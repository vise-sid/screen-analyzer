# Pixel — Architecture Spec (pixel-in-the-wild)

## Vision in one paragraph

A small, immutable agent core (~500-char system prompt + ~10 primitive tools) that delegates **everything domain-specific** to skills (markdown + scripts) the model auto-discovers via Anthropic's native Skills API. The model writes Python in a sandboxed code-execution container that calls our browser and workspace primitives programmatically; intermediate snapshots and scrape outputs never bloat the model's context. Behavioral tuning happens by editing skill files, not by editing the prompt or the agent code.

## Why this shape

- **Slop is a structural problem, not a prompting problem.** Every prior iteration tried to fix bad behavior by adding more rules to the prompt. The result was a 24k-character prompt that the model still ignored. Skills move that knowledge out of the prompt and into discoverable, on-demand documentation.
- **Context bloat compounds.** Snapshots, screenshots, and scrape outputs were accumulating across turns. Programmatic tool calling keeps all of that inside the sandbox; only the summary returns.
- **Replaying a prose playbook is not deterministic.** A "playbook" today is the model re-reasoning each step; tomorrow it should be a Python script the model wrote once and the user can read. We're laying foundations for that.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Agent model | Claude Sonnet 4.6 | Strongest tool-use, native Skills, prompt caching |
| Vision helper | Gemini Flash 3 | ~10× cheaper than Sonnet for image classification; captcha + screenshot describe |
| Execution | `code_execution_20260120` (programmatic tool calling) | Browser/workspace primitives callable from inside agent's Python; intermediate results don't enter context |
| Skill system | Anthropic Agent Skills API (`skills-2025-10-02` beta) | Native progressive disclosure, no roll-our-own loader |
| Backend | FastAPI (Python 3.12) | Existing infra |
| UI surface | Chrome MV3 extension (sidepanel) | Existing user touchpoint; Tauri later |

Compatibility of `code_execution_20260120` + `skills-2025-10-02` was verified in a smoke test (Apr 19) — both can be enabled in the same request with Sonnet 4.6.

## The core

### System prompt (~500 chars, frozen)

```
You are Pixel Foxx, an autonomous browser-automation agent.

You work by calling tools and reading skills. The skills folder
contains markdown files (with optional Python helpers) that teach
you HOW and WHEN to use the tools for specific situations.

Every turn pairs a one-line `chat` narration with a concrete tool
call. Run plans to completion — pause only for: plan-level approval,
a destructive action, a genuine pathway fork, or the final report.
```

### Primitive tools (~13 total)

**Programmatic-callable** (`allowed_callers: ["code_execution_20260120"]`) — agent calls these from inside its Python code; intermediate results stay in the sandbox:

| Tool | Purpose |
|---|---|
| `observe(include=[...])` | Consolidated probe: snapshot + screenshot + network. One tool replaces probe_site + screenshot + scrape_* |
| `navigate(url)` | Navigate active tab |
| `click(ref)` | Click by accessibility ref |
| `type(ref, text, submit?)` | Focus + type, optional Enter |
| `key(key)` | Single key press |
| `scroll(deltaY)` | Vertical scroll |
| `workspace(api, args)` | Dispatcher for Google Sheets / Docs / Slides operations |
| `reauth_google()` | Force re-auth on workspace OAuth failures |
| `vision(task, image, prompt?)` | Hand off to Gemini Flash for image-only tasks (captcha, classification) |

**Direct-only** (no `allowed_callers` — must be called by the model itself, not from code):

| Tool | Purpose |
|---|---|
| `chat(message)` | One-line progress narration. Always paired with another tool. |
| `set_plan(steps[])` | Declare or replace the plan |
| `request_approval(scope, reason?)` | scope=`plan` (one-time, after set_plan) or scope=`todo` (destructive only, with whitelisted reason) |
| `clarify(question, why, options[≥2])` | Pathway fork only — never for confirmation |
| `done(step_id, summary)` | Mark a step complete; immediately start the next |
| `report(summary, artifacts, save_playbook?, ...)` | Terminal — final session summary |

That's it. No `mark_todo_done`, `update_todo`, `ask_advisor`, `store`, `recall`, `wait`, `dismiss_*`, `click_captcha`, `stealth_solve`, `scrape_*` (×6), `sheets_create`, `sheets_write`, `sheets_read`, `docs_*`, `slides_*`. All of those are patterns described in skills, executed via the primitives.

## Skills

Each skill is a folder uploaded to Anthropic's Skills API and referenced by `skill_id` in the request `container`.

```
backend/skills/<gerund-name>/
  SKILL.md          # frontmatter (name, description) + body
  helpers.py        # optional async functions the agent imports + calls
```

### Initial skill set (8)

| Name | Freedom | Purpose |
|---|---|---|
| `browser-research` | HIGH | Observe-first patterns, network-scrape preference ladder |
| `logging-to-sheets` | LOW | Concrete `log_row_to_sheet(title, headers, row)` helper + verify-by-reread + auth recovery |
| `writing-to-docs` | MEDIUM | Doc create/append patterns |
| `verifying-page-state` | MEDIUM | Visual verify + textual verify decision rules |
| `recovering-from-errors` | MEDIUM | Try ≥2 alternatives before surfacing; intelligent retry vs. arg-change |
| `gating-destructive-actions` | LOW | The destructive whitelist + scope=todo gate |
| `clarifying-pathway-forks` | HIGH | When to call `clarify` (real fork) vs not (confirmation) |
| `authoring-playbook-report` | MEDIUM | `report()` structure, when `save_playbook=true` |

### Skill authoring rules (from Anthropic best-practices doc)

- Names in **gerund form**, lowercase + hyphens, ≤64 chars.
- Descriptions in **third person**, include both **what** and **when**, ≤1024 chars.
- SKILL.md body ≤500 lines; split into reference files if longer.
- References go **one level deep** from SKILL.md (Claude uses `head -100` previews on nested refs).
- **Concise by default** — assume the model knows Python, HTTP, OAuth basics. Only add what it doesn't know.
- **No time-sensitive info** ("after August 2025…"). Use "Current method" + "Old patterns" sections instead.
- **Helpers solve, don't punt** — handle errors in the helper, don't push them back to the model.
- **Forward slashes only** in paths.
- **No network access in the container** — all I/O goes through our primitive tools, no `import requests`.

### Skill management workflow

- `backend/skills/_registry.json` — committed map of skill_name → skill_id (per environment).
- `scripts/upload_skills.py` — CLI: scans `backend/skills/`, zips each folder, calls `client.beta.skills.create` (first time) or `versions.create` (updates), updates registry.
- Dev uses `version: "latest"`. Prod pins to specific versions from the registry.

## Vision helper

Gemini Flash 3 sits behind a small FastAPI endpoint (`backend/vision_helper/`):

| Endpoint | Purpose |
|---|---|
| `POST /vision/captcha` | Image → captcha answer |
| `POST /vision/describe` | Image + prompt → text description |
| `POST /vision/extract_form` | Image → field map |

The Sonnet agent calls these via the `vision()` primitive when it needs image-only inference. Cheaper and faster than burning Sonnet tokens on classification.

## UI surface (extension)

Chrome MV3 extension. Sidepanel rebuilt against `pixelfoxx_ui_design_system/`. Responsibilities:

- Sign-in (Google ID token → backend) — kept from old design.
- Chat thread + action bubbles + plan strip + approval/clarify/report cards.
- CDP-based browser action execution — sends results back to backend as `tool_result` blocks for the running container.
- `key.pem` is preserved so the extension ID is stable for OAuth.

The extension is a **dispatcher**, not an agent. All decisions live in the backend.

## Evaluation-driven development

For each new skill:

1. Write 3 representative scenarios + expected behaviors → `evals/<skill_name>.jsonl`.
2. Measure baseline (skill not loaded) — Claude does whatever it does.
3. Author the skill, upload, measure with skill loaded.
4. Iterate skill content until evals pass.
5. Re-run all skill evals on every skill or core change (regression guard).

## Build order

1. Backend skeleton — FastAPI + Anthropic SDK + minimal agent loop. Stub tools (return mock data) so the loop runs end-to-end without browser/workspace.
2. Skill upload script + registry.
3. First skill (`logging-to-sheets`) end-to-end with a real Google Sheets call. Proves the upload → discover → execute → verify cycle.
4. Real browser primitives wired through the extension's CDP path.
5. Remaining 7 skills, evals first.
6. Vision helper.
7. Cut the extension UI over to `pixelfoxx_ui_design_system` styles.

## Non-goals (for this branch)

- Tauri desktop app — separate later branch.
- OpenRouter multi-model — direct Anthropic SDK only.
- Triggered/scheduled playbook runs — needs daemon, deferred.
- Self-modifying skills — manual edits + upload only.
- Self-heal during deterministic replay — there is no deterministic replay yet; everything still goes through the agent loop.
