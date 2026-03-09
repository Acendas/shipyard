#!/usr/bin/env python3
"""Shipyard eval runner — static analysis + assertion checking for all skills, agents, and rules.

Usage:
    python3 tests/eval-run.py              # Run all checks
    python3 tests/eval-run.py --skill X    # Run checks for one skill
    python3 tests/eval-run.py --verbose    # Show passing assertions too

Checks:
    1. YAML frontmatter validity (all skills, agents, rules)
    2. Required frontmatter fields present
    3. File references resolve (paths mentioned in skills exist)
    4. Banned patterns (git push, sprint/NNN, squash, etc.)
    5. Per-skill assertions from tests/assertions/*.json
    6. Cross-file consistency (skills reference agents that exist, etc.)
    7. Hook script syntax check
"""

import json
import os
import re
import sys
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SKILLS_DIR = PROJECT_ROOT / "skills"
AGENTS_DIR = PROJECT_ROOT / "agents"
RULES_DIR = PROJECT_ROOT / "project-files" / "rules"
SCRIPTS_DIR = PROJECT_ROOT / "project-files" / "scripts"
TEMPLATES_DIR = PROJECT_ROOT / "project-files" / "templates"
HOOKS_DIR = PROJECT_ROOT / "hooks"
ASSERTIONS_DIR = Path(__file__).resolve().parent / "assertions"


class Result:
    def __init__(self):
        self.passed = []
        self.failed = []
        self.warnings = []

    def ok(self, check, detail=""):
        self.passed.append((check, detail))

    def fail(self, check, detail=""):
        self.failed.append((check, detail))

    def warn(self, check, detail=""):
        self.warnings.append((check, detail))

    @property
    def total(self):
        return len(self.passed) + len(self.failed)


def parse_frontmatter(filepath):
    """Extract YAML frontmatter from a markdown file."""
    try:
        text = filepath.read_text(encoding='utf-8')
    except Exception as e:
        return None, str(e)

    match = re.match(r'^---\s*\n(.*?)\n---', text, re.DOTALL)
    if not match:
        return None, "no frontmatter found"

    fm = {}
    for line in match.group(1).split('\n'):
        line = line.strip()
        if ':' in line and not line.startswith('#'):
            key, _, val = line.partition(':')
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            # Handle YAML lists on same line
            if val.startswith('[') and val.endswith(']'):
                val = [v.strip().strip('"').strip("'") for v in val[1:-1].split(',') if v.strip()]
            fm[key] = val
    return fm, None


def find_all_files(directory, pattern="*.md"):
    """Recursively find files matching pattern."""
    return list(directory.rglob(pattern))


def read_file(filepath):
    """Read file contents, return empty string on error."""
    try:
        return filepath.read_text(encoding='utf-8')
    except Exception:
        return ""


# ─── Check 1: Frontmatter validity ───

def check_frontmatter(result):
    """Validate YAML frontmatter on all skills, agents, rules."""

    # Skills
    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir() or not skill_dir.name.startswith("ship-"):
            continue
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            result.fail(f"skill:{skill_dir.name}", "SKILL.md missing")
            continue

        fm, err = parse_frontmatter(skill_file)
        if err:
            result.fail(f"skill:{skill_dir.name}:frontmatter", err)
            continue

        # Required fields
        for field in ["name", "description"]:
            if field in fm:
                result.ok(f"skill:{skill_dir.name}:has_{field}")
            else:
                result.fail(f"skill:{skill_dir.name}:has_{field}", f"missing '{field}' in frontmatter")

        # Name matches directory
        if fm.get("name") == skill_dir.name:
            result.ok(f"skill:{skill_dir.name}:name_matches_dir")
        else:
            result.fail(f"skill:{skill_dir.name}:name_matches_dir",
                        f"frontmatter name '{fm.get('name')}' != dir '{skill_dir.name}'")

    # Agents
    for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
        fm, err = parse_frontmatter(agent_file)
        if err:
            result.fail(f"agent:{agent_file.stem}:frontmatter", err)
            continue
        for field in ["name", "description"]:
            if field in fm:
                result.ok(f"agent:{agent_file.stem}:has_{field}")
            else:
                result.fail(f"agent:{agent_file.stem}:has_{field}", f"missing '{field}'")

    # Rules
    for rule_file in sorted(RULES_DIR.glob("shipyard-*.md")):
        fm, err = parse_frontmatter(rule_file)
        if err:
            result.fail(f"rule:{rule_file.stem}:frontmatter", err)
            continue
        if "paths" in fm:
            result.ok(f"rule:{rule_file.stem}:has_paths")
        elif "alwaysApply" in fm:
            result.ok(f"rule:{rule_file.stem}:alwaysApply")
        else:
            result.warn(f"rule:{rule_file.stem}:has_paths", "no paths field and no alwaysApply — rule may not load")


# ─── Check 2: Banned patterns ───

BANNED_PATTERNS = [
    (r'\bgit\s+push\b', "git push — Shipyard never pushes"),
    (r'\bsprint/NNN\b', "sprint/NNN — no sprint branches"),
    (r'\bgit\s+merge\s+--squash\b', "git merge --squash — user handles merge strategy"),
    (r'\bsquash-merge\b', "squash-merge — user handles merge strategy"),
    (r'\bgh\s+pr\s+create\b', "gh pr create — Shipyard doesn't create PRs"),
    (r'\bgit\.sprint_branch\b', "git.sprint_branch config — removed"),
    (r'\bgit\.merge_strategy\b', "git.merge_strategy config — removed"),
    (r'\bgit\.pr_on_sprint_complete\b', "git.pr_on_sprint_complete config — removed"),
    (r'\bgit\.integration_branch\b', "git.integration_branch config — removed"),
]

# Files exempt from banned pattern checks
EXEMPT_FILES = {
    "eval-run.py",  # this file
    "git-strategy.md",  # documents what we DON'T do — references banned terms in negation
}


def check_banned_patterns(result):
    """Check for patterns that should no longer exist after git simplification."""

    all_files = []
    all_files.extend(find_all_files(SKILLS_DIR))
    all_files.extend(find_all_files(AGENTS_DIR))
    all_files.extend(find_all_files(RULES_DIR))
    all_files.extend(find_all_files(SCRIPTS_DIR, "*.py"))

    for filepath in sorted(all_files):
        if filepath.name in EXEMPT_FILES:
            continue

        content = read_file(filepath)
        rel = filepath.relative_to(PROJECT_ROOT)

        for pattern, description in BANNED_PATTERNS:
            matches = list(re.finditer(pattern, content, re.IGNORECASE))
            if matches:
                lines = []
                content_lines = content.split('\n')
                for m in matches:
                    line_num = content[:m.start()].count('\n') + 1
                    line_text = content_lines[line_num - 1].strip()[:80]
                    lines.append(f"  L{line_num}: {line_text}")
                result.fail(
                    f"banned:{rel}:{description.split(' — ')[0]}",
                    f"{description}\n" + "\n".join(lines[:3])
                    + (f"\n  ... and {len(lines)-3} more" if len(lines) > 3 else "")
                )
            else:
                result.ok(f"banned:{rel}:no_{pattern.split(chr(92))[-1][:15]}")


# ─── Check 3: File references ───

def check_file_references(result):
    """Verify that file paths referenced in skills actually exist."""

    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir() or not skill_dir.name.startswith("ship-"):
            continue

        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            continue

        content = read_file(skill_file)

        # Find references to other files (common patterns)
        # Check references to ship-* skill files (both .claude/skills/ and skills/ paths)
        ref_pattern = r'`?\.?claude/skills/ship-[^`\s*]+`?'
        for match in re.finditer(ref_pattern, content):
            ref_path = match.group().strip('`').strip()
            # Try both plugin-root and .claude-prefixed paths
            if ref_path.startswith('.claude/'):
                plugin_path = ref_path.replace('.claude/', '', 1)
            else:
                plugin_path = ref_path
            full_path = PROJECT_ROOT / plugin_path
            if full_path.exists():
                result.ok(f"ref:{skill_dir.name}:{plugin_path}")
            else:
                result.fail(f"ref:{skill_dir.name}:{plugin_path}", f"referenced file not found: {plugin_path}")

        # Pattern: `.shipyard/` paths (these are runtime, just check they're plausible)
        # Skip — these exist at runtime in client projects, not in source

        # Check references/ subdirectory files are actually referenced
        refs_dir = skill_dir / "references"
        if refs_dir.is_dir():
            for ref_file in refs_dir.glob("*.md"):
                ref_relative = f"skills/{skill_dir.name}/references/{ref_file.name}"
                if ref_relative in content or ref_file.name in content:
                    result.ok(f"ref:{skill_dir.name}:references/{ref_file.name}:referenced")
                else:
                    result.warn(f"ref:{skill_dir.name}:references/{ref_file.name}:referenced",
                                "file exists in references/ but not referenced in SKILL.md")


# ─── Check 4: Agent references from skills ───

def check_agent_references(result):
    """Check that skills reference agents that actually exist."""

    existing_agents = {f.stem for f in AGENTS_DIR.glob("shipyard-*.md")}

    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir():
            continue

        # Check all .md files in the skill
        for md_file in skill_dir.rglob("*.md"):
            content = read_file(md_file)
            rel = md_file.relative_to(PROJECT_ROOT)

            # Find agent references: subagent_type: shipyard:shipyard-* (plugin-namespaced)
            for match in re.finditer(r'subagent_type:\s*(?:shipyard:)?(shipyard-[\w-]+)', content):
                agent_name = match.group(1)
                if agent_name in existing_agents:
                    result.ok(f"agent_ref:{rel}:{agent_name}")
                else:
                    result.fail(f"agent_ref:{rel}:{agent_name}",
                                f"references agent '{agent_name}' but no {agent_name}.md in agents/")


# ─── Check 5: Hook scripts ───

def check_hook_scripts(result):
    """Syntax-check Python hook scripts."""

    for script in sorted(SCRIPTS_DIR.glob("*.py")):
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "py_compile", str(script)],
                capture_output=True, text=True
            )
            if proc.returncode == 0:
                result.ok(f"hook:{script.name}:syntax")
            else:
                result.fail(f"hook:{script.name}:syntax", proc.stderr.strip())
        except Exception as e:
            result.fail(f"hook:{script.name}:syntax", str(e))

    # Check hooks.json references scripts that exist
    settings_file = HOOKS_DIR / "hooks.json"
    if settings_file.exists():
        settings = json.loads(settings_file.read_text(encoding='utf-8'))
        hooks = settings.get("hooks", {})
        for event_type, entries in hooks.items():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                for hook in entry.get("hooks", []):
                    cmd = hook.get("command", "")
                    # Extract script name from command
                    match = re.search(r'(?:\.shipyard|CLAUDE_PLUGIN_ROOT)[/}]*[/]?project-files/scripts/(\S+\.py)', cmd)
                    if match:
                        script_name = match.group(1)
                        script_path = SCRIPTS_DIR / script_name
                        if script_path.exists():
                            result.ok(f"hook:settings:{script_name}:exists")
                        else:
                            result.fail(f"hook:settings:{script_name}:exists",
                                        f"settings.json references {script_name} but not found in scripts/")


# ─── Check 6: Template validity ───

def check_templates(result):
    """Validate template files have valid frontmatter."""

    for tmpl in sorted(TEMPLATES_DIR.glob("*.md")):
        fm, err = parse_frontmatter(tmpl)
        if err:
            result.warn(f"template:{tmpl.name}:frontmatter", err)
        else:
            result.ok(f"template:{tmpl.name}:frontmatter")


# ─── Check 7: Per-skill assertions ───

def check_skill_assertions(result, skill_filter=None):
    """Run per-skill assertions from tests/assertions/*.json."""

    if not ASSERTIONS_DIR.exists():
        return

    for assertion_file in sorted(ASSERTIONS_DIR.glob("*.json")):
        skill_name = assertion_file.stem
        if skill_filter and skill_name != skill_filter:
            continue

        try:
            cases = json.loads(assertion_file.read_text(encoding='utf-8'))
        except json.JSONDecodeError as e:
            result.fail(f"assertions:{skill_name}:parse", str(e))
            continue

        # Find the skill content
        skill_dir = SKILLS_DIR / skill_name
        if not skill_dir.exists():
            result.fail(f"assertions:{skill_name}:exists", f"skill directory not found")
            continue

        # Collect skill text — SKILL.md only by default, references on demand
        skill_main = read_file(skill_dir / "SKILL.md")
        all_text = skill_main + "\n"
        # Also collect reference files for 'contains' checks (features may be in refs)
        refs_text = ""
        for md_file in skill_dir.rglob("*.md"):
            if md_file.name != "SKILL.md":
                refs_text += read_file(md_file) + "\n"

        for case in cases:
            name = case.get("name", "unnamed")
            check_type = case.get("type", "contains")
            target = case.get("target", "skill")  # skill | agent:name | rule:name

            # Resolve target text
            # For not_contains, only check SKILL.md (refs may document negations)
            # For contains, check SKILL.md + references (features may be in refs)
            if target == "skill":
                text = (skill_main if check_type == "not_contains" else skill_main + refs_text)
            elif target.startswith("agent:"):
                agent_name = target.split(":", 1)[1]
                agent_file = AGENTS_DIR / f"{agent_name}.md"
                text = read_file(agent_file) if agent_file.exists() else ""
            elif target.startswith("rule:"):
                rule_name = target.split(":", 1)[1]
                rule_file = RULES_DIR / f"{rule_name}.md"
                text = read_file(rule_file) if rule_file.exists() else ""
            elif target.startswith("script:"):
                script_name = target.split(":", 1)[1]
                script_file = SCRIPTS_DIR / script_name
                text = read_file(script_file) if script_file.exists() else ""
            elif target.startswith("hooks:"):
                hooks_name = target.split(":", 1)[1]
                hooks_file = HOOKS_DIR / hooks_name
                text = read_file(hooks_file) if hooks_file.exists() else ""
            elif target.startswith("ref:"):
                ref_name = target.split(":", 1)[1]
                # Search for reference file in skill's references/ subdirectory
                ref_file = skill_dir / "references" / ref_name
                text = read_file(ref_file) if ref_file.exists() else ""
            else:
                text = all_text

            check_id = f"assert:{skill_name}:{name}"

            if check_type == "contains":
                pattern = case.get("pattern", "")
                flags = re.IGNORECASE | (re.DOTALL if case.get("dotall") else 0)
                if re.search(pattern, text, flags):
                    result.ok(check_id)
                else:
                    result.fail(check_id, f"pattern not found: {pattern}")

            elif check_type == "not_contains":
                pattern = case.get("pattern", "")
                flags = re.IGNORECASE | (re.DOTALL if case.get("dotall") else 0)
                match = re.search(pattern, text, flags)
                if match:
                    # Find line number
                    line_num = text[:match.start()].count('\n') + 1
                    result.fail(check_id, f"banned pattern found at ~L{line_num}: {pattern}")
                else:
                    result.ok(check_id)

            elif check_type == "frontmatter_field":
                fm, _ = parse_frontmatter(skill_dir / "SKILL.md")
                field = case.get("field", "")
                expected = case.get("value", None)
                if fm and field in fm:
                    if expected is None or fm[field] == expected:
                        result.ok(check_id)
                    else:
                        result.fail(check_id, f"field '{field}' = '{fm[field]}', expected '{expected}'")
                else:
                    result.fail(check_id, f"field '{field}' not in frontmatter")

            elif check_type == "file_exists":
                path = case.get("path", "")
                full = PROJECT_ROOT / path
                if full.exists():
                    result.ok(check_id)
                else:
                    result.fail(check_id, f"file not found: {path}")

            else:
                result.warn(check_id, f"unknown check type: {check_type}")


# ─── Check 8: Cross-skill consistency ───

def check_cross_skill_consistency(result):
    """Check skills reference each other consistently."""

    # Collect all skill names
    skill_names = set()
    for skill_dir in SKILLS_DIR.iterdir():
        if skill_dir.is_dir() and skill_dir.name.startswith("ship-"):
            skill_names.add(skill_dir.name)

    # Check that /ship-* references in SKILL.md files point to real skills
    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir():
            continue
        for md_file in skill_dir.rglob("*.md"):
            content = read_file(md_file)
            rel = md_file.relative_to(PROJECT_ROOT)

            for match in re.finditer(r'/ship-(\w[\w-]*)', content):
                ref_skill = f"ship-{match.group(1)}"
                if ref_skill in skill_names:
                    result.ok(f"xref:{rel}:{ref_skill}")
                else:
                    # Could be a user-facing mention of a command, not a file ref
                    result.warn(f"xref:{rel}:{ref_skill}",
                                f"references /ship-{match.group(1)} but no skill directory found")


# ─── Report ───

def print_report(result, verbose=False):
    """Print the final eval report."""

    print()
    print("=" * 60)
    print("  SHIPYARD EVAL REPORT")
    print("=" * 60)
    print()

    if result.failed:
        print(f"  FAILED: {len(result.failed)}")
        print(f"  PASSED: {len(result.passed)}")
        if result.warnings:
            print(f"  WARNINGS: {len(result.warnings)}")
        print(f"  TOTAL:  {result.total}")
        print()
        print("-" * 60)
        print("  FAILURES")
        print("-" * 60)
        for check, detail in result.failed:
            print(f"\n  FAIL  {check}")
            if detail:
                for line in detail.split('\n'):
                    print(f"        {line}")
    else:
        print(f"  ALL PASSED: {len(result.passed)} checks")
        if result.warnings:
            print(f"  WARNINGS: {len(result.warnings)}")

    if result.warnings:
        print()
        print("-" * 60)
        print("  WARNINGS")
        print("-" * 60)
        for check, detail in result.warnings:
            print(f"\n  WARN  {check}")
            if detail:
                for line in detail.split('\n'):
                    print(f"        {line}")

    if verbose and result.passed:
        print()
        print("-" * 60)
        print("  PASSED")
        print("-" * 60)
        for check, detail in result.passed:
            print(f"  OK    {check}")

    print()
    print("=" * 60)
    status = "FAIL" if result.failed else "PASS"
    print(f"  {status} — {len(result.passed)} passed, {len(result.failed)} failed, {len(result.warnings)} warnings")
    print("=" * 60)
    print()

    return 0 if not result.failed else 1


def main():
    args = sys.argv[1:]
    verbose = "--verbose" in args or "-v" in args
    skill_filter = None
    if "--skill" in args:
        idx = args.index("--skill")
        if idx + 1 < len(args):
            skill_filter = args[idx + 1]

    result = Result()

    check_frontmatter(result)
    check_banned_patterns(result)
    check_file_references(result)
    check_agent_references(result)
    check_hook_scripts(result)
    check_templates(result)
    check_skill_assertions(result, skill_filter)
    check_cross_skill_consistency(result)

    exit_code = print_report(result, verbose)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
