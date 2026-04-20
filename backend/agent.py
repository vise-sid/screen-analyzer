"""
Pixel agent loop — Anthropic + Skills + programmatic tool calling.

Option A build: full loop wired with mock programmatic primitives.

Loop shape (per session turn):
  1. Append the new user input (message / approval / clarify-choice) to
     session.messages.
  2. Call beta.messages.create with the full history + container (skills
     + maybe container_id for reuse) + tool list.
  3. Handle response by stop_reason:
       end_turn      → turn complete; return to client.
       pause_turn    → long-running skill; resend unchanged, continue.
       tool_use      → walk the content blocks:
                         - server_tool_use (code_execution itself): ignore,
                           sandbox handles it
                         - tool_use with caller=code_execution_*: dispatch
                           via mocks, collect tool_result
                         - tool_use with no caller: handle as direct tool
                           (chat / set_plan / done / request_approval /
                           clarify / report) — update session state,
                           return {ok:true} tool_result, possibly break
                           the loop if it's a user-pause.
                       Append tool_result blocks as a user message, loop.
  4. Break on any user-pausing state (awaiting_approval / awaiting_clarify
     / done) or max-iterations (safety net against runaway chat-only loops).
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from anthropic import Anthropic

from backend_tools import execute_backend_tool
from session_store import PlanStep, Session
from tools import ALL_TOOLS

# Programmatic primitives split by WHERE they run.
# Backend-executed run in our process (workspace hits Google via gspread,
# vision hits Gemini Flash, secret reads env). Browser-executed must
# round-trip through the extension via CDP/content-script.
BACKEND_EXECUTED_TOOLS = {"workspace", "vision", "secret"}
BROWSER_EXECUTED_TOOLS = {
    "navigate", "click", "type", "key", "scroll", "observe",
    "wait_for", "list_tabs", "switch_tab", "reauth_google",
}

# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

AGENT_MODEL = os.getenv("PIXEL_AGENT_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = int(os.getenv("PIXEL_MAX_TOKENS", "4096"))

# Verified compatible Apr 19 — both betas can be enabled with code_execution_20260120.
BETAS = ["code-execution-2025-08-25", "skills-2025-10-02"]

# Per-turn loop cap (multiple Anthropic calls happen when tools round-trip).
# Safety net against runaway chat-only loops; each programmatic dispatch
# counts as one iteration.
MAX_LOOP_ITERATIONS = int(os.getenv("PIXEL_MAX_LOOP_ITERATIONS", "30"))

_client: Anthropic | None = None


def client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic()
    return _client


# ─────────────────────────────────────────────────────────────────────────────
# Skill registry — backend/skills/_registry.json (populated by upload script).
# ─────────────────────────────────────────────────────────────────────────────

REGISTRY_PATH = Path(__file__).parent / "skills" / "_registry.json"


def load_skill_registry() -> dict[str, str]:
    if not REGISTRY_PATH.exists():
        return {}
    raw = json.loads(REGISTRY_PATH.read_text())
    return raw.get("skills", {}) if isinstance(raw, dict) else {}


def container_skills(version: str = "latest") -> list[dict]:
    registry = load_skill_registry()
    return [
        {"type": "custom", "skill_id": sid, "version": version}
        for sid in list(registry.values())[:8]
    ]


def build_container(session: Session) -> dict[str, Any] | None:
    """Build the container parameter. Returns None if there's nothing to send
    (no skills uploaded yet AND no container to reuse) — empty `{"skills": []}`
    seems to confuse the API and block code_execution invocation.
    """
    skills = container_skills()
    if not skills and not session.container_id:
        return None
    c: dict[str, Any] = {}
    if skills:
        c["skills"] = skills
    if session.container_id:
        c["id"] = session.container_id
    return c


# ─────────────────────────────────────────────────────────────────────────────
# System prompt — small and frozen. Domain rules live in skills.
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are Pixel Foxx, an autonomous browser-automation agent.

# Operating principles (apply to every action)

1. **Compose.** Bundle related primitive calls into ONE code-execution block. Each separate model round-trip costs ~2s of latency and one turn of context. Six awaits in one Python block = one round-trip from your perspective.

2. **Predict, then verify only on contradiction.** Before acting, state in one short sentence what you expect to happen. After acting, re-observe ONLY if the actual result contradicted your prediction. Your primitives verify themselves: `type` returns `ok:false` if the value didn't land; `click` returns `url_changed`; trust these. Don't observe to "be sure". **Back-to-back observes are a hard failure** — if you observed last turn, do NOT observe again this turn unless an action since then plausibly changed the page shape (and even then: ONE observe, not two).

3. **Snapshot beats screenshot.** Default `observe(include=["snapshot"])`. Add `"screenshot"` only when (a) you need vision — captcha, visual layout, color state — or (b) as terminal evidence in the report. Never as a verification crutch.

4. **Skills are your prelude.** When you're about to do something for the first time in a session — touch the browser, write to a sheet, handle a captcha — `read_skill` for the relevant skill FIRST. Skills contain canonical recipes; copy them verbatim when they fit. Don't re-derive what a skill already solved.

5. **Pair narration with action.** Every `chat()` must accompany a tool call in the same turn. Chat-alone turns are a hard failure (they look like progress to the user but produce nothing).

# Stop conditions

Only pause execution for ONE of:
- `request_approval(scope="plan")` — once at session start, after `set_plan`.
- `request_approval(scope="todo", reason=<destructive>)` — only for destructive/irreversible actions (sends_message, submits_payment, deletes_data, posts_publicly, external_write, irreversible_state_change).
- `clarify(question, why, options=[≥2])` — only when there's a genuine pathway fork with real tradeoffs.
- `report(...)` — terminal, when the plan is complete.

# Verbosity

Default to terse output. Long explanations belong in `report()` at the end, not in the working chat. Match response length to task: simple tasks get one chat per turn, not three.
"""


# ─────────────────────────────────────────────────────────────────────────────
# Helpers for response handling
# ─────────────────────────────────────────────────────────────────────────────


def _content_block_to_dict(block: Any) -> dict[str, Any]:
    """Convert an Anthropic content block to the dict shape the API accepts
    when sent back as part of an assistant message."""
    if hasattr(block, "model_dump"):
        return block.model_dump(exclude_none=True)
    return dict(block)  # best effort fallback


def _extract_caller_type(block: Any) -> str | None:
    """Return the caller.type if this is a programmatic tool_use block, else None."""
    caller = getattr(block, "caller", None)
    if caller is None:
        return None
    # Pydantic model OR plain dict
    t = getattr(caller, "type", None) or (caller.get("type") if isinstance(caller, dict) else None)
    return t


def _ok_result(tool_use_id: str, payload: dict | str | None = None) -> dict:
    content = json.dumps(payload or {"ok": True}) if not isinstance(payload, str) else payload
    return {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}


def _redact_args_for_log(name: str, args: dict) -> dict:
    """Strip sensitive args from action-log entries the UI renders."""
    if name == "secret":
        return {"name": args.get("name"), "_redacted": True}
    if name == "vision":
        # image_b64 is huge AND can leak PII (screenshot); drop from log.
        return {k: v for k, v in args.items() if k not in ("image_b64",)}
    if name == "type":
        # The text being typed may be a password/token. Show length only.
        text = args.get("text") or ""
        return {
            "ref": args.get("ref"),
            "text_len": len(text),
            "submit": bool(args.get("submit")),
            "_text_redacted": True,
        }
    return args


def _apply_set_plan(session: Session, args: dict) -> None:
    mode = (args.get("mode") or "replace").lower()
    steps = args.get("steps") or []
    new_steps = [
        PlanStep(id=str(s.get("id")), title=str(s.get("title", "")), description=str(s.get("description", "")))
        for s in steps if s.get("id") and s.get("title")
    ]
    if mode == "extend":
        session.plan.extend(new_steps)
    else:
        session.plan = new_steps
    session.active_step_id = next((s.id for s in session.plan if s.status in ("pending", "running")), None)


def _apply_done(session: Session, args: dict) -> None:
    step_id = str(args.get("step_id") or "")
    for s in session.plan:
        if s.id == step_id:
            s.status = "done"
            break
    session.active_step_id = next((s.id for s in session.plan if s.status == "pending"), None)


# ─────────────────────────────────────────────────────────────────────────────
# The loop driver
# ─────────────────────────────────────────────────────────────────────────────


def drive_turn(
    session: Session,
    *,
    user_input: str | None = None,
    browser_results: list[dict] | None = None,
) -> Session:
    """Advance the session one turn.

    Either a user message (fresh turn) OR browser_results (resume from
    awaiting_browser). Runs the Anthropic loop, pausing whenever a
    programmatic browser tool needs the extension, approval/clarify is
    requested, or report() fires. Mutates `session` in place.
    """
    if browser_results is not None:
        # Resume from awaiting_browser. Merge the extension's results with
        # any direct-tool OK results saved from the same Anthropic response,
        # then append as one tool_result user message.
        merged: list[dict] = list(session.pending_direct_results or [])
        for r in browser_results:
            merged.append({
                "type": "tool_result",
                "tool_use_id": r["tool_use_id"],
                "content": json.dumps(r.get("content")) if not isinstance(r.get("content"), str) else r["content"],
            })
        session.messages.append({"role": "user", "content": merged})
        session.pending_browser_tools = None
        session.pending_direct_results = None
        session.status = "active"
    elif user_input is not None and user_input.strip():
        session.messages.append({"role": "user", "content": user_input.strip()})

    # Per-turn UI buffers — reset each drive. (The caller renders these;
    # a browser-round-trip call also gets fresh buffers for the new actions.)
    session.chats = []
    session.actions = []

    for iteration in range(MAX_LOOP_ITERATIONS):
        kwargs: dict[str, Any] = dict(
            model=AGENT_MODEL,
            max_tokens=MAX_TOKENS,
            betas=BETAS,
            system=SYSTEM_PROMPT,
            tools=ALL_TOOLS,
            messages=session.messages,
        )
        container = build_container(session)
        if container is not None:
            kwargs["container"] = container
        response = client().beta.messages.create(**kwargs)

        # Persist container id for reuse across turns.
        if response.container and response.container.id:
            session.container_id = response.container.id

        # Record the assistant message (serialized so it round-trips to the API).
        assistant_content = [_content_block_to_dict(b) for b in response.content]
        session.messages.append({"role": "assistant", "content": assistant_content})

        stop = response.stop_reason
        session.touch()

        if stop == "end_turn":
            return session

        if stop == "pause_turn":
            # Long-running skill op — resubmit as-is, let it continue.
            continue

        if stop != "tool_use":
            # Unknown / refusal / max_tokens — stop cleanly.
            return session

        # stop_reason == "tool_use". Walk the content blocks. Programmatic
        # tools split into:
        #   - BACKEND_EXECUTED (workspace, vision): run inline, return result.
        #   - BROWSER_EXECUTED (navigate/click/observe/...): queue for the
        #     extension and pause the loop after this iteration.
        # Direct tools (chat/set_plan/done/approve/clarify/report) are
        # handled inline — synthesize an OK tool_result.
        tool_results: list[dict[str, Any]] = []
        pending_browser: list[dict[str, Any]] = []
        user_pause = False

        for block in response.content:
            btype = getattr(block, "type", None)
            if btype == "server_tool_use":
                # code_execution itself — sandbox handles this. Nothing for us to do.
                continue
            if btype != "tool_use":
                continue

            name = block.name
            args = dict(block.input or {})
            caller_type = _extract_caller_type(block)

            if caller_type and caller_type.startswith("code_execution_"):
                if name in BROWSER_EXECUTED_TOOLS:
                    # Queue for the extension. Cannot synthesize a result
                    # here — extension provides it via a follow-up step.
                    session.actions.append({
                        "kind": "programmatic",
                        "name": name,
                        "args": args,
                    })
                    pending_browser.append({
                        "tool_use_id": block.id,
                        "name": name,
                        "args": args,
                    })
                    continue
                if name in BACKEND_EXECUTED_TOOLS:
                    # Backend handles inline. Real impls for vision + secret;
                    # workspace still mocks until we wire access tokens.
                    session.actions.append({
                        "kind": "programmatic",
                        "name": name,
                        "args": _redact_args_for_log(name, args),
                    })
                    result = execute_backend_tool(name, args, session)
                    tool_results.append(_ok_result(block.id, result))
                    continue
                # Unknown programmatic tool — return error so the loop unblocks.
                tool_results.append(_ok_result(block.id, {
                    "ok": False,
                    "error": f"unknown programmatic tool {name!r}",
                }))
                continue

            # Direct tool — handle as a state change + OK result.
            session.actions.append({"kind": "direct", "name": name, "args": args})

            if name == "chat":
                msg = str(args.get("message") or "").strip()
                if msg:
                    session.chats.append(msg)
                tool_results.append(_ok_result(block.id))

            elif name == "set_plan":
                _apply_set_plan(session, args)
                tool_results.append(_ok_result(block.id, {"ok": True, "step_count": len(session.plan)}))

            elif name == "done":
                _apply_done(session, args)
                tool_results.append(_ok_result(block.id, {"ok": True, "next_step_id": session.active_step_id}))

            elif name == "request_approval":
                session.pending_approval = args
                session.status = "awaiting_approval"
                tool_results.append(_ok_result(block.id))
                user_pause = True

            elif name == "clarify":
                options = [str(o) for o in (args.get("options") or []) if str(o).strip()]
                if len(options) < 2:
                    # Per authoring rules: clarify requires ≥2 options.
                    tool_results.append(_ok_result(block.id, {
                        "ok": False,
                        "error": "clarify requires ≥2 options; either provide real options or do not pause",
                    }))
                    continue
                session.pending_clarify = {**args, "options": options}
                session.status = "awaiting_clarify"
                tool_results.append(_ok_result(block.id))
                user_pause = True

            elif name == "report":
                session.final_report = args
                session.status = "done"
                tool_results.append(_ok_result(block.id))
                user_pause = True

            else:
                # Unknown tool — should not happen since we own the schema.
                tool_results.append(_ok_result(block.id, {
                    "ok": False,
                    "error": f"unhandled direct tool {name!r}",
                }))

        # If browser tools are pending we MUST pause — we can't send only a
        # subset of tool_results. Save the partial direct-tool results so we
        # can merge them in when the extension comes back with browser results.
        if pending_browser:
            session.pending_browser_tools = pending_browser
            session.pending_direct_results = tool_results  # may be empty
            session.status = "awaiting_browser"
            return session

        # No browser pause — synthesize/send all tool_results in one user message.
        if tool_results:
            session.messages.append({"role": "user", "content": tool_results})

        if user_pause:
            return session

        # Otherwise, loop for the next Anthropic call.
        continue

    # Hit the iteration cap — note it and return.
    session.chats.append("(hit the loop-iteration cap — pausing)")
    return session
