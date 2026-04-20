"""
Vision helper — Gemini Flash 3 endpoints for image-only inference.

Sonnet 4.6 for vision is ~10× the cost of Gemini Flash for the same
classification quality. The agent's `vision()` programmatic primitive
routes here when it needs to process an image (captcha, screenshot
description, form field extraction).

All endpoints accept base64-encoded image bytes.
"""
from __future__ import annotations

import base64
import os
from typing import Any

from fastapi import APIRouter, HTTPException
from google import genai
from google.genai import types
from pydantic import BaseModel

router = APIRouter(prefix="/vision", tags=["vision"])

VISION_MODEL = os.getenv("PIXEL_VISION_MODEL", "gemini-3-flash-preview")

_client: genai.Client | None = None


def client() -> genai.Client:
    global _client
    if _client is None:
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise HTTPException(status_code=500, detail="GEMINI_API_KEY not set")
        _client = genai.Client(api_key=api_key)
    return _client


def _decode_image(image_b64: str) -> bytes:
    raw = image_b64
    if "," in raw and raw.lstrip().startswith("data:"):
        # data URL prefix
        raw = raw.split(",", 1)[1]
    try:
        return base64.b64decode(raw)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"invalid base64 image: {e}")


def _ask_gemini(prompt: str, image_bytes: bytes, mime: str = "image/png") -> str:
    """Single-shot multimodal call. Returns the text answer or raises."""
    try:
        resp = client().models.generate_content(
            model=VISION_MODEL,
            contents=[
                types.Part.from_text(text=prompt),
                types.Part.from_bytes(data=image_bytes, mime_type=mime),
            ],
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"gemini call failed: {e}")
    text = (resp.text or "").strip()
    return text


# ── Request / response models ─────────────────────────────────────────────


class CaptchaRequest(BaseModel):
    image_b64: str
    mime: str = "image/png"


class CaptchaResponse(BaseModel):
    ok: bool
    answer: str
    raw: str  # the model's full response, for debugging


class DescribeRequest(BaseModel):
    image_b64: str
    prompt: str | None = None
    mime: str = "image/png"


class DescribeResponse(BaseModel):
    ok: bool
    description: str


class ExtractFormRequest(BaseModel):
    image_b64: str
    mime: str = "image/png"


class ExtractFormResponse(BaseModel):
    ok: bool
    fields: list[dict[str, Any]]
    raw: str


# ── Endpoints ─────────────────────────────────────────────────────────────


_CAPTCHA_PROMPT = (
    "This image is a CAPTCHA. Return ONLY the characters shown — no spaces, "
    "no punctuation, no explanation, no quotes. Preserve case exactly as shown. "
    "If you can't read it confidently, return the single token UNREADABLE."
)


@router.post("/captcha", response_model=CaptchaResponse)
def solve_captcha(req: CaptchaRequest) -> CaptchaResponse:
    image = _decode_image(req.image_b64)
    raw = _ask_gemini(_CAPTCHA_PROMPT, image, mime=req.mime)
    # Strip whitespace and any quotes the model may add despite the prompt.
    answer = raw.strip().strip('"\'`').strip()
    if not answer or answer.upper() == "UNREADABLE":
        return CaptchaResponse(ok=False, answer="", raw=raw)
    return CaptchaResponse(ok=True, answer=answer, raw=raw)


@router.post("/describe", response_model=DescribeResponse)
def describe_screenshot(req: DescribeRequest) -> DescribeResponse:
    prompt = req.prompt or "Describe what is visible in this screenshot in 2-3 sentences."
    image = _decode_image(req.image_b64)
    text = _ask_gemini(prompt, image, mime=req.mime)
    return DescribeResponse(ok=True, description=text)


_FORM_PROMPT = (
    "Identify input fields visible in this screenshot. "
    "Return ONE field per line in this exact format:\n"
    "  name=<label or placeholder> | kind=<text|password|email|select|checkbox|radio|file>\n"
    "If no input fields are visible, return the single word NONE."
)


@router.post("/extract_form", response_model=ExtractFormResponse)
def extract_form_fields(req: ExtractFormRequest) -> ExtractFormResponse:
    image = _decode_image(req.image_b64)
    raw = _ask_gemini(_FORM_PROMPT, image, mime=req.mime)
    fields: list[dict[str, Any]] = []
    if raw.strip().upper() != "NONE":
        for line in raw.splitlines():
            line = line.strip().lstrip("-").strip()
            if not line:
                continue
            parts = {}
            for chunk in line.split("|"):
                if "=" in chunk:
                    k, v = chunk.split("=", 1)
                    parts[k.strip()] = v.strip()
            if "name" in parts:
                fields.append(parts)
    return ExtractFormResponse(ok=True, fields=fields, raw=raw)
