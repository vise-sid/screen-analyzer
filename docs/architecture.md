# PixelFoxx — Architecture & Build Reference

Decisions and rationale captured for reference during build. Not a full spec.

---

## Product framing

A workflow-recipe platform for browser automation on legacy portals (no APIs).

- User **records** or **describes** a task once → becomes a reusable recipe
- Recipes run **attended** (now, in the user's tab) or **unattended** (scheduled, parallel)
- Recipes are **intent-based**, not dumb replay — they adapt to DOM changes and page-state differences via LLM reasoning
- Target: anyone with repetitive work on legacy portals (CAs, compliance, back-office, ops) — GST is an example use case, not the whole product

---

## Chosen architecture: Extension + Local Daemon

```
┌─────────────────────────────────────────────────────────────┐
│                 USER'S CHROME BROWSER                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ PixelFoxx Extension                                   │   │
│  │  - Sidepanel UI: recipes, schedules, runs            │   │
│  │  - Recorder: content scripts capture DOM events      │   │
│  │  - Attended runs: chrome.debugger on current tab     │   │
│  └──────────────┬───────────────────────────────────────┘   │
└─────────────────┼───────────────────────────────────────────┘
                  │ native messaging (stdio, JSON-RPC)
                  ▼
┌─────────────────────────────────────────────────────────────┐
│           LOCAL DAEMON (Go or Rust, single binary)          │
│   Scheduler · Executor pool · Chrome launcher · CDP client  │
│   Reuses user's Chrome profile for session persistence      │
└────────────┬──────────────────────┬─────────────────────────┘
             │                      │
      SQLCipher vault         OS Keychain
      + session cache         (Windows DPAPI /
                              macOS Keychain /
                              Linux libsecret)
             │
             ▼ HTTPS
┌─────────────────────────────────────────────────────────────┐
│           BACKEND (existing FastAPI + Gemini)               │
│   Flash executor · Pro advisor · intent resolution          │
│   Stateless — no client data persisted                      │
└─────────────────────────────────────────────────────────────┘
```

### Why this and not a desktop app

- Lower install friction — Chrome Web Store install first, daemon only when scheduling is needed
- Extension is already the best surface for recording (content scripts see every DOM event)
- Sidepanel UX is contextual — lives next to the site being automated
- Keeps existing extension + backend code as primary assets
- Daemon is small (~3–5K LOC), just plumbing

### Why a daemon at all (vs extension alone)

- MV3 service workers die after ~30s idle — can't run 2-minute workflows across sleep
- Extension can't wake Chrome; daemon can launch Chrome with user's profile on schedule
- Extension runs one tab at a time; daemon spawns N browser contexts for parallel fan-out

### When to revisit (add full desktop app)

- Team mode with shared recipes and admin console
- On-prem enterprise deployment
- Non-Chrome support (Firefox/Safari)

---

## Intent-based recipe model

Recipes are **not** deterministic click-scripts. Each step has four layers evaluated top-down at replay:

```json
{
  "step_id": "fill_gstin",
  "intent": "Enter the client's GSTIN into the login form",
  "action": "fill_field",

  "target_hints": {
    "aria_role": "textbox",
    "accessible_name": "GSTIN / Username",
    "nearby_text": "Enter 15-digit GSTIN",
    "css_selector": "#gstin_input",
    "xpath": "//input[@id='gstin_input']",
    "visual_anchor_screenshot": "recording_step_3.png"
  },

  "value": {
    "source": "parameter",
    "name": "gstin",
    "transform": "uppercase"
  },

  "guards": {
    "skip_if": "field already contains $value",
    "wait_for": "page loaded AND captcha absent",
    "on_fail": "ask_advisor"
  },

  "intent_modifiers": [
    "if field is labeled 'Username' instead, use same value",
    "if GSTIN is pre-filled, skip",
    "if page shows 'session expired', re-login first"
  ]
}
```

### Runtime resolution order

1. **Deterministic fast path** — try CSS selector → ARIA+name → xpath. ~95% of steps resolve here. No LLM cost.
2. **Advisor fallback** — on failure, send current DOM + intent + target hints to Gemini Pro, get new selector.
3. **Intent modifier evaluation** — natural-language rules applied each run, advisor rewrites target if needed.
4. **Human escalation** — low confidence → pause, ask user, save answer back into recipe (self-teaching).

### Cost control

Most steps never call the LLM. Advisor runs only on failure or high-abstraction steps. Cheap at scale.

---

## Credential management

### Three separate concerns

1. **Vault** — encrypted store of usernames/passwords/mobile
2. **Session cache** — saved cookies from past logins, reused first
3. **OTP channel** — how one-time codes enter at runtime

### Vault design

- **SQLCipher** (AES-256) in the daemon
- **Key split in two**: half in OS keychain (DPAPI/Keychain/libsecret), half from optional master password. Need both to unlock.
- Bulk CSV import; tag/folder/search; per-credential metadata (last login, expiry)
- Encrypted backup/export for recovery

### The critical rule: LLM never sees credentials

- Password fields redacted to `{{CRED:147}}` placeholders before any DOM is sent to Gemini
- Daemon substitutes real value at CDP injection time, never through clipboard, never in logs
- Extension content scripts also redact before backend calls
- Violating this = DPDP Act violation + dealbreaker for any serious firm

### Session-first pattern (critical — reduces credential use by 50–95%)

Every login step runs this order:

1. Load saved cookies for `(client, portal)`, navigate to dashboard
2. If logged-in markers present → skip login entirely, run workflow
3. Else → pull credentials from vault, fill form, handle OTP
4. On success → capture cookies, re-encrypt, store with TTL
5. Zero credentials from memory immediately

GST session ≈ 4 hours active / 15 min idle. Batch runs amortize one login across many recipe executions.

### OTP handling

- **Manual (MVP)** — workflow pauses, badge on sidepanel, user types OTP, daemon injects
- **Android companion (phase 2)** — reads SMS on ops phone, forwards to daemon over LAN; documented client consent
- **TOTP (where supported)** — generate codes from stored secret

### Team mode (later)

- Shared vault: each credential encrypted with a group key
- Group key wrapped per-user via public-key crypto (age / NaCl box)
- Revoke user → rotate group key, re-wrap
- Audit log: every decryption with user, time, recipe, client

---

## Build order

### Phase 1 — Foundation (extension only, attended)

1. **Recipe schema** — JSON format. Everything depends on it.
2. **Recorder** — extension captures user actions into a recipe.
3. **Replay engine** — runs recipe in current tab, attended.
4. **LLM redaction middleware** — strip credentials before any Gemini call. Ship before step 5.
5. **Credential vault** — SQLCipher + OS keychain. CSV import.

### Phase 2 — Daemon (scheduled + unattended)

6. **Native messaging bridge** — extension ↔ daemon JSON-RPC.
7. **Local daemon + CDP** — launches Chrome with user's profile, drives it.
8. **Scheduler** — cron inside daemon. Recipes run on time.
9. **Session cache** — reuse cookies across runs.

### Phase 3 — Scale + resilience

10. **Parallel fan-out** — worker pool for batch runs.
11. **Manual OTP handoff** — pause/resume flow in sidepanel.
12. **Self-healing selectors** — LLM fallback when DOM shifts.
13. **Encrypted backup/export** — recovery story.

### Later

Team mode · Android OTP companion · Tally/Zoho/Excel/Busy connectors · on-prem server · SSO · hardware key support.

---

## Hard rules (do not violate)

- **Never log or send credentials to the LLM.** Redact before every backend call.
- **Never persist raw CSV imports.** Ingest, encrypt, shred.
- **Never use clipboard for credential injection.** Use CDP `Input.insertText` / direct DOM writes.
- **Never hardcode credentials in recipes.** Always reference by vault ID.
- **Never roll your own crypto.** libsodium / age / SQLCipher only.
- **Never auto-reveal passwords in UI.** Reveal requires master password re-prompt; clipboard auto-clears in 30s.
- **Never ship unsigned installers.** Windows SmartScreen and macOS Gatekeeper will block.

---

## Open questions to resolve during build

- Daemon language: Go (faster to ship, mature CDP libs) vs Rust (better memory safety for handling secrets). Probably Go for MVP, Rust if compliance posture demands it.
- Chrome profile strategy: use user's real profile directly (risk: conflicts with daily browsing) vs a managed copy synced from the real one. Lean toward managed copy.
- Recipe sharing: export/import between users → how to handle environment-specific selectors without leaking client data.
- Offline mode: should recipes run without the backend? Fast-path works offline; self-healing and intent reasoning need network. Decide UX for degraded mode.
- Billing model: per-seat / per-recipe-run / per-client. Affects telemetry requirements.

---

## Competitive context (for reference)

- **Bardeen / Browse.ai / Axiom.ai** — extension or cloud, weak on unattended-with-your-session
- **UiPath / Automation Anywhere** — enterprise, desktop, expensive, no LLM self-healing
- **Differentiation** — LLM-driven recipe creation + self-healing + uses your real session + runs unattended + parallel at scale. No competitor has all five.
