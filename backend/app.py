"""
PixelFoxx backend — minimal FastAPI surface.

The agent loop lives in agent.py. This module is just the HTTP wiring:
  - /health
  - POST /sessions/{id}/agent/step  → drive one agent turn, return chats + pending tool calls
  - POST /vision/*                  → Gemini Flash helper for image-only tasks
"""
from __future__ import annotations

import os

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

app = FastAPI(title="PixelFoxx Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["chrome-extension://*", "http://localhost:*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "service": "pixelfoxx-backend",
        "version": app.version,
        "agent_model": os.getenv("PIXEL_AGENT_MODEL", "claude-sonnet-4-6"),
        "vision_model": os.getenv("PIXEL_VISION_MODEL", "gemini-3-flash-preview"),
    }


# Routers wired in subsequent commits:
#   from agent_routes import router as agent_router
#   from vision_helper.routes import router as vision_router
#   app.include_router(agent_router)
#   app.include_router(vision_router)
