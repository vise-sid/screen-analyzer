"""
Option A smoke test — drive the agent loop end-to-end with mock primitives.

Boots a single in-process Session (no HTTP, no auth), calls drive_turn()
with a user message, and prints what happened each turn. Continues the
session through approval / clarify / report pauses by feeding simulated
user responses.

Usage:
  # from repo root, with backend/.env loaded
  backend/.venv/bin/python scripts/test_agent_loop.py "log today's AQI for Mumbai to a sheet"
  backend/.venv/bin/python scripts/test_agent_loop.py   # uses a default prompt

Run count each Anthropic call — expected: ≤ MAX_LOOP_ITERATIONS per turn,
≤ ~3 turns per session for simple scenarios.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Make backend/ importable.
ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from agent import drive_turn  # noqa: E402
from session_store import create_session  # noqa: E402


def print_turn_report(session, turn_label: str) -> None:
    print(f"\n──── {turn_label} ────")
    print(f"  status: {session.status}")
    if session.chats:
        for c in session.chats:
            print(f"  chat: {c}")
    if session.actions:
        for a in session.actions:
            kind = a["kind"]
            name = a["name"]
            args = a.get("args") or {}
            short = {k: (str(v)[:60] + "…" if len(str(v)) > 60 else v) for k, v in args.items()}
            print(f"  action [{kind:12}] {name}({short})")
    if session.plan:
        print("  plan:")
        for p in session.plan:
            marker = {"done": "x", "running": "*", "failed": "!", "skipped": "-"}.get(p.status, " ")
            print(f"    [{marker}] {p.id}: {p.title}")
    if session.pending_approval:
        print(f"  awaiting approval: {json.dumps(session.pending_approval)[:200]}")
    if session.pending_clarify:
        print(f"  awaiting clarify: {json.dumps(session.pending_clarify)[:200]}")
    if session.final_report:
        print(f"  report: {json.dumps(session.final_report)[:300]}…")


def main() -> int:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY missing — source backend/.env first", file=sys.stderr)
        return 2

    prompt = (
        " ".join(sys.argv[1:]).strip()
        or "Navigate to example.com, tell me what you see, and log a single row "
        "'hello, 42' to a sheet titled 'Option A smoke'."
    )

    print(f"user: {prompt}")
    s = create_session(user_sub="test-user")

    # Turn 1: initial user message.
    drive_turn(s, user_input=prompt)
    print_turn_report(s, "TURN 1 (initial)")

    # Auto-respond to any pauses for up to a few more turns so the script
    # completes without hanging on interactive input.
    for turn_idx in range(2, 8):
        if s.status == "done":
            break
        if s.status == "awaiting_approval":
            scope = (s.pending_approval or {}).get("scope", "todo")
            print(f"\n(auto-approving the {scope})")
            # Clear pending state BEFORE driving so drive_turn's own status
            # writes (e.g. report → "done") aren't clobbered after.
            s.pending_approval = None
            s.status = "active"
            drive_turn(s, user_input=f"[user approved the {scope} — proceed]")
        elif s.status == "awaiting_clarify":
            options = (s.pending_clarify or {}).get("options") or []
            chosen = options[0] if options else "first"
            print(f"\n(auto-picking clarify option: {chosen!r})")
            s.pending_clarify = None
            s.status = "active"
            drive_turn(s, user_input=f"[user picked: {chosen}]")
        else:
            print("\n(status is neither done nor paused — stopping)")
            break
        print_turn_report(s, f"TURN {turn_idx}")

    print("\n──── DONE ────")
    print(f"final status: {s.status}")
    print(f"messages in history: {len(s.messages)}")
    print(f"container_id: {s.container_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
