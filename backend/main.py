import base64
import json
import os
import re
import uuid

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai.types import Content, GenerateContentConfig, Part, ThinkingConfig
from pydantic import BaseModel

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

SYSTEM_PROMPT = """You are an expert browser automation agent. Each step, you receive:
- A SCREENSHOT of the current page
- A list of INTERACTIVE ELEMENTS with ref numbers
- SCROLL CONTAINERS showing scrollable regions
- POPUP/MODAL alerts if overlays are blocking the page
- AGENT TABS if multiple tabs are open

## RESPONSE FORMAT

Respond with a single JSON object. No markdown, no code fences.

{
  "eval": "Did the previous action succeed? What changed on the page? (write 'start' on step 1)",
  "memory": "Condensed summary of progress so far — what has been accomplished, what remains",
  "goal": "What to do next and why",
  "action": {"type": "...", ...}
}

All four fields are REQUIRED every step.

## ACTIONS

### Navigation
- click: {"type": "click", "ref": 5} or {"type": "click", "x": 500, "y": 300}
- double_click: {"type": "double_click", "ref": 5}
- hover: {"type": "hover", "ref": 5}
- navigate: {"type": "navigate", "url": "https://example.com"}
- back: {"type": "back"}
- forward: {"type": "forward"}

### Input
- focus_and_type (PREFERRED): {"type": "focus_and_type", "ref": 5, "text": "hello", "clear": true}
- type: {"type": "type", "text": "hello"}
- clear_and_type: {"type": "clear_and_type", "text": "new value"}
- key: {"type": "key", "key": "Enter"}
  Keys: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Space, Home, End, PageUp, PageDown
- select: {"type": "select", "ref": 5, "value": "option_value"}

### Page
- scroll: {"type": "scroll", "x": 400, "y": 400, "deltaX": 0, "deltaY": 500}
- wait: {"type": "wait", "duration": 1000}
- extract_text: {"type": "extract_text", "ref": 5}

### Tabs
- new_tab: {"type": "new_tab", "url": "https://example.com"}
- switch_tab: {"type": "switch_tab", "tabId": 12345}
- close_tab: {"type": "close_tab", "tabId": 12345}

### CAPTCHAs & Anti-Bot
- click_captcha: {"type": "click_captcha"} — Clicks the CAPTCHA checkbox with human-like mouse movement. Quick first attempt.
- stealth_solve: {"type": "stealth_solve"} — Launches a stealth browser (patchright) that is undetectable by Cloudflare. It inherits the user's cookies, solves the challenge, and transfers cookies back. The page reloads automatically. Use when click_captcha fails.

### Popups & Dialogs
- dismiss_popup: {"type": "dismiss_popup"} — Aggressively tries to close any popup/modal/overlay using multiple JS strategies (click close buttons, hide overlays, remove backdrops). Use this when clicking the X button or Escape doesn't work.
- accept_dialog: {"type": "accept_dialog"} — Accept a JS alert/confirm dialog
- dismiss_dialog: {"type": "dismiss_dialog"} — Dismiss a JS confirm dialog

### Completion
- done: {"type": "done", "summary": "What was accomplished or why it failed"}
- ask_user: {"type": "ask_user", "question": "What you need the user to do"} — Pause and ask the user for help (e.g., solve a CAPTCHA you can't read)

## STRATEGY

### Priority Order
1. **POPUPS FIRST.** If ⚠ POPUP/MODAL DETECTED appears, dismiss it. Try in this order:
   a. Click the close button coordinates if provided
   b. If that fails, use dismiss_popup action (tries multiple JS strategies automatically)
   c. Try pressing Escape
   d. Look for "No", "Later", "Cancel", "Skip", "Close", "X" buttons in the screenshot and click them
   Do NOT spend more than 3 steps trying to close a popup — use dismiss_popup which is the most aggressive approach.
2. **CAPTCHA SOLVING — 3-tier escalation:**
   - **Tier 1 — click_captcha** (try once): Quick attempt with human-like mouse movement.
   - **Tier 2 — stealth_solve** (try once): Launches a stealth browser (patchright) that Cloudflare cannot detect. It opens the page, solves the challenge, and transfers the clearance cookies back. Page reloads automatically.
   - **Tier 3 — ask_user**: If both fail, pause and ask the user to solve manually.
   - For text CAPTCHAs: Read the distorted text from the screenshot and type it. If wrong 3 times, ask_user.
   - For text CAPTCHAs: Read the distorted text from the screenshot and type it. If wrong 3 times, ask_user.
   - For image CAPTCHAs: Try your best with vision. If wrong 3 times, ask_user.
3. **EVALUATE before acting.** In the "eval" field, honestly assess whether your previous action worked by comparing the current screenshot to what you expected. If it failed, diagnose why and try a different approach.

### Element Targeting
- ALWAYS use ref-based targeting when the element is in the list.
- Only use x/y coordinates for canvas pages or elements not in the list.
- For input fields, ALWAYS use focus_and_type (click + type in one action). Set "clear": true to replace existing text.
- After typing in a search field, press Enter to submit.
- For dropdowns, click to open, then click the option, or use select action.

### Scrolling
- Pages have MULTIPLE scroll areas (sidebar, main, modals). The SCROLL CONTAINERS list shows each with position and center coordinates.
- To scroll a specific area, aim at its CENTER coordinates.
- For infinite scroll: scroll, wait for content, compare. Stop when no new content loads (3 scrolls with no change).

### Page Transitions
- After clicking a link or submitting a form, use wait (1000-2000ms) for the page to load.
- After navigation, the element refs will change — never reuse refs from a previous step.
- If a page is still loading (spinner visible, partial content), use wait before acting.

### Forms
- Fill fields one at a time using focus_and_type.
- After submitting, check for validation errors in the next screenshot. If errors appear, read them and fix the inputs.
- For multi-step forms (wizards), complete each step and verify before proceeding to the next.

### Error Recovery
- If an action didn't work (page unchanged), try an alternative: different ref, keyboard shortcut, or different approach entirely.
- If clicking a button doesn't work, try: (1) scroll it into better view, (2) hover first then click, (3) use coordinates instead of ref.
- After 3 consecutive failed attempts at the same goal, report done with explanation.
- NEVER repeat the exact same action if it didn't work the first time.

### Edge Cases
- **Alerts/Confirms:** If a JS alert or confirmation dialog appears, it will be noted. Use key Escape to dismiss or Enter to accept.
- **iframes:** Some content is inside iframes. If you can't find expected elements, note it — the system will attempt to extract from iframes.
- **Dynamic content:** After actions that trigger AJAX/dynamic updates, always wait briefly and re-check the page state.
- **Downloads:** Do not attempt to download files. Report that a download is needed and let the user handle it.
- **New windows:** If an action opens a new window/tab, use switch_tab to navigate to it.
"""


# In-memory session store
sessions: dict[str, dict] = {}


class StartRequest(BaseModel):
    task: str
    viewport_width: int = 1280
    viewport_height: int = 800


class StepRequest(BaseModel):
    image: str
    elements: list[dict] | None = None
    scroll_containers: list[dict] | None = None
    popup: dict | None = None
    captcha: dict | None = None
    dialog: dict | None = None
    agent_tabs: list[dict] | None = None
    loop_warning: str | None = None
    is_canvas_heavy: bool = False


@app.post("/session/start")
async def start_session(req: StartRequest):
    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "task": req.task,
        "viewport_width": req.viewport_width,
        "viewport_height": req.viewport_height,
        "history": [],
    }
    return {"session_id": session_id}


def _format_elements(elements: list[dict] | None, is_canvas: bool) -> str:
    if is_canvas:
        return (
            "PAGE TYPE: Canvas-heavy — element list is unreliable. "
            "Use the screenshot and pixel coordinates."
        )

    if not elements:
        return "No interactive elements detected. Use screenshot and coordinates."

    lines = [f"INTERACTIVE ELEMENTS ({len(elements)} found):"]
    for i, el in enumerate(elements):
        parts = [f"[ref={i}]"]
        parts.append(f"<{el.get('tag', '?')}>")
        if el.get("role") and el["role"] != el.get("tag"):
            parts.append(f'role="{el["role"]}"')
        if el.get("desc"):
            parts.append(f'"{el["desc"]}"')
        if el.get("type"):
            parts.append(f"type={el['type']}")
        if el.get("href"):
            parts.append(f"href={el['href']}")
        if el.get("value"):
            parts.append(f"value=\"{el['value']}\"")
        if el.get("checked"):
            parts.append("(checked)")
        if el.get("disabled"):
            parts.append("(disabled)")
        rect = el.get("rect", {})
        parts.append(
            f"@ ({rect.get('x', 0)},{rect.get('y', 0)} "
            f"{rect.get('width', 0)}x{rect.get('height', 0)})"
        )
        lines.append("  " + " ".join(parts))

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

    lines.append(
        "  -> To scroll a specific container, aim scroll coordinates at its CENTER."
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
    lines.append(
        "  -> Use switch_tab with tabId to change tabs. Use new_tab to open more."
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
            f"  Close button found at center=({close_btn['centerX']},{close_btn['centerY']})"
        )
        lines.append(
            f"  -> DISMISS THIS POPUP FIRST by clicking at ({close_btn['centerX']},{close_btn['centerY']})"
        )
    else:
        lines.append(
            "  No close button detected — look for X button in screenshot or press Escape"
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
    if "turnstile" in ctype.lower() or "recaptcha" in ctype.lower() or "hcaptcha" in ctype.lower():
        lines.append(
            "  -> Try click_captcha first, then stealth_solve if it fails."
        )
    else:
        lines.append(
            "  -> Read the CAPTCHA text/image from the screenshot and enter the answer."
        )
    return "\n".join(lines)


def _format_dialog(dialog: dict | None) -> str:
    if not dialog:
        return ""
    return (
        f"\n⚠ JS DIALOG ({dialog.get('type', 'alert')}):\n"
        f"  Message: \"{dialog.get('message', '')}\"\n"
        f"  -> Use accept_dialog or dismiss_dialog to handle it."
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
        elements_text = _format_elements(req.elements, req.is_canvas_heavy)
        scroll_text = _format_scroll_containers(req.scroll_containers)
        popup_text = _format_popup(req.popup)
        captcha_text = _format_captcha(req.captcha)
        dialog_text = _format_dialog(req.dialog)
        tabs_text = _format_agent_tabs(req.agent_tabs)
        loop_text = f"\n⚠ {req.loop_warning}" if req.loop_warning else ""

        user_parts = [
            Part.from_text(
                text=(
                    f"Task: {session['task']}\n"
                    f"Viewport: {session['viewport_width']}x{session['viewport_height']}px\n"
                    f"Step {len(session['history']) // 2 + 1}\n"
                    f"{loop_text}\n"
                    f"{popup_text}\n"
                    f"{captcha_text}\n"
                    f"{dialog_text}\n"
                    f"{elements_text}\n"
                    f"{scroll_text}\n"
                    f"{tabs_text}\n\n"
                    f"Screenshot:"
                )
            ),
            Part.from_bytes(
                data=base64.b64decode(req.image),
                mime_type="image/png",
            ),
        ]

        contents = list(session["history"])
        contents.append(Content(role="user", parts=user_parts))

        response = client.models.generate_content(
            model="gemini-3-flash-preview",
            config=GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                thinking_config=ThinkingConfig(thinking_budget=8000),
            ),
            contents=contents,
        )

        raw_text = _extract_response_text(response)
        result = _extract_json(raw_text)

        # Save to history (only the clean JSON, not thinking)
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
    return {"status": "ok"}


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
