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

# Locators use the `by` parameter to map directly to Playwright's preferred
# locator builders (page.getByRole / getByLabel / getByPlaceholder / etc.).
# This avoids the string-selector grammar trap entirely.
_LOCATOR_PROPS = {
    "by": {
        "type": "string",
        "enum": ["role", "label", "placeholder", "text", "testid", "css"],
        "description": (
            "Locator strategy — maps 1:1 to Playwright methods: "
            "role→getByRole, label→getByLabel, placeholder→getByPlaceholder, "
            "text→getByText, testid→getByTestId, css→raw CSS (escape hatch)."
        ),
    },
    "name": {
        "type": "string",
        "description": (
            "The accessible name / label / placeholder / text / testid value. "
            "Required for by ∈ {role, label, placeholder, text, testid}. "
            "For by=role, this is the accessible name (e.g. 'LOGIN' for a button)."
        ),
    },
    "role": {
        "type": "string",
        "description": (
            "ARIA role (only used when by='role'). E.g. 'button', 'textbox', 'link', 'checkbox'."
        ),
    },
    "exact": {
        "type": "boolean",
        "description": "Exact match for name/text? Default false (case-insensitive substring).",
        "default": False,
    },
    "selector": {
        "type": "string",
        "description": "Raw CSS selector (only used when by='css').",
    },
    "n": {
        "type": "integer",
        "description": "Pick the nth match (0-indexed). Default 0 — i.e. first match.",
        "default": 0,
    },
}

CLICK = {
    "name": "click",
    "description": (
        "Click an element. Uses Playwright's recommended locator methods "
        "(getByRole, getByLabel, etc.) — no selector strings. Auto-waits for "
        "actionability. Returns ok:false with a clear error if no element matches."
    ),
    "input_schema": {
        "type": "object",
        "properties": _LOCATOR_PROPS,
        "required": ["by"],
    },
    "allowed_callers": ["code_execution_20260120"],
}

TYPE = {
    "name": "type",
    "description": (
        "Focus a field via locator and type text with real keystrokes (per-char "
        "jitter, dispatches keydown/keyup the way humans do). Verifies the "
        "value actually landed in the field — returns ok:false if length "
        "mismatch. Set submit=true to press Enter after typing."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            **_LOCATOR_PROPS,
            "text": {"type": "string", "description": "Text to type (real keystrokes)."},
            "submit": {"type": "boolean", "default": False, "description": "Press Enter after typing?"},
        },
        "required": ["by", "text"],
    },
    "allowed_callers": ["code_execution_20260120"],
}

KEY = {
    "name": "key",
    "description": "Press a key on the active element. Examples: 'Enter', 'Escape', 'ArrowDown', 'Tab'.",
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

LIST_TABS = {
    "name": "list_tabs",
    "description": (
        "List all open browser tabs. Returns {ok, tabs: [{id, url, title, active, agent_attached}, ...]}. "
        "Use this BEFORE opening a new tab — if the target site is already open in another tab, "
        "switch to it via switch_tab(tab_id=...) instead of navigate()."
    ),
    "input_schema": {"type": "object", "properties": {}},
    "allowed_callers": ["code_execution_20260120"],
}

SWITCH_TAB = {
    "name": "switch_tab",
    "description": (
        "Attach the agent's browser session to an existing tab by id (from list_tabs). "
        "All subsequent navigate / click / observe / type / etc. operate on this tab. "
        "Returns {ok, url, title}. Fails if the tab doesn't exist or is on a restricted URL "
        "(chrome://, about:, etc)."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "tab_id": {"type": "integer", "description": "The tab id from list_tabs()."},
        },
        "required": ["tab_id"],
    },
    "allowed_callers": ["code_execution_20260120"],
}

WAIT_FOR = {
    "name": "wait_for",
    "description": (
        "Wait for a condition on the page. Three modes: "
        "(1) wait for a locator's state — pass `by`+`name`/`role`/`selector` and "
        "`state` ∈ {visible, hidden, attached, detached}. "
        "(2) wait for URL — pass `url_pattern` (substring or regex). "
        "(3) wait for load state — pass `load_state` ∈ {load, domcontentloaded, networkidle}. "
        "All wait modes auto-retry until the condition holds or timeout."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            **_LOCATOR_PROPS,
            "state": {
                "type": "string",
                "enum": ["visible", "hidden", "attached", "detached"],
                "description": "Locator state to wait for (used with by/name/etc).",
            },
            "url_pattern": {
                "type": "string",
                "description": "Substring of the page URL to wait for (e.g. '/dashboard').",
            },
            "load_state": {
                "type": "string",
                "enum": ["load", "domcontentloaded", "networkidle"],
                "description": "Page load state to wait for.",
            },
            "timeout_ms": {
                "type": "integer",
                "description": "Max wait time. Default 8000.",
                "default": 8000,
            },
        },
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

SECRET = {
    "name": "secret",
    "description": (
        "Fetch a secret value (credential, API key, etc.) from the backend's "
        "secret store by name. The value is returned ONLY to your code-execution "
        "sandbox — it never enters your main conversation context. Use this for "
        "passwords, API tokens, anything you must not see in chat. Allowed names "
        "are limited; see error messages for the allowlist."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Secret name from the backend allowlist (e.g. GST_TEST_PASSWORD).",
            },
        },
        "required": ["name"],
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
    OBSERVE, NAVIGATE, CLICK, TYPE, KEY, SCROLL, WAIT_FOR,
    LIST_TABS, SWITCH_TAB,
    WORKSPACE, REAUTH_GOOGLE, VISION, SECRET,
]

DIRECT_TOOLS = [CHAT, SET_PLAN, REQUEST_APPROVAL, CLARIFY, DONE, REPORT]

CODE_EXECUTION_TOOL = {"type": "code_execution_20260120", "name": "code_execution"}

ALL_TOOLS: list[dict] = [CODE_EXECUTION_TOOL] + PROGRAMMATIC_TOOLS + DIRECT_TOOLS
