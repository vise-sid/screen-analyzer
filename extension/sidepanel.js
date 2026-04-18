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

const approvalCard = document.getElementById("approvalCard");
const approvalSub = document.getElementById("approvalSub");
const approveBtn = document.getElementById("approveBtn");
const rejectBtn = document.getElementById("rejectBtn");

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
  chatThread.innerHTML = "";
  setTodoPlan({ todos: [] }, null);
  hideApproval();
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
  el.textContent = "thinking";
  chatThread.appendChild(el);
  chatThread.scrollTop = chatThread.scrollHeight;
  return el;
}

function removeThinking() {
  chatThread.querySelectorAll('[data-role="thinking"]').forEach((n) => n.remove());
}

function addActionBubble(actionName, args) {
  const summary = describeAction(actionName, args);
  return addBubble("assistant", summary, { cls: "action" });
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
function showApproval(todoId, description) {
  approvalCard?.classList.remove("hidden");
  approvalSub.textContent = description || "Next step is ready.";
  approveBtn.dataset.todoId = todoId || "";
}

function hideApproval() {
  approvalCard?.classList.add("hidden");
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
}

// ── Session lifecycle ───────────────────────────────────────
async function createNewSession(initialMessage) {
  const resp = await apiFetch(`${API_BASE}/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: initialMessage || "" }),
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

const PIXEL_FOXX_GREETING =
  "Hey there, partner. Pixel Foxx at your service — paws on the keyboard, ready to work. What are we building today?";

async function startSession() {
  if (running) return;
  showChat();
  setTodoPlan({ todos: [] }, null);
  hideApproval();
  hideSaveBanner();
  chatThread.innerHTML = "";
  renderedMessageIds = new Set();

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
    addBubble("assistant", PIXEL_FOXX_GREETING);
  } catch (err) {
    addBubble("assistant", `Couldn't start a session: ${err.message}`, { cls: "error" });
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
      addBubble("assistant", `Couldn't start a session: ${err.message}`, { cls: "error" });
    } finally {
      setRunning(false);
    }
    return;
  }

  addBubble("user", text);
  setRunning(true);
  try {
    hideApproval();
    await driveAgentStep({ user_message: text, action_results: [] });
  } catch (err) {
    addBubble("assistant", `${err.message}`, { cls: "error" });
  } finally {
    setRunning(false);
  }
}

async function approveCurrentTodo() {
  if (running) return;
  const todoId = approveBtn.dataset.todoId || "";
  hideApproval();
  setRunning(true);
  try {
    const note = todoId
      ? `Approved. Go ahead with todo ${todoId}.`
      : "Approved. Go ahead.";
    addBubble("user", "Go ahead");
    await driveAgentStep({ user_message: note, action_results: [] });
  } catch (err) {
    addBubble("assistant", err.message, { cls: "error" });
  } finally {
    setRunning(false);
  }
}

async function rejectCurrentTodo() {
  if (running) return;
  hideApproval();
  setRunning(true);
  try {
    addBubble("user", "Hold on");
    await driveAgentStep({
      user_message: "Hold on — don't run that yet. Reconsider or ask me.",
      action_results: [],
    });
  } catch (err) {
    addBubble("assistant", err.message, { cls: "error" });
  } finally {
    setRunning(false);
  }
}

// ── Main agent-step driver ──────────────────────────────────
async function driveAgentStep(firstPayload) {
  let payload = firstPayload;
  for (let iter = 0; iter < MAX_ACTION_ITERATIONS; iter++) {
    const thinking = addThinking();
    let result;
    try {
      result = await postAgentStep(payload);
    } finally {
      thinking.remove();
    }

    renderMessages(result.messages || []);
    setTodoPlan(result.session.todo_plan, result.session.active_todo_id);

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
        "Next step is ready.";
      showApproval(result.approval_todo_id, previewText);
      return;
    }

    const pending = result.pending_actions || [];
    if (!pending.length) {
      // Agent emitted text only — turn is done.
      return;
    }

    // Execute each browser action the agent asked for.
    const action_results = [];
    for (const pa of pending) {
      addActionBubble(pa.name, pa.args || {});
      try {
        const response = await handlePendingAction(pa.name, pa.args || {});
        action_results.push({ call_id: pa.call_id, name: pa.name, response });
      } catch (err) {
        console.error(`action ${pa.name} failed`, err);
        action_results.push({
          call_id: pa.call_id,
          name: pa.name,
          response: { ok: false, error: err.message || String(err) },
        });
      }
    }
    payload = { user_message: null, action_results };
  }
  addBubble("assistant", "(hit the step cap — taking a breath.)", { cls: "system" });
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
    return snapshotResponse(state, { ok: true, purpose: "probe_site" });
  }
  if (name === "screenshot") {
    const state = await captureState(true);
    return snapshotResponse(state, { ok: true, purpose: "screenshot" });
  }
  if (name === "ensure_session") {
    const state = await captureState(false);
    const authState = guessAuthState(state);
    return snapshotResponse(state, { ok: true, auth_state: authState });
  }
  if (name === "verify") {
    const state = await captureState(false);
    const expected = (args.expected_text || args.expected || "").toLowerCase();
    const flat = flattenElements(state.elements).toLowerCase();
    const present = !!expected && flat.includes(expected);
    return snapshotResponse(state, { ok: present, expected, present });
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

function snapshotResponse(state, extras = {}) {
  const tab = state?.screenshot || {};
  const elementsCount = Array.isArray(state?.elements) ? state.elements.length : 0;
  const url = state?.url || "";
  const title = state?.title || "";
  // Avoid shipping the element list back to the backend — it'd balloon the
  // Gemini conversation. Just describe the result.
  return {
    ...extras,
    url: url,
    title: title,
    element_count: elementsCount,
    popup: state?.popup ? truthy(state.popup) : null,
    captcha: state?.captcha ? truthy(state.captcha) : null,
    dialog: state?.dialog || null,
    tab_id: tab.tabId || null,
    page_loading: !!state?.pageLoading,
  };
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
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      break;
    } catch (e) {
      if (attempt < 2) await sleep(300); else throw e;
    }
  }
  return {
    base64: dataUrl ? dataUrl.split(",")[1] : null,
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
    addBubble("assistant", `Save failed: ${t}`, { cls: "error" });
    return;
  }
  const data = await resp.json();
  hideSaveBanner();
  addBubble("assistant", `💾 Saved as "${data.playbook.title}".`, { cls: "system" });
}

async function loadPlaybooks() {
  playbooksList.innerHTML = '<div class="playbooks-empty">Loading…</div>';
  const resp = await apiFetch(`${API_BASE}/playbooks`);
  if (!resp.ok) {
    playbooksList.innerHTML = `<div class="playbooks-empty">Couldn't load (${resp.status}).</div>`;
    return;
  }
  const records = await resp.json();
  playbooksList.innerHTML = "";
  if (!records.length) {
    playbooksList.innerHTML = '<div class="playbooks-empty">No saved playbooks yet.</div>';
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
    card.addEventListener("click", () => openPlaybook(pb));
    playbooksList.appendChild(card);
  }
}

function openPlaybook(pb) {
  goHome();
  showChat();
  addBubble("assistant", `Loaded playbook: ${pb.title}`, { cls: "system" });
  const md = pb.markdown_render || "";
  if (md) addBubble("assistant", md);
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
  if (userAvatar) {
    if (user.picture) {
      userAvatar.src = user.picture;
      userAvatar.classList.remove("hidden");
    } else {
      userAvatar.classList.add("hidden");
    }
  }
  if (userName) userName.textContent = user.name || user.email || "Signed in";
  userChip.classList.remove("hidden");
}

function clearUserChip() {
  userChip?.classList.add("hidden");
  if (userName) userName.textContent = "";
  if (userAvatar) userAvatar.src = "";
}

async function handleSignIn() {
  if (signinError) signinError.textContent = "";
  if (signinBtn) {
    signinBtn.disabled = true;
    signinBtn.textContent = "Signing in…";
  }
  try {
    const token = await getGoogleIdToken({ interactive: true });
    if (!token) {
      if (signinError) signinError.textContent = "Sign-in cancelled or failed. Try again.";
      return;
    }
    const resp = await apiFetch(`${API_BASE}/me`);
    if (!resp.ok) {
      if (signinError) signinError.textContent = `Backend rejected token (${resp.status}).`;
      await signOut();
      return;
    }
    const me = await resp.json();
    renderUserChip(me);
    hideSignIn();
    showLanding();
  } catch (err) {
    if (signinError) signinError.textContent = err.message || "Unexpected error.";
  } finally {
    if (signinBtn) {
      signinBtn.disabled = false;
      signinBtn.textContent = "Sign in with Google";
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
approveBtn?.addEventListener("click", approveCurrentTodo);
rejectBtn?.addEventListener("click", rejectCurrentTodo);
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
