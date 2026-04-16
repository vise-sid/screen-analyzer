/**
 * Google Sign-In for PixelFoxx.
 *
 * Two separate token flows:
 *   1. ID token (JWT) — sent to OUR backend for JWKS verification.
 *      Obtained via chrome.identity.launchWebAuthFlow against a
 *      **Web application** OAuth client.
 *   2. Access token — sent to Google's Workspace APIs (Sheets/Docs/Slides).
 *      Obtained via chrome.identity.getAuthToken against the **Chrome
 *      Extension** OAuth client registered in manifest.json.
 *
 * These are intentionally separate. The ID token is short-lived (~1h) and
 * refreshed silently; access tokens are Google's usual OAuth 2.0.
 *
 * Setup: see docs/setup.md for how to create both OAuth clients.
 */

// ── Configuration ───────────────────────────────────────────────────────────
//
// Web Application OAuth client ID (NOT the Chrome Extension one in manifest.json).
// Create this in Google Cloud Console → APIs & Services → Credentials →
// Create Credentials → OAuth client ID → Web application.
// Add https://<extension-id>.chromiumapp.org/ as an Authorized redirect URI.
const WEB_CLIENT_ID =
  "412083714557-nqvf6jq1jda8shc9sjo6scv7ui5fp0vl.apps.googleusercontent.com";
// ^ Placeholder: using the existing client_id for now. Replace with the
// Web-app client_id once it's created. See docs/setup.md.

const STORAGE_KEY = "pixelfoxx_id_token";
const USER_STORAGE_KEY = "pixelfoxx_user";

// ── In-memory caches ────────────────────────────────────────────────────────
let cachedIdToken = null;        // { token, expiresAt, claims }
let cachedAccessToken = null;    // Legacy — used by Workspace APIs

// ── ID token (for OUR backend) ──────────────────────────────────────────────

/**
 * Parse a JWT payload without verifying the signature — safe because we only
 * use the `exp` field to decide when to refresh. All real verification
 * happens on the backend via JWKS.
 */
function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function isIdTokenFresh(entry) {
  if (!entry || !entry.token || !entry.expiresAt) return false;
  // Refresh 60s early to avoid in-flight expiry.
  return Date.now() < entry.expiresAt - 60_000;
}

function buildAuthUrl({ interactive }) {
  const nonce =
    (crypto.randomUUID && crypto.randomUUID()) ||
    Math.random().toString(36).slice(2) + Date.now().toString(36);
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id: WEB_CLIENT_ID,
    response_type: "id_token",
    scope: "openid email profile",
    redirect_uri: redirectUri,
    nonce,
  });
  // Silent refresh: ask Google not to prompt again if the user is still
  // logged into their Google account.
  if (!interactive) params.set("prompt", "none");
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function launchFlow(interactive) {
  return new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow(
      { url: buildAuthUrl({ interactive }), interactive },
      (redirectUrl) => {
        if (chrome.runtime.lastError || !redirectUrl) {
          resolve(null);
          return;
        }
        // ID token comes back in the URL fragment.
        const hash = (redirectUrl.split("#")[1] || "").replace(/^\//, "");
        const token = new URLSearchParams(hash).get("id_token");
        resolve(token || null);
      }
    );
  });
}

async function persistIdToken(token) {
  const claims = decodeJwtPayload(token);
  if (!claims || !claims.exp) return null;
  const entry = {
    token,
    expiresAt: claims.exp * 1000,
    claims,
  };
  cachedIdToken = entry;
  await chrome.storage.local.set({
    [STORAGE_KEY]: entry,
    [USER_STORAGE_KEY]: {
      sub: claims.sub,
      email: claims.email,
      name: claims.name,
      picture: claims.picture,
    },
  });
  return entry;
}

/**
 * Ensure we have a fresh Google ID token. Tries in order:
 *   1. In-memory cache.
 *   2. chrome.storage.local cache.
 *   3. Silent re-auth (prompt=none) — works if user is still signed into Google.
 *   4. Interactive sign-in — shows the Google consent window.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.interactive=true] - Allow showing a consent window.
 * @returns {Promise<string|null>} ID token, or null if unavailable.
 */
async function getGoogleIdToken({ interactive = true } = {}) {
  if (isIdTokenFresh(cachedIdToken)) return cachedIdToken.token;

  // Warm from storage on a fresh sidepanel load.
  if (!cachedIdToken) {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (stored[STORAGE_KEY] && isIdTokenFresh(stored[STORAGE_KEY])) {
      cachedIdToken = stored[STORAGE_KEY];
      return cachedIdToken.token;
    }
  }

  // Try silent refresh first — covers the common case of a returning user.
  const silent = await launchFlow(false);
  if (silent) {
    const entry = await persistIdToken(silent);
    if (entry) return entry.token;
  }

  if (!interactive) return null;

  const interactiveToken = await launchFlow(true);
  if (interactiveToken) {
    const entry = await persistIdToken(interactiveToken);
    if (entry) return entry.token;
  }
  return null;
}

/**
 * Get the cached signed-in user (from the last stored ID token) without
 * hitting the network. Returns null if not signed in.
 */
async function getCachedUser() {
  const stored = await chrome.storage.local.get(USER_STORAGE_KEY);
  return stored[USER_STORAGE_KEY] || null;
}

/**
 * Sign the user out locally. Clears caches and storage. Does NOT revoke
 * the Google session itself — user can sign back in with one click.
 */
async function signOut() {
  cachedIdToken = null;
  cachedAccessToken = null;
  await chrome.storage.local.remove([STORAGE_KEY, USER_STORAGE_KEY]);
  try {
    // Best-effort revoke of the Workspace access token too.
    const existing = await new Promise((resolve) => {
      chrome.identity.getAuthToken({ interactive: false }, (t) => resolve(t));
    });
    if (existing) {
      await new Promise((resolve) => {
        chrome.identity.removeCachedAuthToken({ token: existing }, resolve);
      });
    }
  } catch (_) {}
}

// ── Access token (for Google Workspace APIs) ───────────────────────────────
// Unchanged from the previous implementation — Workspace APIs need
// access_tokens via the Chrome Extension OAuth client from manifest.json.

async function getGoogleAuthToken() {
  if (cachedAccessToken) {
    try {
      const resp = await fetch(
        "https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=" +
          cachedAccessToken
      );
      if (resp.ok) return cachedAccessToken;
    } catch (_) {}
    cachedAccessToken = null;
  }

  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        console.error("OAuth failed:", chrome.runtime.lastError.message);
        resolve(null);
        return;
      }
      cachedAccessToken = token;
      console.log("Google OAuth access token obtained");
      resolve(token);
    });
  });
}

async function clearGoogleAuthToken() {
  if (cachedAccessToken) {
    return new Promise((resolve) => {
      chrome.identity.removeCachedAuthToken(
        { token: cachedAccessToken },
        () => {
          cachedAccessToken = null;
          console.log("Google OAuth access token cleared");
          resolve();
        }
      );
    });
  }
}

// ── Authenticated fetch helper ─────────────────────────────────────────────

/**
 * Wrapper around fetch() that automatically attaches the Google ID token
 * as a Bearer credential. Transparently refreshes on 401.
 *
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
async function apiFetch(url, init = {}) {
  let token = await getGoogleIdToken({ interactive: false });
  if (!token) {
    // Force interactive sign-in once — if it still fails, bubble up a 401.
    token = await getGoogleIdToken({ interactive: true });
  }
  if (!token) {
    // Synthesize a 401 Response so callers can handle it uniformly.
    return new Response(
      JSON.stringify({ detail: "Not signed in" }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);

  let response = await fetch(url, { ...init, headers });

  // Token might have just expired server-side — retry once with a forced refresh.
  if (response.status === 401) {
    cachedIdToken = null;
    const refreshed = await getGoogleIdToken({ interactive: true });
    if (refreshed) {
      headers.set("Authorization", `Bearer ${refreshed}`);
      response = await fetch(url, { ...init, headers });
    }
  }
  return response;
}
