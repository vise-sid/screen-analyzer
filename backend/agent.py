"""
Pixel agent loop — minimal Anthropic + Skills + programmatic tool calling.

This is intentionally small. Domain knowledge lives in skills (uploaded to
Anthropic's Skills API and referenced via skill_id), NOT in this file.
The system prompt is ~500 chars. Tools are ~13 primitives. Everything else
is a skill the model auto-discovers via progressive disclosure.

Skeleton stage: agent_step() is not yet wired to a real tool dispatcher.
The structure shows the intended shape — primitive tool definitions,
container with skills + code execution, message loop with pause_turn
handling for long-running skill operations.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from anthropic import Anthropic

# ─────────────────────────────────────────────────────────────────────────────
# Model + container config
# ─────────────────────────────────────────────────────────────────────────────

AGENT_MODEL = os.getenv("PIXEL_AGENT_MODEL", "claude-sonnet-4-6")
MAX_TOKENS = int(os.getenv("PIXEL_MAX_TOKENS", "4096"))

# Verified compatible Apr 19 — both betas can be enabled with code_execution_20260120.
BETAS = ["code-execution-2025-08-25", "skills-2025-10-02"]

# Loaded lazily so the module imports without an API key (e.g. in tests).
_client: Anthropic | None = None


def client() -> Anthropic:
    global _client
    if _client is None:
        _client = Anthropic()
    return _client


# ─────────────────────────────────────────────────────────────────────────────
# Skill registry — committed at backend/skills/_registry.json
#   { "logging-to-sheets": "skill_01...", "verifying-page-state": "skill_01...", ... }
# Populated by scripts/upload_skills.py after each skill upload.
# ─────────────────────────────────────────────────────────────────────────────

REGISTRY_PATH = Path(__file__).parent / "skills" / "_registry.json"


def load_skill_registry() -> dict[str, str]:
    if not REGISTRY_PATH.exists():
        return {}
    return json.loads(REGISTRY_PATH.read_text())


def container_skills(version: str = "latest") -> list[dict]:
    """Build the `container.skills` array for the Messages API request.
    Caps at 8 (Anthropic's per-request limit).
    """
    registry = load_skill_registry()
    skills = [
        {"type": "custom", "skill_id": sid, "version": version}
        for sid in list(registry.values())[:8]
    ]
    return skills


# ─────────────────────────────────────────────────────────────────────────────
# System prompt — small and frozen. Domain rules live in skills.
# ─────────────────────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are Pixel Foxx, an autonomous browser-automation agent.

You work by calling tools and reading skills. The skills folder contains markdown files (with optional Python helpers) that teach you HOW and WHEN to use the tools for specific situations.

Every turn pairs a one-line `chat` narration with a concrete tool call. Run plans to completion — pause only for: plan-level approval, a destructive action, a genuine pathway fork, or the final report."""


# ─────────────────────────────────────────────────────────────────────────────
# Primitive tool surface — the only tools the model ever sees.
# Imported from tools.py to keep this file focused on the loop.
# ─────────────────────────────────────────────────────────────────────────────

from tools import ALL_TOOLS  # noqa: E402


# ─────────────────────────────────────────────────────────────────────────────
# Agent step — the loop.
# Skeleton: this is the shape, not a working implementation. Real wiring
# (extension dispatch, container reuse, pause_turn, prompt caching) lands
# in subsequent commits.
# ─────────────────────────────────────────────────────────────────────────────


def agent_step(
    *,
    messages: list[dict[str, Any]],
    container_id: str | None = None,
) -> dict[str, Any]:
    """Drive one agent turn.

    `messages` is the full conversation history in Anthropic Messages format.
    Returns a dict with the assistant's response, the container ID for reuse,
    and the stop_reason (so callers can detect pause_turn vs tool_use vs end_turn).
    """
    container: dict[str, Any] = {"skills": container_skills()}
    if container_id:
        container["id"] = container_id

    response = client().beta.messages.create(
        model=AGENT_MODEL,
        max_tokens=MAX_TOKENS,
        betas=BETAS,
        system=SYSTEM_PROMPT,
        container=container,
        tools=ALL_TOOLS,
        messages=messages,
    )

    return {
        "stop_reason": response.stop_reason,
        "content": response.content,
        "container_id": response.container.id if response.container else None,
        "usage": {
            "input_tokens": response.usage.input_tokens,
            "output_tokens": response.usage.output_tokens,
            "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0),
            "cache_read_input_tokens": getattr(response.usage, "cache_read_input_tokens", 0),
        },
    }
