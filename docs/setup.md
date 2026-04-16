# Setup: Google Sign-In + Token Tracking

This document covers the one-time setup required to enable Google Sign-In
(via JWKS-verified ID tokens) and per-user token spend tracking.

The extension uses **two** OAuth clients intentionally:

1. A **Chrome Extension** OAuth client — existing, for Google Workspace API
   access tokens (Sheets / Docs / Slides / Drive). Registered in
   `extension/manifest.json` under `oauth2.client_id`.
2. A **Web application** OAuth client — new, for ID tokens that our backend
   verifies against Google's JWKS. Used in `extension/auth.js`
   (`WEB_CLIENT_ID`).

They can share the same Google Cloud project and consent screen.

---

## 1. Create the Web application OAuth client

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Click **Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name: e.g. `PixelFoxx — Sign-In`.
5. **Authorized redirect URIs**: add the Chrome extension redirect URI.
   Chrome generates this as `https://phkpioihgndmafegpedfkpimapphfjea
.chromiumapp.org/`.
   - For published extensions the ID comes from the Chrome Web Store.
   - For unpacked development extensions the ID changes each time you
     load the folder unless you pin it — see **Pinning the extension ID**
     below.
6. Click **Create** and copy the generated **Client ID**.

## 2. Wire the Client ID into the extension

Edit `extension/auth.js`:

```js
const WEB_CLIENT_ID = "<paste the Web application client id here>";
```

This is a public value — it's fine to commit.

## 3. Wire the Client ID into the backend

Create (or update) `backend/.env`:

```dotenv
GEMINI_API_KEY=...
GOOGLE_WEB_CLIENT_ID=<same Web application client id>
# Optional — overrides of daily $ caps per tier
DAILY_LIMIT_FREE_USD=1.00
DAILY_LIMIT_PRO_USD=25.00
DAILY_LIMIT_TEAM_USD=100.00
```

Restart the backend. On the first request, `backend/data.db` is created
automatically (SQLite + WAL).

## 4. Pinning the extension ID (development only)

The unpacked extension ID depends on the folder path. To keep it stable
across machines and reloads, add a `key` field to `extension/manifest.json`.

Generate a key:

```bash
openssl genrsa -out key.pem 2048
openssl rsa -in key.pem -pubout -outform DER | openssl base64 -A
```

Paste the resulting base64 string into `manifest.json`:

```json
{
  "manifest_version": 3,
  "key": "MIIBIjANBgkq...",
  "name": "PixelFoxx",
  ...
}
```

Reload the extension and copy the new (now stable) ID from
`chrome://extensions`. Register `https://<that-id>.chromiumapp.org/` as a
redirect URI on the Web application OAuth client.

**Do not commit `key.pem`.** The `key` field in `manifest.json` is the
public half and is safe to commit.

## 5. Smoke test

1. Reload the extension in `chrome://extensions`.
2. Open the sidepanel — you should see the **Sign in with Google** screen.
3. Click it. A Google consent window appears; approve.
4. The sidepanel flips to the main UI with your avatar and name in the header.
5. Run any short task. Check `backend/data.db`:

   ```sql
   sqlite3 backend/data.db
   > SELECT email, COUNT(*), SUM(cost_usd)
     FROM usage_events
     JOIN users ON users.sub = usage_events.user_sub
     GROUP BY email;
   ```

   You should see one row per signed-in user with their running spend.

## 6. Useful admin commands

Raise yourself to the `admin` tier (no daily cap):

```sql
sqlite3 backend/data.db
> UPDATE users SET tier = 'admin' WHERE email = 'you@example.com';
```

Reset a user's usage:

```sql
> DELETE FROM usage_events WHERE user_sub = (SELECT sub FROM users WHERE email = 'you@example.com');
```

## 7. Dev mode (optional, local-only)

To skip Google Sign-In while developing:

```dotenv
AUTH_DEV_MODE=1
```

Every request is then attributed to a synthetic `dev-user` — useful for
running without the Google consent round-trip. **Never enable in
production.**

---

## Troubleshooting

- **"Server missing GOOGLE_WEB_CLIENT_ID"** — the env var wasn't read.
  Restart the backend after editing `.env`.
- **"Invalid ID token"** — the Client ID in `auth.js` doesn't match the
  one on the backend, or the token was minted for a different audience.
- **Sign-in closes without success** — the redirect URI registered on the
  Web OAuth client doesn't match `https://<extension-id>.chromiumapp.org/`.
  Copy it exactly from `chrome.identity.getRedirectURL()` in the
  extension's devtools.
- **401 on every request** — browser network tab, check that the request
  has an `Authorization: Bearer …` header. If missing, `getGoogleIdToken`
  returned null — usually the redirect URI mismatch above.
