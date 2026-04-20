"""
Agent routes.

  POST /sessions                       → create a new session. Returns {session_id}.
  POST /sessions/{id}/agent/step       → advance one turn.
       Body options (all optional, one at a time):
         { user_message: "..." }
         { approval: "approved" | "rejected" }
         { clarify_choice: "<one of the offered options>" }
       Returns the current session envelope (chats, actions, plan, pending states).
  GET  /sessions/{id}                  → envelope only (no drive).

Auth: all routes require the Bearer ID token (verified via JWKS).
"""
from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from agent import drive_turn
from auth import AuthenticatedUser, require_user
from session_logger import dump_screenshot, log_turn
from session_store import Session, create_session, get_session

router = APIRouter(prefix="/sessions", tags=["agent"])


# ── Request / response models ─────────────────────────────────────────────


class StepRequest(BaseModel):
    user_message: str | None = None
    approval: str | None = None             # "approved" | "rejected"
    clarify_choice: str | None = None       # one of the offered options
    browser_results: list[dict] | None = None  # [{tool_use_id, content}, ...]


class SessionEnvelope(BaseModel):
    session_id: str
    status: str
    chats: list[str]
    actions: list[dict]
    plan: list[dict]
    active_step_id: str | None
    pending_approval: dict | None
    pending_clarify: dict | None
    pending_browser_tools: list[dict] | None
    final_report: dict | None
    updated_at: str


def envelope(s: Session) -> SessionEnvelope:
    env = SessionEnvelope(
        session_id=s.id,
        status=s.status,
        chats=list(s.chats),
        actions=list(s.actions),
        plan=[asdict(p) for p in s.plan],
        active_step_id=s.active_step_id,
        pending_approval=s.pending_approval,
        pending_clarify=s.pending_clarify,
        pending_browser_tools=s.pending_browser_tools,
        final_report=s.final_report,
        updated_at=s.updated_at,
    )
    log_turn(s.id, env.model_dump())
    return env


# ── Routes ────────────────────────────────────────────────────────────────


@router.post("", response_model=SessionEnvelope)
def create(user: AuthenticatedUser = Depends(require_user)) -> SessionEnvelope:
    s = create_session(user.sub)
    return envelope(s)


@router.get("/{session_id}", response_model=SessionEnvelope)
def get(session_id: str, user: AuthenticatedUser = Depends(require_user)) -> SessionEnvelope:
    s = get_session(session_id, user.sub)
    if s is None:
        raise HTTPException(status_code=404, detail="session not found")
    return envelope(s)


@router.post("/{session_id}/agent/step", response_model=SessionEnvelope)
def step(
    session_id: str,
    req: StepRequest,
    user: AuthenticatedUser = Depends(require_user),
) -> SessionEnvelope:
    s = get_session(session_id, user.sub)
    if s is None:
        raise HTTPException(status_code=404, detail="session not found")

    # Route the inbound event to the right user-message shape.
    user_input: str | None = None

    if req.user_message:
        # Fresh user message (may also clear a stale pause).
        user_input = req.user_message
        s.pending_approval = None
        s.pending_clarify = None
        if s.status in ("awaiting_approval", "awaiting_clarify"):
            s.status = "active"

    elif req.approval:
        if s.status != "awaiting_approval" or s.pending_approval is None:
            raise HTTPException(status_code=400, detail="no pending approval to respond to")
        choice = req.approval.lower().strip()
        if choice not in ("approved", "rejected"):
            raise HTTPException(status_code=400, detail="approval must be 'approved' or 'rejected'")
        scope = (s.pending_approval.get("scope") or "todo").lower()
        note = (
            f"[user approved the {scope} — proceed]" if choice == "approved"
            else f"[user rejected the {scope} — revise or pause]"
        )
        s.pending_approval = None
        s.status = "active"
        user_input = note

    elif req.clarify_choice:
        if s.status != "awaiting_clarify" or s.pending_clarify is None:
            raise HTTPException(status_code=400, detail="no pending clarify to respond to")
        options = s.pending_clarify.get("options") or []
        if req.clarify_choice not in options:
            raise HTTPException(status_code=400, detail=f"choice must be one of {options}")
        chosen = req.clarify_choice
        s.pending_clarify = None
        s.status = "active"
        user_input = f"[user picked: {chosen}]"

    elif req.browser_results is not None:
        if s.status != "awaiting_browser" or not s.pending_browser_tools:
            raise HTTPException(status_code=400, detail="no pending browser tools to respond to")
        # Validate IDs match what we're waiting for.
        expected_ids = {bt["tool_use_id"] for bt in s.pending_browser_tools}
        got_ids = {r.get("tool_use_id") for r in req.browser_results}
        missing = expected_ids - got_ids
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"missing tool_use_ids in browser_results: {sorted(missing)}",
            )
        # Sniff for screenshots from observe() and dump them. We tag with the
        # turn index for ordering.
        s._screenshot_seq = getattr(s, "_screenshot_seq", 0)  # type: ignore[attr-defined]
        for r in req.browser_results:
            content = r.get("content")
            if isinstance(content, dict) and content.get("screenshot_b64"):
                s._screenshot_seq += 1  # type: ignore[attr-defined]
                label = f"obs_{s._screenshot_seq:02d}"  # type: ignore[attr-defined]
                dump_screenshot(s.id, label, content["screenshot_b64"])
        drive_turn(s, browser_results=req.browser_results)
        return envelope(s)

    else:
        raise HTTPException(
            status_code=400,
            detail="provide exactly one of: user_message, approval, clarify_choice, browser_results",
        )

    drive_turn(s, user_input=user_input)
    return envelope(s)
