"""
SQLite store for users + usage events.

Intentionally tiny: stdlib sqlite3, no ORM. The schema here is append-only
for audit purposes (usage_events) plus an idempotent user upsert.

File location: backend/data.db (ignored by git). Safe to delete to reset.
"""

from __future__ import annotations
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

DB_PATH = Path(__file__).parent / "data.db"

# sqlite3 connections are not thread-safe when shared. We use a lock around
# a single connection for simplicity — fine for this scale. For higher
# concurrency, switch to a per-thread connection or a pool.
_lock = threading.Lock()
_conn: Optional[sqlite3.Connection] = None


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    # WAL gives us concurrent reads while writes are happening.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    """Create tables if they don't exist. Safe to call repeatedly."""
    global _conn
    with _lock:
        if _conn is None:
            _conn = _connect()

        # One-shot migration: drop legacy builder_sessions if it still has the
        # candidate_paths_json column (old harness schema). Dev-only; in-progress
        # sessions are acceptable to lose.
        cols = _conn.execute(
            "SELECT name FROM pragma_table_info('builder_sessions')"
        ).fetchall()
        col_names = {row[0] for row in cols}
        if cols and "candidate_paths_json" in col_names:
            _conn.executescript(
                """
                DROP TABLE IF EXISTS session_messages;
                DROP TABLE IF EXISTS builder_sessions;
                """
            )

        _conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                sub           TEXT PRIMARY KEY,
                email         TEXT,
                name          TEXT,
                picture       TEXT,
                tier          TEXT NOT NULL DEFAULT 'free',
                created_at    TEXT NOT NULL,
                last_seen_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS usage_events (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                user_sub       TEXT NOT NULL,
                session_id     TEXT,
                model          TEXT NOT NULL,
                purpose        TEXT,
                input_tokens   INTEGER NOT NULL DEFAULT 0,
                output_tokens  INTEGER NOT NULL DEFAULT 0,
                cost_usd       REAL NOT NULL DEFAULT 0,
                created_at     TEXT NOT NULL,
                FOREIGN KEY (user_sub) REFERENCES users(sub)
            );

            CREATE INDEX IF NOT EXISTS idx_usage_user_day
                ON usage_events(user_sub, created_at);

            CREATE INDEX IF NOT EXISTS idx_usage_session
                ON usage_events(session_id);

            CREATE TABLE IF NOT EXISTS builder_sessions (
                id                   TEXT PRIMARY KEY,
                user_sub             TEXT NOT NULL,
                status               TEXT NOT NULL,
                intent_spec_json     TEXT NOT NULL,
                site_models_json     TEXT NOT NULL DEFAULT '[]',
                draft_block_graph_json TEXT NOT NULL DEFAULT '[]',
                evidence_ledger_json TEXT NOT NULL DEFAULT '[]',
                gate_state_json      TEXT NOT NULL DEFAULT '[]',
                todo_plan_json       TEXT NOT NULL DEFAULT '{"todos":[]}',
                active_todo_id       TEXT,
                awaiting_approval    INTEGER NOT NULL DEFAULT 0,
                gemini_contents_json TEXT NOT NULL DEFAULT '[]',
                created_at           TEXT NOT NULL,
                updated_at           TEXT NOT NULL,
                FOREIGN KEY (user_sub) REFERENCES users(sub)
            );

            CREATE INDEX IF NOT EXISTS idx_builder_sessions_user_updated
                ON builder_sessions(user_sub, updated_at DESC);

            CREATE TABLE IF NOT EXISTS session_messages (
                id            TEXT PRIMARY KEY,
                session_id    TEXT NOT NULL,
                role          TEXT NOT NULL,
                message_type  TEXT NOT NULL,
                content       TEXT NOT NULL,
                created_at    TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES builder_sessions(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_session_messages_session_created
                ON session_messages(session_id, created_at);

            CREATE TABLE IF NOT EXISTS playbooks (
                id                     TEXT PRIMARY KEY,
                user_sub               TEXT NOT NULL,
                title                  TEXT NOT NULL,
                intent_spec_json       TEXT NOT NULL,
                automation_grade       TEXT NOT NULL DEFAULT 'attended',
                status                 TEXT NOT NULL DEFAULT 'active',
                last_verified_at       TEXT,
                markdown_render        TEXT NOT NULL,
                generalized_inputs_json TEXT NOT NULL DEFAULT '[]',
                loop_hints_json        TEXT NOT NULL DEFAULT '[]',
                branch_hints_json      TEXT NOT NULL DEFAULT '[]',
                source_session_id      TEXT,
                created_at             TEXT NOT NULL,
                updated_at             TEXT NOT NULL,
                FOREIGN KEY (user_sub) REFERENCES users(sub)
            );

            CREATE INDEX IF NOT EXISTS idx_playbooks_user_updated
                ON playbooks(user_sub, updated_at DESC);

            CREATE TABLE IF NOT EXISTS playbook_blocks (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                playbook_id          TEXT NOT NULL,
                block_id             TEXT NOT NULL,
                order_index          INTEGER NOT NULL,
                type                 TEXT NOT NULL,
                title                TEXT NOT NULL,
                config_json          TEXT NOT NULL,
                success_verifier     TEXT NOT NULL,
                failure_policy       TEXT NOT NULL,
                destructive          INTEGER NOT NULL DEFAULT 0,
                requires_human_gate  INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (playbook_id) REFERENCES playbooks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_playbook_blocks_order
                ON playbook_blocks(playbook_id, order_index);
            """
        )


@contextmanager
def _cursor() -> Iterator[sqlite3.Cursor]:
    global _conn
    if _conn is None:
        init_db()
    assert _conn is not None
    with _lock:
        cur = _conn.cursor()
        try:
            yield cur
        finally:
            cur.close()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Users ──────────────────────────────────────────────────────────────────

def upsert_user(user: dict) -> None:
    """Insert or update a user row based on their Google `sub`.

    We refresh email/name/picture on every call in case the user changed them
    in their Google account. We always bump last_seen_at.
    """
    now = _now_iso()
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO users (sub, email, name, picture, tier, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, 'free', ?, ?)
            ON CONFLICT(sub) DO UPDATE SET
                email        = excluded.email,
                name         = excluded.name,
                picture      = excluded.picture,
                last_seen_at = excluded.last_seen_at
            """,
            (
                user.get("sub"),
                user.get("email", ""),
                user.get("name", ""),
                user.get("picture", ""),
                now,
                now,
            ),
        )


def get_user_tier(sub: str) -> str:
    with _cursor() as cur:
        row = cur.execute(
            "SELECT tier FROM users WHERE sub = ?", (sub,)
        ).fetchone()
    return (row["tier"] if row else None) or "free"


# ── Usage ──────────────────────────────────────────────────────────────────

def insert_usage_event(
    *,
    user_sub: str,
    session_id: Optional[str],
    model: str,
    purpose: Optional[str],
    input_tokens: int,
    output_tokens: int,
    cost_usd: float,
) -> None:
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO usage_events
                (user_sub, session_id, model, purpose,
                 input_tokens, output_tokens, cost_usd, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                user_sub,
                session_id,
                model,
                purpose,
                input_tokens,
                output_tokens,
                cost_usd,
                _now_iso(),
            ),
        )


def get_daily_cost_usd(user_sub: str) -> float:
    """Total USD spent by this user today (UTC)."""
    day_start = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00+00:00")
    with _cursor() as cur:
        row = cur.execute(
            """
            SELECT COALESCE(SUM(cost_usd), 0) AS total
            FROM usage_events
            WHERE user_sub = ? AND created_at >= ?
            """,
            (user_sub, day_start),
        ).fetchone()
    return float(row["total"]) if row else 0.0


def get_user_usage_summary(user_sub: str) -> dict[str, Any]:
    """Aggregate usage for display in sidepanel / admin view."""
    with _cursor() as cur:
        totals = cur.execute(
            """
            SELECT
                COALESCE(SUM(input_tokens), 0)  AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cost_usd), 0)      AS cost_usd,
                COUNT(*)                         AS calls
            FROM usage_events
            WHERE user_sub = ?
            """,
            (user_sub,),
        ).fetchone()

    return {
        "input_tokens": int(totals["input_tokens"]),
        "output_tokens": int(totals["output_tokens"]),
        "cost_usd": round(float(totals["cost_usd"]), 6),
        "calls": int(totals["calls"]),
        "today_usd": round(get_daily_cost_usd(user_sub), 6),
    }


# ── Builder Sessions ───────────────────────────────────────────────────────

def create_builder_session(
    *,
    session_id: str,
    user_sub: str,
    status: str,
    intent_spec_json: str,
    site_models_json: str = "[]",
    draft_block_graph_json: str = "[]",
    evidence_ledger_json: str = "[]",
    gate_state_json: str = "[]",
    todo_plan_json: str = '{"todos":[]}',
    active_todo_id: str | None = None,
    awaiting_approval: int = 0,
    gemini_contents_json: str = "[]",
) -> None:
    now = _now_iso()
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO builder_sessions (
                id, user_sub, status, intent_spec_json, site_models_json,
                draft_block_graph_json, evidence_ledger_json, gate_state_json,
                todo_plan_json, active_todo_id, awaiting_approval,
                gemini_contents_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id,
                user_sub,
                status,
                intent_spec_json,
                site_models_json,
                draft_block_graph_json,
                evidence_ledger_json,
                gate_state_json,
                todo_plan_json,
                active_todo_id,
                awaiting_approval,
                gemini_contents_json,
                now,
                now,
            ),
        )


def update_builder_session(
    *,
    session_id: str,
    user_sub: str,
    status: str,
    intent_spec_json: str,
    site_models_json: str,
    draft_block_graph_json: str,
    evidence_ledger_json: str,
    gate_state_json: str,
    todo_plan_json: str,
    active_todo_id: str | None,
    awaiting_approval: int,
    gemini_contents_json: str,
) -> None:
    with _cursor() as cur:
        cur.execute(
            """
            UPDATE builder_sessions
            SET
                status = ?,
                intent_spec_json = ?,
                site_models_json = ?,
                draft_block_graph_json = ?,
                evidence_ledger_json = ?,
                gate_state_json = ?,
                todo_plan_json = ?,
                active_todo_id = ?,
                awaiting_approval = ?,
                gemini_contents_json = ?,
                updated_at = ?
            WHERE id = ? AND user_sub = ?
            """,
            (
                status,
                intent_spec_json,
                site_models_json,
                draft_block_graph_json,
                evidence_ledger_json,
                gate_state_json,
                todo_plan_json,
                active_todo_id,
                awaiting_approval,
                gemini_contents_json,
                _now_iso(),
                session_id,
                user_sub,
            ),
        )
        if cur.rowcount == 0:
            raise KeyError(f"Builder session not found: {session_id}")


def get_builder_session(session_id: str, user_sub: str) -> dict[str, Any] | None:
    with _cursor() as cur:
        row = cur.execute(
            """
            SELECT *
            FROM builder_sessions
            WHERE id = ? AND user_sub = ?
            """,
            (session_id, user_sub),
        ).fetchone()
    return dict(row) if row else None


def insert_session_message(
    *,
    message_id: str,
    session_id: str,
    role: str,
    message_type: str,
    content: str,
) -> None:
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO session_messages
                (id, session_id, role, message_type, content, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                message_id,
                session_id,
                role,
                message_type,
                content,
                _now_iso(),
            ),
        )


def list_session_messages(session_id: str) -> list[dict[str, Any]]:
    with _cursor() as cur:
        rows = cur.execute(
            """
            SELECT id, session_id, role, message_type, content, created_at
            FROM session_messages
            WHERE session_id = ?
            ORDER BY created_at ASC
            """,
            (session_id,),
        ).fetchall()
    return [dict(row) for row in rows]


# ── Playbooks ──────────────────────────────────────────────────────────────

def create_playbook(
    *,
    playbook_id: str,
    user_sub: str,
    title: str,
    intent_spec_json: str,
    automation_grade: str,
    status: str,
    last_verified_at: str | None,
    markdown_render: str,
    generalized_inputs_json: str = "[]",
    loop_hints_json: str = "[]",
    branch_hints_json: str = "[]",
    source_session_id: str | None = None,
) -> None:
    now = _now_iso()
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO playbooks (
                id, user_sub, title, intent_spec_json, automation_grade,
                status, last_verified_at, markdown_render, generalized_inputs_json,
                loop_hints_json, branch_hints_json, source_session_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                playbook_id,
                user_sub,
                title,
                intent_spec_json,
                automation_grade,
                status,
                last_verified_at,
                markdown_render,
                generalized_inputs_json,
                loop_hints_json,
                branch_hints_json,
                source_session_id,
                now,
                now,
            ),
        )


def insert_playbook_block(
    *,
    playbook_id: str,
    block_id: str,
    order_index: int,
    block_type: str,
    title: str,
    config_json: str,
    success_verifier: str,
    failure_policy: str,
    destructive: bool,
    requires_human_gate: bool,
) -> None:
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO playbook_blocks (
                playbook_id, block_id, order_index, type, title, config_json,
                success_verifier, failure_policy, destructive, requires_human_gate
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                playbook_id,
                block_id,
                order_index,
                block_type,
                title,
                config_json,
                success_verifier,
                failure_policy,
                1 if destructive else 0,
                1 if requires_human_gate else 0,
            ),
        )


def get_playbook(playbook_id: str, user_sub: str) -> dict[str, Any] | None:
    with _cursor() as cur:
        row = cur.execute(
            """
            SELECT *
            FROM playbooks
            WHERE id = ? AND user_sub = ?
            """,
            (playbook_id, user_sub),
        ).fetchone()
    return dict(row) if row else None


def list_playbooks(user_sub: str) -> list[dict[str, Any]]:
    with _cursor() as cur:
        rows = cur.execute(
            """
            SELECT *
            FROM playbooks
            WHERE user_sub = ?
            ORDER BY updated_at DESC
            """,
            (user_sub,),
        ).fetchall()
    return [dict(row) for row in rows]


def list_playbook_blocks(playbook_id: str) -> list[dict[str, Any]]:
    with _cursor() as cur:
        rows = cur.execute(
            """
            SELECT playbook_id, block_id, order_index, type, title, config_json,
                   success_verifier, failure_policy, destructive, requires_human_gate
            FROM playbook_blocks
            WHERE playbook_id = ?
            ORDER BY order_index ASC
            """,
            (playbook_id,),
        ).fetchall()
    return [dict(row) for row in rows]


# Initialise on import so the rest of the app can call helpers directly.
init_db()
