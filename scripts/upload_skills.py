"""
Skill upload script — uploads skill folders under backend/skills/ to
Anthropic's Skills API. First time creates the skill; subsequent runs
create a new version. The returned skill_id is recorded in
backend/skills/_registry.json so the agent can reference it.

Usage:
  python scripts/upload_skills.py                  # all skills
  python scripts/upload_skills.py --skill <name>   # one skill (forces new version)
  python scripts/upload_skills.py --dry-run        # show plan, no upload
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from anthropic import Anthropic
from anthropic.lib import files_from_dir

ROOT = Path(__file__).parent.parent
SKILLS_DIR = ROOT / "backend" / "skills"
REGISTRY_PATH = SKILLS_DIR / "_registry.json"

BETAS = ["skills-2025-10-02"]


def load_registry() -> dict:
    if REGISTRY_PATH.exists():
        try:
            return json.loads(REGISTRY_PATH.read_text())
        except json.JSONDecodeError:
            pass
    return {"_comment": "skill_name → skill_id (committed)", "skills": {}}


def save_registry(reg: dict) -> None:
    REGISTRY_PATH.write_text(json.dumps(reg, indent=2) + "\n")


def find_skills() -> list[Path]:
    return sorted(
        p for p in SKILLS_DIR.iterdir()
        if p.is_dir() and not p.name.startswith("_") and (p / "SKILL.md").exists()
    )


def parse_skill_meta(skill_dir: Path) -> tuple[str, str]:
    """Read name + description from SKILL.md frontmatter."""
    text = (skill_dir / "SKILL.md").read_text()
    name = skill_dir.name
    description = ""
    if text.startswith("---"):
        end = text.find("---", 3)
        if end > 0:
            for line in text[3:end].splitlines():
                line = line.strip()
                if line.startswith("name:"):
                    name = line.split(":", 1)[1].strip()
                elif line.startswith("description:"):
                    description = line.split(":", 1)[1].strip()
    return name, description


def upload_one(client: Anthropic, skill_dir: Path, registry: dict, dry_run: bool) -> None:
    name, description = parse_skill_meta(skill_dir)
    display_title = description[:60] if description else name
    existing_id = registry.get("skills", {}).get(name)

    if dry_run:
        action = "create new version" if existing_id else "create new skill"
        print(f"  [{action}] {name}")
        print(f"     dir:        {skill_dir}")
        print(f"     existing:   {existing_id or '(none)'}")
        print(f"     title:      {display_title!r}")
        return

    files = files_from_dir(str(skill_dir))
    if existing_id:
        version = client.beta.skills.versions.create(
            skill_id=existing_id,
            files=files,
            betas=BETAS,
        )
        print(f"  ↑ {name}: new version {version.version} on existing skill {existing_id}")
    else:
        skill = client.beta.skills.create(
            display_title=display_title,
            files=files,
            betas=BETAS,
        )
        registry.setdefault("skills", {})[name] = skill.id
        print(f"  + {name}: created skill {skill.id} (version {skill.latest_version})")
        save_registry(registry)


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
        return 0

    registry = load_registry()
    print(f"Found {len(skills)} skill(s):")
    for s in skills:
        print(f"  - {s.name}")
    print()

    if not args.dry_run and not os.environ.get("ANTHROPIC_API_KEY"):
        print("ANTHROPIC_API_KEY missing — source backend/.env first", file=sys.stderr)
        return 2

    client = None if args.dry_run else Anthropic()
    for s in skills:
        upload_one(client, s, registry, args.dry_run)

    if not args.dry_run:
        save_registry(registry)
        print(f"\nRegistry saved → {REGISTRY_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
