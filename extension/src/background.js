// PixelFoxx service worker.
//
// Hosts playwright-crx, dispatches browser-tool requests from the sidepanel
// against the user's Chrome via chrome.debugger. Includes the ports of
// origin/main's CDP-wrapper capabilities on top of the Playwright engine:
//   - Stealth init script
//   - Network capture (page.on response → /scrape kind="network")
//   - Dialog auto-handler
//   - Tab grouping ("Agent" purple group)
//   - Structured snapshot enrichment (popup/captcha/canvas/scroll)
//   - Scrape primitives (page/table/links/metadata/network)
//   - Popup dispatcher (dismiss + click_captcha)
//   - Cookies dispatcher (extract / inject)
//   - Action verbs: double_click, hover, key_combo, back, forward, fill_cells

import { crx } from "playwright-crx";
import { STEALTH_INIT_SCRIPT } from "./stealth.js";
import {
  SNAPSHOT_DETECT_SCRIPT,
  SCRAPE_LINKS_SCRIPT,
  SCRAPE_METADATA_SCRIPT,
  SCRAPE_PAGE_HTML_SCRIPT,
  SCRAPE_TABLE_FN,
  DISMISS_POPUP_SCRIPT,
  FIND_CAPTCHA_TARGET_SCRIPT,
} from "./page_scripts.js";

// ── State ──────────────────────────────────────────────────────
let crxApp = null;
let attachedTabId = null;
let page = null;
let agentGroupId = null;       // chrome.tabGroups id for the "Agent" group
let originalTabId = null;      // tab the user was on when session started
const networkCaptures = [];    // captured response refs (per-tab)
const MAX_NETWORK = 50;
let stealthApplied = false;

// ── playwright-crx bootstrap ───────────────────────────────────
async function ensureApp() {
  if (!crxApp) {
    crxApp = await crx.start({ slowMo: 0 });
    crxApp.on("detached", (tabId) => {
      if (tabId === attachedTabId) {
        attachedTabId = null;
        page = null;
        clearNetworkCaptures();
      }
    });
  }
  if (!stealthApplied) {
    try {
      await crxApp.context().addInitScript({ content: STEALTH_INIT_SCRIPT });
      stealthApplied = true;
      console.log("[bg] stealth init script applied to context");
    } catch (e) {
      console.warn("[bg] stealth addInitScript failed:", e);
    }
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
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id && !isRestrictedUrl(active.url)) return active.id;
  const all = await chrome.tabs.query({});
  for (const t of all) {
    if (t.id && !isRestrictedUrl(t.url)) return t.id;
  }
  const created = await chrome.tabs.create({ url: "about:blank", active: false });
  return created.id;
}

async function isTabAlive(tabId) {
  if (tabId == null) return false;
  try {
    const t = await chrome.tabs.get(tabId);
    return !!t && !isRestrictedUrl(t.url || "about:blank");
  } catch (_) { return false; }
}

// Bring the agent's tab + its window to the foreground so the user can SEE
// what the agent is doing. Without this, navigate() opens background tabs
// and the user thinks the agent isn't doing anything.
async function bringTabToFront(tabId) {
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId != null) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
    }
  } catch (e) {
    console.warn("[bg] bringTabToFront failed:", e);
  }
}

// Force a sane desktop viewport so sites don't render their mobile layout
// (collapsed hamburger nav, hidden LOGIN/REGISTER, etc.). This is a CDP
// Emulation override — it does NOT physically resize the user's window.
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
async function applyDesktopViewport(p) {
  if (!p) return;
  try { await p.setViewportSize(DESKTOP_VIEWPORT); }
  catch (e) { console.warn("[bg] setViewportSize failed:", e); }
}

// ── Tab grouping ("Agent" purple group, ports tabs.js) ─────────
const MAX_AGENT_TABS = 5; // safety cap mirroring origin/main
async function ensureAgentGroup(tabId) {
  if (!chrome.tabGroups || tabId == null) return;
  try {
    if (agentGroupId == null) {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      agentGroupId = groupId;
      await chrome.tabGroups.update(groupId, {
        title: "Agent", color: "purple", collapsed: false,
      });
    } else {
      const tab = await chrome.tabs.get(tabId);
      if (tab.groupId !== agentGroupId) {
        // Enforce the 5-tab cap before adding. Close the OLDEST group member
        // that isn't the original tab or the one being attached.
        const groupTabs = await chrome.tabs.query({ groupId: agentGroupId });
        if (groupTabs.length >= MAX_AGENT_TABS) {
          const evictable = groupTabs
            .filter((t) => t.id !== tabId && t.id !== originalTabId)
            .sort((a, b) => (a.id || 0) - (b.id || 0)); // oldest tab id first
          const victim = evictable[0];
          if (victim?.id != null) {
            try { await chrome.tabs.remove(victim.id); }
            catch (e) { console.warn("[bg] evict tab failed:", e); }
          }
        }
        await chrome.tabs.group({ tabIds: [tabId], groupId: agentGroupId });
      }
    }
  } catch (e) {
    console.warn("[bg] ensureAgentGroup failed:", e);
  }
}

async function ensureAttached() {
  await ensureApp();
  if (attachedTabId != null && (await isTabAlive(attachedTabId))) {
    return page;
  }
  if (attachedTabId != null) {
    try { await crxApp.detach(attachedTabId); } catch (_) {}
  }
  attachedTabId = await pickStartingTab();
  if (originalTabId == null) originalTabId = attachedTabId;
  page = await crxApp.attach(attachedTabId);
  await applyDesktopViewport(page);
  await ensureAgentGroup(attachedTabId);
  attachNetworkListener();
  attachDialogHandler();
  await bringTabToFront(attachedTabId);
  return page;
}

// ── Network capture (page-level listener; auto-clears on nav) ──
function clearNetworkCaptures() {
  networkCaptures.length = 0;
}

function attachNetworkListener() {
  if (!page) return;
  // Avoid duplicate listeners on re-attach.
  if (page._pixelNetAttached) return;
  page._pixelNetAttached = true;

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) clearNetworkCaptures();
  });
  page.on("response", async (resp) => {
    try {
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      if (!ct.includes("json")) return;
      networkCaptures.push({
        url: resp.url(),
        status: resp.status(),
        mime: ct,
        ts: Date.now(),
        _resp: resp,
      });
      while (networkCaptures.length > MAX_NETWORK) networkCaptures.shift();
    } catch (_) {}
  });
}

function attachDialogHandler() {
  if (!page || page._pixelDialogAttached) return;
  page._pixelDialogAttached = true;
  page.on("dialog", async (d) => {
    // Default: accept beforeunload (so navigation isn't blocked) and dismiss
    // alert/confirm/prompt — mirrors origin/main's auto-handler. Agent can
    // override by calling dialog(action="accept"/"dismiss") if it expects one.
    try {
      const t = d.type();
      if (t === "beforeunload" || t === "alert") await d.accept();
      else await d.dismiss();
    } catch (_) {}
  });
}

// ── Locator builder (structured (by, name/role/selector) → Playwright) ──
function buildLocator(p, args) {
  const { by, name, role, selector, exact = false, n = 0 } = args || {};
  if (!by) throw new Error("locator missing required arg `by`");
  let loc;
  switch (by) {
    case "role":
      if (!role) throw new Error("by='role' requires `role`");
      loc = name ? p.getByRole(role, { name, exact }) : p.getByRole(role);
      break;
    case "label":
      if (!name) throw new Error("by='label' requires `name`");
      loc = p.getByLabel(name, { exact });
      break;
    case "placeholder":
      if (!name) throw new Error("by='placeholder' requires `name`");
      loc = p.getByPlaceholder(name, { exact });
      break;
    case "text":
      if (!name) throw new Error("by='text' requires `name`");
      loc = p.getByText(name, { exact });
      break;
    case "testid":
      if (!name) throw new Error("by='testid' requires `name`");
      loc = p.getByTestId(name);
      break;
    case "css":
      if (!selector) throw new Error("by='css' requires `selector`");
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

// ── Tool dispatch ──────────────────────────────────────────────
const NAV_TIMEOUT = 15_000;
const ACT_TIMEOUT = 8_000;

async function executeBrowserTool(tool) {
  const { name, args = {} } = tool;

  // navigate is special: bootstraps the agent's tab if needed.
  if (name === "navigate") {
    if (attachedTabId == null || !(await isTabAlive(attachedTabId))) {
      await ensureApp();
      // active: true so the user SEES the agent open the page. Without this
      // the tab opens in the background and the user thinks nothing happened.
      const created = await chrome.tabs.create({ url: args.url, active: true });
      attachedTabId = created.id;
      if (originalTabId == null) originalTabId = attachedTabId;
      page = await crxApp.attach(attachedTabId);
      await applyDesktopViewport(page);
      await ensureAgentGroup(attachedTabId);
      attachNetworkListener();
      attachDialogHandler();
      await bringTabToFront(attachedTabId);
      try { await page.waitForLoadState(args.wait || "domcontentloaded", { timeout: NAV_TIMEOUT }); } catch (_) {}
      return { ok: true, url: page.url(), opened_new_tab: true };
    }
    await page.goto(args.url, { timeout: NAV_TIMEOUT, waitUntil: args.wait || "domcontentloaded" });
    return { ok: true, url: page.url() };
  }

  if (name === "list_tabs") {
    const all = await chrome.tabs.query({});
    return { ok: true, tabs: all.filter((t) => t.id != null).map((t) => ({
      id: t.id, url: t.url || "", title: t.title || "",
      active: !!t.active, agent_attached: t.id === attachedTabId,
      restricted: isRestrictedUrl(t.url || ""),
    })) };
  }

  if (name === "switch_tab") {
    const targetId = args.tab_id;
    if (typeof targetId !== "number") return { ok: false, error: "switch_tab requires numeric tab_id" };
    let targetTab;
    try { targetTab = await chrome.tabs.get(targetId); }
    catch (e) { return { ok: false, error: `tab ${targetId} not found: ${e?.message || e}` }; }
    if (isRestrictedUrl(targetTab.url || "")) {
      return { ok: false, error: `tab ${targetId} is on restricted URL: ${targetTab.url}` };
    }
    if (attachedTabId != null && attachedTabId !== targetId) {
      try { await crxApp.detach(attachedTabId); } catch (_) {}
    }
    await ensureApp();
    page = await crxApp.attach(targetId);
    attachedTabId = targetId;
    if (originalTabId == null) originalTabId = targetId;
    await applyDesktopViewport(page);
    await ensureAgentGroup(targetId);
    attachNetworkListener();
    attachDialogHandler();
    await bringTabToFront(targetId);
    return { ok: true, tab_id: targetId, url: page.url(), title: await page.title() };
  }

  // All remaining tools need an attached page.
  const p = await ensureAttached();

  if (name === "observe") {
    const include = args.include || ["snapshot"];
    const out = { ok: true, url: p.url(), title: await p.title() };
    if (include.includes("snapshot")) {
      out.snapshot = await p.locator("body").ariaSnapshot({ timeout: ACT_TIMEOUT });
    }
    if (include.includes("screenshot")) {
      const buf = await p.screenshot({ type: "png", fullPage: false, timeout: ACT_TIMEOUT });
      out.screenshot_b64 = arrayBufferToBase64(buf);
    }
    // Always run the lightweight detect script — popup/captcha/hamburger/
    // canvas/scroll signal is cheap and high-leverage for the agent.
    try {
      const detectJson = await p.evaluate(SNAPSHOT_DETECT_SCRIPT);
      const detect = JSON.parse(detectJson);
      out.popup = detect.popup || null;
      out.captcha = detect.captcha || null;
      out.nav_hamburger = detect.nav_hamburger || null;
      out.is_canvas_heavy = !!detect.isCanvasHeavy;
      out.viewport = detect.viewport;
      out.page_loading = !!detect.pageLoading;
      out.page_scroll = detect.pageScroll;
      out.scroll_containers = detect.scrollContainers || [];
    } catch (e) {
      console.warn("[bg] snapshot detect failed:", e);
    }
    return out;
  }

  if (name === "click") {
    const loc = buildLocator(p, args);
    const urlBefore = p.url();
    try { await loc.click({ timeout: ACT_TIMEOUT }); }
    catch (e) {
      return { ok: false, locator: describeLocator(args),
        error: `click failed: ${String(e?.message || e).split("\n")[0]}` };
    }
    try { await p.waitForLoadState("domcontentloaded", { timeout: 2000 }); } catch (_) {}
    return { ok: true, locator: describeLocator(args), url: p.url(), url_changed: p.url() !== urlBefore };
  }

  if (name === "double_click") {
    const loc = buildLocator(p, args);
    try { await loc.dblclick({ timeout: ACT_TIMEOUT }); }
    catch (e) { return { ok: false, locator: describeLocator(args), error: String(e?.message || e).split("\n")[0] }; }
    return { ok: true, locator: describeLocator(args) };
  }

  if (name === "hover") {
    const loc = buildLocator(p, args);
    try { await loc.hover({ timeout: ACT_TIMEOUT }); }
    catch (e) { return { ok: false, locator: describeLocator(args), error: String(e?.message || e).split("\n")[0] }; }
    return { ok: true, locator: describeLocator(args) };
  }

  if (name === "type") {
    const loc = buildLocator(p, args);
    const text = args.text || "";
    let actualLen = -1;
    try {
      await loc.click({ timeout: ACT_TIMEOUT });
      await loc.fill("", { timeout: ACT_TIMEOUT });
      if (text) {
        for (const char of text) {
          await p.keyboard.type(char);
          await new Promise((r) => setTimeout(r, 40 + Math.random() * 50));
        }
      }
      if (args.submit) await loc.press("Enter");
      try {
        const v = await loc.inputValue({ timeout: 1500 });
        actualLen = v == null ? -1 : v.length;
      } catch (_) { /* not an input */ }
    } catch (e) {
      return { ok: false, locator: describeLocator(args),
        error: `type failed: ${String(e?.message || e).split("\n")[0]}` };
    }
    const matched = actualLen === text.length;
    return {
      ok: matched,
      locator: describeLocator(args),
      expected_chars: text.length,
      actual_chars: actualLen,
      submitted: !!args.submit,
      error: matched ? undefined :
        `value mismatch after type: expected ${text.length} chars, field has ${actualLen}. ` +
        `Locator (${describeLocator(args)}) may have hit the wrong element.`,
    };
  }

  if (name === "key") {
    await p.keyboard.press(args.key);
    return { ok: true, key: args.key };
  }

  if (name === "key_combo") {
    // e.g. "Control+a", "Shift+Tab". Playwright accepts these directly.
    if (!args.combo) return { ok: false, error: "key_combo requires `combo`" };
    try { await p.keyboard.press(args.combo); }
    catch (e) { return { ok: false, error: String(e?.message || e).split("\n")[0] }; }
    return { ok: true, combo: args.combo };
  }

  if (name === "scroll") {
    await p.evaluate((dy) => window.scrollBy(0, dy), args.deltaY || 0);
    return { ok: true, deltaY: args.deltaY };
  }

  if (name === "back") {
    try { await p.goBack({ timeout: NAV_TIMEOUT }); }
    catch (e) { return { ok: false, error: String(e?.message || e).split("\n")[0] }; }
    return { ok: true, url: p.url() };
  }

  if (name === "forward") {
    try { await p.goForward({ timeout: NAV_TIMEOUT }); }
    catch (e) { return { ok: false, error: String(e?.message || e).split("\n")[0] }; }
    return { ok: true, url: p.url() };
  }

  if (name === "fill_cells") {
    // Canvas-app keyboard fill (Sheets-style): type-Tab-type-Tab... or
    // type-Enter-type-Enter, depending on `direction`. Caller is responsible
    // for clicking into the starting cell first (or providing a locator for it).
    const values = args.values || [];
    const direction = args.direction || "right"; // right (Tab) | down (Enter)
    const sep = direction === "down" ? "Enter" : "Tab";
    if (args.start_locator) {
      try {
        const startLoc = buildLocator(p, args.start_locator);
        await startLoc.click({ timeout: ACT_TIMEOUT });
      } catch (e) {
        return { ok: false, error: `fill_cells: start_locator click failed: ${e?.message || e}` };
      }
    }
    for (let i = 0; i < values.length; i++) {
      for (const ch of String(values[i])) {
        await p.keyboard.type(ch);
        await new Promise((r) => setTimeout(r, 30 + Math.random() * 30));
      }
      if (i < values.length - 1) await p.keyboard.press(sep);
    }
    return { ok: true, count: values.length, direction };
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
      const state = args.state || "visible";
      const loc = buildLocator(p, args);
      await loc.waitFor({ state, timeout });
      return { ok: true, mode: "locator_state", state, locator: describeLocator(args) };
    } catch (e) {
      return { ok: false, error: `wait_for timed out: ${String(e?.message || e).split("\n")[0]}` };
    }
  }

  // ── Scrape dispatcher ────────────────────────────────────────
  if (name === "scrape") {
    const kind = args.kind;
    try {
      if (kind === "links") {
        const json = await p.evaluate(SCRAPE_LINKS_SCRIPT);
        return { ok: true, ...JSON.parse(json) };
      }
      if (kind === "metadata") {
        const json = await p.evaluate(SCRAPE_METADATA_SCRIPT);
        return { ok: true, metadata: JSON.parse(json) };
      }
      if (kind === "page_html") {
        const html = await p.evaluate(SCRAPE_PAGE_HTML_SCRIPT);
        return { ok: true, html, length: (html || "").length };
      }
      if (kind === "table") {
        const json = await p.evaluate(SCRAPE_TABLE_FN(args.selector || ""));
        return { ok: true, ...JSON.parse(json) };
      }
      if (kind === "network") {
        // Materialize captured response bodies (Playwright lets us read the
        // body off the Response handle even after navigation — for a while).
        const out = [];
        const max = args.max || 20;
        let totalSize = 0;
        const MAX_TOTAL = 10000;
        for (const cap of networkCaptures.slice(-max)) {
          if (totalSize > MAX_TOTAL) break;
          let body = "";
          try { body = await cap._resp.text(); } catch (_) { body = "(body unavailable)"; }
          if (body.length > 3000) body = body.substring(0, 3000) + "... [truncated]";
          out.push({ url: cap.url, status: cap.status, mime: cap.mime, body });
          totalSize += body.length;
        }
        return { ok: true, requests: out, count: out.length, total_captured: networkCaptures.length };
      }
      return { ok: false, error: `unknown scrape kind: ${kind}` };
    } catch (e) {
      return { ok: false, error: `scrape ${kind} failed: ${String(e?.message || e).split("\n")[0]}` };
    }
  }

  // ── Popup dispatcher (dismiss + click_captcha + open_nav) ────
  if (name === "popup") {
    const action = args.action;
    if (action === "dismiss") {
      try {
        const json = await p.evaluate(DISMISS_POPUP_SCRIPT);
        return JSON.parse(json);
      } catch (e) { return { ok: false, error: String(e?.message || e).split("\n")[0] }; }
    }
    if (action === "open_nav") {
      // Re-run detection (page may have changed since last observe) and click
      // the hamburger via its own selector (preferred) or coordinates.
      try {
        const detectJson = await p.evaluate(SNAPSHOT_DETECT_SCRIPT);
        const detect = JSON.parse(detectJson);
        const h = detect.nav_hamburger;
        if (!h) return { ok: false, error: "no nav_hamburger detected on page" };
        if (h.selector) {
          try {
            const loc = p.locator(h.selector).first();
            await loc.click({ timeout: ACT_TIMEOUT });
            return { ok: true, strategy: "selector", selector: h.selector };
          } catch (_) { /* fall through to coords */ }
        }
        // Coords fallback — works even when selector is null (visual heuristic match)
        await p.mouse.click(h.clickTarget.x, h.clickTarget.y);
        return { ok: true, strategy: "coords", coords: h.clickTarget, reason: h.reason };
      } catch (e) { return { ok: false, error: String(e?.message || e).split("\n")[0] }; }
    }
    if (action === "click_captcha") {
      // Find checkbox-captcha coordinates, then synthesize a human-like
      // mouse move + click via Playwright's mouse API.
      try {
        const infoJson = await p.evaluate(FIND_CAPTCHA_TARGET_SCRIPT);
        const info = JSON.parse(infoJson);
        if (info.type === "not_found") {
          return { ok: false, error: "no checkbox captcha found (Turnstile/reCAPTCHA/hCaptcha)" };
        }
        const jitterX = Math.round((Math.random() - 0.5) * 6);
        const jitterY = Math.round((Math.random() - 0.5) * 6);
        const x = info.x + jitterX, y = info.y + jitterY;
        // Curved approach: 5-10 micro-moves
        const steps = 5 + Math.round(Math.random() * 5);
        const startX = x + Math.round((Math.random() - 0.5) * 100);
        const startY = y + Math.round((Math.random() - 0.5) * 100);
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          await p.mouse.move(startX + (x - startX) * t, startY + (y - startY) * t);
          await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
        }
        await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
        await p.mouse.click(x, y);
        return { ok: true, type: info.type, clicked_at: { x, y } };
      } catch (e) { return { ok: false, error: String(e?.message || e).split("\n")[0] }; }
    }
    return { ok: false, error: `popup action must be 'dismiss' | 'open_nav' | 'click_captcha', got ${action}` };
  }

  // ── Dialog dispatcher (manual control over native JS dialogs) ──
  if (name === "dialog") {
    // The auto-handler already handles dialogs as they fire. This is for
    // the rare case where the agent wants to set up a one-shot listener
    // BEFORE triggering an action that will fire a dialog.
    const action = args.action;
    return new Promise((resolve) => {
      const handler = async (d) => {
        try {
          if (action === "accept") await d.accept(args.text || undefined);
          else if (action === "dismiss") await d.dismiss();
          resolve({ ok: true, type: d.type(), message: d.message() });
        } catch (e) {
          resolve({ ok: false, error: String(e?.message || e) });
        }
      };
      p.once("dialog", handler);
      // Auto-resolve if no dialog fires within 5s.
      setTimeout(() => {
        try { p.removeListener("dialog", handler); } catch (_) {}
        resolve({ ok: false, error: "no dialog appeared within 5s" });
      }, 5000);
    });
  }

  // ── Cookies dispatcher (extract / inject) ─────────────────────
  if (name === "cookies") {
    const action = args.action;
    if (action === "extract") {
      const url = args.url || p.url();
      const cookies = await chrome.cookies.getAll({ url });
      return {
        ok: true, count: cookies.length,
        cookies: cookies.map((c) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: c.secure, httpOnly: c.httpOnly,
          sameSite: c.sameSite || "unspecified",
          expirationDate: c.expirationDate,
        })),
      };
    }
    if (action === "inject") {
      const cookies = args.cookies || [];
      let injected = 0;
      const errors = [];
      for (const c of cookies) {
        try {
          const dom = c.domain || "";
          const cleanDomain = dom.startsWith(".") ? dom.slice(1) : dom;
          const url = c.url || `${c.secure ? "https" : "http"}://${cleanDomain}${c.path || "/"}`;
          await chrome.cookies.set({
            url, name: c.name, value: c.value,
            domain: c.domain, path: c.path || "/",
            secure: !!c.secure, httpOnly: !!c.httpOnly,
            sameSite: c.sameSite || "unspecified",
            expirationDate: c.expirationDate,
          });
          injected++;
        } catch (e) { errors.push({ cookie: c.name, error: String(e?.message || e) }); }
      }
      return { ok: errors.length === 0, injected, errors };
    }
    return { ok: false, error: `cookies action must be 'extract' or 'inject', got ${action}` };
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
      .then((r) => sendResponse(r))
      .catch((e) => {
        console.error("[bg] tool failed:", msg.tool?.name, e);
        sendResponse({ ok: false, error: String(e?.message || e) });
      });
    return true;
  }
  if (msg?.type === "ping") {
    sendResponse({
      ok: true,
      attached_tab: attachedTabId,
      original_tab: originalTabId,
      group_id: agentGroupId,
      stealth: stealthApplied,
      network_captures: networkCaptures.length,
    });
    return false;
  }
  return false;
});

// ── Side-panel auto-open + install ─────────────────────────────
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
