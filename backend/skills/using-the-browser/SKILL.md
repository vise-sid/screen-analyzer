---
name: using-the-browser
description: Drives a real Chrome browser via Playwright. Read this BEFORE the first navigate / observe / click / type in any session that touches a website — login flows, scraping, form filling, clicking through web UIs. Contains canonical recipes (login with captcha, fill a form, extract a list) you should copy verbatim, plus the structured locator API. Aim for ≤8 turns per task by using the recipes in one code-execution block.
---

# Using the browser

## START HERE — copy these recipes verbatim

Each recipe is a single Python block. Paste into ONE code-execution call, fill the parameters, run.

### Recipe: pick the right tab BEFORE navigating

Always check what's already open. The user may have the target site loaded in an existing tab; reuse it instead of opening a new one.

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

This pattern is short enough to inline at the top of any session that touches a real-world site.


### Recipe: log into a site (with optional captcha)

```python
# Checklist (copy this into chat as you progress):
# [ ] Navigate to login URL
# [ ] Fetch credentials from secret store
# [ ] Type username (placeholder selector preferred)
# [ ] Type password
# [ ] If captcha appears: screenshot + vision + type
# [ ] Click submit, wait for URL to change
# [ ] One final observe to confirm

# Parameters to set for this site:
LOGIN_URL = "https://services.gst.gov.in/services/login"
USERNAME_SECRET = "GST_TEST_USERNAME"
PASSWORD_SECRET = "GST_TEST_PASSWORD"
USERNAME_PLACEHOLDER = "Enter Username"
PASSWORD_PLACEHOLDER = "Enter Password"
CAPTCHA_INPUT_PLACEHOLDER = "Enter Characters shown below"  # set to None if no captcha
SUBMIT_BUTTON_NAME = "LOGIN"
SUCCESS_URL_FRAGMENT = "/dashboard"  # or "/welcome", "/home" — whatever the post-login URL contains

# 1. Navigate + observe (one snapshot, no screenshot needed yet)
await navigate(url=LOGIN_URL)
snap = await observe(include=["snapshot"])
print(snap["snapshot"][:600])

# 2. Fetch creds (sandbox-only; never enter chat context)
user = (await secret(name=USERNAME_SECRET))["value"]
pwd  = (await secret(name=PASSWORD_SECRET))["value"]

# 3. Fill username + password. type() verifies length match; check ok.
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

### Recipe: fill any form

```python
await navigate(url=FORM_URL)
snap = await observe(include=["snapshot"])
print(snap["snapshot"][:800])

# Build a list of (placeholder, value) pairs from what the snapshot shows.
fields = [
    ("Email", "user@example.com"),
    ("Phone", "555-1234"),
    # ...
]
for placeholder, value in fields:
    r = await type(by="placeholder", name=placeholder, text=value)
    assert r["ok"], f"{placeholder} fill failed: {r}"

await click(by="role", role="button", name="Submit")
```

### Recipe: extract a list of items

```python
await navigate(url=LIST_URL)
# Snapshot shows YAML structure including all visible items.
snap = await observe(include=["snapshot"])
# Parse the YAML in your head and extract the items you need.
# For complex pages, scroll then re-observe:
await scroll(deltaY=600)
more = await observe(include=["snapshot"])
```

## Locator API — when recipes don't fit

Every action that targets an element (`click`, `type`, `wait_for`) takes:

| `by` | Maps to | Use for |
|---|---|---|
| `"placeholder"` | `getByPlaceholder(name)` | **Default for input fields** |
| `"role"` + `role` + `name` | `getByRole(role, {name})` | Buttons, links, headings |
| `"label"` | `getByLabel(name)` | Inputs with `<label>` |
| `"text"` | `getByText(name)` | Plain content |
| `"testid"` | `getByTestId(name)` | When data-testid exists |
| `"css"` + `selector` | `locator(selector)` | Escape hatch |

Optional: `exact: true` for strict matching, `n: <int>` to pick the nth match.

## When to observe

- After `navigate()` — once.
- After an action that should have changed the page shape (typing username that triggers a captcha, clicking that opens a modal) — once.
- When a `type` or `click` returned `ok:false` and you need to see the new state — once.

NOT after every action. NOT to "verify". Primitives verify themselves.

## When to use screenshot

- Captcha (must give to `vision`).
- Visual layout questions you can't answer from snapshot.
- Final terminal evidence for `report`.

NOT to verify text typed correctly. NOT to "see what's there" — snapshot shows that.

## When type/click returns ok:false

1. Re-observe ONCE.
2. Pick a different `by`. If `placeholder` failed, try `label` or `role`+`name` from the new snapshot.
3. After two distinct `by` strategies fail on the same element, stop and report. The element isn't where you think it is.

## What NEVER goes in chat

Passwords, tokens, captcha solutions in human-readable form, anything from `secret()` or `vision()`. Reference these as Python variables in code blocks.
