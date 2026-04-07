#!/usr/bin/env python3
"""Tests for the session mutex pattern enforced across planning skills.

The session mutex check is the safety net that prevents two simultaneous
/ship-sprint or /ship-discuss invocations from corrupting the spec or
allocating duplicate task IDs. The check runs as the first action of each
planning skill: Read .active-session.json, decide based on cleared/skill/
started fields, hard-block or proceed.

These tests verify the structural pattern (the right files have the right
sections) and the .active-session.json sentinel format that session-guard
reads.
"""

import json
import re
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent.parent
SKILLS_DIR = PLUGIN_ROOT / "skills"

# Skills that own the session marker (write it on entry, clear on exit)
PLANNING_SKILLS = {"ship-discuss", "ship-sprint"}

# Skills that check the marker but don't write it (refuse to start if active)
EXECUTION_SKILLS = {"ship-execute", "ship-quick", "ship-debug"}


class TestPlanningSkillsHaveMutexEntry(unittest.TestCase):
    """Each planning skill must read .active-session.json before writing it."""

    def test_planning_skills_read_marker_first(self):
        """The Read MUST appear before the Write in skill body order."""
        for skill_name in PLANNING_SKILLS:
            skill_md = SKILLS_DIR / skill_name / "SKILL.md"
            content = skill_md.read_text()

            read_match = re.search(
                r"Read[^\n]*<SHIPYARD_DATA>/\.active-session\.json",
                content,
                re.IGNORECASE,
            )
            self.assertIsNotNone(
                read_match,
                f"{skill_name}: missing Read of .active-session.json"
            )

            write_match = re.search(r'"skill":\s*"ship-[a-z-]+"', content)
            self.assertIsNotNone(
                write_match,
                f"{skill_name}: missing session marker Write"
            )

            self.assertLess(
                read_match.start(), write_match.start(),
                f"{skill_name}: mutex Read appears AFTER the marker Write — "
                f"two concurrent invocations would both write before either reads"
            )

    def test_planning_skills_explain_hard_block(self):
        for skill_name in PLANNING_SKILLS:
            skill_md = SKILLS_DIR / skill_name / "SKILL.md"
            content = skill_md.read_text()
            self.assertRegex(
                content,
                r"HARD BLOCK|hard.?block",
                f"{skill_name}: no HARD BLOCK directive"
            )
            self.assertRegex(
                content,
                r"ship-status",
                f"{skill_name}: hard-block message should point user at /ship-status"
            )

    def test_planning_skills_have_2hr_staleness_recovery(self):
        for skill_name in PLANNING_SKILLS:
            skill_md = SKILLS_DIR / skill_name / "SKILL.md"
            content = skill_md.read_text()
            self.assertRegex(
                content,
                r"more than 2 hours old|2 hours ago|2.?hour|>?2h",
                f"{skill_name}: missing 2-hour staleness recovery rule"
            )


class TestExecutionSkillsCheckPlanningSession(unittest.TestCase):
    """Execution skills must hard-block if a planning session is active."""

    def test_execution_skills_check_active_session(self):
        for skill_name in EXECUTION_SKILLS:
            skill_md = SKILLS_DIR / skill_name / "SKILL.md"
            content = skill_md.read_text()
            self.assertRegex(
                content,
                r"<SHIPYARD_DATA>/\.active-session\.json",
                f"{skill_name}: missing planning-session check"
            )
            self.assertRegex(
                content,
                r"[Pp]lanning.?session.?(active|mutex|check)",
                f"{skill_name}: missing planning-session block instruction"
            )


class TestSessionMarkerFormat(unittest.TestCase):
    """The .active-session.json format must be consistent across skills."""

    def test_marker_includes_skill_topic_started_fields(self):
        for skill_name in PLANNING_SKILLS:
            skill_md = SKILLS_DIR / skill_name / "SKILL.md"
            content = skill_md.read_text()
            for keyword in ('"skill"', '"topic"', '"started"'):
                self.assertIn(
                    keyword, content,
                    f"{skill_name}: session marker missing {keyword} field"
                )

    def test_clear_uses_soft_delete_sentinel(self):
        """Cleanup must Write {skill: null, cleared: ...}, not delete the file."""
        for skill_name in PLANNING_SKILLS:
            skill_md = SKILLS_DIR / skill_name / "SKILL.md"
            content = skill_md.read_text()
            self.assertRegex(
                content,
                r'"skill":\s*null.*"cleared"|"cleared".*"skill":\s*null',
                f"{skill_name}: cleanup must use the soft-delete sentinel"
            )

    def test_session_guard_accepts_sentinel(self):
        guard = PLUGIN_ROOT / "bin" / "hooks" / "session-guard.mjs"
        content = guard.read_text()
        self.assertIn(
            "cleared", content,
            "session-guard.mjs should check the `cleared` field"
        )
        self.assertIn(
            "session.skill", content,
            "session-guard.mjs should check session.skill"
        )


class TestSentinelRoundtrip(unittest.TestCase):
    """Sanity-check the JSON shape of the sentinel and active-marker."""

    def test_sentinel_is_valid_json(self):
        sentinel = {"skill": None, "cleared": "2026-04-07T12:00:00Z"}
        encoded = json.dumps(sentinel)
        decoded = json.loads(encoded)
        self.assertIsNone(decoded["skill"])
        self.assertEqual(decoded["cleared"], "2026-04-07T12:00:00Z")

    def test_active_marker_is_valid_json(self):
        marker = {
            "skill": "ship-discuss",
            "topic": "test feature",
            "started": "2026-04-07T12:00:00Z",
        }
        encoded = json.dumps(marker)
        decoded = json.loads(encoded)
        self.assertEqual(decoded["skill"], "ship-discuss")
        self.assertNotIn("cleared", decoded)


if __name__ == "__main__":
    unittest.main()
