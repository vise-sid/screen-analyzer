"""
Mock implementations of the 9 programmatic primitives.

For Option A (agent loop proof). These stand in for the real browser (via
CDP over the extension) and the real Google Workspace APIs so we can
iterate on the loop shape in seconds instead of minutes.

Every mock returns a JSON-serializable dict the way the real tool would.
Keep them boringly predictable — the point is exercising the loop, not
simulating the web.
"""
from __future__ import annotations

import random
from typing import Any


def _observe(args: dict) -> dict:
    include = args.get("include") or ["snapshot"]
    out: dict[str, Any] = {"ok": True, "included": include, "url": "https://mock.example.com/page"}
    if "snapshot" in include:
        out["snapshot"] = (
            "page title: Mock Page\n"
            "interactive:\n"
            "  button[ref=e1] 'Search'\n"
            "  textbox[ref=e2] 'Query'\n"
            "  link[ref=e3] 'Next page' href=/next\n"
        )
    if "screenshot" in include:
        # Real tool returns base64 bytes. Mock returns a placeholder marker.
        out["screenshot_b64"] = "data:image/png;base64,MOCK"
    if "network" in include:
        out["network"] = [{"url": "https://mock.example.com/api/search", "method": "GET", "status": 200}]
    return out


def _navigate(args: dict) -> dict:
    return {"ok": True, "url": args.get("url"), "loaded_in_ms": random.randint(120, 420)}


def _click(args: dict) -> dict:
    return {"ok": True, "ref": args.get("ref")}


def _type(args: dict) -> dict:
    return {
        "ok": True,
        "ref": args.get("ref"),
        "chars_typed": len(args.get("text", "")),
        "submitted": bool(args.get("submit")),
    }


def _key(args: dict) -> dict:
    return {"ok": True, "key": args.get("key")}


def _scroll(args: dict) -> dict:
    return {"ok": True, "deltaY": args.get("deltaY", 0)}


def _workspace(args: dict) -> dict:
    api = args.get("api", "")
    payload = args.get("args") or {}
    if api == "sheets_create":
        return {
            "ok": True,
            "spreadsheet_id": "mock-sheet-" + str(random.randint(1000, 9999)),
            "url": "https://docs.google.com/spreadsheets/d/MOCK",
            "title": payload.get("title", "Untitled"),
        }
    if api == "sheets_write":
        return {"ok": True, "range": payload.get("range"), "rows_written": len(payload.get("values") or [])}
    if api == "sheets_read":
        return {"ok": True, "values": [["mock", "row", "1"], ["mock", "row", "2"]]}
    if api.startswith("docs_"):
        return {"ok": True, "document_id": "mock-doc-1234", "url": "https://docs.google.com/document/d/MOCK"}
    if api.startswith("slides_"):
        return {"ok": True, "presentation_id": "mock-deck-1234", "url": "https://docs.google.com/presentation/d/MOCK"}
    return {"ok": False, "error": f"mock workspace: unknown api {api!r}"}


def _reauth_google(_: dict) -> dict:
    return {"ok": True, "message": "mock reauth ok"}


def _vision(args: dict) -> dict:
    task = args.get("task")
    if task == "captcha":
        return {"ok": True, "answer": "MOCK-CAPTCHA-42", "confidence": 0.87}
    if task == "describe":
        return {"ok": True, "description": "Mock image: appears to be a pixel-art fox."}
    if task == "extract_form":
        return {"ok": True, "fields": [{"name": "email", "kind": "text"}, {"name": "password", "kind": "password"}]}
    return {"ok": False, "error": f"mock vision: unknown task {task!r}"}


_DISPATCH = {
    "observe": _observe,
    "navigate": _navigate,
    "click": _click,
    "type": _type,
    "key": _key,
    "scroll": _scroll,
    "workspace": _workspace,
    "reauth_google": _reauth_google,
    "vision": _vision,
}


def execute_programmatic(name: str, args: dict) -> dict:
    """Dispatch a programmatic tool call from the sandbox to its mock."""
    fn = _DISPATCH.get(name)
    if fn is None:
        return {"ok": False, "error": f"mock: no handler for tool {name!r}"}
    try:
        return fn(args or {})
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"mock {name} raised: {type(e).__name__}: {e}"}
