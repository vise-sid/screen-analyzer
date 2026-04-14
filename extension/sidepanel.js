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
let currentAbortController = null; // For killing stuck requests

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
  // New format: single "thought" field
  if (result.thought) {
    addLog(
      `<div class="thought-label">\u{1F9E0} THINKING</div><div>${escapeHtml(result.thought)}</div>`,
      "log-thought"
    );
    return;
  }
  // Backward compat: old eval/memory/goal format
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
  if (parts.length > 0) {
    addLog(
      `<div class="thought-label">\u{1F9E0} THINKING</div>${parts.join("")}`,
      "log-thought"
    );
  }
}

function addAction(action) {
  const icons = {
    click: "\u{1F446}",        double_click: "\u{1F446}",
    hover: "\u{1F441}",        focus_and_type: "\u2328\uFE0F",
    type: "\u2328\uFE0F",      clear_and_type: "\u2328\uFE0F",
    key: "\u26A1",              key_combo: "\u26A1",
    select: "\u{1F4CB}",
    scroll: "\u{1F4DC}",       navigate: "\u{1F30D}",
    back: "\u2B05\uFE0F",      forward: "\u27A1\uFE0F",
    extract_text: "\u{1F4D6}", screenshot: "\u{1F4F7}",
    new_tab: "\u2795",          switch_tab: "\u{1F500}",
    close_tab: "\u274C",        click_captcha: "\u{1F916}",
    stealth_solve: "\u{1F575}",dismiss_popup: "\u{1F6AB}",
    accept_dialog: "\u2705",    dismiss_dialog: "\u274C",
    ask_user: "\u{1F64B}",      wait: "\u23F3",
    done: "\u2705",
    // Scraping & Memory
    scrape_page: "\u{1F4C4}",    scrape_table: "\u{1F4CA}",
    scrape_links: "\u{1F517}",   scrape_metadata: "\u{1F3F7}",
    scrape_network: "\u{1F310}", store: "\u{1F4BE}",
    recall: "\u{1F4E5}",
    // Planning & Intelligence
    plan: "\u{1F9E0}",           google_search: "\u{1F50D}",
    ask_advisor: "\u{1F4A1}",    fill_cells: "\u{1F4DD}",
    // Google Workspace API
    sheets_create: "\u{1F4CA}",  sheets_write: "\u270D\uFE0F",
    sheets_read: "\u{1F4D6}",
    docs_create: "\u{1F4DD}",    docs_write: "\u270D\uFE0F",
    docs_read: "\u{1F4D6}",
    slides_create: "\u{1F4FD}",  slides_read: "\u{1F4D6}",
  };
  const icon = icons[action.type] || "\u25B6\uFE0F";
  addLog(
    `<span class="action-icon">${icon}</span> <span>${escapeHtml(formatAction(action))}</span>`,
    "log-action"
  );
}

function addDone(summary) {
  addLog(
    `<div class="done-label">\u{1F389} MISSION COMPLETE</div><div>${escapeHtml(summary)}</div>`,
    "log-done"
  );
}

function addError(msg) {
  addLog(escapeHtml(msg), "log-error");
}

const LOADING_MSGS = [
  "Sniffing around...", "On the trail...", "Foxing through the page...",
  "Eyes on screen...", "Working on it...", "Almost got it...",
  "Reading the pixels...", "Thinking foxy thoughts...",
];

function addLoading() {
  const msg = LOADING_MSGS[Math.floor(Math.random() * LOADING_MSGS.length)];
  return addLog(
    `\u{1F440} <span>${msg}</span>`,
    "log-loading"
  );
}

function formatAction(action) {
  const refStr = (a) =>
    a.ref !== undefined ? `[${a.ref}]` : `(${a.x}, ${a.y})`;

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
    case "key_combo":
      return `Key combo ${action.keys}`;
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
    case "stealth_solve":
      return `Stealth solve Cloudflare${action.url ? ": " + action.url : ""}`;
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
    // Scraping & Memory
    case "scrape_page":
      return `Scrape full page to Markdown`;
    case "scrape_table":
      return `Extract table${action.ref !== undefined ? ` [ref=${action.ref}]` : ""}`;
    case "scrape_links":
      return `Extract all page links`;
    case "scrape_metadata":
      return `Extract page metadata`;
    case "scrape_network":
      return `Show captured API responses`;
    case "store":
      return `Store to memory: "${action.key || "default"}"`;
    case "recall":
      return `Recall from memory: "${action.key || "default"}"`;
    case "plan":
      return `Creating execution plan`;
    case "google_search":
      return `Searching: "${action.query || ""}"`;
    case "ask_advisor":
      return `Consulting advisor: "${(action.question || "").substring(0, 60)}"`;
    case "fill_cells":
      return `Fill ${(action.values || []).length} cells from ${action.startCell || "A1"} (${action.direction || "down"})`;
    case "sheets_create":
      return `Create spreadsheet: "${action.title || "Untitled"}"`;
    case "sheets_write":
      return `Write ${(action.values || []).length} rows to ${action.range || "A1"}`;
    case "sheets_read":
      return `Read cells ${action.range || "A1:Z100"}`;
    case "docs_create":
      return `Create doc: "${action.title || "Untitled"}"`;
    case "docs_write":
      return `Write to doc`;
    case "docs_read":
      return `Read doc`;
    case "slides_create":
      return `Create presentation: "${action.title || "Untitled"}"`;
    case "slides_read":
      return `Read slides`;
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
 * Detect if the agent is stuck in a loop by checking for repeated actions.
 * Returns a warning string if a loop is detected, null otherwise.
 *
 * Catches:
 * - 3 identical actions in a row
 * - A-B-A-B oscillation
 * - Same action TYPE repeated 4+ times (e.g., scroll with varying params)
 * - Scroll up/down oscillation (scroll loop)
 */
function detectLoop(actionHistory) {
  if (actionHistory.length < 3) return null;

  const last3 = actionHistory.slice(-3);
  // All 3 identical
  if (last3[0] === last3[1] && last3[1] === last3[2]) {
    return `LOOP DETECTED: You have repeated the same action 3 times: ${last3[0]}. ` +
      `This action is not working. Try a completely different approach or use done to report what you found so far.`;
  }

  // Oscillating between 2 actions
  if (actionHistory.length >= 4) {
    const last4 = actionHistory.slice(-4);
    if (last4[0] === last4[2] && last4[1] === last4[3] && last4[0] !== last4[1]) {
      return `OSCILLATION DETECTED: You are alternating between two actions. ` +
        `Stop and try a completely different approach, or use done to report what you found.`;
    }
  }

  // Same action TYPE repeated 4+ times (catches scroll loops with varying params)
  if (actionHistory.length >= 4) {
    try {
      const lastTypes = actionHistory.slice(-4).map(a => JSON.parse(a).type);
      const allSame = lastTypes.every(t => t === lastTypes[0]);
      if (allSame) {
        return `TYPE LOOP DETECTED: You have used "${lastTypes[0]}" 4 times in a row. ` +
          `This is not making progress. If you already have the information you need ` +
          `(from a previous scrape or from the element list), use done NOW to report your findings. ` +
          `If you truly need more data, try scrape_page instead of scrolling.`;
      }
    } catch (_) {}
  }

  // Scroll direction oscillation: up-down-up or down-up-down (catches scroll ping-pong)
  if (actionHistory.length >= 5) {
    try {
      const last5 = actionHistory.slice(-5).map(a => {
        const parsed = JSON.parse(a);
        if (parsed.type !== "scroll") return null;
        return (parsed.deltaY || 0) > 0 ? "down" : "up";
      });
      if (last5.every(d => d !== null)) {
        const changes = last5.filter((d, i) => i > 0 && d !== last5[i - 1]).length;
        if (changes >= 3) {
          return `SCROLL LOOP DETECTED: You are scrolling up and down repeatedly without progress. ` +
            `STOP scrolling. Use scrape_page to get the page content, then use done to report your findings.`;
        }
      }
    } catch (_) {}
  }

  return null;
}

// ── Screenshot + Elements ───────────────────────────────────

async function resolveAgentTab() {
  // Try the currently tracked active tab
  const tabId = getActiveAgentTabId();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await chrome.tabs.get(tabId);
    } catch (e) {
      if (attempt < 2) await sleep(300);
    }
  }

  // Active tab gone — try other known agent tabs
  for (const id of agentTabIds) {
    if (id === tabId) continue;
    try {
      const tab = await chrome.tabs.get(id);
      activeAgentTabId = tab.id;
      await chrome.tabs.update(tab.id, { active: true });
      console.log(`Switched to surviving agent tab: ${tab.id} (${tab.url})`);
      return tab;
    } catch (_) {
      agentTabIds.delete(id); // This one's dead too
    }
  }

  // Last resort: find any tab in current window
  const allTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (allTabs.length > 0) {
    const tab = allTabs[0];
    agentTabIds.add(tab.id);
    activeAgentTabId = tab.id;
    return tab;
  }
  throw new Error("No available agent tab found");
}

async function captureScreenshot(tab) {
  // Tab passed in — no duplicate resolveAgentTab call
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(150);
  }

  // JPEG at 60% quality — 3-5x smaller than PNG, faster to send
  let dataUrl = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      break;
    } catch (e) {
      if (attempt < 2) await sleep(300); // Short retry
      else throw e;
    }
  }

  return {
    base64: dataUrl.split(",")[1],
    tabId: tab.id,
    width: tab.width,
    height: tab.height,
  };
}

async function captureState(needsScreenshot = true) {
  const tab = await resolveAgentTab();
  if (!tab.active) {
    await chrome.tabs.update(tab.id, { active: true });
    await sleep(150);
  }

  // Wait for page to be ready before capturing (replaces hardcoded post-action sleeps)
  try {
    await waitForPageReady();
  } catch (_) {}

  let screenshot = { base64: null, tabId: tab.id, width: tab.width, height: tab.height };
  // Run screenshot + element extraction + tab list in PARALLEL
  const [screenshotResult, elemData, agentTabs] = await Promise.all([
    needsScreenshot
      ? captureScreenshot(tab).catch(e => {
          console.warn("Screenshot failed:", e);
          return { base64: null, tabId: tab.id, width: tab.width, height: tab.height };
        })
      : Promise.resolve({ base64: null, tabId: tab.id, width: tab.width, height: tab.height }),
    extractElements(tab.id).catch(err => {
      console.warn("Element extraction failed:", err);
      return { elements: null, scrollContainers: null, popup: null, captcha: null, isCanvasHeavy: false };
    }),
    getAgentTabs(),
  ]);

  let { elements, scrollContainers, popup, captcha, isCanvasHeavy, pageScroll, pageLoading } = elemData;
  if (elements && elements.length > 200) elements = elements.slice(0, 200);

  const dialog = typeof getPendingDialog === "function" ? getPendingDialog() : null;
  return { screenshot: screenshotResult, elements, scrollContainers, popup, captcha, dialog, isCanvasHeavy, agentTabs, pageScroll, pageLoading };
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
    startPopupDetection();

    // Get initial viewport info
    const initialTab = await resolveAgentTab();
    const initial = await captureScreenshot(initialTab);

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

    addLog(`<span class="action-icon">\u{1F9E0}</span> <span>Planning strategy...</span>`, "log-action");

    let googleToken = null;  // Cached Google OAuth token (fetched on demand)

    // Pre-fetch Google OAuth token (silent, non-interactive first attempt)
    // If the task needs Sheets/Drive, this ensures the token is ready
    try {
      googleToken = await new Promise((resolve) => {
        chrome.identity.getAuthToken({ interactive: false }, (token) => {
          if (chrome.runtime.lastError || !token) {
            resolve(null); // Not signed in or no consent yet — will prompt interactively when needed
          } else {
            resolve(token);
          }
        });
      });
      if (googleToken) {
        console.log("Google OAuth token pre-fetched (silent)");
      }
    } catch (_) {
      googleToken = null;
    }

    // Agent loop
    let completed = false;
    const actionHistory = [];
    let consecutiveFailures = 0;
    let killRetries = 0;
    let lastActionResult = null;  // Scrape/extract/recall result to send back to LLM
    for (let step = 0; step < MAX_STEPS && running; step++) {
      // ── Timing: track every phase ──
      const t0 = performance.now();

      const state = await captureState(true);
      const tCapture = performance.now();

      // Get FRESH tab info for URL (after page load, not cached)
      const tab = await resolveAgentTab();
      const freshTab = await chrome.tabs.get(tab.id);
      const requestBody = {
        url: freshTab.url || "",
        elements: state.elements,
        scroll_containers: state.scrollContainers,
        popup: state.popup,
        captcha: state.captcha,
        dialog: state.dialog,
        is_canvas_heavy: state.isCanvasHeavy,
        agent_tabs: state.agentTabs,
        page_scroll: state.pageScroll,
        page_loading: state.pageLoading || false,
      };
      if (state.screenshot.base64) {
        requestBody.image = state.screenshot.base64;
      }
      // Include action result from previous scrape/extract/recall
      if (lastActionResult) {
        requestBody.action_result = lastActionResult;
        lastActionResult = null;  // Clear after sending
      }
      // Include Google OAuth token if we have one (for Sheets API actions)
      if (googleToken) {
        requestBody.google_token = googleToken;
      }
      const loopWarning = detectLoop(actionHistory);
      if (loopWarning) requestBody.loop_warning = loopWarning;

      const loadingEl = addLoading();
      currentAbortController = new AbortController();
      const timeoutId = setTimeout(() => currentAbortController.abort(), 90000);

      const tApiStart = performance.now();
      let stepRes;
      try {
        stepRes = await fetch(`${API_BASE}/session/${sessionId}/step`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: currentAbortController.signal,
        });
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        loadingEl.remove();
        currentAbortController = null;
        if (fetchErr.name === "AbortError") {
          killRetries++;
          if (killRetries >= 3) { addError("Timed out 3 times — skipping."); killRetries = 0; continue; }
          addLog(`Request timed out — retry ${killRetries}/3...`, "log-error");
          continue;
        }
        throw fetchErr;
      }
      clearTimeout(timeoutId);
      currentAbortController = null;
      killRetries = 0;
      const tApiEnd = performance.now();

      loadingEl.remove();

      if (!stepRes.ok) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) { addError("3 consecutive server errors. Stopping."); break; }
        const err = await stepRes.json().catch(() => ({}));
        addError(err.detail || `Server error: ${stepRes.status}`);
        await sleep(1000);
        continue;
      }

      consecutiveFailures = 0;
      const result = await stepRes.json();

      addThought(result);

      if (!result.action) { addError("No action returned by model."); break; }

      if (result.action.type === "screenshot") {
        addLog(`<span class="action-icon">\u{1F4F7}</span> <span>Requesting screenshot...</span>`, "log-action");
        continue;
      }

      actionHistory.push(JSON.stringify(result.action));
      addAction(result.action);

      // ── Execute action ──
      const tExecStart = performance.now();
      let shouldBreak = false;
      let shouldContinue = false;

      if (result.action.type === "done") {
        addDone(result.action.summary || "Task complete.");
        completed = true;
        shouldBreak = true;
      } else if (result.action.type === "plan") {
        // Flash created its execution plan — show it prominently
        const planText = result.action.plan || result.thought || "";
        addLog(
          `<div class="thought-label">\u{1F9E0} PLANNING</div><pre class="scraped-preview">${escapeHtml(planText)}</pre>`,
          "log-thought"
        );
        shouldContinue = true;
      } else if (result.action.type === "google_search") {
        // Google search for URL discovery — result comes back from backend
        const searchData = result._search_data || "";
        if (searchData) {
          lastActionResult = searchData;
          addLog(
            `<div class="thought-label">\u{1F50D} SEARCH</div><div>${escapeHtml(searchData.substring(0, 300))}</div>`,
            "log-thought"
          );
        }
        shouldContinue = true;
      } else if (result.action.type === "ask_advisor") {
        // Consulted the Pro model for complex reasoning
        const advice = result._advisor_response || "";
        if (advice) {
          lastActionResult = advice;
          addLog(
            `<div class="thought-label">\u{1F4A1} ADVISOR</div><pre class="scraped-preview">${escapeHtml(advice)}</pre>`,
            "log-thought"
          );
        }
        shouldContinue = true;
      } else if ([
        "sheets_create", "sheets_write", "sheets_read",
        "docs_create", "docs_write", "docs_read",
        "slides_create", "slides_read",
      ].includes(result.action.type)) {
        // Google Workspace API actions — handled server-side
        const gr = result._gwork_result || {};
        if (gr.error) {
          // If error is about missing token, try interactive auth
          if (gr.error.includes("OAuth token") || gr.error.includes("not connected")) {
            addLog(`<span class="action-icon">\u{1F511}</span> <span>Connecting to Google — approve in popup...</span>`, "log-action");

            // Detach debugger BEFORE OAuth to prevent crash on consent page
            await detachDebugger();
            const preAuthTab = await resolveAgentTab();

            try {
              // Blocks until user approves/rejects consent popup
              googleToken = await getGoogleAuthToken();
              if (googleToken) {
                addLog(`<span class="action-icon">\u2705</span> <span>Google connected! Retrying...</span>`, "log-action");
                lastActionResult = "Google OAuth connected. Retry the action.";
              } else {
                lastActionResult = "GOOGLE ERROR: OAuth not available. Sign into Chrome with Google account.";
              }
            } catch (authErr) {
              lastActionResult = `GOOGLE ERROR: Auth failed — ${authErr.message}`;
            }

            // Switch back to original tab after OAuth completes
            try {
              await chrome.tabs.update(preAuthTab.id, { active: true });
              await sleep(500);
            } catch (_) {}
          } else {
            addLog(`<div class="thought-label">\u26A0\uFE0F GOOGLE ERROR</div><div>${escapeHtml(gr.error)}</div>`, "log-error");
            lastActionResult = `GOOGLE ERROR: ${gr.error}`;
          }
        } else {
          // Success — show result based on action type
          const url = gr.url || "";
          const title = gr.title || result.action.title || "Untitled";
          const atype = result.action.type;

          if (atype.endsWith("_create")) {
            const icon = atype.startsWith("sheets") ? "\u{1F4CA}" : atype.startsWith("docs") ? "\u{1F4DD}" : "\u{1F4FD}";
            const label = atype.startsWith("sheets") ? "SHEET" : atype.startsWith("docs") ? "DOC" : "SLIDES";
            addLog(
              `<div class="thought-label">${icon} ${label} CREATED</div><div><a href="${escapeHtml(url)}" target="_blank">${escapeHtml(title)}</a></div>`,
              "log-thought"
            );
          } else if (atype.endsWith("_write")) {
            addLog(`<div class="thought-label">\u270D\uFE0F WRITTEN</div><div>${escapeHtml(JSON.stringify(gr).substring(0, 200))}</div>`, "log-thought");
          } else if (atype.endsWith("_read")) {
            const data = JSON.stringify(gr, null, 2);
            const preview = data.length > 500 ? data.substring(0, 500) + "..." : data;
            addLog(`<div class="thought-label">\u{1F4D6} READ</div><pre class="scraped-preview">${escapeHtml(preview)}</pre>`, "log-thought");
          }
          lastActionResult = JSON.stringify(gr);
        }
        shouldContinue = true;
      } else if (result.action.type === "ask_user") {
        await pauseForUser(result.action.question || "Please help.");
        if (!running) { shouldBreak = true; } else { shouldContinue = true; }
      } else if (result.action.type === "stealth_solve") {
        const solveTab = await resolveAgentTab();
        addLog(`<div class="thought-label">\u{1F575} STEALTH MODE</div><div>Bypassing Cloudflare...</div>`, "log-thought");
        const solveResult = await stealthSolve(solveTab.id, solveTab.url, API_BASE);
        if (solveResult.success) {
          addLog(`<span class="action-icon">\u{1F510}</span> <span>Cloudflare bypassed!</span>`, "log-action");
          await detachDebugger();
        } else {
          addError(`Stealth solve failed: ${solveResult.error || "Unknown"}`);
        }
        shouldContinue = true;
      } else if (["new_tab", "switch_tab", "close_tab"].includes(result.action.type)) {
        await executeTabAction(result.action);
      } else if (result.action.type === "store") {
        // Store: send lastActionResult to backend via the next step's action_result
        // The backend handles the actual storage when it processes the model response
        if (lastActionResult) {
          addLog(`<div class="thought-label">\u{1F4BE} STORING</div><div>Key: "${escapeHtml(result.action.key || 'default')}" (${(lastActionResult.length / 1024).toFixed(1)}KB)</div>`, "log-thought");
        } else {
          addLog(`<div class="thought-label">\u{1F4BE} STORE</div><div>No data to store — use a scrape action first</div>`, "log-thought");
        }
        // Don't clear lastActionResult — the backend needs it in the next step to actually store
      } else if (result.action.type === "recall") {
        // Recall: backend returns the data in result._recall_data
        if (result._recall_data) {
          lastActionResult = result._recall_data;
          const preview = result._recall_data.length > 300
            ? result._recall_data.substring(0, 300) + "..."
            : result._recall_data;
          addLog(`<div class="thought-label">\u{1F4E5} RECALLED</div><pre class="scraped-preview">${escapeHtml(preview)}</pre>`, "log-thought");
        } else {
          addLog(`<div class="thought-label">\u{1F4E5} RECALL</div><div>Key not found</div>`, "log-thought");
        }
      } else {
        const executed = await executeAction(state.screenshot.tabId, result.action);
        // Handle extracted text (existing)
        if (executed && executed._extractedText) {
          addLog(`<div class="thought-label">\u{1F4D6} EXTRACTED</div><div>${escapeHtml(executed._extractedText)}</div>`, "log-thought");
          lastActionResult = executed._extractedText;
        }
        // Handle scraped data (new)
        if (executed && executed._scrapedData && !executed._extractedText) {
          const scraped = typeof executed._scrapedData === "string"
            ? executed._scrapedData
            : JSON.stringify(executed._scrapedData, null, 2);
          lastActionResult = scraped;
          const preview = scraped.length > 500
            ? scraped.substring(0, 500) + "..."
            : scraped;
          addLog(`<div class="thought-label">\u{1F4CA} SCRAPED</div><pre class="scraped-preview">${escapeHtml(preview)}</pre>`, "log-thought");
        }
        // Handle fill_cells result
        if (executed && executed._fillResult) {
          const fr = executed._fillResult;
          if (fr.error) {
            addLog(`<div class="thought-label">\u26A0\uFE0F FILL FAILED</div><div>${escapeHtml(fr.error)}</div>`, "log-error");
          } else {
            addLog(
              `<div class="thought-label">\u{1F4DD} FILLED</div><div>${fr.count} cells from ${fr.startCell} (${fr.direction}): ${fr.values.join(", ")}</div>`,
              "log-thought"
            );
          }
        }
        // Handle input verification — warn if typed text didn't match
        if (executed && executed._inputVerification) {
          const v = executed._inputVerification;
          if (!v.match) {
            addLog(
              `<div class="thought-label">\u26A0\uFE0F INPUT MISMATCH</div>` +
              `<div>Intended: "${escapeHtml(v.intended)}"<br>Actual: "${escapeHtml(v.actual)}"</div>`,
              "log-error"
            );
            // Send mismatch info to LLM so it can correct
            lastActionResult = `INPUT MISMATCH: Intended "${v.intended}" but field contains "${v.actual}". Use focus_and_type with clear:true to fix.`;
          }
        }
      }

      const tExecEnd = performance.now();

      // ── Log timing ──
      const captureMs = Math.round(tCapture - t0);
      const apiMs = Math.round(tApiEnd - tApiStart);
      const execMs = Math.round(tExecEnd - tExecStart);
      const totalMs = Math.round(tExecEnd - t0);
      console.log(`[Step ${step + 1}] capture=${captureMs}ms api=${apiMs}ms exec=${execMs}ms total=${totalMs}ms`);
      addLog(
        `<span class="timing">⏱ capture ${captureMs}ms · LLM ${apiMs}ms · exec ${execMs}ms · total ${totalMs}ms</span>`,
        "log-timing"
      );

      if (shouldBreak) break;
      if (shouldContinue) continue;

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
    stopPopupDetection();
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
  // Kill current request if stuck, or stop entirely on second click
  if (currentAbortController) {
    currentAbortController.abort();
    // Don't set running=false — let it retry the step
  } else {
    running = false;
  }
});

// Double-click stop to force quit
stopBtn.addEventListener("dblclick", () => {
  running = false;
  if (currentAbortController) currentAbortController.abort();
});

newChatBtn.addEventListener("click", () => {
  if (running) return;
  clearLog();
  taskInput.value = "";
  taskInput.focus();
});
