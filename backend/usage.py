"""
LLM usage accounting.

Wraps a Gemini generate_content call to:
  1. Execute the model call.
  2. Read usage metadata from the response.
  3. Compute $ cost based on per-model pricing.
  4. Persist to the usage_events table attributed to the signed-in user.

Pricing is stored per 1M tokens and converted at insert time.
Update PRICING when Google publishes new rates.
"""

from __future__ import annotations

import os
from typing import Any, Optional

from db import get_daily_cost_usd, insert_usage_event, get_user_tier

# Prices in USD per 1,000,000 tokens.
# Reference: https://ai.google.dev/gemini-api/docs/pricing
# These are preview-tier estimates; adjust when GA pricing lands.
PRICING: dict[str, dict[str, float]] = {
    "gemini-3-flash-preview": {"input": 0.30, "output": 2.50},
    "gemini-3-pro-preview":   {"input": 1.25, "output": 10.00},
    # Fallbacks for older model names, just in case.
    "gemini-2.0-flash":       {"input": 0.10, "output": 0.40},
    "gemini-2.5-flash":       {"input": 0.30, "output": 2.50},
    "gemini-2.5-pro":         {"input": 1.25, "output": 10.00},
}

# Daily spend ceilings per tier, in USD. Enforced before each LLM call.
# Override via env for testing. Tier 'admin' has no cap.
DAILY_LIMITS_USD: dict[str, float] = {
    "free":    float(os.getenv("DAILY_LIMIT_FREE_USD", "1.00")),
    "pro":     float(os.getenv("DAILY_LIMIT_PRO_USD",  "25.00")),
    "team":    float(os.getenv("DAILY_LIMIT_TEAM_USD", "100.00")),
}


class QuotaExceeded(Exception):
    """Raised when a user has spent their daily cap. Caller converts to HTTP 429."""

    def __init__(self, spent: float, limit: float):
        self.spent = spent
        self.limit = limit
        super().__init__(
            f"Daily spend ${spent:.4f} has reached the ${limit:.2f} cap."
        )


def _compute_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    rates = PRICING.get(model)
    if not rates:
        # Unknown model — assume a conservative Flash-ish rate so we never under-charge.
        rates = PRICING.get("gemini-3-flash-preview", {"input": 0.30, "output": 2.50})
    input_cost = (input_tokens / 1_000_000.0) * rates["input"]
    output_cost = (output_tokens / 1_000_000.0) * rates["output"]
    return round(input_cost + output_cost, 6)


def _extract_usage(response: Any) -> tuple[int, int]:
    """Pull input/output token counts from a genai response.
    Falls back to zero if the SDK shape changes."""
    meta = getattr(response, "usage_metadata", None)
    if meta is None:
        return 0, 0
    input_tokens = int(getattr(meta, "prompt_token_count", 0) or 0)
    output_tokens = int(
        getattr(meta, "candidates_token_count", 0)
        or getattr(meta, "response_token_count", 0)
        or 0
    )
    return input_tokens, output_tokens


def check_quota(user_sub: str) -> None:
    """Raise QuotaExceeded if the user's daily spend is at or above their tier cap."""
    tier = get_user_tier(user_sub)
    if tier == "admin":
        return
    limit = DAILY_LIMITS_USD.get(tier, DAILY_LIMITS_USD["free"])
    spent = get_daily_cost_usd(user_sub)
    if spent >= limit:
        raise QuotaExceeded(spent, limit)


def record_llm_call(
    *,
    response: Any,
    user_sub: str,
    model: str,
    session_id: Optional[str],
    purpose: str,
) -> dict[str, Any]:
    """Read usage off a genai response, compute cost, persist an event, return a summary dict."""
    input_tokens, output_tokens = _extract_usage(response)
    cost_usd = _compute_cost(model, input_tokens, output_tokens)

    insert_usage_event(
        user_sub=user_sub,
        session_id=session_id,
        model=model,
        purpose=purpose,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost_usd,
    )

    return {
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": cost_usd,
        "purpose": purpose,
    }
