/**
 * CDP Action Executor + Element Extraction
 * Uses chrome.debugger API for reliable browser automation.
 * Hybrid mode: accessibility-tree refs (reliable) + vision coordinates (fallback).
 */

let attachedTabId = null;
let elementMap = {};

// ── Debugger Management ─────────────────────────────────────

async function attachDebugger(tabId) {
  if (attachedTabId === tabId) return;
  if (attachedTabId !== null) await detachDebugger();
  await chrome.debugger.attach({ tabId }, "1.3");
  attachedTabId = tabId;

  // Apply stealth patches to avoid anti-bot detection
  await applyStealthPatches();
}

/**
 * Inject stealth patches to mask CDP/debugger fingerprints.
 * Runs before any page scripts via Page.addScriptToEvaluateOnNewDocument.
 */
async function applyStealthPatches() {
  try {
    await sendCommand("Page.enable");

    // Inject stealth JS that runs before any page script on every navigation
    await sendCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        // 1. Hide navigator.webdriver — must delete from prototype, not just override
        // The "new" detection uses Object.getOwnPropertyDescriptor on Navigator.prototype
        try {
          // Delete the property from the prototype chain entirely
          const proto = Navigator.prototype;
          if ('webdriver' in proto) {
            delete proto.webdriver;
          }
          // Also delete from the instance
          if ('webdriver' in navigator) {
            Object.defineProperty(navigator, 'webdriver', {
              get: () => false,
              configurable: true,
              enumerable: true,
            });
          }
          // Patch the prototype descriptor to look native
          Object.defineProperty(proto, 'webdriver', {
            get: () => false,
            configurable: true,
            enumerable: true,
          });
          // Make the getter look native (toString check)
          const webdriverDesc = Object.getOwnPropertyDescriptor(proto, 'webdriver');
          if (webdriverDesc && webdriverDesc.get) {
            webdriverDesc.get.toString = () => 'function get webdriver() { [native code] }';
          }
        } catch(e) {}

        // 2. Fix PluginArray instanceof check
        // Chrome 91+ deprecated plugins but still returns a PluginArray-like object.
        // The prototype chain may be broken, causing instanceof to fail.
        try {
          if (typeof PluginArray !== 'undefined') {
            // Approach 1: Fix the prototype chain directly
            const realPlugins = navigator.plugins;
            if (realPlugins && !(realPlugins instanceof PluginArray)) {
              try {
                Object.setPrototypeOf(realPlugins, PluginArray.prototype);
              } catch(e) {
                // If setPrototypeOf fails (frozen object), patch Symbol.hasInstance
                Object.defineProperty(PluginArray, Symbol.hasInstance, {
                  value: (instance) => {
                    if (instance === navigator.plugins) return true;
                    try { return Object.getPrototypeOf(instance) === PluginArray.prototype; }
                    catch(e) { return false; }
                  },
                  configurable: true,
                });
              }
            }
          }
        } catch(e) {}

        // 3. Fake languages
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
          configurable: true,
        });

        // 4. Override permissions query to report "prompt" for notifications
        const originalQuery = window.Notification && Notification.permission;
        if (window.Notification) {
          Notification.permission = 'default';
        }

        // 5. Fix chrome.runtime to not leak extension context
        // (some anti-bot checks for chrome.runtime.id)
        try {
          if (window.chrome && window.chrome.runtime && window.chrome.runtime.id) {
            // Already in extension context, leave it
          }
        } catch(e) {}

        // 6. Prevent detection via Error stack traces containing "debugger"
        const originalError = Error;
        const patchedError = function(...args) {
          const err = new originalError(...args);
          const originalStack = err.stack;
          if (originalStack) {
            err.stack = originalStack
              .split('\\n')
              .filter(line => !line.includes('debugger'))
              .join('\\n');
          }
          return err;
        };
        patchedError.prototype = originalError.prototype;
        // Don't override globally as it breaks some sites

        // 7. Add missing window.chrome properties that headless lacks
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.app) {
          window.chrome.app = {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          };
        }

        // 8. Fix WebGL vendor/renderer (headless has "Google Inc. (Google)" which is suspicious)
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(param) {
          // UNMASKED_VENDOR_WEBGL
          if (param === 37445) return 'Intel Inc.';
          // UNMASKED_RENDERER_WEBGL
          if (param === 37446) return 'Intel Iris OpenGL Engine';
          return getParameter.call(this, param);
        };

        // 9. Spoof WebGL2 as well
        if (typeof WebGL2RenderingContext !== 'undefined') {
          const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
          WebGL2RenderingContext.prototype.getParameter = function(param) {
            if (param === 37445) return 'Intel Inc.';
            if (param === 37446) return 'Intel Iris OpenGL Engine';
            return getParameter2.call(this, param);
          };
        }

        // 10. Fix Permissions API to not leak automation
        const originalPermissionsQuery = navigator.permissions?.query;
        if (originalPermissionsQuery) {
          navigator.permissions.query = function(params) {
            if (params.name === 'notifications') {
              return Promise.resolve({ state: Notification.permission || 'prompt' });
            }
            return originalPermissionsQuery.call(this, params);
          };
        }
      `,
    });

    // Also patch the current page immediately
    await sendCommand("Runtime.evaluate", {
      expression: `
        try {
          const proto = Navigator.prototype;
          Object.defineProperty(proto, 'webdriver', {
            get: () => false, configurable: true, enumerable: true,
          });
        } catch(e) {}
      `,
    });

  } catch (e) {
    console.warn("Stealth patches failed (non-critical):", e);
  }
}

async function detachDebugger() {
  if (attachedTabId === null) return;
  try {
    await chrome.debugger.detach({ tabId: attachedTabId });
  } catch (_) {}
  attachedTabId = null;
}

function sendCommand(method, params = {}) {
  return chrome.debugger.sendCommand({ tabId: attachedTabId }, method, params);
}

// ── Element Extraction ──────────────────────────────────────

const EXTRACT_ELEMENTS_SCRIPT = `
(() => {
  const SELECTORS = [
    'a[href]', 'button', 'input', 'select', 'textarea',
    '[role="button"]', '[role="link"]', '[role="tab"]',
    '[role="menuitem"]', '[role="checkbox"]', '[role="radio"]',
    '[role="switch"]', '[role="option"]', '[role="combobox"]',
    '[role="searchbox"]', '[role="textbox"]', '[role="listbox"]',
    '[role="menu"]', '[role="dialog"]',
    '[onclick]', '[tabindex]:not([tabindex="-1"])',
    'summary', 'details', 'label[for]',
    'th[aria-sort]', '[contenteditable="true"]',
    '[data-action]', '[data-click]'
  ];

  const seen = new Set();
  const elements = [];

  document.querySelectorAll(SELECTORS.join(',')).forEach(el => {
    if (seen.has(el)) return;
    seen.add(el);

    const rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    if (rect.right < 0 || rect.left > window.innerWidth) return;

    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || tag;
    const ariaLabel = el.getAttribute('aria-label') || '';
    const placeholder = el.getAttribute('placeholder') || '';
    const text = (el.innerText || '').trim().substring(0, 80);
    const type = el.getAttribute('type') || '';
    const href = el.getAttribute('href') || '';
    const value = (el.value || '').substring(0, 50);
    const checked = el.checked;
    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';

    let desc = ariaLabel || text || placeholder || (type ? type + ' input' : tag);

    elements.push({
      tag, role, desc, type,
      href: href.substring(0, 120),
      value,
      checked: checked || undefined,
      disabled: disabled || undefined,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }
    });
  });

  // Detect scrollable containers
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

      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const role = el.getAttribute('role') || '';
      let label = ariaLabel || role || id || cls || tag;

      scrollContainers.push({
        label,
        scrollTop: Math.round(el.scrollTop),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        canScrollDown: el.scrollTop + el.clientHeight < el.scrollHeight - 5,
        canScrollUp: el.scrollTop > 5,
        rect: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        }
      });
    }
  }

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

      // Find close button within the popup
      let closeBtn = null;
      const closeCandidates = el.querySelectorAll(
        'button[aria-label*="close" i], button[aria-label*="dismiss" i], ' +
        'button[class*="close" i], button[class*="dismiss" i], ' +
        '[role="button"][aria-label*="close" i], ' +
        '.close, .dismiss, [data-dismiss], [aria-label="Close"]'
      );

      // Also check for X-like buttons (single character text)
      if (closeCandidates.length === 0) {
        el.querySelectorAll('button, [role="button"], [onclick]').forEach(btn => {
          const txt = (btn.innerText || '').trim();
          if (txt === 'X' || txt === 'x' || txt === '\u00D7' || txt === '\u2715' || txt === '\u2716') {
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
          x: Math.round(cr.x),
          y: Math.round(cr.y),
          width: Math.round(cr.width),
          height: Math.round(cr.height),
          centerX: Math.round(cr.x + cr.width / 2),
          centerY: Math.round(cr.y + cr.height / 2),
        };
      }

      popup = {
        type: el.getAttribute('role') || 'popup',
        rect: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
        closeButton: closeBtnRect,
      };
      break;
    }
    if (popup) break;
  }

  // Detect CAPTCHAs, Turnstile, reCAPTCHA — with live click coordinates
  let captcha = null;

  // 1. Cloudflare Turnstile — iframe from challenges.cloudflare.com
  const turnstileFrames = document.querySelectorAll(
    'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile iframe'
  );
  for (const frame of turnstileFrames) {
    const r = frame.getBoundingClientRect();
    if (r.width > 10 && r.height > 10) {
      // The checkbox is typically ~30px from left edge, vertically centered
      captcha = {
        type: 'Cloudflare Turnstile',
        rect: { x: Math.round(r.x), y: Math.round(r.y),
                width: Math.round(r.width), height: Math.round(r.height) },
        clickTarget: {
          x: Math.round(r.x + 30),
          y: Math.round(r.y + r.height / 2),
          note: 'Checkbox is ~30px from left, vertically centered in iframe'
        }
      };
      break;
    }
  }

  // 2. Cloudflare Turnstile container (when iframe not yet loaded)
  if (!captcha) {
    const turnstileDiv = document.querySelector('.cf-turnstile, [data-sitekey][data-appearance]');
    if (turnstileDiv) {
      const r = turnstileDiv.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) {
        // Find the iframe inside
        const innerFrame = turnstileDiv.querySelector('iframe');
        if (innerFrame) {
          const ir = innerFrame.getBoundingClientRect();
          captcha = {
            type: 'Cloudflare Turnstile',
            rect: { x: Math.round(ir.x), y: Math.round(ir.y),
                    width: Math.round(ir.width), height: Math.round(ir.height) },
            clickTarget: {
              x: Math.round(ir.x + 30),
              y: Math.round(ir.y + ir.height / 2),
            }
          };
        } else {
          captcha = {
            type: 'Cloudflare Turnstile (loading)',
            rect: { x: Math.round(r.x), y: Math.round(r.y),
                    width: Math.round(r.width), height: Math.round(r.height) },
            clickTarget: {
              x: Math.round(r.x + 30),
              y: Math.round(r.y + r.height / 2),
            }
          };
        }
      }
    }
  }

  // 3. reCAPTCHA v2 checkbox ("I'm not a robot")
  if (!captcha) {
    const recaptchaFrame = document.querySelector('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]');
    if (recaptchaFrame) {
      const r = recaptchaFrame.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) {
        // The checkbox is ~28px from left, vertically centered
        captcha = {
          type: 'reCAPTCHA v2',
          rect: { x: Math.round(r.x), y: Math.round(r.y),
                  width: Math.round(r.width), height: Math.round(r.height) },
          clickTarget: {
            x: Math.round(r.x + 28),
            y: Math.round(r.y + r.height / 2),
            note: 'Checkbox is ~28px from left in iframe'
          }
        };
      }
    }
  }

  // 4. hCaptcha checkbox
  if (!captcha) {
    const hcaptchaFrame = document.querySelector('iframe[src*="hcaptcha.com/captcha"]');
    if (hcaptchaFrame) {
      const r = hcaptchaFrame.getBoundingClientRect();
      if (r.width > 10 && r.height > 10) {
        captcha = {
          type: 'hCaptcha',
          rect: { x: Math.round(r.x), y: Math.round(r.y),
                  width: Math.round(r.width), height: Math.round(r.height) },
          clickTarget: {
            x: Math.round(r.x + 28),
            y: Math.round(r.y + r.height / 2),
          }
        };
      }
    }
  }

  // 5. Generic CAPTCHA (text-based, image-based)
  if (!captcha) {
    const genericSelectors = [
      '[class*="captcha" i]', '[id*="captcha" i]',
      '[data-sitekey]', '#captcha'
    ];
    for (const sel of genericSelectors) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 10 && r.height > 10) {
          captcha = {
            type: 'CAPTCHA',
            rect: { x: Math.round(r.x), y: Math.round(r.y),
                    width: Math.round(r.width), height: Math.round(r.height) }
          };
          break;
        }
      }
    }
  }

  // Detect iframes with visible content (may contain interactive elements)
  const iframes = [];
  document.querySelectorAll('iframe').forEach(f => {
    const r = f.getBoundingClientRect();
    if (r.width < 50 || r.height < 50) return;
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    const src = f.src || f.getAttribute('src') || '';
    if (src.includes('recaptcha') || src.includes('captcha')) return; // skip CAPTCHA frames
    iframes.push({
      src: src.substring(0, 120),
      rect: { x: Math.round(r.x), y: Math.round(r.y),
              width: Math.round(r.width), height: Math.round(r.height) }
    });
  });

  let canvasArea = 0;
  document.querySelectorAll('canvas').forEach(c => {
    const r = c.getBoundingClientRect();
    canvasArea += r.width * r.height;
  });
  const viewportArea = window.innerWidth * window.innerHeight;
  const isCanvasHeavy = canvasArea > viewportArea * 0.5;

  return JSON.stringify({
    elements,
    scrollContainers,
    popup,
    captcha,
    iframes: iframes.length > 0 ? iframes : undefined,
    isCanvasHeavy,
    viewport: { width: window.innerWidth, height: window.innerHeight }
  });
})()
`;

async function extractElements(tabId) {
  await attachDebugger(tabId);

  const result = await sendCommand("Runtime.evaluate", {
    expression: EXTRACT_ELEMENTS_SCRIPT,
    returnByValue: true,
  });

  const data = JSON.parse(result.result.value);

  elementMap = {};
  data.elements.forEach((el, i) => {
    elementMap[i] = {
      centerX: Math.round(el.rect.x + el.rect.width / 2),
      centerY: Math.round(el.rect.y + el.rect.height / 2),
      rect: el.rect,
    };
  });

  return data;
}

function resolveRef(ref) {
  const el = elementMap[ref];
  if (!el) return null;
  return { x: el.centerX, y: el.centerY };
}

// ── CDP Primitives ──────────────────────────────────────────

async function cdpMoveMouse(x, y) {
  await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}

async function cdpClick(x, y) {
  await cdpMoveMouse(x, y);
  await sleep(50);
  await sendCommand("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1,
  });
  await sendCommand("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1,
  });
}

async function cdpDoubleClick(x, y) {
  await cdpMoveMouse(x, y);
  await sleep(50);
  await sendCommand("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 1,
  });
  await sendCommand("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 1,
  });
  await sleep(50);
  await sendCommand("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button: "left", clickCount: 2,
  });
  await sendCommand("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button: "left", clickCount: 2,
  });
}

async function cdpType(text) {
  for (const char of text) {
    await sendCommand("Input.dispatchKeyEvent", {
      type: "keyDown", text: char, key: char, unmodifiedText: char,
    });
    await sendCommand("Input.dispatchKeyEvent", {
      type: "keyUp", key: char,
    });
    await sleep(30 + Math.random() * 40);
  }
}

async function cdpKey(key) {
  const keyMap = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
    Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
    Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
    End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  };

  const mapped = keyMap[key];
  if (!mapped) {
    console.warn(`Unknown key: ${key}`);
    return;
  }

  await sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...mapped });
  await sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...mapped });
}

async function cdpSelectAll() {
  // Ctrl+A / Cmd+A to select all text
  const modifier = navigator.platform.includes("Mac") ? 2 : 4; // 2=ctrl on mac via CDP, 4=ctrl
  await sendCommand("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: modifier,
  });
  await sendCommand("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: modifier,
  });
}

async function cdpScroll(x, y, deltaX, deltaY) {
  await sendCommand("Input.dispatchMouseEvent", {
    type: "mouseWheel", x, y, deltaX, deltaY,
  });
}

async function cdpNavigate(url) {
  await sendCommand("Page.navigate", { url });
}

async function cdpGoBack() {
  await sendCommand("Page.navigate", {
    url: "javascript:history.back()",
  });
  // Use Runtime.evaluate as fallback
  await sendCommand("Runtime.evaluate", {
    expression: "history.back()",
  });
}

async function cdpGoForward() {
  await sendCommand("Runtime.evaluate", {
    expression: "history.forward()",
  });
}

async function cdpExtractText(ref) {
  const coords = resolveRef(ref);
  if (!coords) return "(element not found)";

  const result = await sendCommand("Runtime.evaluate", {
    expression: `
      (() => {
        const el = document.elementFromPoint(${coords.x}, ${coords.y});
        return el ? el.innerText || el.textContent || '' : '(no element at point)';
      })()
    `,
    returnByValue: true,
  });
  return result.result.value || "(empty)";
}

async function cdpSelectOption(ref, value) {
  // Use Runtime.evaluate to set the select value and dispatch change event
  const coords = resolveRef(ref);
  if (!coords) return;

  await sendCommand("Runtime.evaluate", {
    expression: `
      (() => {
        const el = document.elementFromPoint(${coords.x}, ${coords.y});
        if (el && el.tagName === 'SELECT') {
          el.value = ${JSON.stringify(value)};
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        // Try matching by visible text
        if (el && el.tagName === 'SELECT') {
          for (const opt of el.options) {
            if (opt.text.includes(${JSON.stringify(value)})) {
              el.value = opt.value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
        }
        return false;
      })()
    `,
    returnByValue: true,
  });
}

// ── Action Executor ─────────────────────────────────────────

/**
 * Find and click a CAPTCHA checkbox (Turnstile/reCAPTCHA/hCaptcha) in real-time.
 * Gets the iframe's CURRENT position each call — handles position shifts.
 */
async function cdpClickCaptcha() {
  // Find the captcha iframe's current position via JS
  const result = await sendCommand("Runtime.evaluate", {
    expression: `
      (() => {
        // Try Turnstile first
        let frame = document.querySelector(
          'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile iframe'
        );
        if (frame) {
          const r = frame.getBoundingClientRect();
          if (r.width > 10 && r.height > 10) {
            return JSON.stringify({
              type: 'turnstile',
              x: Math.round(r.x + 30),
              y: Math.round(r.y + r.height / 2),
              iframeRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
            });
          }
        }

        // Try reCAPTCHA
        frame = document.querySelector('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]');
        if (frame) {
          const r = frame.getBoundingClientRect();
          if (r.width > 10 && r.height > 10) {
            return JSON.stringify({
              type: 'recaptcha',
              x: Math.round(r.x + 28),
              y: Math.round(r.y + r.height / 2),
              iframeRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
            });
          }
        }

        // Try hCaptcha
        frame = document.querySelector('iframe[src*="hcaptcha.com"]');
        if (frame) {
          const r = frame.getBoundingClientRect();
          if (r.width > 10 && r.height > 10) {
            return JSON.stringify({
              type: 'hcaptcha',
              x: Math.round(r.x + 28),
              y: Math.round(r.y + r.height / 2),
              iframeRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
            });
          }
        }

        return JSON.stringify({ type: 'not_found' });
      })()
    `,
    returnByValue: true,
  });

  const info = JSON.parse(result.result.value);
  if (info.type === 'not_found') {
    return { success: false, reason: 'No CAPTCHA iframe found' };
  }

  // Move mouse naturally to the click target, then click
  // Add small random offset to seem more human
  const jitterX = Math.round((Math.random() - 0.5) * 6);
  const jitterY = Math.round((Math.random() - 0.5) * 6);
  const clickX = info.x + jitterX;
  const clickY = info.y + jitterY;

  // Human-like: move mouse in steps toward target
  const startX = clickX + Math.round((Math.random() - 0.5) * 100);
  const startY = clickY + Math.round((Math.random() - 0.5) * 100);
  const steps = 5 + Math.round(Math.random() * 5);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mx = Math.round(startX + (clickX - startX) * t);
    const my = Math.round(startY + (clickY - startY) * t);
    await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: mx, y: my });
    await sleep(20 + Math.random() * 30);
  }

  // Click
  await sleep(100 + Math.random() * 200);
  await sendCommand("Input.dispatchMouseEvent", {
    type: "mousePressed", x: clickX, y: clickY, button: "left", clickCount: 1,
  });
  await sleep(50 + Math.random() * 80);
  await sendCommand("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: clickX, y: clickY, button: "left", clickCount: 1,
  });

  return { success: true, type: info.type, clickedAt: { x: clickX, y: clickY } };
}

/**
 * Verify if a CAPTCHA challenge was solved WITHOUT attaching debugger.
 * Uses chrome.scripting.executeScript to check the page state.
 */
async function verifyCaptchaSolved(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const body = document.body?.innerText || "";
        const url = window.location.href;

        // Check if challenge elements are still present
        const hasTurnstile = document.querySelector(
          'iframe[src*="challenges.cloudflare.com"], .cf-turnstile iframe'
        );
        const hasVerifyText =
          body.includes("Verify you are human") ||
          body.includes("Checking your browser") ||
          body.includes("Just a moment");

        // Check if a success indicator is present
        const hasCheckmark = document.querySelector(
          '[class*="success"], [class*="checked"], [data-checked="true"]'
        );

        // Check if the page navigated away from the challenge
        const isOnChallenge = hasVerifyText && hasTurnstile;

        // Check cf_clearance cookie
        const hasCfClearance = document.cookie.includes("cf_clearance");

        return {
          hasTurnstile: !!hasTurnstile,
          hasVerifyText,
          hasCheckmark: !!hasCheckmark,
          hasCfClearance,
          isOnChallenge,
          url,
          bodyPreview: body.substring(0, 200),
        };
      },
    });

    const check = results?.[0]?.result;
    if (!check) return { passed: false, reason: "Verification script failed" };

    // If cf_clearance cookie exists, it passed
    if (check.hasCfClearance) {
      return { passed: true, reason: "cf_clearance cookie found", ...check };
    }

    // If the challenge text is gone, it likely passed
    if (!check.isOnChallenge && !check.hasVerifyText) {
      return { passed: true, reason: "Challenge page no longer visible", ...check };
    }

    // Still on the challenge page
    return { passed: false, reason: "Challenge still present", ...check };
  } catch (e) {
    return { passed: false, reason: e.message || "Verification error" };
  }
}

/**
 * CLEAN CAPTCHA SOLVE — the nuclear option.
 * Detaches debugger (browser becomes genuinely clean), waits for Cloudflare
 * to see a real browser, then does an atomic reattach→find→click→detach
 * in ~100ms so the checkbox can't move between detection and click.
 *
 * Flow:
 * 1. Detach debugger → navigator.webdriver=false, debug bar gone
 * 2. Wait 2s → Cloudflare's background checks see a real browser
 * 3. Reattach → Runtime.evaluate to find iframe position → CDP click → detach
 * 4. Wait for verification
 */
async function cdpCleanCaptchaSolve(tabId) {
  try {
    // Step 1: Detach debugger — browser is now genuinely clean
    await detachDebugger();

    // Step 2: Wait for Cloudflare to see the clean state + Turnstile to render
    await sleep(3000);

    // Step 2.5: Use chrome.scripting to check if Turnstile iframe exists BEFORE reattaching
    // This avoids reattaching debugger when there's nothing to click
    let iframeExists = false;
    for (let retry = 0; retry < 5; retry++) {
      try {
        const check = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            return !!(
              document.querySelector('iframe[src*="challenges.cloudflare.com"]') ||
              document.querySelector('iframe[src*="turnstile"]') ||
              document.querySelector('.cf-turnstile iframe') ||
              document.querySelector('iframe[src*="recaptcha"]') ||
              document.querySelector('iframe[src*="hcaptcha"]')
            );
          },
        });
        iframeExists = check?.[0]?.result || false;
        if (iframeExists) break;
      } catch (e) {}
      await sleep(1000); // Wait and retry — Turnstile might still be loading
    }

    if (!iframeExists) {
      // Check if challenge is already solved (page changed)
      const verified = await verifyCaptchaSolved(tabId);
      if (verified.passed) {
        return { success: true, method: "already_solved", verification: verified };
      }
      return { success: false, reason: "No CAPTCHA iframe found — Turnstile may not have rendered" };
    }

    // Step 3: Atomic reattach → find → click → detach (~100ms total)
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabId = tabId;

    const findResult = await sendCommand("Runtime.evaluate", {
      expression: `
        (() => {
          // Turnstile
          let f = document.querySelector(
            'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile iframe'
          );
          if (f) {
            const r = f.getBoundingClientRect();
            if (r.width > 10 && r.height > 10)
              return JSON.stringify({ x: r.x + 30, y: r.y + r.height / 2, type: 'turnstile' });
          }
          // reCAPTCHA
          f = document.querySelector('iframe[src*="recaptcha/api2/anchor"]');
          if (f) {
            const r = f.getBoundingClientRect();
            if (r.width > 10 && r.height > 10)
              return JSON.stringify({ x: r.x + 28, y: r.y + r.height / 2, type: 'recaptcha' });
          }
          // hCaptcha
          f = document.querySelector('iframe[src*="hcaptcha.com"]');
          if (f) {
            const r = f.getBoundingClientRect();
            if (r.width > 10 && r.height > 10)
              return JSON.stringify({ x: r.x + 28, y: r.y + r.height / 2, type: 'hcaptcha' });
          }
          return JSON.stringify({ type: 'not_found' });
        })()
      `,
      returnByValue: true,
    });

    const info = JSON.parse(findResult.result.value);

    if (info.type === "not_found") {
      // No CAPTCHA found — detach and report
      await detachDebugger();
      return { success: false, reason: "No CAPTCHA iframe found after detach/reattach" };
    }

    // Click immediately at the found position (with tiny jitter)
    const jx = Math.round((Math.random() - 0.5) * 4);
    const jy = Math.round((Math.random() - 0.5) * 4);
    const cx = info.x + jx;
    const cy = info.y + jy;

    // Mouse move → press → release in rapid succession
    await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
    await sleep(30);
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1,
    });
    await sleep(50);
    await sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1,
    });

    // Step 4: Immediately detach — browser is clean for verification
    await detachDebugger();

    // Step 5: Wait for Cloudflare verification to complete
    await sleep(4000);

    // Step 6: VERIFY — check if the challenge is actually gone (no debugger needed)
    const verified = await verifyCaptchaSolved(tabId);

    return {
      success: verified.passed,
      type: info.type,
      clickedAt: { x: cx, y: cy },
      method: "clean_solve",
      verification: verified,
    };

  } catch (e) {
    // Make sure debugger is detached on error
    try { await detachDebugger(); } catch (_) {}
    return { success: false, reason: e.message || "Clean solve failed" };
  }
}

/**
 * Aggressively try to dismiss a popup/modal using multiple strategies via JS.
 * Returns true if something was dismissed.
 */
async function cdpDismissPopup() {
  const result = await sendCommand("Runtime.evaluate", {
    expression: `
      (() => {
        // Strategy 1: Click close/dismiss buttons
        const closeSelectors = [
          'button[aria-label*="close" i]', 'button[aria-label*="dismiss" i]',
          'button[class*="close" i]', 'button[class*="dismiss" i]',
          '.close', '.dismiss', '[data-dismiss]', '[aria-label="Close"]',
          'button[title*="close" i]', 'button[title*="dismiss" i]',
          '.modal-close', '.popup-close', '.dialog-close',
          '[class*="modal"] button', '[class*="popup"] button',
          '[role="dialog"] button[class*="close" i]',
          '[role="dialog"] button:first-of-type'
        ];

        for (const sel of closeSelectors) {
          const btns = document.querySelectorAll(sel);
          for (const btn of btns) {
            const s = getComputedStyle(btn);
            if (s.display === 'none' || s.visibility === 'hidden') continue;
            const r = btn.getBoundingClientRect();
            if (r.width < 5 || r.height < 5) continue;
            // Check if it looks like a close button (small, or has X-like text)
            const txt = (btn.innerText || btn.textContent || '').trim();
            if (txt === 'X' || txt === 'x' || txt === '\\u00D7' || txt === '\\u2715' ||
                txt === '' || txt.toLowerCase().includes('close') ||
                txt.toLowerCase().includes('dismiss') ||
                txt.toLowerCase().includes('no') ||
                txt.toLowerCase().includes('later') ||
                txt.toLowerCase().includes('cancel') ||
                txt.toLowerCase().includes('got it') ||
                txt.toLowerCase().includes('ok') ||
                btn.querySelector('svg')) {
              btn.click();
              return 'clicked_close_button';
            }
          }
        }

        // Strategy 2: Find and click any button inside modals/dialogs
        const modalBtns = document.querySelectorAll(
          '[role="dialog"] button, [class*="modal"] button, [class*="popup"] button'
        );
        for (const btn of modalBtns) {
          const s = getComputedStyle(btn);
          if (s.display === 'none') continue;
          const txt = (btn.innerText || '').trim().toLowerCase();
          if (txt.includes('no') || txt.includes('later') || txt.includes('cancel') ||
              txt.includes('close') || txt.includes('dismiss') || txt.includes('skip')) {
            btn.click();
            return 'clicked_dismiss_in_modal';
          }
        }

        // Strategy 3: Remove overlay elements from DOM
        const overlaySelectors = [
          '[class*="overlay" i]', '[class*="backdrop" i]', '[class*="mask" i]',
          '.modal-backdrop', '.popup-overlay'
        ];
        for (const sel of overlaySelectors) {
          const el = document.querySelector(sel);
          if (el) {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            if (r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.5) {
              el.style.display = 'none';
              return 'hid_overlay';
            }
          }
        }

        // Strategy 4: Hide modals/dialogs directly
        const modals = document.querySelectorAll(
          '[role="dialog"], [aria-modal="true"], [class*="modal" i][class*="show" i]'
        );
        for (const m of modals) {
          const s = getComputedStyle(m);
          if (s.display !== 'none') {
            m.style.display = 'none';
            return 'hid_modal';
          }
        }

        // Strategy 5: Re-enable scrolling on body
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';

        return 'no_popup_found';
      })()
    `,
    returnByValue: true,
  });
  return result.result.value || "failed";
}

async function executeAction(tabId, action) {
  await attachDebugger(tabId);

  // Helper to resolve ref or use raw coordinates
  function getCoords(act) {
    if (act.ref !== undefined) {
      const c = resolveRef(act.ref);
      if (!c) {
        console.warn(`Element ref ${act.ref} not found`);
        return null;
      }
      return c;
    }
    return { x: act.x, y: act.y };
  }

  switch (action.type) {
    case "click": {
      const c = getCoords(action);
      if (c) {
        await cdpClick(c.x, c.y);
        await sleep(500);
      }
      break;
    }

    case "double_click": {
      const c = getCoords(action);
      if (c) {
        await cdpDoubleClick(c.x, c.y);
        await sleep(500);
      }
      break;
    }

    case "hover": {
      const c = getCoords(action);
      if (c) {
        await cdpMoveMouse(c.x, c.y);
        await sleep(600);
      }
      break;
    }

    case "type":
      await cdpType(action.text);
      await sleep(200);
      break;

    case "focus_and_type": {
      // Combined action: click an element to focus it, then type
      const c = getCoords(action);
      if (c) {
        await cdpClick(c.x, c.y);
        await sleep(300);
        // If replacing, select all and delete first
        if (action.clear) {
          await cdpSelectAll();
          await sleep(50);
          await cdpKey("Backspace");
          await sleep(100);
        }
        await cdpType(action.text);
        await sleep(200);
      }
      break;
    }

    case "clear_and_type":
      await cdpSelectAll();
      await sleep(50);
      await cdpKey("Backspace");
      await sleep(100);
      await cdpType(action.text);
      await sleep(200);
      break;

    case "key":
      await cdpKey(action.key);
      await sleep(300);
      break;

    case "select":
      await cdpSelectOption(action.ref, action.value);
      await sleep(300);
      break;

    case "scroll":
      await cdpScroll(
        action.x || 400,
        action.y || 400,
        action.deltaX || 0,
        action.deltaY || 0
      );
      await sleep(500);
      break;

    case "navigate":
      await cdpNavigate(action.url);
      await sleep(2000);
      break;

    case "back":
      await cdpGoBack();
      await sleep(1500);
      break;

    case "forward":
      await cdpGoForward();
      await sleep(1500);
      break;

    case "extract_text": {
      const text = await cdpExtractText(action.ref);
      action._extractedText = text;
      break;
    }

    case "dismiss_popup": {
      const result = await cdpDismissPopup();
      action._dismissResult = result;
      await sleep(500);
      break;
    }

    case "click_captcha": {
      const result = await cdpClickCaptcha();
      action._captchaResult = result;
      await sleep(2000);
      break;
    }

    case "clean_captcha_solve": {
      const result = await cdpCleanCaptchaSolve(tabId);
      action._cleanSolveResult = result;
      // Debugger was detached during clean solve — reattach for next steps
      // (will be reattached automatically on next executeAction call)
      break;
    }

    case "wait":
      await sleep(Math.min(action.duration || 1000, 5000));
      break;

    case "accept_dialog":
      await handleDialog(true);
      await sleep(300);
      break;

    case "dismiss_dialog":
      await handleDialog(false);
      await sleep(300);
      break;

    case "done":
      await detachDebugger();
      break;

    default:
      console.warn(`Unknown action type: ${action.type}`);
  }

  return action;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Dialog / Alert Handling ──────────────────────────────────

let pendingDialog = null;

/**
 * Set up CDP event listener for JS dialogs (alert, confirm, prompt, beforeunload).
 * Auto-dismisses alerts. Stores confirm/prompt dialogs for the agent to handle.
 */
async function setupDialogHandler(tabId) {
  await attachDebugger(tabId);
  // Enable page events
  await sendCommand("Page.enable");

  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId !== attachedTabId) return;

    if (method === "Page.javascriptDialogOpening") {
      pendingDialog = {
        type: params.type,       // "alert", "confirm", "prompt", "beforeunload"
        message: params.message,
      };

      // Auto-accept alerts (they just block execution)
      if (params.type === "alert") {
        sendCommand("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        pendingDialog = null;
      }
    }
  });
}

/**
 * Handle a pending JS dialog. Called when the agent decides to accept or dismiss.
 */
async function handleDialog(accept) {
  if (!pendingDialog) return;
  await sendCommand("Page.handleJavaScriptDialog", { accept });
  pendingDialog = null;
}

/**
 * Get any pending dialog info (for the agent to see).
 */
function getPendingDialog() {
  return pendingDialog;
}

if (typeof globalThis !== "undefined") {
  globalThis.addEventListener?.("unload", () => detachDebugger());
}
