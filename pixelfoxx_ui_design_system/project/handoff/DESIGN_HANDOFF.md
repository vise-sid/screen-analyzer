# PixelFoxx — UI Design Handoff
## For Claude Code · Vanilla JS Chrome Extension

This document is the complete spec to restyle `extension/sidepanel.html` + `extension/sidepanel.css` to match the PixelFoxx design system. **Do not touch `sidepanel.js`, `auth.js`, `actions.js`, `tabs.js`, or `cookies.js`.** All logic stays as-is — this is a pure visual restyle.

---

## 1. FONTS — replace Poppins

Add to the `<head>` of `sidepanel.html`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Silkscreen:wght@400;700&display=swap" rel="stylesheet" />
```

| Role | Family | Use |
|------|--------|-----|
| UI body | `Space Grotesk` | All prose, labels, inputs |
| Pixel headers | `Silkscreen` | Logo, section titles, big numbers |
| Mono / meta | `JetBrains Mono` | Timestamps, chips, action tags, logs |

---

## 2. TOKENS — replace `:root` variables

```css
:root {
  /* Surfaces — warm black */
  --bg:        #14110E;
  --surface:   #1C1916;
  --surface-2: #231F1A;
  --surface-3: #2A2520;
  --line:      #3A352D;
  --line-2:    #4A4338;

  /* Text — warm off-white */
  --text:      #F4EFE6;
  --text-dim:  #A89E8D;
  --text-mute: #6B6357;

  /* Brand — lifted from the mascot */
  --orange:    #FF6A1A;
  --orange-dk: #CC4D00;
  --yellow:    #FFC83D;
  --blue:      #4FB3D9;

  /* Semantic */
  --ok:        #7FD46B;
  --warn:      #FFC83D;
  --err:       #FF5A4E;

  /* Pixel corners clip-path */
  --px-corners: polygon(0 3px,3px 3px,3px 0,calc(100% - 3px) 0,calc(100% - 3px) 3px,100% 3px,100% calc(100% - 3px),calc(100% - 3px) calc(100% - 3px),calc(100% - 3px) 100%,3px 100%,3px calc(100% - 3px),0 calc(100% - 3px));
}
```

---

## 3. PIXEL CORNERS RULE

**No `border-radius` anywhere.** All cards, buttons, chips, modals use:

```css
clip-path: var(--px-corners);
```

---

## 4. DITHER BACKGROUND

The body and panel background uses a subtle pixel dither overlay:

```css
body {
  background: var(--bg);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Crect x='0' y='0' width='1' height='1' fill='%23ffffff' opacity='0.015'/%3E%3Crect x='2' y='2' width='1' height='1' fill='%23ffffff' opacity='0.015'/%3E%3C/svg%3E");
}
```

---

## 5. COMPONENT SPECS

### 5.1 Header

**Current:** Gradient bg + 2px orange bottom border + Poppins logo + icon buttons with border-radius.

**New:**
```
- bg: var(--surface)
- border-bottom: 1px solid var(--line)
- NO gradient
- Logo: font-family Silkscreen, 13px — "PIXEL" in var(--text), "FOXX" in var(--orange)
- User avatar: 22×22 square (no border-radius), bg var(--blue), initials in Mono 9px bold
  - Show first 2 initials from user's display name
- Settings/home icon buttons: 28×28, no border, no border-radius, transparent bg
```

HTML update needed for user chip — replace the `<img>` avatar with an initials block:
```html
<div id="userAvatarBlock" class="user-avatar-initials"></div>
```
In JS, after sign-in, set: `userAvatarBlock.textContent = initials` (first 2 chars of name).

---

### 5.2 Sign-in Screen

**New spec:**
```
- Full panel bg: var(--bg) + dither
- Center card: no border-radius → clip-path var(--px-corners)
  bg: var(--surface), border: 1px solid var(--line)
- Logo: Silkscreen 22px "PIXELFOXX" (FOXX in orange)
- Sub: Space Grotesk 12px var(--text-dim), italic, lowercase
  → "sign in, and we're partners. google sign-in is all i need."
- Google button:
  bg: var(--surface-2), border: 1px solid var(--line-2)
  clip-path: var(--px-corners)
  hover: border-color var(--orange)
  text: Space Grotesk 12.5px var(--text)
```

---

### 5.3 Landing View

**New spec:**
```
- Foxx mascot image (icons/icon128.png): 96px, pixelated rendering
- Title: Silkscreen 13px "WHAT ARE WE GETTING INTO TODAY?"
  → Lowercase copywrite: Space Grotesk 12px var(--text-dim)
  → "start a session or run a saved playbook."
- Buttons: full-width, stacked
  Primary (Start Session):
    bg: var(--orange), color: #14110E
    clip-path: var(--px-corners)
    font: Space Grotesk 12.5px 600
    padding: 12px 16px
  Secondary (My Playbooks):
    bg: transparent, border: 1px solid var(--line-2)
    color: var(--text-dim)
    clip-path: var(--px-corners)
    hover: border-color var(--orange), color var(--text)
```

---

### 5.4 Chat Bubbles

#### User bubble
```css
.chat-bubble.user {
  align-self: flex-end;
  max-width: 80%;
  background: var(--orange);
  color: #14110E;
  font-size: 12.5px;
  line-height: 1.45;
  padding: 8px 11px;
  clip-path: var(--px-corners);
  border-radius: 0;
}
```

#### Assistant / Foxx bubble
```css
.chat-bubble.assistant {
  align-self: flex-start;
  max-width: 82%;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--line);
  font-size: 12.5px;
  line-height: 1.5;
  padding: 9px 11px;
  clip-path: var(--px-corners);
  border-radius: 0;
}
/* Add "FOXX >" label above bubble text */
.chat-bubble.assistant::before {
  content: "FOXX >";
  display: block;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: var(--orange);
  letter-spacing: 0.4px;
  margin-bottom: 4px;
}
```

#### Action bubble (tool call)
```css
.chat-bubble.action {
  align-self: flex-start;
  background: var(--surface);
  border: 1px solid var(--line);
  clip-path: var(--px-corners);
  padding: 7px 10px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 90%;
  border-radius: 0;
}
/* Tag chip before text — derive from action name prefix */
/* → navigate  → blue chip "NAV"
   → click     → orange chip "CLK"
   → type      → yellow chip "IN"
   → scrape_*  → yellow chip "SCRP"
   → verify    → green chip "VFY"
   → wait      → muted chip "WAIT"
   → default   → muted chip "ACT" */
```

Action tag chip colors:
| Prefix | Label | Color |
|--------|-------|-------|
| navigate | NAV | var(--blue) |
| click* | CLK | var(--orange) |
| type / focus_and_type | IN | var(--yellow) |
| scrape_* / extract_* | SCRP | var(--yellow) |
| verify | VFY | var(--ok) |
| wait | WAIT | var(--text-mute) |
| key* | KEY | var(--text-dim) |
| scroll | SCR | var(--text-dim) |
| *_tab | TAB | var(--blue) |
| default | ACT | var(--text-dim) |

Add a tag chip before the action text:
```html
<span class="action-tag" style="background: {color}; color: #14110E; font-size: 8.5px; font-weight: 700; padding: 2px 5px; font-family: JetBrains Mono;">{LABEL}</span>
<span class="action-body">{text}</span>
```
Modify `addActionBubble()` in `sidepanel.js` to inject the chip span.

#### Thinking bubble
```css
.chat-bubble.thinking {
  display: flex;
  gap: 5px;
  align-items: center;
  padding: 11px 14px;
  background: var(--surface);
  border: 1px solid var(--line);
  clip-path: var(--px-corners);
  /* Replace text with three pulsing squares: */
}
```
In `addThinking()` in sidepanel.js, replace `el.textContent = "thinking"` with:
```js
el.innerHTML = `
  <div class="foxx-thinking-dot" style="animation-delay:0ms"></div>
  <div class="foxx-thinking-dot" style="animation-delay:160ms"></div>
  <div class="foxx-thinking-dot" style="animation-delay:320ms"></div>
`;
```
CSS:
```css
.foxx-thinking-dot {
  width: 6px; height: 6px;
  background: var(--orange);
  animation: fxPulse 1.2s ease-in-out infinite;
}
@keyframes fxPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
```

#### System bubble
```css
.chat-bubble.system {
  align-self: center;
  background: transparent;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: var(--text-mute);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  border: none;
  padding: 4px 0;
}
```

#### Error bubble
```css
.chat-bubble.error {
  border-left: 3px solid var(--err);
  background: var(--surface);
  border-color: var(--err);
  color: var(--err);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  clip-path: none; /* left border needs real border */
  border-left: 3px solid var(--err);
  border-top: 1px solid var(--line);
  border-right: 1px solid var(--line);
  border-bottom: 1px solid var(--line);
}
```

#### Approval bubble
```css
.chat-bubble.approval {
  background: rgba(255,200,61,0.08);
  border: 1px solid var(--yellow);
  clip-path: var(--px-corners);
  padding: 11px 12px;
}
.approval-text { font-size: 12.5px; color: var(--text); margin-bottom: 10px; }
.approval-actions { display: flex; gap: 6px; }
.chat-approve {
  padding: 7px 14px;
  background: var(--orange); color: #14110E;
  font-family: 'Space Grotesk', sans-serif; font-size: 11.5px; font-weight: 600;
  border: none; clip-path: var(--px-corners); cursor: pointer;
}
.chat-reject {
  padding: 7px 14px;
  background: transparent; color: var(--text-dim);
  border: 1px solid var(--line-2);
  font-family: 'Space Grotesk', sans-serif; font-size: 11.5px;
  clip-path: var(--px-corners); cursor: pointer;
}
.approval-resolved { font-family: 'JetBrains Mono', monospace; font-size: 10px; margin-top: 8px; letter-spacing: 0.3px; }
.approval-resolved.approved { color: var(--ok); }
.approval-resolved.rejected { color: var(--err); }
```

---

### 5.5 Todo Strip (Plan)

**New spec:**
```
bg: var(--surface-2)
border-bottom: 1px solid var(--line)
no border-radius
```

Header row:
```css
.todo-strip-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 7px 14px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px; color: var(--text-mute);
  letter-spacing: 0.5px; text-transform: uppercase;
}
.todo-strip-count { color: var(--orange); }
```

Todo items:
```css
.todo-strip-list li {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 14px;
  font-size: 11.5px; color: var(--text-dim);
  border-top: 1px solid var(--line);
}
.todo-strip-list li.done .todo-marker { color: var(--ok); }
.todo-strip-list li.running .todo-marker { color: var(--orange); }
.todo-strip-list li.running { color: var(--text); background: rgba(255,106,26,0.06); }
.todo-strip-list li.failed .todo-marker { color: var(--err); }
.todo-marker { font-family: 'JetBrains Mono', monospace; font-size: 10px; width: 12px; flex-shrink: 0; }
```

---

### 5.6 Footer / Input Row

```css
.footer {
  border-top: 1px solid var(--line);
  background: var(--surface);
  padding: 10px 12px 8px;
}
.input-row {
  display: flex; gap: 6px; align-items: center;
}
.task-input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--line-2);
  color: var(--text);
  font-family: 'Space Grotesk', sans-serif;
  font-size: 12.5px;
  padding: 9px 12px;
  outline: none;
  clip-path: var(--px-corners);
  border-radius: 0;
}
.task-input::placeholder { color: var(--text-mute); font-style: italic; }
.task-input:focus { border-color: var(--orange); }

.send-btn {
  width: 34px; height: 34px;
  background: var(--orange); color: #14110E;
  border: none; cursor: pointer;
  clip-path: var(--px-corners);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.send-btn:hover { background: var(--orange-dk); }
.stop-btn {
  width: 34px; height: 34px;
  background: var(--err); color: #14110E;
  border: none; cursor: pointer;
  clip-path: var(--px-corners);
  display: flex; align-items: center; justify-content: center;
}
.footer-note {
  font-family: 'JetBrains Mono', monospace;
  font-size: 8.5px; color: var(--line-2);
  text-align: center; margin-top: 6px; letter-spacing: 0.4px;
}
```

---

### 5.7 Save Banner

```css
.save-banner {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px;
  background: rgba(127,212,107,0.1);
  border-top: 1px solid var(--ok);
  border-bottom: 1px solid var(--ok);
}
.save-text {
  font-size: 11.5px; color: var(--ok); font-style: italic;
  font-family: 'Space Grotesk', sans-serif;
}
.save-btn {
  padding: 6px 14px;
  background: var(--ok); color: #14110E;
  font-family: 'Space Grotesk', sans-serif; font-size: 11px; font-weight: 600;
  border: none; clip-path: var(--px-corners); cursor: pointer;
}
```

---

### 5.8 Playbooks View

```css
.playbooks-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.playbooks-header h2 {
  font-family: 'Silkscreen', monospace;
  font-size: 11px; letter-spacing: 0.5px; color: var(--text);
}
.link-btn {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px; color: var(--text-mute);
  background: none; border: none; cursor: pointer;
  letter-spacing: 0.3px;
}
.link-btn:hover { color: var(--orange); }

/* Each playbook card in the list */
.playbook-card {
  padding: 11px 14px;
  border-bottom: 1px solid var(--line);
  border-left: 3px solid var(--orange);
  background: var(--surface);
  cursor: pointer;
}
.playbook-card:hover { background: var(--surface-2); }
.playbook-card-name {
  font-size: 12.5px; font-weight: 600; color: var(--text); margin-bottom: 3px;
}
.playbook-card-meta {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px; color: var(--text-mute); letter-spacing: 0.3px;
}
.playbooks-empty {
  padding: 32px 14px; text-align: center;
  font-size: 12px; color: var(--text-mute); font-style: italic;
}
```

For `playbooksList`, when rendering playbook items in `sidepanel.js`, update the DOM structure to use `.playbook-card`, `.playbook-card-name`, `.playbook-card-meta` classes.

---

### 5.9 Session Divider

Add this between sessions in the chat thread. Update `sidepanel.js` to inject dividers when a session starts:
```html
<div class="session-divider">
  <div class="session-divider-line"></div>
  <div class="session-divider-label">SESSION STARTED · 14:01</div>
  <div class="session-divider-line"></div>
</div>
```
```css
.session-divider {
  display: flex; align-items: center; gap: 10px;
  margin: 12px 0; padding: 0 14px;
}
.session-divider-line { flex: 1; height: 1px; background: var(--line); }
.session-divider-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px; color: var(--text-mute); letter-spacing: 0.6px;
}
```

---

## 6. SCROLLBARS

```css
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--line); }
```

---

## 7. VOICE RULES — update copy in sidepanel.js

| Current | New |
|---------|-----|
| `"thinking"` (thinking bubble) | Remove — replaced with 3 pulsing squares |
| `"What do you need, boss?"` (input placeholder) | `"what do you need, anna?"` (use signed-in first name) |
| `"What are we getting into today?"` (landing title) | Keep but set in Silkscreen via CSS |
| `"Playbook-worthy. Save it?"` | `"playbook-worthy. save it?"` (lowercase) |
| `"No saved playbooks yet."` | `"no saved playbooks yet."` (lowercase) |
| `"Go ahead"` / `"Hold on…"` | `"go ahead"` / `"hold on…"` (lowercase) |
| `"✓ Approved"` / `"✗ Held"` | `"✓ approved"` / `"✗ held"` |

---

## 8. JS TWEAKS (minimal, targeted)

Only three JS changes needed:

**8.1 Thinking bubble** — in `addThinking()`, replace textContent with dots HTML (see 5.4 above).

**8.2 Action bubble chip** — in `addActionBubble()`, wrap the text in a chip + body span:
```js
function addActionBubble(actionName, args) {
  const summary = describeAction(actionName, args);
  const tag = getActionTag(actionName); // new helper — see table in 5.4
  const el = document.createElement("div");
  el.className = "chat-bubble action";
  el.innerHTML = `<span class="action-tag" style="background:${tag.color};color:#14110E;font-family:'JetBrains Mono',monospace;font-size:8.5px;font-weight:700;padding:2px 5px;flex-shrink:0;">${tag.label}</span><span class="action-body">${summary}</span>`;
  chatThread.appendChild(el);
  chatThread.scrollTop = chatThread.scrollHeight;
  return el;
}
```

**8.3 User avatar initials** — after sign-in resolves and `userName.textContent = user.displayName`:
```js
// Generate 2-char initials from display name
const parts = (user.displayName || '').trim().split(' ');
const initials = (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
userAvatarBlock.textContent = initials.toUpperCase();
```

---

## 9. FILES TO EDIT

| File | Action |
|------|--------|
| `extension/sidepanel.css` | **Full replacement** — use this spec |
| `extension/sidepanel.html` | Add font imports, swap avatar img for initials div, add session-divider markup |
| `extension/sidepanel.js` | 3 targeted changes: thinking dots, action chip, initials |

**Do NOT touch:** `auth.js`, `actions.js`, `background.js`, `cookies.js`, `tabs.js`, `manifest.json`

---

## 10. REFERENCE FILES

The full visual design is in the companion project. Key reference files:
- `tokens.jsx` — all FX tokens with exact values
- `primitives.jsx` — PixelButton, Chip, Mascot, Icon, PixelProgress component code
- `side-panel.jsx` — the reference side panel implementation (React, but read for layout/class patterns)
- `tier1-screens.jsx` — Settings, Permissions, Error states

The mascot image referenced in the design (`assets/pixelfoxx.jpg`) should be placed at `extension/icons/pixelfoxx.jpg` for use as the landing page hero. The existing `icon128.png` can stay as the favicon/extension icon.
