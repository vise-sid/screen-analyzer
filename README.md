# Pixel — In The Wild

A browser-automation agent that runs work to completion while keeping the user genuinely informed.

This is the `pixel-in-the-wild` rebuild — a clean redesign around a **tiny core** (~10 primitive tools, ~500-char system prompt) plus **skills** (markdown + scripts) that teach the model when and how to use those tools.

## Architecture (the short version)

- **Model:** Claude Sonnet 4.6 with adaptive thinking + prompt caching. Gemini Flash 3 only for vision (captcha, screenshot classification).
- **Execution:** Programmatic tool calling — the model writes Python in a sandbox that calls our browser/workspace primitives. Intermediate results stay in the sandbox; only final summaries enter the model's context.
- **Skills:** Anthropic Agent Skills API. Each skill is a folder (`SKILL.md` + helpers) uploaded to our workspace, auto-discovered by Claude via progressive disclosure. We never `read_skill` ourselves — the model does.
- **Surface:** Chrome extension (sidepanel) for now. Tauri desktop app later when we need triggered/scheduled runs.

See [`docs/SPEC.md`](docs/SPEC.md) for the full architectural spec.

## Repo layout

```
backend/             FastAPI + Anthropic SDK + agent loop + skill-aware container
backend/skills/      Skill folders (SKILL.md + helpers.py per skill)
backend/vision_helper/  Gemini Flash endpoint for image-only tasks
extension/           Chrome MV3 extension — sidepanel using pixelfoxx_ui_design_system
scripts/             Skill upload + dev tooling
evals/               Skill evaluations (run before authoring, run after every change)
docs/                SPEC.md and operating notes
pixelfoxx_ui_design_system/  Design handoff bundle (do not edit; recreate, don't copy)
```

## Quickstart

```bash
# Backend
cd backend
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --reload --port 8000

# Skills (one-time per skill change)
python scripts/upload_skills.py

# Extension
# Load `extension/` as unpacked in chrome://extensions (key.pem pins the ID)
```

## Status

Skeleton stage. Nothing implemented yet. See [`docs/SPEC.md`](docs/SPEC.md) for the plan.
