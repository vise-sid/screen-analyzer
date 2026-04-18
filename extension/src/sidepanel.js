// PixelFoxx sidepanel — drives the backend agent loop, dispatches
// browser tools to the service worker (which owns playwright-crx).

import * as auth from "./auth.js";

const API_BASE = "http://localhost:8000";

const $ = (id) => document.getElementById(id);

const signinCard = $("signinCard");
const signInBtn = $("signInBtn");
const signInError = $("signInError");

const app = $("app");
const userAvatar = $("userAvatar");
const userName = $("userName");
const newSessionBtn = $("newSessionBtn");
const signOutBtn = $("signOutBtn");

const planStrip = $("planStrip");
const planList = $("planList");
const planProgress = $("planProgress");

const chatThread = $("chatThread");
const inputRow = $("inputRow");
const msgInput = $("msgInput");
const sendBtn = $("sendBtn");

let sessionId = null;
let inFlight = false;

// ── Auth-aware fetch ───────────────────────────────────────
async function apiFetch(path, init = {}) {
  const token = await auth.getGoogleIdToken({ interactive: false });
  const headers = new Headers(init.headers || {});
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Content-Type") && init.body) headers.set("Content-Type", "application/json");
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

async function postJSON(path, body) {
  const resp = await apiFetch(path, { method: "POST", body: JSON.stringify(body || {}) });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${text || resp.statusText}`);
  }
  return resp.json();
}

// ── Service-worker tool dispatch ───────────────────────────
async function executeBrowserToolViaSW(tool) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "browser_tool", tool }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "no response" });
    });
  });
}

async function executePendingBrowserTools(pending) {
  const results = [];
  for (const tool of pending) {
    addBubble("system", `→ ${tool.name}…`);
    let content;
    try { content = await executeBrowserToolViaSW(tool); }
    catch (e) { content = { ok: false, error: String(e?.message || e) }; }
    results.push({ tool_use_id: tool.tool_use_id, content });
  }
  return results;
}

// ── Rendering ──────────────────────────────────────────────
function clearChat() { chatThread.innerHTML = ""; }
function emptyState() {
  const el = document.createElement("div");
  el.className = "chat-empty";
  el.textContent = "Type a task below. I'll run it end-to-end via Playwright.";
  chatThread.appendChild(el);
}
function scrollDown() { chatThread.scrollTop = chatThread.scrollHeight; }

function addBubble(cls, text) {
  if (!text) return null;
  const el = document.createElement("div");
  el.className = `chat-bubble ${cls}`;
  el.textContent = String(text);
  chatThread.appendChild(el);
  scrollDown();
  return el;
}

function addThinking() {
  const el = document.createElement("div");
  el.className = "thinking";
  el.dataset.role = "thinking";
  el.innerHTML = "<span></span><span></span><span></span>";
  chatThread.appendChild(el);
  scrollDown();
  return el;
}
function removeThinking() {
  chatThread.querySelectorAll('[data-role="thinking"]').forEach((n) => n.remove());
}

const TAGS = {
  navigate:      { label: "NAV",  color: "#4FB3D9" },
  click:         { label: "CLK",  color: "#FF6A1A" },
  type:          { label: "IN",   color: "#FFC83D" },
  key:           { label: "KEY",  color: "#6B6357" },
  scroll:        { label: "SCR",  color: "#6B6357" },
  observe:       { label: "OBS",  color: "#4FB3D9" },
  workspace:     { label: "GOOG", color: "#4FB3D9" },
  reauth_google: { label: "AUTH", color: "#FFC83D" },
  vision:        { label: "VIS",  color: "#7FD46B" },
};

function describeAction(name, args) {
  if (name === "navigate") return `→ ${args.url || ""}`;
  if (name === "click") return `→ ${args.ref}`;
  if (name === "type") return `→ ${args.ref}: ${JSON.stringify(args.text || "").slice(0, 40)}`;
  if (name === "key") return `→ ${args.key}`;
  if (name === "scroll") return `→ deltaY=${args.deltaY}`;
  if (name === "observe") return `→ ${(args.include || ["snapshot"]).join(",")}`;
  if (name === "workspace") return `→ ${args.api || ""}`;
  if (name === "vision") return `→ ${args.task || ""}`;
  return "";
}

function addActionBubble(action) {
  const tag = TAGS[action.name] || { label: "ACT", color: "#6B6357" };
  const el = document.createElement("div");
  el.className = "action-bubble";
  el.innerHTML =
    `<span class="action-tag" style="background:${tag.color}">${tag.label}</span>` +
    `<span class="action-body"></span>`;
  el.querySelector(".action-body").textContent = `${action.name}  ${describeAction(action.name, action.args || {})}`;
  chatThread.appendChild(el);
  scrollDown();
}

function renderPlan(plan, activeStepId) {
  if (!plan?.length) { planStrip.classList.add("hidden"); return; }
  planStrip.classList.remove("hidden");
  const done = plan.filter((s) => s.status === "done").length;
  planProgress.textContent = `${done}/${plan.length}`;
  planList.innerHTML = "";
  for (const step of plan) {
    const li = document.createElement("li");
    li.className = step.status;
    if (step.id === activeStepId && step.status !== "done") li.classList.add("running");
    const marker = step.status === "done" ? "x"
                  : step.status === "failed" ? "!"
                  : step.status === "skipped" ? "-"
                  : (step.id === activeStepId ? "*" : " ");
    li.innerHTML = `<span class="marker">${marker}</span><span class="title"></span>`;
    li.querySelector(".title").textContent = step.title;
    planList.appendChild(li);
  }
}

function renderApproval(pending) {
  const scope = (pending.scope || "todo").toLowerCase();
  const card = document.createElement("div");
  card.className = `approval-card ${scope}`;
  const header = scope === "plan" ? "▶ approve plan"
              : pending.reason ? `⚠ destructive: ${pending.reason.replace(/_/g, " ")}`
              : "approve";
  card.innerHTML = `
    <div class="approval-head"></div>
    <div class="approval-preview"></div>
    <div class="approval-actions">
      <button data-act="approved" type="button">${scope === "plan" ? "approve plan, run it" : "go ahead"}</button>
      <button data-act="rejected" type="button" class="ghost">hold on…</button>
    </div>`;
  card.querySelector(".approval-head").textContent = header;
  card.querySelector(".approval-preview").textContent = pending.preview || "ready when you are.";
  card.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      card.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try { await driveStep({ approval: btn.dataset.act }); }
      catch (e) { addBubble("system", `(approval failed: ${e.message})`); }
    });
  });
  chatThread.appendChild(card);
  scrollDown();
}

function renderClarify(pending) {
  const card = document.createElement("div");
  card.className = "clarify-card";
  card.innerHTML = `
    <div class="clarify-head">❓ pick a path</div>
    <div class="clarify-q"></div>
    <div class="clarify-why"></div>
    <div class="clarify-options"></div>`;
  card.querySelector(".clarify-q").textContent = pending.question || "";
  if (pending.why) card.querySelector(".clarify-why").textContent = `why: ${pending.why}`;
  else card.querySelector(".clarify-why").remove();
  const optsEl = card.querySelector(".clarify-options");
  for (const opt of pending.options || []) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = opt;
    btn.addEventListener("click", async () => {
      card.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try { await driveStep({ clarify_choice: opt }); }
      catch (e) { addBubble("system", `(clarify failed: ${e.message})`); }
    });
    optsEl.appendChild(btn);
  }
  chatThread.appendChild(card);
  scrollDown();
}

function renderReport(report) {
  const card = document.createElement("div");
  card.className = "report-card";
  card.innerHTML = `
    <div class="report-head">✓ session complete</div>
    <div class="report-summary"></div>
    <div class="report-extras"></div>`;
  card.querySelector(".report-summary").textContent = report.summary || "";
  const extras = card.querySelector(".report-extras");

  const addSection = (title, items, formatter) => {
    if (!items?.length) return;
    const t = document.createElement("div");
    t.className = "report-section-title";
    t.textContent = title;
    extras.appendChild(t);
    const list = document.createElement("div");
    list.className = "report-list";
    for (const item of items) {
      const row = document.createElement("div");
      formatter(row, item);
      list.appendChild(row);
    }
    extras.appendChild(list);
  };

  addSection("artifacts", report.artifacts, (row, a) => {
    const label = a.kind ? `${a.kind}: ${a.name}` : a.name;
    if (a.url) {
      const link = document.createElement("a");
      link.href = a.url; link.target = "_blank"; link.rel = "noopener";
      link.textContent = label;
      row.appendChild(link);
    } else { row.textContent = label; }
  });
  addSection("surprises", report.surprises, (row, s) => { row.textContent = "• " + s; });

  if (report.next_steps_for_user) {
    const t = document.createElement("div");
    t.className = "report-section-title"; t.textContent = "next";
    extras.appendChild(t);
    const row = document.createElement("div");
    row.className = "report-list";
    row.textContent = report.next_steps_for_user;
    extras.appendChild(row);
  }

  if (report.save_playbook) {
    const wrap = document.createElement("div");
    wrap.className = "report-save";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "💾 save as playbook";
    btn.disabled = true;
    btn.title = "save endpoint not yet wired";
    wrap.appendChild(btn);
    if (report.playbook_title) {
      const t = document.createElement("div");
      t.className = "report-save-title";
      t.textContent = `suggested title: ${report.playbook_title}`;
      wrap.appendChild(t);
    }
    extras.appendChild(wrap);
  }

  chatThread.appendChild(card);
  scrollDown();
}

function renderTurnEnvelope(env) {
  for (const c of env.chats || []) addBubble("assistant", c);
  for (const a of env.actions || []) {
    if (a.kind === "programmatic") addActionBubble(a);
  }
  renderPlan(env.plan || [], env.active_step_id);
  if (env.status === "awaiting_approval" && env.pending_approval) renderApproval(env.pending_approval);
  else if (env.status === "awaiting_clarify" && env.pending_clarify) renderClarify(env.pending_clarify);
  else if (env.status === "done" && env.final_report) renderReport(env.final_report);
}

// ── Step driver ────────────────────────────────────────────
async function ensureSession() {
  if (sessionId) return sessionId;
  const env = await postJSON("/sessions");
  sessionId = env.session_id;
  return sessionId;
}

async function driveStep(payload) {
  if (inFlight) return;
  inFlight = true;
  setBusy(true);
  let thinking = addThinking();
  try {
    await ensureSession();
    let env = await postJSON(`/sessions/${sessionId}/agent/step`, payload);
    removeThinking();
    renderTurnEnvelope(env);

    let safety = 20;
    while (env.status === "awaiting_browser" && env.pending_browser_tools?.length && safety-- > 0) {
      const results = await executePendingBrowserTools(env.pending_browser_tools);
      thinking = addThinking();
      env = await postJSON(`/sessions/${sessionId}/agent/step`, { browser_results: results });
      removeThinking();
      renderTurnEnvelope(env);
    }
  } catch (e) {
    removeThinking();
    addBubble("system", `(error: ${e.message})`);
  } finally {
    thinking?.remove();
    setBusy(false);
    inFlight = false;
  }
}

function setBusy(busy) { msgInput.disabled = busy; sendBtn.disabled = busy; }

// ── Sign in/out ────────────────────────────────────────────
function showApp(user) {
  signinCard.classList.add("hidden");
  app.classList.remove("hidden");
  userName.textContent = user.name || user.email || "(signed in)";
  if (user.picture) userAvatar.src = user.picture;
  msgInput.focus();
}
function showSignIn(err) {
  app.classList.add("hidden");
  signinCard.classList.remove("hidden");
  signInBtn.disabled = false;
  signInBtn.textContent = "Sign in with Google";
  signInError.textContent = err || "";
}

async function handleSignIn() {
  signInBtn.disabled = true;
  signInBtn.textContent = "Signing in…";
  signInError.textContent = "";
  try {
    const token = await auth.getGoogleIdToken({ interactive: true });
    if (!token) throw new Error("sign-in cancelled");
    const user = await postJSON("/auth/verify", { id_token: token });
    showApp(user);
    clearChat();
    emptyState();
  } catch (e) { showSignIn(e.message); }
}

async function handleSignOut() {
  await auth.signOut();
  sessionId = null;
  clearChat();
  showSignIn("");
}

function startNewSession() {
  sessionId = null;
  clearChat();
  emptyState();
  planStrip.classList.add("hidden");
  msgInput.focus();
}

// ── Boot ───────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  signInBtn.addEventListener("click", handleSignIn);
  signOutBtn.addEventListener("click", handleSignOut);
  newSessionBtn.addEventListener("click", startNewSession);

  inputRow.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if (!text) return;
    msgInput.value = "";
    addBubble("user", text);
    await driveStep({ user_message: text });
  });

  const cached = await auth.getCachedUser();
  if (cached) {
    showApp(cached);
    emptyState();
    try {
      const token = await auth.getGoogleIdToken({ interactive: false });
      if (token) await postJSON("/auth/verify", { id_token: token });
    } catch (e) { console.warn("[boot] silent revalidate failed:", e.message); }
  } else {
    showSignIn("");
  }
});
