import base64
import json
import os
import re
import uuid
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from google import genai
from google.genai.types import Content, GenerateContentConfig, Part, ThinkingConfig
from pydantic import BaseModel

load_dotenv()

app = FastAPI()

# Debug directory for step-by-step inspection
DEBUG_DIR = Path(__file__).parent / "debug"
DEBUG_DIR.mkdir(exist_ok=True)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

SYSTEM_PROMPT = """<role>
You are an autonomous browser automation agent. You take one action per step to accomplish the user's task. You receive an element list every step and a screenshot only on the first step or when you request one.
</role>

<instructions>
1) Before starting a complex or ambiguous task, use ask_user to clarify. E.g., "Should I book the cheapest option or do you have a preference?" Don't assume — ask.
2) Analyze the element list to understand the page. Elements are grouped by section. PAGE SCROLL tells you where you are on the page.
3) Act from the element list. Do NOT request a screenshot unless you need visual info (CAPTCHA, complex layout, can't find element).
4) Use previous context: if you saw a layout before, you know it. The element list updates every step.
5) Adapt: if an action fails, try a different approach. Do not repeat failed actions.
6) Persist: on transient errors, use wait and retry. Only use done when all approaches exhausted.
</instructions>

<response_format>
Respond with a single JSON object. No markdown, no code fences, no text outside the JSON.

{"thought": "brief reasoning", "action": {"type": "...", ...}}
</response_format>

<actions>
click            {"type":"click","ref":5}                                          Click element [5]
click (coords)   {"type":"click","x":500,"y":300}                                  Click screen coordinates (need screenshot first)
double_click     {"type":"double_click","ref":5}
hover            {"type":"hover","ref":5}
focus_and_type   {"type":"focus_and_type","ref":5,"text":"hello","clear":true}      Click then type. clear:true replaces text.
type             {"type":"type","text":"hello"}                                     Type into focused field
key              {"type":"key","key":"Enter"}                                       Enter|Tab|Escape|Backspace|Delete|ArrowUp/Down/Left/Right|Space
select           {"type":"select","ref":5,"value":"option_value"}
scroll           {"type":"scroll","x":400,"y":400,"deltaX":0,"deltaY":500}          +deltaY=down, -deltaY=up
navigate         {"type":"navigate","url":"https://..."}
back/forward     {"type":"back"} or {"type":"forward"}
wait             {"type":"wait","duration":1000}
extract_text     {"type":"extract_text","ref":5}
screenshot       {"type":"screenshot"}                                              Request a screenshot on the NEXT step (use when element list isn't enough)
new_tab          {"type":"new_tab","url":"https://..."}
switch_tab       {"type":"switch_tab","tabId":12345}
close_tab        {"type":"close_tab","tabId":12345}
click_captcha    {"type":"click_captcha"}                                            Human-like click on CAPTCHA checkbox (Turnstile/reCAPTCHA/hCaptcha)
stealth_solve    {"type":"stealth_solve"}                                            Launch stealth browser to bypass Cloudflare (use when click_captcha fails)
dismiss_popup    {"type":"dismiss_popup"}                                            Force-close popups/modals
accept_dialog    {"type":"accept_dialog"}
dismiss_dialog   {"type":"dismiss_dialog"}
done             {"type":"done","summary":"..."}
ask_user         {"type":"ask_user","question":"..."}
</actions>

<context>
- Elements are grouped by page section and listed as [i]<tag>text</tag>. Use index i as "ref".
- A screenshot is included on step 1 and after you request one. Otherwise you work from the element list.
- URL is shown every step. Read URL parameters to understand page state (filters, search queries, sort order). You can modify the URL directly with navigate to change filters instantly.
- PAGE CHANGED = URL changed, review new elements. SAME PAGE = same URL, layout familiar.
- PAGE LOADING = page still loading, use wait before clicking.
- PAGE SCROLL shows your position. SCROLL CONTAINERS show scrollable areas with center coordinates.
- For credentials or 2FA: use ask_user.
- CAPTCHA solving: For checkbox CAPTCHAs (Turnstile/reCAPTCHA), use click_captcha first, then stealth_solve if it fails. For TEXT CAPTCHAs, read the distorted text from the screenshot and type it. For IMAGE CAPTCHAs (select all with X), use the screenshot and try your best with vision. Track attempts — after 3 failures, use ask_user. Do NOT give up on the first failure.
</context>"""


# In-memory session store
sessions: dict[str, dict] = {}


class StartRequest(BaseModel):
    task: str
    viewport_width: int = 1280
    viewport_height: int = 800


class StepRequest(BaseModel):
    image: str | None = None
    url: str | None = None
    elements: list[dict] | None = None
    scroll_containers: list[dict] | None = None
    popup: dict | None = None
    captcha: dict | None = None
    dialog: dict | None = None
    agent_tabs: list[dict] | None = None
    loop_warning: str | None = None
    is_canvas_heavy: bool = False
    page_scroll: dict | None = None
    page_loading: bool = False


@app.post("/session/start")
async def start_session(req: StartRequest):
    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "task": req.task,
        "viewport_width": req.viewport_width,
        "viewport_height": req.viewport_height,
        "history": [],
        "last_url": "",         # Track URL for page-change detection
        "wants_screenshot": True,  # First step always gets a screenshot
    }
    return {"session_id": session_id}


def _format_elements(elements: list[dict] | None, is_canvas: bool) -> str:
    if is_canvas:
        return (
            "PAGE TYPE: Canvas-heavy — use screenshot and pixel coordinates."
        )

    if not elements:
        return "No interactive elements. Use screenshot and coordinates."

    # Group elements by their landmark section
    groups: dict[str, list[tuple[int, dict]]] = {}
    for i, el in enumerate(elements):
        group = el.get("group") or "Page"
        if group not in groups:
            groups[group] = []
        groups[group].append((i, el))

    lines = [f"ELEMENTS ({len(elements)}):"]
    for group_name, group_els in groups.items():
        lines.append(f"\n-- {group_name} --")
        for i, el in group_els:
            tag = el.get("tag", "?")
            desc = el.get("desc", "")
            attrs = ""
            if el.get("type") and el["type"] not in ("submit", "button"):
                attrs += f' type="{el["type"]}"'
            if el.get("href"):
                href = el["href"]
                if len(href) > 50:
                    href = href[:50] + "…"
                attrs += f' href="{href}"'
            if el.get("value"):
                attrs += f' value="{el["value"]}"'
            if el.get("checked"):
                attrs += " checked"
            if el.get("disabled"):
                attrs += " disabled"

            if desc:
                lines.append(f"[{i}]<{tag}{attrs}>{desc}</{tag}>")
            else:
                lines.append(f"[{i}]<{tag}{attrs}/>")

    return "\n".join(lines)


def _format_scroll_containers(containers: list[dict] | None) -> str:
    if not containers:
        return ""

    lines = [f"\nSCROLL CONTAINERS ({len(containers)} found):"]
    for i, sc in enumerate(containers):
        rect = sc.get("rect", {})
        cx = rect.get("x", 0) + rect.get("width", 0) // 2
        cy = rect.get("y", 0) + rect.get("height", 0) // 2
        pct = 0
        sh = sc.get("scrollHeight", 1)
        if sh > 0:
            pct = round(
                (sc.get("scrollTop", 0) / (sh - sc.get("clientHeight", 0))) * 100
            ) if sh > sc.get("clientHeight", 0) else 0

        dirs = []
        if sc.get("canScrollUp"):
            dirs.append("up")
        if sc.get("canScrollDown"):
            dirs.append("down")
        scroll_dir = ", ".join(dirs) if dirs else "none"

        lines.append(
            f"  [scroll={i}] \"{sc.get('label', '?')}\" "
            f"@ ({rect.get('x', 0)},{rect.get('y', 0)} "
            f"{rect.get('width', 0)}x{rect.get('height', 0)}) "
            f"center=({cx},{cy}) "
            f"scrolled={pct}% can_scroll={scroll_dir}"
        )

    return "\n".join(lines)


def _format_agent_tabs(tabs: list[dict] | None) -> str:
    if not tabs or len(tabs) <= 1:
        return ""

    lines = [f"\nAGENT TABS ({len(tabs)} open):"]
    for t in tabs:
        active = " (ACTIVE)" if t.get("isActive") else ""
        url = t.get("url", "")
        if len(url) > 80:
            url = url[:80] + "..."
        lines.append(
            f"  tabId={t.get('tabId')} \"{t.get('title', '?')}\"{active} — {url}"
        )
    return "\n".join(lines)


def _format_popup(popup: dict | None) -> str:
    if not popup:
        return ""

    rect = popup.get("rect", {})
    close_btn = popup.get("closeButton")
    lines = [
        f"\n⚠ POPUP/MODAL DETECTED ({popup.get('type', 'popup')}):",
        f"  Position: ({rect.get('x', 0)},{rect.get('y', 0)} "
        f"{rect.get('width', 0)}x{rect.get('height', 0)})",
    ]

    if close_btn:
        lines.append(
            f"  Close button at ({close_btn['centerX']},{close_btn['centerY']})"
        )
    else:
        lines.append(
            "  No close button detected."
        )

    return "\n".join(lines)


def _format_captcha(captcha: dict | None) -> str:
    if not captcha:
        return ""

    ctype = captcha.get("type", "unknown")
    rect = captcha.get("rect", {})
    lines = [
        f"\n⚠ CAPTCHA DETECTED ({ctype}):",
        f"  Position: ({rect.get('x', 0)},{rect.get('y', 0)} "
        f"{rect.get('width', 0)}x{rect.get('height', 0)})",
    ]
    click_target = captcha.get("clickTarget")
    if click_target:
        lines.append(
            f"  Checkbox at: ({click_target.get('x', 0)},{click_target.get('y', 0)})"
        )
    return "\n".join(lines)


def _format_dialog(dialog: dict | None) -> str:
    if not dialog:
        return ""
    return (
        f"\n⚠ JS DIALOG ({dialog.get('type', 'alert')}):\n"
        f"  Message: \"{dialog.get('message', '')}\""
    )


def _extract_json(text: str) -> dict:
    """Robustly extract JSON from model output, handling truncation, code fences, etc."""
    text = text.strip()

    # Strip markdown code fences
    text = re.sub(r"^```(?:json)?\s*\n?", "", text)
    text = re.sub(r"\n?```\s*$", "", text)
    text = text.strip()

    # Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try to find and parse a JSON object in the text
    match = re.search(r"\{", text)
    if match:
        candidate = text[match.start():]

        # Count braces to find balanced JSON or repair truncation
        depth = 0
        in_string = False
        escape_next = False
        last_pos = 0

        for i, ch in enumerate(candidate):
            if escape_next:
                escape_next = False
                continue
            if ch == "\\":
                escape_next = True
                continue
            if ch == '"' and not escape_next:
                in_string = not in_string
                continue
            if in_string:
                continue
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(candidate[: i + 1])
                    except json.JSONDecodeError:
                        pass
                    break
            last_pos = i

        # Truncated JSON — add missing closing braces
        if depth > 0:
            repaired = candidate + ("}" * depth)
            try:
                return json.loads(repaired)
            except json.JSONDecodeError:
                # Try trimming the last incomplete value and closing
                # e.g., {"thought": "...", "action": {"type": "key", "key": "Enter"}
                # Just needs one more }
                for extra in range(1, depth + 2):
                    try:
                        return json.loads(candidate + "}" * extra)
                    except json.JSONDecodeError:
                        continue

                # Last resort: try to add closing quote + braces
                for suffix in [
                    '"}',
                    '"}}',
                    '"}}}',
                    "}",
                    "}}",
                    "}}}",
                ]:
                    try:
                        return json.loads(candidate + suffix)
                    except json.JSONDecodeError:
                        continue

    raise json.JSONDecodeError("No valid JSON found", text, 0)


def _guess_action_from_raw(raw: str) -> dict | None:
    """Last-resort: try to extract an action from malformed model output using regex."""
    if not raw:
        return None

    # Try to find "type": "something" pattern
    type_match = re.search(r'"type"\s*:\s*"(\w+)"', raw)
    if not type_match:
        return None

    action_type = type_match.group(1)

    if action_type == "key":
        key_match = re.search(r'"key"\s*:\s*"(\w+)"', raw)
        if key_match:
            return {"type": "key", "key": key_match.group(1)}

    elif action_type == "click":
        ref_match = re.search(r'"ref"\s*:\s*(\d+)', raw)
        if ref_match:
            return {"type": "click", "ref": int(ref_match.group(1))}
        x_match = re.search(r'"x"\s*:\s*(\d+)', raw)
        y_match = re.search(r'"y"\s*:\s*(\d+)', raw)
        if x_match and y_match:
            return {"type": "click", "x": int(x_match.group(1)), "y": int(y_match.group(1))}

    elif action_type in ("type", "clear_and_type"):
        text_match = re.search(r'"text"\s*:\s*"([^"]*)"', raw)
        if text_match:
            return {"type": action_type, "text": text_match.group(1)}

    elif action_type == "focus_and_type":
        ref_match = re.search(r'"ref"\s*:\s*(\d+)', raw)
        text_match = re.search(r'"text"\s*:\s*"([^"]*)"', raw)
        if ref_match and text_match:
            clear_match = re.search(r'"clear"\s*:\s*true', raw)
            return {
                "type": "focus_and_type",
                "ref": int(ref_match.group(1)),
                "text": text_match.group(1),
                "clear": bool(clear_match),
            }

    elif action_type == "scroll":
        dy_match = re.search(r'"deltaY"\s*:\s*(-?\d+)', raw)
        x_match = re.search(r'"x"\s*:\s*(\d+)', raw)
        y_match = re.search(r'"y"\s*:\s*(\d+)', raw)
        return {
            "type": "scroll",
            "x": int(x_match.group(1)) if x_match else 400,
            "y": int(y_match.group(1)) if y_match else 400,
            "deltaX": 0,
            "deltaY": int(dy_match.group(1)) if dy_match else 300,
        }

    elif action_type == "navigate":
        url_match = re.search(r'"url"\s*:\s*"([^"]*)"', raw)
        if url_match:
            return {"type": "navigate", "url": url_match.group(1)}

    elif action_type == "wait":
        dur_match = re.search(r'"duration"\s*:\s*(\d+)', raw)
        return {"type": "wait", "duration": int(dur_match.group(1)) if dur_match else 1000}

    elif action_type == "done":
        sum_match = re.search(r'"summary"\s*:\s*"([^"]*)"', raw)
        return {"type": "done", "summary": sum_match.group(1) if sum_match else "Task complete"}

    elif action_type in ("back", "forward"):
        return {"type": action_type}

    elif action_type in ("new_tab", "switch_tab", "close_tab"):
        if action_type == "new_tab":
            url_match = re.search(r'"url"\s*:\s*"([^"]*)"', raw)
            return {"type": "new_tab", "url": url_match.group(1) if url_match else None}
        tab_match = re.search(r'"tabId"\s*:\s*(\d+)', raw)
        if tab_match:
            return {"type": action_type, "tabId": int(tab_match.group(1))}

    elif action_type in ("hover", "double_click"):
        ref_match = re.search(r'"ref"\s*:\s*(\d+)', raw)
        if ref_match:
            return {"type": action_type, "ref": int(ref_match.group(1))}

    elif action_type == "click_captcha":
        return {"type": "click_captcha"}

    elif action_type == "stealth_solve":
        url_match = re.search(r'"url"\s*:\s*"([^"]*)"', raw)
        return {"type": "stealth_solve", "url": url_match.group(1) if url_match else ""}

    elif action_type == "dismiss_popup":
        return {"type": "dismiss_popup"}

    elif action_type == "accept_dialog":
        return {"type": "accept_dialog"}

    elif action_type == "dismiss_dialog":
        return {"type": "dismiss_dialog"}

    elif action_type == "ask_user":
        q_match = re.search(r'"question"\s*:\s*"([^"]*)"', raw)
        return {"type": "ask_user", "question": q_match.group(1) if q_match else "Please help with the page"}

    return None


def _extract_response_text(response) -> str:
    """Extract the text response, handling thinking model parts."""
    # Try .text first (skips thinking parts in most SDK versions)
    try:
        text = response.text
        if text and text.strip():
            return text.strip()
    except Exception:
        pass

    # Fallback: iterate through candidates and parts
    for candidate in response.candidates:
        for part in candidate.content.parts:
            # Skip thinking parts
            if getattr(part, "thought", False):
                continue
            text = getattr(part, "text", None)
            if text and text.strip():
                return text.strip()

    return ""


@app.post("/session/{session_id}/step")
async def step_session(session_id: str, req: StepRequest):
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    try:
        step_num = len(session["history"]) // 2 + 1

        elements_text = _format_elements(req.elements, req.is_canvas_heavy)
        scroll_text = _format_scroll_containers(req.scroll_containers)
        popup_text = _format_popup(req.popup)
        captcha_text = _format_captcha(req.captcha)
        dialog_text = _format_dialog(req.dialog)
        tabs_text = _format_agent_tabs(req.agent_tabs)
        loop_text = f"\n⚠ {req.loop_warning}" if req.loop_warning else ""

        # Page scroll position context
        ps = req.page_scroll
        if ps:
            dirs = []
            if ps.get("canScrollUp"):
                dirs.append("up")
            if ps.get("canScrollDown"):
                dirs.append("down")
            scroll_pos_text = (
                f"\nPAGE SCROLL: {ps.get('scrollPct', 0)}% "
                f"(can scroll: {', '.join(dirs) if dirs else 'none'})"
            )
        else:
            scroll_pos_text = ""

        loading_text = "\n⏳ PAGE LOADING — use wait before interacting" if req.page_loading else ""

        # ── Page context: detect URL change ──
        current_url = req.url or ""
        last_url = session.get("last_url", "")
        page_changed = current_url != last_url and last_url != ""
        session["last_url"] = current_url

        if page_changed:
            page_marker = f"⚡ PAGE CHANGED\n"
        else:
            page_marker = "↻ SAME PAGE\n" if step_num > 1 else ""
        # Always show URL — model can read URL params to understand page state (filters, search queries, etc.)
        url_line = f"URL: {current_url}\n" if current_url else ""

        # ── Screenshot: include when requested, first step, page change, or CAPTCHA ──
        include_screenshot = session.get("wants_screenshot", False)
        has_screenshot = include_screenshot and req.image is not None and len(req.image) > 0
        # Always include on page change (new layout to understand)
        if page_changed and req.image:
            has_screenshot = True
        # Always include when CAPTCHA detected (model needs to SEE it to solve it)
        if req.captcha and req.image:
            has_screenshot = True
        screenshot_note = "Screenshot attached." if has_screenshot else ""

        prompt_text = (
            f"Task: {session['task']}\n"
            f"Step {step_num} | {page_marker}"
            f"{url_line}"
            f"{scroll_pos_text}"
            f"{loading_text}\n"
            f"{loop_text}\n"
            f"{popup_text}\n"
            f"{captcha_text}\n"
            f"{dialog_text}\n"
            f"{elements_text}\n"
            f"{scroll_text}\n"
            f"{tabs_text}\n"
            f"{screenshot_note}"
        )

        user_parts = [Part.from_text(text=prompt_text)]

        if has_screenshot:
            user_parts.append(
                Part.from_bytes(
                    data=base64.b64decode(req.image),
                    mime_type="image/png",
                )
            )
        # Reset — model must request again if it needs another screenshot
        session["wants_screenshot"] = False

        # ── Debug: save prompt + screenshot to debug/ ──
        step_prefix = f"step_{step_num:03d}"
        debug_prompt_path = DEBUG_DIR / f"{step_prefix}_prompt.txt"
        debug_prompt_path.write_text(
            f"=== SYSTEM PROMPT ===\n{SYSTEM_PROMPT}\n\n"
            f"=== USER MESSAGE (Step {step_num}) ===\n{prompt_text}\n"
        )
        if has_screenshot:
            debug_img_path = DEBUG_DIR / f"{step_prefix}_screenshot.png"
            debug_img_path.write_bytes(base64.b64decode(req.image))

        print(f"\n{'='*60}")
        print(f"  STEP {step_num} — {session['task'][:60]}")
        print(f"{'='*60}")
        print(prompt_text)
        print(f"  [screenshot: {'yes' if has_screenshot else 'no'}]")
        print(f"{'─'*60}")

        contents = list(session["history"])
        contents.append(Content(role="user", parts=user_parts))

        response = client.models.generate_content(
            model="gemini-3-flash-preview",
            config=GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                thinking_config=ThinkingConfig(thinking_level="low"),
            ),
            contents=contents,
        )

        raw_text = _extract_response_text(response)
        result = _extract_json(raw_text)

        # ── Handle screenshot request: model asks for visual context ──
        action = result.get("action", {})
        if action.get("type") == "screenshot":
            session["wants_screenshot"] = True
            # Don't save to history — this is a meta-action, not a real step
            print(f"  MODEL REQUESTED SCREENSHOT — will include on next step")
            print(f"{'='*60}\n")
            return result

        # ── Debug: save response ──
        debug_resp_path = DEBUG_DIR / f"{step_prefix}_response.json"
        debug_resp_path.write_text(json.dumps(result, indent=2))

        print(f"  MODEL RESPONSE:")
        print(f"  {json.dumps(result, indent=2)}")
        print(f"{'='*60}\n")

        # Save to history
        session["history"].append(Content(role="user", parts=user_parts))
        session["history"].append(
            Content(
                role="model",
                parts=[Part.from_text(text=json.dumps(result))],
            )
        )

        return result

    except json.JSONDecodeError:
        raw = ""
        try:
            raw = _extract_response_text(response)
        except Exception:
            pass

        # Try to extract action type from raw text as last resort
        action = _guess_action_from_raw(raw)
        if action:
            result = {"thought": f"(Recovered from malformed JSON)", "action": action}
            session["history"].append(Content(role="user", parts=user_parts))
            session["history"].append(
                Content(
                    role="model",
                    parts=[Part.from_text(text=json.dumps(result))],
                )
            )
            return result

        return {
            "thought": f"Failed to parse response. Raw: {raw[:200]}",
            "action": {"type": "wait", "duration": 1000},
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/session/{session_id}")
async def delete_session(session_id: str):
    sessions.pop(session_id, None)
    # Clean debug dir for next session
    for f in DEBUG_DIR.iterdir():
        f.unlink(missing_ok=True)
    return {"status": "ok"}


# ── Debug Endpoints ─────────────────────────────────────────

@app.get("/debug")
async def list_debug_steps():
    """List all saved debug steps."""
    files = sorted(DEBUG_DIR.glob("step_*_prompt.txt"))
    steps = []
    for f in files:
        step_num = f.stem.split("_")[1]
        has_screenshot = (DEBUG_DIR / f"step_{step_num}_screenshot.png").exists()
        has_response = (DEBUG_DIR / f"step_{step_num}_response.json").exists()
        steps.append({
            "step": int(step_num),
            "prompt": f"/debug/step/{int(step_num)}/prompt",
            "screenshot": f"/debug/step/{int(step_num)}/screenshot" if has_screenshot else None,
            "response": f"/debug/step/{int(step_num)}/response" if has_response else None,
        })
    return {"steps": steps}


@app.get("/debug/step/{step_num}/prompt")
async def get_debug_prompt(step_num: int):
    """Get the full prompt text sent to the model for a step."""
    path = DEBUG_DIR / f"step_{step_num:03d}_prompt.txt"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"No debug data for step {step_num}")
    return {"step": step_num, "prompt": path.read_text()}


@app.get("/debug/step/{step_num}/screenshot")
async def get_debug_screenshot(step_num: int):
    """Get the screenshot sent to the model for a step."""
    path = DEBUG_DIR / f"step_{step_num:03d}_screenshot.png"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"No screenshot for step {step_num}")
    return FileResponse(path, media_type="image/png")


@app.get("/debug/step/{step_num}/response")
async def get_debug_response(step_num: int):
    """Get the model's parsed response for a step."""
    path = DEBUG_DIR / f"step_{step_num:03d}_response.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"No response for step {step_num}")
    return json.loads(path.read_text())


# ── Stealth Cloudflare Solver ────────────────────────────────

class StealthSolveRequest(BaseModel):
    url: str
    user_agent: str | None = None
    cookies: list[dict] | None = None
    timeout: int = 30


@app.post("/stealth-solve")
async def stealth_solve(req: StealthSolveRequest):
    """
    Spawn a stealth browser (nodriver) to solve Cloudflare/Turnstile challenges.
    Accepts the user's cookies, injects them, navigates to the URL,
    waits for the challenge to auto-resolve, and returns all cookies
    (including cf_clearance) for injection back into the user's browser.
    """
    import asyncio
    from stealth_solver import solve_cloudflare

    try:
        result = await solve_cloudflare(
            url=req.url,
            user_agent=req.user_agent,
            cookies=req.cookies,
            timeout=req.timeout,
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
