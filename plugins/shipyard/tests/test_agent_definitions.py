#!/usr/bin/env python3
"""Structural tests for agent definitions under agents/.

Verifies that every shipyard-* agent file:
- Has valid YAML frontmatter with the required fields
- Lists tools that are real Claude Code tool names
- References references/ files that exist (when it points to one)
- Has a stable required-section pattern (heading shape)

These complement the eval-run.py per-skill assertion checks; eval-run.py
focuses on skills, this file focuses on agents.
"""

import os
import re
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
AGENTS_DIR = PLUGIN_ROOT / "agents"

# Required frontmatter keys for every agent
REQUIRED_KEYS = {"name", "description", "tools"}

# Optional but expected
OPTIONAL_KEYS = {
    "disallowedTools", "model", "maxTurns", "memory",
    "permissionMode", "isolation", "displayName",
}

# Known tool names. Conservative — anything that looks like a known
# Claude Code tool. The check fails if an agent declares a tool we don't
# recognize, which catches typos.
KNOWN_TOOLS = {
    "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash",
    "Grep", "Glob", "LSP", "Agent", "WebSearch", "WebFetch",
    "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
    "TaskCreate", "TaskUpdate", "TaskGet", "TaskList",
    "TeamCreate", "TeamDelete", "SendMessage",
}


def parse_frontmatter(content: str):
    """Return (dict_of_fields, body_after_frontmatter) or (None, content)."""
    if not content.startswith("---\n"):
        return None, content
    end = content.find("\n---\n", 4)
    if end < 0:
        return None, content
    fm_text = content[4:end]
    body = content[end + len("\n---\n"):]

    fields = {}
    current_key = None
    for line in fm_text.split("\n"):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$", line)
        if m:
            current_key = m.group(1)
            value = m.group(2).strip()
            fields[current_key] = value
    return fields, body


def parse_tool_list(value: str):
    """Parse a YAML inline list like [Read, Write, Edit, "Bash(...)"]."""
    if not value:
        return []
    inner = value.strip()
    if inner.startswith("[") and inner.endswith("]"):
        inner = inner[1:-1]
    items = []
    buf = ""
    in_quote = False
    in_paren = 0
    for ch in inner:
        if ch == '"' and in_paren == 0:
            in_quote = not in_quote
        elif ch == "(" and not in_quote:
            in_paren += 1
        elif ch == ")" and not in_quote:
            in_paren -= 1
        elif ch == "," and not in_quote and in_paren == 0:
            items.append(buf.strip().strip('"'))
            buf = ""
            continue
        buf += ch
    if buf.strip():
        items.append(buf.strip().strip('"'))
    # Strip Bash(...) wrapper for the known-tool check
    return items


def normalize_tool_for_check(tool: str) -> str:
    """For the known-tool check, strip parameter wrappers like Bash(git:*)."""
    m = re.match(r"^([A-Z][A-Za-z]+)(?:\(.+\))?$", tool)
    return m.group(1) if m else tool


class TestAgentFrontmatter(unittest.TestCase):
    """Every agent has well-formed frontmatter."""

    def test_all_agents_have_frontmatter(self):
        for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
            content = agent_file.read_text()
            fm, _ = parse_frontmatter(content)
            self.assertIsNotNone(
                fm, f"{agent_file.name}: missing or malformed frontmatter"
            )

    def test_required_fields_present(self):
        for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
            content = agent_file.read_text()
            fm, _ = parse_frontmatter(content)
            self.assertIsNotNone(fm, agent_file.name)
            for key in REQUIRED_KEYS:
                self.assertIn(
                    key, fm, f"{agent_file.name}: missing required key '{key}'"
                )

    def test_name_matches_filename(self):
        for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
            content = agent_file.read_text()
            fm, _ = parse_frontmatter(content)
            expected = agent_file.stem  # e.g., "shipyard-builder"
            self.assertEqual(
                fm["name"], expected,
                f"{agent_file.name}: frontmatter name '{fm['name']}' does not match filename"
            )

    def test_description_is_non_empty(self):
        for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
            content = agent_file.read_text()
            fm, _ = parse_frontmatter(content)
            desc = fm.get("description", "").strip().strip('"').strip("'")
            self.assertGreater(
                len(desc), 20,
                f"{agent_file.name}: description too short ({len(desc)} chars)"
            )

    def test_tools_are_known(self):
        for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
            content = agent_file.read_text()
            fm, _ = parse_frontmatter(content)
            tools = parse_tool_list(fm.get("tools", ""))
            self.assertGreater(
                len(tools), 0, f"{agent_file.name}: empty tools list"
            )
            for tool in tools:
                normalized = normalize_tool_for_check(tool)
                self.assertIn(
                    normalized, KNOWN_TOOLS,
                    f"{agent_file.name}: unknown tool '{tool}'"
                )

    def test_model_is_valid_when_present(self):
        valid_models = {"sonnet", "opus", "haiku"}
        for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
            content = agent_file.read_text()
            fm, _ = parse_frontmatter(content)
            model = fm.get("model", "").strip().strip('"').strip("'")
            if model:
                self.assertIn(
                    model, valid_models,
                    f"{agent_file.name}: invalid model '{model}' (expected one of {valid_models})"
                )


class TestAgentBodyStructure(unittest.TestCase):
    """Every agent body follows a minimal structural contract."""

    def test_agent_body_is_non_trivial(self):
        for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
            content = agent_file.read_text()
            _, body = parse_frontmatter(content)
            self.assertGreater(
                len(body.strip()), 200,
                f"{agent_file.name}: body too short to be a real agent definition"
            )

    def test_agent_body_has_role_intro(self):
        """Every agent should introduce its role in the first ~500 chars of the body."""
        for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
            content = agent_file.read_text()
            _, body = parse_frontmatter(content)
            head = body[:600].lower()
            # Look for any of: "you are a", "your job", "your role", "your responsibility"
            has_role = any(
                p in head for p in (
                    "you are a", "you are the", "your job", "your role",
                    "your responsibility", "you act as",
                )
            )
            self.assertTrue(
                has_role,
                f"{agent_file.name}: missing 'you are a ...' role intro near the top"
            )

    def test_subagents_have_output_budget_section(self):
        """Every subagent (anything that returns to an orchestrator) must
        document the 32k output cap. Skips top-level agents that don't run
        as Task-tool subagents (currently none — every shipyard-* agent IS
        a subagent, so all of them are checked)."""
        for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
            content = agent_file.read_text()
            _, body = parse_frontmatter(content)
            self.assertIn(
                "Output Budget", body,
                f"{agent_file.name}: missing '## Output Budget' section "
                f"(every Task-tool subagent is hard-capped at 32k output)"
            )
            # And the cap value must appear somewhere near it
            budget_idx = body.find("Output Budget")
            window = body[budget_idx:budget_idx + 800]
            self.assertTrue(
                "32k" in window or "32,000" in window,
                f"{agent_file.name}: Output Budget section doesn't mention the 32k cap"
            )


class TestAgentReferences(unittest.TestCase):
    """Agents that reference reference files / other agents must point to real ones."""

    def test_referenced_files_exist(self):
        """Find ${CLAUDE_PLUGIN_ROOT}/... or path-like references in bodies; verify they exist."""
        ref_pattern = re.compile(
            r"\$\{CLAUDE_PLUGIN_ROOT\}/(skills/[a-z0-9-]+/references/[a-z0-9-]+\.md)"
        )
        for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
            content = agent_file.read_text()
            for match in ref_pattern.finditer(content):
                rel_path = match.group(1)
                full = PLUGIN_ROOT / rel_path
                self.assertTrue(
                    full.exists(),
                    f"{agent_file.name}: references nonexistent file {rel_path}"
                )

    def test_no_dead_subagent_references(self):
        """Agents shouldn't spawn subagents that don't exist."""
        agent_names = {f.stem for f in AGENTS_DIR.glob("shipyard-*.md")}
        spawn_pattern = re.compile(r"shipyard:(shipyard-[a-z0-9-]+)")
        for agent_file in sorted(AGENTS_DIR.glob("shipyard-*.md")):
            content = agent_file.read_text()
            for match in spawn_pattern.finditer(content):
                referenced = match.group(1)
                self.assertIn(
                    referenced, agent_names,
                    f"{agent_file.name}: spawns nonexistent subagent '{referenced}'"
                )


class TestNewDelegationAgents(unittest.TestCase):
    """Specific checks for the two new delegation agents."""

    def test_discovery_scout_exists(self):
        f = AGENTS_DIR / "shipyard-discovery-scout.md"
        self.assertTrue(f.exists(), "shipyard-discovery-scout.md missing")

    def test_discovery_scout_lists_methodology_files(self):
        f = AGENTS_DIR / "shipyard-discovery-scout.md"
        content = f.read_text()
        for ref in (
            "challenge-surface.md",
            "edge-case-framework.md",
            "nfr-scan.md",
            "failure-modes.md",
        ):
            self.assertIn(
                ref, content,
                f"discovery-scout doesn't list {ref} as a methodology source"
            )

    def test_discovery_scout_is_read_only(self):
        f = AGENTS_DIR / "shipyard-discovery-scout.md"
        content = f.read_text()
        fm, _ = parse_frontmatter(content)
        tools = parse_tool_list(fm.get("tools", ""))
        # Must NOT have any write tool
        for write_tool in ("Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"):
            self.assertNotIn(
                write_tool, tools,
                f"discovery-scout must not have {write_tool} (it's a read-only analyst)"
            )

    def test_sprint_analyst_exists(self):
        f = AGENTS_DIR / "shipyard-sprint-analyst.md"
        self.assertTrue(f.exists(), "shipyard-sprint-analyst.md missing")

    def test_sprint_analyst_is_read_only(self):
        f = AGENTS_DIR / "shipyard-sprint-analyst.md"
        content = f.read_text()
        fm, _ = parse_frontmatter(content)
        tools = parse_tool_list(fm.get("tools", ""))
        for write_tool in ("Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"):
            self.assertNotIn(
                write_tool, tools,
                f"sprint-analyst must not have {write_tool}"
            )

    def test_sprint_analyst_can_websearch(self):
        f = AGENTS_DIR / "shipyard-sprint-analyst.md"
        content = f.read_text()
        fm, _ = parse_frontmatter(content)
        tools = parse_tool_list(fm.get("tools", ""))
        self.assertIn(
            "WebSearch", tools,
            "sprint-analyst should have WebSearch for external research"
        )

    def test_both_new_agents_referenced_from_skills(self):
        """The new agents should actually be spawned from somewhere."""
        skills_dir = PLUGIN_ROOT / "skills"
        all_skill_content = ""
        for skill_md in skills_dir.glob("ship-*/SKILL.md"):
            all_skill_content += skill_md.read_text() + "\n"
        self.assertIn(
            "shipyard-discovery-scout", all_skill_content,
            "discovery-scout exists but no skill spawns it"
        )
        self.assertIn(
            "shipyard-sprint-analyst", all_skill_content,
            "sprint-analyst exists but no skill spawns it"
        )


if __name__ == "__main__":
    unittest.main()
