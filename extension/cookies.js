/**
 * Cookie Manager
 * Extracts cookies from the user's Chrome for a given URL,
 * and injects cookies back after stealth solving.
 */

/**
 * Get all cookies for a URL from Chrome.
 * Returns array of { name, value, domain, path, secure, httpOnly, sameSite }.
 */
async function extractCookies(url) {
  const cookies = await chrome.cookies.getAll({ url });
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite || "unspecified",
    expirationDate: c.expirationDate,
  }));
}

/**
 * Inject cookies into Chrome.
 * Used after stealth solver returns new cookies (e.g., cf_clearance).
 */
async function injectCookies(cookies, baseUrl) {
  let injected = 0;

  for (const c of cookies) {
    try {
      // Build the cookie URL from domain
      const domain = c.domain || "";
      const cleanDomain = domain.startsWith(".") ? domain.slice(1) : domain;
      const protocol = c.secure ? "https" : "http";
      const url = baseUrl || `${protocol}://${cleanDomain}${c.path || "/"}`;

      const cookieDetails = {
        url,
        name: c.name,
        value: c.value,
        path: c.path || "/",
        secure: c.secure || false,
        httpOnly: c.httpOnly || false,
      };

      // Domain: only set if it starts with "." (cross-subdomain)
      if (c.domain && c.domain.startsWith(".")) {
        cookieDetails.domain = c.domain;
      }

      // sameSite
      if (c.sameSite && c.sameSite !== "unspecified") {
        cookieDetails.sameSite = c.sameSite;
      }

      // Expiration
      if (c.expirationDate) {
        cookieDetails.expirationDate = c.expirationDate;
      }

      await chrome.cookies.set(cookieDetails);
      injected++;
    } catch (e) {
      console.warn(`Failed to inject cookie ${c.name}:`, e);
    }
  }

  return injected;
}

/**
 * Full stealth solve flow:
 * 1. Extract cookies from Chrome for the URL
 * 2. Send to backend /stealth-solve
 * 3. Get back solved cookies (with cf_clearance)
 * 4. Inject them into Chrome
 * 5. Reload the tab
 *
 * Returns { success, cf_clearance, cookiesInjected, error }
 */
async function stealthSolve(tabId, url, apiBase) {
  try {
    // 1. Get the user agent to match
    const tab = await chrome.tabs.get(tabId);
    const uaResult = await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      { expression: "navigator.userAgent", returnByValue: true }
    ).catch(() => null);
    const userAgent = uaResult?.result?.value || null;

    // 2. Extract current cookies for this URL
    const currentCookies = await extractCookies(url);

    // 3. Call backend stealth solver
    const response = await fetch(`${apiBase}/stealth-solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        user_agent: userAgent,
        cookies: currentCookies,
        timeout: 30,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return {
        success: false,
        cf_clearance: null,
        cookiesInjected: 0,
        error: err.detail || `Server error: ${response.status}`,
      };
    }

    const result = await response.json();

    if (!result.success) {
      return {
        success: false,
        cf_clearance: null,
        cookiesInjected: 0,
        error: result.error || "Stealth solver failed",
      };
    }

    // 4. Inject the solved cookies back into Chrome
    const injected = await injectCookies(result.cookies, url);

    // 5. Reload the tab to apply the new cookies
    await chrome.tabs.reload(tabId);
    // Wait for page to load
    await new Promise((resolve) => {
      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 10000);
    });

    return {
      success: true,
      cf_clearance: result.cf_clearance,
      cookiesInjected: injected,
      error: null,
    };
  } catch (e) {
    return {
      success: false,
      cf_clearance: null,
      cookiesInjected: 0,
      error: e.message || "Unknown error",
    };
  }
}
