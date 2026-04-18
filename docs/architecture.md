# PixelFoxx - Executable Architecture v1

Living implementation spec for Pixel's browser co-pilot and playbook builder.
This document should be detailed enough that two engineers can implement the
same system without inventing different core behavior.

Latest update: architecture rewritten around a session harness that compiles
user intent into a typed playbook graph during a live co-pilot session.

---

## Product in one sentence

Pixel is a browser automation co-pilot that collaborates with the user in one
shared browser session, finds the best path to the user's goal, and builds a
reusable playbook from typed blocks as it works.

## Scope of this document

This document defines:

- the runtime model for one Pixel session
- the planner laws Pixel must obey
- the typed contracts between planner, harness, and executor
- the block registry for MVP
- the evidence model used to verify progress
- the system components and their responsibilities
- the phased build plan

This document does not define:

- the final visual design language
- billing and packaging details
- unattended daemon architecture beyond the MVP seam

---

## Core decisions

### One user-facing mode

There is one user-facing mode: `co-pilot`.

- User and Pixel share the current browser tab.
- User can take over at any time.
- Pixel pauses on trusted user interaction.
- Pixel resumes by re-reading the current page state.
- There is no user-facing `record mode`, `agent mode`, or `builder mode`.

### User controls intent, Pixel controls method

Pixel must follow the user's goal and constraints, but Pixel should choose the
best implementation path.

User provides:

- desired outcome
- systems in scope
- business constraints
- approval requirements

Pixel decides:

- which path is best
- which blocks to add
- which lower-level tools to use
- how to reduce future human involvement

### Canonical artifact

The canonical saved artifact is a typed `playbook graph`.

Supporting artifacts:

- chat transcript
- browser trace and telemetry
- reflection suggestions
- rendered markdown spec

Markdown is a review and export view. It is not the sole runtime source of
truth.

### Best path over first path

A demonstrated path is evidence, not the finished playbook.

Pixel should optimize for:

1. correctness
2. unattended executability
3. robustness to site change
4. repeatability and parameterization
5. verifiability
6. speed
7. similarity to the user's demonstrated path

---

## Product principles

These principles are architecture-level laws. The harness, planner, and UI
should all reinforce them.

1. `Goal over imitation`
   Pixel should achieve the user's outcome, not replay the user's clicks.

2. `Probe before prompt`
   Pixel should inspect the site before asking the user vague questions.

3. `Ask for outcome, not clicks`
   The first question is "What should be true when this finishes?"

4. `Best path over first path`
   The first successful path is a candidate, not automatically the saved one.

5. `Human gates are debt`
   Captcha, OTP, approval, ambiguity, and manual handoff should be isolated and
   reduced where possible.

6. `Evidence beats appearance`
   Network success, download events, and state change markers outrank visual
   impressions.

7. `Reusable over brittle`
   Prefer routes and anchors that survive DOM churn.

8. `Generalize as soon as evidence allows`
   Literal values become inputs, repeated steps become loops, repeated decisions
   become branches.

9. `Do not ask for secrets in chat`
   Credentials and similar secrets must never be pasted into model-visible chat.

10. `Verified blocks only`
    A block is only promotable into the playbook graph after successful
    execution with evidence-backed verification.

---

## Planner laws

These are runtime decision rules. They belong in the planner prompt and in
server-side harness checks where applicable.

### Navigation laws

- `direct URL -> stable menu path -> site search -> exploratory clicking`
- Prefer one stable deep link over many fragile menu traversals.
- Unexpected tab, popup, iframe, or redirect requires rebuilding the page
  model before continuing.

### Session and auth laws

- `session reuse -> vault login -> manual handoff`
- Check logged-in markers before attempting login.
- Detect gates early and separate them from the business flow.
- Never ask the user to paste credentials into chat.

### Extraction laws

- `network/API -> native export/download -> DOM scraping`
- Prefer the strongest structured source available.
- For transfer workflows, complete source extraction before writing to target.

### Verification laws

- `download event / network success / state change -> toast -> screenshot impression`
- A destructive action must have an explicit verifier.
- Verification must be attached to every block.

### Recovery laws

- `same failure twice -> re-probe or re-plan`
- If a step does two jobs, split it into two blocks.
- Low confidence plus high risk must escalate to the user.

### Generalization laws

- `parameterize on second occurrence`
- `prove single-item path before batch`
- `persist structured result before narrative summary`

---

## Prompt stack

Pixel's prompt must include personality, not only task laws.

Personality is part of product behavior because it determines:

- whether Pixel feels collaborative or robotic
- whether questions are calm and specific or vague and noisy
- whether Pixel sounds trustworthy during blockers and handoffs
- whether users feel like Pixel is building the playbook with them

### Prompt layers

Every planner or executor prompt should contain these layers in order:

1. `identity and personality`
   Pixel is warm, calm, collaborative, honest about uncertainty, and concise.

2. `collaboration contract`
   User controls intent and constraints. Pixel controls method. Pixel should
   co-author the playbook with the user, not merely execute clicks.

3. `planner laws`
   Navigation, extraction, verification, recovery, and generalization laws from
   this document.

4. `typed output contract`
   The model must emit the required structured decision or action envelope.

5. `session context`
   IntentSpec, SiteModel, open gates, latest verified block, candidate paths,
   automation grade, and recent user message.

### Pixel personality requirements

Prompt language should make Pixel behave like:

- a supportive teammate, not an impersonal recorder
- outcome-driven, not click-driven
- willing to choose a better path than the user's demonstrated path
- explicit about why it is asking a question
- careful not to ask for secrets in chat

### Ask-user style

When Pixel needs user input, the prompt should enforce:

- ask one focused question at a time
- explain briefly why the answer matters
- say what Pixel will do next with the answer
- avoid asking the user to narrate UI details Pixel can discover by probing
- prefer clarifying business intent over asking about click mechanics

The desired feel is:

`"I think the cleanest next reusable step is to search the client by GSTIN. If you want, I can treat GSTIN as the main input for this playbook."`

not:

`"What do I click next?"`

---

## User experience model

### Sidepanel structure

The Chrome sidepanel remains the primary surface.

Required regions:

- `intent bar`
  Current goal, archetype, and automation grade.
- `chat thread`
  Pixel conversation with the user.
- `playbook canvas`
  Live ordered block graph under construction.
- `context rail`
  Current site, page, auth state, gate state, confidence, and evidence summary.

### Default co-pilot loop

1. User states desired outcome.
2. Pixel infers an internal intent archetype and candidate systems.
3. Pixel probes the current site or opens the likely site.
4. Pixel proposes the next typed block.
5. Harness checks preconditions and risk.
6. Executor runs the block through lower-level tools.
7. Harness gathers evidence and verifies the result.
8. Verified block is committed to the draft graph.
9. Pixel either continues or asks the user only if a real gate exists.

---

## Intent model

### Intent archetypes

Archetypes are internal planning families, not user-facing modes.

1. `observe`
   Primary effect: read from one or more systems and save elsewhere.

2. `operate`
   Primary effect: complete a state change inside one system.

3. `transfer`
   Primary effect: read from source system and write into target system.

4. `reconcile`
   Primary effect: compare states and surface or repair mismatches.

5. `triage`
   Primary effect: review queued items and produce decisions.

### Intent modifiers

Modifiers are orthogonal traits that may apply to any archetype.

- `batch`
- `scheduled`
- `needs_auth`
- `has_human_gate`
- `destructive`
- `approval_required`
- `retryable`
- `parallelizable`
- `download_output`
- `upload_input`

### IntentSpec contract

`IntentSpec` is the normalized session goal object produced from chat plus
early probing.

```json
{
  "outcome": "Download GSTR-2A for a client",
  "archetype": "operate",
  "systems": [
    {
      "role": "primary",
      "host": "services.gst.gov.in",
      "route_hint": "/services/login"
    }
  ],
  "entities": ["client", "period"],
  "inputs": [
    {"name": "gstin", "required": true, "secret": false},
    {"name": "period", "required": true, "secret": false}
  ],
  "modifiers": ["needs_auth", "download_output"],
  "done_when": [
    "download event observed",
    "file size > 1KB"
  ],
  "constraints": [],
  "risk_level": "low"
}
```

Required fields:

- `outcome`
- `archetype`
- `systems`
- `entities`
- `inputs`
- `modifiers`
- `done_when`
- `risk_level`

---

## Session harness

### Purpose

The session harness is the deterministic shell around the model. Pixel reasons,
but the harness owns structure, policy, validation, evidence, and persistence.

### SessionHarness object

```json
{
  "session_id": "sess_123",
  "status": "probing",
  "intent_spec": {},
  "site_models": [],
  "draft_block_graph": [],
  "candidate_paths": [],
  "selected_path_id": null,
  "evidence_ledger": [],
  "gate_state": [],
  "automation_grade": "attended",
  "transcript_ref": "chat_123",
  "trace_ref": "trace_123",
  "last_decision": null,
  "created_at": "2026-04-17T10:00:00Z",
  "updated_at": "2026-04-17T10:00:00Z"
}
```

`draft_block_graph` may contain:

- `proposed` blocks waiting to execute
- `verified` blocks ready to save
- `rejected` blocks preserved only for audit and path comparison

### Harness-owned sub-objects

1. `SiteModel`
   Session-scoped model of the current website or websites.

2. `DraftBlockGraph`
   Ordered graph of verified and pending blocks.

3. `CandidatePath`
   Competing approaches Pixel has discovered for the same goal.

4. `EvidenceLedger`
   Strongest observed evidence across network, DOM, downloads, dialogs, and
   user interventions.

5. `GateState`
   Explicit list of auth, captcha, OTP, approval, ambiguity, and handoff gates.

### What Pixel owns

Pixel owns:

- intent interpretation
- site hypothesis
- next block proposal
- user-facing explanation
- recovery hypotheses

The harness owns:

- schema validation
- policy enforcement
- block lifecycle orchestration
- evidence collection and ranking
- gate handling
- persistence

---

## Session state machine

Every live session must move through explicit states.

### Session states

1. `idle`
   No active intent yet.

2. `intent_binding`
   User outcome is being normalized into `IntentSpec`.

3. `probing`
   Pixel is inspecting the site and building or refreshing `SiteModel`.

4. `planning`
   Pixel is proposing the next block or candidate path.

5. `gated`
   A human gate or policy gate is blocking execution.

6. `executing`
   Harness is running the current block.

7. `verifying`
   Harness is evaluating evidence for the current block.

8. `generalizing`
   Harness and planner are parameterizing and refining the draft graph.

9. `ready_to_save`
   Goal satisfied and draft graph coherent.

10. `completed`
    Playbook saved or session intentionally ended without save.

11. `failed`
    Session cannot continue without major intervention.

### Allowed transitions

- `idle -> intent_binding`
- `intent_binding -> probing`
- `probing -> planning`
- `planning -> gated`
- `planning -> executing`
- `gated -> probing`
- `gated -> planning`
- `executing -> verifying`
- `verifying -> planning`
- `verifying -> generalizing`
- `generalizing -> planning`
- `generalizing -> ready_to_save`
- `ready_to_save -> completed`
- `any active state -> failed`

### Transition rules

- Trusted user action during `executing` pauses the block and returns the
  session to `probing`.
- New page, popup, iframe, or tab that changes the interaction surface returns
  the session to `probing`.
- Repeated block failure returns the session to `planning`, not blind retry.

---

## NextTurnDecision contract

Pixel must not return free-form plans to the harness. Pixel must return a typed
decision object.

```json
{
  "message_to_user": "I found the GST login page. I can try session reuse first.",
  "decision_type": "propose_block",
  "proposed_block": {
    "type": "EnsureSession",
    "title": "Reuse session or log in",
    "intent": "Reach an authenticated session without user credentials in chat",
    "inputs": [],
    "preconditions": ["login wall detected"],
    "success_verifier": "authenticated cookie or dashboard marker",
    "failure_policy": "ask_user_or_handoff",
    "requires_human_gate": false
  },
  "candidate_path_updates": [],
  "risk": "low",
  "confidence": 0.87
}
```

Allowed `decision_type` values for MVP:

- `propose_block`
- `ask_user`
- `replan`
- `mark_done`
- `mark_failed`

The harness must reject malformed decisions.

---

## Block registry

### Design rule

Blocks must be mutually exclusive in responsibility and collectively sufficient
for browser workflows.

The block list below is a taxonomy, not a required runtime sequence and not the
same thing as development slice order. In a live session, Pixel may go
`SiteProbe -> Navigate`, `SiteProbe -> EnsureSession`, or `SiteProbe ->
ClearGate` depending on what the current page actually is.

### MVP block types

1. `SiteProbe`
   Fingerprint host, page type, auth wall, forms, tables, downloads, API
   candidates, popups, and likely next actions.

2. `EnsureSession`
   Reuse session if possible, else establish authenticated session without
   exposing secrets to the model.

3. `ClearGate`
   Handle captcha, OTP, consent modal, Cloudflare, or explicit approval gate.

4. `Navigate`
   Move to a page, route, tab, popup, iframe, or deep link.

5. `Extract`
   Read structured information from the strongest available source.

6. `Transform`
   Normalize, map, derive, validate, or dedupe extracted data.

7. `FillOrUpload`
   Populate fields, set filters, upload files, or enter values.

8. `SubmitOrTrigger`
   Trigger a state-changing action such as submit, search, generate, approve,
   or download.

9. `Verify`
   Verify outcome through evidence.

10. `LoopOrBranch`
    Iterate or choose path based on conditions or evidence.

11. `AskUserOrHandoff`
    Request missing information, approval, or manual takeover.

12. `Persist`
    Write structured outputs to sheet, db, webhook, file, or internal artifact.

13. `Finish`
    Emit the final session outcome and mark the graph complete.

### Mutual exclusivity rules

- `SiteProbe` is read-only and never mutates page state.
- `EnsureSession` owns session reuse and login but not captcha solving beyond
  detecting the gate.
- `ClearGate` removes blockers but does not continue business flow afterward.
- `Navigate` changes location but does not fill forms or verify success.
- `Extract` reads but does not decide or write.
- `Transform` changes data representation, not browser state.
- `FillOrUpload` writes fields or uploads, but does not submit.
- `SubmitOrTrigger` commits an action, but does not own verification.
- `Verify` judges outcome but does not self-repair.
- `LoopOrBranch` owns control flow, not leaf work.
- `AskUserOrHandoff` owns human involvement explicitly.
- `Persist` writes output but does not narrate completion.
- `Finish` packages final result but does not explore.

### Block contract

Every block must conform to this shape:

```json
{
  "block_id": "blk_07",
  "type": "Verify",
  "title": "Confirm GSTR-2A download",
  "intent": "Make sure the export finished successfully",
  "inputs": {
    "expected_file_pattern": "gstr-2a-{{gstin}}-{{period}}.zip"
  },
  "outputs": {},
  "preconditions": ["download triggered"],
  "success_verifier": "download event observed and file size > 1KB",
  "failure_policy": "reprobe_then_replan",
  "destructive": false,
  "requires_human_gate": false
}
```

Required fields:

- `block_id`
- `type`
- `title`
- `intent`
- `inputs`
- `outputs`
- `preconditions`
- `success_verifier`
- `failure_policy`
- `destructive`
- `requires_human_gate`

### Block result contract

Every block execution must emit a typed result:

```json
{
  "block_id": "blk_07",
  "result": "success",
  "evidence": ["download_event:dl_123", "file_size:42013"],
  "confidence": 0.94,
  "verifier": "download event observed and file size > 1KB",
  "next_hint": "finish",
  "artifacts": []
}
```

Allowed `result` values:

- `success`
- `failure`
- `gated`
- `ambiguous`
- `handoff`

---

## Block lifecycle

Every block follows the same lifecycle:

1. `probe`
   Confirm preconditions and refresh page context.

2. `prepare`
   Resolve inputs, secrets, and execution strategy.

3. `execute`
   Run lower-level tool primitives.

4. `observe`
   Collect resulting telemetry and page changes.

5. `verify`
   Rank evidence and decide outcome.

6. `commit`
   If successful, update graph and artifacts.

7. `fallback`
   If not successful, enter gate, re-probe, or re-plan.

Harness invariants:

- a block may not skip `verify`
- a block may not be committed without evidence
- a destructive block may not execute without a verifier
- a gated block may not silently continue

---

## Evidence model

### Evidence types

MVP evidence sources:

- `network_response`
- `download_event`
- `page_state_change`
- `dialog_event`
- `form_validation`
- `visible_text`
- `table_extract`
- `link_extract`
- `user_intervention`
- `tab_change`
- `file_artifact`

### EvidenceLedger record

```json
{
  "evidence_id": "ev_123",
  "type": "download_event",
  "source": "background",
  "tab_id": 321,
  "ts": "2026-04-17T10:00:00Z",
  "summary": "Downloaded gstr-2a-29ABCDE1234F2Z5-202503.zip",
  "confidence": 0.97,
  "payload_ref": "trace:download:123"
}
```

### Evidence ranking

Use this default ranking order:

1. `network_response`
2. `download_event`
3. `page_state_change`
4. `form_validation`
5. `table_extract`
6. `visible_text`
7. `dialog_event`
8. `screenshot-only interpretation`

Rules:

- prefer multiple weaker signals only when stronger evidence is unavailable
- screenshot-only reasoning is never sufficient for destructive verification
- verification should cite concrete evidence ids

---

## Site model

`SiteModel` is the planner's structured understanding of the current site.

```json
{
  "host": "services.gst.gov.in",
  "route": "/services/login",
  "product_name": "GST Portal",
  "page_type": "login",
  "auth_state": "logged_out",
  "gates": ["captcha"],
  "available_regions": ["login_form"],
  "stable_anchors": ["Username", "Password", "Login"],
  "api_candidates": [],
  "success_markers": ["dashboard heading"],
  "risk_markers": []
}
```

Required concerns:

- host and route identity
- page type
- auth state
- gates
- stable anchors
- structured data opportunities
- success markers
- risk markers

`SiteProbe` is responsible for refreshing this object whenever context changes.

---

## Candidate paths and automation fitness

### Why candidate paths exist

The first path Pixel discovers is not necessarily the best automation path.
The harness should preserve alternative approaches when discovered.

### CandidatePath contract

```json
{
  "path_id": "path_02",
  "label": "Deep link plus native download",
  "source": "pixel_inference",
  "steps": ["navigate", "ensure_session", "navigate", "submit_or_trigger", "verify"],
  "advantages": ["fewer menus", "native download", "strong verifier"],
  "disadvantages": ["requires existing session"],
  "score": 0.84
}
```

### Path scoring

Score each candidate path on:

- correctness
- unattended executability
- robustness
- repeatability
- verifiability
- speed

Do not include "looks like what the user did" as a major factor.

### Automation grade

Every session and saved playbook should carry an automation grade:

- `attended`
- `mostly_attended`
- `mostly_unattended`
- `unattended`

Upgrade criteria:

- fewer human gates
- stronger verifiers
- more stable anchors
- less reliance on brittle click paths
- successful dry run on parameterized inputs

---

## Tool primitive layer

The existing executor tool primitives remain the implementation layer.

MVP primitives:

- navigate
- click
- focus_and_type
- type
- select
- key
- key_combo
- scroll
- new_tab
- switch_tab
- close_tab
- scrape_page
- scrape_table
- scrape_links
- scrape_metadata
- scrape_network
- screenshot
- dismiss_popup
- click_captcha
- stealth_solve
- ask_user

Block-to-tool mapping is many-to-many:

- `SiteProbe` uses scrape and page inspection tools
- `EnsureSession` uses navigate, detect markers, focus_and_type, and submit
- `ClearGate` uses captcha, popup, ask_user, and handoff controls
- `Verify` uses download events, network capture, and state markers

The playbook graph must store blocks, not raw primitives.

---

## Security and secret handling

### Critical rule

Raw credentials must never be visible to the model.

### Secret handling rules

- secrets must be redacted before any model call
- secret substitution happens only at execution time
- credentials must be selected from vault or entered during explicit handoff
- chat transcript must never contain secret values
- cookies and session reuse should be preferred before login

### Human gate rules

Human involvement is permitted only for:

- secrets
- OTP and recovery codes
- hard captcha or anti-bot walls
- destructive approvals
- unresolved ambiguity

Every human gate must create a `GateState` record.

---

## Data model

### Tables or persisted objects

MVP persistence should include:

1. `builder_sessions`
2. `session_messages`
3. `session_site_models`
4. `session_blocks`
5. `session_evidence`
6. `session_candidate_paths`
7. `playbooks`
8. `playbook_blocks`
9. `playbook_runs`
10. `playbook_run_blocks`
11. `playbook_reflections`

### Builder session record

```json
{
  "id": "sess_123",
  "user_sub": "user_123",
  "status": "planning",
  "intent_spec_json": {},
  "automation_grade": "mostly_attended",
  "selected_path_id": "path_02",
  "created_at": "2026-04-17T10:00:00Z",
  "updated_at": "2026-04-17T10:05:00Z"
}
```

### Playbook record

```json
{
  "id": "pb_123",
  "title": "Download GSTR-2A",
  "intent_spec_json": {},
  "automation_grade": "mostly_unattended",
  "status": "active",
  "last_verified_at": null,
  "markdown_render": "# Download GSTR-2A\\n..."
}
```

### Playbook block record

Persist each block with:

- `playbook_id`
- `block_id`
- `order_index`
- `type`
- `config_json`
- `success_verifier`
- `failure_policy`
- `destructive`
- `requires_human_gate`

---

## System components

### 1. Sidepanel

Responsibilities:

- render chat thread
- render live block graph
- display session status, automation grade, and gate state
- collect user messages and approvals
- show save and rerun actions

Must not own:

- block verification logic
- secret storage
- canonical graph persistence rules

### 2. Background service worker

Responsibilities:

- unify browser events into envelopes
- maintain tab and window context
- route tab changes, dialogs, downloads, and other browser-level signals
- coordinate capture bootstrap

Must expose:

- current active tab context
- event stream for the session harness
- gate-relevant browser signals

### 3. Content capture layer

Responsibilities:

- collect visible labels and element context
- detect forms, dialogs, alerts, page changes, and user interventions
- feed evidence and page-model inputs

### 4. Executor

Responsibilities:

- execute low-level tool primitives
- provide action results to the harness
- never bypass block lifecycle

### 5. Planner

Responsibilities:

- convert current session state into `NextTurnDecision`
- choose next block or ask user
- infer better candidate paths
- explain reasoning tersely to the user

### 6. Session harness

Responsibilities:

- validate decisions and blocks
- manage state machine
- orchestrate block lifecycle
- gather evidence and compute verification
- persist session artifacts

### 7. Storage

Responsibilities:

- persist builder sessions, playbooks, blocks, evidence, and reflections
- render markdown from saved graph

---

## API and internal contracts

These contracts should be implemented even if endpoint names change.

### Session APIs

- `POST /sessions`
  Create builder session from first user prompt.

- `GET /sessions/{id}`
  Return full harness state.

- `POST /sessions/{id}/message`
  Append user message and request next `NextTurnDecision`.

- `POST /sessions/{id}/continue`
  Continue after gate resolution or user handoff.

- `POST /sessions/{id}/save`
  Persist session graph as playbook.

### Block APIs

- `POST /sessions/{id}/blocks/{block_id}/execute`
  Execute one block through the harness.

- `POST /sessions/{id}/blocks/{block_id}/verify`
  Re-run verification if needed.

### Playbook APIs

- `GET /playbooks`
- `GET /playbooks/{id}`
- `POST /playbooks/{id}/run`
- `POST /playbooks/{id}/reflect`

### Internal message contracts

The sidepanel must communicate:

- user messages
- approvals and handoff events
- active tab context
- run-state toggles

The background must communicate:

- unified browser envelopes
- tab activation
- dialogs, downloads, and relevant navigation events

---

## Session algorithm

This is the canonical per-turn algorithm.

1. Normalize latest user message into or against `IntentSpec`.
2. Refresh active `SiteModel` from browser evidence.
3. If gate is open, resolve gate before normal planning.
4. Ask planner for `NextTurnDecision`.
5. Validate decision against schema and planner laws.
6. If `decision_type = ask_user`, emit question and stop.
7. If `decision_type = propose_block`, validate block contract.
8. Run block lifecycle through executor and evidence collector.
9. Produce `BlockResult`.
10. If verified success, commit block to draft graph.
11. If repeated literals or patterns exist, generalize into inputs, loops, or
    branches.
12. Recompute candidate path scores and automation grade.
13. If `IntentSpec.done_when` is satisfied and graph is coherent, enter
    `ready_to_save`.
14. Save only when user confirms or when auto-save policy explicitly allows it.

---

## Mapping to the current codebase

The current implementation already has several pieces needed for MVP.

### Keep and reuse

- `extension/background.js`
  Event hub, tab context, and message routing.

- `extension/capture.js`
  Visible labels, form validation, dialog detection, and page interaction
  signals.

- `extension/actions.js`
  Executor primitives and CDP-assisted browser control.

- `backend/main.py`
  Existing planner/executor integration point and API shell.

- auth and usage tracking
  Operational infrastructure remains valid.

### Add next

1. session harness module in backend
2. typed schemas for `IntentSpec`, `NextTurnDecision`, `Block`, and
   `BlockResult`
3. builder session persistence
4. sidepanel block canvas and session state rendering
5. evidence ranking and verification service
6. candidate path scoring and automation grade service

### De-emphasize

- trace-first "save as playbook" as the primary authoring flow
- markdown-only runtime representation
- end-of-session synthesis as the only way to create playbooks

---

## Development style

The preferred development style for this project is `small, testable, visible
blocks`.

Do not build Pixel as one large planner integration that only becomes visible
at the end. Build it as a sequence of thin vertical slices where each slice is
demoable in the sidepanel and testable in isolation.

### Development rules

1. `One slice, one visible capability`
   Each slice should introduce exactly one user-visible capability or one
   block-level runtime capability.

2. `Every slice must be demoable`
   A slice is not done unless we can run it in a real browser session or a
   deterministic fixture and watch the result.

3. `Every block gets its own harness test`
   Blocks should be executable and verifiable independently of the full
   end-to-end planner.

4. `Prefer deterministic fixtures before live-site complexity`
   Before depending on a real website, use recorded or synthetic fixtures for
   schemas, decisions, block execution, and verification.

5. `Stub the planner before making it smart`
   A hardcoded or semi-scripted `NextTurnDecision` is acceptable if it proves
   the block lifecycle, evidence model, and UI flow.

6. `Wire before optimize`
   First prove the block contract, session transitions, and evidence flow. Then
   improve planner quality and automation fitness.

7. `No hidden magic`
   Each slice should expose its inputs, outputs, evidence, and state changes in
   the sidepanel or logs.

8. `Prove the first visible browser movement early`
   After the first read-only inspection slice works, the next validation slice
   should make Pixel do one visible thing in the browser before deeper auth or
   workflow complexity is added.

### Minimum test surface per slice

Each slice should ideally include all three:

- `schema test`
  Validate JSON shape and required fields.
- `harness integration test`
  Run one block or one state transition through the harness.
- `manual demo path`
  Show the capability in the sidepanel against a live page or stable fixture.

### Preferred implementation order

Build from the inside out:

1. typed contracts
2. block lifecycle runner
3. evidence collection and verification
4. sidepanel visibility
5. planner intelligence

This keeps the system inspectable while it is still small.

---

## MVP build sequence

These slices are in development order, optimized for small testable increments.
They are not a promise that every live session will execute blocks in this same
order.

### Slice 0 - Typed contracts only

- define typed schemas for `IntentSpec`, `SiteModel`, `NextTurnDecision`,
  `Block`, `BlockResult`, `CandidatePath`, and `EvidenceRecord`

Exit criteria:

- invalid session objects and block results are rejected deterministically
- we can create and inspect sample payloads for every core contract

### Slice 1 - Harness skeleton

- implement session state machine
- implement builder session persistence
- add harness orchestration endpoint
- support a hardcoded `NextTurnDecision`

Exit criteria:

- one session can move from first prompt to one hardcoded proposed block
- the sidepanel can render session state from persisted harness data

### Slice 2 - Block lifecycle runner

- implement `probe -> prepare -> execute -> observe -> verify -> commit`
- support one non-destructive block type end-to-end, preferably `SiteProbe`
- store `BlockResult` and evidence references

Exit criteria:

- a single block can run end-to-end through the harness with visible evidence
- the block is committed only on verification success

### Slice 3 - Builder sidepanel

- replace timeline-first primary view with session-first builder view
- show intent, current state, live block list, gates, and evidence summary
- show `proposed`, `verified`, and `rejected` blocks distinctly

Exit criteria:

- user can watch blocks being proposed, executed, verified, and committed

### Slice 4 - SiteProbe and verification

- implement `SiteProbe`
- implement `SiteModel` refresh from current browser evidence
- connect basic evidence ranking for non-destructive verification

Exit criteria:

- Pixel can inspect a page and produce a verified `SiteProbe` block result
- page type, auth state, gates, and stable anchors are visible in the UI

### Slice 5 - Navigate or search

- implement the first action-taking block after `SiteProbe`
- prefer `Navigate` when a direct route is known, otherwise use the current
  page's native search or entry surface
- verify page transition using URL, page type, title, and stable anchors

Exit criteria:

- from the sidepanel, Pixel can visibly move the browser one step toward the
  user's goal
- the action is represented as a typed block and verified with evidence

### Slice 6 - EnsureSession and ClearGate

- implement `EnsureSession`
- implement `ClearGate`
- support manual handoff, captcha, and login wall handling

Exit criteria:

- Pixel can reuse session or escalate explicitly through gate state
- gates are visible, resumable, and not treated as ordinary failure

### Slice 7 - Extract first

- implement `Extract`
- connect extraction precedence: `network/API -> native export/download -> DOM`
- support at least one verified extraction path from live evidence

Exit criteria:

- Pixel can produce a verified extracted artifact with evidence ids
- extraction source is explicit in the block result

### Slice 8 - Fill, trigger, verify

- implement `FillOrUpload`, `SubmitOrTrigger`, and `Verify`
- enforce destructive-action verification rules
- support one simple `operate` workflow end-to-end

Exit criteria:

- Pixel can complete and verify a single-system task through typed blocks
- destructive actions cannot commit without verifier evidence

### Slice 9 - Generalization and saving

- parameterize repeated literals
- introduce loops and branches
- save playbook graph and render markdown

Exit criteria:

- a successful session becomes a replayable playbook with explicit inputs and
  verifiers

### Slice 10 - Collaborative clarification and parameter binding

- implement real `ask_user` decisions in the builder harness
- bind user answers into `IntentSpec` before replanning
- support at least:
  - system binding questions
  - primary input naming questions
- carry those answers forward into the saved playbook

Exit criteria:

- Pixel can stop to ask one focused question that materially changes the plan
- the next decision reflects the user's answer
- named inputs show up in the saved playbook instead of being lost in chat

### Slice 11 - Candidate paths and automation fitness

- add candidate path scoring
- compute automation grade
- reflect on human gates and brittleness

Exit criteria:

- playbooks are scored and improved for unattended execution, not just success

### Slice 12 - Transfer path

- implement `Transform` and `Persist`
- support one `transfer` workflow from source extraction to target write or
  output persistence

Exit criteria:

- Pixel can complete one cross-system flow with explicit source, mapping, and
  target blocks

---

## MVP capability boundary

At the end of these slices, Pixel should be able to build and replay playbooks
for a broad class of browser automation tasks across the main archetypes:
`observe`, `operate`, `transfer`, `reconcile`, and `triage`.

That does not mean "any possible browser activity" with zero exceptions. The
MVP target is:

- reliable browser workflows on ordinary web apps, portals, queues, forms,
  tables, exports, uploads, and cross-system handoffs
- playbooks that optimize for unattended execution where the site allows it
- explicit human gates when the site or policy makes unattended execution
  impossible or unsafe

The MVP is not a promise of full autonomy for:

- hard anti-bot surfaces that cannot be cleared safely or legally
- flows that depend on hardware tokens, device-bound auth, or out-of-band human
  judgment
- highly visual canvas-only interfaces with no stable semantic hooks
- arbitrary consumer browsing where the goal cannot be parameterized or
  verified

So the right product claim is:

Pixel should be able to build reusable playbooks for a large share of practical
browser automation work, and the harness should make unsupported or gated cases
explicit instead of pretending they are fully automatable.

---

## Non-negotiable rules

- never ask the user to paste credentials into chat
- never commit a block without verification
- never treat captcha or OTP as ordinary failure
- never persist secrets in model-visible logs or transcripts
- never save the observed path as final without evaluating better candidate
  paths
- never use screenshot-only reasoning as the sole verifier for destructive work

---

## Success criteria for this architecture

The architecture is successful when:

- one session can move from user outcome to verified draft graph
- the planner emits typed decisions instead of ad hoc prose
- every block has preconditions, verifier, and failure policy
- verification cites evidence, not intuition
- human gates are explicit and localized
- saved playbooks represent the best discovered automation path, not merely the
  user's demonstrated path

---

## The key sentence

Pixel is not a recorder. Pixel is a session harnessed co-pilot that compiles
user intent into a typed, evidence-backed, automation-grade playbook graph.
