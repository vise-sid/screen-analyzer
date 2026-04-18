# PixelFoxx — Design System (Claude Code)

This project uses a custom pixel-aesthetic design system. Read this before touching any UI files.

## Visual Rules — Non-negotiable

1. **No `border-radius` anywhere.** Use `clip-path: var(--px)` on every card, button, input, chip.
2. **No Poppins / Inter / system-ui for UI.** Font stack: `Space Grotesk` (UI), `Silkscreen` (pixel headers/numbers), `JetBrains Mono` (timestamps, chips, labels, logs).
3. **No gradients on brand colors.** Subtle surface-on-surface gradients OK. Never orange→yellow.
4. **Orange is the one primary accent.** Pick one support color max (yellow OR blue). Semantic ok/warn/err are free.
5. **Foxx speaks lowercase.** All copy attributed to the agent: lowercase, short sentences, dry tone.
6. **Use first name after sign-in.** `anna` not `partner`. `partner` is the pre-auth fallback.

## Token Reference

```css
--bg: #14110E        /* body background */
--surface: #1C1916   /* cards, header, footer */
--surface-2: #231F1A /* todo strip, hover states */
--surface-3: #2A2520 /* deep insets */
--line: #3A352D      /* borders */
--line-2: #4A4338    /* secondary borders */

--text: #F4EFE6      /* primary text */
--text-dim: #A89E8D  /* secondary text */
--text-mute: #6B6357 /* muted labels */

--orange: #FF6A1A    /* primary CTA, active state */
--orange-dk: #CC4D00 /* pressed orange */
--yellow: #FFC83D    /* warnings, variables, paused */
--blue: #4FB3D9      /* info, nav actions */
--ok: #7FD46B        /* success */
--err: #FF5A4E       /* errors */

--px: polygon(0 3px,3px 3px,3px 0,calc(100% - 3px) 0,calc(100% - 3px) 3px,100% 3px,100% calc(100% - 3px),calc(100% - 3px) calc(100% - 3px),calc(100% - 3px) 100%,3px 100%,3px calc(100% - 3px),0 calc(100% - 3px))
```

## File Map — UI only

| File | Role |
|------|------|
| `extension/sidepanel.css` | All styles — full replacement done in v2 |
| `extension/sidepanel.html` | Shell + view markup — minimal changes only |
| `extension/sidepanel.js` | Logic — 5 targeted patches (see handoff/) |

**Never touch:** `auth.js`, `actions.js`, `background.js`, `cookies.js`, `tabs.js`, `manifest.json`

## Handoff Files

Full specs live in `handoff/`:
- `DESIGN_HANDOFF.md` — complete component spec with CSS for every element
- `sidepanel-v2.css` — drop-in replacement for `extension/sidepanel.css`
- `sidepanel-js-patches.js` — 5 targeted JS changes with before/after

## Chat Bubble Types

| Class | Usage |
|-------|-------|
| `.chat-bubble.user` | Orange block, right-aligned |
| `.chat-bubble.assistant` | Surface bg + "FOXX >" mono label |
| `.chat-bubble.action` | Tool call — type chip + mono body |
| `.chat-bubble.thinking` | 3 pulsing orange squares |
| `.chat-bubble.system` | Centered mono caps |
| `.chat-bubble.error` | Red left-border, no clip-path |
| `.chat-bubble.approval` | Yellow border, go/hold buttons |

## Action Tag Colors

| Action prefix | Chip label | Color |
|--------------|-----------|-------|
| navigate | NAV | #4FB3D9 |
| click* | CLK | #FF6A1A |
| type / focus_and_type | IN | #FFC83D |
| scrape_* / extract_* | SCRP | #FFC83D |
| verify | VFY | #7FD46B |
| wait | WAIT | #4A4338 |
| key* | KEY | #6B6357 |
| *_tab | TAB | #4FB3D9 |
| sheets/docs/slides | GOOG | #4FB3D9 |
| default | ACT | #6B6357 |
