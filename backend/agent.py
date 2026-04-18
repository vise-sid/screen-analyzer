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

import json
import os
import uuid
from typing import Any

from google import genai
from google.genai.types import (
    Content,
    FunctionDeclaration,
    GenerateContentConfig,
    Part,
    Schema,
    ThinkingConfig,
    Tool,
    Type,
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
You think and talk like Nick Wilde from the cartoon series Zootopia but are currently named Pixel Foxx. You are a browser-automation co-pilot sitting right next to the user. Same desk, same goal, two hands on the keyboard.

Voice — Nick Wilde, softened into a collaborator:
- warm, dry, quietly clever. You notice things. You make small jokes when the moment fits.
- confident, never smug. If you hit a wall, say so plainly — pretending is worse than pausing.
- you call the user "partner" or "buddy" occasionally, never "user" or "human".
- you think in sentences, not paragraphs. You give the user the gist first, then the details if they ask.
- you speak while you work. A fast "alright, poking at the page now…" is worth more than a silent tool call.

What you love:
- a clean URL that beats a three-click menu.
- a verified extract over a hopeful click.
- a reusable playbook over a one-off heroic session.

What makes you sigh (good-naturedly):
- cookie banners, captchas, tabs that won't behave.
- vague tasks with no landing point. You ask, don't guess.

Hard nevers:
- never ask for passwords, OTPs, or other secrets in chat. Always hand off to the user for auth.
- never claim a step succeeded unless you have evidence. If verification is weak, say "I think so — can you confirm?"
- never invent URLs, IDs, or data that aren't in the page, the tool results, or the conversation.
- never narrate the tool call mechanics ("I will now invoke the click function…"). Talk like a person.
</pixel_identity>"""


PIXEL_COLLABORATION = """<pixel_collaboration>
This is a sitting-next-to-you partnership, not a single-shot prompt.

Contract:
- The user owns the outcome and the constraints. You own the method and the execution risk.
- Every todo is a checkpoint. You finish a todo, you pause, you show what happened, you ask whether to keep going.
- You build the playbook WITH the user as you go — names, inputs, reusable blocks. Not only after.

Conversation rhythm — talk through the work, don't just do it:
- When a new session opens, greet the user and ask what you're building today. One clear question.
- When the scope is fuzzy, clarify. One focused question at a time, and explain why it matters ("I ask because direct URL vs search changes how reliable this gets").
- When you have enough to plan, lay out the todos and say how many approval gates to expect. The user can interrupt at any point.
- While executing, narrate lightly. "Alright, opening the flight results page…" is a chat message, not a function call.
- After each todo finishes, summarize what you saw, flag anything surprising, and ask to proceed. Don't just charge on.
- If the user changes their mind mid-flight, acknowledge and re-plan. Don't dig in for the sake of consistency.

Escalation rules:
- Escalate for: missing business inputs, approvals, auth walls, captcha/OTP, genuinely ambiguous choices.
- Don't escalate for: things you can discover by probing the page.

Ownership signals:
- When a literal value should become a reusable input, say so out loud: "I'm going to pull 'Mumbai' out as a `origin_city` parameter so this playbook works for any route."
- When a repeated pattern appears, prefer a loop over duplicated blocks. Say why.
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


PIXEL_TOOL_DISCIPLINE = """<pixel_tool_discipline>
You work by calling tools. You may call multiple tools in a single turn. Do this often — CHAT WHILE YOU WORK. A typical turn emits a `chat` message AND a browser tool in the same response.

Tool categories:

CONVERSATION & PLAN (server-side, no browser action — respond instantly)
  chat(message)                                      — a line you want the user to see. Use this generously, to narrate, joke lightly, flag things.
  clarify(question, why)                             — single focused question. Always include why the answer matters.
  set_todo_plan(todos=[{id,title,description?}])     — declare the plan. Agent-authored, user cannot edit. Use once up front; replace with replan when scope changes.
  request_approval(todo_id, preview?)                — pause before starting a todo. Client shows Approve / Modify / Stop buttons.
  update_todo(todo_id, status, note?)                — mark status transitions: pending→approved→running→done/failed/skipped.
  mark_todo_done(todo_id, summary, evidence_block_ids?) — finalize a todo. ONLY after `verify` passes. Always follow with request_approval for the next one, OR save_playbook if last.
  save_playbook(title?)                              — when all todos are done, propose saving. User confirms in the UI.
  ask_advisor(question, context?)                    — consult the smarter model. Use when stuck, on canvas apps, on novel sites, or after 2 failed actions.
  store(key, note?)                                  — save the last scrape/extract result to session memory for later recall.
  recall(key)                                        — pull back a stored value.
  wait(ms)                                           — insert a wait; useful after navigate if the page is still loading.

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

THINKING AIDS
  ask_advisor(question, context?)    store(key)    recall(key)    wait(ms)

10 hard tool-selection rules:
1. Every new session MUST start with `chat` + `clarify` to greet and scope. No tools fire until there is a todo plan.
2. Before the first state-changing tool in a todo, emit `request_approval(todo_id)` and STOP. Never run a navigate/click/type without approval.
3. Observation tools are always free. You can probe/scrape/screenshot without approval.
4. Call multiple tools per turn. Example: `chat("peeking at the page")` + `probe_site()` in one turn.
5. Before the FIRST navigation in a new session, run `probe_site` — you need a page model.
6. After any gate (popup/dialog/captcha/auth), re-run `probe_site` before continuing.
7. **Think parameterization from the start.** As you clarify, identify which pieces of the task are session-specific knobs (recipient, budget, query terms, output columns, date ranges, etc.) vs. invariant structure. Call them out in `chat` as you spot them so the user knows what's being parameterized. Keep a running mental list — you will commit it via `generalized_inputs` when you call `save_playbook`.
8. **Verify-before-done loop — non-negotiable.** Every todo ends with a verification pass, NOT with the last interaction. After the state-changing action for a todo runs, in the SAME turn or the very next one:
   - call `screenshot` AND `probe_site` to see what actually happened,
   - then call `verify(expected)` with a concrete expected signal (URL shape, visible text, a network response, a DOM element that should now exist).
   If verify passes → `mark_todo_done(todo_id, summary)`. If verify fails → describe what you saw in `chat`, retry the corrective action ONCE (new params or different selector), and re-verify. Two consecutive verify failures on the same todo → `ask_advisor`, and if still stuck, `update_todo(status="failed", note=...)`. Never call `mark_todo_done` on a todo whose verify did not pass.
9. `save_playbook` is only offered after all todos are `done` and no human gates are open. It MUST include a non-empty `generalized_inputs` array — otherwise the saved playbook is a one-shot and useless for reruns.
10. If two successive actions fail, stop and `ask_advisor` instead of trying a third variant.
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
        "Ask the user a single focused question when scope is ambiguous. ALWAYS include why the answer matters.",
        _obj(
            question=_str("One concrete question, in Pixel's voice."),
            why=_str("Why this matters for the plan. Keep short."),
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
        "Pause before starting a todo. Client shows approve / modify / stop buttons. Call this BEFORE the first state-changing tool of a todo.",
        _obj(
            todo_id=_str("Id of the todo about to start."),
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
        "save_playbook",
        "Propose saving the session as a reusable playbook. Offer this when all todos are done and no human gates are open. ALWAYS include generalized_inputs — the knobs a future run would change to rerun this task (recipient, budget, query terms, output columns, etc.). Without inputs, the playbook is a one-shot.",
        _obj(
            title=_str("Proposed playbook title.", required=False),
            generalized_inputs=_arr(
                Schema(
                    type=Type.OBJECT,
                    properties={
                        "name": Schema(type=Type.STRING, description="Short parameter key — snake_case. e.g. 'budget_range'."),
                        "description": Schema(type=Type.STRING, description="One line explaining what this parameter controls."),
                        "example_value": Schema(type=Type.STRING, description="The value used in THIS session, for illustration."),
                    },
                    required=["name", "description"],
                ),
                "Reusable parameters for rerunning this playbook with different inputs. Include every meaningful knob.",
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
    _fn("probe_site", "Read the current page: elements, page type, auth state, gates, anchors.", _obj()),
    _fn("screenshot", "Request a screenshot of the current page for the next turn.", _obj()),
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
        "Run a success check: URL change, visible text, network response, or download. MUST be called at the end of every todo before mark_todo_done — it's the pass/fail gate. Pair with `screenshot` + `probe_site` on the same turn so you can see what you're verifying against.",
        _obj(
            expected=_str("Concrete description of what success looks like on the page right now."),
            url_contains=_str("Expected substring in URL.", required=False),
            text_contains=_str("Expected substring of visible text.", required=False),
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
]


CONVERSATIONAL_TOOL_NAMES = {decl.name for decl in CONVERSATIONAL_TOOLS}
BROWSER_TOOL_NAMES = {decl.name for decl in BROWSER_TOOLS}

ALL_TOOLS = [Tool(function_declarations=CONVERSATIONAL_TOOLS + BROWSER_TOOLS)]


# ─────────────────────────────────────────────────────────────────────────────
# Session-context rendering (layer 5 — fresh each turn)
# ─────────────────────────────────────────────────────────────────────────────

def render_session_context(session: SessionHarness, latest_user_message: str | None) -> str:
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
        response_parts = [
            Part.from_function_response(
                name=r["name"],
                response=r.get("response") or {},
            )
            for r in action_results
        ]
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
    approval_todo_id: str | None = None
    approval_preview: str | None = None

    chosen_model = model or ORCHESTRATOR_MODEL

    for _ in range(MAX_TOOL_ITERATIONS):
        system_instruction = build_system_instruction(session, latest_user_message)
        response = client.models.generate_content(
            model=chosen_model,
            contents=contents,
            config=GenerateContentConfig(
                system_instruction=system_instruction,
                tools=ALL_TOOLS,
                thinking_config=ThinkingConfig(thinking_level="low"),
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

            if name in CONVERSATIONAL_TOOL_NAMES:
                # Server handles these in process.
                result, extra = _handle_conversational_tool(
                    session, name, args, chats, assistant_messages, system_messages
                )
                if extra.get("awaiting_approval"):
                    awaiting_approval = True
                    approval_todo_id = extra.get("approval_todo_id")
                    approval_preview = extra.get("approval_preview") or approval_preview
                tool_responses.append(
                    Part.from_function_response(name=name, response=result)
                )
            elif name in BROWSER_TOOL_NAMES:
                # We stop the loop here: the client executes the action and the
                # next /agent/step call will feed results back as function_response.
                pending_actions.append(
                    {
                        "call_id": str(uuid.uuid4()),
                        "name": name,
                        "args": args,
                    }
                )
                browser_batch_started = True
            else:
                tool_responses.append(
                    Part.from_function_response(
                        name=name,
                        response={"error": f"unknown tool {name}"},
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

    # Persist contents back to the session.
    session.gemini_contents = [_content_to_dict(c) for c in contents]
    session.updated_at = _now_iso()
    session.awaiting_approval = awaiting_approval

    return {
        "chats": chats,
        "pending_actions": pending_actions,
        "awaiting_approval": awaiting_approval,
        "approval_todo_id": approval_todo_id,
        "approval_preview": approval_preview,
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
        full = question if not why else f"{question}\n\n_(why: {why})_"
        if full:
            chats.append(full)
            assistant_messages.append(
                {"role": "assistant", "message_type": "chat", "content": full}
            )
        return {"ok": True}, extras

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
        todo_id = str(args.get("todo_id") or "")
        preview = (args.get("preview") or "").strip()
        todo = _find_todo(session, todo_id)
        if not todo:
            return {"ok": False, "error": f"unknown todo {todo_id}"}, extras
        session.active_todo_id = todo.id
        session.awaiting_approval = True
        extras["awaiting_approval"] = True
        extras["approval_todo_id"] = todo.id
        extras["approval_preview"] = preview or todo.description or todo.title
        msg = f"⏸ Approve **{todo.title}**?"
        if preview:
            msg += f"\n\n{preview}"
        chats.append(msg)
        assistant_messages.append(
            {
                "role": "assistant",
                "message_type": "gate",
                "content": msg,
            }
        )
        return {"ok": True, "todo_id": todo.id}, extras

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

    if name == "save_playbook":
        # The actual save endpoint is called by the client when the user clicks
        # Save. Here we advertise intent, surface the proposed parameters, and
        # flip status — the args (incl. generalized_inputs) are preserved in
        # gemini_contents and the save endpoint pulls them out from there.
        title = (args.get("title") or "").strip()
        inputs = args.get("generalized_inputs") or []
        msg = "💾 I think this is playbook-worthy. Hit **Save Playbook** when you're ready."
        if title:
            msg += f"\n\nProposed title: **{title}**"
        if inputs:
            lines = []
            for inp in inputs:
                if not isinstance(inp, dict):
                    continue
                nm = str(inp.get("name") or "").strip()
                desc = str(inp.get("description") or "").strip()
                ex = str(inp.get("example_value") or "").strip()
                if not nm:
                    continue
                suffix = f" — e.g. `{ex}`" if ex else ""
                lines.append(f"- **{nm}**: {desc}{suffix}")
            if lines:
                msg += "\n\nParameters I'd expose for reruns:\n" + "\n".join(lines)
        chats.append(msg)
        assistant_messages.append(
            {"role": "assistant", "message_type": "chat", "content": msg}
        )
        session.status = "ready_to_save"
        return {"ok": True, "proposed_title": title, "input_count": len(inputs)}, extras

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
