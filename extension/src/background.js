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

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  if (!tab.url || /^chrome(-extension)?:\/\//.test(tab.url) || tab.url.startsWith("about:")) {
    throw new Error(`cannot operate on restricted URL: ${tab.url}`);
  }
  return tab.id;
}

async function ensureAttached() {
  await ensureApp();
  const targetTabId = await activeTabId();
  if (attachedTabId !== targetTabId) {
    if (attachedTabId !== null) {
      try { await crxApp.detach(attachedTabId); } catch (_) {}
    }
    page = await crxApp.attach(targetTabId);
    attachedTabId = targetTabId;
  }
  return page;
}

// ── Tool dispatch ──────────────────────────────────────────────
//
// Selector model (kept simple for v1): the agent learns from observe()
// what's on the page, then targets elements with Playwright selector
// strings the model derives from the snapshot:
//   - role=button[name="Sign in"]
//   - text=Continue
//   - css=#main .submit
//   - getByRole-equivalent lookups via locator strings
// We pass the model's `ref` straight into page.locator(ref).

const NAV_TIMEOUT = 15_000;
const ACT_TIMEOUT = 8_000;

async function executeBrowserTool(tool) {
  const { name, args = {} } = tool;
  const p = await ensureAttached();

  if (name === "navigate") {
    await p.goto(args.url, { timeout: NAV_TIMEOUT, waitUntil: "domcontentloaded" });
    return { ok: true, url: p.url() };
  }

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
    await p.locator(args.ref).first().click({ timeout: ACT_TIMEOUT });
    return { ok: true, ref: args.ref };
  }

  if (name === "type") {
    const loc = p.locator(args.ref).first();
    await loc.fill(args.text || "", { timeout: ACT_TIMEOUT });
    if (args.submit) {
      await loc.press("Enter");
    }
    return { ok: true, ref: args.ref, chars_typed: (args.text || "").length, submitted: !!args.submit };
  }

  if (name === "key") {
    await p.keyboard.press(args.key);
    return { ok: true, key: args.key };
  }

  if (name === "scroll") {
    await p.evaluate((dy) => window.scrollBy(0, dy), args.deltaY || 0);
    return { ok: true, deltaY: args.deltaY };
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
