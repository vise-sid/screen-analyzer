# Skills

Each subdirectory is one skill, uploaded to Anthropic's Skills API and referenced by `skill_id` from `_registry.json`.

## Layout

```
backend/skills/
  _registry.json                 (skill_name → skill_id, committed)
  README.md                      (this file)
  <gerund-name>/
    SKILL.md                     (frontmatter + body, ≤500 lines)
    helpers.py                   (optional async helpers the agent imports)
    reference/                   (optional, one level deep from SKILL.md)
      *.md
```

## Authoring rules (Anthropic best-practices)

- Names: gerund form, lowercase + hyphens, ≤64 chars (e.g. `logging-to-sheets`).
- Description: third person, both **what** and **when**, ≤1024 chars. This is the entire signal for skill discovery.
- Body: ≤500 lines. Split into reference files if longer.
- References: one level deep from SKILL.md.
- Concise — assume Claude knows Python, HTTP, OAuth.
- No time-sensitive info, no magic numbers without justification.
- Forward slashes only.
- Helpers solve, don't punt — handle errors in the helper.
- **Container has no network access.** All I/O goes through our primitive tools (`workspace()`, `navigate()`, `observe()`, `vision()`). No `import requests` or direct API calls.

## Upload workflow

```bash
# Upload all skills, update _registry.json
python scripts/upload_skills.py

# Upload one skill (forces a new version)
python scripts/upload_skills.py --skill logging-to-sheets

# Dry run — show what would happen
python scripts/upload_skills.py --dry-run
```

Dev uses `version: "latest"`. Prod pins to specific versions from the registry.
