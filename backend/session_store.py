"""
In-memory session store.

Holds the agent loop's per-session state: message history (in Anthropic
Messages format), container_id (for code-execution container reuse), the
declared plan, the active step, and any pending pause (approval / clarify
/ report). Replaced with a real DB later — for Option A in-memory is fine.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal


SessionStatus = Literal[
    "active",              # agent is mid-loop or waiting for the next user message
    "awaiting_approval",   # request_approval was called, blocked on user
    "awaiting_clarify",    # clarify was called, blocked on user choice
    "awaiting_browser",    # programmatic tool(s) pending — extension must execute
    "done",                # report() called — session is terminal
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class PlanStep:
    id: str
    title: str
    description: str = ""
    status: Literal["pending", "running", "done", "failed", "skipped"] = "pending"


@dataclass
class Session:
    id: str
    user_sub: str
    messages: list[dict[str, Any]] = field(default_factory=list)
    container_id: str | None = None
    plan: list[PlanStep] = field(default_factory=list)
    active_step_id: str | None = None
    status: SessionStatus = "active"
    # Populated by request_approval — cleared once the user responds.
    pending_approval: dict[str, Any] | None = None
    # Populated by clarify — cleared once the user responds.
    pending_clarify: dict[str, Any] | None = None
    # Populated by report — terminal.
    final_report: dict[str, Any] | None = None
    # Populated when the Anthropic loop pauses on a programmatic tool call
    # that requires the extension (navigate/click/observe/etc.). Each entry:
    #   {tool_use_id, name, args}
    # When the extension POSTs /agent/step with browser_results, we merge
    # them with any `pending_direct_results` from the same response and
    # resume the loop with one tool_result user message.
    pending_browser_tools: list[dict[str, Any]] | None = None
    pending_direct_results: list[dict[str, Any]] | None = None
    # Recent programmatic tool calls (name + args-hash) for loop detection.
    # Trimmed to the last ~6 entries — long enough to spot 3-in-a-row thrash,
    # short enough to forget legitimate repeats far apart.
    recent_browser_calls: list[tuple[str, str]] = field(default_factory=list)
    # Per-turn buffer of chat() narrations the model emitted this turn.
    # Reset at the start of each turn, returned to the client.
    chats: list[str] = field(default_factory=list)
    # Per-turn buffer of tool_use blocks for the UI to render as action bubbles.
    actions: list[dict[str, Any]] = field(default_factory=list)
    created_at: str = field(default_factory=_now_iso)
    updated_at: str = field(default_factory=_now_iso)

    def touch(self) -> None:
        self.updated_at = _now_iso()


_SESSIONS: dict[str, Session] = {}


def create_session(user_sub: str) -> Session:
    sid = uuid.uuid4().hex
    s = Session(id=sid, user_sub=user_sub)
    _SESSIONS[sid] = s
    return s


def get_session(session_id: str, user_sub: str) -> Session | None:
    s = _SESSIONS.get(session_id)
    if s is None or s.user_sub != user_sub:
        return None
    return s


def list_sessions(user_sub: str) -> list[Session]:
    return [s for s in _SESSIONS.values() if s.user_sub == user_sub]
