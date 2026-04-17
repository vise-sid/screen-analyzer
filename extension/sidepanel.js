const API_BASE = "http://localhost:8000";
const MAX_STEPS = 50;

const taskInput = document.getElementById("taskInput");
const sendBtn = document.getElementById("sendBtn");
const stopBtn = document.getElementById("stopBtn");
const newChatBtn = document.getElementById("newChatBtn");
const logArea = document.getElementById("logArea");
const placeholder = document.getElementById("placeholder");

// Sign-in UI elements
const signinOverlay = document.getElementById("signinOverlay");
const signinBtn = document.getElementById("signinBtn");
const signinError = document.getElementById("signinError");
const appShell = document.getElementById("appShell");
const userChip = document.getElementById("userChip");
const userAvatar = document.getElementById("userAvatar");
const userName = document.getElementById("userName");
const signoutBtn = document.getElementById("signoutBtn");

// Stream (timeline) + state indicator UI
const stream = document.getElementById("stream");
const timelineBody = document.getElementById("timelineBody");
const streamIdle = document.getElementById("streamIdle");
const stateIndicator = document.getElementById("stateIndicator");
const stateActorEl = document.getElementById("stateActor");
const stateVerbEl = document.getElementById("stateVerb");
const stateTimingEl = document.getElementById("stateTiming");
const toastTray = document.getElementById("toastTray");

// Grouped-timeline UI: dossier, chip strip, jump-to-latest pill, nav header
const dossier = document.getElementById("dossier");
const dossierFavicon = document.getElementById("dossierFavicon");
const dossierHost = document.getElementById("dossierHost");
const dossierTitle = document.getElementById("dossierTitle");
const chipStrip = document.getElementById("chipStrip");
const jumpToLatest = document.getElementById("jumpToLatest");
const jumpToLatestCount = document.getElementById("jumpToLatestCount");
const navHeader = document.getElementById("navHeader");
const backBtn = document.getElementById("backBtn");
const navTitle = document.getElementById("navTitle");

let sessionId = null;
let running = false;
let currentAbortController = null; // For killing stuck requests

// ── UI Helpers ──────────────────────────────────────────────

function addLog(html, className) {
  const div = document.createElement("div");
  div.className = `log-entry ${className}`;
  div.innerHTML = html;
  logArea.appendChild(div);
  logArea.scrollTop = logArea.scrollHeight;
  return div;
}

function addThought(result) {
  // New format: single "thought" field
  if (result.thought) {
    addLog(
      `<div class="thought-label">\u{1F9E0} THINKING</div><div>${escapeHtml(result.thought)}</div>`,
      "log-thought"
    );
    return;
  }
  // Backward compat: old eval/memory/goal format
  const parts = [];
  if (result.eval && result.eval !== "start") {
    parts.push(`<div class="thought-section"><span class="thought-tag eval-tag">Eval</span> ${escapeHtml(result.eval)}</div>`);
  }
  if (result.memory) {
    parts.push(`<div class="thought-section"><span class="thought-tag memory-tag">Memory</span> ${escapeHtml(result.memory)}</div>`);
  }
  if (result.goal) {
    parts.push(`<div class="thought-section"><span class="thought-tag goal-tag">Goal</span> ${escapeHtml(result.goal)}</div>`);
  }
  if (parts.length > 0) {
    addLog(
      `<div class="thought-label">\u{1F9E0} THINKING</div>${parts.join("")}`,
      "log-thought"
    );
  }
}

function addAction(action) {
  const icons = {
    click: "\u{1F446}",        double_click: "\u{1F446}",
    hover: "\u{1F441}",        focus_and_type: "\u2328\uFE0F",
    type: "\u2328\uFE0F",      clear_and_type: "\u2328\uFE0F",
    key: "\u26A1",              key_combo: "\u26A1",
    select: "\u{1F4CB}",
    scroll: "\u{1F4DC}",       navigate: "\u{1F30D}",
    back: "\u2B05\uFE0F",      forward: "\u27A1\uFE0F",
    extract_text: "\u{1F4D6}", screenshot: "\u{1F4F7}",
    new_tab: "\u2795",          switch_tab: "\u{1F500}",
    close_tab: "\u274C",        click_captcha: "\u{1F916}",
    stealth_solve: "\u{1F575}",dismiss_popup: "\u{1F6AB}",
    accept_dialog: "\u2705",    dismiss_dialog: "\u274C",
    ask_user: "\u{1F64B}",      wait: "\u23F3",
    done: "\u2705",
    // Scraping & Memory
    scrape_page: "\u{1F4C4}",    scrape_table: "\u{1F4CA}",
    scrape_links: "\u{1F517}",   scrape_metadata: "\u{1F3F7}",
    scrape_network: "\u{1F310}", store: "\u{1F4BE}",
    recall: "\u{1F4E5}",
    // Planning & Intelligence
    plan: "\u{1F9E0}",           google_search: "\u{1F50D}",
    ask_advisor: "\u{1F4A1}",    fill_cells: "\u{1F4DD}",
    // Google Workspace API
    sheets_create: "\u{1F4CA}",  sheets_write: "\u270D\uFE0F",
    sheets_read: "\u{1F4D6}",
    docs_create: "\u{1F4DD}",    docs_write: "\u270D\uFE0F",
    docs_read: "\u{1F4D6}",
    slides_create: "\u{1F4FD}",  slides_read: "\u{1F4D6}",
  };
  const icon = icons[action.type] || "\u25B6\uFE0F";
  addLog(
    `<span class="action-icon">${icon}</span> <span>${escapeHtml(formatAction(action))}</span>`,
    "log-action"
  );
}

function addDone(summary) {
  addLog(
    `<div class="done-label">\u{1F389} MISSION COMPLETE</div><div>${escapeHtml(summary)}</div>`,
    "log-done"
  );
}

function addError(msg) {
  // Keep the legacy logArea write so anything inspecting it still works,
  // but the user-visible surface is now the toast tray.
  addLog(escapeHtml(msg), "log-error");
  if (typeof showToast === "function") {
    showToast(String(msg || "Something went wrong"), { tone: "error" });
  }
}

const LOADING_MSGS = [
  "Sniffing around...", "On the trail...", "Foxing through the page...",
  "Eyes on screen...", "Working on it...", "Almost got it...",
  "Reading the pixels...", "Thinking foxy thoughts...",
];

function addLoading() {
  const msg = LOADING_MSGS[Math.floor(Math.random() * LOADING_MSGS.length)];
  return addLog(
    `\u{1F440} <span>${msg}</span>`,
    "log-loading"
  );
}

function formatAction(action) {
  const refStr = (a) =>
    a.ref !== undefined ? `[${a.ref}]` : `(${a.x}, ${a.y})`;

  switch (action.type) {
    case "click":
      return `Click ${refStr(action)}`;
    case "double_click":
      return `Double-click ${refStr(action)}`;
    case "hover":
      return `Hover ${refStr(action)}`;
    case "focus_and_type":
      return `Type "${action.text}" into ${refStr(action)}${action.clear ? " (replace)" : ""}`;
    case "type":
      return `Type "${action.text}"`;
    case "clear_and_type":
      return `Clear & type "${action.text}"`;
    case "key":
      return `Press ${action.key}`;
    case "key_combo":
      return `Key combo ${action.keys}`;
    case "select":
      return `Select "${action.value}" in [ref=${action.ref}]`;
    case "scroll": {
      const dir = (action.deltaY || 0) > 0 ? "down" : "up";
      return `Scroll ${dir} ${Math.abs(action.deltaY || 0)}px`;
    }
    case "navigate":
      return `Navigate to ${action.url}`;
    case "back":
      return `Go back`;
    case "forward":
      return `Go forward`;
    case "extract_text":
      return `Read text from [ref=${action.ref}]`;
    case "new_tab":
      return `Open new tab${action.url ? ": " + action.url : ""}`;
    case "switch_tab":
      return `Switch to tab ${action.tabId}`;
    case "close_tab":
      return `Close tab ${action.tabId}`;
    case "click_captcha":
      return `Click CAPTCHA checkbox`;
    case "stealth_solve":
      return `Stealth solve Cloudflare${action.url ? ": " + action.url : ""}`;
    case "dismiss_popup":
      return `Force-dismiss popup`;
    case "accept_dialog":
      return `Accept dialog`;
    case "dismiss_dialog":
      return `Dismiss dialog`;
    case "ask_user":
      return `Asking for help: ${action.question || ""}`;
    case "wait":
      return `Wait ${action.duration}ms`;
    case "done":
      return `Task complete`;
    // Scraping & Memory
    case "scrape_page":
      return `Scrape full page to Markdown`;
    case "scrape_table":
      return `Extract table${action.ref !== undefined ? ` [ref=${action.ref}]` : ""}`;
    case "scrape_links":
      return `Extract all page links`;
    case "scrape_metadata":
      return `Extract page metadata`;
    case "scrape_network":
      return `Show captured API responses`;
    case "store":
      return `Store to memory: "${action.key || "default"}"`;
    case "recall":
      return `Recall from memory: "${action.key || "default"}"`;
    case "plan":
      return `Creating execution plan`;
    case "google_search":
      return `Searching: "${action.query || ""}"`;
    case "ask_advisor":
      return `Consulting advisor: "${(action.question || "").substring(0, 60)}"`;
    case "fill_cells":
      return `Fill ${(action.values || []).length} cells from ${action.startCell || "A1"} (${action.direction || "down"})`;
    case "sheets_create":
      return `Create spreadsheet: "${action.title || "Untitled"}"`;
    case "sheets_write":
      return `Write ${(action.values || []).length} rows to ${action.range || "A1"}`;
    case "sheets_read":
      return `Read cells ${action.range || "A1:Z100"}`;
    case "docs_create":
      return `Create doc: "${action.title || "Untitled"}"`;
    case "docs_write":
      return `Write to doc`;
    case "docs_read":
      return `Read doc`;
    case "slides_create":
      return `Create presentation: "${action.title || "Untitled"}"`;
    case "slides_read":
      return `Read slides`;
    default:
      return JSON.stringify(action);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setRunning(state) {
  running = state;
  taskInput.disabled = state;
  sendBtn.classList.toggle("hidden", state);
  stopBtn.classList.toggle("hidden", !state);
  newChatBtn.classList.toggle("hidden", state);
  // Reflect in the state indicator
  if (typeof setState === "function") {
    if (state) {
      setState({ actor: "Foxx", verb: "is driving…", mode: "active-agent" });
    } else if (typeof resetStateIndicator === "function") {
      resetStateIndicator();
    }
  }
  // Tell background to gate scroll events from the agent's current tab.
  // CDP scrolls fire with isTrusted:true and would otherwise be captured
  // as user scrolls; this filters them at the hub.
  const agentTabId =
    typeof getActiveAgentTabId === "function" ? getActiveAgentTabId() : null;
  if (agentTabId != null) {
    try {
      chrome.runtime
        .sendMessage({
          type: "pixelfoxx_agent_running",
          tabId: agentTabId,
          running: state,
        })
        .catch(() => {});
    } catch (_) {}
  }
}

function clearLog() {
  while (logArea.lastChild && logArea.lastChild !== placeholder) {
    logArea.removeChild(logArea.lastChild);
  }
  if (placeholder) placeholder.classList.remove("hidden");
  // Also wipe the stream/timeline so the new chat starts fresh.
  if (typeof clearTimeline === "function") clearTimeline();
}

// ── Pause / Resume ──────────────────────────────────────────

/**
 * Pause the agent loop and show a message asking the user for help.
 * Returns a promise that resolves when the user clicks "Resume".
 */
function pauseForUser(question) {
  return new Promise((resolve) => {
    const entry = addLog(
      `<div class="ask-user-label">Needs your help</div>` +
      `<div class="ask-user-text">${escapeHtml(question)}</div>` +
      `<button class="resume-btn" id="resumeBtn">Resume after solving</button>`,
      "log-ask-user"
    );

    const resumeBtn = entry.querySelector("#resumeBtn");
    resumeBtn.addEventListener("click", () => {
      resumeBtn.disabled = true;
      resumeBtn.textContent = "Resuming...";
      resolve();
    });
  });
}

// ── Loop Detection ──────────────────────────────────────────

/**
 * Detect if the agent is stuck in a loop by checking for repeated actions.
 * Returns a warning string if a loop is detected, null otherwise.
 *
 * Catches:
 * - 3 identical actions in a row
 * - A-B-A-B oscillation
 * - Same action TYPE repeated 4+ times (e.g., scroll with varying params)
 * - Scroll up/down oscillation (scroll loop)
 */
function detectLoop(actionHistory) {
  if (actionHistory.length < 3) return null;

  const last3 = actionHistory.slice(-3);
  // All 3 identical
  if (last3[0] === last3[1] && last3[1] === last3[2]) {
    return `LOOP DETECTED: You have repeated the same action 3 times: ${last3[0]}. ` +
      `This action is not working. Try a completely different approach or use done to report what you found so far.`;
  }

  // Oscillating between 2 actions
  if (actionHistory.length >= 4) {
    const last4 = actionHistory.slice(-4);
    if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
      return `OSCILLATION DETECTED: You are alternating between two actions. ` +
        `Stop and try a completely different approach, or use done to report what you found.`;
    }
  }

  // Same action TYPE repeated 4+ times (catches scroll loops with varying params)
  if (actionHistory.length >= 4) {
    try {
      const lastTypes = actionHistory.slice(-4).map(a => JSON.parse(a).type);
      const allSame = lastTypes.every(t => t === lastTypes[0]);
      if (allSame) {
        return `TYPE LOOP DETECTED: You have used "${lastTypes[0]}" 4 times in a row. ` +
          `This is not making progress. If you already have the information you need ` +
          `(from a previous scrape or from the element list), use done NOW to report your findings. ` +
          `If you truly need more data, try scrape_page instead of scrolling.`;
      }
    } catch (_) {}
  }

  // Scroll direction oscillation: up-down-up or down-up-down (catches scroll ping-pong)
  if (actionHistory.length >= 5) {
    try {
      const last5 = actionHistory.slice(-5).map(a => {
        const parsed = JSON.parse(a);
        if (parsed.type !== "scroll") return null;
        return (parsed.deltaY || 0) > 0 ? "down" : "up";
      });
      if (last5.every(d => d !== null)) {
        const changes = last5.filter((d, i) => i > 0 && d !== last5[i - 1]).length;
        if (changes >= 3) {
          return `SCROLL LOOP DETECTED: You are scrolling up and down repeatedly without progress. ` +
            `STOP scrolling. Use scrape_page to get the page content, then use done to report your findings.`;
        }
      }
    } catch (_) {}
  }

  return null;
}

// ── Screenshot + Elements ───────────────────────────────────

async function resolveAgentTab() {
  // Try the currently tracked active tab
  const tabId = getActiveAgentTabId();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (e) {
      if (attempt < 2) await sleep(300);
    }
  }

  // Active tab gone — try other known agent tabs
  for (const id of agentTabIds) {
    if (id === tabId) continue;
    try {
      const tab = await chrome.tabs.get(id);
      activeAgentTabId = tab.id;
      await chrome.tabs.update(tab.id, { active: true });
      console.log(`Switched to surviving agent tab: ${tab.id} (${tab.url})`);
      return tab;
    } catch (_) {
      agentTabIds.delete(id); // This one's dead too
    }
  }

  // Last resort: find any tab in current window
  const allTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (allTabs.length > 0) {
    const tab = allTabs[0];
    agentTabIds.add(tab.id);
    activeAgentTabId = tab.id;
    return tab;
  }
  throw new Error("No available agent tab found");
}

async function captureScreenshot(tab) {
  // Tab passed in — no duplicate resolveAgentTab call
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(150);
  }

  // JPEG at 60% quality — 3-5x smaller than PNG, faster to send
  let dataUrl = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      break;
    } catch (e) {
      if (attempt < 2) await sleep(300); // Short retry
      else throw e;
    }
  }

  return {
    base64: dataUrl.split(",")[1],
    tabId: tab.id,
    width: tab.width,
    height: tab.height,
  };
}

async function captureState(needsScreenshot = true) {
  const tab = await resolveAgentTab();
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(150);
  }

  // Wait for page to be ready before capturing (replaces hardcoded post-action sleeps)
  try {
    await waitForPageReady();
  } catch (_) {}

  let screenshot = { base64: null, tabId: tab.id, width: tab.width, height: tab.height };
  // Run screenshot + element extraction + tab list in PARALLEL
  const [screenshotResult, elemData, agentTabs] = await Promise.all([
    needsScreenshot
      ? captureScreenshot(tab).catch(e => {
          console.warn("Screenshot failed:", e);
          return { base64: null, tabId: tab.id, width: tab.width, height: tab.height };
        })
      : Promise.resolve({ base64: null, tabId: tab.id, width: tab.width, height: tab.height }),
    extractElements(tab.id).catch(err => {
      console.warn("Element extraction failed:", err);
      return { elements: null, scrollContainers: null, popup: null, captcha: null, isCanvasHeavy: false };
    }),
    getAgentTabs(),
  ]);

  let { elements, scrollContainers, popup, captcha, isCanvasHeavy, pageScroll, pageLoading } = elemData;
  if (elements && elements.length > 200) elements = elements.slice(0, 200);

  const dialog = typeof getPendingDialog === "function" ? getPendingDialog() : null;
  return { screenshot: screenshotResult, elements, scrollContainers, popup, captcha, dialog, isCanvasHeavy, agentTabs, pageScroll, pageLoading };
}

// ── Tab Action Executor ─────────────────────────────────────

async function executeTabAction(action) {
  switch (action.type) {
    case "new_tab": {
      const result = await agentNewTab(action.url || "about:blank");
      if (!result) {
        addError("Tab limit reached (max 5).");
      }
      // Detach debugger so it reattaches to the new tab on next step
      await detachDebugger();
      await sleep(action.url ? 2000 : 500);
      break;
    }
    case "switch_tab": {
      const ok = await agentSwitchTab(action.tabId);
      if (!ok) {
        addError(`Could not switch to tab ${action.tabId}.`);
      }
      await sleep(500);
      break;
    }
    case "close_tab": {
      const ok = await agentCloseTab(action.tabId);
      if (!ok) {
        addError(`Could not close tab ${action.tabId}.`);
      }
      await sleep(300);
      break;
    }
  }
}

// ── Agent Loop ──────────────────────────────────────────────

async function runAgent(task) {
  placeholder.classList.add("hidden");
  addLog(escapeHtml(task), "log-task");
  setRunning(true);

  try {
    // Initialize tab manager — creates "Agent" tab group
    await initTabManager();
    startPopupDetection();

    // Get initial viewport info
    const initialTab = await resolveAgentTab();
    const initial = await captureScreenshot(initialTab);

    // Start session (authenticated — attaches Bearer ID token)
    const startRes = await apiFetch(`${API_BASE}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        viewport_width: initial.width || 1280,
        viewport_height: initial.height || 800,
      }),
    });

    if (startRes.status === 401) {
      addError("You're signed out. Sign in to continue.");
      await signOut();
      showSignIn();
      return;
    }
    if (startRes.status === 429) {
      const body = await startRes.json().catch(() => ({}));
      addError(body.detail || "Daily usage limit reached.");
      return;
    }
    if (!startRes.ok) throw new Error("Failed to start session");
    const { session_id } = await startRes.json();
    sessionId = session_id;

    addLog(`<span class="action-icon">\u{1F9E0}</span> <span>Planning strategy...</span>`, "log-action");

    let googleToken = null;  // Cached Google OAuth token (fetched on demand)

    // Pre-fetch Google OAuth token (silent, non-interactive first attempt)
    // If the task needs Sheets/Drive, this ensures the token is ready
    try {
      googleToken = await new Promise((resolve) => {
        chrome.identity.getAuthToken({ interactive: false }, (token) => {
          if (chrome.runtime.lastError || !token) {
            resolve(null); // Not signed in or no consent yet — will prompt interactively when needed
          } else {
            resolve(token);
          }
        });
      });
      if (googleToken) {
        console.log("Google OAuth token pre-fetched (silent)");
      }
    } catch (_) {
      googleToken = null;
    }

    // Agent loop
    let completed = false;
    const actionHistory = [];
    let consecutiveFailures = 0;
    let killRetries = 0;
    let lastActionResult = null;  // Scrape/extract/recall result to send back to LLM
    for (let step = 0; step < MAX_STEPS && running; step++) {
      // ── Timing: track every phase ──
      const t0 = performance.now();

      // Bound captureState — CDP commands can hang if the debugger is in a
      // weird state post-navigation. On timeout we detach and try once more.
      let state;
      const CAPTURE_TIMEOUT_MS = 30_000;
      const captureWithTimeout = () =>
        Promise.race([
          captureState(true),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error("captureState timeout")), CAPTURE_TIMEOUT_MS)
          ),
        ]);
      try {
        state = await captureWithTimeout();
      } catch (capErr) {
        console.warn("captureState failed, resetting debugger:", capErr.message);
        addLog("Page capture stalled — resetting browser connection...", "log-error");
        try { await detachDebugger(); } catch (_) {}
        try {
          state = await captureWithTimeout();
        } catch (capErr2) {
          consecutiveFailures++;
          if (consecutiveFailures >= 3) {
            addError("Cannot read page after 3 tries. Stopping.");
            break;
          }
          addLog(`Capture retry ${consecutiveFailures}/3...`, "log-error");
          await sleep(1000);
          continue;
        }
      }
      const tCapture = performance.now();

      // Get FRESH tab info for URL (after page load, not cached)
      const tab = await resolveAgentTab();
      const freshTab = await chrome.tabs.get(tab.id);
      const requestBody = {
        url: freshTab.url || "",
        elements: state.elements,
        scroll_containers: state.scrollContainers,
        popup: state.popup,
        captcha: state.captcha,
        dialog: state.dialog,
        is_canvas_heavy: state.isCanvasHeavy,
        agent_tabs: state.agentTabs,
        page_scroll: state.pageScroll,
        page_loading: state.pageLoading || false,
      };
      if (state.screenshot.base64) {
        requestBody.image = state.screenshot.base64;
      }
      // Include action result from previous scrape/extract/recall
      if (lastActionResult) {
        requestBody.action_result = lastActionResult;
        lastActionResult = null;  // Clear after sending
      }
      // Include Google OAuth token if we have one (for Sheets API actions)
      if (googleToken) {
        requestBody.google_token = googleToken;
      }
      const loopWarning = detectLoop(actionHistory);
      if (loopWarning) requestBody.loop_warning = loopWarning;

      const loadingEl = addLoading();
      currentAbortController = new AbortController();
      const timeoutId = setTimeout(() => currentAbortController.abort(), 90000);

      const tApiStart = performance.now();
      let stepRes;
      try {
        stepRes = await apiFetch(`${API_BASE}/session/${sessionId}/step`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: currentAbortController.signal,
        });
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        loadingEl.remove();
        currentAbortController = null;
        if (fetchErr.name === "AbortError") {
          killRetries++;
          if (killRetries >= 3) { addError("Timed out 3 times — skipping."); killRetries = 0; continue; }
          addLog(`Request timed out — retry ${killRetries}/3...`, "log-error");
          continue;
        }
        throw fetchErr;
      }
      clearTimeout(timeoutId);
      currentAbortController = null;
      killRetries = 0;
      const tApiEnd = performance.now();

      loadingEl.remove();

      if (stepRes.status === 401) {
        addError("You're signed out. Sign in to continue.");
        await signOut();
        showSignIn();
        break;
      }
      if (stepRes.status === 429) {
        const body = await stepRes.json().catch(() => ({}));
        addError(body.detail || "Daily usage limit reached.");
        break;
      }
      if (!stepRes.ok) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) { addError("3 consecutive server errors. Stopping."); break; }
        const err = await stepRes.json().catch(() => ({}));
        addError(err.detail || `Server error: ${stepRes.status}`);
        await sleep(1000);
        continue;
      }

      consecutiveFailures = 0;
      const result = await stepRes.json();

      addThought(result);
      if (result.thought) {
        appendAgentTimelineEvent("agent_thought", { text: String(result.thought).slice(0, 200) });
      }

      if (!result.action) { addError("No action returned by model."); break; }

      if (result.action.type === "screenshot") {
        addLog(`<span class="action-icon">\u{1F4F7}</span> <span>Requesting screenshot...</span>`, "log-action");
        continue;
      }

      actionHistory.push(JSON.stringify(result.action));
      addAction(result.action);
      appendAgentTimelineEvent("agent_action", { action: result.action });

      // ── Execute action ──
      const tExecStart = performance.now();
      let shouldBreak = false;
      let shouldContinue = false;

      if (result.action.type === "done") {
        addDone(result.action.summary || "Task complete.");
        appendAgentTimelineEvent("agent_done", { summary: result.action.summary || "" });
        completed = true;
        shouldBreak = true;
      } else if (result.action.type === "plan") {
        // Flash created its execution plan — show it prominently
        const planText = result.action.plan || result.thought || "";
        addLog(
          `<div class="thought-label">\u{1F9E0} PLANNING</div><pre class="scraped-preview">${escapeHtml(planText)}</pre>`,
          "log-thought"
        );
        shouldContinue = true;
      } else if (result.action.type === "google_search") {
        // Google search for URL discovery — result comes back from backend
        const searchData = result._search_data || "";
        if (searchData) {
          lastActionResult = searchData;
          addLog(
            `<div class="thought-label">\u{1F50D} SEARCH</div><div>${escapeHtml(searchData.substring(0, 300))}</div>`,
            "log-thought"
          );
        }
        shouldContinue = true;
      } else if (result.action.type === "ask_advisor") {
        // Consulted the Pro model for complex reasoning
        const advice = result._advisor_response || "";
        if (advice) {
          lastActionResult = advice;
          addLog(
            `<div class="thought-label">\u{1F4A1} ADVISOR</div><pre class="scraped-preview">${escapeHtml(advice)}</pre>`,
            "log-thought"
          );
        }
        shouldContinue = true;
      } else if ([
        "sheets_create", "sheets_write", "sheets_read",
        "docs_create", "docs_write", "docs_read",
        "slides_create", "slides_read",
      ].includes(result.action.type)) {
        // Google Workspace API actions — handled server-side
        const gr = result._gwork_result || {};
        if (gr.error) {
          // If error is about missing token, try interactive auth
          if (gr.error.includes("OAuth token") || gr.error.includes("not connected")) {
            addLog(`<span class="action-icon">\u{1F511}</span> <span>Connecting to Google — approve in popup...</span>`, "log-action");

            // Detach debugger BEFORE OAuth to prevent crash on consent page
            await detachDebugger();
            const preAuthTab = await resolveAgentTab();

            try {
              // Blocks until user approves/rejects consent popup
              googleToken = await getGoogleAuthToken();
              if (googleToken) {
                addLog(`<span class="action-icon">\u2705</span> <span>Google connected! Retrying...</span>`, "log-action");
                lastActionResult = "Google OAuth connected. Retry the action.";
              } else {
                lastActionResult = "GOOGLE ERROR: OAuth not available. Sign into Chrome with Google account.";
              }
            } catch (authErr) {
              lastActionResult = `GOOGLE ERROR: Auth failed — ${authErr.message}`;
            }

            // Switch back to original tab after OAuth completes
            try {
              await chrome.tabs.update(preAuthTab.id, { active: true });
              await sleep(500);
            } catch (_) {}
          } else {
            addLog(`<div class="thought-label">\u26A0\uFE0F GOOGLE ERROR</div><div>${escapeHtml(gr.error)}</div>`, "log-error");
            lastActionResult = `GOOGLE ERROR: ${gr.error}`;
          }
        } else {
          // Success — show result based on action type
          const url = gr.url || "";
          const title = gr.title || result.action.title || "Untitled";
          const atype = result.action.type;

          if (atype.endsWith("_create")) {
            const icon = atype.startsWith("sheets") ? "\u{1F4CA}" : atype.startsWith("docs") ? "\u{1F4DD}" : "\u{1F4FD}";
            const label = atype.startsWith("sheets") ? "SHEET" : atype.startsWith("docs") ? "DOC" : "SLIDES";
            addLog(
              `<div class="thought-label">${icon} ${label} CREATED</div><div><a href="${escapeHtml(url)}" target="_blank">${escapeHtml(title)}</a></div>`,
              "log-thought"
            );
          } else if (atype.endsWith("_write")) {
            addLog(`<div class="thought-label">\u270D\uFE0F WRITTEN</div><div>${escapeHtml(JSON.stringify(gr).substring(0, 200))}</div>`, "log-thought");
          } else if (atype.endsWith("_read")) {
            const data = JSON.stringify(gr, null, 2);
            const preview = data.length > 500 ? data.substring(0, 500) + "..." : data;
            addLog(`<div class="thought-label">\u{1F4D6} READ</div><pre class="scraped-preview">${escapeHtml(preview)}</pre>`, "log-thought");
          }
          lastActionResult = JSON.stringify(gr);
        }
        shouldContinue = true;
      } else if (result.action.type === "ask_user") {
        await pauseForUser(result.action.question || "Please help.");
        if (!running) { shouldBreak = true; } else { shouldContinue = true; }
      } else if (result.action.type === "stealth_solve") {
        const solveTab = await resolveAgentTab();
        addLog(`<div class="thought-label">\u{1F575} STEALTH MODE</div><div>Bypassing Cloudflare...</div>`, "log-thought");
        const solveResult = await stealthSolve(solveTab.id, solveTab.url, API_BASE);
        if (solveResult.success) {
          addLog(`<span class="action-icon">\u{1F510}</span> <span>Cloudflare bypassed!</span>`, "log-action");
          await detachDebugger();
        } else {
          addError(`Stealth solve failed: ${solveResult.error || "Unknown"}`);
        }
        shouldContinue = true;
      } else if (["new_tab", "switch_tab", "close_tab"].includes(result.action.type)) {
        await executeTabAction(result.action);
      } else if (result.action.type === "store") {
        // Store: send lastActionResult to backend via the next step's action_result
        // The backend handles the actual storage when it processes the model response
        if (lastActionResult) {
          addLog(`<div class="thought-label">\u{1F4BE} STORING</div><div>Key: "${escapeHtml(result.action.key || 'default')}" (${(lastActionResult.length / 1024).toFixed(1)}KB)</div>`, "log-thought");
        } else {
          addLog(`<div class="thought-label">\u{1F4BE} STORE</div><div>No data to store — use a scrape action first</div>`, "log-thought");
        }
        // Don't clear lastActionResult — the backend needs it in the next step to actually store
      } else if (result.action.type === "recall") {
        // Recall: backend returns the data in result._recall_data
        if (result._recall_data) {
          lastActionResult = result._recall_data;
          const preview = result._recall_data.length > 300
            ? result._recall_data.substring(0, 300) + "..."
            : result._recall_data;
          addLog(`<div class="thought-label">\u{1F4E5} RECALLED</div><pre class="scraped-preview">${escapeHtml(preview)}</pre>`, "log-thought");
        } else {
          addLog(`<div class="thought-label">\u{1F4E5} RECALL</div><div>Key not found</div>`, "log-thought");
        }
      } else {
        const executed = await executeAction(state.screenshot.tabId, result.action);
        // Handle extracted text (existing)
        if (executed && executed._extractedText) {
          addLog(`<div class="thought-label">\u{1F4D6} EXTRACTED</div><div>${escapeHtml(executed._extractedText)}</div>`, "log-thought");
          lastActionResult = executed._extractedText;
        }
        // Handle scraped data (new)
        if (executed && executed._scrapedData && !executed._extractedText) {
          const scraped = typeof executed._scrapedData === "string"
            ? executed._scrapedData
            : JSON.stringify(executed._scrapedData, null, 2);
          lastActionResult = scraped;
          const preview = scraped.length > 500
            ? scraped.substring(0, 500) + "..."
            : scraped;
          addLog(`<div class="thought-label">\u{1F4CA} SCRAPED</div><pre class="scraped-preview">${escapeHtml(preview)}</pre>`, "log-thought");
        }
        // Handle fill_cells result
        if (executed && executed._fillResult) {
          const fr = executed._fillResult;
          if (fr.error) {
            addLog(`<div class="thought-label">\u26A0\uFE0F FILL FAILED</div><div>${escapeHtml(fr.error)}</div>`, "log-error");
          } else {
            addLog(
              `<div class="thought-label">\u{1F4DD} FILLED</div><div>${fr.count} cells from ${fr.startCell} (${fr.direction}): ${fr.values.join(", ")}</div>`,
              "log-thought"
            );
          }
        }
        // Handle input verification — warn if typed text didn't match
        if (executed && executed._inputVerification) {
          const v = executed._inputVerification;
          if (!v.match) {
            addLog(
              `<div class="thought-label">\u26A0\uFE0F INPUT MISMATCH</div>` +
              `<div>Intended: "${escapeHtml(v.intended)}"<br>Actual: "${escapeHtml(v.actual)}"</div>`,
              "log-error"
            );
            // Send mismatch info to LLM so it can correct
            lastActionResult = `INPUT MISMATCH: Intended "${v.intended}" but field contains "${v.actual}". Use focus_and_type with clear:true to fix.`;
          }
        }
      }

      const tExecEnd = performance.now();

      // ── Log timing ──
      const captureMs = Math.round(tCapture - t0);
      const apiMs = Math.round(tApiEnd - tApiStart);
      const execMs = Math.round(tExecEnd - tExecStart);
      const totalMs = Math.round(tExecEnd - t0);
      console.log(`[Step ${step + 1}] capture=${captureMs}ms api=${apiMs}ms exec=${execMs}ms total=${totalMs}ms`);
      addLog(
        `<span class="timing">⏱ capture ${captureMs}ms · LLM ${apiMs}ms · exec ${execMs}ms · total ${totalMs}ms</span>`,
        "log-timing"
      );

      if (shouldBreak) break;
      if (shouldContinue) continue;

    }

    if (!completed && running) {
      addError(`Stopped after ${MAX_STEPS} steps. You can start a new task to continue.`);
    } else if (!completed && !running) {
      addLog("Stopped by user.", "log-error");
    }
  } catch (err) {
    addError(err.message || "Something went wrong.");
  } finally {
    setRunning(false);
    // Cleanup: ungroup tabs (keep them open for the user)
    stopPopupDetection();
    await cleanupTabManager();
    if (sessionId) {
      apiFetch(`${API_BASE}/session/${sessionId}`, { method: "DELETE" }).catch(
        () => {}
      );
      sessionId = null;
    }
    detachDebugger().catch(() => {});
  }
}

// ── Event Listeners ─────────────────────────────────────────

sendBtn.addEventListener("click", () => {
  const task = taskInput.value.trim();
  if (!task) return;
  taskInput.value = "";
  runAgent(task);
});

taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

stopBtn.addEventListener("click", () => {
  // Kill current request if stuck, or stop entirely on second click
  if (currentAbortController) {
    currentAbortController.abort();
    // Don't set running=false — let it retry the step
  } else {
    running = false;
  }
});

// Double-click stop to force quit
stopBtn.addEventListener("dblclick", () => {
  running = false;
  if (currentAbortController) currentAbortController.abort();
});

newChatBtn.addEventListener("click", () => {
  if (running) return;
  clearLog();
  taskInput.value = "";
  taskInput.focus();
});

// ── Sign-in bootstrap ───────────────────────────────────────

function showSignIn() {
  if (signinOverlay) signinOverlay.classList.remove("hidden");
  if (appShell) appShell.classList.add("hidden");
}

function hideSignIn() {
  if (signinOverlay) signinOverlay.classList.add("hidden");
  if (appShell) appShell.classList.remove("hidden");
}

function renderUserChip(user) {
  if (!userChip || !user) return;
  if (userAvatar) {
    if (user.picture) {
      userAvatar.src = user.picture;
      userAvatar.classList.remove("hidden");
    } else {
      userAvatar.classList.add("hidden");
    }
  }
  if (userName) {
    userName.textContent = user.name || user.email || "Signed in";
  }
  userChip.classList.remove("hidden");
}

function clearUserChip() {
  if (!userChip) return;
  userChip.classList.add("hidden");
  if (userName) userName.textContent = "";
  if (userAvatar) userAvatar.src = "";
}

async function handleSignIn() {
  if (signinError) signinError.textContent = "";
  if (signinBtn) {
    signinBtn.disabled = true;
    signinBtn.textContent = "Signing in…";
  }
  try {
    const token = await getGoogleIdToken({ interactive: true });
    if (!token) {
      if (signinError) signinError.textContent = "Sign-in cancelled or failed. Try again.";
      return;
    }
    // Confirm with backend — also populates the users table and returns usage.
    const resp = await apiFetch(`${API_BASE}/me`);
    if (!resp.ok) {
      if (signinError) signinError.textContent = `Backend rejected token (${resp.status}).`;
      await signOut();
      return;
    }
    const me = await resp.json();
    renderUserChip(me);
    hideSignIn();
  } catch (err) {
    console.error(err);
    if (signinError) signinError.textContent = err.message || "Unexpected error.";
  } finally {
    if (signinBtn) {
      signinBtn.disabled = false;
      signinBtn.textContent = "Sign in with Google";
    }
  }
}

async function handleSignOut() {
  if (running) return;
  await signOut();
  clearUserChip();
  clearLog();
  showSignIn();
}

async function bootstrapAuth() {
  // Try silent restore — only shows the consent screen if we can't refresh quietly.
  const cached = await getCachedUser();
  if (cached) renderUserChip(cached);

  const token = await getGoogleIdToken({ interactive: false });
  if (token) {
    // Validate with backend so we capture the canonical user record and usage.
    try {
      const resp = await apiFetch(`${API_BASE}/me`);
      if (resp.ok) {
        const me = await resp.json();
        renderUserChip(me);
        hideSignIn();
        return;
      }
    } catch (_) {}
  }
  clearUserChip();
  showSignIn();
}

if (signinBtn) signinBtn.addEventListener("click", handleSignIn);
if (signoutBtn) signoutBtn.addEventListener("click", handleSignOut);

// Kick off auth check as soon as the sidepanel loads.
bootstrapAuth();

// Ask background to emit a tab_activated for the current active tab
// so the timeline opens with a "You're on <url>" context row.
try {
  chrome.runtime
    .sendMessage({ type: "pixelfoxx_prime" })
    .catch(() => {});
} catch (_) {}

/**
 * Phase 3 — ensure CDP network capture is running on the given tab.
 *
 * Reuses `attachDebugger` from actions.js (idempotent: no-op if already
 * attached to this tabId; auto-detaches from any prior tab first).
 * Silently swallows attach failures — chrome://, Web Store, PDF viewer
 * and similar tabs reject CDP attach and that's fine.
 */
async function ensureNetworkCapture(tabId) {
  if (tabId == null) return;
  if (typeof attachDebugger !== "function") return;
  try {
    await attachDebugger(tabId);
  } catch (_) {
    // Restricted page or user cancelled the debugger bar — accept silently.
  }
}

// Initial attach: query the current active tab and attach once the
// sidepanel is ready. This is what makes network capture start "just
// because the sidepanel is open" — no Start Capture button yet.
(async () => {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tab && tab.id != null) ensureNetworkCapture(tab.id);
  } catch (_) {}
})();

// ══════════════════════════════════════════════════════════════
// ACTIVITY TIMELINE — grouped co-pilot transcript. Events flow in
// as a flat list from background, but display as a tree:
//   Dossier (current tab)
//   └── Chip strip (every tab touched)
//       └── Tab-visit sections (collapsible, one per page-visit)
//           └── Action rows (collapsible if they have consequences)
//               └── Consequence rows (indented, dim)
// The envelope's tabId + parentActionId + kind + actor are the only
// inputs needed for the hierarchy — no extra data plumbing required.
// ══════════════════════════════════════════════════════════════

const TIMELINE_MAX_EVENTS = 400;
const timelineEvents = [];
// Agent-navigate re-tagging now lives in background.js (chrome.storage.session
// keyed by tabId), so attribution survives sidepanel close + brief SW idles.

// --- helpers ---------------------------------------------------

function nowTimeStr(ts) {
  const d = ts ? new Date(ts) : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function shortUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    const path = u.pathname.length > 26 ? u.pathname.slice(0, 23) + "…" : u.pathname;
    return `${u.host}${path === "/" ? "" : path}`;
  } catch (_) {
    return String(url).slice(0, 60);
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return ""; }
}

/** Human label for an element descriptor captured by capture.js. */
function describeTarget(t) {
  if (!t) return "";
  // Prefer the standards-based visible label (aria-labelledby / <label>)
  // over innerText or placeholder — matches what the user actually saw.
  const raw =
    t.label ||
    t.ariaLabel ||
    t.text ||
    t.placeholder ||
    t.name ||
    t.id ||
    t.role ||
    "";
  const base = raw
    ? (raw.length > 60 ? raw.slice(0, 57) + "…" : raw)
    : t.tag
      ? `<${t.tag}>`
      : "";
  // Append container context ONLY for high-signal containers (dialog and
  // table-row). Form/section context stays in the envelope for the LLM
  // but isn't shown inline, to keep the timeline compact.
  if (t.container === "dialog" && t.containerName) {
    return `${base} in dialog "${t.containerName}"`;
  }
  if (t.container === "table-row" && t.containerName) {
    return `${base} in row "${t.containerName}"`;
  }
  return base;
}

/** Build the inner HTML for an event's primary line. */
function eventInnerHtml(ev) {
  const v = (str, max = 80) => {
    const s = String(str || "");
    const cut = s.length > max ? s.slice(0, max - 1) + "…" : s;
    return `<span class="val">${escapeHtml(cut)}</span>`;
  };
  const tag = (str) => `<span class="tag">${escapeHtml(str)}</span>`;
  const p = ev.payload || {};
  const ctxUrl = ev.context?.url;

  switch (ev.kind) {
    case "click": {
      const desc = describeTarget(ev.target);
      if (desc) return `Clicked ${v(desc, 60)}`;
      return `Clicked at ${tag(`(${p.coords?.x ?? 0}, ${p.coords?.y ?? 0})`)}`;
    }
    case "input": {
      const field = describeTarget(ev.target) || "a field";
      if (p.sensitive) return `Entered a secret into ${v(field, 40)}`;
      return `Typed ${v(p.value || "", 50)} into ${v(field, 40)}`;
    }
    case "submit":
      return `Submitted ${v(describeTarget(ev.target) || "the form", 50)}`;
    case "key":
      return `Pressed ${v(p.key, 20)}`;
    case "scroll":
      return `Scrolled`;
    case "navigate": {
      const navType = p.navigationType;
      const verb =
        navType === "history" ? "Route changed to"
        : navType === "fragment" ? "Jumped to"
        : "Navigated to";
      return `${verb} ${v(shortUrl(ctxUrl), 60)}`;
    }
    case "page_ready":
      return `Opened ${v(shortUrl(ctxUrl), 60)}`;
    case "form_invalid": {
      const field = describeTarget(ev.target) || "a field";
      if (p.validationMessage) {
        return `${v(field, 30)} rejected: ${v(p.validationMessage, 80)}`;
      }
      return `${v(field, 40)} failed validation`;
    }
    case "page_alert":
      return `Alert: ${v(p.text, 120)}`;
    case "page_dialog_opened":
      return p.name
        ? `Dialog opened: ${v(p.name, 50)}`
        : `Dialog opened`;
    case "page_title_changed":
      return `Title changed to ${v(p.title, 60)}`;
    case "tab_activated":
      return ctxUrl ? `On ${v(shortUrl(ctxUrl), 60)}` : `Switched tab`;
    case "network": {
      const method = p.method || "GET";
      const status = p.failed ? "\u2715" : (p.status ?? "?");
      const urlShort = shortUrl(p.url || "");
      const dur = p.durationMs != null ? ` ${tag(p.durationMs + "ms")}` : "";
      return `${tag(method)} ${v(urlShort, 50)} ${tag(String(status))}${dur}`;
    }
    case "agent_action": {
      const a = p.action || {};
      const bits = [`${escapeHtml(a.type || "action")}`];
      if (a.ref !== undefined) bits.push(tag(`ref ${a.ref}`));
      if (a.text) bits.push(v(a.text, 50));
      if (a.url) bits.push(v(shortUrl(a.url), 60));
      if (a.query) bits.push(v(a.query, 50));
      if (a.key) bits.push(tag(a.key));
      return bits.join(" ");
    }
    case "agent_thought":
      return escapeHtml(p.text || "");
    case "agent_done":
      return escapeHtml(p.summary ? `${p.summary}` : "Task complete.");
    case "system":
      return escapeHtml(p.text || "System note");
    default:
      return escapeHtml(ev.kind || "event");
  }
}

// Hoisted so they're not reconstructed per event.
const IMPORTANT_KINDS = new Set([
  "click", "submit", "navigate", "agent_done",
  "page_alert", "page_dialog_opened", "tab_activated",
]);
const QUIET_KINDS = new Set([
  "scroll", "page_ready", "key", "page_title_changed",
]);

/** Visual-class augment for network events: failures bubble up as important. */
function networkVisualParts(ev) {
  const p = ev.payload || {};
  const failed = p.failed || (typeof p.status === "number" && p.status >= 400);
  return failed ? ["important"] : ["quiet"];
}

/** Classify event importance for visual weighting. */
function eventVisualClass(ev) {
  const parts = [ev.actor || "system"];
  if (ev.kind === "agent_thought") parts.push("thought");
  else if (ev.kind === "agent_done") parts.push("done", "important");
  else if (ev.kind === "agent_action") parts.push("important");
  else if (ev.kind === "form_invalid") parts.push("important", "error");
  else if (ev.kind === "network") parts.push(...networkVisualParts(ev));
  else if (IMPORTANT_KINDS.has(ev.kind)) parts.push("important");
  else if (QUIET_KINDS.has(ev.kind)) parts.push("quiet");
  return parts.join(" ");
}

// ══════════════════════════════════════════════════════════════
// Hierarchy: Events → Page-visits → Action-groups (action + its
// consequences). Consequences inherit their parent action's visit,
// so a click + its Turbo navigate always stay in the same block.
// A page-visit's boundary is (tabId, url-without-fragment) and is
// only opened by actions or tab_activated — never by consequence
// events alone. This keeps visits stable across SPA noise.
// ══════════════════════════════════════════════════════════════

const ACTION_KINDS_CLIENT = new Set([
  "click", "input", "submit", "key", "navigate", "agent_action",
]);

// Which action is currently "in-flight" for the agent — used to
// apply a pulse to that row. Cleared on agent_done / setRunning(false).
let runningActionId = null;

// Drill-down view state. Clicks navigate (push); back button returns.
// currentView ∈ { "root", "visit", "action" }
let currentView    = "root";
let currentVisitKey  = null;  // when view === "visit" or "action"
let currentActionId  = null;  // when view === "action"
let chipFilter       = null;  // host string, or null for "All"

// Scroll-aware "new events below" counter, for the jump-to-latest pill.
let pendingBelow = 0;

/**
 * Host-only key for page-visit grouping. Keeping it at the host level
 * means all activity on fonts.google.com — no matter which sub-path —
 * folds into one block. Switching to mail.google.com starts a new block.
 * Switching tabs also starts a new block (tabId changes).
 */
function pageUrlKey(url) {
  if (!url) return "unknown";
  try {
    const u = new URL(url);
    return u.host || "unknown";
  } catch (_) { return String(url); }
}

/** Short, pretty host for chip + header (no path). */
function hostShort(url) {
  try {
    const u = new URL(url);
    return u.host;
  } catch (_) { return ""; }
}

function durationStr(startTs, endTs) {
  const ms = Math.max(0, endTs - startTs);
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Build page-visits from the flat event list. A new visit begins when
 * an action or tab_activated event lands on a different (tabId, url)
 * than the current visit. Consequence events inherit their parent
 * action's visit so a click + its navigate + its page_ready stay
 * grouped, even if the URL changed along the way.
 */
function buildPageVisits(events) {
  const visits = [];
  let current = null;

  const byId = new Map();
  for (const ev of events) if (ev.id) byId.set(ev.id, ev);
  const eventToVisit = new Map();

  for (const ev of events) {
    const isAction = ACTION_KINDS_CLIENT.has(ev.kind);
    const isTabActivated = ev.kind === "tab_activated";
    let visit = null;

    // Consequences inherit their parent's visit — action + its navigate
    // stay together, no matter what URL the navigate took the tab to.
    if (ev.parentActionId && byId.has(ev.parentActionId)) {
      visit = eventToVisit.get(ev.parentActionId) || null;
    }

    if (!visit) {
      const tabId = ev.tabId ?? null;
      const urlKey = pageUrlKey(ev.context?.url);

      const differentPage = !current
        || current.tabId !== tabId
        || current.urlKey !== urlKey;

      const shouldOpenNew =
        !current ||
        ((isAction || isTabActivated) && differentPage);

      if (shouldOpenNew) {
        current = {
          key: `v${visits.length}`,
          tabId,
          urlKey,
          url: ev.context?.url || null,
          title: ev.context?.title || null,
          favIconUrl: ev.payload?.favIconUrl || null,
          startTs: ev.ts,
          endTs: ev.ts,
          events: [],
        };
        visits.push(current);
      }
      visit = current;
    }

    visit.endTs = ev.ts;
    visit.events.push(ev);
    if (ev.id) eventToVisit.set(ev.id, visit);

    if (ev.context?.title) visit.title = ev.context.title;
    if (ev.payload?.favIconUrl) visit.favIconUrl = ev.payload.favIconUrl;
    if (ev.context?.url) visit.url = ev.context.url;
  }

  for (const v of visits) {
    v.actionGroups = buildActionGroups(v.events);
  }
  return visits;
}

/**
 * Within a page-visit, fold each action and its consequences into a
 * group. Orphans (consequence events with no attributable parent) go
 * in a separate bucket surfaced above the action groups.
 */
function buildActionGroups(events) {
  const groups = [];
  const orphans = [];
  const byActionId = new Map();

  for (const ev of events) {
    // tab_activated is implicit in the visit header — don't render it
    // as its own row inside the body.
    if (ev.kind === "tab_activated") continue;

    if (ACTION_KINDS_CLIENT.has(ev.kind)) {
      const g = { action: ev, consequences: [] };
      byActionId.set(ev.id, g);
      groups.push(g);
    } else if (ev.parentActionId && byActionId.has(ev.parentActionId)) {
      byActionId.get(ev.parentActionId).consequences.push(ev);
    } else {
      orphans.push(ev);
    }
  }
  return { groups, orphans };
}

// ══════════════════════════════════════════════════════════════
// DOM builders
// ══════════════════════════════════════════════════════════════

function buildChevron() {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("class", "chevron");
  s.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M6 4l4 4-4 4");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.8");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  s.appendChild(p);
  return s;
}

function buildEventRow(ev, { isConsequence = false } = {}) {
  const row = document.createElement("div");
  row.className = "event " + eventVisualClass(ev) + (isConsequence ? " consequence" : "");
  row.dataset.timestamp = String(ev.ts);
  if (ev.id) row.dataset.eventId = ev.id;
  if (ev.parentActionId) row.dataset.parentActionId = ev.parentActionId;

  const time = document.createElement("div");
  time.className = "event-time";
  time.textContent = isConsequence ? "" : nowTimeStr(ev.ts);

  const rail = document.createElement("div");
  rail.className = "event-rail";
  const marker = document.createElement("span");
  marker.className = "event-marker";
  rail.appendChild(marker);

  const content = document.createElement("div");
  content.className = "event-content";
  const text = document.createElement("div");
  text.className = "event-text";
  text.innerHTML = eventInnerHtml(ev);
  content.appendChild(text);

  // Sub-line: URL for user events (when not obvious), or redaction flag
  const sensitive = ev.payload?.sensitive;
  const evUrl = ev.context?.url;
  const subBits = [];
  if (!isConsequence && evUrl && ev.kind !== "navigate" && ev.kind !== "page_ready" && ev.actor === "user") {
    subBits.push(shortUrl(evUrl));
  }
  if (sensitive) subBits.push("REDACTED");
  if (subBits.length > 0) {
    const sub = document.createElement("div");
    sub.className = "event-meta" + (sensitive ? " sensitive" : "");
    sub.textContent = subBits.join(" · ");
    content.appendChild(sub);
  }

  row.appendChild(time);
  row.appendChild(rail);
  row.appendChild(content);
  return row;
}

/** Visit card for the root view — clickable, drills into visit detail. */
function buildVisitCard(visit, { isCurrent = false } = {}) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "visit-card";
  if (isCurrent) card.classList.add("active");
  card.dataset.visitKey = visit.key;

  const chev = buildChevron();
  chev.classList.add("chevron");
  card.appendChild(chev);

  if (visit.favIconUrl) {
    const fav = document.createElement("img");
    fav.className = "visit-favicon";
    fav.src = visit.favIconUrl;
    fav.alt = "";
    fav.addEventListener("error", () => {
      fav.style.visibility = "hidden";
    });
    card.appendChild(fav);
  }

  const host = document.createElement("span");
  host.className = "visit-host";
  host.textContent = hostShort(visit.url) || "unknown";
  card.appendChild(host);

  const meta = document.createElement("span");
  meta.className = "visit-meta";
  const count = visit.actionGroups.groups.length;
  meta.textContent = `${count} act${count === 1 ? "" : "s"} · ${durationStr(visit.startTs, visit.endTs)}`;
  card.appendChild(meta);

  card.addEventListener("click", () => pushVisitView(visit.key));
  return card;
}

/** Action card for the visit detail view — clickable if consequences exist. */
function buildActionCard(group) {
  const hasConsequences = group.consequences.length > 0;
  const hasAlert = group.consequences.some(
    (c) => c.kind === "page_alert" || c.kind === "form_invalid"
  );

  const card = document.createElement(hasConsequences ? "button" : "div");
  if (hasConsequences) card.type = "button";
  card.className = "action-card " + eventVisualClass(group.action);
  if (hasAlert) card.classList.add("has-alert");
  if (hasConsequences) card.classList.add("clickable");
  else card.classList.add("no-detail");
  card.dataset.eventId = group.action.id;

  // Running action gets pulse (reuse .event.in-progress animation)
  if (runningActionId && group.action.id === runningActionId) {
    card.classList.add("in-progress");
  }

  // Column 1: time
  const time = document.createElement("div");
  time.className = "event-time";
  time.textContent = nowTimeStr(group.action.ts);
  card.appendChild(time);

  // Column 2: rail/marker
  const rail = document.createElement("div");
  rail.className = "event-rail";
  const marker = document.createElement("span");
  marker.className = "event-marker";
  rail.appendChild(marker);
  card.appendChild(rail);

  // Column 3: content (text + sub-meta)
  const content = document.createElement("div");
  content.className = "event-content";
  const text = document.createElement("div");
  text.className = "event-text";
  text.innerHTML = eventInnerHtml(group.action);
  content.appendChild(text);

  const sensitive = group.action.payload?.sensitive;
  const evUrl = group.action.context?.url;
  const subBits = [];
  if (evUrl && group.action.kind !== "navigate" && group.action.kind !== "page_ready" && group.action.actor === "user") {
    subBits.push(shortUrl(evUrl));
  }
  if (sensitive) subBits.push("REDACTED");
  if (subBits.length > 0) {
    const sub = document.createElement("div");
    sub.className = "event-meta" + (sensitive ? " sensitive" : "");
    sub.textContent = subBits.join(" · ");
    content.appendChild(sub);
  }
  card.appendChild(content);

  // Column 4: chevron + count badge (only when there are consequences)
  if (hasConsequences) {
    const controls = document.createElement("div");
    controls.className = "event-controls";
    const c = buildChevron();
    c.classList.add("event-chevron");
    controls.appendChild(c);
    const badge = document.createElement("span");
    badge.className = "consequences-badge";
    badge.textContent = `${group.consequences.length}`;
    controls.appendChild(badge);
    card.appendChild(controls);

    card.addEventListener("click", (e) => {
      if (e && e.target && e.target.closest && e.target.closest(".val")) return;
      pushActionView(group.action.id);
    });
  }

  return card;
}

// ══════════════════════════════════════════════════════════════
// Chip strip — "All" + one chip per host touched. Clicking a chip
// filters the root view; clicking "All" (or the active chip again)
// clears the filter. In detail views, clicking a chip pops back to
// root with that filter applied.
// ══════════════════════════════════════════════════════════════

function renderChipStrip(visits) {
  if (!chipStrip) return;
  chipStrip.innerHTML = "";
  if (visits.length === 0) return;

  // Unique hosts in visit order (deduped, latest wins for favicon)
  const hostOrder = [];
  const hostMeta = new Map(); // host -> { favIconUrl }
  for (const v of visits) {
    const h = hostShort(v.url);
    if (!h) continue;
    if (!hostMeta.has(h)) hostOrder.push(h);
    hostMeta.set(h, { favIconUrl: v.favIconUrl || hostMeta.get(h)?.favIconUrl });
  }
  if (hostOrder.length <= 1 && chipFilter == null) return; // don't clutter when only one host

  // "All" chip
  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "tab-chip all-chip";
  if (chipFilter == null) allChip.classList.add("active");
  const allLabel = document.createElement("span");
  allLabel.className = "chip-host";
  allLabel.textContent = "All";
  allChip.appendChild(allLabel);
  allChip.addEventListener("click", () => {
    chipFilter = null;
    currentView = "root";
    currentVisitKey = null;
    currentActionId = null;
    renderTimeline();
  });
  chipStrip.appendChild(allChip);

  // Per-host chips
  for (const h of hostOrder) {
    const meta = hostMeta.get(h) || {};
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tab-chip";
    if (chipFilter === h) chip.classList.add("active");

    if (meta.favIconUrl) {
      const ico = document.createElement("img");
      ico.className = "chip-favicon";
      ico.src = meta.favIconUrl;
      ico.alt = "";
      ico.addEventListener("error", () => (ico.style.display = "none"));
      chip.appendChild(ico);
    }
    const label = document.createElement("span");
    label.className = "chip-host";
    label.textContent = h;
    chip.appendChild(label);

    chip.addEventListener("click", () => {
      // Toggle: click active chip → clear filter; else set it.
      chipFilter = chipFilter === h ? null : h;
      // Always jump back to root when a chip is clicked
      currentView = "root";
      currentVisitKey = null;
      currentActionId = null;
      renderTimeline();
    });
    chipStrip.appendChild(chip);
  }
}

// ══════════════════════════════════════════════════════════════
// Dossier — "Pixel is looking at…" pinned header
// ══════════════════════════════════════════════════════════════

function updateDossier(currentVisit) {
  if (!dossier) return;
  if (!currentVisit || !currentVisit.url) {
    dossier.classList.add("empty");
    return;
  }
  dossier.classList.remove("empty");
  if (dossierFavicon) {
    if (currentVisit.favIconUrl) {
      dossierFavicon.src = currentVisit.favIconUrl;
      dossierFavicon.style.visibility = "visible";
    } else {
      dossierFavicon.removeAttribute("src");
      dossierFavicon.style.visibility = "hidden";
    }
  }
  if (dossierHost) dossierHost.textContent = shortUrl(currentVisit.url) || "";
  if (dossierTitle) dossierTitle.textContent = currentVisit.title || "";
}

// ══════════════════════════════════════════════════════════════
// Jump-to-latest pill — appears when new events land while the
// user is scrolled up. Doesn't steal scroll.
// ══════════════════════════════════════════════════════════════

function isNearBottom() {
  if (!stream) return true;
  return stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
}
function scrollToBottom() {
  if (!stream) return;
  stream.scrollTop = stream.scrollHeight;
}
function refreshJumpPill() {
  if (!jumpToLatest || !jumpToLatestCount) return;
  if (pendingBelow <= 0) {
    jumpToLatest.classList.add("hidden");
    return;
  }
  jumpToLatestCount.textContent = String(pendingBelow);
  jumpToLatest.classList.remove("hidden");
}
if (jumpToLatest) {
  jumpToLatest.addEventListener("click", () => {
    pendingBelow = 0;
    refreshJumpPill();
    scrollToBottom();
  });
}
if (stream) {
  stream.addEventListener("scroll", () => {
    if (isNearBottom()) {
      pendingBelow = 0;
      refreshJumpPill();
    }
  });
}

// ══════════════════════════════════════════════════════════════
// Click-to-copy on URL chips (the orange `.val` spans)
// ══════════════════════════════════════════════════════════════

if (timelineBody) {
  timelineBody.addEventListener("click", (e) => {
    const chip = e.target.closest && e.target.closest(".val");
    if (!chip) return;
    const text = chip.textContent || "";
    if (!text) return;
    e.stopPropagation(); // don't toggle the parent action
    try {
      navigator.clipboard.writeText(text).then(
        () => {
          if (typeof showToast === "function") {
            showToast(`Copied "${text.length > 40 ? text.slice(0, 37) + "…" : text}"`, {
              tone: "info",
              duration: 1600,
            });
          }
        },
        () => {}
      );
    } catch (_) {}
  });
}

// ══════════════════════════════════════════════════════════════
// Drill-down navigation
// ══════════════════════════════════════════════════════════════

function pushVisitView(visitKey) {
  currentView = "visit";
  currentVisitKey = visitKey;
  currentActionId = null;
  renderTimeline();
  if (stream) stream.scrollTop = 0;
}

function pushActionView(actionId) {
  currentView = "action";
  currentActionId = actionId;
  renderTimeline();
  if (stream) stream.scrollTop = 0;
}

function popView() {
  if (currentView === "action") {
    currentView = "visit";
    currentActionId = null;
  } else if (currentView === "visit") {
    currentView = "root";
    currentVisitKey = null;
  }
  renderTimeline();
}

if (backBtn) backBtn.addEventListener("click", popView);

function findActionGroup(visits, actionId) {
  for (const v of visits) {
    for (const g of v.actionGroups.groups) {
      if (g.action.id === actionId) return { visit: v, group: g };
    }
  }
  return null;
}

function setNavHeader(title, show) {
  if (!navHeader || !navTitle) return;
  if (show) {
    navTitle.textContent = title || "";
    navHeader.classList.remove("hidden");
  } else {
    navHeader.classList.add("hidden");
  }
}

// ══════════════════════════════════════════════════════════════
// View renderers
// ══════════════════════════════════════════════════════════════

function renderRootView(body, visits) {
  setNavHeader("", false);

  const filtered = chipFilter
    ? visits.filter((v) => hostShort(v.url) === chipFilter)
    : visits;

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "visit-empty";
    empty.textContent = chipFilter
      ? `Nothing captured on ${chipFilter} yet.`
      : "Nothing captured yet.";
    body.appendChild(empty);
    return;
  }

  // Current visit = last visit overall; mark it active for the ember accent.
  const currentVisit = visits[visits.length - 1];
  for (const v of filtered) {
    body.appendChild(buildVisitCard(v, { isCurrent: v === currentVisit }));
  }
}

function renderVisitDetail(body, visit) {
  const title = hostShort(visit.url) || "unknown";
  setNavHeader(title, true);

  const groups = visit.actionGroups.groups;
  const orphans = visit.actionGroups.orphans;

  // Orphan "page activity" (alerts, title changes, dialogs not tied to an action)
  // appears at the top of the visit detail.
  for (const o of orphans) {
    // Render orphans as leaf-style action cards (no consequences).
    const pseudo = { action: o, consequences: [] };
    body.appendChild(buildActionCard(pseudo));
  }

  if (groups.length === 0 && orphans.length === 0) {
    const empty = document.createElement("div");
    empty.className = "visit-empty";
    empty.textContent = "No activity yet on this page.";
    body.appendChild(empty);
    return;
  }

  for (const g of groups) {
    body.appendChild(buildActionCard(g));
  }
}

function renderActionDetail(body, visit, group) {
  // Use a short summary of the action as the nav title (plain-text,
  // stripping any HTML tags from eventInnerHtml).
  const tmp = document.createElement("div");
  tmp.innerHTML = eventInnerHtml(group.action);
  const title = (tmp.textContent || "").slice(0, 80);
  setNavHeader(title, true);

  // Action row itself (as a non-clickable card)
  const actionPseudo = { action: group.action, consequences: [] };
  const actionCard = buildActionCard(actionPseudo);
  actionCard.classList.add("no-detail");
  body.appendChild(actionCard);

  // Consequences as leaf rows below
  if (group.consequences.length === 0) {
    const empty = document.createElement("div");
    empty.className = "visit-empty";
    empty.textContent = "No consequences recorded for this action.";
    body.appendChild(empty);
    return;
  }
  for (const c of group.consequences) {
    body.appendChild(buildEventRow(c, { isConsequence: true }));
  }
}

// ══════════════════════════════════════════════════════════════
// Render entry point — routes to the right view
// ══════════════════════════════════════════════════════════════

function renderTimeline() {
  if (!timelineBody) return;

  const wasNearBottom = isNearBottom();
  timelineBody.innerHTML = "";

  const visits = buildPageVisits(timelineEvents);
  if (streamIdle) {
    streamIdle.classList.toggle("hidden", visits.length > 0);
  }

  // Route to view. If a stale ref points to something no longer present,
  // fall back to root gracefully.
  let viewResolved = currentView;
  if (viewResolved === "action") {
    const found = findActionGroup(visits, currentActionId);
    if (found) {
      renderActionDetail(timelineBody, found.visit, found.group);
    } else {
      viewResolved = "root";
      currentView = "root";
      currentActionId = null;
      currentVisitKey = null;
      renderRootView(timelineBody, visits);
    }
  } else if (viewResolved === "visit") {
    const visit = visits.find((v) => v.key === currentVisitKey);
    if (visit) {
      renderVisitDetail(timelineBody, visit);
    } else {
      viewResolved = "root";
      currentView = "root";
      currentVisitKey = null;
      renderRootView(timelineBody, visits);
    }
  } else {
    renderRootView(timelineBody, visits);
  }

  renderChipStrip(visits);
  updateDossier(visits.length ? visits[visits.length - 1] : null);

  if (wasNearBottom) scrollToBottom();
}

function appendTimelineEvent(ev) {
  // Background is the source of truth for id/sessionId/ts/actor/parentActionId.
  // We just defensively coerce in case a malformed event slips through.
  if (ev.ts == null) ev.ts = Date.now();
  if (!ev.actor) ev.actor = "system";

  const wasNearBottom = isNearBottom();

  timelineEvents.push(ev);
  if (timelineEvents.length > TIMELINE_MAX_EVENTS) {
    timelineEvents.splice(0, timelineEvents.length - TIMELINE_MAX_EVENTS);
  }

  // Update the running-action tracker.
  if (ev.kind === "agent_action") {
    runningActionId = ev.id;
  } else if (ev.kind === "agent_done") {
    runningActionId = null;
  }

  renderTimeline();

  // Jump-to-latest counter: if user was scrolled up, count new arrivals.
  if (!wasNearBottom) {
    pendingBelow += 1;
    refreshJumpPill();
  }

  refreshStateIndicator(ev);
}

function clearTimeline() {
  timelineEvents.length = 0;
  pendingBelow = 0;
  runningActionId = null;
  // Reset navigation state too — "new chat" returns you to the root view
  // with no filter, regardless of where you had drilled into.
  currentView = "root";
  currentVisitKey = null;
  currentActionId = null;
  chipFilter = null;
  refreshJumpPill();
  renderTimeline();
  resetStateIndicator();
  // Tell background to regenerate sessionIds across all known tabs so the
  // next batch of events arrives under a fresh session.
  try {
    chrome.runtime
      .sendMessage({ type: "pixelfoxx_session_reset" })
      .catch(() => {});
  } catch (_) {}
}

// --- incoming events from background (content captures + webNav) --------

chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== "pixelfoxx_event") return;
  const ev = message.event;
  if (!ev || !ev.kind) return;
  // Re-attach CDP network capture when the user switches tabs.
  // attachDebugger is idempotent, so same-tab tab_activated is a no-op.
  if (ev.kind === "tab_activated" && ev.tabId != null) {
    ensureNetworkCapture(ev.tabId);
  }
  appendTimelineEvent(ev);
});

/**
 * Agent event mirror. Called by the agent loop.
 *
 * Renders synchronously (no IPC round-trip → no flicker, no reorder risk
 * vs incoming user events). Notifies background as a state-update so it
 * can open the action window for outcome attribution and mark agent
 * navigates for re-tagging in the webNavigation handler.
 */
function appendAgentTimelineEvent(kind, data) {
  const tabId = (typeof getActiveAgentTabId === "function")
    ? getActiveAgentTabId()
    : null;
  const ev = {
    id: crypto.randomUUID(),
    sessionId: null, // sidepanel doesn't track sessionIds; background owns them
    ts: Date.now(),
    source: "agent",
    kind,
    actor: "agent",
    tabId,
    payload: data || {},
    parentActionId: null,
    causedBy: "agent-action",
  };

  // Render immediately so the user sees agent thoughts/actions without lag.
  appendTimelineEvent(ev);

  // Notify background so it can update tabState (action window + agent-nav mark).
  try {
    chrome.runtime
      .sendMessage({ type: "pixelfoxx_emit", event: ev })
      .catch(() => {});
  } catch (_) {}
}
window.appendAgentTimelineEvent = appendAgentTimelineEvent;

// ══════════════════════════════════════════════════════════════
// STATE INDICATOR — who's driving right now
// ══════════════════════════════════════════════════════════════

let stateIdleTimer = null;

function setState({ actor, verb, mode }) {
  if (!stateIndicator || !stateActorEl || !stateVerbEl) return;
  if (actor) stateActorEl.textContent = actor;
  if (verb) stateVerbEl.textContent = verb;
  stateIndicator.classList.remove("idle", "active-user", "active-agent");
  if (mode) stateIndicator.classList.add(mode);
}

function resetStateIndicator() {
  setState({ actor: "Foxx", verb: "is observing", mode: "idle" });
  if (stateTimingEl) stateTimingEl.textContent = "";
}

/** React to the most recent event to show who's driving. */
function refreshStateIndicator(ev) {
  if (!ev) return;
  if (running) {
    setState({ actor: "Foxx", verb: "is driving…", mode: "active-agent" });
    return;
  }
  if (ev.actor === "user") {
    setState({ actor: "You", verb: "are driving", mode: "active-user" });
    clearTimeout(stateIdleTimer);
    stateIdleTimer = setTimeout(() => {
      if (!running) resetStateIndicator();
    }, 6000);
    return;
  }
  if (ev.actor === "agent" && ev.kind === "agent_done") {
    setState({ actor: "Foxx", verb: "finished the task", mode: "idle" });
    return;
  }
}

// ══════════════════════════════════════════════════════════════
// TOASTS — for errors + system notifications
// ══════════════════════════════════════════════════════════════

function showToast(message, { tone = "error", duration = 5000 } = {}) {
  if (!toastTray) return;
  const toast = document.createElement("div");
  toast.className = "toast" + (tone === "info" ? " info" : "");
  toast.textContent = message;
  toastTray.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("fading");
    setTimeout(() => toast.remove(), 260);
  }, duration);
}
window.showToast = showToast;

// Initialize the state indicator on load.
resetStateIndicator();
