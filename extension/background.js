// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Enable side panel to open on action click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// ══════════════════════════════════════════════════════════════
// Event envelope hub
//
// Every captured signal — user input, agent action, navigation —
// flows through this worker as a uniform envelope:
//
//   { id, sessionId, ts, source, kind, actor, tabId,
//     target?, context?, payload?, parentActionId?, causedBy? }
//
// Background's job is to:
//   1. Assign identity (id, sessionId, tabId)
//   2. Maintain a per-tab "action window" so consequence events
//      (page_ready, scroll, future mutations/network) can be tagged
//      with the action that caused them via parentActionId
//   3. Re-tag agent-driven navigations so webNavigation events
//      arriving after an agent navigate are correctly attributed
//
// Sidepanel listens for `pixelfoxx_event` and renders. Sidepanel-side
// agent events render immediately (no round-trip) and notify us via
// `pixelfoxx_emit` purely so we can update tabState.
// ══════════════════════════════════════════════════════════════

const ACTION_KINDS = new Set([
  "click", "input", "submit", "key", "navigate", "agent_action",
]);
const WINDOW_MS = 1500;          // how long an action's "context window" stays open
const AGENT_NAV_TTL_MS = 5000;   // how long agent-navigate marks remain valid
const RESTRICTED_URL = /^(chrome|edge|about|devtools|view-source):/;

/** Per-tab state. Lost on service-worker death; sessions then regenerate. */
const tabState = new Map(); // tabId -> { sessionId, currentActionId, windowExpiresAt }

/**
 * Tabs the agent is actively running on. CDP-injected scrolls on these
 * tabs land in capture.js with isTrusted:true (CDP synthesizes trusted
 * events), so we filter them out at the hub rather than letting them
 * pollute the timeline as "user scrolled."
 *
 * Populated by sidepanel via `pixelfoxx_agent_running`. Cleared on tab
 * removal and on session reset.
 */
const agentRunningTabs = new Set(); // Set<tabId>

function getOrCreateTabState(tabId) {
  let st = tabState.get(tabId);
  if (!st) {
    st = {
      sessionId: crypto.randomUUID(),
      currentActionId: null,
      windowExpiresAt: 0,
      lastNavUrl: null,    // last navigate URL emitted on this tab
      lastFullNavAt: 0,    // ts of the last `full` navigate — used to swallow
                           // chatty SPA replaceState calls right after load
    };
    tabState.set(tabId, st);
  }
  return st;
}

/**
 * Enrich a partial envelope and stamp it with attribution metadata.
 * Returns the same object (mutated) for convenience.
 */
function enrichEnvelope(ev, tabId) {
  const st = getOrCreateTabState(tabId);
  if (ev.id == null) ev.id = crypto.randomUUID();
  if (ev.ts == null) ev.ts = Date.now();
  ev.tabId = tabId;
  ev.sessionId = st.sessionId;

  if (ACTION_KINDS.has(ev.kind)) {
    st.currentActionId = ev.id;
    st.windowExpiresAt = ev.ts + WINDOW_MS;
    ev.parentActionId = null;
    ev.causedBy = ev.actor === "agent" ? "agent-action" : "user-event";
  } else if (ev.ts < st.windowExpiresAt && st.currentActionId) {
    ev.parentActionId = st.currentActionId;
    ev.causedBy = "page";
    // Sliding window: chained consequences (mutation → request → response → render)
    // stay attributed to the originating action.
    st.windowExpiresAt = ev.ts + WINDOW_MS;
  } else {
    ev.parentActionId = null;
    ev.causedBy = null;
  }
  return ev;
}

/** Forward a fully-enriched envelope to the sidepanel. */
function dispatch(ev) {
  chrome.runtime
    .sendMessage({ type: "pixelfoxx_event", event: ev })
    .catch(() => {
      // No sidepanel open — drop silently.
    });
}

// ── Agent-navigate marks (survive SW death via storage.session) ─────────
//
// When the agent issues a navigate, the resulting webNavigation event
// would otherwise look user-driven. We mark the tab so the next few
// webNavigations are tagged actor:"agent". Marks live in chrome.storage.session
// so a brief SW idle between mark-and-fire doesn't lose attribution.

function agentNavKey(tabId) {
  return `agentNav:${tabId}`;
}

async function markAgentNavigate(tabId) {
  try {
    await chrome.storage.session.set({ [agentNavKey(tabId)]: Date.now() });
  } catch (_) {
    // storage.session may be unavailable in very old Chromes; treat as best-effort.
  }
}

async function readAgentNavMark(tabId) {
  try {
    const key = agentNavKey(tabId);
    const data = await chrome.storage.session.get(key);
    const ts = data?.[key];
    if (typeof ts !== "number") return false;
    if (Date.now() - ts > AGENT_NAV_TTL_MS) {
      // Stale — clean up.
      chrome.storage.session.remove(key).catch(() => {});
      return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
// Inbound message handling
// ══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || typeof message.type !== "string") return;

  // (1) Content-script captures from capture.js
  if (message.type === "pixelfoxx_capture") {
    const ev = message.event || {};
    const tabId = sender?.tab?.id ?? null;
    if (tabId == null) return; // safety: shouldn't happen for content-script senders
    // Agent-run gate: drop scroll events on tabs where the agent is
    // actively executing. CDP scrolls land here as trusted events and
    // would otherwise be mis-attributed to the user.
    if (ev.kind === "scroll" && agentRunningTabs.has(tabId)) return;
    enrichEnvelope(ev, tabId);
    dispatch(ev);
    return;
  }

  // (1b) Network captures from actions.js (CDP Network.* events).
  // Flows through the same enrichment pipeline as content captures, so
  // network events get parentActionId attribution via the sliding window.
  if (message.type === "pixelfoxx_network") {
    const ev = message.event || {};
    const tabId = ev.tabId ?? null;
    if (tabId == null) return;
    enrichEnvelope(ev, tabId);
    dispatch(ev);
    return;
  }

  // (2) Sidepanel-originated agent events. The sidepanel renders
  // these immediately for zero-flicker; we only update tabState.
  if (message.type === "pixelfoxx_emit") {
    const ev = message.event || {};
    const tabId = ev.tabId ?? null;
    if (tabId == null) return; // sidepanel must supply tabId for agent events
    const st = getOrCreateTabState(tabId);

    if (ACTION_KINDS.has(ev.kind)) {
      // Open the action window so subsequent capture/webNav events
      // get parentActionId from this agent action.
      st.currentActionId = ev.id || crypto.randomUUID();
      st.windowExpiresAt = (ev.ts || Date.now()) + WINDOW_MS;
    }

    // Mark agent navigates so the resulting webNavigation is tagged correctly.
    if (
      ev.kind === "agent_action" &&
      ev.payload?.action?.type === "navigate"
    ) {
      markAgentNavigate(tabId);
    }
    return;
  }

  // (3) Session reset (e.g. "new chat" in the sidepanel)
  if (message.type === "pixelfoxx_session_reset") {
    const tabId = message.tabId;
    if (typeof tabId === "number") {
      const st = tabState.get(tabId);
      if (st) st.sessionId = crypto.randomUUID();
    } else {
      // Reset all known tabs.
      for (const st of tabState.values()) {
        st.sessionId = crypto.randomUUID();
        st.currentActionId = null;
        st.windowExpiresAt = 0;
      }
    }
    return;
  }

  // (4) Agent run-state signal from the sidepanel. Marks a tab as
  // "agent executing" so capture.js scrolls on it are filtered out.
  // Sidepanel sends this when setRunning(true/false) flips.
  if (message.type === "pixelfoxx_agent_running") {
    const tid = message.tabId;
    if (typeof tid !== "number") return;
    if (message.running) agentRunningTabs.add(tid);
    else agentRunningTabs.delete(tid);
    return;
  }

  // (5) Sidepanel bootstrap prime — emit a tab_activated for the current
  // active tab so the timeline opens with "On <url>" context, even if
  // the user hasn't switched tabs in this session.
  if (message.type === "pixelfoxx_prime") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        if (tab && tab.id != null) {
          emitTabActivated(tab.id, { forcePrime: true });
        }
      } catch (_) {}
    })();
    return;
  }
});

// ══════════════════════════════════════════════════════════════
// Navigation tracking (top-frame, non-restricted only)
//
// Three webNavigation events, all routed through one handler:
//   - onCommitted              — full page navigation (navigationType: "full")
//   - onHistoryStateUpdated    — SPA route change via pushState/replaceState
//                                (navigationType: "history")
//   - onReferenceFragmentUpdated — URL #hash change (navigationType: "fragment")
// ══════════════════════════════════════════════════════════════

async function handleNavigationEvent(details, navigationType) {
  if (details.frameId !== 0) return;
  if (RESTRICTED_URL.test(details.url || "")) return;

  const st = getOrCreateTabState(details.tabId);
  const url = details.url || "";

  // Cheap URL dedup for same-URL replaceState storms (GitHub's Turbo
  // sometimes pushes identical URLs in bursts).
  if (navigationType !== "full" && st.lastNavUrl === url) return;
  st.lastNavUrl = url;

  const agentDriven = await readAgentNavMark(details.tabId);
  const ev = {
    source: "background",
    kind: "navigate",
    actor: agentDriven ? "agent" : "user",
    context: { url },
    payload: {
      navigationType,
      transitionType: details.transitionType || null,
      transitionQualifiers: details.transitionQualifiers || null,
    },
  };
  enrichEnvelope(ev, details.tabId);

  // Semantic noise filter: SPA history/fragment updates that have no
  // preceding user action (or agent action) are framework heartbeats,
  // analytics state pushes, scroll-driven anchor tracking — not real
  // navigation intent. Suppress unless the navigate is attributable to
  // something the user or agent just did.
  //
  // Full navigates always pass: typed URLs, reloads, bookmarks, and
  // back/forward buttons happen in browser chrome where capture.js
  // can't see them, so parentActionId is legitimately null.
  if (
    navigationType !== "full" &&
    ev.parentActionId == null &&
    !agentDriven
  ) {
    return;
  }

  dispatch(ev);
}

if (chrome.webNavigation) {
  if (chrome.webNavigation.onCommitted) {
    chrome.webNavigation.onCommitted.addListener((details) => {
      handleNavigationEvent(details, "full");
    });
  }
  if (chrome.webNavigation.onHistoryStateUpdated) {
    chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
      handleNavigationEvent(details, "history");
    });
  }
  if (chrome.webNavigation.onReferenceFragmentUpdated) {
    chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
      handleNavigationEvent(details, "fragment");
    });
  }
}

// ══════════════════════════════════════════════════════════════
// Tab focus tracking
//
// Tab switches and window focus changes are invisible to capture.js
// (content scripts don't see them) and to webNavigation (no URL change).
// We emit a `tab_activated` kind so the timeline shows when the user's
// attention shifts to a different page — including at sidepanel open
// time, via the `pixelfoxx_prime` handler above.
// ══════════════════════════════════════════════════════════════

const TAB_ACTIVATED_DEDUP_MS = 300;
let lastTabActivatedEmit = { tabId: null, ts: 0 };

async function emitTabActivated(tabId, { forcePrime = false } = {}) {
  if (tabId == null) return;

  const now = Date.now();
  if (
    !forcePrime &&
    lastTabActivatedEmit.tabId === tabId &&
    now - lastTabActivatedEmit.ts < TAB_ACTIVATED_DEDUP_MS
  ) {
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    return; // tab vanished between the event firing and our lookup
  }
  if (!tab || RESTRICTED_URL.test(tab.url || "")) return;

  lastTabActivatedEmit = { tabId, ts: now };

  const ev = {
    source: "background",
    kind: "tab_activated",
    actor: "user",
    context: {
      url: tab.url || null,
      title: tab.title || null,
    },
    payload: {
      favIconUrl: tab.favIconUrl || null,
      windowId: tab.windowId ?? null,
    },
  };
  enrichEnvelope(ev, tabId);
  dispatch(ev);
}

if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    // Belt-and-suspenders: make sure capture.js is running in the tab the
    // user just switched to. Content scripts normally inject on navigation;
    // this also covers pre-existing tabs we may have missed at SW boot.
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) ensureCaptureInTab(tabId, tab.url);
    } catch (_) {}
    emitTabActivated(tabId);
  });
}

if (chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return; // focus left Chrome
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab && tab.id != null) emitTabActivated(tab.id);
    } catch (_) {}
  });
}

// ══════════════════════════════════════════════════════════════
// Tab cleanup — prevent tabState leak
// ══════════════════════════════════════════════════════════════

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    tabState.delete(tabId);
    agentRunningTabs.delete(tabId);
    // Best-effort cleanup of any lingering agent-nav mark.
    chrome.storage.session?.remove(agentNavKey(tabId)).catch(() => {});
  });
}

// ══════════════════════════════════════════════════════════════
// Capture bootstrap — programmatic injection into existing tabs
//
// Manifest-declared content scripts only inject on NAVIGATION. Tabs that
// were already open before the extension loaded (fresh install, browser
// restart, SW re-boot after idle) have no capture.js running in them.
// To avoid making the user refresh every tab manually, we programmatically
// inject capture.js into every already-open non-restricted tab on SW boot.
//
// An idempotency guard in capture.js (window.__pixelfoxxCaptureInstalled)
// means re-injection into a tab that already has a live capture.js is a
// no-op — no duplicate event listeners.
// ══════════════════════════════════════════════════════════════

async function ensureCaptureInTab(tabId, url) {
  if (tabId == null) return;
  if (!url || RESTRICTED_URL.test(url)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["capture.js"],
    });
  } catch (_) {
    // Restricted page, web store, file://, PDF viewer, etc. — silently accept.
  }
}

async function bootstrapCaptureInAllTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab && tab.id != null) ensureCaptureInTab(tab.id, tab.url);
    }
  } catch (_) {}
}

// Runs on every service-worker boot (install, update, browser startup,
// reload, and any re-awake after idle). Cheap thanks to the idempotency
// guard in capture.js.
bootstrapCaptureInAllTabs();
