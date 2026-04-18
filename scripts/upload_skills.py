"""
Skill upload script — builds + uploads each skill folder under backend/skills/
to Anthropic's Skills API, updates backend/skills/_registry.json with the
returned skill_ids.

Usage:
  python scripts/upload_skills.py                  # all skills
  python scripts/upload_skills.py --skill <name>   # one skill (forces new version)
  python scripts/upload_skills.py --dry-run        # show what would happen, no upload
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from io import BytesIO
from pathlib import Path

# Skeleton — actual upload wiring comes in the next commit. The shape:
#   1. Find all skill folders under backend/skills/ (skip _registry.json, README, _*).
#   2. For each: read SKILL.md frontmatter to get the canonical name.
#   3. Zip the folder in-memory.
#   4. If skill_name in registry: client.beta.skills.versions.create(...)
#      Else: client.beta.skills.create(display_title=...) → records skill_id.
#   5. Write registry back to disk.

ROOT = Path(__file__).parent.parent
SKILLS_DIR = ROOT / "backend" / "skills"
REGISTRY_PATH = SKILLS_DIR / "_registry.json"


def find_skills() -> list[Path]:
    return sorted(
        p for p in SKILLS_DIR.iterdir()
        if p.is_dir() and not p.name.startswith("_") and (p / "SKILL.md").exists()
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill", help="Upload only this skill name")
    parser.add_argument("--dry-run", action="store_true", help="Show plan, don't upload")
    args = parser.parse_args()

    skills = find_skills()
    if args.skill:
        skills = [s for s in skills if s.name == args.skill]
        if not skills:
            print(f"No skill named '{args.skill}' under {SKILLS_DIR}", file=sys.stderr)
            return 1

    if not skills:
        print(f"No skills found under {SKILLS_DIR}.")
        print("Create a skill folder with SKILL.md and re-run.")
        return 0

    print(f"Found {len(skills)} skill(s):")
    for s in skills:
        print(f"  - {s.name}")

    if args.dry_run:
        print("\n(dry run — no upload)")
        return 0

    print("\n[upload not yet implemented — wire to anthropic.beta.skills in next commit]")
    return 0


if __name__ == "__main__":
    sys.exit(main())
