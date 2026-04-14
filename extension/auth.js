/**
 * Google OAuth via Chrome Identity API.
 * Piggybacks on the user's Chrome Google account — no separate login needed.
 */

let cachedToken = null;

/**
 * Get a Google OAuth access token for the current Chrome user.
 * First call triggers a consent popup; subsequent calls return cached/refreshed token.
 * @returns {Promise<string|null>} OAuth access token or null if unavailable
 */
async function getGoogleAuthToken() {
  // Return cached if still valid
  if (cachedToken) {
    // Quick validation — try a lightweight API call
    try {
      const resp = await fetch("https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=" + cachedToken);
      if (resp.ok) return cachedToken;
    } catch (_) {}
    cachedToken = null;
  }

  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        console.error("OAuth failed:", chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      cachedToken = token;
      console.log("Google OAuth token obtained");
      resolve(token);
    });
  });
}

/**
 * Clear the cached token (e.g., on auth error so next call re-authenticates).
 */
async function clearGoogleAuthToken() {
  if (cachedToken) {
    return new Promise((resolve) => {
      chrome.identity.removeCachedAuthToken({ token: cachedToken }, () => {
        cachedToken = null;
        console.log("Google OAuth token cleared");
        resolve();
      });
    });
  }
}
