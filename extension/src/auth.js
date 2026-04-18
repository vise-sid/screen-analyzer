// Google ID-token sign-in via chrome.identity.launchWebAuthFlow.
//
// We use a Web Application OAuth client (the one verified to work in GCP)
// rather than the manifest's chrome-extension client (which Google rejects
// as "bad client id"). The redirect URI chrome.identity.getRedirectURL()
// returns is registered in GCP for our extension ID.
//
// This file exposes:
//   getGoogleIdToken({ interactive }) → Promise<string|null>
//   getCachedUser()                   → Promise<{sub,email,name,picture}|null>
//   signOut()                         → Promise<void>

const WEB_CLIENT_ID =
  "412083714557-nqvf6jq1jda8shc9sjo6scv7ui5fp0vl.apps.googleusercontent.com";

const ID_STORAGE_KEY = "pixelfoxx_id_token";
const USER_STORAGE_KEY = "pixelfoxx_user";

let cachedIdToken = null; // { token, expiresAt, claims }

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function isFresh(entry) {
  if (!entry || !entry.token || !entry.expiresAt) return false;
  return Date.now() < entry.expiresAt - 60_000; // 60s early refresh
}

function buildAuthUrl({ interactive }) {
  const nonce =
    (crypto.randomUUID && crypto.randomUUID()) ||
    Math.random().toString(36).slice(2) + Date.now().toString(36);
  const params = new URLSearchParams({
    client_id: WEB_CLIENT_ID,
    response_type: "id_token",
    scope: "openid email profile",
    redirect_uri: chrome.identity.getRedirectURL(),
    nonce,
  });
  if (!interactive) params.set("prompt", "none");
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function launchFlow(interactive) {
  return new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow(
      { url: buildAuthUrl({ interactive }), interactive },
      (redirectUrl) => {
        if (chrome.runtime.lastError || !redirectUrl) {
          if (chrome.runtime.lastError) {
            console.warn("[auth] launchWebAuthFlow:", chrome.runtime.lastError.message);
          }
          resolve(null);
          return;
        }
        const hash = (redirectUrl.split("#")[1] || "").replace(/^\//, "");
        const token = new URLSearchParams(hash).get("id_token");
        resolve(token || null);
      }
    );
  });
}

async function persist(token) {
  const claims = decodeJwtPayload(token);
  if (!claims || !claims.exp) return null;
  const entry = { token, expiresAt: claims.exp * 1000, claims };
  cachedIdToken = entry;
  await chrome.storage.local.set({
    [ID_STORAGE_KEY]: entry,
    [USER_STORAGE_KEY]: {
      sub: claims.sub,
      email: claims.email,
      name: claims.name,
      picture: claims.picture,
    },
  });
  return entry;
}

async function getGoogleIdToken({ interactive = true } = {}) {
  if (isFresh(cachedIdToken)) return cachedIdToken.token;

  if (!cachedIdToken) {
    const stored = await chrome.storage.local.get(ID_STORAGE_KEY);
    if (stored[ID_STORAGE_KEY] && isFresh(stored[ID_STORAGE_KEY])) {
      cachedIdToken = stored[ID_STORAGE_KEY];
      return cachedIdToken.token;
    }
  }

  const silent = await launchFlow(false);
  if (silent) {
    const entry = await persist(silent);
    if (entry) return entry.token;
  }

  if (!interactive) return null;

  const interactiveToken = await launchFlow(true);
  if (interactiveToken) {
    const entry = await persist(interactiveToken);
    if (entry) return entry.token;
  }
  return null;
}

async function getCachedUser() {
  const stored = await chrome.storage.local.get(USER_STORAGE_KEY);
  return stored[USER_STORAGE_KEY] || null;
}

async function signOut() {
  cachedIdToken = null;
  await chrome.storage.local.remove([ID_STORAGE_KEY, USER_STORAGE_KEY]);
}

export { getGoogleIdToken, getCachedUser, signOut };
