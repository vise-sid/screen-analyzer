"""
Score a session log against an eval definition.

  python scripts/score_eval.py evals/using-the-browser.jsonl <session_id>

Reads:
  evals/using-the-browser.jsonl  (eval definitions, one JSON object per line)
  evals/results/<session_id>/turns.jsonl  (per-turn envelopes the backend logged)
  evals/results/<session_id>/*.png  (any screenshots dumped during the session)

Prints a pass/fail breakdown per behavior check and prompts for outcome
verification (manual review of the final screenshot).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parent.parent
EVALS_DIR = ROOT / "evals"
RESULTS_ROOT = EVALS_DIR / "results"


def load_eval(eval_file: Path, eval_id: str | None = None) -> dict:
    for line in eval_file.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)
        if eval_id is None or obj.get("id") == eval_id:
            return obj
    raise SystemExit(f"no eval matching id={eval_id} in {eval_file}")


def load_session(session_id: str) -> tuple[list[dict], list[Path]]:
    sdir = RESULTS_ROOT / session_id
    if not sdir.exists():
        raise SystemExit(f"no session log at {sdir}")
    turns_path = sdir / "turns.jsonl"
    if not turns_path.exists():
        raise SystemExit(f"no turns.jsonl in {sdir}")
    turns = [json.loads(line) for line in turns_path.read_text().splitlines() if line.strip()]
    screenshots = sorted(sdir.glob("*.png"))
    return turns, screenshots


def flatten_actions(turns: list[dict]) -> list[dict]:
    """Each turn envelope has its own actions list. Concatenate, tagging each
    with its turn_index for after-action ordering."""
    out: list[dict] = []
    for t in turns:
        for a in t.get("actions", []) or []:
            out.append({**a, "_turn": t.get("turn_index", 0)})
    return out


def check_behavior(check: dict, actions: list[dict]) -> tuple[bool, str]:
    # Support `matcher_any` (OR semantics): pass if ANY sub-matcher matches.
    if "matcher_any" in check:
        for sub in check["matcher_any"]:
            ok, note = check_behavior({"matcher": sub}, actions)
            if ok:
                return True, f"any-of: {note}"
        return False, "no sub-matcher matched"

    matcher = check.get("matcher", {})
    name = matcher.get("action_name")
    kind = matcher.get("action_kind")
    matching = [
        a for a in actions
        if (name is None or a.get("name") == name)
        and (kind is None or a.get("kind") == kind)
    ]

    # Argument filters.
    arg_url_inc = matcher.get("arg_url_includes")
    if arg_url_inc is not None:
        matching = [a for a in matching if arg_url_inc in str((a.get("args") or {}).get("url", ""))]
    arg_task = matcher.get("arg_task")
    if arg_task is not None:
        matching = [a for a in matching if (a.get("args") or {}).get("task") == arg_task]

    count = len(matching)

    args_count_min = matcher.get("args_count_min")
    if args_count_min is not None and count < args_count_min:
        return False, f"only {count} matching actions; need ≥{args_count_min}"

    max_count = matcher.get("max_count")
    if max_count is not None and count > max_count:
        return False, f"{count} matching actions exceeds cap of {max_count}"

    min_after = matcher.get("min_after_action_index")
    if min_after is not None:
        # Need at least one matching action whose position in the action stream
        # is greater than `min_after` (loose proxy for "after the username step").
        if not any(idx >= min_after for idx, a in enumerate(actions) if a in matching):
            return False, f"no matching action after index {min_after}"

    if count == 0 and args_count_min is None and max_count is None:
        return False, "no matching action found"

    return True, f"matched {count} action(s)"


def run(eval_file: str, session_id: str, eval_id: str | None) -> int:
    eval_def = load_eval(Path(eval_file), eval_id)
    turns, screenshots = load_session(session_id)
    actions = flatten_actions(turns)

    print(f"\n══════ EVAL: {eval_def['id']} ══════")
    print(f"  session: {session_id}")
    print(f"  turns logged: {len(turns)}")
    print(f"  total actions: {len(actions)}")
    print(f"  screenshots: {len(screenshots)}")
    print()

    print("── BEHAVIOR CHECKS ──")
    behavior_pass = 0
    behavior_total = 0
    for check in eval_def.get("behavior_checks", []):
        behavior_total += 1
        ok, note = check_behavior(check, actions)
        marker = "✓" if ok else "✗"
        if ok:
            behavior_pass += 1
        print(f"  {marker} [{check['id']}] {check['desc']}")
        print(f"      → {note}")

    print()
    print("── OUTCOME CHECK ──")
    outcome = eval_def.get("outcome_check") or {}
    if outcome.get("type") == "manual_screenshot":
        if screenshots:
            print(f"  Screenshots in {RESULTS_ROOT / session_id}:")
            for s in screenshots:
                print(f"    - {s.name}")
        else:
            print("  ⚠ No screenshots dumped — agent may not have taken a final shot.")
        print()
        print(f"  Verifier prompt:")
        print(f"    {outcome.get('verifier_prompt')}")
        print()
        print("  Open the final screenshot, judge pass/fail manually.")
    else:
        print(f"  (no outcome check defined; type={outcome.get('type')!r})")

    # Final agent state.
    final = turns[-1] if turns else {}
    print()
    print("── FINAL SESSION STATE ──")
    print(f"  status: {final.get('status')}")
    if final.get("final_report"):
        rep = final["final_report"]
        print(f"  report.summary: {(rep.get('summary') or '')[:200]}")
    print()
    print(f"BEHAVIOR: {behavior_pass}/{behavior_total} passed")
    return 0 if behavior_pass == behavior_total else 1


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    eval_file = sys.argv[1]
    session_id = sys.argv[2]
    eval_id = sys.argv[3] if len(sys.argv) > 3 else None
    return run(eval_file, session_id, eval_id)


if __name__ == "__main__":
    sys.exit(main())
