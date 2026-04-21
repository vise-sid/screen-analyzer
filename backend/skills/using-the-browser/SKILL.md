---
name: using-the-browser
description: Drives a real Chrome browser via Playwright. Read this BEFORE the first navigate / observe / click / type / scrape / popup / cookies call in any session that touches a website — login flows, scraping, form filling, clicking through web UIs, dismissing modals, or capturing/restoring session state. Contains canonical recipes (login with captcha, fill a form, dismiss popup, scrape a table, mine network) you should copy verbatim, plus the structured locator API. Aim for ≤8 turns per task by using the recipes in one code-execution block.
---

# Using the browser

## START HERE — copy these recipes verbatim

Each recipe is a single Python block. Paste into ONE code-execution call, fill the parameters, run.

### Recipe: pick the right tab BEFORE navigating

The user may have the target site loaded already. Reuse it instead of opening a new tab.

```python
tabs = await list_tabs()
target_host = "gst.gov.in"  # set this for your task
match = next((t for t in tabs["tabs"] if target_host in t["url"]), None)
if match:
    await switch_tab(tab_id=match["id"])
    snap = await observe(include=["snapshot"])
else:
    await navigate(url=f"https://{target_host}/...")
    snap = await observe(include=["snapshot"])
```

### Recipe: log into a site (with optional captcha)

```python
LOGIN_URL = "https://services.gst.gov.in/services/login"
USERNAME_SECRET = "GST_TEST_USERNAME"
PASSWORD_SECRET = "GST_TEST_PASSWORD"
USERNAME_PLACEHOLDER = "Enter Username"
PASSWORD_PLACEHOLDER = "Enter Password"
CAPTCHA_INPUT_PLACEHOLDER = "Enter Characters shown below"  # None if no captcha
SUBMIT_BUTTON_NAME = "LOGIN"
SUCCESS_URL_FRAGMENT = "/dashboard"

# 1. Navigate + observe
await navigate(url=LOGIN_URL)
snap = await observe(include=["snapshot"])

# 1a. Open the nav hamburger if the site uses one (IRCTC, gov sites, …)
if snap.get("nav_hamburger"):
    await popup(action="open_nav")
    snap = await observe(include=["snapshot"])

# 1b. Dismiss blocking popups — but ONLY if they don't contain input fields
if snap.get("popup"):
    snap_text = snap["snapshot"]
    if not any(k in snap_text for k in ("textbox", "Username", "Password", "Email")):
        await popup(action="dismiss")
        snap = await observe(include=["snapshot"])
    # else: the popup IS our login form, leave it open

# 1c. Click LOGIN if it's still needed (after opening nav, LOGIN may now be visible)
if "LOGIN" in snap["snapshot"] and "Password" not in snap["snapshot"]:
    await click(by="role", role="link", name="LOGIN")
    snap = await observe(include=["snapshot"])

# 2. Fetch creds (sandbox-only; never enter chat context)
user = (await secret(name=USERNAME_SECRET))["value"]
pwd  = (await secret(name=PASSWORD_SECRET))["value"]

# 3. Fill username + password
r1 = await type(by="placeholder", name=USERNAME_PLACEHOLDER, text=user)
r2 = await type(by="placeholder", name=PASSWORD_PLACEHOLDER, text=pwd)
assert r1["ok"] and r2["ok"], f"username/password type failed: {r1}, {r2}"

# 4. Captcha — only if this site has one
if CAPTCHA_INPUT_PLACEHOLDER:
    shot = await observe(include=["screenshot"])
    captcha = await vision(task="captcha", image_b64=shot["screenshot_b64"])
    assert captcha["ok"], f"vision could not read captcha: {captcha.get('error')}"
    r3 = await type(by="placeholder", name=CAPTCHA_INPUT_PLACEHOLDER, text=captcha["answer"])
    assert r3["ok"], f"captcha type failed: {r3}"

# 5. Submit + wait for URL change
await click(by="role", role="button", name=SUBMIT_BUTTON_NAME)
landed = await wait_for(url_pattern=SUCCESS_URL_FRAGMENT, timeout_ms=10000)

# 6. Final state — one observe with screenshot for terminal evidence
final = await observe(include=["snapshot", "screenshot"])
print("LOGGED IN:" if landed["ok"] else "LOGIN FAILED:", final["url"])
```

### Recipe: dismiss any popup / cookie banner

`observe()` returns a `popup` field when one is detected. Dispatch handles 95% of cases.

```python
snap = await observe(include=["snapshot"])
if snap.get("popup"):
    r = await popup(action="dismiss")
    # r['strategy'] is one of: 'close_button', 'x_button', 'escape'
    # If 'escape' fired, the popup may still be there — re-observe.
    if r["strategy"] == "escape":
        snap = await observe(include=["snapshot"])
```

### Recipe: handle a checkbox captcha (Turnstile / reCAPTCHA v2 / hCaptcha)

```python
snap = await observe(include=["snapshot"])
cap = snap.get("captcha")
if cap and cap["type"] in ("Cloudflare Turnstile", "reCAPTCHA v2", "hCaptcha"):
    r = await popup(action="click_captcha")
    # Wait briefly for the challenge to settle
    await wait_for(load_state="networkidle", timeout_ms=8000)
    snap2 = await observe(include=["snapshot"])
elif cap:  # image/text captcha — needs vision pipeline
    shot = await observe(include=["screenshot"])
    answer = (await vision(task="captcha", image_b64=shot["screenshot_b64"]))["answer"]
    await type(by="placeholder", name="Enter the characters", text=answer)
```

### Recipe: scrape a table to JSON

`scrape(kind="table")` is dramatically better than parsing aria YAML mentally.

```python
await navigate(url=URL_WITH_TABLE)
t = await scrape(kind="table")  # or pass selector="table.data" for a specific one
# t = {"ok": True, "headers": [...], "rows": [{...}, ...], "row_count": N}
for row in t["rows"][:5]:
    print(row)
```

### Recipe: mine the network for already-fetched JSON (often beats re-scraping HTML)

Many SPAs render data they fetched via XHR/Fetch. Capture is auto-on — just navigate and read.

```python
await navigate(url=APP_URL)
await wait_for(load_state="networkidle", timeout_ms=8000)
caps = await scrape(kind="network", max=20)
# caps = {"requests": [{url, status, mime, body}, ...], "count, "total_captured"}
import json
api_hits = [r for r in caps["requests"] if "/api/" in r["url"] and r["status"] == 200]
for r in api_hits[:3]:
    try:
        data = json.loads(r["body"])
        print(r["url"], "→", list(data.keys()) if isinstance(data, dict) else f"len={len(data)}")
    except Exception:
        pass
```

### Recipe: extract metadata + links from an article

```python
await navigate(url=ARTICLE_URL)
meta = (await scrape(kind="metadata"))["metadata"]
links = (await scrape(kind="links"))["links"]
print(meta.get("title"), "by", meta.get("author"), "·", meta.get("published_time"))
print(f"{len(links)} outbound links")
```

### Recipe: snapshot + restore a logged-in session

```python
# After successful login, capture cookies for re-use:
saved = await cookies(action="extract", url="https://services.gst.gov.in")
# … later in this or another session:
await cookies(action="inject", cookies=saved["cookies"])
await navigate(url="https://services.gst.gov.in/services/auth/dashboard")
# Skip the login flow entirely if cookies are still valid.
```

### Recipe: fill a Google-Sheets-style canvas grid

DOM locators don't reach canvas-rendered cells. Use keyboard navigation.

```python
# Click into the starting cell first (e.g. A1), then type+Tab/Enter rest.
await fill_cells(
    values=["Q1", "Q2", "Q3", "Q4"],
    direction="right",  # Tab between cells; use "down" for Enter between cells
    start_locator={"by": "css", "selector": "[aria-label='A1']"},
)
```

### Recipe: fill any HTML form

```python
await navigate(url=FORM_URL)
snap = await observe(include=["snapshot"])
fields = [("Email", "user@example.com"), ("Phone", "555-1234")]
for placeholder, value in fields:
    r = await type(by="placeholder", name=placeholder, text=value)
    assert r["ok"], f"{placeholder} fill failed: {r}"
await click(by="role", role="button", name="Submit")
```

## Hamburger navigation (CRITICAL — read this before clicking LOGIN/REGISTER)

The browser attaches at a forced **1280×800 desktop viewport**. But many sites — IRCTC, most Indian gov sites, lots of modern SPAs — use a hamburger nav at ALL widths, not just narrow. LOGIN / REGISTER / Account are HIDDEN inside it until you click the toggle.

**`observe()` now surfaces this for you.** Check `observe.nav_hamburger`:

```python
snap = await observe(include=["snapshot"])
if snap.get("nav_hamburger"):
    # Open the menu BEFORE looking for nav items
    await popup(action="open_nav")
    snap = await observe(include=["snapshot"])  # now LOGIN/REGISTER are visible
```

**If `nav_hamburger` is null but you still can't find a nav item you expected,** the snapshot may have missed a non-standard hamburger. Manual discovery, in this order, **one selector at a time**:

```python
# 1) Semantic — most modern sites
await click(by="role", role="button", name="menu")
# 2) ARIA label
await click(by="css", selector="[aria-label*='menu' i]")
# 3) Bootstrap default
await click(by="css", selector=".navbar-toggler")
# 4) Last resort — find the real class via HTML scrape
html = (await scrape(kind="page_html"))["html"]
# grep for: 'toggler', 'hamburger', 'menu-icon', 'nav-toggle'
```

**NEVER comma-OR multiple guessed CSS selectors** (`".hamberger, .hamburger, .menu-toggle"`). If your first guess is wrong the rest are likely also wrong — that's shotgunning, not investigating.

## Login-as-modal pattern (IRCTC, gov sites, many SPAs)

Many sites open login as a **MODAL on the same page**, not a navigation to a new URL. After clicking LOGIN:

```python
await click(by="role", role="link", name="LOGIN")
snap = await observe(include=["snapshot"])

if snap.get("popup"):
    # CRITICAL: does the popup contain INPUT FIELDS?
    snap_text = snap["snapshot"]
    has_inputs = any(k in snap_text for k in ("textbox", "Username", "User ID", "Password", "Email"))
    if has_inputs:
        # This IS the login form. DO NOT dismiss. Fill it.
        await type(by="placeholder", name="User Name", text=user)
        await type(by="placeholder", name="Password", text=pwd)
    else:
        # Real blocker (cookie banner, app promo, ad). Dismiss and continue.
        await popup(action="dismiss")
```

**Rule of thumb: popups that contain input fields are usually GOAL modals, not blocking modals.** Auto-dismissing them undoes your own progress.

## Loop-detection guard

If you call the same tool with identical args **3 times in a row**, the backend will return `{ok: false, loop_detected: true}` instead of dispatching. This is a hard signal that your strategy isn't working — change approach. Common triggers:
- Re-scraping HTML hoping for different output (it's the same page; the result will be the same)
- Re-observing without acting in between (the snapshot doesn't change without an action)
- Repeating the same failing click (the element isn't where you think)

When you hit this: re-read `observe.popup` / `observe.nav_hamburger`, try a DIFFERENT `by` strategy, or report the blocker and stop.

## What `observe()` gives you (read this — it changes how you act)

```
{
  "ok": true,
  "url": "...",
  "title": "...",
  "snapshot": "<aria YAML — semantic tree>",  # if include=['snapshot']
  "screenshot_b64": "...",                     # if include=['screenshot']
  "popup": {"type": "dialog", "rect": {...}, "closeButton": {...}} | null,
  "captcha": {"type": "reCAPTCHA v2"|"Cloudflare Turnstile"|"hCaptcha"|"CAPTCHA (image/text)", ...} | null,
  "nav_hamburger": {"selector": "...", "rect": {...}, "clickTarget": {x,y}, "reason": "..."} | null,
  "is_canvas_heavy": true|false,   # Sheets/Docs/Slides → DOM tools won't work, use fill_cells
  "page_loading": true|false,      # if true: await wait_for(load_state='networkidle')
  "page_scroll": {"scrollTop", "scrollPct", "canScrollDown", "canScrollUp"},
  "scroll_containers": [{"label", "scrollTop", "canScrollDown", ...}],
  "viewport": {"width", "height"}
}
```

**After every observe, check in this order: `nav_hamburger` → `popup` → `captcha`**. If `nav_hamburger` is non-null and you need a nav item (LOGIN, REGISTER, Account, etc.), open it first via `popup(action="open_nav")`. If `popup` is non-null and contains input fields, that's likely your goal modal — don't dismiss. If `captcha` is non-null, handle it before clicking submit.

## Locator API — the action verbs

Every action that targets an element (`click`, `double_click`, `hover`, `type`, `wait_for`) takes:

| `by` | Maps to | Use for |
|---|---|---|
| `"placeholder"` | `getByPlaceholder(name)` | **Default for input fields** |
| `"role"` + `role` + `name` | `getByRole(role, {name})` | Buttons, links, headings, checkboxes |
| `"label"` | `getByLabel(name)` | Inputs with `<label>` |
| `"text"` | `getByText(name)` | Plain content |
| `"testid"` | `getByTestId(name)` | When data-testid exists |
| `"css"` + `selector` | `locator(selector)` | Escape hatch |

Optional: `exact: true` for strict matching, `n: <int>` to pick the nth match.

## Action verb reference

| Verb | When |
|---|---|
| `click(by=…)` | Click anything once. Returns `url_changed` + new `url`. |
| `double_click(by=…)` | Open file in tree, select word, expand row. |
| `hover(by=…)` | Reveal hover-only menus/tooltips — pair with `observe()` after. |
| `type(by=…, text=…, submit=False)` | Real keystrokes + length verify. `submit=True` presses Enter after. |
| `key(key="Enter"\|"Escape"\|...)` | One key on the active element. |
| `key_combo(combo="Control+a")` | Shortcut combos. Use Meta on macOS, Control on Windows/Linux. |
| `scroll(deltaY=600)` | Scroll the page. |
| `back()` / `forward()` | Browser history navigation. |
| `wait_for(...)` | URL fragment, load_state, or locator state. |
| `fill_cells(values=[...], direction='right'\|'down', start_locator=…)` | Canvas-grid keyboard fill. |
| `popup(action='dismiss'\|'open_nav'\|'click_captcha')` | Dismiss blocking popups, open nav hamburger, or click checkbox captchas. |
| `dialog(action='accept'\|'dismiss', text=…)` | Override the auto-handler for a specific upcoming JS dialog. |
| `cookies(action='extract'\|'inject', url=…, cookies=[…])` | Snapshot/restore session cookies. |
| `scrape(kind='page_html'\|'table'\|'links'\|'metadata'\|'network', selector=…, max=…)` | Structured extraction. |

## Native JS dialogs (alert / confirm / prompt) — auto-handled

The backend auto-accepts `beforeunload` + `alert` and dismisses `confirm` + `prompt`. You usually do nothing. To override for a specific upcoming action:

```python
# Two separate code blocks: arm the dialog handler, then trigger it.
import asyncio
async def fire_with_accept():
    arm = asyncio.create_task(dialog(action="accept", text="confirmed"))
    await click(by="role", role="button", name="Delete")
    return await arm
result = await fire_with_accept()
```

## When to observe

- After `navigate()` — once.
- After an action that should have changed the page shape (typing username that triggers a captcha, clicking that opens a modal) — once.
- When `type` or `click` returned `ok:false` and you need to see the new state — once.

NOT after every action. NOT to "verify". Primitives verify themselves.

## When to use screenshot

- Captcha (must give to `vision`).
- Visual layout questions you can't answer from snapshot.
- Final terminal evidence for `report`.

NOT to verify text typed correctly. NOT to "see what's there" — snapshot shows that.

## When type/click returns ok:false

1. Re-observe ONCE.
2. Pick a different `by`. If `placeholder` failed, try `label` or `role`+`name` from the new snapshot.
3. After two distinct `by` strategies fail on the same element, stop and report.

## What NEVER goes in chat

Passwords, tokens, captcha solutions in human-readable form, cookie values, anything from `secret()` / `vision()` / `cookies(action='extract')`. Reference these as Python variables in code blocks only.
