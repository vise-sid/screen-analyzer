// Stealth patches — applied via crxApp.context().addInitScript() so they
// run BEFORE any page script on every navigation. Ports the anti-detection
// patches from origin/main's actions.js applyStealthPatches.
//
// What each patch does (do not delete the comments — they're load-bearing
// when debugging false negatives on anti-bot sites):
//
//   1. delete navigator.webdriver from the prototype (not just override)
//   2. fix PluginArray instanceof check broken in Chrome 91+
//   3. fake navigator.languages = ['en-US', 'en']
//   4. patch Notification.permission to "default"
//   5. add window.chrome.app stub (headless lacks this)
//   6. spoof WebGL vendor/renderer to Intel (CDP mode reports "Google Inc.")
//   7. spoof WebGL2 the same way
//   8. patch navigator.permissions.query for notifications
//
// Note: applied at the BrowserContext level, so every tab + every navigation
// inherits these patches.

export const STEALTH_INIT_SCRIPT = `
// 1. Hide navigator.webdriver — must delete from prototype
try {
  const proto = Navigator.prototype;
  if ('webdriver' in proto) { delete proto.webdriver; }
  if ('webdriver' in navigator) {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false, configurable: true, enumerable: true,
    });
  }
  Object.defineProperty(proto, 'webdriver', {
    get: () => false, configurable: true, enumerable: true,
  });
  const desc = Object.getOwnPropertyDescriptor(proto, 'webdriver');
  if (desc && desc.get) {
    desc.get.toString = () => 'function get webdriver() { [native code] }';
  }
} catch(e) {}

// 2. PluginArray instanceof patch
try {
  if (typeof PluginArray !== 'undefined') {
    const realPlugins = navigator.plugins;
    if (realPlugins && !(realPlugins instanceof PluginArray)) {
      try {
        Object.setPrototypeOf(realPlugins, PluginArray.prototype);
      } catch(e) {
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
try {
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
    configurable: true,
  });
} catch(e) {}

// 4. Notification permission default
try {
  if (window.Notification) Notification.permission = 'default';
} catch(e) {}

// 5. window.chrome.app stub (real Chrome has this; headless lacks)
try {
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.app) {
    window.chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    };
  }
} catch(e) {}

// 6. Spoof WebGL vendor/renderer
try {
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Intel Inc.';            // UNMASKED_VENDOR_WEBGL
    if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
    return getParameter.call(this, param);
  };
} catch(e) {}

// 7. Spoof WebGL2 the same way
try {
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return 'Intel Inc.';
      if (param === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter2.call(this, param);
    };
  }
} catch(e) {}

// 8. Permissions API for notifications
try {
  const originalQuery = navigator.permissions && navigator.permissions.query;
  if (originalQuery) {
    navigator.permissions.query = function(params) {
      if (params && params.name === 'notifications') {
        return Promise.resolve({ state: (window.Notification && Notification.permission) || 'prompt' });
      }
      return originalQuery.call(this, params);
    };
  }
} catch(e) {}

// 9. Scrub automation-tool tokens from Error.stack — anti-bot scripts that
// throw and inspect the stack will see "playwright" / "puppeteer" / "debugger"
// frames in CDP mode. Replace those tokens before the page can read them.
try {
  const STACK_REDACT = /(playwright|puppeteer|debugger|chrome-extension)/gi;
  const origToString = Error.prototype.toString;
  Error.prototype.toString = function() {
    const s = origToString.call(this);
    return s.replace(STACK_REDACT, 'native');
  };
  const stackDesc = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
  if (!stackDesc || stackDesc.configurable !== false) {
    const origStackGetter = stackDesc && stackDesc.get;
    Object.defineProperty(Error.prototype, 'stack', {
      configurable: true,
      get() {
        const raw = origStackGetter ? origStackGetter.call(this) : this._stack;
        if (typeof raw !== 'string') return raw;
        return raw.replace(STACK_REDACT, 'native');
      },
      set(v) { this._stack = v; },
    });
  }
} catch(e) {}
`;
