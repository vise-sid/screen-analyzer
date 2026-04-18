/**
 * Cookie Manager
 * Extracts cookies from Chrome for a URL, injects cookies back after stealth solving.
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

async function injectCookies(cookies, baseUrl) {
  let injected = 0;
  const errors = [];

  for (const c of cookies) {
    try {
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

      // Domain
      if (c.domain && c.domain.startsWith(".")) {
        cookieDetails.domain = c.domain;
      }

      // sameSite — Chrome extension API expects lowercase
      const sameSite = (c.sameSite || "").toLowerCase();
      if (sameSite === "none" || sameSite === "no_restriction") {
        cookieDetails.sameSite = "no_restriction";
        // sameSite=None requires secure=true
        cookieDetails.secure = true;
      } else if (sameSite === "lax") {
        cookieDetails.sameSite = "lax";
      } else if (sameSite === "strict") {
        cookieDetails.sameSite = "strict";
      }
      // "unspecified" or empty → don't set sameSite (Chrome defaults to Lax)

      // Expiration
      if (c.expirationDate) {
        cookieDetails.expirationDate = c.expirationDate;
      }

      const result = await chrome.cookies.set(cookieDetails);
      if (result) {
        injected++;
        if (c.name === "cf_clearance") {
          console.log(`Injected cf_clearance cookie for ${url}`);
        }
      } else {
        errors.push(`${c.name}: chrome.cookies.set returned null`);
      }
    } catch (e) {
      errors.push(`${c.name}: ${e.message}`);
    }
  }

  if (errors.length > 0) {
    console.warn(`Cookie injection errors (${errors.length}):`, errors.slice(0, 5));
  }

  return injected;
}

/**
 * Full stealth solve flow:
 * 1. Extract cookies from Chrome
 * 2. Send to backend /stealth-solve
 * 3. Get solved cookies back (with cf_clearance)
 * 4. Inject into Chrome
 * 5. Reload tab
 */
async function stealthSolve(tabId, url, apiBase) {
  try {
    // Get user agent
    let userAgent = null;
    try {
      await attachDebugger(tabId);
      const uaResult = await sendCommand("Runtime.evaluate", {
        expression: "navigator.userAgent",
        returnByValue: true,
      });
      userAgent = uaResult?.result?.value || null;
      await detachDebugger();
    } catch (e) {
      console.warn("Could not get user agent:", e);
    }

    // Extract current cookies
    const currentCookies = await extractCookies(url);
    console.log(`Extracted ${currentCookies.length} cookies for ${url}`);

    // Call backend
    const response = await fetch(`${apiBase}/stealth-solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        user_agent: userAgent,
        cookies: currentCookies,
        timeout: 45,
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
    console.log(`Stealth solve result: success=${result.success}, cookies=${result.cookies?.length}, cf_clearance=${!!result.cf_clearance}`);

    if (!result.success || !result.cookies || result.cookies.length === 0) {
      return {
        success: false,
        cf_clearance: result.cf_clearance,
        cookiesInjected: 0,
        error: result.error || "No cookies returned from stealth solver",
      };
    }

    // Inject cookies
    const injected = await injectCookies(result.cookies, url);
    console.log(`Injected ${injected}/${result.cookies.length} cookies`);

    // Reload the tab
    await chrome.tabs.reload(tabId);
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
      success: !!result.cf_clearance,
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
