"""
Per-session JSONL logger for evals.

Every /sessions/{id}/agent/step appends one line to:
  evals/results/<session_id>/turns.jsonl

Each line is the envelope dict (status, chats, actions, plan, pending_*,
final_report) from that turn, plus a turn_index and iso timestamp.

We also dump screenshots from observe(include=["screenshot"]) results
into the same folder as <turn_index>_<seq>.png so the scorer can find
them after the fact.

Disabled when PIXEL_LOG_SESSIONS=0.
"""
from __future__ import annotations

import base64
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOG_ENABLED = os.getenv("PIXEL_LOG_SESSIONS", "1") != "0"
RESULTS_ROOT = Path(__file__).parent.parent / "evals" / "results"


def _session_dir(session_id: str) -> Path:
    p = RESULTS_ROOT / session_id
    p.mkdir(parents=True, exist_ok=True)
    return p


def log_turn(session_id: str, envelope_dict: dict[str, Any]) -> None:
    """Append one turn's envelope to the session log."""
    if not LOG_ENABLED:
        return
    try:
        path = _session_dir(session_id) / "turns.jsonl"
        # Find next turn index by counting existing lines.
        idx = 0
        if path.exists():
            with path.open() as f:
                idx = sum(1 for _ in f)
        record = {
            "turn_index": idx,
            "ts": datetime.now(timezone.utc).isoformat(),
            **envelope_dict,
        }
        with path.open("a") as f:
            f.write(json.dumps(record, default=str) + "\n")
    except Exception as e:
        print(f"[session_logger] failed to log turn: {e}")


def maybe_dump_screenshots(session_id: str, turn_index: int, actions: list[dict]) -> list[str]:
    """If any observe() actions in this turn returned screenshots in their
    tool_result, dump them. We don't have the result here — only the args —
    so this is a stub. Real screenshot dump happens via the result-aware
    helper in agent.py (called when we synthesize the tool_result).

    Kept here for symmetry; actual dumper lives below.
    """
    return []


def dump_screenshot(session_id: str, label: str, b64: str) -> str | None:
    """Dump a base64 PNG to the session dir. Returns the file path."""
    if not LOG_ENABLED or not b64:
        return None
    raw = b64
    if "," in raw and raw.lstrip().startswith("data:"):
        raw = raw.split(",", 1)[1]
    try:
        data = base64.b64decode(raw)
        # Sanitize label for filename use.
        safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in label)[:80]
        path = _session_dir(session_id) / f"{safe}.png"
        path.write_bytes(data)
        return str(path)
    except Exception as e:
        print(f"[session_logger] screenshot dump failed: {e}")
        return None
