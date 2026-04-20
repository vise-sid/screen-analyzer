// PixelFoxx service worker.
//
// Hosts playwright-crx and dispatches browser-tool requests from the
// sidepanel against the user's active Chrome tab via chrome.debugger.
//
// Why here (not in the sidepanel)? chrome.debugger lifetime tracks the
// extension; routing through the service worker keeps a single CrxApplication
// alive across sidepanel reloads. The sidepanel sends RPC-style messages;
// we own attach/detach and the active Page handle.

import { crx } from "playwright-crx";

let crxApp = null;        // CrxApplication singleton
let attachedTabId = null; // tab we currently control
let page = null;          // playwright Page bound to attachedTabId

async function ensureApp() {
  if (!crxApp) {
    crxApp = await crx.start({ slowMo: 0 });
    crxApp.on("detached", (tabId) => {
      if (tabId === attachedTabId) {
        attachedTabId = null;
        page = null;
      }
    });
  }
  return crxApp;
}

function isRestrictedUrl(url) {
  return !url
    || /^chrome(-extension)?:\/\//.test(url)
    || url.startsWith("about:")
    || url === "";
}

async function pickStartingTab() {
  // First, prefer the active tab in the last-focused window.
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id && !isRestrictedUrl(active.url)) return active.id;
  // Otherwise, scan all tabs for any non-restricted candidate.
  const all = await chrome.tabs.query({});
  for (const t of all) {
    if (t.id && !isRestrictedUrl(t.url)) return t.id;
  }
  // Nothing usable — open a new tab to a blank-but-real page.
  const created = await chrome.tabs.create({ url: "about:blank", active: false });
  return created.id;
}

async function isTabAlive(tabId) {
  if (tabId == null) return false;
  try {
    const t = await chrome.tabs.get(tabId);
    return !!t && !isRestrictedUrl(t.url || "about:blank");
  } catch (_) {
    return false;
  }
}

async function ensureAttached() {
  await ensureApp();
  // 1. If we already have a page bound to a live tab, use it. Don't chase the
  //    user's tab focus — once attached, the agent owns its tab.
  if (attachedTabId != null && (await isTabAlive(attachedTabId))) {
    return page;
  }
  // 2. Tab is dead/missing — clean up + pick a new one.
  if (attachedTabId != null) {
    try { await crxApp.detach(attachedTabId); } catch (_) {}
  }
  attachedTabId = await pickStartingTab();
  // attach() refreshes our page reference; navigate() will move the tab.
  page = await crxApp.attach(attachedTabId);
  return page;
}

// ── Tool dispatch ──────────────────────────────────────────────
//
// We expose Playwright's recommended locator builders directly. The agent
// passes structured arguments (by, name/role/selector) — never raw selector
// strings. Backend dispatches to page.getByRole / getByLabel / etc.

const NAV_TIMEOUT = 15_000;
const ACT_TIMEOUT = 8_000;

/**
 * Resolve {by, name, role, selector, exact, n} into a Playwright Locator.
 * Throws a clear Error if the args don't make sense for the chosen `by`.
 */
function buildLocator(p, args) {
  const { by, name, role, selector, exact = false, n = 0 } = args || {};
  if (!by) throw new Error("locator missing required arg `by`");
  let loc;
  switch (by) {
    case "role":
      if (!role) throw new Error("by='role' requires `role` (e.g. 'button')");
      loc = name
        ? p.getByRole(role, { name, exact })
        : p.getByRole(role);
      break;
    case "label":
      if (!name) throw new Error("by='label' requires `name` (the label text)");
      loc = p.getByLabel(name, { exact });
      break;
    case "placeholder":
      if (!name) throw new Error("by='placeholder' requires `name` (the placeholder text)");
      loc = p.getByPlaceholder(name, { exact });
      break;
    case "text":
      if (!name) throw new Error("by='text' requires `name` (the visible text)");
      loc = p.getByText(name, { exact });
      break;
    case "testid":
      if (!name) throw new Error("by='testid' requires `name` (the testid value)");
      loc = p.getByTestId(name);
      break;
    case "css":
      if (!selector) throw new Error("by='css' requires `selector` (raw CSS)");
      loc = p.locator(selector);
      break;
    default:
      throw new Error(`unknown by=${by}`);
  }
  if (n && n > 0) loc = loc.nth(n);
  else loc = loc.first();
  return loc;
}

function describeLocator(args) {
  const { by, name, role, selector, n = 0 } = args || {};
  if (by === "role") return `getByRole(${role}, name=${JSON.stringify(name || "")})${n ? `.nth(${n})` : ""}`;
  if (by === "css") return `locator(${selector})${n ? `.nth(${n})` : ""}`;
  return `getBy${by[0].toUpperCase()}${by.slice(1)}(${JSON.stringify(name || "")})${n ? `.nth(${n})` : ""}`;
}

async function executeBrowserTool(tool) {
  const { name, args = {} } = tool;

  // list_tabs and switch_tab must NOT require ensureAttached() — they're how
  // the agent picks WHICH tab to attach to. Handle them up front.
  if (name === "list_tabs") {
    const all = await chrome.tabs.query({});
    const tabs = all
      .filter((t) => t.id != null)
      .map((t) => ({
        id: t.id,
        url: t.url || "",
        title: t.title || "",
        active: !!t.active,
        agent_attached: t.id === attachedTabId,
        restricted: isRestrictedUrl(t.url || ""),
      }));
    return { ok: true, tabs };
  }

  if (name === "switch_tab") {
    const targetId = args.tab_id;
    if (typeof targetId !== "number") return { ok: false, error: "switch_tab requires numeric tab_id" };
    let targetTab;
    try {
      targetTab = await chrome.tabs.get(targetId);
    } catch (e) {
      return { ok: false, error: `tab ${targetId} not found: ${e?.message || e}` };
    }
    if (isRestrictedUrl(targetTab.url || "")) {
      return { ok: false, error: `tab ${targetId} is on restricted URL: ${targetTab.url}` };
    }
    if (attachedTabId != null && attachedTabId !== targetId) {
      try { await crxApp.detach(attachedTabId); } catch (_) {}
    }
    await ensureApp();
    page = await crxApp.attach(targetId);
    attachedTabId = targetId;
    try { await chrome.tabs.update(targetId, { active: true }); } catch (_) {}
    return {
      ok: true,
      tab_id: targetId,
      url: page.url(),
      title: await page.title(),
    };
  }

  // navigate() is special: it can BOOTSTRAP the agent's tab. If no live tab
  // is attached, open a fresh one and use it. Other primitives just attach
  // to whatever's there.
  if (name === "navigate") {
    if (attachedTabId == null || !(await isTabAlive(attachedTabId))) {
      await ensureApp();
      const created = await chrome.tabs.create({ url: args.url, active: false });
      attachedTabId = created.id;
      page = await crxApp.attach(attachedTabId);
      // chrome.tabs.create already triggered the navigation; just wait for it.
      try { await page.waitForLoadState("domcontentloaded", { timeout: NAV_TIMEOUT }); } catch (_) {}
      return { ok: true, url: page.url(), opened_new_tab: true };
    }
    await page.goto(args.url, { timeout: NAV_TIMEOUT, waitUntil: "domcontentloaded" });
    return { ok: true, url: page.url() };
  }

  const p = await ensureAttached();

  if (name === "observe") {
    const include = args.include || ["snapshot"];
    const out = { ok: true, url: p.url(), title: await p.title() };
    if (include.includes("snapshot")) {
      // ariaSnapshot returns YAML; perfect for the model. To address an
      // element later, the model crafts a Playwright selector from this
      // tree (e.g. role=button[name="Sign in"]).
      out.snapshot = await p.locator("body").ariaSnapshot({ timeout: ACT_TIMEOUT });
    }
    if (include.includes("screenshot")) {
      const buf = await p.screenshot({ type: "png", fullPage: false, timeout: ACT_TIMEOUT });
      out.screenshot_b64 = arrayBufferToBase64(buf);
    }
    return out;
  }

  if (name === "click") {
    const loc = buildLocator(p, args);
    const urlBefore = p.url();
    try {
      await loc.click({ timeout: ACT_TIMEOUT });
    } catch (e) {
      return {
        ok: false,
        locator: describeLocator(args),
        error: `click failed: ${String(e?.message || e).split("\n")[0]}`,
      };
    }
    // Best-effort: short settle for any resulting navigation/state change.
    try {
      await p.waitForLoadState("domcontentloaded", { timeout: 2000 });
    } catch (_) { /* not all clicks navigate */ }
    return { ok: true, locator: describeLocator(args), url: p.url(), url_changed: p.url() !== urlBefore };
  }

  if (name === "type") {
    const loc = buildLocator(p, args);
    const text = args.text || "";
    let actualLen = -1;
    try {
      // Focus + clear + type with REAL keystrokes. Per-char human-like
      // jitter (40-90ms) — sites like GST captcha reject machine-precision
      // timing AND only accept value when keydown/keyup fire.
      await loc.click({ timeout: ACT_TIMEOUT });
      await loc.fill("", { timeout: ACT_TIMEOUT });
      if (text) {
        for (const char of text) {
          await p.keyboard.type(char);
          await new Promise((r) => setTimeout(r, 40 + Math.random() * 50));
        }
      }
      if (args.submit) {
        await loc.press("Enter");
      }
      try {
        const v = await loc.inputValue({ timeout: 1500 });
        actualLen = v == null ? -1 : v.length;
      } catch (_) { /* not an input element */ }
    } catch (e) {
      return {
        ok: false,
        locator: describeLocator(args),
        error: `type failed: ${String(e?.message || e).split("\n")[0]}`,
      };
    }
    const expectedLen = text.length;
    const matched = actualLen === expectedLen;
    return {
      ok: matched,
      locator: describeLocator(args),
      expected_chars: expectedLen,
      actual_chars: actualLen,
      submitted: !!args.submit,
      error: matched ? undefined :
        `value mismatch after type: expected ${expectedLen} chars, field has ${actualLen}. ` +
        `Locator (${describeLocator(args)}) may have hit the wrong element. ` +
        `Try a different by/name combination.`,
    };
  }

  if (name === "key") {
    await p.keyboard.press(args.key);
    return { ok: true, key: args.key };
  }

  if (name === "scroll") {
    await p.evaluate((dy) => window.scrollBy(0, dy), args.deltaY || 0);
    return { ok: true, deltaY: args.deltaY };
  }

  if (name === "wait_for") {
    const timeout = args.timeout_ms || 8000;
    try {
      if (args.url_pattern) {
        await p.waitForURL((u) => u.toString().includes(args.url_pattern), { timeout });
        return { ok: true, mode: "url", url: p.url() };
      }
      if (args.load_state) {
        await p.waitForLoadState(args.load_state, { timeout });
        return { ok: true, mode: "load_state", state: args.load_state };
      }
      // locator state
      const state = args.state || "visible";
      const loc = buildLocator(p, args);
      await loc.waitFor({ state, timeout });
      return { ok: true, mode: "locator_state", state, locator: describeLocator(args) };
    } catch (e) {
      return { ok: false, error: `wait_for timed out: ${String(e?.message || e).split("\n")[0]}` };
    }
  }

  if (name === "reauth_google") {
    return { ok: true, message: "reauth_google not yet wired in extension" };
  }

  return { ok: false, error: `unknown browser tool ${name}` };
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return self.btoa(s);
}

// ── Message bus ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "browser_tool") {
    executeBrowserTool(msg.tool)
      .then((result) => sendResponse(result))
      .catch((e) => {
        console.error("[bg] tool failed:", msg.tool?.name, e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      });
    return true; // keep channel open for async response
  }
  if (msg?.type === "ping") {
    sendResponse({ ok: true, attached_tab: attachedTabId });
    return false;
  }
  return false;
});

// ── Side panel auto-open on action click ───────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) =>
    console.error("[bg] sidePanel.open failed:", e)
  );
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn("[bg] setPanelBehavior:", e));
});
