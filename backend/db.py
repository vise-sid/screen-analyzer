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


# Initialise on import so the rest of the app can call helpers directly.
init_db()
