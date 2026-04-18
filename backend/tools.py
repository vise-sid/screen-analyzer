"""
Primitive tool surface — the entire tool set the agent sees.

Two classes:
  - PROGRAMMATIC tools (allowed_callers=["code_execution_20260120"])
    callable from inside Claude's Python sandbox; intermediate results
    stay in the sandbox and never enter the model's context.

  - DIRECT tools (no allowed_callers)
    must be called by the model directly — these touch the user
    (chat narration, plan, approval, clarify, report).

Plus the built-in code_execution tool that hosts programmatic calls.

Domain knowledge (when/how to use sheets, how to verify, recovery patterns,
etc.) lives in skills, NOT in tool descriptions here.
"""
from __future__ import annotations

# ── Programmatic primitives (callable from agent's code) ──────────────────

OBSERVE = {
    "name": "observe",
    "description": "Inspect the active browser tab. Returns any combination of: a11y snapshot (with stable refs), screenshot bytes, captured XHR/Fetch network traffic. Pass `include` to control what's returned.",
    "input_schema": {
        "type": "object",
        "properties": {
            "include": {
                "type": "array",
                "items": {"type": "string", "enum": ["snapshot", "screenshot", "network"]},
                "description": "Which observations to return. Default: ['snapshot'].",
            },
        },
    },
    "allowed_callers": ["code_execution_20260120"],
}

NAVIGATE = {
    "name": "navigate",
    "description": "Navigate the active tab to a URL. Returns when the page reaches readyState=complete or the timeout elapses.",
    "input_schema": {
        "type": "object",
        "properties": {"url": {"type": "string"}},
        "required": ["url"],
    },
    "allowed_callers": ["code_execution_20260120"],
}

CLICK = {
    "name": "click",
    "description": "Click an element identified by its accessibility ref (from a prior observe() snapshot).",
    "input_schema": {
        "type": "object",
        "properties": {"ref": {"type": "string"}},
        "required": ["ref"],
    },
    "allowed_callers": ["code_execution_20260120"],
}

TYPE = {
    "name": "type",
    "description": "Focus a field by ref and type text. Set submit=true to press Enter after.",
    "input_schema": {
        "type": "object",
        "properties": {
            "ref": {"type": "string"},
            "text": {"type": "string"},
            "submit": {"type": "boolean", "default": False},
        },
        "required": ["ref", "text"],
    },
    "allowed_callers": ["code_execution_20260120"],
}

KEY = {
    "name": "key",
    "description": "Press a single key on the focused element. Examples: 'Enter', 'Escape', 'ArrowDown', 'Tab'.",
    "input_schema": {
        "type": "object",
        "properties": {"key": {"type": "string"}},
        "required": ["key"],
    },
    "allowed_callers": ["code_execution_20260120"],
}

SCROLL = {
    "name": "scroll",
    "description": "Scroll the active tab vertically. Positive deltaY scrolls down.",
    "input_schema": {
        "type": "object",
        "properties": {"deltaY": {"type": "integer"}},
        "required": ["deltaY"],
    },
    "allowed_callers": ["code_execution_20260120"],
}

WORKSPACE = {
    "name": "workspace",
    "description": "Dispatcher for Google Workspace operations (Sheets, Docs, Slides). The `api` field selects the operation; `args` is the operation-specific payload. See the workspace-* skills for available APIs and patterns. Returns {ok: bool, ...} — on auth errors, the error string includes a hint to call reauth_google().",
    "input_schema": {
        "type": "object",
        "properties": {
            "api": {
                "type": "string",
                "description": "Operation name: sheets_create, sheets_write, sheets_read, docs_create, docs_write, docs_read, slides_create, slides_read.",
            },
            "args": {"type": "object", "description": "Operation-specific arguments."},
        },
        "required": ["api", "args"],
    },
    "allowed_callers": ["code_execution_20260120"],
}

REAUTH_GOOGLE = {
    "name": "reauth_google",
    "description": "Force a fresh Google OAuth flow in the extension. Call after a workspace() error mentioning auth/token/401/403, then retry the same workspace call.",
    "input_schema": {"type": "object", "properties": {}},
    "allowed_callers": ["code_execution_20260120"],
}

VISION = {
    "name": "vision",
    "description": "Hand off a single-shot multimodal task to Gemini Flash 3 (cheaper for image-only inference). Tasks: 'captcha' (image → answer), 'describe' (image + prompt → text), 'extract_form' (image → field map).",
    "input_schema": {
        "type": "object",
        "properties": {
            "task": {"type": "string", "enum": ["captcha", "describe", "extract_form"]},
            "image_b64": {"type": "string", "description": "Base64-encoded image bytes."},
            "prompt": {"type": "string", "description": "Optional prompt for 'describe' task."},
        },
        "required": ["task", "image_b64"],
    },
    "allowed_callers": ["code_execution_20260120"],
}

# ── Direct tools (model-only; touch the user-facing UI) ───────────────────

CHAT = {
    "name": "chat",
    "description": "Speak one short line to the user. ALWAYS pair with another tool call in the same turn. chat() alone is a hard failure.",
    "input_schema": {
        "type": "object",
        "properties": {"message": {"type": "string"}},
        "required": ["message"],
    },
}

SET_PLAN = {
    "name": "set_plan",
    "description": "Declare or replace the active plan. Each step has an id and a one-line title. Use mode='replace' to wipe the existing plan, mode='extend' to append.",
    "input_schema": {
        "type": "object",
        "properties": {
            "mode": {"type": "string", "enum": ["replace", "extend"], "default": "replace"},
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "title": {"type": "string"},
                        "description": {"type": "string"},
                    },
                    "required": ["id", "title"],
                },
            },
        },
        "required": ["steps"],
    },
}

REQUEST_APPROVAL = {
    "name": "request_approval",
    "description": "Pause for user approval. scope='plan' is the ONE-TIME approval right after set_plan; scope='todo' is ONLY for destructive actions and requires `reason` to be one of the destructive whitelist (see gating-destructive-actions skill).",
    "input_schema": {
        "type": "object",
        "properties": {
            "scope": {"type": "string", "enum": ["plan", "todo"]},
            "step_id": {"type": "string"},
            "reason": {
                "type": "string",
                "enum": [
                    "sends_message",
                    "submits_payment",
                    "deletes_data",
                    "posts_publicly",
                    "external_write",
                    "irreversible_state_change",
                ],
            },
            "preview": {"type": "string"},
        },
        "required": ["scope"],
    },
}

CLARIFY = {
    "name": "clarify",
    "description": "Ask the user a pathway-fork question. ONLY for genuine choices with real tradeoffs — never for confirming the obvious next step. Requires ≥2 distinct options.",
    "input_schema": {
        "type": "object",
        "properties": {
            "question": {"type": "string"},
            "why": {"type": "string"},
            "options": {
                "type": "array",
                "items": {"type": "string"},
                "minItems": 2,
            },
        },
        "required": ["question", "why", "options"],
    },
}

DONE = {
    "name": "done",
    "description": "Mark a plan step complete with a short summary of what was achieved. After calling done(), IMMEDIATELY start the next step's first tool in the SAME turn — do not pause to ask.",
    "input_schema": {
        "type": "object",
        "properties": {
            "step_id": {"type": "string"},
            "summary": {"type": "string"},
        },
        "required": ["step_id", "summary"],
    },
}

REPORT = {
    "name": "report",
    "description": "TERMINAL — the session's final user-facing summary. Call when all plan steps are done. If the work is repeatable, set save_playbook=true and include generalized_inputs (the parameters a future rerun would change).",
    "input_schema": {
        "type": "object",
        "properties": {
            "summary": {"type": "string"},
            "artifacts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "url": {"type": "string"},
                        "kind": {"type": "string"},
                    },
                    "required": ["name"],
                },
            },
            "surprises": {"type": "array", "items": {"type": "string"}},
            "next_steps_for_user": {"type": "string"},
            "save_playbook": {"type": "boolean", "default": False},
            "playbook_title": {"type": "string"},
            "generalized_inputs": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "description": {"type": "string"},
                        "example_value": {"type": "string"},
                    },
                    "required": ["name", "description"],
                },
            },
        },
        "required": ["summary"],
    },
}


# ── The full toolset the agent sees ───────────────────────────────────────

PROGRAMMATIC_TOOLS = [
    OBSERVE, NAVIGATE, CLICK, TYPE, KEY, SCROLL,
    WORKSPACE, REAUTH_GOOGLE, VISION,
]

DIRECT_TOOLS = [CHAT, SET_PLAN, REQUEST_APPROVAL, CLARIFY, DONE, REPORT]

CODE_EXECUTION_TOOL = {"type": "code_execution_20260120", "name": "code_execution"}

ALL_TOOLS: list[dict] = [CODE_EXECUTION_TOOL] + PROGRAMMATIC_TOOLS + DIRECT_TOOLS
