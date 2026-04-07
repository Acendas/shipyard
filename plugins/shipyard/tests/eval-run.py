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
SCRIPTS_DIR = PROJECT_ROOT / "project-files" / "scripts"  # legacy, removed in H4
HOOKS_NODE_DIR = PROJECT_ROOT / "bin" / "hooks"
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
    """Syntax-check Node hook modules and verify hooks.json references them.

    Phase H4: this used to py_compile every Python script under
    project-files/scripts/. After porting, we node --check every .mjs
    under bin/hooks/.
    """

    for script in sorted(HOOKS_NODE_DIR.glob("*.mjs")):
        try:
            proc = subprocess.run(
                ["node", "--check", str(script)],
                capture_output=True, text=True, timeout=10,
            )
            if proc.returncode == 0:
                result.ok(f"hook:{script.name}:syntax")
            else:
                result.fail(f"hook:{script.name}:syntax", proc.stderr.strip())
        except Exception as e:
            result.fail(f"hook:{script.name}:syntax", str(e))

    # Check hooks.json: every dispatched hook name must have a matching
    # bin/hooks/<name>.mjs module. The dispatcher matches `hook-runner.mjs
    # <name>` in the command string.
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
                    # Extract dispatched hook name from `hook-runner.mjs <name>`
                    match = re.search(r'hook-runner\.mjs"?\s+(\S+)', cmd)
                    if match:
                        hook_name = match.group(1)
                        module_path = HOOKS_NODE_DIR / f"{hook_name}.mjs"
                        if module_path.exists():
                            result.ok(f"hook:settings:{hook_name}:exists")
                        else:
                            result.fail(
                                f"hook:settings:{hook_name}:exists",
                                f"hooks.json references hook {hook_name} but bin/hooks/{hook_name}.mjs is missing",
                            )


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
                # Phase H4: scripts ported from Python to Node. Legacy
                # `script:foo.py` targets are auto-redirected to
                # `bin/hooks/foo.mjs`. Plain Node names without an extension
                # also resolve to `bin/hooks/<name>.mjs`. Falls back to the
                # legacy SCRIPTS_DIR for any non-hook scripts that may live
                # there in the future.
                script_name = target.split(":", 1)[1]
                if script_name.endswith(".py"):
                    node_name = script_name[:-3] + ".mjs"
                elif script_name.endswith(".mjs"):
                    node_name = script_name
                else:
                    node_name = script_name + ".mjs"
                node_file = HOOKS_NODE_DIR / node_name
                if node_file.exists():
                    text = read_file(node_file)
                else:
                    legacy = SCRIPTS_DIR / script_name
                    text = read_file(legacy) if legacy.exists() else ""
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


# ─── Check 7.5: Pre-exec bash permissions ───

# Pre-exec slash-command syntax: a line whose first non-space char is `!` followed by a
# backtick-delimited command. Claude Code runs these through the Bash tool at load time,
# so the skill's allowed-tools must permit the command — otherwise the user sees
# "Shell command permission check failed for pattern ...". Silent drift here broke
# /ship-discuss in the wild when shipyard-context was introduced without updating
# allowed-tools — see commit log for ship-discuss/ship-spec/ship-backlog/ship-bug/
# ship-sprint/ship-help. Enforce the invariant at eval time.

PREEXEC_RE = re.compile(r'^\s*!`([^`]+)`', re.MULTILINE)


def _allowed_bash_scopes(fm):
    """Return (has_unscoped_bash, set_of_scoped_commands) from an allowed-tools list."""
    tools = fm.get("allowed-tools") or []
    if isinstance(tools, str):
        tools = [tools]
    has_plain = False
    scopes = set()
    for t in tools:
        t = t.strip()
        if t == "Bash":
            has_plain = True
        elif t.startswith("Bash(") and t.endswith(")"):
            inner = t[5:-1]
            # "cmd:*" or "cmd arg..." — take the first whitespace/colon-delimited token
            cmd = re.split(r'[\s:]', inner, maxsplit=1)[0]
            if cmd:
                scopes.add(cmd)
    return has_plain, scopes


def check_bash_preexec_portability(result):
    """Flag pre-exec lines that will break on Windows.

    Two failure classes:

    1. Quoted argument containing a space: passing `"No codebase context"` as
       argv crosses the `.cmd` wrapper on Windows and cmd.exe's `%*` mangles
       the quoting. CLAUDE.md has an explicit rule against this. Route the
       default through the CLI (`shipyard-context view <name>`) instead.

    2. Non-shipyard, non-`echo` root command: `head`, `cat`, `tail`, `sed`,
       `awk`, `grep`, `python3`, `[`, test — these either don't exist on
       cmd.exe / PowerShell or have different semantics. Pre-exec must
       route through the Node CLIs (`shipyard-context`, `shipyard-data`)
       which are cross-platform.

    Allowed root commands: shipyard-context, shipyard-data, shipyard-logcap.
    """

    ALLOWED_ROOTS = {"shipyard-context", "shipyard-data", "shipyard-logcap"}

    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir() or not skill_dir.name.startswith("ship-"):
            continue
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            continue
        content = read_file(skill_file)
        body = re.sub(r'^---\s*\n.*?\n---\s*\n', '', content, count=1, flags=re.DOTALL)

        for m in PREEXEC_RE.finditer(body):
            cmd_line = m.group(1).strip()
            line_num = body[:m.start()].count('\n') + 1 + (content[:m.start()].count('\n') - body[:m.start()].count('\n'))
            check_id = f"bash_preexec_portability:{skill_dir.name}:L{line_num}"

            # (1) Quoted-arg-with-space check. Match "..." or '...' containing a space.
            if re.search(r'"[^"]*\s[^"]*"', cmd_line) or re.search(r"'[^']*\s[^']*'", cmd_line):
                result.fail(
                    check_id + ":quoted_space_arg",
                    f"pre-exec has a quoted argument containing a space — breaks on Windows\n"
                    f"  line: {cmd_line}\n"
                    f"  fix: bake the default into a shipyard-context named subcommand "
                    f"(view/list/count-of) — see VIEW_REGISTRY in bin/shipyard-context.mjs"
                )
                continue

            # (2) Allowed root command check
            root = cmd_line.split(None, 1)[0] if cmd_line else ""
            # Strip leading env assignments (shouldn't appear but defensive)
            if "=" in root and not root.startswith("$"):
                for tok in cmd_line.split():
                    if "=" not in tok:
                        root = tok
                        break
            if root not in ALLOWED_ROOTS:
                result.fail(
                    check_id + ":non_portable_root",
                    f"pre-exec uses non-portable root command `{root}` — may not exist on Windows\n"
                    f"  line: {cmd_line}\n"
                    f"  fix: add a subcommand to shipyard-context that does this work in Node, "
                    f"then call `shipyard-context <subcommand>` from the skill"
                )
                continue

            # (3) Shell operators (pipes, redirects, &&, ||, ;) — these require
            # a real shell, which on Windows means either Git Bash (not always
            # present) or cmd.exe (different syntax). Reject.
            if re.search(r'[|<>;]|&&|\|\|', cmd_line):
                result.fail(
                    check_id + ":shell_operators",
                    f"pre-exec contains shell operators (|, >, <, ;, &&, ||) — not portable\n"
                    f"  line: {cmd_line}\n"
                    f"  fix: move the logic into shipyard-context as a named subcommand"
                )
                continue

            result.ok(check_id)


def check_bash_fenced_portability(result):
    """Flag POSIX-only shell builtins inside ``` bash ``` code fences.

    Scope: every .md file under skills/ (including references/), plus every
    agent body under agents/. The `check_bash_preexec_portability` sibling
    only scans pre-exec `!`cmd`` lines; this check covers the fenced
    examples that skills and agent bodies show Claude as "run this".

    Banned tokens — each has a cross-platform replacement:

    - ``mktemp``              → ``shipyard-logcap run <name> -- <cmd>``
                                (captures to $TMPDIR cross-platform, `.cmd` shim on Windows)
    - ``readlink -f``         → Node inline or realpath via Node script
    - ``realpath`` (GNU)      → Node's `path.resolve` / `fs.realpathSync`
    - ``sed -i ''``           → Edit tool, or a Node `shipyard-*` subcommand
    - ``stat -c``             → Node `fs.statSync`
    - ``/dev/stdin``          → piped input via a `shipyard-*` CLI

    Why each one breaks: `mktemp`, `readlink -f`, GNU `realpath`, `stat -c`,
    and `/dev/stdin` don't exist on plain Windows cmd.exe / PowerShell — they
    only work inside Git Bash, which is NOT a guaranteed environment.
    `sed -i ''` with an empty backup extension is the BSD variant; GNU sed
    on Linux needs `sed -i` without the empty arg, so even on POSIX the
    two diverge silently. All of these are in CLAUDE.md's "Don't use
    POSIX-only shell builtins" rule under Cross-Platform.

    Excluded from scanning: the portability reference docs themselves
    (which must name the banned tokens to explain why they're banned).
    """

    # Each entry: (token-regex, fix-hint)
    BANNED = [
        (r'\bmktemp\b', 'use `shipyard-logcap run <name> -- <cmd>` (cross-platform capture with .cmd shim)'),
        (r'\breadlink\s+-f\b', 'use a shipyard-* Node subcommand or `node -e "console.log(require(\'fs\').realpathSync(...))"`'),
        # Match bare `realpath` (the GNU binary) but not compound tokens
        # like `shipyard-realpath` or `fs.realpathSync`. The negative
        # lookbehind rejects any hyphen or dot immediately before — those
        # indicate an identifier inside a larger name, not a shell call.
        (r'(?<![-.])\brealpath\b', 'GNU realpath is not on macOS/Windows by default — use Node `fs.realpathSync` or a shipyard-* subcommand'),
        (r"\bsed\s+-i\s+''", 'BSD sed-in-place differs from GNU — use the Edit tool or a shipyard-* subcommand'),
        (r'\bstat\s+-c\b', 'GNU-only flag — use Node `fs.statSync` or a shipyard-* subcommand'),
        (r'/dev/stdin\b', 'not available on Windows — pipe through a shipyard-* CLI instead'),
    ]

    # Match ``` bash ... ``` fences. The test-delegation.md prompt template
    # also has nested fences inside a prompt string; we flatten by scanning
    # every bash fence independently.
    BASH_FENCE = re.compile(r'```(?:bash|sh|shell)\s*\n(.*?)\n```', re.DOTALL)

    # Files whose sole purpose is to document the banned tokens — they must
    # be allowed to name them. Keep this list minimal and specific.
    EXCLUDED = {
        # (none yet — add here if a reference doc needs to explain a token)
    }

    targets = []
    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir() or not skill_dir.name.startswith("ship-"):
            continue
        for md_file in skill_dir.rglob("*.md"):
            if md_file.name in EXCLUDED:
                continue
            targets.append(("skill", md_file))
    for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
        targets.append(("agent", agent_file))

    for kind, md_file in targets:
        content = read_file(md_file)
        # Strip YAML frontmatter so tokens mentioned in descriptions don't
        # match. Frontmatter never contains bash fences anyway.
        body = re.sub(r'^---\s*\n.*?\n---\s*\n', '', content, count=1, flags=re.DOTALL)

        rel = md_file.relative_to(PROJECT_ROOT) if md_file.is_relative_to(PROJECT_ROOT) else md_file
        fenced_hits = 0
        fenced_fail = False

        for fence_match in BASH_FENCE.finditer(body):
            fence_content = fence_match.group(1)
            fence_start_line = body[:fence_match.start()].count('\n') + 1

            for pattern, hint in BANNED:
                for tok_match in re.finditer(pattern, fence_content):
                    fenced_hits += 1
                    fenced_fail = True
                    # Line number of the match *within the fence*, added to
                    # the fence's starting line for a file-level pointer.
                    tok_line_in_fence = fence_content[:tok_match.start()].count('\n')
                    file_line = fence_start_line + 1 + tok_line_in_fence
                    check_id = f"bash_fenced_portability:{rel}:L{file_line}:{tok_match.group(0)!r}"
                    result.fail(
                        check_id,
                        f"POSIX-only token in {kind} bash fence: {tok_match.group(0)!r}\n"
                        f"  file: {rel}:L{file_line}\n"
                        f"  fix: {hint}",
                    )

        if not fenced_fail:
            result.ok(f"bash_fenced_portability:{rel}")


def check_session_mutex_pattern(result):
    """Structural guard: every skill that writes `.active-session.json` with
    a non-null skill field MUST also read it first to do a mutex check.

    This catches the "someone added a new planning skill and forgot the
    entry check" failure mode. The per-skill assertions in
    tests/assertions/ship-{sprint,discuss}.json catch regressions in
    existing skills; this check catches new-skill omissions.

    Algorithm: scan every SKILL.md body for the substring
    `"skill": "ship-` inside a JSON-shaped block (the marker write). If
    found AND it's NOT the soft-delete sentinel `"skill": null`, the body
    must also contain a Read instruction targeting `.active-session.json`
    BEFORE that write.

    Skills that only check (ship-execute, ship-quick, ship-debug) and
    skills that don't touch the marker at all are unaffected.
    """
    import re

    SKILL_WRITE_RE = re.compile(r'"skill":\s*"ship-[a-z-]+"')
    SESSION_READ_RE = re.compile(
        r'Read\b[^\n]*<SHIPYARD_DATA>/\.active-session\.json',
        re.IGNORECASE,
    )

    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir() or not skill_dir.name.startswith("ship-"):
            continue
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists():
            continue
        body = read_file(skill_md)
        rel = skill_md.relative_to(PROJECT_ROOT) if skill_md.is_relative_to(PROJECT_ROOT) else skill_md

        write_match = SKILL_WRITE_RE.search(body)
        if not write_match:
            # Skill never claims a planning session marker — nothing to check.
            result.ok(f"session_mutex:{skill_dir.name}:not-applicable")
            continue

        # Find the FIRST Read of .active-session.json. The mutex check
        # must come before the write — same skill body, earlier line.
        read_match = SESSION_READ_RE.search(body)
        if not read_match:
            result.fail(
                f"session_mutex:{skill_dir.name}:missing_read",
                f"{rel} writes a session marker (`{write_match.group(0)}`) "
                f"but never reads `.active-session.json` to check whether "
                f"another planning session is already active. Add a "
                f"Session Mutex Check section near the top of the skill body.",
            )
            continue

        if read_match.start() >= write_match.start():
            result.fail(
                f"session_mutex:{skill_dir.name}:read_after_write",
                f"{rel} reads `.active-session.json` (L{body[:read_match.start()].count(chr(10)) + 1}) "
                f"AFTER it writes the marker (L{body[:write_match.start()].count(chr(10)) + 1}). "
                f"The mutex check must come BEFORE the write — otherwise two "
                f"simultaneous invocations both write before either reads.",
            )
            continue

        result.ok(f"session_mutex:{skill_dir.name}:read_before_write")


def check_no_python_in_plugin(result):
    """Phase H5 guard rail: fail if any .py file appears under bin/ or
    project-files/scripts/.

    The hook port (Phase H1-H4) eliminated Python from the plugin runtime
    entirely. The eval runner itself (eval-run.py) is the only Python that
    remains, and it lives in tests/, not in any user-facing plugin path.
    This check prevents a future contributor from re-introducing a Python
    hook script (and thereby re-introducing the hidden Python dependency
    on Windows).

    Excluded: tests/eval-run.py (this file), test_*.py files in tests/
    that exercise non-hook CLIs (those are dev-time scripts and Python is
    fine for CI).
    """
    bad_dirs = [
        PROJECT_ROOT / "bin",
        PROJECT_ROOT / "project-files" / "scripts",
    ]
    found = []
    for d in bad_dirs:
        if not d.exists():
            continue
        for py in d.rglob("*.py"):
            found.append(py.relative_to(PROJECT_ROOT))
    if found:
        for f in found:
            result.fail(
                f"no_python_in_plugin:{f}",
                f"Python file under plugin runtime path: {f}\n"
                f"  Phase H4 deleted all Python hooks. Re-introducing one "
                f"resurrects the hidden Python dependency on Windows.\n"
                f"  Port the script to bin/hooks/<name>.mjs instead.",
            )
    else:
        result.ok("no_python_in_plugin")


def check_no_shell_substitution_in_body(result):
    """Fail if any SKILL.md or reference body contains a `$(shipyard-...)` form.

    Started from a customer bug: ship-discuss told Claude to use compound bash
    `SD=$(shipyard-data) && cat $SD/...`. Claude Code's bash-AST matcher choked
    on the compound form ("Unhandled node type: string") and the user was
    prompted on every step. The structural fix is: skill bodies must never
    instruct Claude to invoke a Shipyard binary via shell command substitution
    — they should use Read/Grep/Glob with the literal SHIPYARD_DATA prefix
    surfaced by the `!`shipyard-context path`` pre-exec line.

    Banned forms (matched as plain substrings, not regex):
    - `$(shipyard-data` — command substitution invoking the data resolver
    - `$(shipyard-context` — command substitution invoking the context CLI
    - `SD=$(shipyard-data` — the documented "data path" anti-pattern that
      every restricted skill used to ship at the top of its body

    Allowed: bare invocations like `shipyard-data archive-sprint sprint-001`
    inside a bash fence (those don't use `$()`), and the literal placeholder
    `<SHIPYARD_DATA>` (used as documentation that Claude should substitute
    the actual path from the pre-exec context block).

    Scope: every .md file under skills/ (SKILL.md + references/). Excluded:
    none — the canonical placeholder is `<SHIPYARD_DATA>`, and any SKILL.md
    that needs to mention the banned form for documentation should use plain
    English ("shell command substitution") instead of the literal token.
    """

    BANNED_SUBSTRINGS = [
        ('$(shipyard-data', 'use Read/Grep/Glob with the literal <SHIPYARD_DATA> prefix from the !`shipyard-context path` pre-exec line'),
        ('$(shipyard-context', 'use the !`shipyard-context ...` pre-exec line in the context block instead'),
        ('SD=$(shipyard-data', 'replaced by the canonical "Data path" paragraph — use the literal <SHIPYARD_DATA> placeholder'),
    ]

    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir() or not skill_dir.name.startswith("ship-"):
            continue
        for md_file in skill_dir.rglob("*.md"):
            content = read_file(md_file)
            rel = md_file.relative_to(PROJECT_ROOT) if md_file.is_relative_to(PROJECT_ROOT) else md_file
            any_hit = False
            for needle, hint in BANNED_SUBSTRINGS:
                idx = content.find(needle)
                if idx >= 0:
                    line_num = content[:idx].count('\n') + 1
                    any_hit = True
                    result.fail(
                        f"no_shell_substitution:{rel}:L{line_num}",
                        f"banned shell-substitution form {needle!r} in skill body\n"
                        f"  file: {rel}:L{line_num}\n"
                        f"  fix: {hint}",
                    )
            if not any_hit:
                result.ok(f"no_shell_substitution:{rel}")


def check_skill_bash_allowlist_consistency(result):
    """Cross-validate skill bodies against their own `allowed-tools` Bash entries.

    Three layered checks:

    1. Pre-exec `!`<bin> ...`` invocations must be covered by an `allowed-tools`
       entry of one of the supported shapes: bare `Bash`, `Bash(<bin>)`, or
       `Bash(<bin>:*)`. Per-subcommand literal forms `Bash(<bin>:<subcmd>)`
       are NOT a supported matcher form in this plugin (every existing entry
       across all skills is plain `Bash`, `Bash(<bin>)`, or `Bash(<bin>:*)`).
       Adding one would silently never match — re-opening the customer-bug
       failure mode. The check warns if it sees that shape.

    2. Bash code fences in the body must not invoke any binary the skill
       hasn't allowlisted (when the skill is restricted — has any `Bash(...)`
       entry that isn't bare `Bash`).

    3. The check duplicates `check_bash_preexec_permissions` intentionally for
       layered defense: pre-exec drift is high-impact and easy to miss.
    """

    BIN_FROM_PREEXEC = re.compile(r'!`([\w-][\w./-]*)\s')
    BIN_FROM_FENCE = re.compile(r'(?:^|\s)([\w-][\w./-]*)\s', re.MULTILINE)
    ALLOWED_TOOL_BASH = re.compile(r'"?Bash(?:\(([^)]*)\))?"?')
    BASH_FENCE = re.compile(r'```(?:bash|sh|shell)\s*\n(.*?)\n```', re.DOTALL)

    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir() or not skill_dir.name.startswith("ship-"):
            continue
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.exists():
            continue
        content = read_file(skill_md)
        rel = skill_md.relative_to(PROJECT_ROOT) if skill_md.is_relative_to(PROJECT_ROOT) else skill_md
        fm, _ = parse_frontmatter(skill_md)
        if not fm:
            continue
        allowed_tools = fm.get("allowed-tools") or []
        if isinstance(allowed_tools, str):
            allowed_tools = [allowed_tools]

        has_plain_bash = False
        scopes = set()  # set of allowlisted binary names (or "*" for full)
        per_subcmd_warnings = []
        for entry in allowed_tools:
            entry_str = str(entry).strip()
            if entry_str == "Bash":
                has_plain_bash = True
                scopes.add("*")
                continue
            m = ALLOWED_TOOL_BASH.fullmatch(entry_str)
            if not m:
                continue
            arg = m.group(1) or ""
            if not arg:
                has_plain_bash = True
                scopes.add("*")
            elif ":" in arg:
                bin_name, suffix = arg.split(":", 1)
                if suffix != "*":
                    per_subcmd_warnings.append((bin_name, suffix))
                scopes.add(bin_name)
            else:
                scopes.add(arg)

        # Per-subcommand literal warning (Correction B)
        for bin_name, suffix in per_subcmd_warnings:
            result.fail(
                f"bash_allowlist_consistency:{rel}:per_subcmd",
                f"per-subcommand Bash matcher form `Bash({bin_name}:{suffix})` is not supported "
                f"in this plugin — every existing entry uses plain `Bash`, `Bash(<bin>)`, or "
                f"`Bash(<bin>:*)`. The literal form would silently never match. Use "
                f"`Bash({bin_name}:*)` and let this eval check enforce subcommand intent.",
            )

        body = re.sub(r'^---\s*\n.*?\n---\s*\n', '', content, count=1, flags=re.DOTALL)

        # Pre-exec invocations
        preexec_failures = []
        for m in BIN_FROM_PREEXEC.finditer(body):
            bin_name = m.group(1)
            if has_plain_bash or bin_name in scopes:
                continue
            preexec_failures.append(bin_name)
        if preexec_failures:
            result.fail(
                f"bash_allowlist_consistency:{rel}:preexec",
                f"pre-exec line invokes binary not in allowed-tools: {sorted(set(preexec_failures))}\n"
                f"  file: {rel}\n"
                f"  fix: add `Bash({preexec_failures[0]}:*)` to allowed-tools",
            )

        # Bash fences mentioning shipyard binaries when restricted
        if not has_plain_bash:
            for fence_match in BASH_FENCE.finditer(body):
                fence = fence_match.group(1)
                fence_start_line = body[:fence_match.start()].count('\n') + 1
                for bad_bin in ("shipyard-data", "shipyard-context", "shipyard-logcap"):
                    if re.search(rf'\b{re.escape(bad_bin)}\b', fence) and bad_bin not in scopes:
                        result.fail(
                            f"bash_allowlist_consistency:{rel}:L{fence_start_line}:{bad_bin}",
                            f"bash fence invokes `{bad_bin}` but it is not in allowed-tools\n"
                            f"  file: {rel}:L{fence_start_line}\n"
                            f"  fix: add `Bash({bad_bin}:*)` to allowed-tools, or rewrite the fence to use Read/Grep/Glob",
                        )
                        break

        result.ok(f"bash_allowlist_consistency:{rel}")


def check_bash_preexec_permissions(result):
    """Every !`cmd ...` pre-exec in a SKILL.md body must be covered by allowed-tools."""

    for skill_dir in sorted(SKILLS_DIR.iterdir()):
        if not skill_dir.is_dir() or not skill_dir.name.startswith("ship-"):
            continue
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            continue

        content = read_file(skill_file)
        fm, err = parse_frontmatter(skill_file)
        if err or fm is None:
            continue

        # Strip frontmatter so we only scan the body
        body = re.sub(r'^---\s*\n.*?\n---\s*\n', '', content, count=1, flags=re.DOTALL)

        preexecs = PREEXEC_RE.findall(body)
        if not preexecs:
            result.ok(f"bash_preexec:{skill_dir.name}:none")
            continue

        has_plain, scopes = _allowed_bash_scopes(fm)

        # Collect the root command of every pre-exec
        needed = set()
        for cmd_line in preexecs:
            first = cmd_line.strip().split(None, 1)[0] if cmd_line.strip() else ""
            # Strip any leading env assignments like FOO=bar cmd
            if "=" in first and not first.startswith("$"):
                parts = cmd_line.strip().split()
                for p in parts:
                    if "=" not in p:
                        first = p
                        break
            if first:
                needed.add(first)

        missing = sorted(c for c in needed if not has_plain and c not in scopes)
        if missing:
            result.fail(
                f"bash_preexec:{skill_dir.name}:allowed_tools_coverage",
                "SKILL.md contains !`cmd` pre-exec blocks but allowed-tools does not "
                "permit them — user will hit 'Shell command permission check failed'.\n"
                f"  missing Bash scopes: {', '.join(missing)}\n"
                f"  fix: add \"Bash({missing[0]}:*)\" (and similar) to allowed-tools"
            )
        else:
            result.ok(f"bash_preexec:{skill_dir.name}:allowed_tools_coverage",
                      f"covers: {', '.join(sorted(needed))}")


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
    check_bash_preexec_permissions(result)
    check_bash_preexec_portability(result)
    check_bash_fenced_portability(result)
    check_no_shell_substitution_in_body(result)
    check_skill_bash_allowlist_consistency(result)
    check_no_python_in_plugin(result)
    check_session_mutex_pattern(result)
    check_cross_skill_consistency(result)

    exit_code = print_report(result, verbose)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
