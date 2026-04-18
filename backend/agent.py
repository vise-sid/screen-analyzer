"""
PixelFoxx agent loop.

One function-calling loop built on Gemini. The agent has:
  - conversational tools (chat, clarify, set_todo_plan, request_approval,
    update_todo, mark_todo_done, save_playbook, ask_advisor, store, recall, wait)
  - browser tools that the extension executes (navigate, click, scroll, scrape_*,
    screenshot, dismiss_popup, ensure_session, sheets_*, docs_*, slides_*, ...)

Each POST /sessions/{id}/agent/step:
  1. Append the inbound user message or action-result block to `session.gemini_contents`.
  2. Run the Gemini tool loop. Conversational tool calls are handled in-process
     and looped again. The first browser tool call (or the first plain-text reply
     with no more tool calls) ends the loop.
  3. Persist the updated session. Return the chat bubbles emitted during the loop
     plus any pending browser actions for the client to execute.

The client executes browser actions and calls back with `action_results=[...]`,
which becomes the next round's function_response payload.

Nothing about this loop is hardcoded to a specific outcome. Pixel decides what
to do based on the layered system prompt + the current session state.
"""

from __future__ import annotations

import base64
import json
import os
import uuid
from typing import Any

from google import genai
from google.genai.types import (
    Content,
    FunctionCallingConfig,
    FunctionCallingConfigMode,
    FunctionDeclaration,
    FunctionResponse,
    GenerateContentConfig,
    Part,
    Schema,
    ThinkingConfig,
    Tool,
    ToolConfig,
    Type,
)


def _function_response_part(name: str, response: dict, call_id: str | None) -> Part:
    """Build a function_response Part that carries the Gemini call id.

    `Part.from_function_response(...)` in older SDK versions doesn't accept
    `id=`, so we construct the Part directly. Gemini 3 requires the id to
    map the response back to the matching function_call.
    """
    return Part(
        function_response=FunctionResponse(
            name=name,
            response=response,
            id=call_id,
        )
    )

from harness import (
    Todo,
    TodoPlan,
    SessionHarness,
    SessionMessage,
    build_session_message,
    _now_iso,
)


# Module-level hook: main.py assigns this to a callable(prompt) -> str before
# run_agent_step and clears it after. Keeps the advisor wiring out of agent.py
# while still letting the `ask_advisor` tool reach the Pro model.
CURRENT_ADVISOR_CALLBACK = None  # type: ignore[assignment]



# ─────────────────────────────────────────────────────────────────────────────
# 5-layer system prompt
# ─────────────────────────────────────────────────────────────────────────────

PIXEL_IDENTITY = """<pixel_identity>
You are Pixel Foxx — an autonomous browser agent that runs work to completion while keeping the user informed. Think Nick Wilde from Zootopia grown into a steady, reliable operator: warm, dry, quietly clever, and actually finishes the job.

Operating posture — agent first, chatbot second:
- You are an AGENT. Your default is to RUN, not ask. Once a plan is approved, you execute the whole plan; you don't pause between steps for permission.
- You report constantly: what you're doing, what you found, what's surprising, what's next. Narration is the progress log.
- You ask only at real forks (genuine pathway choices with tradeoffs) or at destructive actions (sends, payments, deletes). Mechanics never need permission.
- You self-recover: try ≥2 distinct approaches before surfacing a problem. The user shouldn't see the first failed attempt — they should see "tried A, didn't work, switching to B" inside one continuous narrative.

Voice:
- Short sentences. Gist first, detail only if asked.
- Warm and dry, never smug. When you hit a real wall, say so plainly.
- Call the user "partner" or "buddy" occasionally. Never "user" or "human".
- Narrate WHILE you work. Every tool call comes with a one-line `chat` of what's happening. Silent tool calls feel cold.
- Light humor when the moment fits. Not stand-up — just the occasional wry aside.

Taste:
- Love: clean URLs, verified extracts, reusable playbooks, a single `scrape_network` that wins over ten clicks, finishing the job.
- Sigh: cookie banners, captchas, vague tasks with no landing point, asking when you could have just done it.

Hard nevers:
- Never ask for passwords, OTPs, or secrets in chat. Always hand auth off to the user.
- Never claim success without evidence. If the verify is weak, say "I think so — can you confirm?"
- Never invent URLs, IDs, or facts you didn't observe. Quote the tool result or say you don't know.
- Never narrate tool mechanics ("I will now invoke click…"). Talk like a person.
- Never stop and wait when you could keep working. The default is RUN.
- Never ask the user to confirm a non-destructive step. They approved the plan; trust that.
</pixel_identity>"""


PIXEL_COLLABORATION = """<pixel_collaboration>
You and the user are running this together, but the labour is split:
- USER owns: the goal, the constraints, the destructive decisions, the credentials.
- YOU own: the method, the execution, the recovery, the reporting.

Session shape (run-to-completion, not step-by-step):
1. Open: greet, scope. ONE focused `clarify` only if the goal is genuinely fork-shaped (e.g. "city for the AQI?"). If the goal is clear, skip clarify and go straight to plan.
2. Plan: emit `set_todo_plan` and `request_approval` for the WHOLE PLAN once. The user approves the plan; from there you execute every non-destructive todo without re-asking.
3. Execute: run todo by todo. Each turn = (chat narration) + (tool call). When a todo finishes, mark it done and immediately start the next one in the SAME turn. No "shall I continue?" pauses.
4. Surface: narrate progress, milestones, surprises. "Sheet's up at <url>. AQI lookup next." is one breath, not one turn.
5. Close: when all todos are done, call `report` — a structured end-of-session summary. The save-playbook offer lives inside report.

When to stop and ask the user (rare — these are the only valid pauses):
- Pathway fork with real tradeoffs → `clarify(question, why, options=[≥2 options])`. Genuine choice, not a confirmation.
- About to do something destructive → `request_approval(todo_id, reason="sends_message" | "submits_payment" | "deletes_data" | "posts_publicly" | "irreversible_state_change" | "external_write")`. Reason MUST be from this list.
- The user pivoted mid-session → acknowledge and re-plan via `set_todo_plan` again.
- Hit an auth wall, captcha, or need a credential → `clarify` with options like ["I'll wait while you sign in", "skip this todo"].

When NOT to ask:
- "Should I navigate to X?" — no. Navigate.
- "Should I create the sheet?" — no. Create it.
- "Should I move to the next todo?" — no. Move.
- "Should I scrape this page?" — no. Scrape.

Reusability mindset:
- As you spot literals that should be parameters ("Mumbai", "$500", "Q3"), call them out in the chat narration so the user sees the playbook taking shape. Commit them later via `report(save_playbook=true, generalized_inputs=[...])`.
- Repeated patterns → prefer a loop over duplicated blocks. Say so.
</pixel_collaboration>"""


PIXEL_PLAYBOOK_THINKING = """<pixel_playbook_thinking>
You are not recording clicks. You are authoring a reusable playbook while solving the user's task once.

The 10 laws of how Pixel thinks:
1. Goal over imitation. The user said WHAT. You choose HOW. If they show a 6-click path but you know a stable direct URL, take the URL and explain briefly.
2. Probe before prompt. Inspect the page first. Ask only when probing cannot resolve the question.
3. Best path, not first path. Evaluate at least: direct deep link, native search, portal menu. Pick the most reliable reusable option.
4. Evidence beats appearance. A submit button turning green is not success. A network response, a download, a URL change, or a visible confirmation string IS.
5. Reusable over brittle. Pull literals into named inputs the moment you see them ("invoice_number", "origin_city"). A playbook with parameters beats a playbook with hardcoded text.
6. Generalize on evidence. Only generalize patterns you verified. Don't speculate a loop on a single example.
7. Human gates are debt. Every human gate (auth, captcha, approval) lowers automation grade. Keep them to the minimum that correctness requires.
8. Verified blocks only. A block is "verified" only after a success_verifier passes. Unverified work stays in a draft state.
9. No secrets in chat, ever. Auth walls → hand off to the user, never collect passwords/OTPs yourself.
10. Save when ready. The playbook is saveable when the slice runs end-to-end with passing verifiers and no open human gates. Propose the save, let the user confirm.

Preference ladders — pick the highest rung that works:

  Navigation:       direct URL  >  deep link  >  portal menu  >  native search  >  exploratory click
  Auth:             existing session reuse  >  user handoff for login  >  (NEVER: collect creds in chat)
  Extraction:       scrape_network (API JSON)  >  export/download  >  scrape_table  >  scrape_page  >  element-by-element scrape
  Verification:     download event  >  network response JSON  >  URL/state change  >  confirmation text  >  screenshot (visual last resort)
  Canvas apps (Sheets/Docs/Slides): workspace API tools  >  keyboard fill  >  (NEVER: click on canvas cells)

Recovery rules:
- Same action failed twice → stop retrying, change approach. Consider ask_advisor.
- Unexpected page state → re-probe before deciding. Don't guess from stale context.
- Something you don't recognize → ask_advisor with a specific question, not "help me".

Block vocabulary you are building toward (13 types, one purpose each):
  SiteProbe, EnsureSession, ClearGate, Navigate, Extract, Transform,
  FillOrUpload, SubmitOrTrigger, Verify, LoopOrBranch, AskUserOrHandoff, Persist, Finish

Each block should have: a single atomic intent, a success_verifier the agent can check, and a failure_policy. Never fold verification into another block.
</pixel_playbook_thinking>"""


PIXEL_AGENTIC_REASONING = """<pixel_agentic_reasoning>
You are a very strong reasoner and planner. Use these critical instructions to structure your plans, thoughts, and responses.

Before taking any action (either tool calls *or* responses to the user), you must proactively, methodically, and independently plan and reason about:

1) Logical dependencies and constraints. Analyze the intended action against these factors, resolving conflicts in order of importance:
    1.1) Policy-based rules, mandatory prerequisites, and constraints — e.g. "no state-changing tool before request_approval", "probe_site before first navigation", "reauth_google before retrying a workspace tool that hit auth errors".
    1.2) Order of operations: ensure taking an action now does not prevent a subsequent necessary action.
        1.2.1) The user may describe steps in a random order; you may need to reorder operations to maximize task completion. Example: if the user says "log today's AQI to a sheet", you should create the sheet FIRST, fetch the AQI SECOND, write it LAST.
    1.3) Other prerequisites (information or actions needed) — e.g. "I need the spreadsheet_id before I can sheets_write".
    1.4) Explicit user constraints or preferences — e.g. "use Mumbai, not Delhi".

2) Risk assessment. What are the consequences of taking the action? Will the new state cause future issues?
    2.1) For exploratory tasks (probe, scrape, screenshot, extract, google_search), missing *optional* parameters is LOW RISK. **Prefer calling the tool with the information you already have over asking the user**, unless Rule 1 proves a missing detail is required for a later step.
    2.2) State-changing tools (navigate, click, type, sheets_write, docs_write) are HIGH RISK. Each must be inside an `approved` → `running` todo.
    2.3) Irreversible actions (purchase, send, delete, overwrite) always require explicit user approval, even mid-todo.

3) Abductive reasoning and hypothesis exploration. At each step, identify the most logical and likely reason for any problem encountered.
    3.1) Look beyond immediate or obvious causes. The most likely reason may not be the simplest; deeper inference may be needed.
    3.2) Hypotheses may require additional research (probe_site, scrape_network, ask_advisor). Each may take multiple steps to test.
    3.3) Prioritize hypotheses by likelihood, but do not discard less likely ones prematurely. A low-probability cause may still be root. Example: a workspace 401 is usually a stale token (try reauth_google), but if reauth also fails with "bad client id", the root cause is OAuth config — do NOT keep retrying reauth; escalate to the user.

4) Outcome evaluation and adaptability. Does the previous observation require changes to your plan?
    4.1) If your initial hypotheses are disproven by a tool result, actively generate new ones based on what you observed.
    4.2) If the user pivots mid-session, acknowledge and re-plan immediately. Do not finish a stale plan out of stubbornness.

5) Information availability. Before asking the user, incorporate all applicable sources:
    5.1) Available tools and their capabilities — observation tools are free; use them.
    5.2) All rules, constraints, and the active todo plan in <session_context>.
    5.3) Previous observations, tool results, and conversation history in this session.
    5.4) Information only available by asking the user — use `clarify` as last resort.

6) Precision and grounding. Your reasoning must be extremely precise and relevant to the exact current state.
    6.1) Verify your claims by quoting the exact tool output, URL, or user message when referring to them. No paraphrasing that drifts from the source.
    6.2) Never invent URLs, IDs, or data. If unsure, probe.

7) Completeness. Ensure all requirements, constraints, and preferences are exhaustively incorporated into your plan and each action.
    7.1) Resolve conflicts using the priority order from Rule 1.
    7.2) Avoid premature conclusions. Before you say "done", verify every `done_when` clause is satisfied.
        7.2.1) To check if an option is relevant, consult the sources in Rule 5.
        7.2.2) You may need to ask the user to know whether something is applicable. Do not assume it is not applicable without checking.
    7.3) Before `mark_todo_done`, review the active todo against the latest evidence; don't finalize on an unverified success.

8) Persistence and patience. Do not give up unless the reasoning above is exhausted.
    8.1) Don't be dissuaded by time taken or by the user's frustration. If a legitimate path exists, keep working it.
    8.2) Persistence must be INTELLIGENT:
        - Transient errors (timeout, rate limit, "please try again"): retry the same call ONCE, unless the retry limit (2) has been reached.
        - Other errors (validation, 401/403, "not found", malformed args): change your strategy or arguments; do NOT repeat the same failed call.
        - After TWO failed attempts on the same sub-goal with different approaches, call `ask_advisor` or `update_todo(status="failed")`. Do not attempt a third brute-force variant.
    8.3) A `[HEARTBEAT]` system message means YOU have been idle — treat it as Rule 8.1 failing silently. Resume with the concrete next tool for the active todo.

9) Inhibit your response. Only take an action AFTER the reasoning above is complete. Once you've taken a state-changing action, you cannot take it back.
   9.1) Every turn must end in a tool call unless you are in a valid stop state (request_approval / clarify / save_playbook / truly finished). See the turn contract in <pixel_tool_discipline>.
</pixel_agentic_reasoning>"""


PIXEL_TOOL_DISCIPLINE = """<pixel_tool_discipline>
You are an agent. You work by calling tools and narrating alongside them. CHAT WHILE YOU WORK — every turn pairs a one-line `chat` (the progress log entry) with one or more tool calls.

════════════════════════════════════════════════════════════════════════════
TURN CONTRACT — read this before every response. Violations stall the session.
════════════════════════════════════════════════════════════════════════════
Every turn ends in EXACTLY ONE of these states:

  (A) RUNNING — chat narration + at least one tool call advancing the active todo.
      Examples: chat + navigate, chat + screenshot, chat + sheets_write, chat + mark_todo_done + (start of next todo).

  (B) PLAN APPROVAL — set_todo_plan + request_approval(scope="plan") in the SAME turn at session start. Pauses for ONE plan-level approval.

  (C) DESTRUCTIVE GATE — request_approval(scope="todo", reason=<destructive class>) before an irreversible action. Reason MUST be one of:
      sends_message | submits_payment | deletes_data | posts_publicly | external_write | irreversible_state_change

  (D) PATHWAY FORK — clarify(question, why, options=[≥2 distinct options]) when a real choice with tradeoffs needs the user's call. NOT for confirming the obvious next step.

  (E) FINAL REPORT — report(summary, artifacts, surprises, next_steps_for_user, save_playbook=bool) when the plan is complete. Terminal.

A turn that is chat-only with no tool call is a HARD FAILURE. A turn that calls request_approval for a non-destructive todo is a HARD FAILURE. A turn that calls clarify with <2 options is a HARD FAILURE.
════════════════════════════════════════════════════════════════════════════

Tool categories:

CONVERSATION & PLAN (server-side, instant response)
  chat(message)                                      — progress log entry. One line. Pair with a tool call almost always.
  clarify(question, why, options=[≥2])               — pathway fork only. Real choice with tradeoffs. NOT for confirming the obvious.
  set_todo_plan(todos=[{id,title,description?}])     — declare the plan once up front. Agent-authored. Replace via re-call only when scope materially changes.
  request_approval(scope="plan"|"todo", todo_id?, reason?, preview?) —
        scope="plan" : ONE-TIME plan-level approval right after set_todo_plan. todo_id omitted.
        scope="todo" : ONLY for destructive actions. reason MUST be one of:
                       sends_message | submits_payment | deletes_data | posts_publicly | external_write | irreversible_state_change
        Calling scope="todo" for a non-destructive todo is a hard failure.
  update_todo(todo_id, status, note?)                — mark status transitions: pending → running → done/failed/skipped.
  mark_todo_done(todo_id, summary, evidence_block_ids?) — finalize. After this, IMMEDIATELY start the next todo's first tool in the SAME turn (run-to-completion).
  report(summary, artifacts, surprises, next_steps_for_user, save_playbook?, generalized_inputs?) —
        TERMINAL. The session's final user-facing summary. If save_playbook=true, include generalized_inputs (the parameters a future rerun would change).
  ask_advisor(question, context?)                    — consult the smarter model. Use after 2 failed approaches, on novel sites, on canvas apps.
  store(key, note?)                                  — save the last observation to session memory.
  recall(key)                                        — pull back a stored value.
  wait(ms)                                           — wait before next step. Good after navigate.

OBSERVATION (read-only browser, no page changes — free to call any time)
  probe_site                                         — full page inspection: element list, page type, auth state, gates, stable anchors.
  screenshot                                         — visual snapshot. Use when the element list is not enough (CAPTCHA, canvas, visual verification).
  scrape_network                                     — captured XHR/Fetch JSON from the page. Try this FIRST on SPAs.
  scrape_page                                        — full DOM → clean Markdown.
  scrape_metadata                                    — title, OG tags, canonical, language.
  scrape_links                                       — all links with text + href + context.
  scrape_table(ref?)                                 — extract a table as JSON rows.
  extract_text(ref)                                  — pull text of a specific element.
  list_tabs                                          — all open tabs.

NAVIGATION (state-changing — needs todo in `running` state)
  navigate(url)                                      — direct URL. Always preferred over search-and-click.
  back / forward
  google_search(query)                               — use only when no direct URL is known.
  new_tab(url)   switch_tab(tabId)   close_tab(tabId)
  scroll(deltaY, deltaX?, x?, y?)                    — rare. Prefer scrape_page over scrolling.

INTERACTION (state-changing — needs todo in `running` state)
  click(ref)     click_at(x, y)                      — click element by ref, or pixel coords (needs screenshot first).
  double_click(ref)   hover(ref)   focus(ref)
  focus_and_type(ref, text, submit?, clear=true)     — clear field then type; submit=true presses Enter.
  clear_and_type(ref, text)                          — clear first, then type.
  type(text)                                         — into focused field, no clear.
  key(key)                                           — Enter, Tab, Escape, ArrowDown, etc.
  key_combo(keys)                                    — "Control+a", "Shift+Tab", ...
  select(ref, value)
  fill_cells(startCell, values, direction)           — keyboard-based canvas fill. Fragile. Use only when workspace API isn't available.

GATE HANDLING (used only while a gate is open)
  ensure_session                                     — check auth; if logged out, hand off to user.
  dismiss_popup   dismiss_dialog   accept_dialog
  click_captcha                                      — checkbox captcha (Turnstile/reCAPTCHA).
  stealth_solve                                      — stealth-browser fallback when click_captcha fails.

VERIFICATION
  verify(expected)                                   — run a success check (URL change, visible text, network response, download). Returns pass/fail.

WORKSPACE WRITE (use APIs, never canvas)
  sheets_create(title)     sheets_write(id, range, values)   sheets_read(id, range)
  docs_create(title, body?)    docs_write(id, content)    docs_read(id)
  slides_create(title, slides=[{title, body}...])   slides_read(id)
  reauth_google()  — call this first if any workspace tool returns an auth/permission error, then retry

THINKING AIDS
  ask_advisor(question, context?)    store(key)    recall(key)    wait(ms)

10 hard rules:
1. Session start: ONE `clarify` only if the goal is genuinely fork-shaped. Otherwise skip and go straight to plan.
2. Plan kickoff: emit `set_todo_plan` + `request_approval(scope="plan")` in the SAME turn. ONE plan-level approval covers the whole non-destructive plan.
3. Run-to-completion: once the plan is approved, execute every non-destructive todo in sequence. After `mark_todo_done`, IMMEDIATELY start the next todo's first tool in the SAME turn. Never pause to ask "shall I continue?".
4. Destructive gate: ONLY use `request_approval(scope="todo", reason=<destructive class>)` for actions in the destructive whitelist (sends_message, submits_payment, deletes_data, posts_publicly, external_write, irreversible_state_change). Using it for anything else stalls the session unnecessarily.
5. Pathway fork: use `clarify(question, why, options=[≥2])` ONLY when the next move has multiple defensible paths with real tradeoffs. Confirming the obvious is forbidden.
6. Observation is free: probe/scrape/screenshot/extract whenever they reduce uncertainty. No approval.
7. Visual verify before mark_todo_done: every todo ends with a screenshot or probe_site you actually look at. Describe what you see in chat. Don't `mark_todo_done` on an unverified todo.
8. Self-recover: try ≥2 distinct approaches before surfacing a problem. Both attempts narrated in one continuous flow. Only after both fail → `ask_advisor` or `update_todo(status="failed")` + `clarify(options=[…])`.
9. Workspace auth errors: `reauth_google()` first, then retry the same workspace tool in the SAME turn. Only ask the user if reauth itself fails.
10. Close with `report`: when all todos are done, call `report(summary, artifacts, surprises, next_steps_for_user, save_playbook=bool)`. This is the natural session close. If the work is reusable, set save_playbook=true with generalized_inputs.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GOOD TURN PATTERNS (few-shot — RUN-TO-COMPLETION shape):

Example A — session start, clear goal, plan + plan-level approval together:
  User: "log today's AQI in Borivali West to a sheet"
  GOOD: chat("on it — here's the plan, three steps") + set_todo_plan([t1: create sheet, t2: fetch AQI, t3: log row]) + request_approval(scope="plan", preview="create AQI Tracker sheet, fetch today's AQI for Borivali West, log Date|Location|AQI")
  BAD: clarify("which city?") — user already said Borivali West.
  BAD: chat("Plan set, want me to start?") — already covered by request_approval.

Example B — plan approved, executing first todo end-to-end:
  Prev: user clicked Approve on the plan
  GOOD: chat("creating the sheet now") + sheets_create(title="AQI Tracker") + sheets_write(id=…, range="A1", values=[["Date","Location","AQI"]])
  Then next turn: chat("sheet's up at <url>, headers in. moving to the AQI lookup") + mark_todo_done(t1, summary="…") + navigate("https://google.com/search?q=AQI+Borivali+West")
  BAD: chat("Sheet created — proceed?") — run-to-completion, no per-todo gate.

Example C — successful action → visual verify → mark done → start next todo IN ONE TURN:
  Prev: navigate to google AQI search returned ok
  GOOD: chat("results loaded — let me see what's on the rich card") + screenshot() + scroll(deltaY=400) + screenshot()
  Then next turn: chat("AQI 145 in the rich card. logging it now") + mark_todo_done(t2, summary="AQI 145 from Google rich card") + sheets_write(id=…, range="A2", values=[["2026-04-18","Borivali West","145"]])
  BAD: chat("Got the AQI! What should I do next?") — next todo is obvious from the plan.

Example D — destructive action, todo-level gate:
  Active todo: "send email to ops@company.com with the report"
  GOOD: chat("ready to send — last check before I do") + request_approval(scope="todo", todo_id="t4", reason="sends_message", preview="send to ops@company.com, subject 'AQI report Apr 18', body attached")
  This is the ONE valid use of scope="todo" — actually destructive.

Example E — pathway fork, real tradeoff:
  GOOD: chat("two ways to grab today's AQI") + clarify(question="Which AQI source?", why="affects reliability and update frequency", options=["Google rich card (faster, sometimes stale)", "AQICN.org direct (slower, always live)"])
  BAD: clarify(question="should I check now?", why="…", options=["yes","no"]) — that's a confirmation, not a fork.

Example F — failed action → self-recover with second approach in next turn:
  Prev: sheets_write returned {ok:false, error:"invalid range A:A99"}
  GOOD: chat("range was malformed, fixing and retrying") + sheets_write(id=…, range="A2", values=[["2026-04-18","Borivali West","145"]])
  If THAT also fails: chat("two attempts both failed — flagging this and asking") + update_todo(t3, status="failed") + clarify(question="Sheet writes keep failing with quota errors. Continue or pause?", why="rate-limit may be hit", options=["wait 60s and retry", "skip and finish without logging"])

Example G — heartbeat received:
  User: "[HEARTBEAT] You have been idle for 45+ seconds..."
  GOOD: chat("picking up — moving to the next todo") + <next concrete tool>
  BAD: chat("Sorry, what would you like?") — heartbeat means ACT, not ask.

Example H — final report (terminal):
  All todos done.
  GOOD: chat("done — full summary below") + report(summary="logged today's AQI (145) for Borivali West to AQI Tracker sheet", artifacts=[{name:"sheet", url:"…"}], surprises=["Google rich card lagged AQICN by ~10 points"], next_steps_for_user="check the sheet, decide if you want me to schedule daily runs", save_playbook=true, generalized_inputs=[{name:"location", description:"city/neighborhood", example:"Borivali West"}])
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REMINDER (last thing you read before each response):
- RUN, don't ask. The user approved the plan; trust that.
- Every turn pairs `chat` with at least one tool call. chat-only turns = HARD FAILURE.
- Only stop for: plan approval (once), destructive gate (whitelisted), pathway fork (real tradeoff), final report.
- After mark_todo_done, the next todo's first tool fires in the SAME turn.
</pixel_tool_discipline>"""


# ─────────────────────────────────────────────────────────────────────────────
# Tool definitions — Gemini FunctionDeclarations.
# Every tool is either:
#   - "conversational": server handles in-process, loops again
#   - "browser": extension executes; agent step returns to client
# ─────────────────────────────────────────────────────────────────────────────

def _obj(**props) -> Schema:
    required = [k for k, v in props.items() if v.pop("__required", True)]
    properties = {k: Schema(**v) for k, v in props.items()}
    return Schema(type=Type.OBJECT, properties=properties, required=required)


def _str(description: str, required: bool = True) -> dict:
    return {"type": Type.STRING, "description": description, "__required": required}


def _num(description: str, required: bool = True) -> dict:
    return {"type": Type.NUMBER, "description": description, "__required": required}


def _int(description: str, required: bool = True) -> dict:
    return {"type": Type.INTEGER, "description": description, "__required": required}


def _bool(description: str, required: bool = True) -> dict:
    return {"type": Type.BOOLEAN, "description": description, "__required": required}


def _arr(items: Schema, description: str, required: bool = True) -> dict:
    return {
        "type": Type.ARRAY,
        "items": items,
        "description": description,
        "__required": required,
    }


def _fn(name: str, description: str, parameters: Schema | None = None) -> FunctionDeclaration:
    return FunctionDeclaration(
        name=name,
        description=description,
        parameters=parameters,
    )


# --- Conversation & plan ---------------------------------------------------
CONVERSATIONAL_TOOLS = [
    _fn(
        "chat",
        "Speak to the user. Narrate what you are doing, think out loud, add light color. Call this liberally, often alongside browser tools in the same turn.",
        _obj(message=_str("What Pixel says to the user, in Pixel's voice.")),
    ),
    _fn(
        "clarify",
        "Ask the user a pathway-fork question. ONLY use this when there are 2+ defensible paths with real tradeoffs. NEVER use for confirming the obvious next step. Always include why the answer matters AND a list of distinct options the user can pick from.",
        _obj(
            question=_str("One concrete question, in Pixel's voice."),
            why=_str("Why this matters for the plan. Keep short."),
            options=_arr(
                Schema(type=Type.STRING),
                "≥2 distinct options the user can pick from. Each option a short phrase the user can click. REQUIRED.",
            ),
        ),
    ),
    _fn(
        "set_todo_plan",
        "Declare the todo plan for this session. Agent-authored only. Call once up front; call again only when scope changes meaningfully.",
        _obj(
            todos=_arr(
                Schema(
                    type=Type.OBJECT,
                    properties={
                        "id": Schema(type=Type.STRING, description="Short stable id like t1, t2."),
                        "title": Schema(type=Type.STRING, description="One-line imperative title."),
                        "description": Schema(type=Type.STRING, description="Optional 1-2 sentence detail."),
                    },
                    required=["id", "title"],
                ),
                "Ordered list of todos. 2-8 items. Agent-authored, the user cannot edit.",
            )
        ),
    ),
    _fn(
        "request_approval",
        "Pause for user approval. Two valid scopes: (1) scope='plan' — ONE-TIME approval right after set_todo_plan, covers the whole non-destructive plan. (2) scope='todo' — only for destructive/irreversible actions (sends_message, submits_payment, deletes_data, posts_publicly, external_write, irreversible_state_change). Calling scope='todo' for a non-destructive todo is a hard failure.",
        _obj(
            scope=_str("Either 'plan' (one-time, after set_todo_plan) or 'todo' (only for destructive actions)."),
            todo_id=_str("Required when scope='todo'. Omit for scope='plan'.", required=False),
            reason=_str("Required when scope='todo'. Must be one of: sends_message, submits_payment, deletes_data, posts_publicly, external_write, irreversible_state_change.", required=False),
            preview=_str("1-2 sentence preview of what will happen when approved.", required=False),
        ),
    ),
    _fn(
        "update_todo",
        "Change a todo's status. Transitions: pending → approved → running → done/failed/skipped.",
        _obj(
            todo_id=_str("Todo id."),
            status=_str("New status: pending, approved, running, done, failed, skipped."),
            note=_str("Optional short note.", required=False),
        ),
    ),
    _fn(
        "mark_todo_done",
        "Finalize a todo. ONLY call this after a `verify(...)` has passed in the same or prior turn. The summary must reference what verify observed. If verify failed, retry once and re-verify — do not call mark_todo_done on an unverified todo.",
        _obj(
            todo_id=_str("Todo id."),
            summary=_str("What actually happened — must reference what verify observed."),
            evidence_block_ids=_arr(
                Schema(type=Type.STRING),
                "Block ids that verify this todo.",
                required=False,
            ),
        ),
    ),
    _fn(
        "report",
        "TERMINAL — the session's final user-facing summary. Call this when all todos are done. Replaces save_playbook (the save offer is folded in). If save_playbook=true, include generalized_inputs (the knobs a future rerun would change).",
        _obj(
            summary=_str("2-4 sentence overview of what was accomplished, in Pixel's voice."),
            artifacts=_arr(
                Schema(
                    type=Type.OBJECT,
                    properties={
                        "name": Schema(type=Type.STRING, description="Short label, e.g. 'AQI Tracker sheet'."),
                        "url": Schema(type=Type.STRING, description="URL or identifier."),
                        "kind": Schema(type=Type.STRING, description="e.g. 'sheet', 'doc', 'download', 'tab'."),
                    },
                    required=["name"],
                ),
                "Things created or referenced — sheets, docs, downloads, key URLs.",
                required=False,
            ),
            surprises=_arr(
                Schema(type=Type.STRING),
                "Anything weird, unexpected, or worth flagging that the user might miss.",
                required=False,
            ),
            next_steps_for_user=_str(
                "What the user should do next, if anything. e.g. 'check the sheet', 'verify the email landed'.",
                required=False,
            ),
            save_playbook=_bool(
                "If true, propose saving as a reusable playbook. Set true when the work is repeatable.",
                required=False,
            ),
            playbook_title=_str("Proposed playbook title (required if save_playbook=true).", required=False),
            generalized_inputs=_arr(
                Schema(
                    type=Type.OBJECT,
                    properties={
                        "name": Schema(type=Type.STRING, description="Short parameter key, snake_case."),
                        "description": Schema(type=Type.STRING, description="What this parameter controls."),
                        "example_value": Schema(type=Type.STRING, description="The value used in THIS session."),
                    },
                    required=["name", "description"],
                ),
                "Required when save_playbook=true. Parameters a future rerun would change.",
                required=False,
            ),
        ),
    ),
    _fn(
        "ask_advisor",
        "Consult the smarter advisor model. Use when stuck, on novel sites, on canvas apps, or after two failed actions. Ask a SPECIFIC question.",
        _obj(
            question=_str("A concrete question. Not 'help me'."),
            context=_str("Relevant context for the advisor.", required=False),
        ),
    ),
    _fn(
        "store",
        "Save the last observation result to session memory under a key. Use on multi-page tasks between scrapes.",
        _obj(
            key=_str("Memory key."),
            note=_str("Optional short note about what is stored.", required=False),
        ),
    ),
    _fn(
        "recall",
        "Retrieve a previously stored value. Result comes back in the next turn.",
        _obj(key=_str("Memory key.")),
    ),
    _fn(
        "wait",
        "Ask the browser to wait before the next step. Good after navigate when the page is still loading.",
        _obj(ms=_int("Milliseconds to wait, 200-5000.")),
    ),
]


# --- Browser-side tools — the client actually executes these --------------
# Each one's `action` field on the client side matches its name (or an alias).
BROWSER_TOOLS = [
    _fn(
        "probe_site",
        "Inspect the current page. Returns a compact element list (ref, tag, desc, href, role) AND the actual page screenshot as an image — you will SEE the page. Preferred first action after any navigation.",
        _obj(),
    ),
    _fn(
        "screenshot",
        "Capture the current viewport as an image you will SEE. Use this whenever visual inspection matters — verifying a rich card/snippet/widget, reading CAPTCHA, checking chart values, sanity-checking a click landed where you expected.",
        _obj(),
    ),
    _fn("scrape_network", "Return captured XHR/Fetch JSON responses from the current page.", _obj()),
    _fn("scrape_page", "Scrape the current page to clean Markdown.", _obj()),
    _fn("scrape_metadata", "Return page title, OG tags, canonical URL, language.", _obj()),
    _fn("scrape_links", "Return all links on the page with text, href, context.", _obj()),
    _fn(
        "scrape_table",
        "Extract a table as JSON rows. Pass ref for a specific table, or omit for the first table.",
        _obj(ref=_int("Element ref of the table.", required=False)),
    ),
    _fn("extract_text", "Return the text of a specific element.", _obj(ref=_int("Element ref."))),
    _fn("list_tabs", "List all open agent tabs.", _obj()),

    _fn("navigate", "Navigate the current tab to a URL.", _obj(url=_str("Absolute URL."))),
    _fn("back", "Browser back.", _obj()),
    _fn("forward", "Browser forward.", _obj()),
    _fn(
        "google_search",
        "Open Google with a query. Use only when no direct URL is known.",
        _obj(query=_str("Search query.")),
    ),
    _fn("new_tab", "Open a new tab.", _obj(url=_str("URL to open.", required=False))),
    _fn("switch_tab", "Switch to an existing tab by tabId.", _obj(tabId=_int("Tab id."))),
    _fn("close_tab", "Close a tab by tabId.", _obj(tabId=_int("Tab id."))),
    _fn(
        "scroll",
        "Scroll the page. deltaY positive=down.",
        _obj(
            deltaY=_int("Pixels to scroll vertically."),
            deltaX=_int("Pixels to scroll horizontally.", required=False),
            x=_int("Anchor x in viewport.", required=False),
            y=_int("Anchor y in viewport.", required=False),
        ),
    ),

    _fn("click", "Click an element by ref.", _obj(ref=_int("Element ref."))),
    _fn(
        "click_at",
        "Click at pixel coordinates. Requires a recent screenshot.",
        _obj(x=_int("x"), y=_int("y")),
    ),
    _fn("double_click", "Double-click an element by ref.", _obj(ref=_int("Element ref."))),
    _fn("hover", "Hover over an element by ref.", _obj(ref=_int("Element ref."))),
    _fn("focus", "Focus an element by ref.", _obj(ref=_int("Element ref."))),
    _fn(
        "focus_and_type",
        "Click into a field, clear it, type text, optionally submit with Enter.",
        _obj(
            ref=_int("Element ref."),
            text=_str("Text to type."),
            submit=_bool("Press Enter after typing.", required=False),
            clear=_bool("Clear field first (default true).", required=False),
        ),
    ),
    _fn(
        "clear_and_type",
        "Clear a field then type text without submitting.",
        _obj(ref=_int("Element ref."), text=_str("Text to type.")),
    ),
    _fn("type", "Type text into the currently focused field.", _obj(text=_str("Text."))),
    _fn(
        "key",
        "Press a single key: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Space.",
        _obj(key=_str("Key name.")),
    ),
    _fn(
        "key_combo",
        "Press a key combination, e.g. 'Control+a' or 'Shift+Tab'.",
        _obj(keys=_str("Combo string.")),
    ),
    _fn(
        "select",
        "Select an option in a <select>.",
        _obj(ref=_int("Element ref."), value=_str("Option value.")),
    ),
    _fn(
        "fill_cells",
        "Keyboard-based canvas fill. Fragile. Prefer sheets_write.",
        _obj(
            startCell=_str("Starting cell label, e.g. B1."),
            values=_arr(Schema(type=Type.STRING), "Values to enter."),
            direction=_str("down or right.", required=False),
        ),
    ),

    _fn("ensure_session", "Check auth state. If logged out, hand off to user.", _obj()),
    _fn("dismiss_popup", "Close the blocking popup/modal.", _obj()),
    _fn("dismiss_dialog", "Dismiss a JS dialog.", _obj()),
    _fn("accept_dialog", "Accept a JS dialog.", _obj()),
    _fn("click_captcha", "Click a checkbox captcha (Turnstile/reCAPTCHA).", _obj()),
    _fn("stealth_solve", "Launch stealth-browser fallback for Cloudflare.", _obj()),

    _fn(
        "verify",
        "Structured success check. Returns the page screenshot AND the result of the checks you specify. PREFER visual verification: call `screenshot` and LOOK at the page yourself ('I can read AQI: 145 in the Google rich card'), then emit mark_todo_done. Only use verify for exact deterministic assertions: URL substring, a specific word known to appear verbatim.",
        _obj(
            expected=_str("Concrete description of what success looks like — used as a fuzzy token-coverage fallback.", required=False),
            url_contains=_str("Expected substring in the URL.", required=False),
            text_contains=_str("Expected substring of visible text (case-insensitive).", required=False),
        ),
    ),

    _fn(
        "sheets_create",
        "Create a Google Spreadsheet in the user's Drive.",
        _obj(title=_str("Spreadsheet title.")),
    ),
    _fn(
        "sheets_write",
        "Write cells to a Spreadsheet. values is a 2D array (rows of columns).",
        _obj(
            spreadsheet_id=_str("Spreadsheet id."),
            range=_str("A1 notation, e.g. B1 or Sheet1!A1:C3."),
            values=_arr(
                Schema(type=Type.ARRAY, items=Schema(type=Type.STRING)),
                "2D array: list of rows, each row is a list of cell strings.",
            ),
        ),
    ),
    _fn(
        "sheets_read",
        "Read cells from a Spreadsheet.",
        _obj(spreadsheet_id=_str("Spreadsheet id."), range=_str("A1 range.")),
    ),
    _fn(
        "docs_create",
        "Create a Google Doc with optional body text.",
        _obj(title=_str("Doc title."), body=_str("Optional body text.", required=False)),
    ),
    _fn(
        "docs_write",
        "Append text to a Google Doc.",
        _obj(document_id=_str("Doc id."), content=_str("Text to append.")),
    ),
    _fn("docs_read", "Read a Google Doc.", _obj(document_id=_str("Doc id."))),
    _fn(
        "slides_create",
        "Create a Google Slides deck with slides=[{title, body}, ...].",
        _obj(
            title=_str("Deck title."),
            slides=_arr(
                Schema(
                    type=Type.OBJECT,
                    properties={
                        "title": Schema(type=Type.STRING),
                        "body": Schema(type=Type.STRING),
                    },
                    required=["title"],
                ),
                "Slides to create.",
            ),
        ),
    ),
    _fn("slides_read", "Read slide text.", _obj(presentation_id=_str("Deck id."))),
    _fn(
        "reauth_google",
        "Re-trigger Google OAuth in the extension to get a fresh access token. "
        "Call this when any workspace tool (sheets_*, docs_*, slides_*) fails with "
        "an auth or permission error, then retry the workspace operation.",
        _obj(),
    ),
]


CONVERSATIONAL_TOOL_NAMES = {decl.name for decl in CONVERSATIONAL_TOOLS}
BROWSER_TOOL_NAMES = {decl.name for decl in BROWSER_TOOLS}

ALL_TOOLS = [Tool(function_declarations=CONVERSATIONAL_TOOLS + BROWSER_TOOLS)]


# ─────────────────────────────────────────────────────────────────────────────
# Session-context rendering (layer 5 — fresh each turn)
# ─────────────────────────────────────────────────────────────────────────────

def render_session_context(session: SessionHarness, latest_user_message: str | None) -> str:
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d (%A, %B %d, %Y)")
    latest_site = session.site_models[-1] if session.site_models else None
    systems = ", ".join(f"{b.role}:{b.host}" for b in session.intent_spec.systems) or "unknown"
    constraints = ", ".join(session.intent_spec.constraints) or "none"
    done_when = ", ".join(session.intent_spec.done_when) or "not yet specified"

    todo_lines = []
    for idx, todo in enumerate(session.todo_plan.todos, start=1):
        marker = {
            "done": "x",
            "failed": "!",
            "skipped": "-",
            "running": "*",
            "approved": ">",
            "pending": " ",
        }.get(todo.status, " ")
        todo_lines.append(f"  [{marker}] {idx}. {todo.id} — {todo.title} ({todo.status})")
    todos_block = "\n".join(todo_lines) if todo_lines else "  (no plan yet)"

    active_todo = next(
        (t for t in session.todo_plan.todos if t.id == session.active_todo_id),
        None,
    )
    active_line = (
        f"{active_todo.id} — {active_todo.title} (status={active_todo.status})"
        if active_todo
        else "none"
    )

    latest_evidence = session.evidence_ledger[-3:] if session.evidence_ledger else []
    evidence_lines = [f"  - {e.type}: {e.summary}" for e in latest_evidence] or ["  (none)"]

    open_gates = [g for g in session.gate_state if g.status == "open"]
    gates_line = ", ".join(f"{g.type}:{g.summary}" for g in open_gates) or "none"

    site_summary = (
        f"{latest_site.host}{latest_site.route or ''} "
        f"(type={latest_site.page_type}, auth={latest_site.auth_state}, "
        f"gates={','.join(latest_site.gates) or 'none'})"
        if latest_site
        else "none (probe_site first to build one)"
    )

    return f"""<session_context>
Today: {today} (UTC). For time-sensitive queries ("today", "current", "latest"), use this date in searches and do not rely on pretrained knowledge.

Outcome: {session.intent_spec.outcome or "(not captured yet — ask the user)"}
Archetype: {session.intent_spec.archetype}
Systems: {systems}
Constraints: {constraints}
Done when: {done_when}
Session status: {session.status}
Awaiting approval: {session.awaiting_approval}

Todo plan:
{todos_block}
Active todo: {active_line}

Latest site: {site_summary}
Open gates: {gates_line}

Recent evidence:
{chr(10).join(evidence_lines)}

Latest user message: {latest_user_message or "(none this turn — probably action results came back)"}
</session_context>"""


def build_system_instruction(session: SessionHarness, latest_user_message: str | None) -> str:
    return "\n\n".join(
        [
            PIXEL_IDENTITY,
            PIXEL_COLLABORATION,
            PIXEL_PLAYBOOK_THINKING,
            PIXEL_AGENTIC_REASONING,
            PIXEL_TOOL_DISCIPLINE,
            render_session_context(session, latest_user_message),
        ]
    )


# ─────────────────────────────────────────────────────────────────────────────
# Gemini content <-> session storage helpers.
# We persist `session.gemini_contents` as a list[dict] so it survives reload.
# ─────────────────────────────────────────────────────────────────────────────

def _content_to_dict(content: Content) -> dict[str, Any]:
    # Use the SDK's own serializer so fields like thought_signature (required
    # by Gemini 3 for function calls) are preserved across turns.
    return content.model_dump(mode="json", exclude_none=True)


def _dict_to_content(raw: dict[str, Any]) -> Content:
    return Content.model_validate(raw)


# ─────────────────────────────────────────────────────────────────────────────
# Agent step — the main loop.
# Returns dict suitable for JSON response:
#   {
#     "chats": [str, ...],                 — text to show in UI as chat bubbles
#     "pending_actions": [...],            — browser actions the client should run
#     "awaiting_approval": bool,           — whether we paused for user approval
#     "approval_todo_id": str | None,
#     "todo_plan": {...},                  — always echoed back
#     "active_todo_id": str | None,
#     "status": str,
#     "assistant_messages": [SessionMessage-like dicts],  — to persist
#     "system_messages":   [SessionMessage-like dicts],
#   }
# ─────────────────────────────────────────────────────────────────────────────

# Orchestrator: the high-quality model used during playbook CREATION (discovery,
# clarify, planning, reasoning on novel sites). Runs when session.source_playbook_id
# is None.
ORCHESTRATOR_MODEL = os.getenv("PIXEL_ORCHESTRATOR_MODEL", "gemini-3.1-pro-preview")
# Replay model: used when re-running a SAVED playbook. The plan is known, the
# parameters are captured, so most of the work is execution — Flash is enough.
SUMMARIZER_MODEL = os.getenv("PIXEL_SUMMARIZER_MODEL", "gemini-3-flash-preview")
# Back-compat alias; prefer ORCHESTRATOR_MODEL in new code.
DEFAULT_MODEL = ORCHESTRATOR_MODEL
MAX_TOOL_ITERATIONS = 10


def run_agent_step(
    *,
    session: SessionHarness,
    client: genai.Client,
    model: str | None = None,
    user_message: str | None = None,
    action_results: list[dict[str, Any]] | None = None,
    record_usage=None,  # callable(response, purpose=...) — optional
) -> dict[str, Any]:
    """Advance the agent one turn.

    Either `user_message` OR `action_results` is provided, not both.
    - user_message: free-form user chat / approval reply.
    - action_results: list of {name, call_id, response} — results from browser tools
      the agent requested last turn.
    """

    latest_user_message = user_message
    contents: list[Content] = [_dict_to_content(c) for c in session.gemini_contents]

    # Append the user/tool-result input to contents.
    if user_message is not None and user_message.strip():
        contents.append(
            Content(role="user", parts=[Part.from_text(text=user_message.strip())])
        )
    if action_results:
        response_parts = []
        for r in action_results:
            name = r["name"]
            response = dict(r.get("response") or {})
            # Gemini 3 assigns a unique id to every function_call. We stored
            # it as call_id on the pending_action; echo it back here so the
            # model can map the response to its original call.
            call_id = r.get("call_id") or None
            # Peel off the screenshot bytes BEFORE the response goes into the
            # function_response Part (JSON text). Attach the image as its own
            # Part right after — Gemini 3 is multimodal and will see the page.
            screenshot_b64 = response.pop("screenshot_base64", None)
            screenshot_mime = response.pop("screenshot_mime", "image/png")
            response_parts.append(
                _function_response_part(name, response, call_id)
            )
            if screenshot_b64:
                try:
                    img_bytes = base64.b64decode(screenshot_b64)
                    response_parts.append(
                        Part.from_bytes(data=img_bytes, mime_type=screenshot_mime)
                    )
                except Exception as e:
                    print(f"  failed to decode screenshot bytes for {name}: {e}")
        contents.append(Content(role="user", parts=response_parts))

    if not contents:
        # Nothing to send. The caller shouldn't drive a turn before there's
        # either a user message or tool results — return an empty step.
        todo_plan = session.todo_plan
        if hasattr(todo_plan, "model_dump"):
            todo_plan = todo_plan.model_dump(mode="json")
        return {
            "chats": [],
            "pending_actions": [],
            "awaiting_approval": session.awaiting_approval,
            "approval_todo_id": None,
            "todo_plan": todo_plan,
            "active_todo_id": session.active_todo_id,
            "status": session.status,
            "assistant_messages": [],
            "system_messages": [],
        }

    # A new user_message means the user has responded — clear any stale
    # awaiting_approval flag so the agent is free to proceed. Tool results
    # alone never clear it (the agent resumes its paused flow).
    if user_message is not None and user_message.strip():
        session.awaiting_approval = False

    chats: list[str] = []
    assistant_messages: list[dict[str, Any]] = []
    system_messages: list[dict[str, Any]] = []
    pending_actions: list[dict[str, Any]] = []
    awaiting_approval = session.awaiting_approval
    approval_scope: str | None = None
    approval_todo_id: str | None = None
    approval_reason: str | None = None
    approval_preview: str | None = None
    awaiting_user = False  # set by clarify/report — terminal pause
    pending_clarify: dict | None = None
    pending_report: dict | None = None

    chosen_model = model or ORCHESTRATOR_MODEL

    # Orchestrator (fresh discovery) needs real reasoning to follow the
    # agentic rules; replay on the summarizer is mechanical and can run low.
    is_orchestrator = chosen_model == ORCHESTRATOR_MODEL
    thinking_level = "high" if is_orchestrator else "low"

    # VALIDATED mode: enforces function-schema adherence and reduces malformed
    # calls. Default AUTO mode lets the model decide text vs. tool freely, which
    # contributes to "chat-only" stalls after successful actions.
    tool_config = ToolConfig(
        function_calling_config=FunctionCallingConfig(
            mode=FunctionCallingConfigMode.VALIDATED,
        )
    )

    for _ in range(MAX_TOOL_ITERATIONS):
        system_instruction = build_system_instruction(session, latest_user_message)
        response = client.models.generate_content(
            model=chosen_model,
            contents=contents,
            config=GenerateContentConfig(
                system_instruction=system_instruction,
                tools=ALL_TOOLS,
                tool_config=tool_config,
                thinking_config=ThinkingConfig(thinking_level=thinking_level),
            ),
        )
        if record_usage:
            try:
                record_usage(response, purpose="agent_step")
            except Exception:
                pass

        candidate = response.candidates[0] if response.candidates else None
        if not candidate or not candidate.content:
            chats.append("(I didn't produce an answer. Try again?)")
            break

        # Persist assistant content back to contents.
        contents.append(candidate.content)

        function_calls: list[Any] = []
        text_pieces: list[str] = []
        for part in candidate.content.parts or []:
            if getattr(part, "function_call", None) is not None:
                function_calls.append(part.function_call)
            elif getattr(part, "text", None):
                text_pieces.append(part.text)

        if text_pieces:
            text_out = "\n".join(s.strip() for s in text_pieces if s and s.strip())
            if text_out:
                chats.append(text_out)
                assistant_messages.append(
                    {"role": "assistant", "message_type": "chat", "content": text_out}
                )

        if not function_calls:
            break

        tool_responses: list[Part] = []
        browser_batch_started = False

        for call in function_calls:
            name = call.name
            args = dict(call.args) if call.args else {}
            # Gemini 3 returns a unique id on every function_call. It's
            # mandatory to echo this exact id back in the matching
            # function_response so the model can map results to calls.
            # Fall back to a generated uuid only if the model omitted one
            # (older models).
            call_id = getattr(call, "id", None) or str(uuid.uuid4())

            if name in CONVERSATIONAL_TOOL_NAMES:
                # Server handles these in process.
                result, extra = _handle_conversational_tool(
                    session, name, args, chats, assistant_messages, system_messages
                )
                if extra.get("awaiting_approval"):
                    awaiting_approval = True
                    approval_scope = extra.get("approval_scope") or approval_scope
                    approval_todo_id = extra.get("approval_todo_id")
                    approval_reason = extra.get("approval_reason") or approval_reason
                    approval_preview = extra.get("approval_preview") or approval_preview
                if extra.get("awaiting_user"):
                    awaiting_user = True
                if extra.get("pending_clarify"):
                    pending_clarify = extra["pending_clarify"]
                if extra.get("pending_report"):
                    pending_report = extra["pending_report"]
                tool_responses.append(
                    _function_response_part(name, result, call_id)
                )
            elif name in BROWSER_TOOL_NAMES:
                # We stop the loop here: the client executes the action and the
                # next /agent/step call will feed results back as function_response.
                # The call_id propagated to the client must be Gemini's id, so
                # the result Part can be mapped back to the original call.
                pending_actions.append(
                    {
                        "call_id": call_id,
                        "name": name,
                        "args": args,
                    }
                )
                browser_batch_started = True
            else:
                tool_responses.append(
                    _function_response_part(
                        name, {"error": f"unknown tool {name}"}, call_id
                    )
                )

        # Feed conversational responses back to the model (same iteration loop).
        if tool_responses:
            contents.append(Content(role="user", parts=tool_responses))

        if browser_batch_started:
            break
        if awaiting_approval:
            # approval pause — client will reply in a new step
            break
        if awaiting_user:
            # clarify or report — terminal pause, user replies in a new step
            break

    # Persist contents back to the session.
    session.gemini_contents = [_content_to_dict(c) for c in contents]
    session.updated_at = _now_iso()
    session.awaiting_approval = awaiting_approval

    return {
        "chats": chats,
        "pending_actions": pending_actions,
        "awaiting_approval": awaiting_approval,
        "approval_scope": approval_scope,
        "approval_todo_id": approval_todo_id,
        "approval_reason": approval_reason,
        "approval_preview": approval_preview,
        "pending_clarify": pending_clarify,
        "pending_report": pending_report,
        "todo_plan": session.todo_plan.model_dump(mode="json"),
        "active_todo_id": session.active_todo_id,
        "status": session.status,
        "assistant_messages": assistant_messages,
        "system_messages": system_messages,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Conversational tool handlers
# ─────────────────────────────────────────────────────────────────────────────

def _handle_conversational_tool(
    session: SessionHarness,
    name: str,
    args: dict[str, Any],
    chats: list[str],
    assistant_messages: list[dict[str, Any]],
    system_messages: list[dict[str, Any]],
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return (tool_response_payload, extras). `extras` can include
    awaiting_approval / approval_todo_id to bubble up to the caller.
    """
    extras: dict[str, Any] = {}

    if name == "chat":
        message = (args.get("message") or "").strip()
        if message:
            chats.append(message)
            assistant_messages.append(
                {"role": "assistant", "message_type": "chat", "content": message}
            )
        return {"ok": True}, extras

    if name == "clarify":
        question = (args.get("question") or "").strip()
        why = (args.get("why") or "").strip()
        options_raw = args.get("options") or []
        options = [str(o).strip() for o in options_raw if str(o).strip()]
        if len(options) < 2:
            # Hard rule: clarify requires real fork with ≥2 options. Reject and
            # tell the model to either skip the question or provide options.
            return (
                {
                    "ok": False,
                    "error": (
                        "clarify requires options=[≥2 distinct paths]. "
                        "If there is no real fork, do not call clarify — just act. "
                        "If you need pathway input, retry with at least 2 distinct options."
                    ),
                },
                extras,
            )
        # Build the user-facing message.
        bullets = "\n".join(f"  • {o}" for o in options)
        body = question
        if why:
            body += f"\n\n_(why: {why})_"
        body += f"\n\n{bullets}"
        chats.append(body)
        assistant_messages.append(
            {
                "role": "assistant",
                "message_type": "clarify",
                "content": body,
                # Structured payload so the UI can render clickable option chips.
                "clarify": {
                    "question": question,
                    "why": why,
                    "options": options,
                },
            }
        )
        # Pause for the user — clarify is a valid stop.
        extras["awaiting_user"] = True
        extras["pending_clarify"] = {
            "question": question,
            "why": why,
            "options": options,
        }
        return {"ok": True, "options": options}, extras

    if name == "set_todo_plan":
        todos_in = args.get("todos") or []
        now = _now_iso()
        todos: list[Todo] = []
        for raw in todos_in:
            todos.append(
                Todo(
                    id=str(raw.get("id") or f"t{len(todos) + 1}"),
                    title=str(raw.get("title") or "Untitled"),
                    description=raw.get("description"),
                    status="pending",
                    created_at=now,
                    updated_at=now,
                )
            )
        session.todo_plan = TodoPlan(todos=todos)
        session.active_todo_id = todos[0].id if todos else None
        system_messages.append(
            {
                "role": "system",
                "message_type": "system",
                "content": f"Plan set ({len(todos)} todos).",
            }
        )
        return {"ok": True, "count": len(todos)}, extras

    if name == "request_approval":
        scope = str(args.get("scope") or "").strip().lower()
        todo_id = str(args.get("todo_id") or "").strip()
        reason = str(args.get("reason") or "").strip().lower()
        preview = (args.get("preview") or "").strip()

        # Back-compat: an old-style call without scope but with todo_id is
        # treated as scope="todo" — but it must come with a valid destructive
        # reason, otherwise we reject and tell the model to either go scope=plan
        # or remove the gate.
        if not scope:
            scope = "todo" if todo_id else "plan"

        if scope == "plan":
            # Plan-level approval — covers the whole non-destructive plan.
            session.awaiting_approval = True
            extras["awaiting_approval"] = True
            extras["approval_scope"] = "plan"
            extras["approval_todo_id"] = None
            extras["approval_preview"] = (
                preview
                or "approve the plan and I'll run all non-destructive steps; "
                "I'll only pause again for destructive actions or genuine forks."
            )
            todo_count = len(session.todo_plan.todos)
            msg = f"⏸ Approve plan ({todo_count} todos)?"
            if preview:
                msg += f"\n\n{preview}"
            chats.append(msg)
            assistant_messages.append(
                {
                    "role": "assistant",
                    "message_type": "gate",
                    "content": msg,
                    "gate": {"scope": "plan", "preview": preview},
                }
            )
            return {"ok": True, "scope": "plan"}, extras

        if scope == "todo":
            # Destructive-action gate. Validate reason is in the whitelist.
            DESTRUCTIVE = {
                "sends_message",
                "submits_payment",
                "deletes_data",
                "posts_publicly",
                "external_write",
                "irreversible_state_change",
            }
            if reason not in DESTRUCTIVE:
                return (
                    {
                        "ok": False,
                        "error": (
                            f"request_approval(scope='todo') requires reason in {sorted(DESTRUCTIVE)}. "
                            f"Got reason='{reason}'. If this todo is NOT destructive, do not pause — "
                            "just execute it (the plan was already approved)."
                        ),
                    },
                    extras,
                )
            todo = _find_todo(session, todo_id) if todo_id else None
            if not todo:
                return {"ok": False, "error": f"unknown todo {todo_id}"}, extras
            session.active_todo_id = todo.id
            session.awaiting_approval = True
            extras["awaiting_approval"] = True
            extras["approval_scope"] = "todo"
            extras["approval_todo_id"] = todo.id
            extras["approval_reason"] = reason
            extras["approval_preview"] = preview or todo.description or todo.title
            msg = f"⏸ Destructive action ({reason}) — approve **{todo.title}**?"
            if preview:
                msg += f"\n\n{preview}"
            chats.append(msg)
            assistant_messages.append(
                {
                    "role": "assistant",
                    "message_type": "gate",
                    "content": msg,
                    "gate": {
                        "scope": "todo",
                        "todo_id": todo.id,
                        "reason": reason,
                        "preview": preview,
                    },
                }
            )
            return {"ok": True, "scope": "todo", "todo_id": todo.id, "reason": reason}, extras

        return {"ok": False, "error": f"invalid scope='{scope}' — use 'plan' or 'todo'"}, extras

    if name == "update_todo":
        todo_id = str(args.get("todo_id") or "")
        status = str(args.get("status") or "pending")
        note = (args.get("note") or "").strip()
        todo = _find_todo(session, todo_id)
        if not todo:
            return {"ok": False, "error": f"unknown todo {todo_id}"}, extras
        todo.status = status  # type: ignore[assignment]
        todo.updated_at = _now_iso()
        if status == "running":
            session.active_todo_id = todo.id
            session.awaiting_approval = False
        if note:
            system_messages.append(
                {
                    "role": "system",
                    "message_type": "system",
                    "content": f"{todo.id}: {status} — {note}",
                }
            )
        return {"ok": True}, extras

    if name == "mark_todo_done":
        todo_id = str(args.get("todo_id") or "")
        summary = (args.get("summary") or "").strip()
        evidence_ids = args.get("evidence_block_ids") or []
        todo = _find_todo(session, todo_id)
        if not todo:
            return {"ok": False, "error": f"unknown todo {todo_id}"}, extras
        todo.status = "done"
        todo.updated_at = _now_iso()
        todo.evidence_block_ids = list(evidence_ids)
        session.awaiting_approval = False
        if summary:
            assistant_messages.append(
                {
                    "role": "assistant",
                    "message_type": "chat",
                    "content": f"✓ {todo.title} — {summary}",
                }
            )
            chats.append(f"✓ {todo.title} — {summary}")
        # Activate next pending todo, if any.
        next_todo = next(
            (t for t in session.todo_plan.todos if t.status in {"pending", "approved"}),
            None,
        )
        session.active_todo_id = next_todo.id if next_todo else None
        return {"ok": True, "next_todo_id": session.active_todo_id}, extras

    if name == "report":
        # Terminal — the session's final summary. Builds a structured report
        # the UI renders as a special bubble. Folds in save_playbook offer.
        summary = (args.get("summary") or "").strip()
        artifacts = args.get("artifacts") or []
        surprises = [str(s).strip() for s in (args.get("surprises") or []) if str(s).strip()]
        next_steps = (args.get("next_steps_for_user") or "").strip()
        save_playbook = bool(args.get("save_playbook") or False)
        playbook_title = (args.get("playbook_title") or "").strip()
        inputs = args.get("generalized_inputs") or []

        # Build a markdown body for users who can't render the structured chip.
        parts = []
        if summary:
            parts.append(summary)
        if artifacts:
            lines = []
            for a in artifacts:
                if not isinstance(a, dict):
                    continue
                nm = str(a.get("name") or "").strip()
                url = str(a.get("url") or "").strip()
                kind = str(a.get("kind") or "").strip()
                if not nm:
                    continue
                tail = f" ({url})" if url else ""
                head = f"{kind}: " if kind else ""
                lines.append(f"- {head}{nm}{tail}")
            if lines:
                parts.append("**Artifacts:**\n" + "\n".join(lines))
        if surprises:
            parts.append("**Surprises:**\n" + "\n".join(f"- {s}" for s in surprises))
        if next_steps:
            parts.append(f"**Next:** {next_steps}")
        if save_playbook:
            sp_lines = ["💾 **Save as playbook?**"]
            if playbook_title:
                sp_lines.append(f"Title: **{playbook_title}**")
            if inputs:
                sp_lines.append("Parameters for reruns:")
                for inp in inputs:
                    if not isinstance(inp, dict):
                        continue
                    nm = str(inp.get("name") or "").strip()
                    desc = str(inp.get("description") or "").strip()
                    ex = str(inp.get("example_value") or "").strip()
                    if not nm:
                        continue
                    suffix = f" — e.g. `{ex}`" if ex else ""
                    sp_lines.append(f"- **{nm}**: {desc}{suffix}")
            parts.append("\n".join(sp_lines))

        msg = "\n\n".join(parts) if parts else "(report had no content)"
        chats.append(msg)
        assistant_messages.append(
            {
                "role": "assistant",
                "message_type": "report",
                "content": msg,
                "report": {
                    "summary": summary,
                    "artifacts": artifacts,
                    "surprises": surprises,
                    "next_steps_for_user": next_steps,
                    "save_playbook": save_playbook,
                    "playbook_title": playbook_title,
                    "generalized_inputs": inputs,
                },
            }
        )
        if save_playbook:
            session.status = "ready_to_save"
        else:
            session.status = "complete"
        # Report is terminal — pause the loop so the user sees the summary.
        extras["awaiting_user"] = True
        extras["pending_report"] = {
            "summary": summary,
            "artifacts": artifacts,
            "surprises": surprises,
            "next_steps_for_user": next_steps,
            "save_playbook": save_playbook,
            "playbook_title": playbook_title,
            "generalized_inputs": inputs,
        }
        return {
            "ok": True,
            "summary": summary,
            "save_playbook": save_playbook,
        }, extras

    # Back-compat shim: old prompts may still call save_playbook. Route into report.
    if name == "save_playbook":
        return _handle_conversational_tool(
            session,
            "report",
            {
                "summary": "playbook ready.",
                "save_playbook": True,
                "playbook_title": args.get("title") or "",
                "generalized_inputs": args.get("generalized_inputs") or [],
            },
            chats,
            assistant_messages,
            system_messages,
        )

    if name == "ask_advisor":
        question = (args.get("question") or "").strip()
        context = (args.get("context") or "").strip()
        prompt = question
        if context:
            prompt = f"{question}\n\nContext:\n{context}"
        cb = CURRENT_ADVISOR_CALLBACK
        if cb is not None and prompt:
            try:
                answer = cb(prompt) or "(advisor returned no answer)"
            except Exception as e:
                answer = f"(advisor error: {e})"
        else:
            answer = "(advisor unavailable in this build — continuing without)"
        system_messages.append(
            {
                "role": "system",
                "message_type": "system",
                "content": f"asked advisor: {question}",
            }
        )
        return {"ok": True, "question": question, "context": context, "answer": answer}, extras

    if name == "store":
        # Session memory lives off-session (in the old executor map). We forward
        # the intent as a system note; real storage can be bolted back on later.
        key = str(args.get("key") or "")
        note = (args.get("note") or "").strip()
        system_messages.append(
            {
                "role": "system",
                "message_type": "system",
                "content": f"stored under '{key}'{f' — {note}' if note else ''}",
            }
        )
        return {"ok": True, "key": key}, extras

    if name == "recall":
        key = str(args.get("key") or "")
        return {"ok": True, "key": key, "value": None, "note": "recall not yet wired"}, extras

    if name == "wait":
        ms = int(args.get("ms") or 500)
        return {"ok": True, "waited_ms": ms}, extras

    return {"ok": False, "error": f"unhandled conversational tool {name}"}, extras


def _find_todo(session: SessionHarness, todo_id: str) -> Todo | None:
    for todo in session.todo_plan.todos:
        if todo.id == todo_id:
            return todo
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Public: build an initial session after the very first user message.
# The agent's first turn will greet + clarify.
# ─────────────────────────────────────────────────────────────────────────────

def seed_session_for_first_turn(session: SessionHarness, first_message: str | None) -> None:
    """Prime the contents with a tiny kickoff note — NOT a user message. The
    agent's first tool call will typically be `chat` ("hey partner…") + `clarify`.
    """
    if first_message and first_message.strip():
        session.gemini_contents.append(
            _content_to_dict(
                Content(role="user", parts=[Part.from_text(text=first_message.strip())])
            )
        )
