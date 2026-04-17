/**
 * Page activity capture — runs on every page the user visits.
 *
 * Emits *partial* envelopes for user-initiated events. The background
 * worker enriches each envelope with id, sessionId, tabId, and outcome
 * attribution (parentActionId, causedBy) before forwarding to the
 * sidepanel as `pixelfoxx_event`.
 *
 * Envelope shape produced here:
 *   {
 *     source:  "content",
 *     kind:    "click" | "input" | "submit" | "key" | "scroll" | "page_ready",
 *     actor:   "user",
 *     ts:      Date.now(),
 *     target?: { tag, role, ariaLabel, name, id, type, placeholder, href, text },
 *     context: { url, title, viewport: { w, h } },
 *     payload?: { ...kind-specific (coords | value/sensitive | key | scrollX/Y | readyState) },
 *   }
 *
 * Only trusted events (isTrusted=true) are captured — CDP-injected agent
 * actions have isTrusted=false and are intentionally ignored here so the
 * agent's own actions don't echo back as "user" events.
 *
 * Password fields and sensitive autocomplete hints are redacted at the
 * source — raw secrets never leave the page.
 */

(function () {
  "use strict";

  // Idempotency: if another instance of capture.js has already installed
  // listeners in this tab's isolated world, bail. This lets the background
  // worker safely re-inject on SW boot without creating duplicate
  // listeners (which would double every captured event).
  //
  // Note on dev-reload: if the extension was reloaded while this tab was
  // open, the *previous* capture.js still has this flag set even though
  // its runtime is dead. In that case the user still needs to refresh
  // the tab — we can't detect the dead instance from the new injection.
  if (window.__pixelfoxxCaptureInstalled) return;
  window.__pixelfoxxCaptureInstalled = true;

  // Deduplicate rapid repeats of the same event (e.g. key-held)
  const MIN_CAPTURE_INTERVAL_MS = 40;
  let lastCapture = 0;

  // ── Selectors and limits shared by container-walk + outcome observer ──
  const DIALOG_SEL   = '[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]';
  const ALERT_SEL    = '[role="alert"], [aria-live="assertive"]';
  const FORM_SEL     = 'form, [role="form"]';
  const SECTION_SEL  =
    'section, article, main, nav, aside, ' +
    '[role="region"], [role="navigation"], [role="search"], ' +
    '[role="banner"], [role="complementary"]';

  const CONTAINER_WALK_MAX   = 8;
  const CONTAINER_NAME_MAX   = 60;
  const ALERT_TEXT_MAX       = 200;
  const DEDUP_WINDOW_MS      = 500;
  const MUTATION_RECORD_BAIL = 200;  // safety valve against runaway bursts

  // Per-ancestor memoization: once we resolve a container for one target,
  // other targets that share the ancestor chain reuse the result.
  const containerCache = new WeakMap(); // Element → { container, containerName } | null
  // Dedup map for outcome-observer emits, pruned inline on each call.
  const recentEmits    = new Map();     // "kind:text40" → timestamp

  function currentContext() {
    return {
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
  }

  // Becomes true once we detect the extension context has been invalidated
  // (extension reloaded / disabled). Once flipped, we stop trying to emit
  // — the only recovery is a page refresh, which re-injects this script.
  let ctxDead = false;

  function markContextDead() {
    if (ctxDead) return;
    ctxDead = true;
    // Clear the idempotency flag so a fresh background-bootstrap injection
    // (after extension reload) can install a working capture.js in this tab
    // without needing a page refresh.
    try { delete window.__pixelfoxxCaptureInstalled; } catch (_) {}
    // console.debug (not warn) — context invalidation is an expected
    // dev-workflow event (user reloaded the extension without refreshing
    // this tab). warn would pollute chrome://extensions' Errors page.
    try {
      console.debug(
        "[PixelFoxx] Extension context invalidated — capture paused on this page. Refresh the tab to resume."
      );
    } catch (_) {}
  }

  /** Send a partial envelope to the background worker. */
  function emit(kind, partial) {
    if (ctxDead) return;
    // Fast check: if the extension was reloaded, chrome.runtime.id is
    // undefined in this orphaned content script.
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
      markContextDead();
      return;
    }
    const envelope = {
      source: "content",
      kind,
      actor: "user",
      ts: Date.now(),
      context: currentContext(),
      ...partial,
    };
    try {
      const p = chrome.runtime.sendMessage({
        type: "pixelfoxx_capture",
        event: envelope,
      });
      if (p && typeof p.catch === "function") {
        p.catch((err) => {
          const msg = err && err.message ? String(err.message) : "";
          if (msg.includes("context invalidated") || msg.includes("Extension context")) {
            markContextDead();
          }
          // Otherwise (e.g. "Receiving end does not exist" when sidepanel
          // is closed) — drop silently, that's expected.
        });
      }
    } catch (err) {
      const msg = err && err.message ? String(err.message) : "";
      if (msg.includes("context invalidated") || msg.includes("Extension context")) {
        markContextDead();
      }
    }
  }

  /**
   * Extract the visible label of an element the user actually saw.
   * Walks standards-based sources in priority order:
   *   1. aria-labelledby (resolves referenced element text)
   *   2. <label for="{id}">
   *   3. Wrapping <label> ancestor
   *   4. aria-label
   * Returns null if none apply — caller falls back to other descriptors.
   */
  function extractLabel(el) {
    if (!el || !(el instanceof Element)) return null;
    try {
      // 1. aria-labelledby — space-separated list of element IDs to concatenate
      const lb = el.getAttribute && el.getAttribute("aria-labelledby");
      if (lb) {
        const parts = lb
          .split(/\s+/)
          .map((id) => {
            const ref = document.getElementById(id);
            return ref ? (ref.innerText || ref.textContent || "").trim() : "";
          })
          .filter(Boolean);
        if (parts.length) return parts.join(" ").slice(0, 120);
      }
      // 2. <label for="{id}"> elsewhere in the document
      if (el.id && typeof CSS !== "undefined" && CSS.escape) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) {
          const t = (lbl.innerText || lbl.textContent || "").trim();
          if (t) return t.slice(0, 120);
        }
      }
      // 3. Wrapping <label> ancestor. Strip the input's own value so we
      //    don't echo "email: sid@foo.com" when they type into an
      //    implicitly-labelled field.
      const parent = el.closest && el.closest("label");
      if (parent) {
        const clone = parent.cloneNode(true);
        clone
          .querySelectorAll("input,select,textarea,button")
          .forEach((n) => n.remove());
        const t = (clone.innerText || clone.textContent || "").trim();
        if (t) return t.slice(0, 120);
      }
      // 4. aria-label (also returned separately as ariaLabel; kept here
      //    so consumers get a single canonical "label" field).
      const aria = el.getAttribute && el.getAttribute("aria-label");
      if (aria) return aria.trim().slice(0, 120);
    } catch (_) {}
    return null;
  }

  // ── Semantic container resolution ───────────────────────────────────
  //
  // When the user clicks/types inside a dialog, a table row, a form, or
  // a named region, that container's identity is often the whole point
  // of the action ("Click Download in row GSTR-2A"). We walk up at most
  // CONTAINER_WALK_MAX ancestors, first-match-wins, priority order:
  //   dialog > table-row > form > named-section
  // Named-section returns null if we can't derive a name (unnamed
  // sections are noise).

  /** Extract a short name from a container element (heading / aria). */
  function extractContainerName(node) {
    if (!node || !(node instanceof Element)) return null;
    try {
      // aria-labelledby (resolve references)
      const lb = node.getAttribute && node.getAttribute("aria-labelledby");
      if (lb) {
        const parts = lb
          .split(/\s+/)
          .map((id) => {
            const ref = document.getElementById(id);
            return ref ? (ref.innerText || ref.textContent || "").trim() : "";
          })
          .filter(Boolean);
        if (parts.length) return parts.join(" ").slice(0, CONTAINER_NAME_MAX);
      }
      // aria-label
      const aria = node.getAttribute && node.getAttribute("aria-label");
      if (aria) return aria.trim().slice(0, CONTAINER_NAME_MAX);
      // First heading / legend inside
      const h = node.querySelector(
        "h1, h2, h3, h4, h5, h6, legend, [role=\"heading\"]"
      );
      if (h) {
        const t = (h.innerText || h.textContent || "").trim();
        if (t) return t.slice(0, CONTAINER_NAME_MAX);
      }
    } catch (_) {}
    return null;
  }

  /** Primary identifier text for a <tr> — first cell, inputs/controls stripped. */
  function firstCellText(tr) {
    if (!tr) return null;
    try {
      const cell = tr.querySelector("th, td");
      if (!cell) return null;
      const clone = cell.cloneNode(true);
      clone
        .querySelectorAll("input, select, textarea, button, a")
        .forEach((n) => n.remove());
      const t = (clone.innerText || clone.textContent || "").trim();
      return t ? t.slice(0, CONTAINER_NAME_MAX) : null;
    } catch (_) {}
    return null;
  }

  /** Classify a single ancestor node. Returns null if it's not a container. */
  function classifyContainer(node) {
    if (!node || !(node instanceof Element)) return null;
    try {
      if (node.matches(DIALOG_SEL)) {
        return {
          container: "dialog",
          containerName: extractContainerName(node),
        };
      }
      if (node.matches("tr")) {
        const name = firstCellText(node);
        return { container: "table-row", containerName: name };
      }
      if (node.matches(FORM_SEL)) {
        const name =
          extractContainerName(node) ||
          (node.getAttribute && node.getAttribute("name")) ||
          null;
        return { container: "form", containerName: name };
      }
      if (node.matches(SECTION_SEL)) {
        const name = extractContainerName(node);
        // Unnamed sections are noise — skip.
        if (!name) return null;
        return { container: "section", containerName: name };
      }
    } catch (_) {}
    return null;
  }

  /** Walk up from el (exclusive) to find the first semantic container. */
  function findContainer(el) {
    if (!el || !(el instanceof Element)) return null;
    let node = el.parentElement;
    let depth = 0;
    while (node && node !== document.body && depth < CONTAINER_WALK_MAX) {
      if (containerCache.has(node)) return containerCache.get(node);
      const info = classifyContainer(node);
      if (info) {
        containerCache.set(node, info);
        return info;
      }
      containerCache.set(node, null);
      node = node.parentElement;
      depth++;
    }
    return null;
  }

  /** Extract a compact, replay-useful description of an element. */
  function describeElement(el) {
    if (!el || !(el instanceof Element)) return null;
    const tag = el.tagName ? el.tagName.toLowerCase() : "?";
    const role = el.getAttribute && el.getAttribute("role");
    const ariaLabel = el.getAttribute && el.getAttribute("aria-label");
    const name = el.getAttribute && el.getAttribute("name");
    const id = el.id || null;
    const type = el.getAttribute && el.getAttribute("type");
    const placeholder = el.getAttribute && el.getAttribute("placeholder");
    const href = el.getAttribute && el.getAttribute("href");
    const label = extractLabel(el);
    const container = findContainer(el); // null or { container, containerName }
    // innerText is expensive; limit scope and size
    let text = "";
    try {
      text = (el.innerText || el.textContent || "").trim().slice(0, 80);
    } catch (_) {}
    return {
      tag,
      role: role || null,
      label: label || null,
      ariaLabel: ariaLabel || null,
      name: name || null,
      id,
      type: type || null,
      placeholder: placeholder || null,
      href: href || null,
      text,
      container: container?.container ?? null,
      containerName: container?.containerName ?? null,
    };
  }

  /** Check if a field holds secret data and should be redacted. */
  function isSensitiveField(el) {
    if (!el) return false;
    const type = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return true;
    const name = (el.getAttribute && el.getAttribute("name") || "").toLowerCase();
    const id = (el.id || "").toLowerCase();
    const autocomplete = (
      (el.getAttribute && el.getAttribute("autocomplete")) ||
      ""
    ).toLowerCase();
    const hints = ["password", "passwd", "pwd", "pin", "cvv", "cvc", "otp", "secret"];
    return hints.some(
      (h) => name.includes(h) || id.includes(h) || autocomplete.includes(h)
    );
  }

  // ── Event listeners (all in capture phase so we see events before page handlers cancel them) ──

  // Clicks
  document.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted) return;
      emit("click", {
        target: describeElement(e.target),
        payload: { coords: { x: e.clientX, y: e.clientY } },
      });
    },
    true
  );

  // Input — fired on blur / commit so we get the final value, not every keystroke.
  document.addEventListener(
    "change",
    (e) => {
      if (!e.isTrusted) return;
      const t = e.target;
      if (!t || !("value" in t)) return;
      const sensitive = isSensitiveField(t);
      const raw = String(t.value == null ? "" : t.value);
      emit("input", {
        target: describeElement(t),
        payload: {
          value: sensitive ? "[REDACTED]" : raw.slice(0, 200),
          sensitive,
        },
      });
    },
    true
  );

  // Form submit
  document.addEventListener(
    "submit",
    (e) => {
      if (!e.isTrusted) return;
      emit("submit", {
        target: describeElement(e.target),
      });
    },
    true
  );

  // Meaningful key presses (Enter/Tab/Escape). We deliberately skip
  // character-by-character capture to avoid revealing passwords and noise.
  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.isTrusted) return;
      if (!["Enter", "Escape", "Tab"].includes(e.key)) return;
      const now = Date.now();
      if (now - lastCapture < MIN_CAPTURE_INTERVAL_MS) return;
      lastCapture = now;
      emit("key", {
        target: describeElement(e.target),
        payload: { key: e.key },
      });
    },
    true
  );

  // HTML5 form validation failures. Fires per-field when a submit is
  // blocked by `required`, `pattern`, `type`, etc. This is a high-signal
  // "user hit friction" event — portals like GSTN rely heavily on it.
  document.addEventListener(
    "invalid",
    (e) => {
      if (!e.isTrusted) return;
      const t = e.target;
      if (!t) return;
      let msg = null;
      try {
        msg = (t.validationMessage || "").slice(0, 200) || null;
      } catch (_) {}
      emit("form_invalid", {
        target: describeElement(t),
        payload: { validationMessage: msg },
      });
    },
    true
  );

  // Scroll — debounced. isTrusted isn't reliable on scroll events so we
  // accept some false positives; the agent can filter these later if needed.
  let scrollTimer = null;
  document.addEventListener(
    "scroll",
    () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        emit("scroll", {
          payload: {
            scrollX: Math.round(window.scrollX),
            scrollY: Math.round(window.scrollY),
          },
        });
      }, 500);
    },
    { passive: true, capture: true }
  );

  // ── Outcome-only MutationObserver ───────────────────────────────────
  //
  // We watch for *consequences*: alerts appearing, dialogs opening, page
  // title changing. Everything else — React re-renders, CSS flips,
  // hover-state changes — we deliberately ignore. Observer is
  // { childList: true, subtree: true } on <body>, with per-added-node
  // classification via matches() and querySelector() (native, fast, deep).
  //
  // Attribute observation is intentionally NOT enabled: aria-hidden,
  // aria-busy, display toggles are noisy and low-signal. If a real use
  // case demands them later, scope them narrowly to known elements.

  /** Cheap visibility heuristic: offsetParent + non-zero rect. */
  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    try {
      if (el.offsetParent === null) {
        // Fixed/sticky elements have offsetParent === null but may still be visible.
        const pos = getComputedStyle(el).position;
        if (pos !== "fixed" && pos !== "sticky") return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (_) {
      return false;
    }
  }

  /**
   * Dedup by (kind, first-40-chars-of-text). Prunes expired entries on
   * every call — `recentEmits` stays tiny because the window is short.
   */
  function shouldEmit(kind, text) {
    const now = Date.now();
    // Prune expired
    for (const [k, t] of recentEmits) {
      if (now - t > DEDUP_WINDOW_MS) recentEmits.delete(k);
    }
    const key = `${kind}:${String(text || "").slice(0, 40)}`;
    if (recentEmits.has(key)) return false;
    recentEmits.set(key, now);
    return true;
  }

  /**
   * Find the first matching dialog/alert element in an added subtree.
   * Uses matches() + querySelector() — native, depth-unbounded.
   */
  function classifyAddedNode(node) {
    if (!(node instanceof Element)) return null;
    try {
      let el = node.matches(DIALOG_SEL) ? node : node.querySelector(DIALOG_SEL);
      if (el) return { kind: "page_dialog_opened", el };
      el = node.matches(ALERT_SEL) ? node : node.querySelector(ALERT_SEL);
      if (el) return { kind: "page_alert", el };
    } catch (_) {}
    return null;
  }

  function emitDialogOpened(el) {
    const name = extractContainerName(el);
    if (!shouldEmit("page_dialog_opened", name || "")) return;
    emit("page_dialog_opened", {
      target: describeElement(el),
      payload: { name: name || null },
    });
  }

  function emitAlert(el) {
    let text = "";
    try {
      text = ((el.innerText || el.textContent || "").trim()).slice(
        0,
        ALERT_TEXT_MAX
      );
    } catch (_) {}
    if (!text) return;
    if (!shouldEmit("page_alert", text)) return;
    emit("page_alert", {
      target: describeElement(el),
      payload: { text },
    });
  }

  function handleMutations(records) {
    // Safety valve: if a site dumps a huge batch, bail rather than block.
    if (records.length > MUTATION_RECORD_BAIL) return;
    for (const rec of records) {
      if (rec.type !== "childList") continue;
      for (const node of rec.addedNodes) {
        const hit = classifyAddedNode(node);
        if (!hit) continue;
        if (!isVisible(hit.el)) continue;
        if (hit.kind === "page_dialog_opened") emitDialogOpened(hit.el);
        else if (hit.kind === "page_alert") emitAlert(hit.el);
      }
    }
  }

  function startOutcomeObserver() {
    // One-shot scan for pre-existing visible dialogs. (Alerts that exist
    // at page load are usually stale — skip them.)
    try {
      document.querySelectorAll(DIALOG_SEL).forEach((el) => {
        if (isVisible(el)) emitDialogOpened(el);
      });
    } catch (_) {}

    // Main body observer — childList only, subtree, no attributes.
    try {
      new MutationObserver(handleMutations).observe(document.body, {
        childList: true,
        subtree: true,
      });
    } catch (_) {}

    // Title observer — scoped, so characterData cost is trivial.
    try {
      const titleNode = document.querySelector("title");
      if (titleNode) {
        let lastTitle = document.title;
        new MutationObserver(() => {
          const now = document.title;
          if (now === lastTitle) return;
          lastTitle = now;
          if (!shouldEmit("page_title_changed", now)) return;
          emit("page_title_changed", {
            payload: { title: String(now).slice(0, ALERT_TEXT_MAX) },
          });
        }).observe(titleNode, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startOutcomeObserver, {
      once: true,
    });
  } else {
    startOutcomeObserver();
  }

  // Announce the page itself so the timeline has context when the user
  // opens the sidepanel mid-session.
  emit("page_ready", {
    payload: { readyState: document.readyState },
  });
})();
