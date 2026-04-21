// Page-side scripts that get evaluated in the target page via
// page.evaluate(...). Each script returns a JSON string so we can move
// data across the playwright-crx boundary cleanly.
//
// Ported from origin/main's actions.js with light adaptation:
//   - SNAPSHOT_DETECT_SCRIPT: popup/captcha/canvas/scroll detection
//     (the agent's "page intelligence" payload, augmenting ariaSnapshot)
//   - SCRAPE_LINKS_SCRIPT
//   - SCRAPE_METADATA_SCRIPT
//   - SCRAPE_TABLE_HTML_SCRIPT
//   - SCRAPE_PAGE_HTML_SCRIPT
//   - DISMISS_POPUP_SCRIPT
//   - FIND_CAPTCHA_TARGET_SCRIPT (for click_captcha)

// ── Popup / captcha / canvas / scroll detection ─────────────
// Returns a JSON object with {popup, captcha, isCanvasHeavy, pageScroll,
// scrollContainers, viewport, pageLoading}. The agent reads this AFTER
// observe()'s ariaSnapshot to decide if it needs to handle a popup/captcha
// before doing anything else.

export const SNAPSHOT_DETECT_SCRIPT = `
(() => {
  // Detect popups, modals, overlays, cookie banners
  let popup = null;
  const popupSelectors = [
    '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
    '.modal', '.popup', '.overlay', '.dialog',
    '[class*="modal"]', '[class*="popup"]', '[class*="overlay"]',
    '[class*="cookie"]', '[class*="consent"]', '[class*="banner"]',
    '[id*="modal"]', '[id*="popup"]', '[id*="overlay"]',
    '[id*="cookie"]', '[id*="consent"]'
  ];
  for (const sel of popupSelectors) {
    const matches = document.querySelectorAll(sel);
    for (const el of matches) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue;
      let closeBtn = null;
      const closeCandidates = el.querySelectorAll(
        'button[aria-label*="close" i], button[aria-label*="dismiss" i], ' +
        'button[class*="close" i], button[class*="dismiss" i], ' +
        '[role="button"][aria-label*="close" i], ' +
        '.close, .dismiss, [data-dismiss], [aria-label="Close"]'
      );
      if (closeCandidates.length === 0) {
        el.querySelectorAll('button, [role="button"], [onclick]').forEach(btn => {
          const txt = (btn.innerText || '').trim();
          if (txt === 'X' || txt === 'x' || txt === '\\u00D7' || txt === '\\u2715' || txt === '\\u2716') {
            closeBtn = btn;
          }
        });
      } else {
        closeBtn = closeCandidates[0];
      }
      let closeBtnRect = null;
      if (closeBtn) {
        const cr = closeBtn.getBoundingClientRect();
        closeBtnRect = {
          x: Math.round(cr.x), y: Math.round(cr.y),
          width: Math.round(cr.width), height: Math.round(cr.height),
          centerX: Math.round(cr.x + cr.width / 2),
          centerY: Math.round(cr.y + cr.height / 2),
        };
      }
      popup = {
        type: el.getAttribute('role') || 'popup',
        rect: { x: Math.round(r.x), y: Math.round(r.y),
                width: Math.round(r.width), height: Math.round(r.height) },
        closeButton: closeBtnRect,
      };
      break;
    }
    if (popup) break;
  }

  // Detect CAPTCHAs
  let captcha = null;
  // Cloudflare Turnstile iframe
  const tFrames = document.querySelectorAll(
    'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile iframe'
  );
  for (const f of tFrames) {
    const r = f.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) {
      captcha = {
        type: 'Cloudflare Turnstile',
        rect: { x: Math.round(r.x), y: Math.round(r.y),
                width: Math.round(r.width), height: Math.round(r.height) },
        clickTarget: { x: Math.round(r.x + 30), y: Math.round(r.y + r.height / 2) },
      };
      break;
    }
  }
  if (!captcha) {
    const tDiv = document.querySelector('.cf-turnstile, [data-sitekey][data-appearance]');
    if (tDiv) {
      const r = tDiv.getBoundingClientRect();
      const inner = tDiv.querySelector('iframe');
      const ir = inner ? inner.getBoundingClientRect() : r;
      if (ir.width > 10 && ir.height > 10) {
        captcha = {
          type: inner ? 'Cloudflare Turnstile' : 'Cloudflare Turnstile (loading)',
          rect: { x: Math.round(ir.x), y: Math.round(ir.y),
                  width: Math.round(ir.width), height: Math.round(ir.height) },
          clickTarget: { x: Math.round(ir.x + 30), y: Math.round(ir.y + ir.height / 2) },
        };
      }
    }
  }
  if (!captcha) {
    const rFrame = document.querySelector(
      'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]'
    );
    if (rFrame) {
      const r = rFrame.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) {
        captcha = {
          type: 'reCAPTCHA v2',
          rect: { x: Math.round(r.x), y: Math.round(r.y),
                  width: Math.round(r.width), height: Math.round(r.height) },
          clickTarget: { x: Math.round(r.x + 28), y: Math.round(r.y + r.height / 2) },
        };
      }
    }
  }
  if (!captcha) {
    const hFrame = document.querySelector('iframe[src*="hcaptcha.com/captcha"]');
    if (hFrame) {
      const r = hFrame.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) {
        captcha = {
          type: 'hCaptcha',
          rect: { x: Math.round(r.x), y: Math.round(r.y),
                  width: Math.round(r.width), height: Math.round(r.height) },
          clickTarget: { x: Math.round(r.x + 28), y: Math.round(r.y + r.height / 2) },
        };
      }
    }
  }
  if (!captcha) {
    for (const sel of ['[class*="captcha" i]', '[id*="captcha" i]', '[data-sitekey]', '#captcha']) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 10 && r.height > 10) {
          captcha = {
            type: 'CAPTCHA (image/text)',
            rect: { x: Math.round(r.x), y: Math.round(r.y),
                    width: Math.round(r.width), height: Math.round(r.height) },
          };
          break;
        }
      }
    }
  }

  // Detect navigation hamburger (sites like IRCTC use a hamburger at ALL
  // viewport widths — not just narrow). The agent needs to click this BEFORE
  // looking for LOGIN/REGISTER/Account etc., because those items live behind
  // the hamburger. Heuristics in priority order:
  //   1. Bootstrap class .navbar-toggler (used by ~30% of websites)
  //   2. aria-label containing menu/navigation/hamburger
  //   3. Class name containing hamburger/menu-toggle/nav-toggle
  //   4. Icon-sized button in the top header bar with no visible text
  //      and 3 horizontal lines (the classic "≡" pattern)
  let nav_hamburger = null;
  const hamburgerSelectors = [
    'button.navbar-toggler',
    '[aria-label*="menu" i][role="button"]',
    '[aria-label*="navigation" i][role="button"]',
    '[aria-label*="hamburger" i]',
    'button[aria-label*="menu" i]',
    'button[aria-label*="navigation" i]',
    '.hamburger',
    '.hamburger-menu',
    '.hamburger_menu',
    '.menu-toggle',
    '.nav-toggle',
    '[class*="hamburger" i]',
    '[class*="menu-toggle" i]',
    '[class*="navbar-toggler" i]',
  ];
  for (const sel of hamburgerSelectors) {
    const matches = document.querySelectorAll(sel);
    for (const el of matches) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      // Must be in the top region of the viewport (header bar, < 120px from top)
      if (r.top > 120 || r.bottom < 0) continue;
      // Must be icon-sized (not the entire nav bar)
      if (r.width < 20 || r.width > 80 || r.height < 20 || r.height > 80) continue;
      nav_hamburger = {
        selector: sel,
        rect: { x: Math.round(r.x), y: Math.round(r.y),
                width: Math.round(r.width), height: Math.round(r.height) },
        clickTarget: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
        reason: 'matched_selector',
      };
      break;
    }
    if (nav_hamburger) break;
  }
  // Fallback: visual heuristic — small button in top bar with 3 stacked lines
  if (!nav_hamburger) {
    const allBtns = document.querySelectorAll('button, [role="button"], a[href]');
    for (const el of allBtns) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
      const r = el.getBoundingClientRect();
      if (r.top > 120 || r.bottom < 0) continue;
      if (r.width < 20 || r.width > 80 || r.height < 20 || r.height > 80) continue;
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt.length > 2) continue; // hamburger has no text (or just an icon char)
      // Check for 3 child lines/spans/divs
      const children = el.querySelectorAll('span, div, line, path, rect');
      let lineCount = 0;
      for (const c of children) {
        const cr = c.getBoundingClientRect();
        if (cr.height < 6 && cr.width > 10) lineCount++;
      }
      if (lineCount >= 3) {
        nav_hamburger = {
          selector: null, // no specific selector — agent should use coords or aria
          rect: { x: Math.round(r.x), y: Math.round(r.y),
                  width: Math.round(r.width), height: Math.round(r.height) },
          clickTarget: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) },
          reason: 'visual_3_lines',
        };
        break;
      }
    }
  }

  // Canvas-heavy detection (for canvas-app heuristic — Sheets/Docs use canvas)
  let canvasArea = 0;
  document.querySelectorAll('canvas').forEach(c => {
    const r = c.getBoundingClientRect();
    canvasArea += r.width * r.height;
  });
  const viewportArea = window.innerWidth * window.innerHeight;
  const isCanvasHeavy = canvasArea > viewportArea * 0.5;

  // Scroll containers
  const scrollContainers = [];
  const allEls = document.querySelectorAll('*');
  for (let i = 0; i < allEls.length && scrollContainers.length < 10; i++) {
    const el = allEls[i];
    const s = getComputedStyle(el);
    const oy = s.overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
        el.scrollHeight > el.clientHeight + 20) {
      const r = el.getBoundingClientRect();
      if (r.width < 50 || r.height < 50) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      scrollContainers.push({
        label: el.getAttribute('aria-label') || el.getAttribute('role') || id || cls || el.tagName.toLowerCase(),
        scrollTop: Math.round(el.scrollTop),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        canScrollDown: el.scrollTop + el.clientHeight < el.scrollHeight - 5,
        canScrollUp: el.scrollTop > 5,
      });
    }
  }

  // Page scroll
  const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  const viewHeight = window.innerHeight;
  const scrollTop = window.scrollY || document.documentElement.scrollTop;
  const scrollPct = docHeight > viewHeight ? Math.round(scrollTop / (docHeight - viewHeight) * 100) : 0;

  return JSON.stringify({
    popup, captcha, nav_hamburger, isCanvasHeavy,
    scrollContainers,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    pageLoading: document.readyState !== 'complete',
    pageScroll: {
      scrollTop: Math.round(scrollTop), scrollPct,
      docHeight: Math.round(docHeight),
      canScrollDown: scrollTop + viewHeight < docHeight - 10,
      canScrollUp: scrollTop > 10,
    },
  });
})()
`;

// ── Scrape: links ────────────────────────────────────────────
export const SCRAPE_LINKS_SCRIPT = `
(() => {
  const seen = new Set();
  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.href;
    if (!href || href.startsWith('javascript:') || href === '#' || seen.has(href)) continue;
    seen.add(href);
    const text = (a.innerText || a.textContent || '').trim().substring(0, 100);
    if (!text) continue;
    const parent = a.closest('p, li, td, div, span');
    const context = parent ? (parent.innerText || '').trim().substring(0, 150) : '';
    links.push({ text, href, context });
    if (links.length >= 200) break;
  }
  return JSON.stringify({
    links, count: links.length,
    truncated: document.querySelectorAll('a[href]').length > 200,
  });
})()
`;

// ── Scrape: metadata (title, OG tags, canonical, language, etc.) ─
export const SCRAPE_METADATA_SCRIPT = `
(() => {
  const meta = {};
  const get = (sel, attr = 'content') => {
    const el = document.querySelector(sel);
    return el ? (el.getAttribute(attr) || '').trim() : '';
  };
  meta.title = document.title || '';
  meta.description = get('meta[name="description"]');
  meta.author = get('meta[name="author"]');
  meta.robots = get('meta[name="robots"]');
  meta.og_title = get('meta[property="og:title"]');
  meta.og_description = get('meta[property="og:description"]');
  meta.og_image = get('meta[property="og:image"]');
  meta.og_url = get('meta[property="og:url"]');
  meta.og_type = get('meta[property="og:type"]');
  meta.og_site_name = get('meta[property="og:site_name"]');
  meta.published_time = get('meta[property="article:published_time"]')
    || get('meta[name="date"]') || get('time[datetime]', 'datetime');
  meta.modified_time = get('meta[property="article:modified_time"]');
  meta.canonical = get('link[rel="canonical"]', 'href');
  meta.language = document.documentElement.lang || get('meta[http-equiv="content-language"]');
  meta.favicon = get('link[rel="icon"]', 'href') || get('link[rel="shortcut icon"]', 'href');
  if (!meta.title) {
    meta.title = meta.og_title || get('meta[name="twitter:title"]') || get('meta[name="title"]') || '';
  }
  for (const k of Object.keys(meta)) { if (!meta[k]) delete meta[k]; }
  return JSON.stringify(meta);
})()
`;

// ── Scrape: page HTML (returned as string; agent or backend turns to MD) ──
export const SCRAPE_PAGE_HTML_SCRIPT = `document.documentElement.outerHTML`;

// ── Scrape: extract a table to JSON rows ─────────────────────
// Selector argument is interpolated by the caller via JSON.stringify.
export const SCRAPE_TABLE_FN = (selector) => `
(() => {
  let t;
  if (${JSON.stringify(selector || "")}) {
    t = document.querySelector(${JSON.stringify(selector)});
    if (!t) return JSON.stringify({ error: "no table at selector" });
    if (t.tagName !== 'TABLE') t = t.closest('table') || t.querySelector('table');
  } else {
    t = document.querySelector('table');
  }
  if (!t) return JSON.stringify({ error: "no table found on page" });

  const headers = [];
  const headerRow = t.querySelector('thead tr') || t.querySelector('tr');
  if (headerRow) {
    headerRow.querySelectorAll('th, td').forEach(c => {
      headers.push((c.innerText || c.textContent || '').trim());
    });
  }
  const rows = [];
  const trs = t.querySelectorAll('tbody tr');
  const list = trs.length > 0 ? trs : Array.from(t.querySelectorAll('tr')).slice(headerRow ? 1 : 0);
  for (const tr of list) {
    const cells = [];
    tr.querySelectorAll('td, th').forEach(c => {
      cells.push((c.innerText || c.textContent || '').trim());
    });
    if (cells.length === 0) continue;
    if (headers.length > 0 && cells.length === headers.length) {
      const obj = {};
      headers.forEach((h, i) => { obj[h || ('col' + i)] = cells[i]; });
      rows.push(obj);
    } else {
      rows.push(cells);
    }
  }
  return JSON.stringify({ headers, rows, row_count: rows.length });
})()
`;

// ── Dismiss popup (try multiple strategies) ──────────────────
export const DISMISS_POPUP_SCRIPT = `
(() => {
  // Strategy 1: Click close/dismiss buttons
  const closeSelectors = [
    'button[aria-label*="close" i]', 'button[aria-label*="dismiss" i]',
    'button[class*="close" i]', 'button[class*="dismiss" i]',
    '.close', '.dismiss', '[data-dismiss]', '[aria-label="Close"]',
    'button[title*="close" i]', 'button[title*="dismiss" i]',
    '.modal-close', '.popup-close', '.dialog-close',
    '[role="dialog"] button[class*="close" i]',
  ];
  for (const sel of closeSelectors) {
    const btns = document.querySelectorAll(sel);
    for (const btn of btns) {
      const s = getComputedStyle(btn);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const r = btn.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) continue;
      btn.click();
      return JSON.stringify({ ok: true, strategy: 'close_button', selector: sel });
    }
  }
  // Strategy 2: Find X-shaped buttons by text
  const allBtns = document.querySelectorAll('button, [role="button"], [onclick]');
  for (const btn of allBtns) {
    const txt = (btn.innerText || btn.textContent || '').trim();
    if (txt === 'X' || txt === 'x' || txt === '\\u00D7' || txt === '\\u2715' || txt === '\\u2716') {
      const r = btn.getBoundingClientRect();
      if (r.width > 5 && r.height > 5) {
        btn.click();
        return JSON.stringify({ ok: true, strategy: 'x_button' });
      }
    }
  }
  // Strategy 3: Press Escape (last resort, dispatched in JS)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
  return JSON.stringify({ ok: false, strategy: 'escape', note: 'no close button found; pressed Escape as fallback' });
})()
`;

// ── Find captcha checkbox click target (for click_captcha) ───
export const FIND_CAPTCHA_TARGET_SCRIPT = `
(() => {
  let frame = document.querySelector(
    'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile iframe'
  );
  if (frame) {
    const r = frame.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) {
      return JSON.stringify({ type: 'turnstile',
        x: Math.round(r.x + 30), y: Math.round(r.y + r.height / 2) });
    }
  }
  frame = document.querySelector('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]');
  if (frame) {
    const r = frame.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) {
      return JSON.stringify({ type: 'recaptcha',
        x: Math.round(r.x + 28), y: Math.round(r.y + r.height / 2) });
    }
  }
  frame = document.querySelector('iframe[src*="hcaptcha.com"]');
  if (frame) {
    const r = frame.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) {
      return JSON.stringify({ type: 'hcaptcha',
        x: Math.round(r.x + 28), y: Math.round(r.y + r.height / 2) });
    }
  }
  return JSON.stringify({ type: 'not_found' });
})()
`;
