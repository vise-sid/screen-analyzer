import base64
import json
import os
import re
import uuid
from pathlib import Path

from bs4 import BeautifulSoup, Comment
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from google import genai
from google.genai.types import Content, GenerateContentConfig, Part, ThinkingConfig
from markdownify import markdownify as md
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

# ── Model Configuration ─────────────────────────────────────
EXECUTOR_MODEL = "gemini-3-flash-preview"     # Fast, cheap — handles step-by-step actions
ADVISOR_MODEL = "gemini-3-pro-preview"        # Smarter — plans, re-plans, verifies

# Style directive injected into all advisor prompts — keeps output minimal
ADVISOR_STYLE = """Respond terse. No fluff. Abbreviations OK. Fragments OK.
Drop: articles, filler, pleasantries, hedging, markdown bold/headers.
Pattern: [thing] [action] [reason]. Max 150 words."""

# Expert scraping knowledge baked into the advisor
ADVISOR_EXPERTISE = """Expert scraping strategies (apply relevant ones):

DATA SOURCING — priority order:
1. scrape_network FIRST — most SPAs load data via XHR/Fetch JSON. Cleanest source. Check before touching DOM.
2. JSON-LD / structured data — many pages embed schema.org data in <script type="application/ld+json">. scrape_page captures it.
3. scrape_table for tabular data — faster + structured vs full page scrape.
4. scrape_page as fallback — full DOM→markdown when above fail.

URL INTELLIGENCE:
- Wikipedia: /wiki/Topic (direct, never search)
- Amazon: /s?k=query or /dp/ASIN
- BookMyShow/cinema: Google → site link (URL patterns vary by region)
- News sites: usually clean article pages, scrape_page works well
- E-commerce: product APIs often in network calls, check scrape_network first
- Google: /search?q=query for quick answers

EFFICIENCY TACTICS:
- Multi-page compare: scrape→store→navigate→scrape→store→recall both→done
- Never scroll >2x. If data not visible, scrape_page gets full content including below-fold.
- Cookie banners/popups: dismiss_popup first, then scrape.
- For lists/catalogs: scrape_links first to find target URLs, then navigate directly.
- If page is SPA (React/Angular): scrape_network almost always has clean API JSON.

CANVAS APPS (Google Sheets, Docs, Figma):
- Canvas apps = browser automation is unreliable for data entry. Use APIs instead.
- Google Sheets: ALWAYS use sheets_create + sheets_write API. Never type into canvas cells.
  Pattern: sheets_create title="X" → get spreadsheet_id → sheets_write values=[["row1"],["row2"]] → done with URL.
- fill_cells is a fragile fallback. Prefer API whenever available.

ANTI-PATTERNS to avoid:
- Don't search when direct URL known.
- Don't scroll-and-read when scrape_page gives full content in one shot.
- Don't scrape same page twice. Store first time, recall later.
- Don't give partial answers. Collect all data before reporting."""

ADVISOR_PLAN_PROMPT = """Plan for browser automation agent.

Agent tools: navigate, click, type, scroll, scrape_page (→markdown), scrape_table (→JSON),
scrape_network (capture XHR/Fetch JSON), scrape_links, scrape_metadata,
store/recall (session memory), screenshots, dismiss_popup.

""" + ADVISOR_EXPERTISE + """

Task: {task}

Output: numbered steps (max 8) + one-line strategy. """ + ADVISOR_STYLE

ADVISOR_REPLAN_PROMPT = """Agent stuck. Diagnose + create revised plan.

""" + ADVISOR_EXPERTISE + """

Task: {task}
Original plan: {plan}
Progress: {progress}
URL: {url}
Problem: {problem}
Memory keys: {memory_keys}

Diagnose root cause. If enough data exists to answer, respond EXACTLY: ANSWER NOW: [complete answer]
Otherwise: revised numbered steps avoiding previous failure pattern. """ + ADVISOR_STYLE

ADVISOR_VERIFY_PROMPT = """Verify agent answer completeness + quality.

Task: {task}
Plan: {plan}
Answer: {summary}
Memory: {memory_keys}

Check: all parts of task addressed? Data complete? Nothing obvious missing?
Respond EXACTLY one of:
- VERIFIED
- INCOMPLETE: [what missing + specific next action]"""


def _call_advisor(prompt: str) -> str | None:
    """Call the advisor model (Gemini Pro) for strategic guidance.
    Returns the text response, or None if the call fails."""
    try:
        response = client.models.generate_content(
            model=ADVISOR_MODEL,
            config=GenerateContentConfig(
                thinking_config=ThinkingConfig(thinking_level="low"),
            ),
            contents=prompt,
        )
        text = response.text
        if text and text.strip():
            print(f"  ADVISOR ({ADVISOR_MODEL}): {text[:200]}...")
            return text.strip()
        return None
    except Exception as e:
        print(f"  ADVISOR FAILED: {e}")
        return None


SYSTEM_PROMPT = """<role>
You are an autonomous browser automation agent. You take one action per step to accomplish the user's task. You receive an element list every step and a screenshot only on the first step or when you request one.
</role>

<instructions>
1) STEP 1 — ALWAYS PLAN FIRST: Use the "plan" action on step 1. Think about: what site/app? canvas-based? best tools? direct URL or search? If the task is non-trivial (spreadsheets, multi-step forms, SPAs, data comparison), call ask_advisor IMMEDIATELY after planning to get expert strategy.
2) Analyze the element list. Elements grouped by section. PAGE SCROLL shows position.
3) Act from element list. Screenshot only for visual info (CAPTCHA, complex layout).
4) SCROLL sparingly: max 2-3 times per page. Use scrape_page instead of scrolling.
5) Adapt: if action fails, try different approach. Do NOT repeat failed actions.
6) NAVIGATE DIRECTLY: Known sites → direct URLs. Unsure → google_search first.
7) SCRAPING priority: scrape_network (JSON API) → scrape_table → scrape_page. Once you have data → done.
8) MEMORY: Multi-page tasks → store after each scrape before navigating. recall later.
9) VERIFY: Before done, check your answer covers the full task.

ADVISOR — USE IT ACTIVELY:
- ask_advisor gives you access to a smarter model. USE IT. Don't struggle alone.
- MUST use ask_advisor when: (a) task involves canvas apps (Sheets, Docs, Figma), (b) you don't know how a site works, (c) your action failed twice, (d) the task requires multi-step strategy.
- Call ask_advisor EARLY — before you waste steps guessing. One advisor call saves 10 failed attempts.
- When stuck: STOP immediately → ask_advisor with context about what failed and why.
- ask_advisor with a SPECIFIC question gets better advice. Not "help me" but "How do I enter data into Google Sheets cells? My typing goes into one cell."

WORKFLOW RULES:
- ALWAYS respond with valid JSON. Final answer inside done's summary. NEVER bare text.
- Multi-page: scrape→store→navigate→scrape→store→recall→done.
- dismiss_popup before scraping if cookie banners/modals present.

INPUT SAFETY:
- Fields show ⚡CONTAINS:"..." when they have existing text. Check before typing.
- focus_and_type clears by default. Set clear:false only to append.
- INPUT MISMATCH in ACTION RESULT → re-type with focus_and_type.

GOOGLE WORKSPACE — USE API, NOT BROWSER:
- Google Sheets: sheets_create + sheets_write. NEVER type into canvas cells.
- Google Docs: docs_create (with body text) or docs_write to append. NEVER type into canvas.
- Google Slides: slides_create with slides array [{title,body},...]. NEVER click canvas.
- All create in USER's Drive via OAuth. Return URL in done summary.
- For other canvas apps (Figma, etc.): use fill_cells as fallback or acknowledge limitation.
</instructions>

<response_format>
Respond with a single JSON object. No markdown, no code fences, no text outside the JSON.

{"thought": "brief reasoning", "action": {"type": "...", ...}}

Your previous thoughts and actions are included in the conversation — use them as context.
</response_format>

<actions>
click            {"type":"click","ref":5}                                          Click element [5]
click (coords)   {"type":"click","x":500,"y":300}                                  Click screen coordinates (need screenshot first)
double_click     {"type":"double_click","ref":5}
hover            {"type":"hover","ref":5}
focus_and_type   {"type":"focus_and_type","ref":5,"text":"hello","submit":true}      Click, CLEAR field, type. submit:true presses Enter after. clear:false to append.
type             {"type":"type","text":"hello"}                                     Type into focused field (no clear)
key              {"type":"key","key":"Enter"}                                       Single key: Enter|Tab|Escape|Backspace|Delete|ArrowUp/Down/Left/Right|Space
key_combo        {"type":"key_combo","keys":"Control+a"}                            Key combination: Control+c, Control+v, Control+a, Shift+Tab, etc.
select           {"type":"select","ref":5,"value":"option_value"}
scroll           {"type":"scroll","x":400,"y":400,"deltaX":0,"deltaY":500}          +deltaY=down, -deltaY=up
navigate         {"type":"navigate","url":"https://..."}
back/forward     {"type":"back"} or {"type":"forward"}
wait             {"type":"wait","duration":1000}
extract_text     {"type":"extract_text","ref":5}
scrape_page      {"type":"scrape_page"}                                              Full page → clean Markdown (strips nav/ads/boilerplate). Result in next step.
scrape_table     {"type":"scrape_table","ref":5}                                     Extract table as JSON rows (ref optional — defaults to first table). Result in next step.
scrape_links     {"type":"scrape_links"}                                              All links on page with text, href, and context
scrape_metadata  {"type":"scrape_metadata"}                                           Page metadata (title, OG tags, canonical, language, etc.)
scrape_network   {"type":"scrape_network"}                                            Show captured XHR/Fetch JSON API responses from the page
store            {"type":"store","key":"product_info"}                                Save last action result to session memory under a key
recall           {"type":"recall","key":"product_info"}                               Retrieve stored data from session memory. Result in next step.
screenshot       {"type":"screenshot"}                                              Request a screenshot on the NEXT step (use when element list isn't enough)
new_tab          {"type":"new_tab","url":"https://..."}
switch_tab       {"type":"switch_tab","tabId":12345}
close_tab        {"type":"close_tab","tabId":12345}
click_captcha    {"type":"click_captcha"}                                            Human-like click on CAPTCHA checkbox (Turnstile/reCAPTCHA/hCaptcha)
stealth_solve    {"type":"stealth_solve"}                                            Launch stealth browser to bypass Cloudflare (use when click_captcha fails)
dismiss_popup    {"type":"dismiss_popup"}                                            Force-close popups/modals
accept_dialog    {"type":"accept_dialog"}
dismiss_dialog   {"type":"dismiss_dialog"}
fill_cells       {"type":"fill_cells","startCell":"B1","values":["Apple","Apricot","Avocado"],"direction":"down"}  Fill cells via keyboard. Fragile on canvas apps — prefer sheets_write for Google Sheets.
sheets_create    {"type":"sheets_create","title":"My Sheet"}                          Create Google Spreadsheet via API. Returns spreadsheet_id + URL. RELIABLE — use instead of sheets.new.
sheets_write     {"type":"sheets_write","spreadsheet_id":"abc123","range":"B1","values":[["Apple"],["Apricot"],["Avocado"]]}  Write cells via API. values is 2D array. Each inner array = one row. RELIABLE.
sheets_read      {"type":"sheets_read","spreadsheet_id":"abc123","range":"A1:C10"}    Read cells from spreadsheet via API.
docs_create      {"type":"docs_create","title":"My Doc","body":"Hello world\nParagraph 2"}  Create Google Doc with optional body text. RELIABLE.
docs_write       {"type":"docs_write","document_id":"abc123","content":"\nNew paragraph"}   Append text to existing Google Doc.
docs_read        {"type":"docs_read","document_id":"abc123"}                                Read text content from a Google Doc.
slides_create    {"type":"slides_create","title":"My Deck","slides":[{"title":"Intro","body":"Key points"}]}  Create Google Slides presentation with content.
slides_read      {"type":"slides_read","presentation_id":"abc123"}                          Read slide text from a presentation.
plan             {"type":"plan","plan":"1. Navigate to... 2. Scrape... 3. Store..."}  STEP 1 ONLY: create your execution plan. Think about best URLs, tools, strategy.
google_search    {"type":"google_search","query":"BookMyShow INOX Skycity Borivali"}  Search Google to find URLs, facts, or verify info. Returns top results.
ask_advisor      {"type":"ask_advisor","question":"How to scrape this SPA?"}            Consult a smarter AI for complex reasoning, strategy, or when stuck.
done             {"type":"done","summary":"Your detailed answer here. Can be long. Include all findings."}
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
- ACTION RESULT: When a scrape/extract/recall action returns data, it appears as ACTION RESULT in the next step. Read it carefully — this is the scraped content.
- SESSION MEMORY: A persistent key-value store for the session. Use store after scraping to save data you'll need later. Use recall to retrieve it. Memory survives across all steps and page navigations.
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
    action_result: str | None = None  # Result from scrape/extract/recall actions
    google_token: str | None = None   # OAuth token from Chrome Identity API


@app.post("/session/start")
async def start_session(req: StartRequest):
    session_id = str(uuid.uuid4())

    # ── Flash self-plans via a "plan" action on step 0 ──
    # No Pro call here. The executor (Flash) creates its own plan on step 1
    # using the planning instructions in the system prompt.
    # Pro is reserved for stuck recovery (Ralph Loop) only.

    sessions[session_id] = {
        "task": req.task,
        "viewport_width": req.viewport_width,
        "viewport_height": req.viewport_height,
        "model_outputs": [],       # Model's thought+action from each step
        "action_results": [],      # Parallel list: action result for each step (None if none)
        "memory": {},              # Session memory: key → {"data": str, "step": int, "size": int}
        "compacted_summary": "",   # Accumulated summary of evicted history entries
        "plan": "",                # Set by Flash on step 1 via "plan" action
        "consecutive_loop_warnings": 0,  # Track for Ralph Loop trigger
        "advisor_calls": 0,
        "last_url": "",
        "wants_screenshot": True,
        "step_count": 0,
    }
    return {"session_id": session_id}


def _format_elements(elements: list[dict] | None, is_canvas: bool) -> str:
    if is_canvas:
        return (
            "<page_elements>\n"
            "PAGE TYPE: Canvas-heavy — use screenshot and pixel coordinates.\n"
            "</page_elements>"
        )

    if not elements:
        return (
            "<page_elements>\n"
            "No interactive elements. Use screenshot and coordinates.\n"
            "</page_elements>"
        )

    # Group elements by their landmark section
    groups: dict[str, list[tuple[int, dict]]] = {}
    for i, el in enumerate(elements):
        group = el.get("group") or "Page"
        if group not in groups:
            groups[group] = []
        groups[group].append((i, el))

    lines = [f"<page_elements>\nELEMENTS ({len(elements)}):"]
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
            if el.get("checked"):
                attrs += " checked"
            if el.get("disabled"):
                attrs += " disabled"

            # Make current input values highly visible — not buried as an attribute
            value_indicator = ""
            if el.get("value"):
                value_indicator = f' ⚡CONTAINS:"{el["value"]}"'

            if desc:
                lines.append(f"[{i}]<{tag}{attrs}>{desc}</{tag}>{value_indicator}")
            else:
                lines.append(f"[{i}]<{tag}{attrs}/>{value_indicator}")

    lines.append("</page_elements>")
    return "\n".join(lines)


def _format_scroll_containers(containers: list[dict] | None) -> str:
    if not containers:
        return ""

    lines = [f"<scroll_containers>\nSCROLL CONTAINERS ({len(containers)} found):"]
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

    lines.append("</scroll_containers>")
    return "\n".join(lines)


def _format_agent_tabs(tabs: list[dict] | None) -> str:
    if not tabs or len(tabs) <= 1:
        return ""

    lines = [f"<agent_tabs>\nAGENT TABS ({len(tabs)} open):"]
    for t in tabs:
        active = " (ACTIVE)" if t.get("isActive") else ""
        url = t.get("url", "")
        if len(url) > 80:
            url = url[:80] + "..."
        lines.append(
            f"  tabId={t.get('tabId')} \"{t.get('title', '?')}\"{active} — {url}"
        )
    lines.append("</agent_tabs>")
    return "\n".join(lines)


def _format_alerts(
    popup: dict | None,
    captcha: dict | None,
    dialog: dict | None,
    loading: bool,
    loop_warning: str | None,
) -> str:
    """Group all warnings/alerts into a single <alerts> section. Empty if no alerts."""
    parts = []

    if loop_warning:
        parts.append(f"⚠ {loop_warning}")

    if loading:
        parts.append("⏳ PAGE LOADING — use wait before interacting")

    if popup:
        rect = popup.get("rect", {})
        close_btn = popup.get("closeButton")
        text = (
            f"⚠ POPUP/MODAL ({popup.get('type', 'popup')}): "
            f"({rect.get('x', 0)},{rect.get('y', 0)} "
            f"{rect.get('width', 0)}x{rect.get('height', 0)})"
        )
        if close_btn:
            text += f" Close at ({close_btn['centerX']},{close_btn['centerY']})"
        parts.append(text)

    if captcha:
        ctype = captcha.get("type", "unknown")
        rect = captcha.get("rect", {})
        text = (
            f"⚠ CAPTCHA ({ctype}): "
            f"({rect.get('x', 0)},{rect.get('y', 0)} "
            f"{rect.get('width', 0)}x{rect.get('height', 0)})"
        )
        click_target = captcha.get("clickTarget")
        if click_target:
            text += f" Checkbox at ({click_target.get('x', 0)},{click_target.get('y', 0)})"
        parts.append(text)

    if dialog:
        parts.append(
            f"⚠ JS DIALOG ({dialog.get('type', 'alert')}): "
            f"\"{dialog.get('message', '')}\""
        )

    if not parts:
        return ""

    return "<alerts>\n" + "\n".join(parts) + "\n</alerts>"


def _format_memory(memory: dict) -> str:
    """Format session memory summary wrapped in <memory> tags."""
    if not memory:
        return ""
    total = sum(m["size"] for m in memory.values())
    lines = [f"<memory>\nSESSION MEMORY ({len(memory)} items, {total / 1024:.1f}KB total):"]
    for key, m in memory.items():
        preview = m["data"][:60].replace("\n", " ").strip()
        lines.append(
            f'  - "{key}" ({m["size"] / 1024:.1f}KB, step {m["step"]}) — {preview}...'
        )
    lines.append("Use recall to retrieve full content. Use store to save new data.")
    lines.append("</memory>")
    return "\n".join(lines)


def _compact_history(session: dict) -> None:
    """Compact oldest history entries into a summary instead of dropping them.

    When history exceeds 15 entries, extract the oldest 5, build a deterministic
    summary from their thoughts + action types, append to compacted_summary,
    and remove from history lists.
    """
    outputs = session["model_outputs"]
    results = session["action_results"]

    if len(outputs) <= 15:
        return

    # Extract the oldest 5 entries to compact
    num_to_compact = 5
    to_compact = outputs[:num_to_compact]
    results_to_compact = results[:num_to_compact]

    # Calculate the step offset (these are the earliest remaining steps)
    current_step = session["step_count"]
    total_history = len(outputs)
    first_step = current_step - total_history + 1

    # Build summary from thoughts and action types
    summary_lines = []
    for i, entry_json in enumerate(to_compact):
        step_num = first_step + i
        try:
            entry = json.loads(entry_json)
            thought = entry.get("thought", "")[:100]
            action = entry.get("action", {})
            action_type = action.get("type", "unknown")

            # Build a concise line
            detail = ""
            if action_type == "navigate":
                detail = f" → {action.get('url', '')[:60]}"
            elif action_type in ("scrape_page", "scrape_table", "scrape_links"):
                ar = results_to_compact[i]
                size = f" ({len(ar)} chars)" if ar else ""
                detail = f"{size}"
            elif action_type == "click":
                detail = f" ref={action.get('ref', '?')}"
            elif action_type == "store":
                detail = f" key=\"{action.get('key', '')}\""
            elif action_type == "done":
                detail = f": {action.get('summary', '')[:80]}"

            summary_lines.append(f"  Step {step_num}: [{action_type}{detail}] {thought}")
        except (json.JSONDecodeError, KeyError):
            summary_lines.append(f"  Step {first_step + i}: [unknown]")

    new_summary = f"Steps {first_step}-{first_step + num_to_compact - 1}:\n" + "\n".join(summary_lines)

    # Append to existing compacted summary
    existing = session.get("compacted_summary", "")
    if existing:
        session["compacted_summary"] = existing + "\n" + new_summary
    else:
        session["compacted_summary"] = new_summary

    # Remove the compacted entries
    session["model_outputs"] = outputs[num_to_compact:]
    session["action_results"] = results[num_to_compact:]


# ── Firecrawl-style HTML Cleaning & Scraping ────────────────

# Boilerplate selectors to remove (inspired by Firecrawl's 42-selector list)
BOILERPLATE_SELECTORS = [
    "script", "style", "noscript", "meta", "link",
    "header", "footer", "nav", "aside",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']",
    "[role='complementary']",
    ".sidebar", "#sidebar", ".nav", ".navbar", ".menu",
    ".footer", "#footer", ".header", "#header",
    ".ad", ".ads", ".advert", ".advertisement", "[class*='ad-']",
    "[class*='cookie']", "[class*='consent']", "[id*='cookie']",
    ".modal", ".popup", ".overlay", "[class*='popup']",
    ".breadcrumb", ".breadcrumbs",
    ".social", ".social-media", ".share", "[class*='social']",
    ".widget", ".widgets",
    ".lang-selector", ".language-selector",
    ".newsletter", ".subscribe",
    ".comments", "#comments", ".comment-form",
    "[aria-hidden='true']",
]


def _clean_html(html: str, only_main_content: bool = True) -> BeautifulSoup:
    """Clean HTML by removing boilerplate elements (Firecrawl-style)."""
    soup = BeautifulSoup(html, "html.parser")

    # Remove comments
    for comment in soup.find_all(string=lambda t: isinstance(t, Comment)):
        comment.extract()

    if only_main_content:
        # Try to find main content container first
        main = (
            soup.find("main")
            or soup.find(attrs={"role": "main"})
            or soup.find("article")
        )

        if main:
            # Use main content only — but still clean it
            soup = BeautifulSoup(str(main), "html.parser")
        else:
            # No main container found — remove boilerplate from full page
            for selector in BOILERPLATE_SELECTORS:
                try:
                    for el in soup.select(selector):
                        el.decompose()
                except Exception:
                    continue

    # Always remove scripts/styles even inside main
    for tag in soup.find_all(["script", "style", "noscript"]):
        tag.decompose()

    return soup


def scrape_page_to_markdown(html: str) -> dict:
    """Convert full HTML page to clean Markdown."""
    soup = _clean_html(html, only_main_content=True)

    # Extract title before conversion
    title_tag = BeautifulSoup(html, "html.parser").find("title")
    title = title_tag.get_text(strip=True) if title_tag else ""

    # Convert to Markdown using markdownify
    # Remove images before conversion (not useful as text for LLM)
    for img in soup.find_all("img"):
        alt = img.get("alt", "")
        if alt:
            img.replace_with(f"[Image: {alt}]")
        else:
            img.decompose()

    markdown = md(
        str(soup),
        heading_style="ATX",
        bullets="-",
    )

    # Clean up excessive whitespace
    markdown = re.sub(r"\n{3,}", "\n\n", markdown).strip()

    # Truncate if needed
    truncated = False
    if len(markdown) > 10000:
        markdown = markdown[:10000]
        truncated = True
        markdown += f"\n\n[Content truncated at 10000 chars]"

    word_count = len(markdown.split())

    return {
        "markdown": markdown,
        "title": title,
        "wordCount": word_count,
        "truncated": truncated,
    }


def scrape_table_from_html(html: str) -> dict:
    """Extract a table from HTML as structured JSON rows."""
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table")

    if not table:
        return {"headers": [], "rows": [], "rowCount": 0, "error": "No table found"}

    # ── Detect key-value table (Wikipedia infobox style) ──
    # If most rows have exactly 1 <th> + 1 <td>, treat as key-value pairs
    all_rows = table.find_all("tr")
    kv_rows = 0
    for tr in all_rows:
        ths = tr.find_all("th", recursive=False)
        tds = tr.find_all("td", recursive=False)
        if len(ths) == 1 and len(tds) == 1:
            kv_rows += 1

    is_key_value = kv_rows > len(all_rows) * 0.4 and kv_rows >= 3

    if is_key_value:
        headers = ["Spec", "Value"]
        rows = []
        for tr in all_rows:
            ths = tr.find_all("th", recursive=False)
            tds = tr.find_all("td", recursive=False)
            if len(ths) == 1 and len(tds) == 1:
                key = ths[0].get_text(strip=True)
                val = tds[0].get_text(strip=True)
                if key:  # Skip empty header rows
                    rows.append({"Spec": key, "Value": val})
            elif len(ths) >= 1 and len(tds) == 0:
                # Section header row (e.g., colspan title) — include as context
                text = tr.get_text(strip=True)
                if text:
                    rows.append({"Spec": f"--- {text} ---", "Value": ""})

        truncated = len(rows) > 200
        if truncated:
            rows = rows[:200]

        return {
            "headers": headers,
            "rows": rows,
            "rowCount": len(rows),
            "truncated": truncated,
            "format": "key_value",
        }

    # ── Standard table with header row ──
    headers = []
    thead = table.find("thead")
    if thead:
        header_row = thead.find("tr")
        if header_row:
            headers = [
                th.get_text(strip=True) for th in header_row.find_all(["th", "td"])
            ]

    data_rows = all_rows

    if not headers and all_rows:
        first_row = all_rows[0]
        cells = first_row.find_all(["th", "td"])
        if first_row.find("th"):
            headers = [c.get_text(strip=True) for c in cells]
            data_rows = all_rows[1:]
        else:
            headers = [f"column_{i + 1}" for i in range(len(cells))]
    elif headers:
        data_rows = all_rows[1:] if thead is None else [
            tr for tr in all_rows if tr.parent != thead
        ]

    rows = []
    for tr in data_rows:
        if tr.find_parent("thead"):
            continue
        cells = tr.find_all(["td", "th"])
        if not cells:
            continue
        row = {}
        for i, cell in enumerate(cells):
            key = headers[i] if i < len(headers) else f"column_{i + 1}"
            row[key] = cell.get_text(strip=True)
        rows.append(row)

    truncated = len(rows) > 200
    if truncated:
        rows = rows[:200]

    return {
        "headers": headers,
        "rows": rows,
        "rowCount": len(rows),
        "truncated": truncated,
        "format": "standard",
    }


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

    # Scraping actions
    elif action_type == "scrape_page":
        return {"type": "scrape_page"}

    elif action_type == "scrape_table":
        ref_match = re.search(r'"ref"\s*:\s*(\d+)', raw)
        return {"type": "scrape_table", "ref": int(ref_match.group(1)) if ref_match else None}

    elif action_type == "scrape_links":
        return {"type": "scrape_links"}

    elif action_type == "scrape_metadata":
        return {"type": "scrape_metadata"}

    elif action_type == "scrape_network":
        return {"type": "scrape_network"}

    # Memory actions
    elif action_type == "store":
        key_match = re.search(r'"key"\s*:\s*"([^"]*)"', raw)
        return {"type": "store", "key": key_match.group(1) if key_match else "default"}

    elif action_type == "recall":
        key_match = re.search(r'"key"\s*:\s*"([^"]*)"', raw)
        return {"type": "recall", "key": key_match.group(1) if key_match else "default"}

    elif action_type == "sheets_create":
        title_match = re.search(r'"title"\s*:\s*"([^"]*)"', raw)
        return {"type": "sheets_create", "title": title_match.group(1) if title_match else "Untitled"}

    elif action_type == "sheets_write":
        id_match = re.search(r'"spreadsheet_id"\s*:\s*"([^"]*)"', raw)
        range_match = re.search(r'"range"\s*:\s*"([^"]*)"', raw)
        return {
            "type": "sheets_write",
            "spreadsheet_id": id_match.group(1) if id_match else "",
            "range": range_match.group(1) if range_match else "A1",
            "values": [],
        }

    elif action_type == "sheets_read":
        id_match = re.search(r'"spreadsheet_id"\s*:\s*"([^"]*)"', raw)
        range_match = re.search(r'"range"\s*:\s*"([^"]*)"', raw)
        return {
            "type": "sheets_read",
            "spreadsheet_id": id_match.group(1) if id_match else "",
            "range": range_match.group(1) if range_match else "A1:Z100",
        }

    elif action_type == "fill_cells":
        cell_match = re.search(r'"startCell"\s*:\s*"([^"]*)"', raw)
        dir_match = re.search(r'"direction"\s*:\s*"([^"]*)"', raw)
        # Try to extract values array
        vals_match = re.search(r'"values"\s*:\s*\[([^\]]*)\]', raw)
        values = []
        if vals_match:
            values = [v.strip().strip('"').strip("'") for v in vals_match.group(1).split(",") if v.strip()]
        return {
            "type": "fill_cells",
            "startCell": cell_match.group(1) if cell_match else "A1",
            "values": values,
            "direction": dir_match.group(1) if dir_match else "down",
        }

    elif action_type == "key_combo":
        keys_match = re.search(r'"keys"\s*:\s*"([^"]*)"', raw)
        if keys_match:
            return {"type": "key_combo", "keys": keys_match.group(1)}

    elif action_type == "plan":
        plan_match = re.search(r'"plan"\s*:\s*"([^"]*(?:\\.[^"]*)*)"', raw)
        return {"type": "plan", "plan": plan_match.group(1) if plan_match else ""}

    elif action_type == "google_search":
        q_match = re.search(r'"query"\s*:\s*"([^"]*)"', raw)
        return {"type": "google_search", "query": q_match.group(1) if q_match else ""}

    elif action_type == "ask_advisor":
        q_match = re.search(r'"question"\s*:\s*"([^"]*)"', raw)
        return {"type": "ask_advisor", "question": q_match.group(1) if q_match else "Need help"}

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
        session["step_count"] += 1
        step_num = session["step_count"]

        # ── Auto-store scrape results in session memory ──
        if req.action_result and len(req.action_result) > 20:
            url_slug = (req.url or "page").split("/")[-1].split("?")[0][:30] or "page"
            auto_key = f"scrape_{url_slug}_{step_num - 1}"
            session["memory"][auto_key] = {
                "data": req.action_result,
                "step": step_num - 1,
                "size": len(req.action_result),
            }
            print(f"  AUTO-STORED: \"{auto_key}\" ({len(req.action_result)} chars)")

        # ── Format all sections ──
        elements_text = _format_elements(req.elements, req.is_canvas_heavy)
        scroll_text = _format_scroll_containers(req.scroll_containers)
        tabs_text = _format_agent_tabs(req.agent_tabs)
        memory_text = _format_memory(session.get("memory", {}))
        alerts_text = _format_alerts(
            req.popup, req.captcha, req.dialog,
            req.page_loading, req.loop_warning,
        )

        # ── Ralph Loop: re-plan when stuck ──
        if req.loop_warning:
            session["consecutive_loop_warnings"] = session.get("consecutive_loop_warnings", 0) + 1
        else:
            session["consecutive_loop_warnings"] = 0

        if session["consecutive_loop_warnings"] >= 1:
            print(f"  RALPH LOOP TRIGGERED (loop #{session['consecutive_loop_warnings']}) — consulting advisor")
            # Build progress summary
            progress_lines = []
            if session.get("compacted_summary"):
                progress_lines.append(session["compacted_summary"])
            for out in session["model_outputs"][-5:]:
                try:
                    entry = json.loads(out)
                    progress_lines.append(
                        f"  [{entry.get('action',{}).get('type','?')}] {entry.get('thought','')[:80]}"
                    )
                except Exception:
                    pass

            memory_keys = list(session["memory"].keys()) if session.get("memory") else []
            replan_prompt = ADVISOR_REPLAN_PROMPT.format(
                task=session["task"],
                plan=session["plan"],
                progress="\n".join(progress_lines) or "(no progress recorded)",
                url=req.url or "(unknown)",
                problem=req.loop_warning,
                memory_keys=memory_keys,
            )
            advice = _call_advisor(replan_prompt)
            if advice:
                session["advisor_calls"] = session.get("advisor_calls", 0) + 1
                if advice.strip().startswith("ANSWER NOW:"):
                    # Advisor says agent has enough data — force done
                    answer = advice.replace("ANSWER NOW:", "", 1).strip()
                    print(f"  ADVISOR: ANSWER NOW — forcing done")
                    session["consecutive_loop_warnings"] = 0
                    result = {
                        "thought": "(Advisor determined answer is ready)",
                        "action": {"type": "done", "summary": answer},
                    }
                    session["model_outputs"].append(json.dumps(result))
                    session["action_results"].append(req.action_result)
                    return result
                else:
                    # Advisor provided a new plan
                    session["plan"] = advice
                    session["consecutive_loop_warnings"] = 0
                    print(f"  ADVISOR: New plan applied")

        # Page scroll
        ps = req.page_scroll
        if ps:
            dirs = []
            if ps.get("canScrollUp"):
                dirs.append("up")
            if ps.get("canScrollDown"):
                dirs.append("down")
            scroll_pos = (
                f"PAGE SCROLL: {ps.get('scrollPct', 0)}% "
                f"(can scroll: {', '.join(dirs) if dirs else 'none'})"
            )
        else:
            scroll_pos = ""

        # Action result from previous step
        action_result_section = ""
        if req.action_result:
            truncated = req.action_result[:10000]
            if len(req.action_result) > 10000:
                truncated += f"\n[... truncated, {len(req.action_result)} total chars]"
            action_result_section = f"<previous_action_result>\n{truncated}\n</previous_action_result>"

        # Session summary (compacted history)
        summary_section = ""
        if session.get("compacted_summary"):
            summary_section = (
                f"<session_summary>\n{session['compacted_summary']}\n</session_summary>"
            )

        # ── Page context: detect URL change ──
        current_url = req.url or ""
        last_url = session.get("last_url", "")
        page_changed = current_url != last_url and last_url != ""
        session["last_url"] = current_url

        if page_changed:
            page_marker = "⚡ PAGE CHANGED"
        else:
            page_marker = "↻ SAME PAGE" if step_num > 1 else ""

        # ── Screenshot ──
        include_screenshot = session.get("wants_screenshot", False)
        has_screenshot = include_screenshot and req.image is not None and len(req.image) > 0
        if page_changed and req.image:
            has_screenshot = True
        if req.captcha and req.image:
            has_screenshot = True
        screenshot_note = "Screenshot attached." if has_screenshot else ""

        # ── Build structured prompt ──
        # Assemble only non-empty sections
        sections = []

        # 1. Task (always present)
        sections.append(f"<task>{session['task']}</task>")

        # 1b. Plan (if advisor created one)
        if session.get("plan"):
            sections.append(f"<plan>\n{session['plan']}\n</plan>")

        # 2. State (always present)
        state_lines = [f"Step {step_num} | {page_marker}"]
        if current_url:
            state_lines.append(f"URL: {current_url}")
        if scroll_pos:
            state_lines.append(scroll_pos)
        if screenshot_note:
            state_lines.append(screenshot_note)
        sections.append("<state>\n" + "\n".join(state_lines) + "\n</state>")

        # 3. Alerts (only if any)
        if alerts_text:
            sections.append(alerts_text)

        # 4. Action result (only if present)
        if action_result_section:
            sections.append(action_result_section)

        # 5. Session summary (only if compacted history exists)
        if summary_section:
            sections.append(summary_section)

        # 6. Memory (only if items stored)
        if memory_text:
            sections.append(memory_text)

        # 7. Elements (always present — main body)
        sections.append(elements_text)

        # 8. Scroll containers (only if present)
        if scroll_text:
            sections.append(scroll_text)

        # 9. Agent tabs (only if >1)
        if tabs_text:
            sections.append(tabs_text)

        prompt_text = "\n\n".join(sections)

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

        # ── Build context: model outputs from previous steps + current full input ──
        # Tool output offloading: large action results replaced with references
        # (full data lives in session memory, accessible via recall)
        contents = []
        for i, prev_output in enumerate(session["model_outputs"]):
            ar = session["action_results"][i] if i < len(session["action_results"]) else None
            if ar and len(ar) > 500:
                # Offload: replace large results with a reference
                user_text = (
                    f"Continue.\nACTION RESULT: "
                    f"[Stored in session memory — {len(ar)} chars. Use recall to access full data.]"
                )
            elif ar:
                user_text = f"Continue.\nACTION RESULT:\n{ar}"
            else:
                user_text = "Continue."
            contents.append(Content(role="user", parts=[Part.from_text(text=user_text)]))
            contents.append(Content(role="model", parts=[Part.from_text(text=prev_output)]))
        contents.append(Content(role="user", parts=user_parts))

        response = client.models.generate_content(
            model=EXECUTOR_MODEL,
            config=GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                thinking_config=ThinkingConfig(thinking_level="low"),
            ),
            contents=contents,
        )

        raw_text = _extract_response_text(response)
        result = _extract_json(raw_text)

        # ── Handle plan: Flash creates its own plan on step 1 ──
        action = result.get("action", {})
        if action.get("type") == "plan":
            session["plan"] = action.get("plan", "")
            result["_plan_set"] = True
            print(f"  PLAN SET: {session['plan'][:200]}")

        # ── Handle google_search: search Google and return results ──
        if action.get("type") == "google_search":
            query = action.get("query", "")
            if query:
                try:
                    search_url = f"https://www.google.com/search?q={query.replace(' ', '+')}"
                    # Use a lightweight scrape of Google results page
                    # The result goes back as action_result via _search_data
                    import urllib.request
                    import urllib.parse
                    search_api = f"https://www.googleapis.com/customsearch/v1?q={urllib.parse.quote(query)}&key={os.getenv('GOOGLE_SEARCH_API_KEY', '')}&cx={os.getenv('GOOGLE_SEARCH_CX', '')}"
                    # Fallback: just tell the agent to navigate to Google search
                    result["_search_data"] = (
                        f"Google search URL: {search_url}\n"
                        f"Navigate to this URL to see results, or use these common patterns:\n"
                        f"- Wikipedia: https://en.wikipedia.org/wiki/{{Topic}}\n"
                        f"- Amazon India: https://www.amazon.in/s?k={{query}}\n"
                        f"- Flipkart: https://www.flipkart.com/search?q={{query}}\n"
                        f"- BookMyShow: https://in.bookmyshow.com/explore/movies-{{city}}"
                    )
                    print(f"  GOOGLE SEARCH: {query}")
                except Exception as e:
                    result["_search_data"] = f"Search failed: {e}. Navigate to https://www.google.com/search?q={query.replace(' ', '+')}"

        # ── Handle ask_advisor: consult Pro model for complex reasoning ──
        if action.get("type") == "ask_advisor":
            question = action.get("question", "")
            # Build context for the advisor
            memory_keys = list(session["memory"].keys()) if session.get("memory") else []
            advisor_context = (
                f"Agent question: {question}\n"
                f"Task: {session['task']}\n"
                f"Current plan: {session.get('plan', 'none')}\n"
                f"URL: {req.url or 'unknown'}\n"
                f"Memory: {memory_keys}\n"
                f"Step: {step_num}"
            )
            advice = _call_advisor(advisor_context)
            session["advisor_calls"] = session.get("advisor_calls", 0) + 1
            if advice:
                result["_advisor_response"] = advice
                print(f"  ADVISOR RESPONSE: {advice[:200]}")
            else:
                result["_advisor_response"] = "(Advisor unavailable. Continue with your best judgment.)"

        # ── Handle Google Workspace API actions (Sheets, Docs, Slides) ──
        google_actions = {
            "sheets_create", "sheets_write", "sheets_read",
            "docs_create", "docs_write", "docs_read",
            "slides_create", "slides_read",
        }
        if action.get("type") in google_actions:
            token = req.google_token
            if not token:
                result["_gwork_result"] = {
                    "error": "Google not connected. The extension needs to provide an OAuth token via chrome.identity."
                }
            else:
                try:
                    atype = action["type"]
                    data = None

                    # Sheets
                    if atype == "sheets_create":
                        data = await sheets_create(SheetsCreateRequest(
                            title=action.get("title", "Untitled"), token=token,
                        ))
                    elif atype == "sheets_write":
                        data = await sheets_write(SheetsWriteRequest(
                            spreadsheet_id=action.get("spreadsheet_id", ""),
                            range=action.get("range", "A1"),
                            values=action.get("values", []), token=token,
                        ))
                    elif atype == "sheets_read":
                        data = await sheets_read(SheetsReadRequest(
                            spreadsheet_id=action.get("spreadsheet_id", ""),
                            range=action.get("range", "A1:Z100"), token=token,
                        ))

                    # Docs
                    elif atype == "docs_create":
                        data = await docs_create(DocsCreateRequest(
                            title=action.get("title", "Untitled"),
                            body=action.get("body", ""), token=token,
                        ))
                    elif atype == "docs_write":
                        data = await docs_write(DocsWriteRequest(
                            document_id=action.get("document_id", ""),
                            content=action.get("content", ""), token=token,
                        ))
                    elif atype == "docs_read":
                        data = await docs_read(DocsReadRequest(
                            document_id=action.get("document_id", ""), token=token,
                        ))

                    # Slides
                    elif atype == "slides_create":
                        data = await slides_create(SlidesCreateRequest(
                            title=action.get("title", "Untitled"),
                            slides=action.get("slides"), token=token,
                        ))
                    elif atype == "slides_read":
                        data = await slides_read(SlidesReadRequest(
                            presentation_id=action.get("presentation_id", ""),
                            token=token,
                        ))

                    result["_gwork_result"] = data
                    print(f"  GOOGLE WORKSPACE [{atype}]: {json.dumps(data)[:200]}")

                except Exception as e:
                    result["_gwork_result"] = {"error": str(e)}

        # ── Handle screenshot request: model asks for visual context ──
        if action.get("type") == "screenshot":
            session["wants_screenshot"] = True
            # Don't save to history — this is a meta-action, not a real step
            print(f"  MODEL REQUESTED SCREENSHOT — will include on next step")
            print(f"{'='*60}\n")
            return result

        # ── Handle store: save data to session memory ──
        if action.get("type") == "store":
            key = action.get("key", f"item_{step_num}")
            # Data comes from the action_result (last scrape/extract result sent by extension)
            data = req.action_result or action.get("data", "")
            if data:
                session["memory"][key] = {
                    "data": data,
                    "step": step_num,
                    "size": len(data),
                }
                result["_stored"] = True
                result["_store_key"] = key
                result["_store_size"] = len(data)
                print(f"  STORED to memory: \"{key}\" ({len(data)} chars)")
            else:
                result["_stored"] = False
                result["_store_error"] = "No data to store. Use a scrape/extract action first."
                print(f"  STORE FAILED: no data available for key \"{key}\"")

        # ── Handle recall: retrieve data from session memory ──
        if action.get("type") == "recall":
            key = action.get("key", "")
            mem = session["memory"].get(key)
            if mem:
                result["_recall_data"] = mem["data"]
                print(f"  RECALLED from memory: \"{key}\" ({mem['size']} chars)")
            else:
                available = list(session["memory"].keys())
                result["_recall_data"] = (
                    f"(no memory item '{key}'. "
                    f"Available keys: {available if available else 'none'})"
                )
                print(f"  RECALL FAILED: key \"{key}\" not found")

        # ── Debug: save response ──
        debug_resp_path = DEBUG_DIR / f"{step_prefix}_response.json"
        debug_resp_path.write_text(json.dumps(result, indent=2))

        print(f"  MODEL RESPONSE:")
        print(f"  {json.dumps(result, indent=2)}")
        print(f"{'='*60}\n")

        # Append model's output and action result to history (parallel lists)
        session["model_outputs"].append(json.dumps(result))
        session["action_results"].append(req.action_result)

        # Context compaction: summarize oldest entries instead of dropping them
        _compact_history(session)

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
            return {"thought": "(Recovered from malformed JSON)", "action": action}

        # ── Auto-wrap prose responses as "done" ──
        # If the model produced a substantive text answer (not JSON), it likely
        # has the answer and broke format. Wrap it as a done action instead of
        # falling back to wait (which causes infinite loops).
        if raw and len(raw) > 50 and '"type"' not in raw:
            summary = raw[:2000] if len(raw) > 2000 else raw
            print(f"  AUTO-WRAPPED prose response as done ({len(raw)} chars)")
            result = {
                "thought": "(Model produced prose answer — auto-wrapped as done)",
                "action": {"type": "done", "summary": summary},
            }
            session["model_outputs"].append(json.dumps(result))
            session["action_results"].append(req.action_result)
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


# ── Scraping Endpoints ──────────────────────────────────────


class ScrapePageRequest(BaseModel):
    html: str


class ScrapeTableRequest(BaseModel):
    html: str


@app.post("/scrape/page")
async def scrape_page(req: ScrapePageRequest):
    """Convert HTML page to clean Markdown using BS4 + markdownify (Firecrawl-style)."""
    try:
        return scrape_page_to_markdown(req.html)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Scrape failed: {str(e)}")


@app.post("/scrape/table")
async def scrape_table(req: ScrapeTableRequest):
    """Extract a table from HTML as structured JSON rows."""
    try:
        return scrape_table_from_html(req.html)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Table scrape failed: {str(e)}")


# ── Google Sheets API (user OAuth via Chrome Identity) ───────


def _get_gspread_client_for_token(token: str):
    """Create a gspread client authenticated with the user's OAuth token."""
    import gspread
    from google.oauth2.credentials import Credentials

    creds = Credentials(token=token)
    return gspread.authorize(creds)


class SheetsCreateRequest(BaseModel):
    title: str = "Untitled Spreadsheet"
    token: str  # OAuth access token from Chrome Identity API


class SheetsWriteRequest(BaseModel):
    spreadsheet_id: str
    range: str = "A1"
    values: list[list[str]]  # 2D array: each inner array = one row
    token: str


class SheetsReadRequest(BaseModel):
    spreadsheet_id: str
    range: str = "A1:Z100"
    token: str


@app.post("/sheets/create")
async def sheets_create(req: SheetsCreateRequest):
    """Create a new Google Spreadsheet in the user's Drive via OAuth."""
    try:
        gc = _get_gspread_client_for_token(req.token)
        sh = gc.create(req.title)
        return {
            "spreadsheet_id": sh.id,
            "url": sh.url,
            "title": sh.title,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Sheets create failed: {e}")


@app.post("/sheets/write")
async def sheets_write(req: SheetsWriteRequest):
    """Write values to cells in a Google Spreadsheet."""
    try:
        gc = _get_gspread_client_for_token(req.token)
        sh = gc.open_by_key(req.spreadsheet_id)
        worksheet = sh.sheet1
        worksheet.update(req.range, req.values)
        return {
            "success": True,
            "range": req.range,
            "rows_written": len(req.values),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Sheets write failed: {e}")


@app.post("/sheets/read")
async def sheets_read(req: SheetsReadRequest):
    """Read values from a Google Spreadsheet."""
    try:
        gc = _get_gspread_client_for_token(req.token)
        sh = gc.open_by_key(req.spreadsheet_id)
        worksheet = sh.sheet1
        values = worksheet.get(req.range)
        return {
            "values": values,
            "rows": len(values),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Sheets read failed: {e}")


# ── Google Docs API (user OAuth) ─────────────────────────────

DOCS_API = "https://docs.googleapis.com"
SLIDES_API = "https://slides.googleapis.com"


def _google_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


class DocsCreateRequest(BaseModel):
    title: str = "Untitled Document"
    body: str = ""  # Plain text or basic content to insert
    token: str


class DocsWriteRequest(BaseModel):
    document_id: str
    content: str  # Text to append
    token: str


class DocsReadRequest(BaseModel):
    document_id: str
    token: str


@app.post("/docs/create")
async def docs_create(req: DocsCreateRequest):
    """Create a Google Doc in user's Drive and optionally insert content."""
    import httpx
    async with httpx.AsyncClient() as client:
        # Create the doc
        resp = await client.post(
            f"{DOCS_API}/v1/documents",
            headers=_google_headers(req.token),
            json={"title": req.title},
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        doc = resp.json()
        doc_id = doc["documentId"]

        # Insert body content if provided
        if req.body:
            await client.post(
                f"{DOCS_API}/v1/documents/{doc_id}:batchUpdate",
                headers=_google_headers(req.token),
                json={
                    "requests": [
                        {
                            "insertText": {
                                "location": {"index": 1},
                                "text": req.body,
                            }
                        }
                    ]
                },
            )

        return {
            "document_id": doc_id,
            "url": f"https://docs.google.com/document/d/{doc_id}/edit",
            "title": req.title,
        }


@app.post("/docs/write")
async def docs_write(req: DocsWriteRequest):
    """Append text to a Google Doc."""
    import httpx
    async with httpx.AsyncClient() as client:
        # Get current doc length to append at end
        resp = await client.get(
            f"{DOCS_API}/v1/documents/{req.document_id}",
            headers=_google_headers(req.token),
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        doc = resp.json()
        end_index = doc["body"]["content"][-1]["endIndex"] - 1

        # Append text
        resp = await client.post(
            f"{DOCS_API}/v1/documents/{req.document_id}:batchUpdate",
            headers=_google_headers(req.token),
            json={
                "requests": [
                    {
                        "insertText": {
                            "location": {"index": max(1, end_index)},
                            "text": req.content,
                        }
                    }
                ]
            },
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        return {"success": True, "chars_written": len(req.content)}


@app.post("/docs/read")
async def docs_read(req: DocsReadRequest):
    """Read text content from a Google Doc."""
    import httpx
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{DOCS_API}/v1/documents/{req.document_id}",
            headers=_google_headers(req.token),
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        doc = resp.json()
        # Extract plain text from document structure
        text_parts = []
        for element in doc.get("body", {}).get("content", []):
            if "paragraph" in element:
                for part in element["paragraph"].get("elements", []):
                    if "textRun" in part:
                        text_parts.append(part["textRun"]["content"])

        return {
            "title": doc.get("title", ""),
            "text": "".join(text_parts),
            "document_id": req.document_id,
        }


# ── Google Slides API (user OAuth) ───────────────────────────


class SlidesCreateRequest(BaseModel):
    title: str = "Untitled Presentation"
    slides: list[dict] | None = None  # [{"title": "...", "body": "..."}, ...]
    token: str


class SlidesReadRequest(BaseModel):
    presentation_id: str
    token: str


@app.post("/slides/create")
async def slides_create(req: SlidesCreateRequest):
    """Create a Google Slides presentation with optional slide content."""
    import httpx
    async with httpx.AsyncClient() as client:
        # Create the presentation
        resp = await client.post(
            f"{SLIDES_API}/v1/presentations",
            headers=_google_headers(req.token),
            json={"title": req.title},
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        pres = resp.json()
        pres_id = pres["presentationId"]

        # Add slides with content if provided
        if req.slides:
            requests_list = []
            for i, slide_data in enumerate(req.slides):
                slide_id = f"slide_{i}"
                # Create new slide
                requests_list.append({
                    "createSlide": {
                        "objectId": slide_id,
                        "insertionIndex": i + 1,  # After title slide
                        "slideLayoutReference": {"predefinedLayout": "TITLE_AND_BODY"},
                    }
                })
                # Set title
                if slide_data.get("title"):
                    requests_list.append({
                        "insertText": {
                            "objectId": f"{slide_id}_title",
                            "text": slide_data["title"],
                        }
                    })
                # Set body
                if slide_data.get("body"):
                    requests_list.append({
                        "insertText": {
                            "objectId": f"{slide_id}_body",
                            "text": slide_data["body"],
                        }
                    })

            if requests_list:
                try:
                    await client.post(
                        f"{SLIDES_API}/v1/presentations/{pres_id}:batchUpdate",
                        headers=_google_headers(req.token),
                        json={"requests": requests_list},
                    )
                except Exception:
                    pass  # Slide content insertion is best-effort

        return {
            "presentation_id": pres_id,
            "url": f"https://docs.google.com/presentation/d/{pres_id}/edit",
            "title": req.title,
        }


@app.post("/slides/read")
async def slides_read(req: SlidesReadRequest):
    """Read slide content from a Google Slides presentation."""
    import httpx
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{SLIDES_API}/v1/presentations/{req.presentation_id}",
            headers=_google_headers(req.token),
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        pres = resp.json()
        slides = []
        for slide in pres.get("slides", []):
            texts = []
            for element in slide.get("pageElements", []):
                shape = element.get("shape", {})
                for para in shape.get("text", {}).get("textElements", []):
                    if "textRun" in para:
                        texts.append(para["textRun"]["content"])
            slides.append({"text": "".join(texts).strip()})

        return {
            "title": pres.get("title", ""),
            "slides": slides,
            "slide_count": len(slides),
        }


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
