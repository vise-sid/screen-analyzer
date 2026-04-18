"""
PixelFoxx backend.

The business is the agent loop (see agent.py). This module wires:
  - Auth + per-user usage accounting
  - Builder-session CRUD (POST /sessions, GET /sessions/{id}, POST /sessions/{id}/agent/step, POST /sessions/{id}/save)
  - Playbook read endpoints (GET /playbooks, GET /playbooks/{id})
  - Scraping helpers (/scrape/page, /scrape/table) invoked by the extension
  - Google Workspace OAuth routes (Sheets / Docs / Slides) invoked by the agent
  - Stealth Cloudflare solver

Everything related to the old rule-based "planner" / step loop has been removed.
"""

import json
import os
import re
import uuid
from pathlib import Path

from bs4 import BeautifulSoup, Comment
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai.types import GenerateContentConfig, ThinkingConfig
from markdownify import markdownify as md
from pydantic import BaseModel, Field

load_dotenv()

from auth import AuthenticatedUser, get_current_user  # noqa: E402
from db import (  # noqa: E402
    create_builder_session as db_create_builder_session,
    create_playbook as db_create_playbook,
    get_builder_session as db_get_builder_session,
    get_playbook as db_get_playbook,
    get_user_usage_summary,
    insert_session_message as db_insert_session_message,
    insert_playbook_block as db_insert_playbook_block,
    list_playbook_blocks as db_list_playbook_blocks,
    list_playbooks as db_list_playbooks,
    list_session_messages as db_list_session_messages,
    update_builder_session as db_update_builder_session,
)
from harness import (  # noqa: E402
    BuilderSessionCreateRequest,
    BuilderSessionEnvelope,
    PlaybookInput,
    PlaybookSaveEnvelope,
    SessionHarness,
    SessionMessage,
    build_initial_intent_spec,
    build_saved_playbook,
    build_session_message,
    load_saved_playbook,
    load_session_harness,
    model_dump_json,
    new_session_harness,
    serialize_session_harness,
    session_is_saveable,
)
import agent as pixel_agent  # noqa: E402
from usage import QuotaExceeded, check_quota, record_llm_call  # noqa: E402

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))

# ── Advisor (Gemini Pro) — called by the agent via the `ask_advisor` tool ────

ADVISOR_MODEL = "gemini-3-pro-preview"

ADVISOR_STYLE = """Respond terse. No fluff. Abbreviations OK. Fragments OK.
Drop: articles, filler, pleasantries, hedging, markdown bold/headers.
Pattern: [thing] [action] [reason]. Max 150 words."""


def _call_advisor(
    prompt: str,
    *,
    user_sub: str | None = None,
    session_id: str | None = None,
    purpose: str = "advisor",
) -> str | None:
    """Call the advisor model (Gemini Pro) for strategic guidance.

    Returns the text response, or None if the call fails. Usage is attributed
    to `user_sub` when provided.
    """
    try:
        response = client.models.generate_content(
            model=ADVISOR_MODEL,
            config=GenerateContentConfig(
                thinking_config=ThinkingConfig(thinking_level="low"),
            ),
            contents=prompt,
        )
        if user_sub:
            record_llm_call(
                response=response,
                user_sub=user_sub,
                model=ADVISOR_MODEL,
                session_id=session_id,
                purpose=purpose,
            )
        text = response.text
        if text and text.strip():
            return text.strip()
        return None
    except Exception as e:
        print(f"  ADVISOR FAILED: {e}")
        return None


# ─────────────────────────────────────────────────────────────────────────────
# /me
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/me")
async def me(user: AuthenticatedUser = Depends(get_current_user)):
    """Current user profile + usage summary. Lightweight; safe to poll."""
    return {
        "sub": user.sub,
        "email": user.email,
        "name": user.name,
        "picture": user.picture,
        "usage": get_user_usage_summary(user.sub),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Builder-session persistence helpers
# ─────────────────────────────────────────────────────────────────────────────

def _load_builder_session_or_404(
    session_id: str,
    user: AuthenticatedUser,
) -> SessionHarness:
    row = db_get_builder_session(session_id, user.sub)
    if not row:
        raise HTTPException(status_code=404, detail="Builder session not found")
    return load_session_harness(row)


def _list_builder_session_messages(session_id: str) -> list[SessionMessage]:
    return [SessionMessage(**row) for row in db_list_session_messages(session_id)]


def _persist_builder_session(
    session: SessionHarness,
    user: AuthenticatedUser,
    *,
    create: bool,
) -> None:
    payload = serialize_session_harness(session)
    if create:
        db_create_builder_session(
            session_id=session.session_id,
            user_sub=user.sub,
            status=payload["status"],
            intent_spec_json=payload["intent_spec_json"],
            site_models_json=payload["site_models_json"],
            draft_block_graph_json=payload["draft_block_graph_json"],
            evidence_ledger_json=payload["evidence_ledger_json"],
            gate_state_json=payload["gate_state_json"],
            todo_plan_json=payload["todo_plan_json"],
            active_todo_id=payload["active_todo_id"],
            awaiting_approval=payload["awaiting_approval"],
            gemini_contents_json=payload["gemini_contents_json"],
        )
        return

    db_update_builder_session(
        session_id=session.session_id,
        user_sub=user.sub,
        status=payload["status"],
        intent_spec_json=payload["intent_spec_json"],
        site_models_json=payload["site_models_json"],
        draft_block_graph_json=payload["draft_block_graph_json"],
        evidence_ledger_json=payload["evidence_ledger_json"],
        gate_state_json=payload["gate_state_json"],
        todo_plan_json=payload["todo_plan_json"],
        active_todo_id=payload["active_todo_id"],
        awaiting_approval=payload["awaiting_approval"],
        gemini_contents_json=payload["gemini_contents_json"],
    )


def _append_builder_message(message: SessionMessage) -> None:
    db_insert_session_message(
        message_id=message.id,
        session_id=message.session_id,
        role=message.role,
        message_type=message.message_type,
        content=message.content,
    )


def _persist_agent_messages(
    session_id: str,
    assistant_messages: list[dict],
    system_messages: list[dict],
) -> None:
    for m in assistant_messages:
        _append_builder_message(
            build_session_message(
                session_id=session_id,
                role=m.get("role", "assistant"),
                message_type=m.get("message_type", "chat"),
                content=m.get("content", ""),
            )
        )
    for m in system_messages:
        _append_builder_message(
            build_session_message(
                session_id=session_id,
                role=m.get("role", "system"),
                message_type=m.get("message_type", "system"),
                content=m.get("content", ""),
            )
        )


def _build_builder_session_envelope(session_id: str, user: AuthenticatedUser) -> BuilderSessionEnvelope:
    session = _load_builder_session_or_404(session_id, user)
    return BuilderSessionEnvelope(
        session=session,
        messages=_list_builder_session_messages(session_id),
    )


def _extract_save_proposal(session: SessionHarness) -> tuple[str | None, list[PlaybookInput]]:
    """Pull the most recent save_playbook tool-call args out of gemini_contents.

    The agent emits save_playbook(title=..., generalized_inputs=[...]) and the
    tool-call is persisted inside session.gemini_contents. We scan from the end
    to find the latest invocation and extract its args.
    """
    title: str | None = None
    inputs: list[PlaybookInput] = []
    for content in reversed(session.gemini_contents):
        for part in content.get("parts", []) or []:
            fc = part.get("function_call")
            if not fc or fc.get("name") != "save_playbook":
                continue
            args = fc.get("args") or {}
            t = args.get("title")
            if isinstance(t, str) and t.strip():
                title = t.strip()
            raw_inputs = args.get("generalized_inputs") or []
            if isinstance(raw_inputs, list):
                for raw in raw_inputs:
                    if not isinstance(raw, dict):
                        continue
                    name = str(raw.get("name") or "").strip()
                    if not name:
                        continue
                    inputs.append(
                        PlaybookInput(
                            name=name,
                            default_value=(
                                str(raw.get("example_value")).strip()
                                if raw.get("example_value") is not None
                                else None
                            ),
                            description=(
                                str(raw.get("description")).strip()
                                if raw.get("description") is not None
                                else None
                            ),
                        )
                    )
            if title is not None or inputs:
                return title, inputs
    return title, inputs


# ─────────────────────────────────────────────────────────────────────────────
# Agent step endpoint
# ─────────────────────────────────────────────────────────────────────────────

class AgentActionResult(BaseModel):
    """Result of a browser tool call executed by the client."""
    call_id: str | None = None
    name: str
    response: dict = Field(default_factory=dict)


class AgentStepRequest(BaseModel):
    """Client asks the agent to advance one turn.

    Either user_message (new chat / approval reply) or action_results (tool
    outputs from the last pending_actions batch) — typically not both.
    """
    user_message: str | None = None
    action_results: list[AgentActionResult] = Field(default_factory=list)


class AgentStepEnvelope(BaseModel):
    session: SessionHarness
    messages: list[SessionMessage] = Field(default_factory=list)
    chats: list[str] = Field(default_factory=list)
    pending_actions: list[dict] = Field(default_factory=list)
    awaiting_approval: bool = False
    approval_todo_id: str | None = None
    approval_preview: str | None = None


def _agent_record_usage_factory(user_sub: str, session_id: str):
    def _record(response, *, purpose: str = "agent_step") -> None:
        try:
            record_llm_call(
                response=response,
                user_sub=user_sub,
                model=pixel_agent.DEFAULT_MODEL,
                session_id=session_id,
                purpose=purpose,
            )
        except Exception as e:
            print(f"  record_llm_call failed: {e}")

    return _record


def _exec_agent_advisor(session: SessionHarness, question: str, user_sub: str) -> str:
    """Wire the agent's `ask_advisor` tool to the advisor model. Called from
    the conversational-tool dispatcher via pixel_agent._advisor_callback.
    """
    return (
        _call_advisor(
            question,
            user_sub=user_sub,
            session_id=session.session_id,
            purpose="advisor_ask",
        )
        or "(Advisor unavailable. Continue with your best judgment.)"
    )


@app.post("/sessions", response_model=BuilderSessionEnvelope)
async def create_builder_session(
    req: BuilderSessionCreateRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    """Open a new session. `message` can be empty to show the greeting first."""
    try:
        check_quota(user.sub)
    except QuotaExceeded as qe:
        raise HTTPException(status_code=429, detail=str(qe))

    intent_spec = build_initial_intent_spec(req.message or "Starting a new session")
    session = new_session_harness(str(uuid.uuid4()), intent_spec)
    pixel_agent.seed_session_for_first_turn(session, req.message)

    _persist_builder_session(session, user, create=True)

    if req.message and req.message.strip():
        _append_builder_message(
            build_session_message(
                session_id=session.session_id,
                role="user",
                message_type="chat",
                content=req.message.strip(),
            )
        )

    return _build_builder_session_envelope(session.session_id, user)


@app.get("/sessions/{session_id}", response_model=BuilderSessionEnvelope)
async def get_builder_session(
    session_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
):
    return _build_builder_session_envelope(session_id, user)


@app.post("/sessions/{session_id}/agent/step", response_model=AgentStepEnvelope)
async def agent_step(
    session_id: str,
    req: AgentStepRequest,
    user: AuthenticatedUser = Depends(get_current_user),
):
    """Advance the agent one turn. Returns any chat bubbles the agent emitted
    during the loop plus the next browser actions for the client to execute.
    """
    try:
        check_quota(user.sub)
    except QuotaExceeded as qe:
        raise HTTPException(status_code=429, detail=str(qe))

    session = _load_builder_session_or_404(session_id, user)

    if req.user_message and req.user_message.strip():
        _append_builder_message(
            build_session_message(
                session_id=session_id,
                role="user",
                message_type="chat",
                content=req.user_message.strip(),
            )
        )

    action_results_payload = [
        {
            "call_id": r.call_id,
            "name": r.name,
            "response": r.response,
        }
        for r in req.action_results
    ]

    # Provide the advisor callback to the agent for this turn only.
    pixel_agent.CURRENT_ADVISOR_CALLBACK = lambda q: _exec_agent_advisor(session, q, user.sub)  # type: ignore[attr-defined]

    try:
        result = pixel_agent.run_agent_step(
            session=session,
            client=client,
            user_message=req.user_message,
            action_results=action_results_payload or None,
            record_usage=_agent_record_usage_factory(user.sub, session_id),
        )
    finally:
        pixel_agent.CURRENT_ADVISOR_CALLBACK = None  # type: ignore[attr-defined]

    _persist_agent_messages(
        session_id,
        result.get("assistant_messages", []),
        result.get("system_messages", []),
    )
    _persist_builder_session(session, user, create=False)

    return AgentStepEnvelope(
        session=session,
        messages=_list_builder_session_messages(session_id),
        chats=result.get("chats", []),
        pending_actions=result.get("pending_actions", []),
        awaiting_approval=bool(result.get("awaiting_approval")),
        approval_todo_id=result.get("approval_todo_id"),
        approval_preview=result.get("approval_preview"),
    )


@app.post("/sessions/{session_id}/save", response_model=PlaybookSaveEnvelope)
async def save_builder_session(
    session_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
):
    session = _load_builder_session_or_404(session_id, user)
    if not session_is_saveable(session):
        raise HTTPException(status_code=400, detail="Session is not ready to save as a playbook")

    proposed_title, proposed_inputs = _extract_save_proposal(session)
    playbook = build_saved_playbook(
        session,
        proposed_title=proposed_title,
        proposed_generalized_inputs=proposed_inputs,
    )
    db_create_playbook(
        playbook_id=playbook.playbook_id,
        user_sub=user.sub,
        title=playbook.title,
        intent_spec_json=model_dump_json(playbook.intent_spec),
        automation_grade=playbook.automation_grade,
        status=playbook.status,
        last_verified_at=playbook.last_verified_at,
        markdown_render=playbook.markdown_render,
        generalized_inputs_json=model_dump_json(playbook.generalized_inputs),
        loop_hints_json=model_dump_json(playbook.loop_hints),
        branch_hints_json=model_dump_json(playbook.branch_hints),
        source_session_id=playbook.source_session_id,
    )
    for index, block in enumerate(playbook.blocks):
        db_insert_playbook_block(
            playbook_id=playbook.playbook_id,
            block_id=block.block_id,
            order_index=index,
            block_type=block.type,
            title=block.title,
            config_json=model_dump_json(
                {
                    "intent": block.intent,
                    "inputs": block.inputs,
                    "outputs": block.outputs,
                    "preconditions": block.preconditions,
                }
            ),
            success_verifier=block.success_verifier,
            failure_policy=block.failure_policy,
            destructive=block.destructive,
            requires_human_gate=block.requires_human_gate,
        )

    session.status = "completed"
    session.updated_at = playbook.updated_at
    _append_builder_message(
        build_session_message(
            session_id=session_id,
            role="assistant",
            message_type="system",
            content=f'Playbook saved as "{playbook.title}" ({playbook.playbook_id})',
        )
    )
    _persist_builder_session(session, user, create=False)
    return PlaybookSaveEnvelope(
        session=session,
        playbook=playbook,
        messages=_list_builder_session_messages(session_id),
    )


@app.get("/playbooks")
async def list_saved_playbooks(
    user: AuthenticatedUser = Depends(get_current_user),
):
    records = db_list_playbooks(user.sub)
    playbooks = []
    for record in records:
        block_records = db_list_playbook_blocks(record["id"])
        playbooks.append(load_saved_playbook(record, block_records))
    return playbooks


@app.get("/playbooks/{playbook_id}")
async def get_saved_playbook(
    playbook_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
):
    record = db_get_playbook(playbook_id, user.sub)
    if not record:
        raise HTTPException(status_code=404, detail="Playbook not found")
    block_records = db_list_playbook_blocks(playbook_id)
    return load_saved_playbook(record, block_records)


# ─────────────────────────────────────────────────────────────────────────────
# Scraping helpers (HTML → Markdown / HTML → table rows)
# Called by the extension when the agent asks for scrape_page / scrape_table.
# ─────────────────────────────────────────────────────────────────────────────

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
    soup = BeautifulSoup(html, "html.parser")

    for comment in soup.find_all(string=lambda t: isinstance(t, Comment)):
        comment.extract()

    if only_main_content:
        main = (
            soup.find("main")
            or soup.find(attrs={"role": "main"})
            or soup.find("article")
        )
        if main:
            soup = BeautifulSoup(str(main), "html.parser")
        else:
            for selector in BOILERPLATE_SELECTORS:
                try:
                    for el in soup.select(selector):
                        el.decompose()
                except Exception:
                    continue

    for tag in soup.find_all(["script", "style", "noscript"]):
        tag.decompose()

    return soup


def scrape_page_to_markdown(html: str) -> dict:
    soup = _clean_html(html, only_main_content=True)

    title_tag = BeautifulSoup(html, "html.parser").find("title")
    title = title_tag.get_text(strip=True) if title_tag else ""

    for img in soup.find_all("img"):
        alt = img.get("alt", "")
        if alt:
            img.replace_with(f"[Image: {alt}]")
        else:
            img.decompose()

    markdown = md(str(soup), heading_style="ATX", bullets="-")
    markdown = re.sub(r"\n{3,}", "\n\n", markdown).strip()

    truncated = False
    if len(markdown) > 10000:
        markdown = markdown[:10000]
        truncated = True
        markdown += "\n\n[Content truncated at 10000 chars]"

    return {
        "markdown": markdown,
        "title": title,
        "wordCount": len(markdown.split()),
        "truncated": truncated,
    }


def scrape_table_from_html(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table")
    if not table:
        return {"headers": [], "rows": [], "rowCount": 0, "error": "No table found"}

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
                if key:
                    rows.append({"Spec": key, "Value": val})
            elif len(ths) >= 1 and len(tds) == 0:
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

    headers = []
    thead = table.find("thead")
    if thead:
        header_row = thead.find("tr")
        if header_row:
            headers = [th.get_text(strip=True) for th in header_row.find_all(["th", "td"])]

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


class ScrapePageRequest(BaseModel):
    html: str


class ScrapeTableRequest(BaseModel):
    html: str


@app.post("/scrape/page")
async def scrape_page(req: ScrapePageRequest):
    try:
        return scrape_page_to_markdown(req.html)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Scrape failed: {e}")


@app.post("/scrape/table")
async def scrape_table(req: ScrapeTableRequest):
    try:
        return scrape_table_from_html(req.html)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Table scrape failed: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Google Workspace (user OAuth via Chrome Identity)
# ─────────────────────────────────────────────────────────────────────────────

def _get_gspread_client_for_token(token: str):
    import gspread
    from google.oauth2.credentials import Credentials

    creds = Credentials(token=token)
    return gspread.authorize(creds)


class SheetsCreateRequest(BaseModel):
    title: str = "Untitled Spreadsheet"
    token: str


class SheetsWriteRequest(BaseModel):
    spreadsheet_id: str
    range: str = "A1"
    values: list[list[str]]
    token: str


class SheetsReadRequest(BaseModel):
    spreadsheet_id: str
    range: str = "A1:Z100"
    token: str


@app.post("/sheets/create")
async def sheets_create(req: SheetsCreateRequest):
    try:
        gc = _get_gspread_client_for_token(req.token)
        sh = gc.create(req.title)
        return {"spreadsheet_id": sh.id, "url": sh.url, "title": sh.title}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Sheets create failed: {e}")


@app.post("/sheets/write")
async def sheets_write(req: SheetsWriteRequest):
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
    try:
        gc = _get_gspread_client_for_token(req.token)
        sh = gc.open_by_key(req.spreadsheet_id)
        worksheet = sh.sheet1
        values = worksheet.get(req.range)
        return {"values": values, "rows": len(values)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Sheets read failed: {e}")


DOCS_API = "https://docs.googleapis.com"
SLIDES_API = "https://slides.googleapis.com"


def _google_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


class DocsCreateRequest(BaseModel):
    title: str = "Untitled Document"
    body: str = ""
    token: str


class DocsWriteRequest(BaseModel):
    document_id: str
    content: str
    token: str


class DocsReadRequest(BaseModel):
    document_id: str
    token: str


@app.post("/docs/create")
async def docs_create(req: DocsCreateRequest):
    import httpx
    async with httpx.AsyncClient() as http:
        resp = await http.post(
            f"{DOCS_API}/v1/documents",
            headers=_google_headers(req.token),
            json={"title": req.title},
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        doc = resp.json()
        doc_id = doc["documentId"]

        if req.body:
            await http.post(
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
    import httpx
    async with httpx.AsyncClient() as http:
        resp = await http.get(
            f"{DOCS_API}/v1/documents/{req.document_id}",
            headers=_google_headers(req.token),
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        doc = resp.json()
        end_index = doc["body"]["content"][-1]["endIndex"] - 1

        resp = await http.post(
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
    import httpx
    async with httpx.AsyncClient() as http:
        resp = await http.get(
            f"{DOCS_API}/v1/documents/{req.document_id}",
            headers=_google_headers(req.token),
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        doc = resp.json()
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


class SlidesCreateRequest(BaseModel):
    title: str = "Untitled Presentation"
    slides: list[dict] | None = None
    token: str


class SlidesReadRequest(BaseModel):
    presentation_id: str
    token: str


@app.post("/slides/create")
async def slides_create(req: SlidesCreateRequest):
    import httpx
    async with httpx.AsyncClient() as http:
        resp = await http.post(
            f"{SLIDES_API}/v1/presentations",
            headers=_google_headers(req.token),
            json={"title": req.title},
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=resp.status_code, detail=resp.text)

        pres = resp.json()
        pres_id = pres["presentationId"]

        if req.slides:
            requests_list = []
            for i, slide_data in enumerate(req.slides):
                slide_id = f"slide_{i}"
                requests_list.append({
                    "createSlide": {
                        "objectId": slide_id,
                        "insertionIndex": i + 1,
                        "slideLayoutReference": {"predefinedLayout": "TITLE_AND_BODY"},
                    }
                })
                if slide_data.get("title"):
                    requests_list.append({
                        "insertText": {
                            "objectId": f"{slide_id}_title",
                            "text": slide_data["title"],
                        }
                    })
                if slide_data.get("body"):
                    requests_list.append({
                        "insertText": {
                            "objectId": f"{slide_id}_body",
                            "text": slide_data["body"],
                        }
                    })

            if requests_list:
                try:
                    await http.post(
                        f"{SLIDES_API}/v1/presentations/{pres_id}:batchUpdate",
                        headers=_google_headers(req.token),
                        json={"requests": requests_list},
                    )
                except Exception:
                    pass

        return {
            "presentation_id": pres_id,
            "url": f"https://docs.google.com/presentation/d/{pres_id}/edit",
            "title": req.title,
        }


@app.post("/slides/read")
async def slides_read(req: SlidesReadRequest):
    import httpx
    async with httpx.AsyncClient() as http:
        resp = await http.get(
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


# ─────────────────────────────────────────────────────────────────────────────
# Stealth Cloudflare solver
# ─────────────────────────────────────────────────────────────────────────────

class StealthSolveRequest(BaseModel):
    url: str
    user_agent: str | None = None
    cookies: list[dict] | None = None
    timeout: int = 30


@app.post("/stealth-solve")
async def stealth_solve(req: StealthSolveRequest):
    from stealth_solver import solve_cloudflare

    try:
        return await solve_cloudflare(
            url=req.url,
            user_agent=req.user_agent,
            cookies=req.cookies,
            timeout=req.timeout,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
