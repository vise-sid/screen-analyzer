// PixelFoxx sidepanel — chat-only agent UI.
//
// The backend runs a Gemini function-calling loop. We POST /sessions/{id}/agent/step,
// execute any browser actions it asks for, and POST again with the results.
// That's the entire protocol.

const API_BASE = "http://localhost:8000";
const MAX_ACTION_ITERATIONS = 40;

// ── DOM handles ─────────────────────────────────────────────
const signinOverlay = document.getElementById("signinOverlay");
const signinBtn = document.getElementById("signinBtn");
const signinError = document.getElementById("signinError");
const appShell = document.getElementById("appShell");
const userChip = document.getElementById("userChip");
const userAvatar = document.getElementById("userAvatar");
const userName = document.getElementById("userName");
const signoutBtn = document.getElementById("signoutBtn");
const homeBtn = document.getElementById("homeBtn");

const landingView = document.getElementById("landingView");
const chatView = document.getElementById("chatView");
const playbooksView = document.getElementById("playbooksView");

const startSessionBtn = document.getElementById("startSessionBtn");
const playbooksBtn = document.getElementById("playbooksBtn");
const playbooksBack = document.getElementById("playbooksBack");
const playbooksList = document.getElementById("playbooksList");

const chatThread = document.getElementById("chatThread");
const todoStrip = document.getElementById("todoStrip");
const todoStripList = document.getElementById("todoStripList");
const todoStripCount = document.getElementById("todoStripCount");

const activityBar = document.getElementById("activityBar");
const saveBanner = document.getElementById("saveBanner");
const saveBtn = document.getElementById("saveBtn");

const taskInput = document.getElementById("taskInput");
const sendBtn = document.getElementById("sendBtn");
const stopBtn = document.getElementById("stopBtn");

// ── State ───────────────────────────────────────────────────
let sessionId = null;
let running = false;
let currentAbort = null;
let renderedMessageIds = new Set();
// Heartbeat-watchdog signals (consumed by the setInterval at file bottom).
// Updated inside driveAgentStep after every step.
let lastAgentActivityAt = null;   // ms timestamp of last successful step
let agentStuckFlag = false;       // true when an exception bailed driveAgentStep, OR when a step ended with no tool calls + tiny chat (garbage tokens)
let lastActionFailed = false;     // true when the most recent action batch had ≥1 failure
let lastSessionSnapshot = null;   // {activeTodoId, todos, status} from last step
// Tracks optimistic user bubbles (content → count). When a matching
// server-persisted user message arrives from /agent/step, we consume one
// entry and skip re-rendering so the UI doesn't double.
const pendingOptimisticUser = new Map();

// ── Views ───────────────────────────────────────────────────
function showLanding() {
  landingView?.classList.remove("hidden");
  chatView?.classList.add("hidden");
  playbooksView?.classList.add("hidden");
  homeBtn?.classList.add("hidden");
}

function showChat() {
  landingView?.classList.add("hidden");
  playbooksView?.classList.add("hidden");
  chatView?.classList.remove("hidden");
  homeBtn?.classList.remove("hidden");
}

function showPlaybooks() {
  landingView?.classList.add("hidden");
  chatView?.classList.add("hidden");
  playbooksView?.classList.remove("hidden");
  homeBtn?.classList.remove("hidden");
  loadPlaybooks().catch((e) => console.warn("loadPlaybooks", e));
}

function goHome() {
  sessionId = null;
  renderedMessageIds = new Set();
  pendingOptimisticUser.clear();
  chatThread.innerHTML = "";
  setTodoPlan({ todos: [] }, null);
  pendingApprovalBubble = null;
  hideSaveBanner();
  cleanupTabManager().catch((e) => console.warn("cleanupTabManager", e));
  showLanding();
}

// ── Chat rendering ──────────────────────────────────────────
function addBubble(role, text, opts = {}) {
  if (!text) return null;
  const el = document.createElement("div");
  const cls = opts.cls || role;
  el.className = `chat-bubble ${cls}`;
  el.textContent = text;
  if (opts.id) el.dataset.messageId = opts.id;
  chatThread.appendChild(el);
  chatThread.scrollTop = chatThread.scrollHeight;
  return el;
}

function addThinking() {
  const el = document.createElement("div");
  el.className = "chat-bubble thinking";
  el.dataset.role = "thinking";
  el.innerHTML =
    '<div class="foxx-thinking-dot" style="animation-delay:0ms"></div>' +
    '<div class="foxx-thinking-dot" style="animation-delay:160ms"></div>' +
    '<div class="foxx-thinking-dot" style="animation-delay:320ms"></div>';
  chatThread.appendChild(el);
  chatThread.scrollTop = chatThread.scrollHeight;
  return el;
}

function removeThinking() {
  chatThread.querySelectorAll('[data-role="thinking"]').forEach((n) => n.remove());
}

function addActionBubble(actionName, args) {
  const summary = describeAction(actionName, args);
  const tag = getActionTag(actionName);
  const el = document.createElement("div");
  el.className = "chat-bubble action running";
  el.dataset.actionName = actionName;
  el.innerHTML =
    `<span class="action-tag" style="background:${tag.color}">${escapeHtml(tag.label)}</span>` +
    `<span class="action-body">${escapeHtml(summary)}</span>` +
    `<span class="action-status">…</span>`;
  chatThread.appendChild(el);
  chatThread.scrollTop = chatThread.scrollHeight;
  return el;
}

function markActionBubble(bubble, outcome, response) {
  if (!bubble) return;
  bubble.classList.remove("running");
  bubble.classList.add(outcome === "ok" ? "ok" : "fail");
  const status = bubble.querySelector(".action-status");
  if (status) status.textContent = outcome === "ok" ? "✓" : "✗";
  if (outcome !== "ok" && response && response.error) {
    const err = document.createElement("span");
    err.className = "action-error";
    err.textContent = String(response.error).slice(0, 160);
    bubble.appendChild(err);
  }
}

// Tool-name → tag-chip {label, color}. See claude_design/CLAUDE.md for palette.
function getActionTag(name) {
  const n = (name || "").toLowerCase();
  if (n === "navigate" || n === "back" || n === "forward" || n === "probe_site")
    return { label: "NAV", color: "#4FB3D9" };
  if (n.startsWith("click") || n === "dismiss_popup")
    return { label: "CLK", color: "#FF6A1A" };
  if (n === "focus_and_type" || n === "type" || n === "clear_and_type" || n === "focus")
    return { label: "IN", color: "#FFC83D" };
  if (n.startsWith("scrape") || n.startsWith("extract"))
    return { label: "SCRP", color: "#FFC83D" };
  if (n === "verify")
    return { label: "VFY", color: "#7FD46B" };
  if (n === "wait")
    return { label: "WAIT", color: "#4A4338" };
  if (n.startsWith("key"))
    return { label: "KEY", color: "#6B6357" };
  if (n === "scroll")
    return { label: "SCR", color: "#6B6357" };
  if (n.endsWith("_tab") || n === "list_tabs" || n === "switch_tab" || n === "new_tab" || n === "close_tab")
    return { label: "TAB", color: "#4FB3D9" };
  if (n.startsWith("sheets") || n.startsWith("docs") || n.startsWith("slides") || n === "fill_cells")
    return { label: "GOOG", color: "#4FB3D9" };
  if (n === "screenshot")
    return { label: "CAP", color: "#6B6357" };
  if (n === "stealth_solve" || n === "click_captcha")
    return { label: "BOT", color: "#FF5A4E" };
  if (n === "google_search")
    return { label: "GOOG", color: "#4FB3D9" };
  return { label: "ACT", color: "#6B6357" };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function describeAction(name, args = {}) {
  switch (name) {
    case "navigate": return `→ navigate: ${args.url || ""}`;
    case "click": return `→ click ref=${args.ref}`;
    case "click_at": return `→ click at (${args.x},${args.y})`;
    case "focus_and_type": return `→ type into ref=${args.ref}: "${(args.text || "").slice(0, 40)}"`;
    case "type": return `→ type: "${(args.text || "").slice(0, 40)}"`;
    case "key": return `→ press ${args.key}`;
    case "key_combo": return `→ key combo: ${args.keys}`;
    case "scroll": return `→ scroll Δy=${args.deltaY || 0}`;
    case "screenshot": return "→ take screenshot";
    case "scrape_page": return "→ scrape page";
    case "scrape_table": return `→ scrape table${args.ref !== undefined ? ` ref=${args.ref}` : ""}`;
    case "scrape_links": return "→ scrape links";
    case "scrape_metadata": return "→ scrape metadata";
    case "scrape_network": return "→ scrape network";
    case "probe_site": return "→ probe site";
    case "dismiss_popup": return "→ dismiss popup";
    case "click_captcha": return "→ click captcha";
    case "stealth_solve": return "→ stealth solve";
    case "ensure_session": return "→ ensure session";
    case "verify": return `→ verify: ${args.expected_text || args.expected || ""}`;
    case "wait": return `→ wait ${args.duration || 1000}ms`;
    case "back": return "→ back";
    case "forward": return "→ forward";
    case "new_tab": return `→ new tab${args.url ? `: ${args.url}` : ""}`;
    case "switch_tab": return `→ switch tab ${args.tabId}`;
    case "close_tab": return `→ close tab ${args.tabId}`;
    case "extract_text": return `→ extract text ref=${args.ref}`;
    case "fill_cells": return `→ fill cells @ ${args.startCell}`;
    case "sheets_create": return `→ create sheet: ${args.title || ""}`;
    case "sheets_write": return `→ write sheet ${args.range}`;
    case "sheets_read": return `→ read sheet ${args.range}`;
    case "docs_create": return `→ create doc: ${args.title || ""}`;
    case "docs_write": return `→ append to doc`;
    case "docs_read": return `→ read doc`;
    case "slides_create": return `→ create deck: ${args.title || ""}`;
    case "slides_read": return `→ read deck`;
    default: return `→ ${name}`;
  }
}

// ── Todo strip ──────────────────────────────────────────────
function setTodoPlan(plan, activeTodoId) {
  const todos = (plan && plan.todos) || [];
  if (!todos.length) {
    todoStrip?.classList.add("hidden");
    todoStripList.innerHTML = "";
    todoStripCount.textContent = "";
    return;
  }
  todoStrip?.classList.remove("hidden");
  const doneCount = todos.filter((t) => t.status === "done").length;
  todoStripCount.textContent = `${doneCount}/${todos.length} done`;
  todoStripList.innerHTML = "";
  for (const todo of todos) {
    const li = document.createElement("li");
    li.className = todo.status;
    if (todo.id === activeTodoId) li.classList.add("active");
    const marker = document.createElement("span");
    marker.className = "todo-marker";
    marker.textContent =
      todo.status === "done"
        ? "✓"
        : todo.status === "running"
        ? "▸"
        : todo.status === "failed"
        ? "✗"
        : todo.status === "approved"
        ? "●"
        : "○";
    const title = document.createElement("span");
    title.className = "todo-title";
    title.textContent = todo.title || "(untitled)";
    li.appendChild(marker);
    li.appendChild(title);
    todoStripList.appendChild(li);
  }
}

// ── Approval flow ───────────────────────────────────────────
// An approval is an inline chat bubble carrying Pixel's own preview text
// plus Go-ahead / Hold-on buttons. No modal, no popup.
let pendingApprovalBubble = null;

function addApprovalBubble(todoId, previewText) {
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble approval";
  bubble.dataset.todoId = todoId || "";

  const text = document.createElement("div");
  text.className = "approval-text";
  text.textContent = previewText || "ready when you are.";
  bubble.appendChild(text);

  const actions = document.createElement("div");
  actions.className = "approval-actions";

  const go = document.createElement("button");
  go.className = "chat-approve";
  go.type = "button";
  go.textContent = "go ahead";

  const hold = document.createElement("button");
  hold.className = "chat-reject";
  hold.type = "button";
  hold.textContent = "hold on…";

  go.addEventListener("click", () => {
    resolveApprovalBubble(bubble, "approved");
    approveCurrentTodo(todoId).catch((e) =>
      addBubble("assistant", e.message, { cls: "error" })
    );
  });
  hold.addEventListener("click", () => {
    resolveApprovalBubble(bubble, "rejected");
    rejectCurrentTodo().catch((e) =>
      addBubble("assistant", e.message, { cls: "error" })
    );
  });

  actions.appendChild(go);
  actions.appendChild(hold);
  bubble.appendChild(actions);

  chatThread.appendChild(bubble);
  chatThread.scrollTop = chatThread.scrollHeight;
  pendingApprovalBubble = bubble;
  return bubble;
}

function resolveApprovalBubble(bubble, outcome) {
  if (!bubble) return;
  bubble.querySelectorAll("button").forEach((b) => {
    b.disabled = true;
  });
  const existing = bubble.querySelector(".approval-resolved");
  if (existing) existing.remove();
  const label = document.createElement("div");
  label.className = `approval-resolved ${outcome}`;
  label.textContent = outcome === "approved" ? "✓ approved" : "✗ held";
  bubble.appendChild(label);
  if (pendingApprovalBubble === bubble) pendingApprovalBubble = null;
}

// ── Save banner ─────────────────────────────────────────────
function showSaveBanner() {
  saveBanner?.classList.remove("hidden");
}

function hideSaveBanner() {
  saveBanner?.classList.add("hidden");
}

// ── Rendering server-persisted messages ─────────────────────
function renderMessages(messages) {
  for (const m of messages) {
    if (renderedMessageIds.has(m.id)) continue;
    renderedMessageIds.add(m.id);
    if (m.role === "user") {
      // If we already showed this content optimistically, consume that entry
      // and don't double-render.
      const count = pendingOptimisticUser.get(m.content) || 0;
      if (count > 0) {
        pendingOptimisticUser.set(m.content, count - 1);
        continue;
      }
      addBubble("user", m.content);
    } else if (m.role === "assistant" && m.message_type === "chat") {
      addBubble("assistant", m.content);
    } else if (m.role === "assistant" && m.message_type === "system") {
      addBubble("system", m.content);
    } else if (m.role === "system") {
      addBubble("system", m.content);
    }
  }
}

// ── Running/stopping UI ─────────────────────────────────────
function setRunning(state) {
  running = state;
  sendBtn?.classList.toggle("hidden", state);
  stopBtn?.classList.toggle("hidden", !state);
  taskInput.disabled = state;
  activityBar?.classList.toggle("hidden", !state);
}

// ── Session lifecycle ───────────────────────────────────────
async function createNewSession(initialMessage, { fromPlaybookId = null } = {}) {
  const body = { message: initialMessage || "" };
  if (fromPlaybookId) body.from_playbook_id = fromPlaybookId;
  const resp = await apiFetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`create session failed: ${resp.status}`);
  return resp.json();
}

async function postAgentStep(payload) {
  const resp = await apiFetch(`${API_BASE}/sessions/${sessionId}/agent/step`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`agent step failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

// Build a lowercase greeting in Foxx's voice, using the signed-in first name
// (falls back to "partner" pre-auth).
function pixelFoxxGreeting() {
  const firstName = (userName?.textContent || "partner").trim().toLowerCase() || "partner";
  return `hey there, ${firstName}. paws on the keyboard, ready to work. what are we building today?`;
}

function addSessionDivider() {
  const now = new Date();
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const el = document.createElement("div");
  el.className = "session-divider";
  el.innerHTML =
    '<div class="session-divider-line"></div>' +
    `<div class="session-divider-label">SESSION STARTED · ${time}</div>` +
    '<div class="session-divider-line"></div>';
  chatThread.appendChild(el);
}

async function startSession() {
  if (running) return;
  showChat();
  setTodoPlan({ todos: [] }, null);
  pendingApprovalBubble = null;
  hideSaveBanner();
  chatThread.innerHTML = "";
  renderedMessageIds = new Set();
  addSessionDivider();

  setRunning(true);
  try {
    // Claim the current tab for the agent. Without this, resolveAgentTab()
    // has nothing to drive and every browser tool silently returns a
    // "No available tab found" failure.
    try { await initTabManager(); } catch (e) { console.warn("initTabManager", e); }
    const envelope = await createNewSession("");
    sessionId = envelope.session.session_id;
    renderMessages(envelope.messages || []);
    setTodoPlan(envelope.session.todo_plan, envelope.session.active_todo_id);
    addBubble("assistant", pixelFoxxGreeting());
  } catch (err) {
    addBubble("assistant", `couldn't start a session: ${err.message}`, { cls: "error" });
  } finally {
    setRunning(false);
  }
}

async function sendMessage() {
  const text = taskInput.value.trim();
  if (!text) return;
  taskInput.value = "";

  if (!sessionId) {
    showChat();
    setRunning(true);
    try {
      try { await initTabManager(); } catch (e) { console.warn("initTabManager", e); }
      const envelope = await createNewSession(text);
      sessionId = envelope.session.session_id;
      renderMessages(envelope.messages || []);
      setTodoPlan(envelope.session.todo_plan, envelope.session.active_todo_id);
      await driveAgentStep({ user_message: null, action_results: [] });
    } catch (err) {
      addBubble("assistant", `couldn't start a session: ${err.message}`, { cls: "error" });
    } finally {
      setRunning(false);
    }
    return;
  }

  addBubble("user", text);
  pendingOptimisticUser.set(text, (pendingOptimisticUser.get(text) || 0) + 1);
  // Typing a fresh message implicitly resolves any open approval bubble.
  if (pendingApprovalBubble) resolveApprovalBubble(pendingApprovalBubble, "rejected");
  setRunning(true);
  try {
    await driveAgentStep({ user_message: text, action_results: [] });
  } catch (err) {
    addBubble("assistant", `${err.message}`, { cls: "error" });
  } finally {
    setRunning(false);
  }
}

async function approveCurrentTodo(todoId) {
  if (running) return;
  setRunning(true);
  try {
    const note = todoId
      ? `approved. go ahead with todo ${todoId}.`
      : "approved. go ahead.";
    await driveAgentStep({ user_message: note, action_results: [] });
  } finally {
    setRunning(false);
  }
}

async function rejectCurrentTodo() {
  if (running) return;
  setRunning(true);
  try {
    await driveAgentStep({
      user_message: "hold on — don't run that yet. reconsider or ask me.",
      action_results: [],
    });
  } finally {
    setRunning(false);
  }
}

// ── Main agent-step driver ──────────────────────────────────
async function driveAgentStep(firstPayload) {
  let payload = firstPayload;
  // A single thinking indicator is kept alive across the entire loop — agent
  // call AND action dispatch — so the UI never goes silent during the
  // ~5-20s it takes CDP to screenshot / probe / scrape. We move it to the
  // bottom of the thread after each new bubble so it always trails the work.
  let thinking = addThinking();

  const bumpThinking = () => {
    // Re-append the same node to push it below any newly added bubble.
    if (thinking && thinking.parentNode) {
      thinking.parentNode.appendChild(thinking);
      chatThread.scrollTop = chatThread.scrollHeight;
    }
  };

  agentStuckFlag = false;
  lastActionFailed = false;
  try {
    for (let iter = 0; iter < MAX_ACTION_ITERATIONS; iter++) {
      const result = await postAgentStep(payload);
      lastAgentActivityAt = Date.now();
      lastSessionSnapshot = {
        activeTodoId: result.session?.active_todo_id || null,
        todos: result.session?.todo_plan?.todos || [],
        status: result.session?.status || null,
      };

      renderMessages(result.messages || []);
      setTodoPlan(result.session.todo_plan, result.session.active_todo_id);
      bumpThinking();

      if (result.session.status === "ready_to_save") {
        showSaveBanner();
      } else {
        hideSaveBanner();
      }

      if (result.awaiting_approval) {
        const activeTodo = (result.session.todo_plan.todos || []).find(
          (t) => t.id === result.approval_todo_id
        );
        const previewText =
          result.approval_preview ||
          activeTodo?.description ||
          activeTodo?.title ||
          "ready when you are.";
        addApprovalBubble(result.approval_todo_id, previewText);
        return;
      }

      const pending = result.pending_actions || [];
      if (!pending.length) {
        // Agent emitted text only — turn is done from the API's view, but if
        // the last assistant chat is empty/tiny (garbage tokens like "_", "9",
        // "{thought"), the model is stuck on response generation rather than
        // genuinely finished. Mark agentStuckFlag so the heartbeat watchdog
        // nudges it within ~10s instead of waiting the full idle threshold.
        const lastAssistantChat = (result.messages || [])
          .filter((m) => m.role === "assistant" && m.message_type === "chat")
          .map((m) => (m.content || "").trim())
          .pop();
        if (lastAssistantChat !== undefined && lastAssistantChat.length < 20) {
          console.log("[heartbeat] garbage response detected:", JSON.stringify(lastAssistantChat));
          agentStuckFlag = true;
        }
        return;
      }

      // Execute each browser action the agent asked for. Thinking indicator
      // stays alive — gets bumped below each new action bubble.
      const action_results = [];
      let batchHadFailure = false;
      for (const pa of pending) {
        const bubble = addActionBubble(pa.name, pa.args || {});
        bumpThinking();
        try {
          const response = await handlePendingAction(pa.name, pa.args || {});
          const ok = response && response.ok !== false;
          if (!ok) batchHadFailure = true;
          markActionBubble(bubble, ok ? "ok" : "fail", response);
          action_results.push({ call_id: pa.call_id, name: pa.name, response });
        } catch (err) {
          console.error(`action ${pa.name} failed`, err);
          batchHadFailure = true;
          markActionBubble(bubble, "fail", { error: err.message || String(err) });
          action_results.push({
            call_id: pa.call_id,
            name: pa.name,
            response: { ok: false, error: err.message || String(err) },
          });
        }
        bumpThinking();
      }
      lastActionFailed = batchHadFailure;
      payload = { user_message: null, action_results };
    }
    addBubble("assistant", "(hit the step cap — taking a breath.)", { cls: "system" });
  } catch (err) {
    agentStuckFlag = true;
    throw err;
  } finally {
    thinking?.remove();
  }
}

// ── Pending action dispatcher ───────────────────────────────
async function handlePendingAction(name, args) {
  // Tab-scoped actions that don't use CDP
  if (name === "new_tab" || name === "switch_tab" || name === "close_tab") {
    await executeTabAction({ type: name, ...args });
    const state = await captureState(false);
    return snapshotResponse(state, { ok: true });
  }

  // List tabs — return lightweight summary the agent can reason over
  if (name === "list_tabs") {
    const tabs = await getAgentTabs();
    const summary = (tabs || []).map((t) => ({
      tab_id: t.id,
      url: t.url || "",
      title: t.title || "",
      active: !!t.active,
    }));
    return { ok: true, tabs: summary };
  }

  // Google search — navigate current tab to google search URL
  if (name === "google_search") {
    const q = (args.query || args.q || "").trim();
    if (!q) return { ok: false, error: "google_search requires a 'query' argument" };
    const url = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
    const tab = await resolveAgentTab();
    await executeAction(tab.id, { type: "navigate", url });
    const state = await captureState(true);
    return snapshotResponse(state, { ok: true, query: q });
  }

  // Focus — treat as a click on the first match to give focus
  if (name === "focus") {
    const tab = await resolveAgentTab();
    await executeAction(tab.id, { type: "focus_and_type", selector: args.selector, text: "" });
    const state = await captureState(false);
    return snapshotResponse(state, { ok: true });
  }

  // Google Workspace — route through backend
  if (
    name === "sheets_create" || name === "sheets_write" || name === "sheets_read" ||
    name === "docs_create" || name === "docs_write" || name === "docs_read" ||
    name === "slides_create" || name === "slides_read"
  ) {
    return await callWorkspace(name, args);
  }

  // Stealth Cloudflare solver — call backend
  if (name === "stealth_solve") {
    const tab = await resolveAgentTab();
    const cookies = typeof getCookiesForUrl === "function"
      ? await getCookiesForUrl(tab.url).catch(() => null)
      : null;
    const resp = await apiFetch(`${API_BASE}/stealth-solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: tab.url, cookies }),
    });
    if (!resp.ok) return { ok: false, error: `stealth_solve HTTP ${resp.status}` };
    const data = await resp.json();
    if (typeof setCookiesFromList === "function" && data.cookies) {
      await setCookiesFromList(data.cookies).catch((e) => console.warn("setCookies", e));
    }
    return { ok: true, cleared: !!data.cleared };
  }

  // "probe_site" / "screenshot" / "ensure_session" / "verify" map to captureState
  if (name === "probe_site") {
    const state = await captureState(true);
    return snapshotResponse(state, { ok: true, purpose: "probe_site" }, { includeScreenshot: true });
  }
  if (name === "screenshot") {
    const state = await captureState(true);
    return snapshotResponse(state, { ok: true, purpose: "screenshot" }, { includeScreenshot: true });
  }
  if (name === "ensure_session") {
    const state = await captureState(false);
    const authState = guessAuthState(state);
    return snapshotResponse(state, { ok: true, auth_state: authState });
  }
  if (name === "verify") {
    const state = await captureState(false);
    const url = (state?.url || "").toLowerCase();
    const flat = flattenElements(state.elements).toLowerCase();
    const urlContains = (args.url_contains || "").toLowerCase().trim();
    const textContains = (args.text_contains || "").toLowerCase().trim();
    const expected = (args.expected_text || args.expected || "").toLowerCase().trim();

    const signals = [];
    let pass = true;

    if (urlContains) {
      const hit = url.includes(urlContains);
      signals.push({ check: "url_contains", value: urlContains, pass: hit });
      if (!hit) pass = false;
    }
    if (textContains) {
      const hit = flat.includes(textContains);
      signals.push({ check: "text_contains", value: textContains, pass: hit });
      if (!hit) pass = false;
    }
    // Only fall back to fuzzy token coverage if no structured check was given.
    if (!urlContains && !textContains && expected) {
      const STOP = new Set(["the","a","an","of","for","to","and","in","on","is","with","at","or","by","as","be","page","showing","information"]);
      const tokens = expected.split(/[^\p{L}\p{N}]+/u).filter((t) => t && !STOP.has(t));
      const present = tokens.filter((t) => flat.includes(t) || url.includes(t));
      const coverage = tokens.length ? present.length / tokens.length : 0;
      const hit = coverage >= 0.5;
      signals.push({
        check: "token_coverage",
        value: expected,
        coverage: Number(coverage.toFixed(2)),
        matched: present,
        missing: tokens.filter((t) => !present.includes(t)),
        pass: hit,
      });
      if (!hit) pass = false;
    }
    if (!signals.length) {
      // No expected-signal args at all — just report state.
      return snapshotResponse(state, {
        ok: false,
        error: "verify needs at least one of url_contains / text_contains / expected",
      });
    }
    // No screenshot here — verify is for deterministic assertions. If Pixel
    // wants to SEE the page, it calls screenshot explicitly.
    return snapshotResponse(state, { ok: pass, signals });
  }

  // Click-by-coordinates
  if (name === "click_at") {
    const tab = await resolveAgentTab();
    await executeAction(tab.id, { type: "click", x: args.x, y: args.y });
    const state = await captureState(false);
    return snapshotResponse(state, { ok: true });
  }

  // Fall-through — pass through to executeAction; afterwards snapshot
  const tab = await resolveAgentTab();
  const execAction = buildExecAction(name, args);
  await executeAction(tab.id, execAction);

  // Some actions produce an action_result (scrape_*, extract_text) — harvest it
  const actionResult = execAction._result || execAction.result || null;
  const state = await captureState(name === "navigate");
  const base = { ok: true };
  if (actionResult !== null && actionResult !== undefined) {
    base.result = typeof actionResult === "string" ? actionResult.slice(0, 8000) : actionResult;
  }
  return snapshotResponse(state, base);
}

function buildExecAction(name, args) {
  // The existing executeAction() uses shape {type, ...args}. Agent tool names
  // line up with the legacy action.type values, so a straight spread works.
  return { type: name, ...args };
}

function snapshotResponse(state, extras = {}, { includeScreenshot = false } = {}) {
  const tab = state?.screenshot || {};
  const raw = Array.isArray(state?.elements) ? state.elements : [];
  const MAX_ELEMENTS = 120;
  const compactElements = raw.slice(0, MAX_ELEMENTS).map((e) => {
    const out = { ref: e.ref, tag: e.tag };
    const desc = (e.desc || e.text || "").toString().trim();
    if (desc) out.desc = desc.length > 160 ? desc.slice(0, 160) + "…" : desc;
    const value = (e.value || "").toString().trim();
    if (value) out.value = value.length > 100 ? value.slice(0, 100) + "…" : value;
    if (e.role) out.role = e.role;
    if (e.href) out.href = e.href;
    return out;
  });
  const out = {
    ...extras,
    url: state?.url || "",
    title: state?.title || "",
    element_count: raw.length,
    elements: compactElements,
    elements_truncated: raw.length > MAX_ELEMENTS,
    popup: state?.popup ? truthy(state.popup) : null,
    captcha: state?.captcha ? truthy(state.captcha) : null,
    dialog: state?.dialog || null,
    tab_id: tab.tabId || null,
    page_loading: !!state?.pageLoading,
  };
  // Ship the image bytes ONLY when requested (probe_site / screenshot /
  // verify). Gemini's multimodal: the backend will pull this out and attach
  // it as an image Part so Pro can actually SEE the page.
  if (includeScreenshot && tab.base64) {
    out.screenshot_base64 = tab.base64;
    out.screenshot_mime = tab.mime || "image/jpeg";
  }
  return out;
}

function truthy(obj) {
  if (!obj) return null;
  const { type, rect, closeButton } = obj;
  return { type: type || "unknown", has_close: !!closeButton };
}

function flattenElements(elements) {
  if (!Array.isArray(elements)) return "";
  return elements.map((e) => [e.tag, e.desc, e.value].filter(Boolean).join(" ")).join(" | ");
}

function guessAuthState(state) {
  const flat = flattenElements(state?.elements).toLowerCase();
  if (/sign in|log in|login|sign-in/.test(flat)) return "logged_out";
  if (/log out|sign out|account|profile|my orders/.test(flat)) return "logged_in";
  return "unknown";
}

async function callWorkspace(name, args) {
  const token = await getGoogleAuthToken();
  if (!token) return { ok: false, error: "no google oauth token" };

  const endpointMap = {
    sheets_create: "/sheets/create",
    sheets_write: "/sheets/write",
    sheets_read: "/sheets/read",
    docs_create: "/docs/create",
    docs_write: "/docs/write",
    docs_read: "/docs/read",
    slides_create: "/slides/create",
    slides_read: "/slides/read",
  };
  const path = endpointMap[name];
  if (!path) return { ok: false, error: `unknown workspace tool ${name}` };

  const body = { ...args, token };
  const resp = await apiFetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false, error: `${resp.status} ${text}` };
  }
  const data = await resp.json();
  return { ok: true, ...data };
}

// ── Capture state (screenshot + elements + tabs) ────────────
async function captureState(needsScreenshot = true) {
  const tab = await resolveAgentTab();
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(150);
  }

  try { await waitForPageReady(); } catch (_) {}

  const [screenshot, elemData, agentTabs] = await Promise.all([
    needsScreenshot
      ? captureScreenshot(tab).catch(() => ({ base64: null, tabId: tab.id }))
      : Promise.resolve({ base64: null, tabId: tab.id }),
    extractElements(tab.id).catch(() => ({
      elements: null, scrollContainers: null, popup: null, captcha: null, isCanvasHeavy: false,
    })),
    getAgentTabs().catch(() => []),
  ]);

  let { elements, scrollContainers, popup, captcha, isCanvasHeavy, pageScroll, pageLoading } = elemData;
  if (elements && elements.length > 200) elements = elements.slice(0, 200);

  const dialog = typeof getPendingDialog === "function" ? getPendingDialog() : null;
  return {
    screenshot,
    elements,
    scrollContainers,
    popup,
    captcha,
    dialog,
    isCanvasHeavy,
    agentTabs,
    pageScroll,
    pageLoading,
    url: tab.url,
    title: tab.title,
  };
}

async function captureScreenshot(tab) {
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(150);
  }
  let dataUrl = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // PNG — lossless. Needed for reliable CAPTCHA text, fine UI details,
      // and anti-aliased text on charts/canvas.
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      break;
    } catch (e) {
      if (attempt < 2) await sleep(300); else throw e;
    }
  }
  return {
    base64: dataUrl ? dataUrl.split(",")[1] : null,
    mime: "image/png",
    tabId: tab.id,
    width: tab.width,
    height: tab.height,
  };
}

async function resolveAgentTab() {
  const tabId = getActiveAgentTabId();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (_) {
      if (attempt < 2) await sleep(300);
    }
  }
  for (const id of agentTabIds) {
    if (id === tabId) continue;
    try {
      const tab = await chrome.tabs.get(id);
      activeAgentTabId = tab.id;
      await chrome.tabs.update(tab.id, { active: true });
      return tab;
    } catch (_) {
      agentTabIds.delete(id);
    }
  }
  const allTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (allTabs.length > 0) {
    const tab = allTabs[0];
    agentTabIds.add(tab.id);
    activeAgentTabId = tab.id;
    return tab;
  }
  throw new Error("No available tab found");
}

async function executeTabAction(action) {
  switch (action.type) {
    case "new_tab": {
      const result = await agentNewTab(action.url || "about:blank");
      if (!result) console.warn("tab limit reached");
      await detachDebugger();
      await sleep(action.url ? 1500 : 400);
      break;
    }
    case "switch_tab": {
      await agentSwitchTab(action.tabId);
      await sleep(400);
      break;
    }
    case "close_tab": {
      await agentCloseTab(action.tabId);
      await sleep(250);
      break;
    }
  }
}

// ── Save playbook + Playbooks list ──────────────────────────
async function savePlaybook() {
  if (!sessionId) return;
  const resp = await apiFetch(`${API_BASE}/sessions/${sessionId}/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!resp.ok) {
    const t = await resp.text();
    addBubble("assistant", `save failed: ${t}`, { cls: "error" });
    return;
  }
  const data = await resp.json();
  hideSaveBanner();
  addBubble("assistant", `saved as "${data.playbook.title}".`, { cls: "system" });
}

async function loadPlaybooks() {
  playbooksList.innerHTML = '<div class="playbooks-empty">Loading…</div>';
  const resp = await apiFetch(`${API_BASE}/playbooks`);
  if (!resp.ok) {
    playbooksList.innerHTML = `<div class="playbooks-empty">couldn't load (${resp.status}).</div>`;
    return;
  }
  const records = await resp.json();
  playbooksList.innerHTML = "";
  if (!records.length) {
    playbooksList.innerHTML = '<div class="playbooks-empty">no saved playbooks yet.</div>';
    return;
  }
  for (const pb of records) {
    const card = document.createElement("div");
    card.className = "playbook-card";
    const title = document.createElement("div");
    title.className = "playbook-card-title";
    title.textContent = pb.title || "Untitled";
    const meta = document.createElement("div");
    meta.className = "playbook-card-meta";
    const date = pb.last_verified_at ? new Date(pb.last_verified_at).toLocaleString() : "";
    meta.textContent = `${pb.blocks?.length || 0} blocks · ${date}`;
    const grade = document.createElement("span");
    grade.className = "playbook-card-grade";
    grade.textContent = pb.automation_grade || "attended";
    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(grade);
    card.addEventListener("click", () =>
      openPlaybook(pb).catch((e) => addBubble("assistant", e.message, { cls: "error" }))
    );
    playbooksList.appendChild(card);
  }
}

async function openPlaybook(pb) {
  if (running) return;
  goHome();
  showChat();

  const inputs = pb.generalized_inputs || [];
  const inputLines = inputs
    .map((i) => {
      const parts = [`- **${i.name}**`];
      if (i.description) parts.push(`: ${i.description}`);
      if (i.default_value) parts.push(` (last run: \`${i.default_value}\`)`);
      return parts.join("");
    })
    .join("\n");

  const plan = (pb.markdown_render || "").trim();
  const promptLines = [
    `Let's rerun this saved playbook: **${pb.title}**.`,
    "",
    inputs.length
      ? `Parameters you defined — ask me for the current values before driving anything:\n${inputLines}`
      : `No generalized inputs are captured on this playbook, so start by asking me for whatever you'd need to rerun this.`,
  ];
  if (plan) {
    promptLines.push("", "Previous plan, for reference:", plan);
  }
  const seedMessage = promptLines.join("\n");

  addBubble("user", `Run playbook: "${pb.title}"`);
  addBubble("assistant", `loading playbook "${pb.title}" (running on flash)…`, { cls: "system" });
  setRunning(true);
  try {
    try { await initTabManager(); } catch (e) { console.warn("initTabManager", e); }
    const envelope = await createNewSession(seedMessage, {
      fromPlaybookId: pb.playbook_id,
    });
    sessionId = envelope.session.session_id;
    renderMessages(envelope.messages || []);
    setTodoPlan(envelope.session.todo_plan, envelope.session.active_todo_id);
    await driveAgentStep({ user_message: null, action_results: [] });
  } catch (err) {
    addBubble("assistant", `couldn't run playbook: ${err.message}`, { cls: "error" });
  } finally {
    setRunning(false);
  }
}

// ── Sign-in (unchanged) ─────────────────────────────────────
function showSignIn() {
  signinOverlay?.classList.remove("hidden");
  appShell?.classList.add("hidden");
}

function hideSignIn() {
  signinOverlay?.classList.add("hidden");
  appShell?.classList.remove("hidden");
}

function renderUserChip(user) {
  if (!userChip || !user) return;
  const displayName = user.name || user.email || "";
  const firstName = (displayName.trim().split(/\s+/)[0] || "").toLowerCase() || "partner";

  // Initials block: first two initials of display name (fallback ?)
  const avatarBlock = document.getElementById("userAvatarBlock");
  if (avatarBlock) {
    const parts = displayName.trim().split(/\s+/);
    const initials = ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase();
    avatarBlock.textContent = initials || "?";
  }

  // Google photo avatar — only show it if we actually have a photo URL.
  if (userAvatar) {
    if (user.picture) {
      userAvatar.src = user.picture;
      userAvatar.classList.remove("hidden");
      avatarBlock?.classList.add("hidden");
    } else {
      userAvatar.classList.add("hidden");
      avatarBlock?.classList.remove("hidden");
    }
  }

  // Chip label is just the first name — keep it short and lowercase per voice.
  if (userName) userName.textContent = firstName;

  // Personalize the input placeholder.
  if (taskInput) taskInput.placeholder = `what do you need, ${firstName}?`;

  userChip.classList.remove("hidden");
}

function clearUserChip() {
  userChip?.classList.add("hidden");
  if (userName) userName.textContent = "";
  if (userAvatar) userAvatar.src = "";
  const avatarBlock = document.getElementById("userAvatarBlock");
  if (avatarBlock) avatarBlock.textContent = "?";
  if (taskInput) taskInput.placeholder = "what do you need, partner?";
}

// Preserve the button's original innerHTML (SVG + span) so we can restore
// it cleanly instead of nuking the Google icon when flipping button text.
const SIGNIN_BTN_ORIGINAL_HTML = signinBtn?.innerHTML || "";

function setSigninLabel(text) {
  if (!signinBtn) return;
  // Find the text span inside the original markup and update just that.
  const span = signinBtn.querySelector("span");
  if (span) {
    span.textContent = text;
  } else {
    signinBtn.textContent = text;
  }
}

async function handleSignIn() {
  if (signinError) signinError.textContent = "";
  if (signinBtn) {
    signinBtn.disabled = true;
    setSigninLabel("signing in…");
  }
  try {
    const token = await getGoogleIdToken({ interactive: true });
    if (!token) {
      if (signinError) signinError.textContent = "sign-in cancelled or failed. try again.";
      return;
    }
    const resp = await apiFetch(`${API_BASE}/me`);
    if (!resp.ok) {
      if (signinError) signinError.textContent = `backend rejected token (${resp.status}).`;
      await signOut();
      return;
    }
    const me = await resp.json();
    renderUserChip(me);
    hideSignIn();
    showLanding();
  } catch (err) {
    if (signinError) signinError.textContent = (err.message || "unexpected error.").toLowerCase();
  } finally {
    if (signinBtn) {
      signinBtn.disabled = false;
      // Restore original markup so the SVG icon comes back, then set label.
      if (SIGNIN_BTN_ORIGINAL_HTML) signinBtn.innerHTML = SIGNIN_BTN_ORIGINAL_HTML;
      setSigninLabel("sign in with google");
    }
  }
}

async function handleSignOut() {
  if (running) return;
  await signOut();
  clearUserChip();
  goHome();
  showSignIn();
}

async function bootstrapAuth() {
  const cached = await getCachedUser();
  if (cached) renderUserChip(cached);

  const token = await getGoogleIdToken({ interactive: false });
  if (token) {
    try {
      const resp = await apiFetch(`${API_BASE}/me`);
      if (resp.ok) {
        const me = await resp.json();
        renderUserChip(me);
        hideSignIn();
        showLanding();
        return;
      }
    } catch (_) {}
  }
  clearUserChip();
  showSignIn();
}

// ── Wire up ─────────────────────────────────────────────────
signinBtn?.addEventListener("click", handleSignIn);
signoutBtn?.addEventListener("click", handleSignOut);
homeBtn?.addEventListener("click", () => goHome());
startSessionBtn?.addEventListener("click", startSession);
playbooksBtn?.addEventListener("click", showPlaybooks);
playbooksBack?.addEventListener("click", goHome);
saveBtn?.addEventListener("click", () => savePlaybook().catch((e) => addBubble("assistant", e.message, { cls: "error" })));

sendBtn?.addEventListener("click", () => sendMessage().catch((e) => addBubble("assistant", e.message, { cls: "error" })));
taskInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage().catch((err) => addBubble("assistant", err.message, { cls: "error" }));
  }
});

stopBtn?.addEventListener("click", () => {
  if (currentAbort) currentAbort.abort();
  setRunning(false);
});

bootstrapAuth();

// ── Heartbeat watchdog ─────────────────────────────────────────
// Self-heal nudge for the two stall patterns we see in production:
//   (1) garbage-token response (output_tokens ~ 1-3, no tool calls) — model
//       reasoning is fine but token generation hiccupped. We detect this in
//       driveAgentStep and set agentStuckFlag → fast nudge after 10s.
//   (2) silent idle — agent ended with text only and is genuinely waiting.
//       Slow nudge after 45s.
// Without this, the user has to type "continue" manually to unstick the
// session. With this, the loop self-recovers.
const HEARTBEAT_TICK_MS = 5_000;
const HEARTBEAT_STUCK_MS = 10_000;  // fast: when we have a definite stuck signal
const HEARTBEAT_IDLE_MS = 45_000;   // slow: pure idleness with no other signal

// Backoff + safety rails to prevent runaway heartbeat spam on persistent
// server errors (e.g. 429 daily-cap, network flake, auth issue).
let heartbeatPausedUntil = 0;         // epoch ms; heartbeat skips firing until after this
let consecutiveHeartbeats = 0;        // resets on user message / successful real action
const MAX_CONSECUTIVE_HEARTBEATS = 3; // 3 back-to-back → pause until user intervenes

setInterval(() => {
  if (running) return;
  if (!sessionId) return;
  if (pendingApprovalBubble) return;
  if (lastAgentActivityAt == null) return;
  if (Date.now() < heartbeatPausedUntil) return;
  if (consecutiveHeartbeats >= MAX_CONSECUTIVE_HEARTBEATS) return;

  const idleMs = Date.now() - lastAgentActivityAt;
  const snap = lastSessionSnapshot;
  const hasStalledTodo =
    snap &&
    snap.status !== "ready_to_save" &&
    snap.status !== "saved" &&
    snap.status !== "completed" &&
    (snap.todos || []).some((t) => {
      const s = (t?.status || "pending").toLowerCase();
      return s !== "done" && s !== "failed" && s !== "skipped";
    });
  const stuckSignal = agentStuckFlag || lastActionFailed || hasStalledTodo;

  let shouldFire = false;
  if (stuckSignal && idleMs >= HEARTBEAT_STUCK_MS) shouldFire = true;
  else if (idleMs >= HEARTBEAT_IDLE_MS) shouldFire = true;

  if (!shouldFire) return;

  consecutiveHeartbeats += 1;
  console.log("[heartbeat] firing", {
    idleMs,
    stuckSignal,
    consecutive: consecutiveHeartbeats,
    activeTodoId: snap?.activeTodoId,
    status: snap?.status,
  });

  agentStuckFlag = false;
  lastActionFailed = false;
  lastAgentActivityAt = Date.now();

  let nudge =
    "[HEARTBEAT] You went silent. Remember: you are an agent, not a chatbot. " +
    "Resume with the next concrete tool call for the active todo. " +
    "Valid next moves: (a) the next browser action, " +
    "(b) mark_todo_done + start the next todo's first tool IN THE SAME TURN, " +
    "(c) ask_advisor if you're genuinely stuck after two distinct attempts, " +
    "(d) clarify(question, why) if there's a real fork with ≥2 options, " +
    "(e) save_playbook if all todos are done. " +
    "Do NOT reply chat-only. Do NOT ask the user what to do — they already approved the plan.";
  if (hasStalledTodo && snap?.activeTodoId) {
    const active = (snap.todos || []).find((t) => t.id === snap.activeTodoId);
    if (active) {
      nudge += ` Active todo: "${active.title || active.id}" (status=${active.status || "pending"}).`;
    }
  }

  setRunning(true);
  driveAgentStep({ user_message: nudge, action_results: [] })
    .then(() => {
      // Success path — a full agent turn completed. If that turn produced
      // actual forward progress (tool calls + no stuck flags), the streak
      // resets naturally on the next user message. Otherwise the counter
      // ticks up toward MAX_CONSECUTIVE_HEARTBEATS.
    })
    .catch((e) => {
      const msg = e?.message || String(e);
      // Hard-pause on daily-cap (429) — no point retrying the same minute.
      // Pause until midnight UTC OR 30 minutes, whichever is shorter.
      if (msg.includes("429") || msg.toLowerCase().includes("daily spend") || msg.toLowerCase().includes("cap")) {
        heartbeatPausedUntil = Date.now() + 30 * 60_000;
        addBubble("assistant",
          "Heartbeat paused (daily spend cap reached). Raise DAILY_LIMIT_FREE_USD env or wait for reset. " +
          "Nudges resume when you send your next message.",
          { cls: "error" });
      } else {
        // Generic error — exponential-ish backoff: 60s × consecutive count, capped at 10min
        const cooldownMs = Math.min(60_000 * consecutiveHeartbeats, 600_000);
        heartbeatPausedUntil = Date.now() + cooldownMs;
        addBubble("assistant",
          `Heartbeat nudge failed: ${msg}. Paused ${Math.round(cooldownMs / 1000)}s before retry.`,
          { cls: "error" });
      }
    })
    .finally(() => setRunning(false));
}, HEARTBEAT_TICK_MS);

// Reset heartbeat streak + unpause whenever the USER sends a message.
// The user typing means they're engaged; the runaway-heartbeat protection
// should yield to human input.
(function installHeartbeatResetOnUserSend() {
  const origSendMessage = window.sendMessage;
  if (typeof origSendMessage === "function") {
    window.sendMessage = async function () {
      consecutiveHeartbeats = 0;
      heartbeatPausedUntil = 0;
      return origSendMessage.apply(this, arguments);
    };
  }
  // Also reset on the bound send-button handler — sendMessage is locally
  // scoped so the window.sendMessage hook only catches if it was exposed.
  // Belt-and-braces: attach a capture-phase click on sendBtn.
  sendBtn?.addEventListener(
    "click",
    () => {
      consecutiveHeartbeats = 0;
      heartbeatPausedUntil = 0;
    },
    true,
  );
  taskInput?.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        consecutiveHeartbeats = 0;
        heartbeatPausedUntil = 0;
      }
    },
    true,
  );
})();
