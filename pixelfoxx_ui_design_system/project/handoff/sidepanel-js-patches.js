// PixelFoxx — sidepanel.js patches (v2.0 design system)
// These are the ONLY 3 changes needed in sidepanel.js.
// Find each section by the comment label and apply the diff.
// ─────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════
// PATCH 1 — addThinking()
// Find this function and replace it entirely.
// ══════════════════════════════════════════════════════════

// BEFORE:
function addThinking_OLD() {
  const el = document.createElement("div");
  el.className = "chat-bubble thinking";
  el.dataset.role = "thinking";
  el.textContent = "thinking";
  chatThread.appendChild(el);
  chatThread.scrollTop = chatThread.scrollHeight;
  return el;
}

// AFTER — replace with:
function addThinking() {
  const el = document.createElement("div");
  el.className = "chat-bubble thinking";
  el.dataset.role = "thinking";
  el.innerHTML = `
    <div class="foxx-thinking-dot" style="animation-delay:0ms"></div>
    <div class="foxx-thinking-dot" style="animation-delay:160ms"></div>
    <div class="foxx-thinking-dot" style="animation-delay:320ms"></div>
  `;
  chatThread.appendChild(el);
  chatThread.scrollTop = chatThread.scrollHeight;
  return el;
}


// ══════════════════════════════════════════════════════════
// PATCH 2 — addActionBubble() + new getActionTag() helper
// Find addActionBubble() and replace it. Add getActionTag below it.
// ══════════════════════════════════════════════════════════

// BEFORE:
function addActionBubble_OLD(actionName, args) {
  const summary = describeAction(actionName, args);
  return addBubble("assistant", summary, { cls: "action" });
}

// AFTER — replace addActionBubble with:
function addActionBubble(actionName, args) {
  const summary = describeAction(actionName, args);
  const tag = getActionTag(actionName);
  const el = document.createElement("div");
  el.className = "chat-bubble action";
  el.innerHTML = `
    <span class="action-tag" style="background:${tag.color}">${tag.label}</span>
    <span class="action-body">${escapeHtml(summary)}</span>
  `;
  chatThread.appendChild(el);
  chatThread.scrollTop = chatThread.scrollHeight;
  return el;
}

// ADD this new helper right after addActionBubble:
function getActionTag(name) {
  const n = (name || "").toLowerCase();
  if (n === "navigate" || n === "probe_site")                    return { label: "NAV",  color: "#4FB3D9" };
  if (n.startsWith("click") || n === "dismiss_popup")           return { label: "CLK",  color: "#FF6A1A" };
  if (n === "focus_and_type" || n === "type")                   return { label: "IN",   color: "#FFC83D" };
  if (n.startsWith("scrape") || n.startsWith("extract"))        return { label: "SCRP", color: "#FFC83D" };
  if (n === "verify")                                            return { label: "VFY",  color: "#7FD46B" };
  if (n === "wait")                                              return { label: "WAIT", color: "#4A4338" };
  if (n.startsWith("key"))                                       return { label: "KEY",  color: "#6B6357" };
  if (n === "scroll")                                            return { label: "SCR",  color: "#6B6357" };
  if (n.includes("tab"))                                         return { label: "TAB",  color: "#4FB3D9" };
  if (n.startsWith("sheets") || n.startsWith("docs") ||
      n.startsWith("slides") || n === "fill_cells")             return { label: "GOOG", color: "#4FB3D9" };
  if (n === "screenshot")                                        return { label: "CAP",  color: "#6B6357" };
  if (n === "back" || n === "forward")                          return { label: "NAV",  color: "#4FB3D9" };
  if (n === "stealth_solve" || n === "click_captcha")           return { label: "BOT",  color: "#FF5A4E" };
  return { label: "ACT", color: "#6B6357" };
}

// ADD this utility if not already present:
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


// ══════════════════════════════════════════════════════════
// PATCH 3 — User avatar initials
// Find where user data is set after sign-in (in auth.js callback
// or wherever userName.textContent = user.displayName is set)
// and add the initials logic after it.
// ══════════════════════════════════════════════════════════

// In sidepanel.js, find the block where user info is applied to the DOM.
// It will look something like:
//   userAvatar.src = user.photoURL || "";
//   userName.textContent = user.displayName || user.email || "";
//   userChip.classList.remove("hidden");

// ADD after that block:
function setUserIdentity(user) {
  // Set avatar image (Google photo)
  if (userAvatar && user.photoURL) {
    userAvatar.src = user.photoURL;
  }
  // Set initials block (shown as fallback or alongside)
  const avatarBlock = document.getElementById("userAvatarBlock");
  if (avatarBlock) {
    const parts = (user.displayName || user.email || "").trim().split(/\s+/);
    const initials = ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase();
    avatarBlock.textContent = initials || "?";
  }
  // First name for input placeholder
  const firstName = (user.displayName || "").split(" ")[0] || "partner";
  const input = document.getElementById("taskInput");
  if (input) input.placeholder = `what do you need, ${firstName.toLowerCase()}?`;
  // Username display
  if (userName) userName.textContent = firstName;
}

// Call setUserIdentity(user) wherever the existing sign-in callback
// currently sets userName.textContent and userAvatar.src.


// ══════════════════════════════════════════════════════════
// PATCH 4 — Copy / voice lowercase fixes
// Find and replace these string literals anywhere in sidepanel.js:
// ══════════════════════════════════════════════════════════

// "Go ahead"           → "go ahead"
// "Hold on…"           → "hold on…"
// "✓ Approved"         → "✓ approved"
// "✗ Held"             → "✗ held"
// "Playbook-worthy. Save it?"  → "playbook-worthy. save it?"
// "No saved playbooks yet."    → "no saved playbooks yet."
// "What do you need, boss?"    → handled via setUserIdentity above


// ══════════════════════════════════════════════════════════
// PATCH 5 (optional but nice) — Session divider on chat start
// In createNewSession() or showChat(), after clearing chatThread,
// inject a session divider:
// ══════════════════════════════════════════════════════════

function addSessionDivider() {
  const now = new Date();
  const time = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const el = document.createElement("div");
  el.className = "session-divider";
  el.innerHTML = `
    <div class="session-divider-line"></div>
    <div class="session-divider-label">SESSION STARTED · ${time}</div>
    <div class="session-divider-line"></div>
  `;
  chatThread.appendChild(el);
}

// Call addSessionDivider() at the start of createNewSession(),
// right after chatThread.innerHTML = "" or after showChat() is called.
