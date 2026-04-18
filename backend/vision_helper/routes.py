"""
Vision helper — Gemini Flash 3 endpoints for image-only inference.

Why this lives outside the agent loop: Sonnet for vision is ~10× more
expensive than Flash for the same classification quality. The agent
calls these endpoints via the `vision()` primitive when it needs to
process an image (captcha, screenshot description, form field map).

Skeleton: route shapes only. Real Gemini calls land in the next commit.
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/vision", tags=["vision"])


class CaptchaRequest(BaseModel):
    image_b64: str


class DescribeRequest(BaseModel):
    image_b64: str
    prompt: str | None = None


class ExtractFormRequest(BaseModel):
    image_b64: str


@router.post("/captcha")
def solve_captcha(req: CaptchaRequest) -> dict:
    raise NotImplementedError("vision_helper.captcha — wire to gemini-3-flash-preview")


@router.post("/describe")
def describe_screenshot(req: DescribeRequest) -> dict:
    raise NotImplementedError("vision_helper.describe — wire to gemini-3-flash-preview")


@router.post("/extract_form")
def extract_form_fields(req: ExtractFormRequest) -> dict:
    raise NotImplementedError("vision_helper.extract_form — wire to gemini-3-flash-preview")
