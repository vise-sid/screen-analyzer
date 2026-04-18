from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote_plus, urlparse
from typing import Literal

from pydantic import BaseModel, Field

Archetype = Literal["observe", "operate", "transfer", "reconcile", "triage"]
IntentModifier = Literal[
    "batch",
    "scheduled",
    "needs_auth",
    "has_human_gate",
    "destructive",
    "approval_required",
    "retryable",
    "parallelizable",
    "download_output",
    "upload_input",
]
SessionStatus = Literal[
    "idle",
    "intent_binding",
    "probing",
    "planning",
    "gated",
    "executing",
    "verifying",
    "generalizing",
    "ready_to_save",
    "completed",
    "failed",
]
AutomationGrade = Literal[
    "attended",
    "mostly_attended",
    "mostly_unattended",
    "unattended",
]
RiskLevel = Literal["low", "medium", "high"]
BlockType = Literal[
    "SiteProbe",
    "EnsureSession",
    "ClearGate",
    "Navigate",
    "Extract",
    "Transform",
    "FillOrUpload",
    "SubmitOrTrigger",
    "Verify",
    "LoopOrBranch",
    "AskUserOrHandoff",
    "Persist",
    "Finish",
]
BlockStatus = Literal["proposed", "verified", "gated", "rejected"]
BlockResultType = Literal["success", "failure", "gated", "ambiguous", "handoff"]
EvidenceType = Literal[
    "network_response",
    "download_event",
    "page_state_change",
    "dialog_event",
    "form_validation",
    "visible_text",
    "table_extract",
    "link_extract",
    "user_intervention",
    "tab_change",
    "file_artifact",
]
GateType = Literal["auth", "captcha", "otp", "approval", "ambiguity", "handoff"]
GateStatus = Literal["open", "resolved"]
MessageRole = Literal["user", "assistant", "system"]
MessageType = Literal["chat", "decision", "gate", "system", "clarify", "report"]
TodoStatus = Literal["pending", "approved", "running", "done", "failed", "skipped"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _json_ready(value: Any) -> Any:
    if isinstance(value, BaseModel):
        if hasattr(value, "model_dump"):
            return value.model_dump(mode="json")
        return value.dict()
    if isinstance(value, list):
        return [_json_ready(item) for item in value]
    if isinstance(value, dict):
        return {key: _json_ready(item) for key, item in value.items()}
    return value


def model_dump_json(model: BaseModel | list[Any] | dict[str, Any] | None) -> str:
    if model is None:
        return "null"
    payload = _json_ready(model)
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


class SystemBinding(BaseModel):
    role: str
    host: str
    route_hint: str | None = None


class IntentInput(BaseModel):
    name: str
    required: bool = True
    secret: bool = False
    sample_value: str | None = None


class IntentSpec(BaseModel):
    outcome: str
    archetype: Archetype
    systems: list[SystemBinding] = Field(default_factory=list)
    entities: list[str] = Field(default_factory=list)
    inputs: list[IntentInput] = Field(default_factory=list)
    modifiers: list[IntentModifier] = Field(default_factory=list)
    done_when: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    risk_level: RiskLevel = "low"


class ElementHint(BaseModel):
    ref: int
    tag: str
    role: str | None = None
    desc: str
    type: str | None = None
    href: str | None = None
    value: str | None = None
    group: str | None = None
    disabled: bool = False


class SiteModel(BaseModel):
    host: str
    route: str | None = None
    product_name: str | None = None
    page_type: str = "unknown"
    auth_state: str = "unknown"
    gates: list[str] = Field(default_factory=list)
    available_regions: list[str] = Field(default_factory=list)
    stable_anchors: list[str] = Field(default_factory=list)
    element_hints: list[ElementHint] = Field(default_factory=list)
    api_candidates: list[str] = Field(default_factory=list)
    success_markers: list[str] = Field(default_factory=list)
    risk_markers: list[str] = Field(default_factory=list)


class Block(BaseModel):
    block_id: str
    type: BlockType
    title: str
    intent: str
    inputs: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, Any] = Field(default_factory=dict)
    preconditions: list[str] = Field(default_factory=list)
    success_verifier: str
    failure_policy: str
    destructive: bool = False
    requires_human_gate: bool = False
    status: BlockStatus = "proposed"


class EvidenceRecord(BaseModel):
    evidence_id: str
    type: EvidenceType
    source: str
    tab_id: int | None = None
    ts: str
    summary: str
    confidence: float
    payload_ref: str | None = None


class GateState(BaseModel):
    gate_id: str
    type: GateType
    status: GateStatus = "open"
    summary: str
    requires_user_action: bool = True


class BlockResult(BaseModel):
    block_id: str
    result: BlockResultType
    evidence: list[str] = Field(default_factory=list)
    confidence: float
    verifier: str
    next_hint: str
    artifacts: list[str] = Field(default_factory=list)


class Todo(BaseModel):
    id: str
    title: str
    description: str | None = None
    status: TodoStatus = "pending"
    evidence_block_ids: list[str] = Field(default_factory=list)
    created_at: str
    updated_at: str


class TodoPlan(BaseModel):
    todos: list[Todo] = Field(default_factory=list)


class SessionMessage(BaseModel):
    id: str
    session_id: str
    role: MessageRole
    message_type: MessageType
    content: str
    created_at: str


class PlaybookInput(BaseModel):
    name: str
    default_value: str | None = None
    source_block_ids: list[str] = Field(default_factory=list)
    description: str | None = None


class LoopHint(BaseModel):
    label: str
    block_ids: list[str] = Field(default_factory=list)
    parameter_name: str | None = None


class BranchHint(BaseModel):
    label: str
    condition: str
    block_ids: list[str] = Field(default_factory=list)


class SavedPlaybook(BaseModel):
    playbook_id: str
    title: str
    intent_spec: IntentSpec
    automation_grade: AutomationGrade
    status: str = "active"
    last_verified_at: str | None = None
    markdown_render: str
    generalized_inputs: list[PlaybookInput] = Field(default_factory=list)
    loop_hints: list[LoopHint] = Field(default_factory=list)
    branch_hints: list[BranchHint] = Field(default_factory=list)
    blocks: list[Block] = Field(default_factory=list)
    source_session_id: str | None = None
    created_at: str
    updated_at: str


class SessionHarness(BaseModel):
    session_id: str
    status: SessionStatus
    intent_spec: IntentSpec
    site_models: list[SiteModel] = Field(default_factory=list)
    draft_block_graph: list[Block] = Field(default_factory=list)
    evidence_ledger: list[EvidenceRecord] = Field(default_factory=list)
    gate_state: list[GateState] = Field(default_factory=list)
    todo_plan: TodoPlan = Field(default_factory=TodoPlan)
    active_todo_id: str | None = None
    awaiting_approval: bool = False
    gemini_contents: list[dict[str, Any]] = Field(default_factory=list)
    # Set when the session is a rerun of an existing playbook. Determines
    # which model drives the agent loop: None → Pro (discovery/build),
    # non-None → Flash (execute a known plan).
    source_playbook_id: str | None = None
    created_at: str
    updated_at: str


class BuilderSessionCreateRequest(BaseModel):
    message: str
    from_playbook_id: str | None = None


class BuilderSessionMessageRequest(BaseModel):
    message: str


class BlockExecutionRequest(BaseModel):
    url: str
    title: str | None = None
    elements: list[dict[str, Any]] | None = None
    popup: dict[str, Any] | None = None
    captcha: dict[str, Any] | None = None
    dialog: dict[str, Any] | None = None
    page_loading: bool = False
    page_scroll: dict[str, Any] | None = None
    agent_tabs: list[dict[str, Any]] | None = None
    action_result: str | None = None
    action_metadata: dict[str, Any] | None = None


class BuilderSessionEnvelope(BaseModel):
    session: SessionHarness
    messages: list[SessionMessage] = Field(default_factory=list)


class PlaybookSaveEnvelope(BaseModel):
    session: SessionHarness
    playbook: SavedPlaybook
    messages: list[SessionMessage] = Field(default_factory=list)


class BlockExecutionEnvelope(BaseModel):
    session: SessionHarness
    block: Block
    block_result: BlockResult
    site_model: SiteModel
    evidence: list[EvidenceRecord] = Field(default_factory=list)
    messages: list[SessionMessage] = Field(default_factory=list)


def infer_archetype(message: str) -> Archetype:
    lower = message.lower()
    if any(token in lower for token in ("compare", "reconcile", "mismatch", "match against")):
        return "reconcile"
    if any(token in lower for token in ("review queue", "triage", "approve", "reject", "classify")):
        return "triage"
    if any(token in lower for token in ("transfer", "copy from", "move from", "upload to", "enter into")):
        return "transfer"
    if any(token in lower for token in ("monitor", "track", "watch", "collect", "extract", "scrape", "check", "look up", "read")):
        return "observe"
    return "operate"


def infer_modifiers(message: str) -> list[IntentModifier]:
    lower = message.lower()
    modifiers: list[IntentModifier] = []
    if any(token in lower for token in ("login", "portal", "website", "site")):
        modifiers.append("needs_auth")
    if any(token in lower for token in ("download", "export", "report")):
        modifiers.append("download_output")
    if any(token in lower for token in ("upload", "attach", "document")):
        modifiers.append("upload_input")
    return modifiers


def infer_system_bindings(message: str) -> list[SystemBinding]:
    bindings: list[SystemBinding] = []
    seen: set[str] = set()

    for match in re.finditer(r"https?://[^\s]+", message):
        raw = match.group(0).rstrip(".,)")
        parsed = urlparse(raw)
        host = parsed.netloc.lower().strip()
        if not host or host in seen:
            continue
        seen.add(host)
        route_hint = parsed.path if parsed.path and parsed.path != "/" else None
        bindings.append(
            SystemBinding(
                role="primary" if not bindings else "secondary",
                host=host,
                route_hint=route_hint,
            )
        )

    for match in re.finditer(r"\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:/[^\s]*)?\b", message, flags=re.I):
        raw = match.group(0).rstrip(".,)")
        if raw.startswith("http://") or raw.startswith("https://"):
            continue
        parsed = urlparse(f"https://{raw}")
        host = parsed.netloc.lower().strip()
        if not host or host in seen:
            continue
        seen.add(host)
        route_hint = parsed.path if parsed.path and parsed.path != "/" else None
        bindings.append(
            SystemBinding(
                role="primary" if not bindings else "secondary",
                host=host,
                route_hint=route_hint,
            )
        )

    return bindings


def _slugify_identifier(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    return slug or "value"


def build_initial_intent_spec(message: str) -> IntentSpec:
    cleaned = message.strip()
    done_when = [f"Outcome achieved: {cleaned}"]
    if "download" in cleaned.lower():
        done_when = ["Requested download or export has completed"]
    systems = infer_system_bindings(cleaned)
    return IntentSpec(
        outcome=cleaned,
        archetype=infer_archetype(cleaned),
        systems=systems,
        entities=[],
        inputs=[],
        modifiers=infer_modifiers(cleaned),
        done_when=done_when,
        constraints=[],
        risk_level="low",
    )


def build_site_probe_block() -> Block:
    return Block(
        block_id=_new_id("blk"),
        type="SiteProbe",
        title="Probe current site",
        intent="Inspect the current browser context and establish the first page model",
        inputs={},
        outputs={},
        preconditions=[],
        success_verifier="Page type, auth state, gate markers, or stable anchors identified",
        failure_policy="reprobe_then_replan",
        destructive=False,
        requires_human_gate=False,
        status="proposed",
    )


def build_reprobe_block() -> Block:
    block = build_site_probe_block()
    block.title = "Re-probe current site"
    block.intent = "Inspect the current browser context again after user intervention or gate handling"
    return block


def _latest_site_model(session: SessionHarness) -> SiteModel | None:
    if not session.site_models:
        return None
    return session.site_models[-1]


def _latest_verified_block(session: SessionHarness) -> Block | None:
    for block in reversed(session.draft_block_graph):
        if block.status == "verified":
            return block
    return None


def _has_verified_block_type(session: SessionHarness, block_type: BlockType) -> bool:
    return any(block.status == "verified" and block.type == block_type for block in session.draft_block_graph)


def _open_gates(session: SessionHarness) -> list[GateState]:
    return [gate for gate in session.gate_state if gate.status == "open"]


def _latest_verified_block_of_type(session: SessionHarness, block_type: BlockType) -> Block | None:
    for block in reversed(session.draft_block_graph):
        if block.status == "verified" and block.type == block_type:
            return block
    return None


def _normalize_phrase(text: str) -> str:
    cleaned = text.strip()
    cleaned = re.sub(r"^(hi|hello|hey)[,!.\s]*", "", cleaned, flags=re.I)
    cleaned = re.sub(r"^(please|can you|could you|i want to|i need to)\s+", "", cleaned, flags=re.I)
    return cleaned.strip()


def derive_fill_text(outcome: str) -> str:
    cleaned = _normalize_phrase(outcome)
    lower = cleaned.lower()
    match = re.search(r"(?:search|find|look up|lookup|check|get|open)\s+(?:the\s+)?(.+)", lower)
    if match:
        return cleaned[match.start(1):].strip()
    return cleaned


def _query_terms(text: str) -> list[str]:
    return [term for term in re.findall(r"[a-z0-9]+", text.lower()) if len(term) > 2][:8]


def find_best_input_candidate(site_model: SiteModel) -> ElementHint | None:
    inputs = [
        hint
        for hint in site_model.element_hints
        if hint.tag in {"input", "textarea", "select"}
        and not hint.disabled
        and (hint.type or "") not in {"hidden", "submit", "button", "checkbox", "radio", "password"}
    ]
    if not inputs:
        return None

    def score(hint: ElementHint) -> tuple[int, int]:
        desc = hint.desc.lower()
        rank = 0
        if any(token in desc for token in ("search", "query", "find")):
            rank += 5
        if any(token in desc for token in ("name", "email", "text", "enter")):
            rank += 2
        if hint.tag == "textarea":
            rank -= 1
        return (rank, -hint.ref)

    return max(inputs, key=score)


def find_best_submit_candidate(site_model: SiteModel) -> ElementHint | None:
    candidates = [
        hint
        for hint in site_model.element_hints
        if not hint.disabled
        and (
            hint.tag == "button"
            or hint.role == "button"
            or (hint.tag == "input" and (hint.type or "") in {"submit", "button"})
        )
    ]
    if not candidates:
        return None

    def score(hint: ElementHint) -> tuple[int, int]:
        desc = hint.desc.lower()
        rank = 0
        if any(token in desc for token in ("search", "submit", "go", "continue", "next", "apply")):
            rank += 5
        if any(token in desc for token in ("cancel", "close", "dismiss", "back")):
            rank -= 4
        return (rank, -hint.ref)

    return max(candidates, key=score)


def choose_extract_method(site_model: SiteModel, session: SessionHarness) -> tuple[str, str]:
    outcome = session.intent_spec.outcome.lower()
    if any(token in outcome for token in ("links", "urls")):
        return "scrape_links", "link inventory"
    if site_model.page_type == "search" and any(h.href for h in site_model.element_hints):
        return "scrape_links", "link inventory"
    if site_model.page_type == "dashboard" and any("download" in anchor.lower() or "export" in anchor.lower() for anchor in site_model.stable_anchors):
        return "scrape_page", "page scrape"
    return "scrape_page", "page scrape"


def _primary_system_url(session: SessionHarness) -> str | None:
    if not session.intent_spec.systems:
        return None
    binding = session.intent_spec.systems[0]
    route = binding.route_hint or ""
    if route and not route.startswith("/"):
        route = f"/{route}"
    return f"https://{binding.host}{route}"


def _extract_url_from_text(text: str) -> str | None:
    match = re.search(r"https?://[^\s]+", text)
    if not match:
        return None
    return match.group(0).rstrip(".,)")


def build_navigate_block(session: SessionHarness) -> Block:
    site_model = _latest_site_model(session)
    outcome = session.intent_spec.outcome.strip()
    direct_url = _extract_url_from_text(outcome)
    bound_system_url = _primary_system_url(session)
    target_url = direct_url or bound_system_url or f"https://www.google.com/search?q={quote_plus(outcome)}"

    title = "Open the best next page"
    intent = "Move one visible step toward the requested goal using the most direct stable route available"
    navigation_mode = "direct_url" if direct_url else ("system_binding" if bound_system_url else "search_results_url")

    if site_model and "google." in site_model.host:
        title = f'Search Google for "{outcome[:64]}"'
        intent = "Open a stable Google search results URL for the requested goal"
    elif direct_url:
        title = "Open requested website"
        intent = "Navigate directly to the requested site or deep link"
    elif bound_system_url and session.intent_spec.systems:
        title = f'Open {session.intent_spec.systems[0].host}'
        intent = "Navigate directly to the user-confirmed primary system instead of searching for it"

    return Block(
        block_id=_new_id("blk"),
        type="Navigate",
        title=title,
        intent=intent,
        inputs={
            "url": target_url,
            "navigation_mode": navigation_mode,
            "query": outcome if not direct_url else "",
            "source_host": site_model.host if site_model else "",
            "source_route": site_model.route if site_model else "",
        },
        outputs={},
        preconditions=["Current page inspected and a plausible next route has been selected"],
        success_verifier="URL changes to the intended destination and the new page exposes stable anchors",
        failure_policy="reprobe_then_replan",
        destructive=False,
        requires_human_gate=False,
        status="proposed",
    )


def build_ensure_session_block(session: SessionHarness) -> Block:
    site_model = _latest_site_model(session)
    host = site_model.host if site_model else ""
    route = site_model.route if site_model else ""
    return Block(
        block_id=_new_id("blk"),
        type="EnsureSession",
        title="Confirm or establish session access",
        intent="Verify whether the page is already authenticated, and if not, hand off explicit login safely",
        inputs={
            "session_strategy": "reuse_then_handoff",
            "source_host": host,
            "source_route": route,
        },
        outputs={},
        preconditions=["Login wall or logged-out state detected"],
        success_verifier="Authenticated markers present and login wall no longer visible",
        failure_policy="create_auth_gate",
        destructive=False,
        requires_human_gate=True,
        status="proposed",
    )


def build_clear_gate_block(session: SessionHarness) -> Block:
    site_model = _latest_site_model(session)
    gates = site_model.gates if site_model else []
    host = site_model.host if site_model else ""
    route = site_model.route if site_model else ""

    gate_kind = "popup"
    clear_action = "dismiss_popup"
    title = "Dismiss blocking popup"
    intent = "Remove a page blocker before continuing the workflow"

    if "dialog" in gates:
        gate_kind = "dialog"
        clear_action = "dismiss_dialog"
        title = "Dismiss blocking dialog"
    elif "captcha" in gates:
        gate_kind = "captcha"
        clear_action = "click_captcha"
        title = "Attempt captcha clearance"
        intent = "Try a safe first-pass captcha interaction, then hand off if it still blocks progress"

    return Block(
        block_id=_new_id("blk"),
        type="ClearGate",
        title=title,
        intent=intent,
        inputs={
            "gate_kind": gate_kind,
            "clear_action": clear_action,
            "source_host": host,
            "source_route": route,
        },
        outputs={},
        preconditions=["A blocking popup, dialog, or captcha is visible"],
        success_verifier="Target blocker is no longer present on the page",
        failure_policy="create_gate_or_handoff",
        destructive=False,
        requires_human_gate=(gate_kind == "captcha"),
        status="proposed",
    )


def build_extract_block(session: SessionHarness) -> Block | None:
    site_model = _latest_site_model(session)
    if not site_model:
        return None

    method, label = choose_extract_method(site_model, session)
    return Block(
        block_id=_new_id("blk"),
        type="Extract",
        title=f"Extract data using {label}",
        intent="Read the strongest practical representation of the current page and capture it as structured evidence",
        inputs={
            "method": method,
            "source_host": site_model.host,
            "source_route": site_model.route,
        },
        outputs={},
        preconditions=["Current page is visible and ready to be read"],
        success_verifier="Extraction result is non-empty and attributable to a specific extraction method",
        failure_policy="reprobe_then_replan",
        destructive=False,
        requires_human_gate=False,
        status="proposed",
    )


def build_fill_block(session: SessionHarness) -> Block | None:
    site_model = _latest_site_model(session)
    if not site_model:
        return None

    candidate = find_best_input_candidate(site_model)
    if not candidate:
        return None

    text = derive_fill_text(session.intent_spec.outcome)
    primary_input_name = session.intent_spec.inputs[0].name if session.intent_spec.inputs else None
    intent = "Populate the most relevant input field with the derived task value"
    if primary_input_name:
        intent = (
            f'Populate the most relevant input field using the playbook input "{primary_input_name}"'
        )
    return Block(
        block_id=_new_id("blk"),
        type="FillOrUpload",
        title=f'Fill "{candidate.desc}"',
        intent=intent,
        inputs={
            "ref": candidate.ref,
            "field_desc": candidate.desc,
            "text": text,
            "parameter_name": primary_input_name or "",
            "clear": True,
            "source_host": site_model.host,
            "source_route": site_model.route,
        },
        outputs={},
        preconditions=["A writable input field is visible on the page"],
        success_verifier="Field contains the intended text after typing",
        failure_policy="reprobe_then_replan",
        destructive=False,
        requires_human_gate=False,
        status="proposed",
    )


def build_submit_block(session: SessionHarness) -> Block | None:
    site_model = _latest_site_model(session)
    fill_block = _latest_verified_block_of_type(session, "FillOrUpload")
    if not site_model or not fill_block:
        return None

    candidate = find_best_submit_candidate(site_model)
    inputs: dict[str, Any] = {
        "source_host": site_model.host,
        "source_route": site_model.route,
        "expected_text": fill_block.outputs.get("filled_text") or fill_block.inputs.get("text") or "",
        "filled_ref": fill_block.outputs.get("filled_ref") or fill_block.inputs.get("ref"),
    }
    title = "Submit the form"

    if candidate:
        title = f'Trigger "{candidate.desc}"'
        inputs.update({"mode": "click", "ref": candidate.ref, "target_desc": candidate.desc})
    else:
        inputs.update({"mode": "key", "key": "Enter"})

    return Block(
        block_id=_new_id("blk"),
        type="SubmitOrTrigger",
        title=title,
        intent="Trigger the next state-changing action after filling the field",
        inputs=inputs,
        outputs={},
        preconditions=["A field has already been populated and a submit path is available"],
        success_verifier="Trigger action is dispatched and the page begins transitioning or changes state",
        failure_policy="reprobe_then_replan",
        destructive=False,
        requires_human_gate=False,
        status="proposed",
    )


def build_verify_block(session: SessionHarness) -> Block | None:
    site_model = _latest_site_model(session)
    submit_block = _latest_verified_block_of_type(session, "SubmitOrTrigger")
    if not site_model or not submit_block:
        return None

    expected_text = str(submit_block.outputs.get("expected_text") or submit_block.inputs.get("expected_text") or "")
    return Block(
        block_id=_new_id("blk"),
        type="Verify",
        title="Verify outcome",
        intent="Confirm that the page now reflects the submitted intent",
        inputs={
            "expected_text": expected_text,
            "source_host": submit_block.inputs.get("source_host") or site_model.host,
            "source_route": submit_block.inputs.get("source_route") or site_model.route,
        },
        outputs={},
        preconditions=["A trigger action has just been dispatched"],
        success_verifier="URL, title, or stable anchors reflect the expected submitted intent",
        failure_policy="reprobe_then_replan",
        destructive=False,
        requires_human_gate=False,
        status="proposed",
    )


def build_transform_block(session: SessionHarness) -> Block | None:
    extract_block = _latest_verified_block_of_type(session, "Extract")
    if not extract_block:
        return None

    return Block(
        block_id=_new_id("blk"),
        type="Transform",
        title="Normalize extracted payload",
        intent="Convert extracted source data into a reusable structured transfer payload",
        inputs={
            "source_block_id": extract_block.block_id,
            "source_method": extract_block.inputs.get("method") or extract_block.outputs.get("method") or "extract",
            "transform_strategy": "normalize_payload",
        },
        outputs={},
        preconditions=["A source extract block has already produced data"],
        success_verifier="Normalized transfer payload contains at least one record or meaningful text body",
        failure_policy="reprobe_then_replan",
        destructive=False,
        requires_human_gate=False,
        status="proposed",
    )


def build_persist_block(session: SessionHarness) -> Block | None:
    transform_block = _latest_verified_block_of_type(session, "Transform")
    if not transform_block:
        return None

    target_host = session.intent_spec.systems[1].host if len(session.intent_spec.systems) > 1 else ""
    target_label = target_host or "session artifact"
    return Block(
        block_id=_new_id("blk"),
        type="Persist",
        title=f"Persist normalized payload to {target_label}",
        intent="Write the transformed transfer payload to an internal artifact or downstream handoff target",
        inputs={
            "source_block_id": transform_block.block_id,
            "persist_target": "session_artifact",
            "target_host": target_host,
            "artifact_label": session.intent_spec.outcome[:80],
        },
        outputs={},
        preconditions=["A transformed transfer payload is available"],
        success_verifier="Artifact id and preview are recorded for downstream use",
        failure_policy="mark_failed",
        destructive=False,
        requires_human_gate=False,
        status="proposed",
    )


def new_session_harness(
    session_id: str,
    intent_spec: IntentSpec,
    *,
    gemini_contents: list[dict[str, Any]] | None = None,
) -> SessionHarness:
    now = _now_iso()
    return SessionHarness(
        session_id=session_id,
        status="idle",
        intent_spec=intent_spec,
        site_models=[],
        draft_block_graph=[],
        evidence_ledger=[],
        gate_state=[],
        todo_plan=TodoPlan(),
        active_todo_id=None,
        awaiting_approval=False,
        gemini_contents=gemini_contents or [],
        created_at=now,
        updated_at=now,
    )


def load_session_harness(record: dict[str, Any]) -> SessionHarness:
    todo_plan_raw = record.get("todo_plan_json")
    gemini_contents_raw = record.get("gemini_contents_json")
    payload = {
        "session_id": record["id"],
        "status": record["status"],
        "intent_spec": json.loads(record["intent_spec_json"]),
        "site_models": json.loads(record["site_models_json"]),
        "draft_block_graph": json.loads(record["draft_block_graph_json"]),
        "evidence_ledger": json.loads(record["evidence_ledger_json"]),
        "gate_state": json.loads(record["gate_state_json"]),
        "todo_plan": json.loads(todo_plan_raw) if todo_plan_raw else {"todos": []},
        "active_todo_id": record.get("active_todo_id"),
        "awaiting_approval": bool(record.get("awaiting_approval") or 0),
        "gemini_contents": json.loads(gemini_contents_raw) if gemini_contents_raw else [],
        "source_playbook_id": record.get("source_playbook_id"),
        "created_at": record["created_at"],
        "updated_at": record["updated_at"],
    }
    return SessionHarness(**payload)


def serialize_session_harness(session: SessionHarness) -> dict[str, Any]:
    return {
        "session_id": session.session_id,
        "status": session.status,
        "intent_spec_json": model_dump_json(session.intent_spec),
        "site_models_json": model_dump_json(session.site_models),
        "draft_block_graph_json": model_dump_json(session.draft_block_graph),
        "evidence_ledger_json": model_dump_json(session.evidence_ledger),
        "gate_state_json": model_dump_json(session.gate_state),
        "todo_plan_json": model_dump_json(session.todo_plan),
        "active_todo_id": session.active_todo_id,
        "awaiting_approval": 1 if session.awaiting_approval else 0,
        "gemini_contents_json": json.dumps(session.gemini_contents, separators=(",", ":")),
        "source_playbook_id": session.source_playbook_id,
    }


def find_block(session: SessionHarness, block_id: str) -> Block:
    for block in session.draft_block_graph:
        if block.block_id == block_id:
            return block
    raise KeyError(f"Block not found: {block_id}")


def classify_page_type(snapshot: BlockExecutionRequest) -> str:
    elements = snapshot.elements or []
    text_bits = []
    input_count = 0
    submit_like = 0
    for element in elements:
        tag = str(element.get("tag", "")).lower()
        desc = str(element.get("desc", "")).strip()
        if desc:
            text_bits.append(desc.lower())
        if tag in {"input", "textarea", "select"}:
            input_count += 1
        if any(token in desc.lower() for token in ("login", "sign in", "submit", "search", "continue")):
            submit_like += 1

    blob = " ".join(text_bits)
    if any(token in blob for token in ("password", "username", "sign in", "login")):
        return "login"
    if snapshot.captcha:
        return "login"
    if any(token in blob for token in ("download", "export", "report")):
        return "download"
    if input_count >= 2 and submit_like >= 1:
        return "form"
    if input_count >= 1 and any(token in blob for token in ("search", "filter", "query")):
        return "search"
    if any(token in blob for token in ("dashboard", "logout", "returns dashboard")):
        return "dashboard"
    return "unknown"


def classify_auth_state(page_type: str, snapshot: BlockExecutionRequest) -> str:
    if page_type == "login":
        return "logged_out"
    elements = snapshot.elements or []
    blob = " ".join(str(el.get("desc", "")).lower() for el in elements)
    if any(token in blob for token in ("logout", "sign out", "profile", "dashboard")):
        return "logged_in"
    return "unknown"


def collect_gates(snapshot: BlockExecutionRequest) -> list[str]:
    gates: list[str] = []
    if snapshot.captcha:
        gates.append("captcha")
    if snapshot.popup:
        gates.append("popup")
    if snapshot.dialog:
        gates.append("dialog")
    return gates


def collect_regions(snapshot: BlockExecutionRequest) -> list[str]:
    seen = []
    for element in snapshot.elements or []:
        group = str(element.get("group") or "").strip()
        if group and group not in seen:
            seen.append(group)
    return seen[:8]


def collect_stable_anchors(snapshot: BlockExecutionRequest) -> list[str]:
    anchors = []
    for element in snapshot.elements or []:
        desc = str(element.get("desc") or "").strip()
        if not desc:
            continue
        if desc not in anchors:
            anchors.append(desc)
        if len(anchors) >= 8:
            break
    return anchors


def collect_element_hints(snapshot: BlockExecutionRequest) -> list[ElementHint]:
    hints: list[ElementHint] = []
    for index, element in enumerate(snapshot.elements or []):
        desc = str(element.get("desc") or "").strip()
        if not desc:
            continue
        hints.append(
            ElementHint(
                ref=index,
                tag=str(element.get("tag") or "").lower() or "unknown",
                role=str(element.get("role") or "").lower() or None,
                desc=desc,
                type=str(element.get("type") or "").lower() or None,
                href=str(element.get("href") or "") or None,
                value=str(element.get("value") or "") or None,
                group=str(element.get("group") or "") or None,
                disabled=bool(element.get("disabled") or False),
            )
        )
        if len(hints) >= 40:
            break
    return hints


def build_site_model(snapshot: BlockExecutionRequest) -> SiteModel:
    parsed = urlparse(snapshot.url)
    page_type = classify_page_type(snapshot)
    auth_state = classify_auth_state(page_type, snapshot)
    anchors = collect_stable_anchors(snapshot)
    return SiteModel(
        host=parsed.netloc or snapshot.url,
        route=parsed.path or "/",
        product_name=(parsed.netloc or snapshot.url),
        page_type=page_type,
        auth_state=auth_state,
        gates=collect_gates(snapshot),
        available_regions=collect_regions(snapshot),
        stable_anchors=anchors,
        element_hints=collect_element_hints(snapshot),
        api_candidates=[],
        success_markers=anchors[:3],
        risk_markers=(["page_loading"] if snapshot.page_loading else []),
    )


def build_site_probe_evidence(snapshot: BlockExecutionRequest, site_model: SiteModel) -> list[EvidenceRecord]:
    now = _now_iso()
    evidence = [
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="page_state_change",
            source="extension",
            ts=now,
            summary=f"Observed {site_model.host}{site_model.route} as {site_model.page_type}",
            confidence=0.78,
            payload_ref=f"url:{snapshot.url}",
        ),
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="visible_text",
            source="extension",
            ts=now,
            summary=(
                "Stable anchors: " + ", ".join(site_model.stable_anchors[:5])
                if site_model.stable_anchors
                else "No stable anchors extracted"
            ),
            confidence=0.68,
            payload_ref="elements",
        ),
    ]
    if snapshot.captcha:
        evidence.append(
            EvidenceRecord(
                evidence_id=_new_id("ev"),
                type="dialog_event",
                source="extension",
                ts=now,
                summary="Captcha gate detected on page",
                confidence=0.9,
                payload_ref="captcha",
            )
        )
    if snapshot.popup or snapshot.dialog:
        evidence.append(
            EvidenceRecord(
                evidence_id=_new_id("ev"),
                type="dialog_event",
                source="extension",
                ts=now,
                summary="Popup or dialog detected on page",
                confidence=0.82,
                payload_ref="dialog",
            )
        )
    return evidence


def build_session_evidence(site_model: SiteModel, snapshot: BlockExecutionRequest) -> list[EvidenceRecord]:
    now = _now_iso()
    return [
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="page_state_change",
            source="extension",
            ts=now,
            summary=(
                f"Session check observed {site_model.host}{site_model.route} "
                f"with auth={site_model.auth_state}"
            ),
            confidence=0.82,
            payload_ref=f"url:{snapshot.url}",
        ),
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="visible_text",
            source="extension",
            ts=now,
            summary=(
                "Session markers: " + ", ".join(site_model.stable_anchors[:5])
                if site_model.stable_anchors
                else "No stable session markers extracted"
            ),
            confidence=0.64,
            payload_ref="elements",
        ),
    ]


def build_gate_evidence(site_model: SiteModel, snapshot: BlockExecutionRequest, gate_kind: str) -> list[EvidenceRecord]:
    now = _now_iso()
    evidence = [
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="dialog_event",
            source="extension",
            ts=now,
            summary=(
                f"Gate check for {gate_kind}: current page gates are "
                f"{', '.join(site_model.gates) if site_model.gates else 'none'}"
            ),
            confidence=0.77,
            payload_ref=f"url:{snapshot.url}",
        ),
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="visible_text",
            source="extension",
            ts=now,
            summary=(
                "Post-gate anchors: " + ", ".join(site_model.stable_anchors[:5])
                if site_model.stable_anchors
                else "No stable anchors extracted after gate handling"
            ),
            confidence=0.6,
            payload_ref="elements",
        ),
    ]
    return evidence


def build_navigation_evidence(
    snapshot: BlockExecutionRequest,
    site_model: SiteModel,
    block: Block,
) -> list[EvidenceRecord]:
    now = _now_iso()
    target_url = str(block.inputs.get("url") or "")
    target = urlparse(target_url)
    actual = urlparse(snapshot.url)
    evidence = [
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="tab_change",
            source="extension",
            ts=now,
            summary=f"Browser moved to {actual.netloc or snapshot.url}{actual.path or '/'}",
            confidence=0.84,
            payload_ref=f"url:{snapshot.url}",
        ),
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="page_state_change",
            source="extension",
            ts=now,
            summary=(
                f"Destination resembles target {target.netloc or 'unknown'} "
                f"and now appears to be {site_model.page_type}"
            ),
            confidence=0.76,
            payload_ref=f"title:{snapshot.title or ''}",
        ),
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="visible_text",
            source="extension",
            ts=now,
            summary=(
                "Stable anchors after navigation: " + ", ".join(site_model.stable_anchors[:5])
                if site_model.stable_anchors
                else "No stable anchors extracted after navigation"
            ),
            confidence=0.67,
            payload_ref="elements",
        ),
    ]
    return evidence


def build_extract_evidence(
    snapshot: BlockExecutionRequest,
    site_model: SiteModel,
    block: Block,
) -> list[EvidenceRecord]:
    now = _now_iso()
    method = str(block.inputs.get("method") or "extract")
    preview = (snapshot.action_result or "").strip().replace("\n", " ")
    preview = preview[:180] + ("..." if len(preview) > 180 else "")
    evidence_type: EvidenceType = "visible_text"
    if method == "scrape_links":
        evidence_type = "link_extract"
    elif method == "scrape_table":
        evidence_type = "table_extract"
    elif method == "scrape_network":
        evidence_type = "network_response"

    return [
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type=evidence_type,
            source="extension",
            ts=now,
            summary=f"Extracted page data via {method}: {preview or 'non-empty result captured'}",
            confidence=0.82,
            payload_ref=f"url:{snapshot.url}",
        ),
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="page_state_change",
            source="extension",
            ts=now,
            summary=f"Extraction ran on {site_model.host}{site_model.route}",
            confidence=0.7,
            payload_ref=f"title:{snapshot.title or ''}",
        ),
    ]


def build_fill_evidence(
    snapshot: BlockExecutionRequest,
    site_model: SiteModel,
    block: Block,
    input_match: bool,
) -> list[EvidenceRecord]:
    now = _now_iso()
    intended = str(block.inputs.get("text") or "")
    actual = str((snapshot.action_metadata or {}).get("input_verification", {}).get("actual") or "")
    return [
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="form_validation",
            source="extension",
            ts=now,
            summary=(
                f'Filled "{block.inputs.get("field_desc", "field")}" with '
                f'"{intended[:80]}"'
            ),
            confidence=0.8 if input_match else 0.42,
            payload_ref=f"url:{snapshot.url}",
        ),
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="visible_text",
            source="extension",
            ts=now,
            summary=f"Field readback: {actual[:120] or 'unavailable'}",
            confidence=0.72 if actual else 0.35,
            payload_ref="action_metadata",
        ),
    ]


def build_submit_evidence(
    snapshot: BlockExecutionRequest,
    site_model: SiteModel,
    block: Block,
) -> list[EvidenceRecord]:
    now = _now_iso()
    mode = str(block.inputs.get("mode") or "unknown")
    return [
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="page_state_change",
            source="extension",
            ts=now,
            summary=(
                f"Submit action dispatched via {mode} on {site_model.host}{site_model.route}"
            ),
            confidence=0.73,
            payload_ref=f"url:{snapshot.url}",
        ),
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="visible_text",
            source="extension",
            ts=now,
            summary=(
                "Post-submit anchors: " + ", ".join(site_model.stable_anchors[:5])
                if site_model.stable_anchors
                else "No stable anchors extracted after submit"
            ),
            confidence=0.58,
            payload_ref="elements",
        ),
    ]


def build_verify_evidence(
    snapshot: BlockExecutionRequest,
    site_model: SiteModel,
    block: Block,
    matched_terms: int,
) -> list[EvidenceRecord]:
    now = _now_iso()
    expected = str(block.inputs.get("expected_text") or "")
    return [
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="page_state_change",
            source="extension",
            ts=now,
            summary=(
                f'Verification checked for "{expected[:80]}" on '
                f"{site_model.host}{site_model.route}"
            ),
            confidence=0.78,
            payload_ref=f"url:{snapshot.url}",
        ),
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="visible_text",
            source="extension",
            ts=now,
            summary=f"Matched {matched_terms} expected query terms in URL, title, or anchors",
            confidence=0.7 if matched_terms else 0.3,
            payload_ref="elements",
        ),
    ]


def replace_or_append_site_model(session: SessionHarness, site_model: SiteModel) -> None:
    for index, existing in enumerate(session.site_models):
        if existing.host == site_model.host:
            session.site_models[index] = site_model
            return
    session.site_models.append(site_model)


def _resolve_gate(session: SessionHarness, gate_type: GateType) -> None:
    for gate in session.gate_state:
        if gate.type == gate_type and gate.status == "open":
            gate.status = "resolved"


def _upsert_gate(
    session: SessionHarness,
    *,
    gate_type: GateType,
    summary: str,
    requires_user_action: bool = True,
) -> GateState:
    for gate in session.gate_state:
        if gate.type == gate_type and gate.status == "open":
            gate.summary = summary
            gate.requires_user_action = requires_user_action
            return gate

    gate = GateState(
        gate_id=_new_id("gate"),
        type=gate_type,
        status="open",
        summary=summary,
        requires_user_action=requires_user_action,
    )
    session.gate_state.append(gate)
    return gate


def sync_resolved_gates(session: SessionHarness, site_model: SiteModel) -> None:
    if site_model.auth_state == "logged_in":
        _resolve_gate(session, "auth")
    if "captcha" not in site_model.gates:
        _resolve_gate(session, "captcha")
    if "popup" not in site_model.gates and "dialog" not in site_model.gates:
        _resolve_gate(session, "handoff")


def execute_site_probe_block(
    session: SessionHarness,
    block_id: str,
    snapshot: BlockExecutionRequest,
) -> tuple[Block, BlockResult, SiteModel, list[EvidenceRecord]]:
    block = find_block(session, block_id)
    if block.type != "SiteProbe":
        raise ValueError(f"Unsupported block type for Slice 2: {block.type}")
    if block.status == "verified":
        raise ValueError("Block already verified")

    site_model = build_site_model(snapshot)
    evidence = build_site_probe_evidence(snapshot, site_model)
    success = bool(site_model.host and (site_model.stable_anchors or site_model.gates or site_model.page_type != "unknown"))

    block.outputs = {
        "site_model_host": site_model.host,
        "page_type": site_model.page_type,
        "auth_state": site_model.auth_state,
        "gate_count": len(site_model.gates),
        "anchor_count": len(site_model.stable_anchors),
    }
    block.status = "verified" if success else "rejected"

    result = BlockResult(
        block_id=block.block_id,
        result="success" if success else "failure",
        evidence=[item.evidence_id for item in evidence],
        confidence=0.86 if success else 0.35,
        verifier=block.success_verifier,
        next_hint="planning",
        artifacts=[],
    )

    replace_or_append_site_model(session, site_model)
    sync_resolved_gates(session, site_model)
    session.evidence_ledger.extend(evidence)
    session.status = "planning"
    session.updated_at = _now_iso()
    return block, result, site_model, evidence


def execute_navigate_block(
    session: SessionHarness,
    block_id: str,
    snapshot: BlockExecutionRequest,
) -> tuple[Block, BlockResult, SiteModel, list[EvidenceRecord]]:
    block = find_block(session, block_id)
    if block.type != "Navigate":
        raise ValueError(f"Unsupported block type for Slice 5: {block.type}")
    if block.status == "verified":
        raise ValueError("Block already verified")

    site_model = build_site_model(snapshot)
    evidence = build_navigation_evidence(snapshot, site_model, block)

    target_url = str(block.inputs.get("url") or "")
    target = urlparse(target_url)
    actual = urlparse(snapshot.url)
    source_host = str(block.inputs.get("source_host") or "")
    source_route = str(block.inputs.get("source_route") or "")
    query = str(block.inputs.get("query") or "").lower()
    haystack = " ".join(
        [snapshot.url or "", snapshot.title or "", *site_model.stable_anchors]
    ).lower()
    query_terms = [term for term in re.findall(r"[a-z0-9]+", query) if len(term) > 2][:6]
    matched_terms = sum(1 for term in query_terms if term in haystack)

    host_ok = not target.netloc or actual.netloc == target.netloc
    path_ok = not target.path or target.path == "/" or actual.path.startswith(target.path)
    moved_ok = bool(actual.netloc) and (
        actual.netloc != source_host or (actual.path or "/") != (source_route or "/")
    )
    query_ok = not query_terms or matched_terms >= min(2, len(query_terms))
    anchors_ok = bool(site_model.stable_anchors) or site_model.page_type != "unknown"
    success = host_ok and path_ok and moved_ok and anchors_ok and query_ok

    block.outputs = {
        "target_url": target_url,
        "actual_url": snapshot.url,
        "page_type": site_model.page_type,
        "auth_state": site_model.auth_state,
        "anchor_count": len(site_model.stable_anchors),
        "matched_query_terms": matched_terms,
    }
    block.status = "verified" if success else "rejected"

    result = BlockResult(
        block_id=block.block_id,
        result="success" if success else "failure",
        evidence=[item.evidence_id for item in evidence],
        confidence=0.81 if success else 0.36,
        verifier=block.success_verifier,
        next_hint="planning",
        artifacts=[],
    )

    replace_or_append_site_model(session, site_model)
    sync_resolved_gates(session, site_model)
    session.evidence_ledger.extend(evidence)
    session.status = "planning"
    session.updated_at = _now_iso()
    return block, result, site_model, evidence


def execute_ensure_session_block(
    session: SessionHarness,
    block_id: str,
    snapshot: BlockExecutionRequest,
) -> tuple[Block, BlockResult, SiteModel, list[EvidenceRecord]]:
    block = find_block(session, block_id)
    if block.type != "EnsureSession":
        raise ValueError(f"Unsupported block type for Slice 6: {block.type}")
    if block.status == "verified":
        raise ValueError("Block already verified")

    site_model = build_site_model(snapshot)
    evidence = build_session_evidence(site_model, snapshot)
    sync_resolved_gates(session, site_model)
    logged_in = site_model.auth_state == "logged_in"

    block.outputs = {
        "host": site_model.host,
        "route": site_model.route,
        "auth_state": site_model.auth_state,
        "page_type": site_model.page_type,
    }

    if logged_in:
        block.status = "verified"
        result = BlockResult(
            block_id=block.block_id,
            result="success",
            evidence=[item.evidence_id for item in evidence],
            confidence=0.83,
            verifier=block.success_verifier,
            next_hint="planning",
            artifacts=[],
        )
        session.status = "planning"
    else:
        block.status = "gated"
        _upsert_gate(
            session,
            gate_type="auth",
            summary="Login required. Take over to sign in, then tell Pixel to continue.",
            requires_user_action=True,
        )
        result = BlockResult(
            block_id=block.block_id,
            result="gated",
            evidence=[item.evidence_id for item in evidence],
            confidence=0.79,
            verifier=block.success_verifier,
            next_hint="wait_for_user_handoff",
            artifacts=[],
        )
        session.status = "gated"

    replace_or_append_site_model(session, site_model)
    session.evidence_ledger.extend(evidence)
    session.updated_at = _now_iso()
    return block, result, site_model, evidence


def execute_clear_gate_block(
    session: SessionHarness,
    block_id: str,
    snapshot: BlockExecutionRequest,
) -> tuple[Block, BlockResult, SiteModel, list[EvidenceRecord]]:
    block = find_block(session, block_id)
    if block.type != "ClearGate":
        raise ValueError(f"Unsupported block type for Slice 6: {block.type}")
    if block.status == "verified":
        raise ValueError("Block already verified")

    gate_kind = str(block.inputs.get("gate_kind") or "popup")
    site_model = build_site_model(snapshot)
    evidence = build_gate_evidence(site_model, snapshot, gate_kind)
    sync_resolved_gates(session, site_model)

    if gate_kind == "captcha":
        cleared = "captcha" not in site_model.gates
    elif gate_kind == "dialog":
        cleared = "dialog" not in site_model.gates
    else:
        cleared = "popup" not in site_model.gates and "dialog" not in site_model.gates

    block.outputs = {
        "gate_kind": gate_kind,
        "remaining_gates": site_model.gates,
        "page_type": site_model.page_type,
    }

    if cleared:
        block.status = "verified"
        result = BlockResult(
            block_id=block.block_id,
            result="success",
            evidence=[item.evidence_id for item in evidence],
            confidence=0.8,
            verifier=block.success_verifier,
            next_hint="planning",
            artifacts=[],
        )
        session.status = "planning"
    else:
        block.status = "gated"
        gate_type: GateType = "captcha" if gate_kind == "captcha" else "handoff"
        summary = (
            "Captcha still blocks the flow. Solve it manually, then tell Pixel to continue."
            if gate_kind == "captcha"
            else "A blocking popup or dialog still covers the page. Dismiss it manually, then tell Pixel to continue."
        )
        _upsert_gate(
            session,
            gate_type=gate_type,
            summary=summary,
            requires_user_action=True,
        )
        result = BlockResult(
            block_id=block.block_id,
            result="gated",
            evidence=[item.evidence_id for item in evidence],
            confidence=0.72,
            verifier=block.success_verifier,
            next_hint="wait_for_user_handoff",
            artifacts=[],
        )
        session.status = "gated"

    replace_or_append_site_model(session, site_model)
    session.evidence_ledger.extend(evidence)
    session.updated_at = _now_iso()
    return block, result, site_model, evidence


def execute_extract_block(
    session: SessionHarness,
    block_id: str,
    snapshot: BlockExecutionRequest,
) -> tuple[Block, BlockResult, SiteModel, list[EvidenceRecord]]:
    block = find_block(session, block_id)
    if block.type != "Extract":
        raise ValueError(f"Unsupported block type for Slice 7: {block.type}")
    if block.status == "verified":
        raise ValueError("Block already verified")

    site_model = build_site_model(snapshot)
    raw = (snapshot.action_result or "").strip()
    success = bool(raw) and not raw.lower().startswith('{"error"') and not raw.lower().startswith("(element not found)")
    evidence = build_extract_evidence(snapshot, site_model, block)

    block.outputs = {
        "method": block.inputs.get("method"),
        "char_count": len(raw),
        "preview": raw[:280],
        "raw_result": raw[:4000],
        "actual_url": snapshot.url,
    }
    block.status = "verified" if success else "rejected"

    result = BlockResult(
        block_id=block.block_id,
        result="success" if success else "failure",
        evidence=[item.evidence_id for item in evidence],
        confidence=0.85 if success else 0.34,
        verifier=block.success_verifier,
        next_hint="planning",
        artifacts=[],
    )

    replace_or_append_site_model(session, site_model)
    session.evidence_ledger.extend(evidence)
    session.status = "planning"
    session.updated_at = _now_iso()
    return block, result, site_model, evidence


def _normalize_extracted_payload(raw: str) -> tuple[dict[str, Any], int, str]:
    cleaned = raw.strip()
    if not cleaned:
        return {}, 0, ""

    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        parsed = None

    if isinstance(parsed, list):
        preview = json.dumps(parsed[:3], ensure_ascii=True)[:280]
        return {"records": parsed[:25]}, len(parsed), preview
    if isinstance(parsed, dict):
        preview = json.dumps(parsed, ensure_ascii=True)[:280]
        item_count = len(parsed) if parsed else 0
        return {"record": parsed}, max(item_count, 1), preview

    lines = [line.strip("-* \t") for line in cleaned.splitlines() if line.strip()]
    top_lines = lines[:12]
    payload = {
        "text": cleaned[:2000],
        "lines": top_lines,
    }
    preview = " | ".join(top_lines[:3])[:280] if top_lines else cleaned[:280]
    item_count = len(top_lines) if top_lines else (1 if cleaned else 0)
    return payload, item_count, preview


def execute_transform_block(
    session: SessionHarness,
    block_id: str,
    snapshot: BlockExecutionRequest,
) -> tuple[Block, BlockResult, SiteModel, list[EvidenceRecord]]:
    block = find_block(session, block_id)
    if block.type != "Transform":
        raise ValueError(f"Unsupported block type for Slice 12: {block.type}")
    if block.status == "verified":
        raise ValueError("Block already verified")

    source_block = _latest_verified_block_of_type(session, "Extract")
    if not source_block:
        raise ValueError("Transform requires a verified Extract block")

    raw = str(source_block.outputs.get("raw_result") or source_block.outputs.get("preview") or "")
    normalized_payload, item_count, preview = _normalize_extracted_payload(raw)
    payload_json = json.dumps(normalized_payload, ensure_ascii=True)[:4000] if normalized_payload else ""
    success = bool(payload_json) and item_count > 0
    site_model = build_site_model(snapshot)
    now = _now_iso()
    evidence_type: EvidenceType = "table_extract" if normalized_payload.get("records") else "visible_text"
    evidence = [
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type=evidence_type,
            source="harness",
            ts=now,
            summary=(
                f"Normalized transfer payload with {item_count} item(s) from {source_block.block_id}"
                if success
                else "Transform produced no normalized payload"
            ),
            confidence=0.83 if success else 0.3,
            payload_ref=f"block:{source_block.block_id}",
        )
    ]

    block.outputs = {
        "source_block_id": source_block.block_id,
        "item_count": item_count,
        "transfer_payload": payload_json,
        "preview": preview,
    }
    block.status = "verified" if success else "rejected"

    result = BlockResult(
        block_id=block.block_id,
        result="success" if success else "failure",
        evidence=[item.evidence_id for item in evidence],
        confidence=0.81 if success else 0.31,
        verifier=block.success_verifier,
        next_hint="planning",
        artifacts=[],
    )

    replace_or_append_site_model(session, site_model)
    session.evidence_ledger.extend(evidence)
    session.status = "planning"
    session.updated_at = _now_iso()
    return block, result, site_model, evidence


def execute_persist_block(
    session: SessionHarness,
    block_id: str,
    snapshot: BlockExecutionRequest,
) -> tuple[Block, BlockResult, SiteModel, list[EvidenceRecord]]:
    block = find_block(session, block_id)
    if block.type != "Persist":
        raise ValueError(f"Unsupported block type for Slice 12: {block.type}")
    if block.status == "verified":
        raise ValueError("Block already verified")

    source_block = _latest_verified_block_of_type(session, "Transform")
    if not source_block:
        raise ValueError("Persist requires a verified Transform block")

    payload_json = str(source_block.outputs.get("transfer_payload") or "")
    preview = str(source_block.outputs.get("preview") or "")
    artifact_id = _new_id("artifact")
    success = bool(payload_json)
    site_model = build_site_model(snapshot)
    now = _now_iso()
    evidence = [
        EvidenceRecord(
            evidence_id=_new_id("ev"),
            type="file_artifact",
            source="harness",
            ts=now,
            summary=(
                f"Persisted transfer payload as internal artifact {artifact_id}"
                if success
                else "Persist had no transfer payload to store"
            ),
            confidence=0.87 if success else 0.28,
            payload_ref=artifact_id,
        )
    ]

    block.outputs = {
        "artifact_id": artifact_id,
        "persist_target": block.inputs.get("persist_target") or "session_artifact",
        "persisted_bytes": len(payload_json.encode("utf-8")),
        "preview": preview,
    }
    block.status = "verified" if success else "rejected"

    result = BlockResult(
        block_id=block.block_id,
        result="success" if success else "failure",
        evidence=[item.evidence_id for item in evidence],
        confidence=0.86 if success else 0.28,
        verifier=block.success_verifier,
        next_hint="planning",
        artifacts=[artifact_id] if success else [],
    )

    replace_or_append_site_model(session, site_model)
    session.evidence_ledger.extend(evidence)
    session.status = "planning"
    session.updated_at = _now_iso()
    return block, result, site_model, evidence


def execute_fill_block(
    session: SessionHarness,
    block_id: str,
    snapshot: BlockExecutionRequest,
) -> tuple[Block, BlockResult, SiteModel, list[EvidenceRecord]]:
    block = find_block(session, block_id)
    if block.type != "FillOrUpload":
        raise ValueError(f"Unsupported block type for Slice 8: {block.type}")
    if block.status == "verified":
        raise ValueError("Block already verified")

    site_model = build_site_model(snapshot)
    input_verification = (snapshot.action_metadata or {}).get("input_verification") or {}
    actual = str(input_verification.get("actual") or "")
    intended = str(block.inputs.get("text") or "")
    input_match = bool(input_verification.get("match")) or (intended and intended.lower() in actual.lower())
    evidence = build_fill_evidence(snapshot, site_model, block, input_match)

    block.outputs = {
        "filled_ref": block.inputs.get("ref"),
        "filled_text": intended,
        "actual_value": actual,
        "page_type": site_model.page_type,
    }
    block.status = "verified" if input_match else "rejected"

    result = BlockResult(
        block_id=block.block_id,
        result="success" if input_match else "failure",
        evidence=[item.evidence_id for item in evidence],
        confidence=0.8 if input_match else 0.32,
        verifier=block.success_verifier,
        next_hint="planning",
        artifacts=[],
    )

    replace_or_append_site_model(session, site_model)
    session.evidence_ledger.extend(evidence)
    session.status = "planning"
    session.updated_at = _now_iso()
    return block, result, site_model, evidence


def execute_submit_block(
    session: SessionHarness,
    block_id: str,
    snapshot: BlockExecutionRequest,
) -> tuple[Block, BlockResult, SiteModel, list[EvidenceRecord]]:
    block = find_block(session, block_id)
    if block.type != "SubmitOrTrigger":
        raise ValueError(f"Unsupported block type for Slice 8: {block.type}")
    if block.status == "verified":
        raise ValueError("Block already verified")

    site_model = build_site_model(snapshot)
    evidence = build_submit_evidence(snapshot, site_model, block)
    source_host = str(block.inputs.get("source_host") or "")
    source_route = str(block.inputs.get("source_route") or "")
    parsed = urlparse(snapshot.url)
    moved = bool(parsed.netloc) and (
        parsed.netloc != source_host or (parsed.path or "/") != (source_route or "/")
    )
    success = moved or snapshot.page_loading or bool(site_model.stable_anchors)

    block.outputs = {
        "actual_url": snapshot.url,
        "page_type": site_model.page_type,
        "expected_text": block.inputs.get("expected_text") or "",
    }
    block.status = "verified" if success else "rejected"

    result = BlockResult(
        block_id=block.block_id,
        result="success" if success else "failure",
        evidence=[item.evidence_id for item in evidence],
        confidence=0.74 if success else 0.33,
        verifier=block.success_verifier,
        next_hint="planning",
        artifacts=[],
    )

    replace_or_append_site_model(session, site_model)
    session.evidence_ledger.extend(evidence)
    session.status = "planning"
    session.updated_at = _now_iso()
    return block, result, site_model, evidence


def execute_verify_block(
    session: SessionHarness,
    block_id: str,
    snapshot: BlockExecutionRequest,
) -> tuple[Block, BlockResult, SiteModel, list[EvidenceRecord]]:
    block = find_block(session, block_id)
    if block.type != "Verify":
        raise ValueError(f"Unsupported block type for Slice 8: {block.type}")
    if block.status == "verified":
        raise ValueError("Block already verified")

    site_model = build_site_model(snapshot)
    expected = str(block.inputs.get("expected_text") or "")
    terms = _query_terms(expected)
    haystack = " ".join([snapshot.url or "", snapshot.title or "", *site_model.stable_anchors]).lower()
    matched_terms = sum(1 for term in terms if term in haystack)
    source_host = str(block.inputs.get("source_host") or "")
    source_route = str(block.inputs.get("source_route") or "")
    parsed = urlparse(snapshot.url)
    moved = bool(parsed.netloc) and (
        parsed.netloc != source_host or (parsed.path or "/") != (source_route or "/")
    )
    success = matched_terms >= min(2, len(terms)) if terms else moved or bool(site_model.stable_anchors)
    evidence = build_verify_evidence(snapshot, site_model, block, matched_terms)

    block.outputs = {
        "matched_terms": matched_terms,
        "actual_url": snapshot.url,
        "page_type": site_model.page_type,
    }
    block.status = "verified" if success else "rejected"

    result = BlockResult(
        block_id=block.block_id,
        result="success" if success else "failure",
        evidence=[item.evidence_id for item in evidence],
        confidence=0.82 if success else 0.3,
        verifier=block.success_verifier,
        next_hint="planning",
        artifacts=[],
    )

    replace_or_append_site_model(session, site_model)
    session.evidence_ledger.extend(evidence)
    session.status = "planning"
    session.updated_at = _now_iso()
    return block, result, site_model, evidence


def verified_blocks_for_playbook(session: SessionHarness) -> list[Block]:
    return [block for block in session.draft_block_graph if block.status == "verified"]


def session_is_saveable(session: SessionHarness) -> bool:
    # Agent-mode sessions: the agent itself has flipped status to ready_to_save
    # after the plan ran to completion. Trust that signal — the agent's
    # save_playbook tool gate is responsible for the "all todos done" check.
    if session.status == "ready_to_save":
        return True
    # Legacy builder flow: require verified blocks that actually do useful work.
    verified = verified_blocks_for_playbook(session)
    if len(verified) < 2:
        return False
    return any(block.type in {"Extract", "Verify", "Persist"} for block in verified)


def compute_loop_hints(session: SessionHarness) -> list[LoopHint]:
    hints: list[LoopHint] = []
    if "batch" in session.intent_spec.modifiers:
        business_blocks = [
            block.block_id
            for block in verified_blocks_for_playbook(session)
            if block.type in {"Navigate", "Extract", "FillOrUpload", "SubmitOrTrigger", "Verify"}
        ]
        if business_blocks:
            hints.append(
                LoopHint(
                    label="Repeat the core business blocks for each input entity",
                    block_ids=business_blocks,
                    parameter_name="entity",
                )
            )
    return hints


def compute_branch_hints(session: SessionHarness) -> list[BranchHint]:
    hints: list[BranchHint] = []
    block_ids = [block.block_id for block in session.draft_block_graph if block.type == "EnsureSession"]
    if block_ids:
        hints.append(
            BranchHint(
                label="Auth branch",
                condition="If the page shows a login wall or logged_out markers, run EnsureSession before continuing.",
                block_ids=block_ids,
            )
        )

    gate_ids = [block.block_id for block in session.draft_block_graph if block.type == "ClearGate"]
    if gate_ids:
        hints.append(
            BranchHint(
                label="Gate-clearing branch",
                condition="If popup, dialog, or captcha markers appear, run ClearGate before business work.",
                block_ids=gate_ids,
            )
        )
    return hints


def _parameter_name_for_occurrence(session: SessionHarness, key: str, block: Block) -> str:
    if key in {"query", "text", "expected_text"}:
        if session.intent_spec.inputs:
            return session.intent_spec.inputs[0].name
        field_desc = str(block.inputs.get("field_desc") or "").lower()
        if "search" in field_desc or "search" in str(block.title).lower():
            return "query"
        return "value"
    return key


def compute_generalized_inputs(session: SessionHarness) -> list[PlaybookInput]:
    occurrences: dict[str, dict[str, Any]] = {}
    for block in verified_blocks_for_playbook(session):
        for key in ("query", "text", "expected_text"):
            value = block.inputs.get(key)
            if not isinstance(value, str):
                continue
            cleaned = value.strip()
            if not cleaned:
                continue
            bucket = occurrences.setdefault(
                cleaned,
                {
                    "blocks": [],
                    "key": key,
                    "name": _parameter_name_for_occurrence(session, key, block),
                    "descriptions": [],
                },
            )
            bucket["blocks"].append(block.block_id)
            desc = str(block.inputs.get("field_desc") or block.title)
            if desc and desc not in bucket["descriptions"]:
                bucket["descriptions"].append(desc)

    generalized: list[PlaybookInput] = []
    used_names: set[str] = set()
    for value, meta in occurrences.items():
        if len(meta["blocks"]) < 2:
            continue
        name = meta["name"]
        if name in used_names:
            suffix = 2
            while f"{name}_{suffix}" in used_names:
                suffix += 1
            name = f"{name}_{suffix}"
        used_names.add(name)
        description = ", ".join(meta["descriptions"][:2]) if meta["descriptions"] else None
        generalized.append(
            PlaybookInput(
                name=name,
                default_value=value,
                source_block_ids=meta["blocks"],
                description=description,
            )
        )
    return generalized


def parameterize_blocks(blocks: list[Block], generalized_inputs: list[PlaybookInput]) -> list[Block]:
    if not generalized_inputs:
        return [block.model_copy(deep=True) for block in blocks]

    replacements: dict[str, str] = {}
    for item in generalized_inputs:
        if item.default_value:
            replacements[item.default_value] = f"{{{{{item.name}}}}}"

    parameterized: list[Block] = []
    for block in blocks:
        clone = block.model_copy(deep=True)
        for key, value in list(clone.inputs.items()):
            if isinstance(value, str) and value in replacements:
                clone.inputs[key] = replacements[value]
        for key, value in list(clone.outputs.items()):
            if isinstance(value, str) and value in replacements:
                clone.outputs[key] = replacements[value]
        parameterized.append(clone)
    return parameterized


def render_playbook_markdown(
    *,
    title: str,
    session: SessionHarness,
    blocks: list[Block],
    generalized_inputs: list[PlaybookInput],
    loop_hints: list[LoopHint],
    branch_hints: list[BranchHint],
    automation_grade: AutomationGrade = "attended",
) -> str:
    lines = [f"# {title}", ""]
    lines.append(f"Outcome: {session.intent_spec.outcome}")
    lines.append(f"Archetype: `{session.intent_spec.archetype}`")
    lines.append(f"Automation grade: `{automation_grade}`")
    lines.append("")

    if generalized_inputs:
        lines.append("## Inputs")
        for item in generalized_inputs:
            default = f" (default: `{item.default_value}`)" if item.default_value else ""
            desc = f" - {item.description}" if item.description else ""
            lines.append(f"- `{item.name}`{default}{desc}")
        lines.append("")

    lines.append("## Blocks")
    for idx, block in enumerate(blocks, start=1):
        lines.append(f"{idx}. `{block.type}` - {block.title}")
        if block.inputs:
            inputs = ", ".join(f"`{key}`={value!r}" for key, value in block.inputs.items() if value not in ("", None, {}))
            if inputs:
                lines.append(f"   Inputs: {inputs}")
        lines.append(f"   Verify: {block.success_verifier}")
    lines.append("")

    if branch_hints:
        lines.append("## Branches")
        for hint in branch_hints:
            lines.append(f"- {hint.label}: {hint.condition}")
        lines.append("")

    if loop_hints:
        lines.append("## Loops")
        for hint in loop_hints:
            parameter = f" Parameter: `{hint.parameter_name}`." if hint.parameter_name else ""
            lines.append(f"- {hint.label}.{parameter}")
        lines.append("")

    lines.append("## Verifiers")
    for block in blocks:
        lines.append(f"- `{block.type}`: {block.success_verifier}")

    return "\n".join(lines).strip() + "\n"


def compute_automation_grade_for_playbook(
    session: SessionHarness,
    verified: list[Block],
) -> AutomationGrade:
    open_gates = [gate for gate in session.gate_state if gate.status == "open"]
    has_human_gate = any(block.requires_human_gate for block in verified)
    strong_terminal = any(block.type in {"Verify", "Persist"} for block in verified)
    auth_or_captcha_open = any(gate.type in {"auth", "captcha", "otp", "approval"} for gate in open_gates)

    if auth_or_captcha_open or has_human_gate:
        return "attended"
    if strong_terminal and len(verified) >= 4:
        return "mostly_unattended"
    if strong_terminal:
        return "mostly_attended"
    return "attended"


def build_saved_playbook(
    session: SessionHarness,
    *,
    proposed_title: str | None = None,
    proposed_generalized_inputs: list[PlaybookInput] | None = None,
) -> SavedPlaybook:
    verified = verified_blocks_for_playbook(session)
    loop_hints = compute_loop_hints(session)
    branch_hints = compute_branch_hints(session)

    if verified:
        generalized_inputs = proposed_generalized_inputs or compute_generalized_inputs(session)
        parameterized_blocks = parameterize_blocks(verified, generalized_inputs)
        automation_grade = compute_automation_grade_for_playbook(session, verified)
    else:
        # Agent-mode: no draft_block_graph. Synthesize minimal blocks from
        # completed todos so the saved playbook is at least a readable record.
        generalized_inputs = proposed_generalized_inputs or []
        parameterized_blocks = _blocks_from_todos(session)
        automation_grade = "attended"

    title = (
        (proposed_title or "").strip()
        or session.intent_spec.outcome[:120]
        or "Untitled playbook"
    )
    now = _now_iso()
    markdown = render_playbook_markdown(
        title=title,
        session=session,
        blocks=parameterized_blocks,
        generalized_inputs=generalized_inputs,
        loop_hints=loop_hints,
        branch_hints=branch_hints,
        automation_grade=automation_grade,
    )
    status = "active"
    last_verified_at = now
    return SavedPlaybook(
        playbook_id=_new_id("pb"),
        title=title,
        intent_spec=session.intent_spec,
        automation_grade=automation_grade,
        status=status,
        last_verified_at=last_verified_at,
        markdown_render=markdown,
        generalized_inputs=generalized_inputs,
        loop_hints=loop_hints,
        branch_hints=branch_hints,
        blocks=parameterized_blocks,
        source_session_id=session.session_id,
        created_at=now,
        updated_at=now,
    )


def _blocks_from_todos(session: SessionHarness) -> list[Block]:
    blocks: list[Block] = []
    for idx, todo in enumerate(session.todo_plan.todos):
        if todo.status not in {"done", "completed"}:
            continue
        blocks.append(
            Block(
                block_id=f"block_{idx}_{todo.id}",
                type="Navigate",
                title=todo.title,
                intent=todo.description or todo.title,
                inputs={},
                outputs={},
                preconditions=[],
                success_verifier="Agent marked the todo complete.",
                failure_policy="retry_once",
                destructive=False,
                requires_human_gate=False,
                status="verified",
            )
        )
    return blocks


def load_saved_playbook(record: dict[str, Any], block_records: list[dict[str, Any]]) -> SavedPlaybook:
    payload = {
        "playbook_id": record["id"],
        "title": record["title"],
        "intent_spec": json.loads(record["intent_spec_json"]),
        "automation_grade": record["automation_grade"],
        "status": record["status"],
        "last_verified_at": record["last_verified_at"],
        "markdown_render": record["markdown_render"],
        "generalized_inputs": json.loads(record["generalized_inputs_json"]),
        "loop_hints": json.loads(record["loop_hints_json"]),
        "branch_hints": json.loads(record["branch_hints_json"]),
        "blocks": [
            {
                "block_id": row["block_id"],
                "type": row["type"],
                "title": row["title"],
                "intent": json.loads(row["config_json"]).get("intent", ""),
                "inputs": json.loads(row["config_json"]).get("inputs", {}),
                "outputs": json.loads(row["config_json"]).get("outputs", {}),
                "preconditions": json.loads(row["config_json"]).get("preconditions", []),
                "success_verifier": row["success_verifier"],
                "failure_policy": row["failure_policy"],
                "destructive": bool(row["destructive"]),
                "requires_human_gate": bool(row["requires_human_gate"]),
                "status": "verified",
            }
            for row in block_records
        ],
        "source_session_id": record["source_session_id"],
        "created_at": record["created_at"],
        "updated_at": record["updated_at"],
    }
    return SavedPlaybook(**payload)


def build_session_message(
    *,
    session_id: str,
    role: MessageRole,
    message_type: MessageType,
    content: str,
    created_at: str | None = None,
) -> SessionMessage:
    return SessionMessage(
        id=_new_id("msg"),
        session_id=session_id,
        role=role,
        message_type=message_type,
        content=content,
        created_at=created_at or _now_iso(),
    )
