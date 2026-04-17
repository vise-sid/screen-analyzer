# PixelFoxx — Architecture & Build Reference

Living reference document. Captures the current design direction so a new
session can resume without replaying the whole conversation.

Latest update: post Phase-3 CDP network capture. Overlay direction reversed —
sidepanel is the primary surface (see below). Capture pipeline now delivers
unified envelopes with outcome attribution, container context, selective
mutation observation, tab-focus tracking, semantic SPA-nav filtering, and
CDP network interception with keys-only request-body safety.

---

## The product in one sentence

A browser co-pilot that sits alongside the user while they work on any
website, learns reusable **playbooks** from sessions, and can run those
playbooks later — attended now, scheduled and parallel later.

### Who it's for

Anyone with repetitive work on legacy portals that lack APIs:
CAs, compliance teams, back-office staff, ops. GST-for-CA-firms is the
lead use case but the product is horizontal.

### The character

The agent is **Pixel Foxx** — "Pixel" for short, "Foxx" when formal.
Streetwear-styled pixel-art fox with headset + shades. Voice is casual
and confident, never corporate.

Copy examples — use these as the reference register:

| State | Copy |
|---|---|
| Idle | "Pixel's watching" |
| Noticed page change | "you're on gst.gov.in — want a hand?" |
| Thinking | "reading the page…" |
| Doing | "clicking Download" |
| Needs user | "hit a wall — need your eyes" |
| Done | "nailed it." |

---

## UX model — co-pilot, one mode

There is **one mode of operation**: co-pilot. User and Pixel share
control of the same browser tab.

- User can take over at any moment by interacting with the page
- Pixel auto-pauses when a trusted user event fires
- User types (or later speaks) to hand control back
- Pixel re-reads the page on resume and continues from there

**Every session is a shared-control session.** No "agent mode" toggle,
no "record mode," no "manual mode." Just one collaborative surface that
works however you feel like working at any moment.

### Primary surface: refined Chrome sidepanel (overlay rejected)

**Decision reversed:** the earlier plan to build an in-page overlay (pill +
card + shadow-DOM + drag-snap-to-corner) was rejected as overengineering
relative to validating the playbook hypothesis. The Chrome sidepanel is
the primary surface.

Why we reversed:
- The overlay would have required weeks of CSS-fighting on every target
  portal (shadow-DOM isolates outwards, but legacy portals routinely break
  it with stacking-context shenanigans). Sidepanel never fights page CSS.
- The overlay is invisible on `chrome://`, Web Store, PDF viewer, file://.
  Sidepanel keeps working there.
- Cross-tab continuity is trivial in a sidepanel (per-window, follows
  tabs). The overlay would have fragmented state per-tab.
- Spatial coupling ("point at the button") can be reclaimed later via the
  content script drawing overlays on demand, without paying for a full
  co-pilot UI in shadow DOM.

The sidepanel has been evolved from a flat chronological stream into a
drill-down outline that respects the captured hierarchy: *Dossier (current
tab) · Chip strip (tabs visited) · Visit cards (one per tab/host) → Action
cards (one per user/agent action) → Action detail (action + its
consequences)*. Typography is Miranda Sans throughout.

### Tab awareness (shipped)

The sidepanel is *about the current tab*. Background emits `tab_activated`
events on focus changes; the sidepanel renders a pinned dossier (favicon +
hostname + title) and a horizontal chip strip of every host touched this
session. Clicking a chip filters the root view to that host.

Shipped signals and filters:
- `chrome.tabs.onActivated` → emits `tab_activated` with dedup (300 ms)
- `chrome.windows.onFocusChanged` → also emits `tab_activated`
- `pixelfoxx_prime` message from sidepanel-bootstrap → forces one prime emit
- Restricted URLs (`chrome://`, `about:`, `devtools:`, `view-source:`) are
  silently skipped at the background level

States deferred for a dedicated design pass: empty/new tab copy, restricted
page copy. Current behavior is "silent skip."

### Voice — deferred

Press-and-hold voice and catch-phrase ("Hey Pixel") are both deferred.
Keyboard is the only input in the current phase. Revisit after playbook
lifecycle is solid.

---

## Playbook model (supersedes earlier "structured JSON recipe" plan)

Playbooks are **markdown documents**, not click-scripts with selectors.
The LLM is the replay engine. Playbooks describe intent; the agent
decides actions using the current DOM.

### Example shape

```markdown
# Download GSTR-2A for a client

## Inputs
- gstin (required): 15-char GSTIN
- username (required): GST portal username
- password (required, secret): GST portal password
- period (required): YYYYMM

## Steps
1. Navigate to https://services.gst.gov.in/services/login
2. Enter {{ username }} in the username field
3. Enter {{ password }} in the password field
4. Complete the CAPTCHA (pause for user if needed)
5. Click Login
6. From the dashboard, open Returns → Returns Dashboard
7. Pick FY {{ fy_from_period(period) }}, period {{ month_from_period(period) }}
8. On GSTR-2A tile, click Download
9. Save the file as gstr-2a-{{ gstin }}-{{ period }}.zip

## Success criteria
File downloaded and larger than 1KB.

## Notes
- Session lives ~4h — reuse cookies first, only login if expired
- "No data" message means no invoices this period — success, not failure
```

### Why markdown, not JSON

- Human-writable and human-readable
- The agent already reasons from prose — no separate replay engine to build
- Brittle selector lists become unnecessary; self-healing is automatic
- Review and edit happen in one place, in natural language
- Shareable as a file

### Runtime model

`POST /playbook/{id}/run` with parameter values →
- Parameter substitution fills `{{ }}` placeholders
- Rendered playbook becomes the task the existing agent runs
- Event stream is captured (same shape as today)

### Capture — user-initiated, not automatic

Running ≠ intent to save. Most sessions are exploration.

- At session end, the overlay offers **"Save as playbook"**
- Advisor synthesizes a draft from the full session trace
- User reviews, edits markdown, saves
- If not saved, trace is discarded on overlay close (privacy)

Failed or incomplete sessions can still produce playbooks — the advisor
is told what worked and what didn't.

### What the advisor uses to write a better playbook than the demonstration

Every session captures:

- **Action trace** — step-by-step thoughts + actions + results
- **Struggle signals** — loop warnings, consecutive failures, retries, advisor calls, time outliers
- **Environmental context** — starting/ending URL, tabs, popups, CAPTCHAs, redirects
- **Network observations** — captured XHR/Fetch responses (often expose a cleaner data source than the UI)
- **User interventions** — ask_user answers, manual takeovers, typed values
- **Form context** — field labels around what the user typed (candidates for parameterization)

With all this, the advisor can propose a playbook that skips detours,
prefers direct URLs, and annotates known friction points.

### Post-run reflection (self-updating playbooks)

After every run, the advisor reviews:
- Original playbook
- Run trace
- Final outcome

And returns one of:
1. No change
2. Clarification (word tweak)
3. Structural update (step added/removed/rewritten)
4. Flag for human (unsure — ask user)

**Never auto-applied.** Suggestions surface in the overlay; user
reviews a diff, accepts or rejects. Rejected suggestions aren't
re-proposed.

---

## Long-term architecture (unchanged — still the target)

```
┌─────────────────────────────────────────────────────────────┐
│                 USER'S CHROME BROWSER                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ PixelFoxx Extension                                   │   │
│  │  - Overlay (pill + card) injected into every page     │   │
│  │  - Capture content script                             │   │
│  │  - Attended runs via chrome.debugger / CDP            │   │
│  └──────────────┬───────────────────────────────────────┘   │
└─────────────────┼───────────────────────────────────────────┘
                  │ native messaging (future — scheduled/unattended)
                  ▼
┌─────────────────────────────────────────────────────────────┐
│           LOCAL DAEMON (future — Go or Rust)                │
│   Scheduler · Executor pool · Chrome launcher · CDP client  │
│   Reuses user's Chrome profile for session persistence      │
└────────────┬──────────────────────┬─────────────────────────┘
             │                      │
      SQLCipher vault         OS Keychain
      + session cache         (Windows DPAPI / macOS / Linux)
             │
             ▼ HTTPS
┌─────────────────────────────────────────────────────────────┐
│       BACKEND (FastAPI + Gemini Flash/Pro, SQLite)          │
│   Flash executor · Pro advisor                              │
│   Auth (JWKS) · per-user usage + quota                      │
│   No client data persisted beyond usage events + playbooks  │
└─────────────────────────────────────────────────────────────┘
```

### Why daemon eventually (not now)

- MV3 service workers die after ~30s idle; can't run 2-minute workflows across sleep
- Extension can't wake Chrome; daemon can launch Chrome on schedule with user's profile
- Extension runs one tab at a time; daemon spawns N browser contexts for parallel fan-out

Daemon is deferred until after the co-pilot UX + playbook lifecycle is
shipping well.

---

## Credential management (unchanged)

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

### Session-first pattern (reduces credential use by 50–95%)

Every login step:
1. Load saved cookies for `(client, portal)`, navigate to dashboard
2. If logged-in markers present → skip login entirely, run workflow
3. Else → pull credentials from vault, fill form, handle OTP
4. On success → capture cookies, re-encrypt, store with TTL
5. Zero credentials from memory immediately

### OTP handling

- **Manual (MVP)** — workflow pauses, overlay shows prompt, user types OTP
- **Android companion (phase 2)** — reads SMS on ops phone, forwards to daemon over LAN
- **TOTP (where supported)** — generate codes from stored secret

### Team mode (later)

- Shared vault: each credential encrypted with a group key
- Group key wrapped per-user via public-key crypto (age / NaCl box)
- Revoke user → rotate group key, re-wrap
- Audit log: every decryption with user, time, playbook, client

---

## Build plan — current phase (`copilot-capture` branch)

Work is grouped to ship independently. Capture pipeline is largely
shipped; next natural step is **Group 6 — Save as playbook** (closes
the loop from capture → synthesis → review → replay).

### Group 1 — Sidepanel polish (redirected, ✅ mostly shipped)
Original plan was to replace the sidepanel with an in-page overlay.
**Reversed** — see "Primary surface" section above. Instead, the
sidepanel itself was polished:
- ✅ Grouped drill-down UI (root → visit → action detail)
- ✅ Dossier strip, chip strip, jump-to-latest pill
- ✅ Miranda Sans typography
- ✅ URL chip click-to-copy
- Open: character-focused copy + sprites (Group 3 below)

### Group 2 — Tab awareness (✅ shipped)
- ✅ `chrome.tabs.onActivated` + `chrome.windows.onFocusChanged` →
  `tab_activated` envelopes
- ✅ `pixelfoxx_prime` for sidepanel bootstrap
- ✅ Dossier strip with favicon + hostname + title
- ✅ Chip strip with All + per-host filter
- ⬜ Explicit copy for empty/new-tab and restricted-page states

### Group 3 — Pixel as a character (⬜ open)
Personality pass: copy, colors, sprites, typography.
- ⬜ Character art sprites (pixel-fox mascot across states)
- ⬜ Palette refinement (ember, leather black, yellow stripe)
- ⬜ Contextual copy rewrite ("watching," "on it," "hit a wall")
- Typography → decided: Miranda Sans throughout (already shipped).

### Group 4 — Keyboard shortcut (⬜ open)
"Call Pixel" from anywhere.
- ⬜ `commands` entry in manifest (`Cmd/Ctrl+Shift+K`)
- ⬜ Opens sidepanel, focuses command input, ready to type
- ⬜ Esc collapses
- ⬜ Rebindable via `chrome://extensions/shortcuts`

### Group 5 — Co-pilot primitives (⬜ open)
The shared-control substrate.
- ⬜ Auto-pause agent on trusted user events (<100 ms latency target)
- ⬜ Resume with re-plan (agent re-reads page on resume)
- ⬜ Take-over / hand-back controls in sidepanel
- ✅ Scroll gate during agent runs (ships as part of capture phase —
  drops CDP-injected scrolls so they don't look like user scrolls)

### Group 6 — Save as playbook (⬜ next)
User-initiated persistence of a session. **This is the closing loop
for the capture pipeline** — nothing from Phase 1–3 has visible value
until this exists.
- ⬜ "Save as playbook" button at session end
- ⬜ Advisor (backend, Gemini Pro) synthesizes draft playbook from
  the event stream (actions + attributed consequences + keys-only
  request schemas + redacted responses)
- ⬜ Draft review + edit UI (markdown)
- ⬜ `playbooks` + `playbook_drafts` tables; CRUD endpoints

### Group 7 — Run a playbook (⬜ open)
Replay with parameters.
- ⬜ `POST /playbook/{id}/run` with param values
- ⬜ `{{ variable }}` substitution
- ⬜ Playbooks list in sidepanel; "run" button
- ⬜ `playbook_runs` table for history

### Group 8 — Post-run reflection (⬜ open)
Pixel suggests edits after each run.
- ⬜ Reflection endpoint called after every run
- ⬜ Diff-based suggestions with rationale
- ⬜ Review UI in sidepanel: accept / reject / remember
- ⬜ `playbook_suggestions` table

### Capture enrichment — not yet on any group list

Flagged in earlier reviews as "undone items" from the original
capture wishlist. Ranked roughly by playbook value:

- ⬜ **Friction signals** derived in background — typing-then-deleting,
  repeated submits, time-between-actions, slow-API detection.
  All computable from the existing event stream, no new capture needed.
- ⬜ **Console errors** via CDP `Runtime.consoleAPICalled` +
  `Runtime.exceptionThrown` — forensics for failed agent runs.
- ⬜ **Custom error detection** — MutationObserver extension for
  `.error`, `.alert-danger`, `[aria-invalid=true]` beyond `role=alert`.
- ⬜ **Download events** — `chrome.downloads.onCreated`; one-liner,
  marks workflow boundaries.
- ⬜ **Iframes** — `all_frames: true` for capture.js (blanket) or
  targeted per-portal (cleaner). Relevant for MCA21, some banking
  portals.
- ⬜ **Start Capture button** — product-level toggle for network
  capture (yellow debug bar UX). Currently capture runs whenever
  sidepanel is open.

### Later (not this phase)

- Voice (press-and-hold, then catch-phrase via Porcupine)
- Full-page app (library / admin / usage dashboard)
- Credential vault
- Local daemon (scheduled + unattended + parallel)
- Team mode
- Android OTP companion
- Tally/Zoho/Excel/Busy connectors
- On-prem server
- SSO, hardware key support

---

## What's already shipped

### On `main`, before the `copilot-capture` branch started

- **Google Sign-In (JWKS-verified ID tokens)** gating all backend calls
- **Per-user token-spend tracking** — SQLite `users` + `usage_events` tables, pricing table, per-tier daily caps with HTTP 429 enforcement
- `/me` endpoint returns profile + usage summary
- LLM redaction scaffolding prepared but credentials feature not yet built
- **CDP timeout guards** — `withTimeout`, bounded `sendCommand`, `cdpNavigate` awaits `Page.loadEventFired`, `captureState` wrapped in 30s race with detach-and-retry

### On `copilot-capture` branch — capture pipeline

**Phase 1 — Unified envelope + outcome attribution.** Every signal flows
through one shape:

```
{ id, sessionId, ts, source, kind, actor, tabId,
  target?, context?, payload?, parentActionId?, causedBy? }
```

Background (`extension/background.js`) is the hub. Per-tab state holds
`sessionId`, the open action's `currentActionId`, and `windowExpiresAt`.
A 1500 ms **sliding window** attributes consequence events (page_ready,
mutations, navigations, network) to the action that caused them —
dropping `parentActionId` on each event. Per-tab isolation prevents
cross-tab bleed. Agent-navigate re-tagging moved out of the sidepanel
and into background, persisted via `chrome.storage.session` so it
survives sidepanel close + short SW idles. `pixelfoxx_session_reset`
on "new chat" regenerates session IDs. `chrome.tabs.onRemoved`
cleanup prevents leaks. Agent events render *synchronously* in the
sidepanel (no round-trip) but notify background for state updates.

**Phase 2a — Labels, SPA nav, form validation.**

- `extractLabel` in `capture.js` walks aria-labelledby → label[for] →
  wrapping label → aria-label to produce the *visible* label the user
  saw (not placeholder/name/id).
- SPA navigation detected via `webNavigation.onHistoryStateUpdated` +
  `onReferenceFragmentUpdated`; envelope carries `navigationType: "full"
  | "history" | "fragment"`. Semantic noise filter: `history`/`fragment`
  events without a preceding user/agent action are suppressed
  (GitHub's Turbo heartbeats, React re-canonicalization, etc.).
- `form_invalid` event kind captures HTML5-validation field rejections
  with `validationMessage` — high signal on GSTN-type portals.

**Phase 2b — Container context + outcome observer.**

- `target.container` / `target.containerName` added to every element
  descriptor. Priority: dialog > table-row > form > named-section.
  8-level ancestor walk, `WeakMap` memoization.
- Selective `MutationObserver` on body emits three high-signal kinds:
  `page_alert` (`[role=alert]` / `aria-live=assertive`),
  `page_dialog_opened` (`[role=dialog]` / `[role=alertdialog]` /
  `<dialog>` / `[aria-modal]`), `page_title_changed`. One-shot scan
  for pre-existing dialogs at `DOMContentLoaded`. 500 ms dedup on
  `(kind, text[0..40])`. No attribute observation (too noisy).
  Explicitly deferred: `page_notice` (role=status is spammy) and
  `page_settled` (aria-busy is inconsistently used).

**Tab focus tracking.** `tab_activated` event kind emitted on
`chrome.tabs.onActivated` and `chrome.windows.onFocusChanged` (300 ms
dedup). Sidepanel sends `pixelfoxx_prime` on bootstrap to get a
`tab_activated` for the current active tab — so the timeline opens
with "On *hostname*" context even without a fresh navigation.

**Scroll gate during agent runs.** `agentRunningTabs: Set<tabId>` in
background. Sidepanel's `setRunning(true/false)` notifies via
`pixelfoxx_agent_running`. Background drops `scroll` events on
agent-active tabs (CDP-injected scrolls land with `isTrusted:true`;
without this gate they'd pollute the timeline as "user scrolled").

**Programmatic capture bootstrap.** `scripting` permission added.
`bootstrapCaptureInAllTabs()` runs on every service-worker boot and
injects `capture.js` into every already-open non-restricted tab.
`chrome.tabs.onActivated` redundantly ensures injection on tab switch.
Idempotency guard (`window.__pixelfoxxCaptureInstalled`) prevents
duplicate listeners from multi-injection. Context-invalidation
diagnostic in `capture.js` logs one-shot at `console.debug` level (no
longer `warn` — doesn't pollute `chrome://extensions` errors page).

**Phase 3 — CDP network capture (V1).** `actions.js` extends its
existing `chrome.debugger` attach lifecycle. Request/response pairs
emitted as `kind: "network"` envelopes.

- *Request bodies:* **keys-only by construction.** `keysOnly()`
  recursively replaces every leaf with `"[VALUE]"`; arrays collapse
  to a single exemplar (length not leaked). Handles JSON, URL-encoded,
  multipart (file parts → `[FILE:<filename>]`). **No raw request
  value ever reaches the envelope.** `Network.enable` is called with
  `{ maxPostDataSize: 65536 }` so Chrome actually includes `postData`
  in `requestWillBeSent`.
- *Response bodies:* values preserved; field-name regex
  (`password|token|api_key|gstin|pan|…` + more) replaces values of
  credential-named keys with `"[REDACTED]"`. 8 KB cap; `responseTruncated`
  flag when hit.
- *URL query params:* param values redacted if name matches
  credential regex. Path segments untouched (needed for replay fidelity).
- *Headers:* never emitted in V1. `authorization` / `cookie` /
  `set-cookie` / `proxy-authorization` permanently excluded.
- *Filters:* type not in `{XHR, Fetch, EventSource}` → skip;
  hostname in 25-entry denylist (analytics + trackers + our backend) →
  skip; URL suffix `.js/.css/.png/…` → skip; OPTIONS preflights →
  skip. Response content-type not in `json|text|xml|javascript` →
  still emits envelope but with `responseBody: null` (metadata only).
- *Caps:* `inflightRequests` capped 500 by size + 60 s age; hard bail
  at 1000 resets with a `system` notice. `networkLog` capped 200.
- *SSE streams:* treated as "completed" at `Network.responseReceived`
  to avoid indefinite inflight pending.
- *Attach lifecycle:* sidepanel's `ensureNetworkCapture(tabId)` calls
  existing `attachDebugger` (idempotent) on bootstrap and on every
  `tab_activated`. Cleanup via existing `onDetach` handler.

### Sidepanel UI — grouped drill-down

- **Dossier strip** (sticky top) — current tab favicon/host/title
- **Chip strip** — "All" + one chip per host touched. Click a chip →
  filter the root view to that host. Click the active chip again →
  clear the filter.
- **Root view** — list of visit cards (one per (tabId, host) span,
  not per URL). Current visit marked with ember-gutter accent.
- **Visit detail** (drill-down) — list of action cards with their
  consequence counts. Clickable only if the action has consequences.
- **Action detail** (drill-down) — action row + all consequences
  inline. Flat leaf list; no further nesting.
- **Back button** (nav header) navigates one level up.
- **Jump-to-latest pill** appears when new events land while the user
  is scrolled up; doesn't steal scroll.
- **URL chip click-to-copy** — `.val` spans in event text copy to
  clipboard with a toast; `stopPropagation` prevents toggling the
  parent action.
- **In-progress pulse** — the currently-executing agent action gets
  a subtle border pulse; cleared on `agent_done` or `setRunning(false)`.
- **Typography** — Miranda Sans throughout (body, display, mono).

### What this earns us

The advisor (when Group 6 ships) will see, per session: every user
action with a visible-label description, the container it happened in
(dialog / row / form), the consequence events that followed within
1.5 s (mutations, alerts, title changes, navigations), and the exact
API calls made — with request-body *schemas* (no values) and
redacted response bodies. That's the minimum sufficient input for an
LLM to synthesize a parameterized playbook without needing to
screen-scrape DOM or re-observe a live demo.

---

## Hard rules (do not violate)

- **Never log or send credentials to the LLM.** Redact before every backend call.
- **Never persist raw CSV imports.** Ingest, encrypt, shred.
- **Never use clipboard for credential injection.** Use CDP `Input.insertText` / direct DOM writes.
- **Never hardcode credentials in playbooks.** Always reference by vault ID.
- **Never roll your own crypto.** libsodium / age / SQLCipher only.
- **Never auto-reveal passwords in UI.** Reveal requires master password re-prompt; clipboard auto-clears in 30s.
- **Never ship unsigned installers** (when the daemon ships). Windows SmartScreen and macOS Gatekeeper will block.
- **Never write UI code before writing a UX brief.** See `.claude/skills` — use the `ui-ux-design` skill for every UI change.
- **Never auto-apply playbook edits** from reflection. User reviews every suggestion.

---

## Open questions to resolve during build

- Extension icon behavior on very first install — open full-page welcome, or just inject the overlay and let users discover? Probably the former.
- Playbook storage: SQLite column (simple) or on-disk `.md` files (nicer for diffing / export). Probably SQLite for now, export as file later.
- Daemon language (when it ships): Go vs Rust. Probably Go for MVP.
- Chrome profile strategy for daemon: user's real profile vs managed copy. Lean toward managed copy.
- Playbook sharing: export/import between users → how to strip environment-specific data.
- Offline mode: playbooks need the backend for reasoning; no offline replay in this phase.
- Billing model: per-seat / per-run / per-client. Affects telemetry requirements.

---

## Competitive context (for reference)

- **Bardeen / Browse.ai / Axiom.ai** — extension or cloud, weak on unattended-with-your-real-session
- **UiPath / Automation Anywhere** — enterprise, desktop, expensive, no LLM self-healing
- **Selenium IDE** — record/replay with no reasoning; breaks on any DOM change
- **Differentiation** — LLM-driven playbook creation + self-healing + uses your real session + runs unattended + parallel at scale + character-led UX. No competitor has all of these.

---

## Resuming in a new session — quick orientation

If you're picking up work cold:

1. Read this file top to bottom — it's the latest single source of truth.
2. Check `git log --oneline -10` for what's shipped.
3. Current working branch: `copilot-capture`.
4. **Next piece of work: Group 6 — Save as playbook.** The capture
   pipeline (Phase 1–3) is shipped and produces rich structured
   traces; nothing downstream of it exists yet. Save-as-playbook is
   the first place captured data becomes user-visible value, and is
   the forcing function that will reveal any remaining capture gaps.
5. Before writing any UI code: use the `ui-ux-design` skill and produce a UX brief.
6. Backend runs via `cd backend && source .venv/bin/activate && uvicorn main:app --reload --port 8000`.
7. Extension: `chrome://extensions` → reload unpacked at `extension/`.
   After extension reload: also hard-refresh any tab you want to
   capture on (orphaned content scripts can't auto-recover from a
   reload — this is known dev-workflow friction, not a user-facing issue).
