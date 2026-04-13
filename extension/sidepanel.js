const API_BASE = "http://localhost:8000";
const MAX_STEPS = 50;

const taskInput = document.getElementById("taskInput");
const sendBtn = document.getElementById("sendBtn");
const stopBtn = document.getElementById("stopBtn");
const newChatBtn = document.getElementById("newChatBtn");
const logArea = document.getElementById("logArea");
const placeholder = document.getElementById("placeholder");

let sessionId = null;
let running = false;

// ── UI Helpers ──────────────────────────────────────────────

function addLog(html, className) {
  const div = document.createElement("div");
  div.className = `log-entry ${className}`;
  div.innerHTML = html;
  logArea.appendChild(div);
  logArea.scrollTop = logArea.scrollHeight;
  return div;
}

function addThought(result) {
  // Display structured eval/memory/goal or fall back to thought string
  const parts = [];
  if (result.eval && result.eval !== "start") {
    parts.push(`<div class="thought-section"><span class="thought-tag eval-tag">Eval</span> ${escapeHtml(result.eval)}</div>`);
  }
  if (result.memory) {
    parts.push(`<div class="thought-section"><span class="thought-tag memory-tag">Memory</span> ${escapeHtml(result.memory)}</div>`);
  }
  if (result.goal) {
    parts.push(`<div class="thought-section"><span class="thought-tag goal-tag">Goal</span> ${escapeHtml(result.goal)}</div>`);
  }
  // Fallback for old "thought" field
  if (parts.length === 0 && result.thought) {
    parts.push(`<div>${escapeHtml(result.thought)}</div>`);
  }

  if (parts.length > 0) {
    addLog(
      `<div class="thought-label">Thinking</div>${parts.join("")}`,
      "log-thought"
    );
  }
}

function addAction(action) {
  const icons = {
    click: "\u{1F5B1}",
    double_click: "\u{1F5B1}",
    hover: "\u{1F4A8}",
    focus_and_type: "\u2328\uFE0F",
    type: "\u2328\uFE0F",
    clear_and_type: "\u2328\uFE0F",
    key: "\u2387",
    select: "\u{1F4CB}",
    scroll: "\u2195",
    navigate: "\u{1F310}",
    back: "\u2B05",
    forward: "\u27A1",
    extract_text: "\u{1F4D6}",
    new_tab: "\u{1F4C4}",
    switch_tab: "\u{1F500}",
    close_tab: "\u274C",
    click_captcha: "\u{1F916}",
    dismiss_popup: "\u{1F6AB}",
    accept_dialog: "\u2705",
    dismiss_dialog: "\u274C",
    ask_user: "\u{1F64B}",
    wait: "\u23F3",
    done: "\u2705",
  };
  const icon = icons[action.type] || "\u25B6";
  const detail = formatAction(action);
  addLog(
    `<span class="action-icon">${icon}</span> <span>${escapeHtml(detail)}</span>`,
    "log-action"
  );
}

function addDone(summary) {
  addLog(
    `<div class="done-label">Done</div><div>${escapeHtml(summary)}</div>`,
    "log-done"
  );
}

function addError(msg) {
  addLog(escapeHtml(msg), "log-error");
}

function addLoading() {
  return addLog(
    `<div class="dot-pulse"><span></span><span></span><span></span></div> <span>Analyzing screen...</span>`,
    "log-loading"
  );
}

function formatAction(action) {
  const refStr = (a) =>
    a.ref !== undefined ? `[ref=${a.ref}]` : `(${a.x}, ${a.y})`;

  switch (action.type) {
    case "click":
      return `Click ${refStr(action)}`;
    case "double_click":
      return `Double-click ${refStr(action)}`;
    case "hover":
      return `Hover ${refStr(action)}`;
    case "focus_and_type":
      return `Type "${action.text}" into ${refStr(action)}${action.clear ? " (replace)" : ""}`;
    case "type":
      return `Type "${action.text}"`;
    case "clear_and_type":
      return `Clear & type "${action.text}"`;
    case "key":
      return `Press ${action.key}`;
    case "select":
      return `Select "${action.value}" in [ref=${action.ref}]`;
    case "scroll": {
      const dir = (action.deltaY || 0) > 0 ? "down" : "up";
      return `Scroll ${dir} ${Math.abs(action.deltaY || 0)}px`;
    }
    case "navigate":
      return `Navigate to ${action.url}`;
    case "back":
      return `Go back`;
    case "forward":
      return `Go forward`;
    case "extract_text":
      return `Read text from [ref=${action.ref}]`;
    case "new_tab":
      return `Open new tab${action.url ? ": " + action.url : ""}`;
    case "switch_tab":
      return `Switch to tab ${action.tabId}`;
    case "close_tab":
      return `Close tab ${action.tabId}`;
    case "click_captcha":
      return `Click CAPTCHA checkbox`;
    case "dismiss_popup":
      return `Force-dismiss popup`;
    case "accept_dialog":
      return `Accept dialog`;
    case "dismiss_dialog":
      return `Dismiss dialog`;
    case "ask_user":
      return `Asking for help: ${action.question || ""}`;
    case "wait":
      return `Wait ${action.duration}ms`;
    case "done":
      return `Task complete`;
    default:
      return JSON.stringify(action);
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setRunning(state) {
  running = state;
  taskInput.disabled = state;
  sendBtn.classList.toggle("hidden", state);
  stopBtn.classList.toggle("hidden", !state);
  newChatBtn.classList.toggle("hidden", state);
}

function clearLog() {
  while (logArea.lastChild && logArea.lastChild !== placeholder) {
    logArea.removeChild(logArea.lastChild);
  }
  placeholder.classList.remove("hidden");
}

// ── Pause / Resume ──────────────────────────────────────────

/**
 * Pause the agent loop and show a message asking the user for help.
 * Returns a promise that resolves when the user clicks "Resume".
 */
function pauseForUser(question) {
  return new Promise((resolve) => {
    const entry = addLog(
      `<div class="ask-user-label">Needs your help</div>` +
      `<div class="ask-user-text">${escapeHtml(question)}</div>` +
      `<button class="resume-btn" id="resumeBtn">Resume after solving</button>`,
      "log-ask-user"
    );

    const resumeBtn = entry.querySelector("#resumeBtn");
    resumeBtn.addEventListener("click", () => {
      resumeBtn.disabled = true;
      resumeBtn.textContent = "Resuming...";
      resolve();
    });
  });
}

// ── Loop Detection ──────────────────────────────────────────

/**
 * Detect if the agent is stuck in a loop by checking for repeated identical actions.
 * Returns a warning string if a loop is detected, null otherwise.
 */
function detectLoop(actionHistory) {
  if (actionHistory.length < 3) return null;

  const last3 = actionHistory.slice(-3);
  // All 3 identical
  if (last3[0] === last3[1] && last3[1] === last3[2]) {
    return `LOOP DETECTED: You have repeated the same action 3 times: ${last3[0]}. ` +
      `This action is not working. Try a completely different approach: ` +
      `use keyboard navigation (Tab/Enter), try a different element, scroll to reveal the target, ` +
      `or use coordinates instead of ref (or vice versa). If truly stuck, use done.`;
  }

  // Oscillating between 2 actions
  if (actionHistory.length >= 4) {
    const last4 = actionHistory.slice(-4);
    if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
      return `OSCILLATION DETECTED: You are alternating between two actions. ` +
        `Break the cycle by trying a completely different approach or reporting done.`;
    }
  }

  return null;
}

// ── Screenshot + Elements ───────────────────────────────────

async function captureScreenshot() {
  // Use the agent's active tab, not necessarily the chrome-active tab
  const tabId = getActiveAgentTabId();
  const tab = await chrome.tabs.get(tabId);

  // Make sure the agent tab is the visible one
  if (!tab.active) {
    await chrome.tabs.update(tabId, { active: true });
    await sleep(300);
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  return {
    base64: dataUrl.split(",")[1],
    tabId: tab.id,
    width: tab.width,
    height: tab.height,
  };
}

async function captureState() {
  const screenshot = await captureScreenshot();

  let elements = null;
  let scrollContainers = null;
  let popup = null;
  let captcha = null;
  let isCanvasHeavy = false;
  try {
    const data = await extractElements(screenshot.tabId);
    elements = data.elements;
    scrollContainers = data.scrollContainers;
    popup = data.popup;
    captcha = data.captcha;
    isCanvasHeavy = data.isCanvasHeavy;
  } catch (err) {
    console.warn("Element extraction failed, using vision-only mode:", err);
  }

  const agentTabs = await getAgentTabs();
  const dialog = getPendingDialog();

  return { screenshot, elements, scrollContainers, popup, captcha, dialog, isCanvasHeavy, agentTabs };
}

// ── Tab Action Executor ─────────────────────────────────────

async function executeTabAction(action) {
  switch (action.type) {
    case "new_tab": {
      const result = await agentNewTab(action.url || "about:blank");
      if (!result) {
        addError("Tab limit reached (max 5).");
      }
      // Detach debugger so it reattaches to the new tab on next step
      await detachDebugger();
      await sleep(action.url ? 2000 : 500);
      break;
    }
    case "switch_tab": {
      const ok = await agentSwitchTab(action.tabId);
      if (!ok) {
        addError(`Could not switch to tab ${action.tabId}.`);
      }
      await sleep(500);
      break;
    }
    case "close_tab": {
      const ok = await agentCloseTab(action.tabId);
      if (!ok) {
        addError(`Could not close tab ${action.tabId}.`);
      }
      await sleep(300);
      break;
    }
  }
}

// ── Agent Loop ──────────────────────────────────────────────

async function runAgent(task) {
  placeholder.classList.add("hidden");
  addLog(escapeHtml(task), "log-task");
  setRunning(true);

  try {
    // Initialize tab manager — creates "Agent" tab group
    await initTabManager();

    // Get initial viewport info
    const initial = await captureScreenshot();

    // Start session
    const startRes = await fetch(`${API_BASE}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        viewport_width: initial.width || 1280,
        viewport_height: initial.height || 800,
      }),
    });

    if (!startRes.ok) throw new Error("Failed to start session");
    const { session_id } = await startRes.json();
    sessionId = session_id;

    // Agent loop with loop detection and failure tracking
    let completed = false;
    const actionHistory = []; // for loop detection
    let consecutiveFailures = 0;

    for (let step = 0; step < MAX_STEPS && running; step++) {
      const state = await captureState();

      // Build request with loop detection hint
      const loopWarning = detectLoop(actionHistory);
      const requestBody = {
        image: state.screenshot.base64,
        elements: state.elements,
        scroll_containers: state.scrollContainers,
        popup: state.popup,
        captcha: state.captcha,
        dialog: state.dialog,
        is_canvas_heavy: state.isCanvasHeavy,
        agent_tabs: state.agentTabs,
      };
      if (loopWarning) {
        requestBody.loop_warning = loopWarning;
      }

      const loadingEl = addLoading();

      const stepRes = await fetch(
        `${API_BASE}/session/${sessionId}/step`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        }
      );

      loadingEl.remove();

      if (!stepRes.ok) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          addError("3 consecutive server errors. Stopping.");
          break;
        }
        const err = await stepRes.json().catch(() => ({}));
        addError(err.detail || `Server error: ${stepRes.status}`);
        await sleep(1000);
        continue;
      }

      consecutiveFailures = 0;
      const result = await stepRes.json();

      // Display structured thinking (eval/memory/goal)
      addThought(result);

      if (!result.action) {
        addError("No action returned by model.");
        break;
      }

      // Track action for loop detection
      actionHistory.push(JSON.stringify(result.action));

      addAction(result.action);

      if (result.action.type === "done") {
        addDone(result.action.summary || "Task complete.");
        completed = true;
        break;
      }

      // Handle ask_user — pause and wait for user to resume
      if (result.action.type === "ask_user") {
        const question = result.action.question || "Please help with the current page.";
        await pauseForUser(question);
        if (!running) break; // user stopped instead of resuming
        continue; // re-capture state and continue loop
      }

      // Execute tab actions vs page actions
      if (["new_tab", "switch_tab", "close_tab"].includes(result.action.type)) {
        await executeTabAction(result.action);
      } else {
        const executed = await executeAction(state.screenshot.tabId, result.action);
        if (executed && executed._extractedText) {
          addLog(
            `<div class="thought-label">Extracted Text</div><div>${escapeHtml(executed._extractedText)}</div>`,
            "log-thought"
          );
        }
      }
    }

    if (!completed && running) {
      addError(`Stopped after ${MAX_STEPS} steps. You can start a new task to continue.`);
    } else if (!completed && !running) {
      addLog("Stopped by user.", "log-error");
    }
  } catch (err) {
    addError(err.message || "Something went wrong.");
  } finally {
    setRunning(false);
    // Cleanup: ungroup tabs (keep them open for the user)
    await cleanupTabManager();
    if (sessionId) {
      fetch(`${API_BASE}/session/${sessionId}`, { method: "DELETE" }).catch(
        () => {}
      );
      sessionId = null;
    }
    detachDebugger().catch(() => {});
  }
}

// ── Event Listeners ─────────────────────────────────────────

sendBtn.addEventListener("click", () => {
  const task = taskInput.value.trim();
  if (!task) return;
  taskInput.value = "";
  runAgent(task);
});

taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendBtn.click();
  }
});

stopBtn.addEventListener("click", () => {
  running = false;
});

newChatBtn.addEventListener("click", () => {
  if (running) return;
  clearLog();
  taskInput.value = "";
  taskInput.focus();
});
