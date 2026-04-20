"""
Backend-executed programmatic tool dispatcher.

When the agent's sandbox calls one of vision()/secret()/workspace(), the
agent loop routes here. We execute in-process and return a JSON-serializable
dict the model can read in the tool_result.

Tools handled here:
  - secret  → env var lookup, allowlisted
  - vision  → POST localhost:8000/vision/* (Gemini Flash 3)
  - workspace → still a mock until we wire Google access tokens

A 2-attempt cap is enforced for vision(task="captcha") on a per-session
basis. After two failures the session is hard-stopped to avoid lockouts.
"""
from __future__ import annotations

import os
from typing import Any

import httpx

from session_store import Session

# ── Secret allowlist ───────────────────────────────────────────────────────
# Only these env vars can be fetched via secret(). Adding the agent's main
# context to a giant key/value store is exactly what we want to avoid.
SECRET_ALLOWLIST = {
    "GST_TEST_USERNAME",
    "GST_TEST_PASSWORD",
}

# Captcha attempts cap — set on the user's instruction (slice C eval).
MAX_CAPTCHA_ATTEMPTS = int(os.getenv("PIXEL_MAX_CAPTCHA_ATTEMPTS", "2"))

VISION_BASE = os.getenv("PIXEL_VISION_BASE_URL", "http://127.0.0.1:8000/vision")
HTTP_TIMEOUT = httpx.Timeout(30.0)


def _secret(args: dict, _session: Session) -> dict:
    name = (args.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "secret(name=...) requires a name"}
    if name not in SECRET_ALLOWLIST:
        return {
            "ok": False,
            "error": (
                f"secret {name!r} not in allowlist. "
                f"Allowed: {sorted(SECRET_ALLOWLIST)}"
            ),
        }
    val = os.environ.get(name)
    if not val:
        return {"ok": False, "error": f"secret {name!r} is allowlisted but not set in env"}
    return {"ok": True, "value": val}


def _vision(args: dict, session: Session) -> dict:
    task = (args.get("task") or "").strip()
    image_b64 = args.get("image_b64") or ""
    prompt = args.get("prompt") or ""

    if not task or not image_b64:
        return {"ok": False, "error": "vision requires task + image_b64"}

    # Captcha lockout safety — set early in the user's instruction.
    if task == "captcha":
        attempts = getattr(session, "_captcha_attempts", 0) + 1
        session._captcha_attempts = attempts  # type: ignore[attr-defined]
        if attempts > MAX_CAPTCHA_ATTEMPTS:
            return {
                "ok": False,
                "error": (
                    f"refusing to attempt captcha #{attempts}: hard cap is "
                    f"{MAX_CAPTCHA_ATTEMPTS}. Stop and surface this to the user."
                ),
                "captcha_attempts": attempts,
                "lockout_risk": True,
            }

    endpoint_map = {
        "captcha": "/captcha",
        "describe": "/describe",
        "extract_form": "/extract_form",
    }
    path = endpoint_map.get(task)
    if path is None:
        return {"ok": False, "error": f"unknown vision task {task!r}"}

    payload: dict[str, Any] = {"image_b64": image_b64}
    if task == "describe" and prompt:
        payload["prompt"] = prompt

    try:
        with httpx.Client(timeout=HTTP_TIMEOUT) as http:
            r = http.post(f"{VISION_BASE}{path}", json=payload)
            if r.status_code != 200:
                return {"ok": False, "error": f"vision {task} failed: {r.status_code} {r.text[:200]}"}
            data = r.json()
    except Exception as e:
        return {"ok": False, "error": f"vision {task} call raised: {e}"}

    if task == "captcha":
        data["captcha_attempts"] = getattr(session, "_captcha_attempts", 0)
    return data


def _workspace(args: dict, _session: Session) -> dict:
    # Mock until we wire Google Workspace access tokens. Returns predictable
    # shapes so the agent can keep going.
    api = (args.get("api") or "").strip()
    payload = args.get("args") or {}
    if api == "sheets_create":
        return {
            "ok": True,
            "spreadsheet_id": "mock-sheet-1234",
            "url": "https://docs.google.com/spreadsheets/d/MOCK",
            "title": payload.get("title", "Untitled"),
            "_mock": True,
        }
    if api == "sheets_write":
        return {"ok": True, "range": payload.get("range"), "rows_written": len(payload.get("values") or []), "_mock": True}
    if api == "sheets_read":
        return {"ok": True, "values": [["mock", "data"]], "_mock": True}
    return {"ok": False, "error": f"workspace api {api!r} not yet wired (mock)"}


_DISPATCH = {
    "secret": _secret,
    "vision": _vision,
    "workspace": _workspace,
}


def execute_backend_tool(name: str, args: dict, session: Session) -> dict:
    fn = _DISPATCH.get(name)
    if fn is None:
        return {"ok": False, "error": f"backend has no dispatcher for tool {name!r}"}
    try:
        return fn(args or {}, session)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{name} raised: {type(e).__name__}: {e}"}
