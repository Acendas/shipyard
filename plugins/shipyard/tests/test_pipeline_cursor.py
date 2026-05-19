"""Tests for the pipeline cursor protocol used by /ship-review and /ship-execute.

The cursor (REVIEW-CURSOR.md, EXECUTE-CURSOR.md) is the persistence
mechanism that makes both skills /loop-friendly: each invocation reads
the cursor, runs one stage, writes the cursor for the next tick, and
emits a structured terminal signal when the pipeline is done.

These tests cover the cursor protocol contract that both skills'
SKILL.md bodies and references/pipeline-cursor.md must satisfy:

1. The cursor schema is documented identically in both skills'
   pipeline-cursor.md references (field names, semantics).
2. Both skills' SKILL.md bodies reference the cursor + the protocol.
3. The terminal-signal protocol uses the exact load-bearing strings:
   - Event name `pipeline_terminal`
   - Marker text `CYCLE COMPLETE`
   - Marker text `/loop should stop`
4. The stuck-detection threshold (5) and hard ceiling (50) are
   documented consistently between the two references.
5. The event vocabulary is identical between the two references
   (pipeline_tick_started, pipeline_tick_completed, pipeline_terminal,
   pipeline_stuck).
6. The no-op terminal path (already-archived sprint, already-complete
   sprint) is documented in both skills.

Regression test: the original bug was that /loop /ship-review kept
firing wakeups after sprint archive because there was no terminal
signal. The terminal_marker_strings test guards against that
regression.
"""

import re
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SKILLS_DIR = PROJECT_ROOT / "skills"

SHIP_REVIEW_SKILL = SKILLS_DIR / "ship-review" / "SKILL.md"
SHIP_REVIEW_CURSOR_REF = SKILLS_DIR / "ship-review" / "references" / "pipeline-cursor.md"
SHIP_EXECUTE_SKILL = SKILLS_DIR / "ship-execute" / "SKILL.md"
SHIP_EXECUTE_CURSOR_REF = SKILLS_DIR / "ship-execute" / "references" / "pipeline-cursor.md"
SHIP_STATUS_SKILL = SKILLS_DIR / "ship-status" / "SKILL.md"


def read(path):
    return path.read_text(encoding="utf-8")


# Load-bearing strings — exact matches required.
TERMINAL_EVENT = "pipeline_terminal"
TICK_STARTED_EVENT = "pipeline_tick_started"
TICK_COMPLETED_EVENT = "pipeline_tick_completed"
STUCK_EVENT = "pipeline_stuck"
TERMINAL_MARKER = "CYCLE COMPLETE"
LOOP_STOP_MARKER = "/loop should stop"
TICK_MARKER = "TICK COMPLETE"
LOOP_CONTINUE_MARKER = "/loop continues"


class TestCursorReferencesExist(unittest.TestCase):
    """The cursor reference files must exist under both skills."""

    def test_ship_review_cursor_ref_exists(self):
        self.assertTrue(
            SHIP_REVIEW_CURSOR_REF.exists(),
            f"missing: {SHIP_REVIEW_CURSOR_REF}",
        )

    def test_ship_execute_cursor_ref_exists(self):
        self.assertTrue(
            SHIP_EXECUTE_CURSOR_REF.exists(),
            f"missing: {SHIP_EXECUTE_CURSOR_REF}",
        )


class TestCursorSchemaDocumented(unittest.TestCase):
    """The cursor frontmatter schema must be documented in both references."""

    REQUIRED_FIELDS = [
        "pipeline:",
        "sprint:",
        "stage:",
        "iteration:",
        "last_advance_at:",
        "loop_owner:",
        "status:",
        "next_action:",
        "terminal:",
        "stuck_counter:",
        "hard_ceiling:",
    ]

    def _assert_fields_in(self, path):
        text = read(path)
        for field in self.REQUIRED_FIELDS:
            self.assertIn(
                field, text, f"{path.name} missing schema field: {field}"
            )

    def test_review_ref_has_all_schema_fields(self):
        self._assert_fields_in(SHIP_REVIEW_CURSOR_REF)

    def test_execute_ref_has_all_schema_fields(self):
        self._assert_fields_in(SHIP_EXECUTE_CURSOR_REF)


class TestTerminalSignalProtocol(unittest.TestCase):
    """The terminal signal uses exact load-bearing strings.

    Regression: original /loop bug fired wakeups indefinitely because
    no terminal marker was printed. The skill bodies + cursor refs MUST
    print "CYCLE COMPLETE" with "/loop should stop" and emit
    pipeline_terminal.
    """

    def _assert_terminal_protocol_in(self, path):
        text = read(path)
        self.assertIn(
            TERMINAL_EVENT,
            text,
            f"{path.name} missing terminal event name: {TERMINAL_EVENT}",
        )
        self.assertIn(
            TERMINAL_MARKER,
            text,
            f"{path.name} missing terminal marker: {TERMINAL_MARKER}",
        )
        self.assertIn(
            LOOP_STOP_MARKER,
            text,
            f"{path.name} missing loop-stop marker: {LOOP_STOP_MARKER}",
        )

    def test_review_ref_has_terminal_protocol(self):
        self._assert_terminal_protocol_in(SHIP_REVIEW_CURSOR_REF)

    def test_execute_ref_has_terminal_protocol(self):
        self._assert_terminal_protocol_in(SHIP_EXECUTE_CURSOR_REF)

    def test_review_skill_has_terminal_protocol(self):
        self._assert_terminal_protocol_in(SHIP_REVIEW_SKILL)

    def test_execute_skill_has_terminal_protocol(self):
        self._assert_terminal_protocol_in(SHIP_EXECUTE_SKILL)


class TestTickContinueMarker(unittest.TestCase):
    """Non-terminal ticks must print the 'continue' marker so /loop
    knows to schedule another wakeup."""

    def _assert_tick_continue_in(self, path):
        text = read(path)
        self.assertIn(
            TICK_MARKER,
            text,
            f"{path.name} missing tick marker: {TICK_MARKER}",
        )
        self.assertIn(
            LOOP_CONTINUE_MARKER,
            text,
            f"{path.name} missing loop-continue marker: {LOOP_CONTINUE_MARKER}",
        )

    def test_review_ref_has_tick_continue(self):
        self._assert_tick_continue_in(SHIP_REVIEW_CURSOR_REF)

    def test_execute_ref_has_tick_continue(self):
        self._assert_tick_continue_in(SHIP_EXECUTE_CURSOR_REF)

    def test_review_skill_has_tick_continue(self):
        self._assert_tick_continue_in(SHIP_REVIEW_SKILL)

    def test_execute_skill_has_tick_continue(self):
        self._assert_tick_continue_in(SHIP_EXECUTE_SKILL)


class TestEventVocabularyConsistent(unittest.TestCase):
    """Both refs must emit the same four cursor-level events."""

    EVENTS = [
        TICK_STARTED_EVENT,
        TICK_COMPLETED_EVENT,
        TERMINAL_EVENT,
        STUCK_EVENT,
    ]

    def _assert_events_in(self, path):
        text = read(path)
        for event in self.EVENTS:
            self.assertIn(
                event, text, f"{path.name} missing event: {event}"
            )

    def test_review_ref_has_all_events(self):
        self._assert_events_in(SHIP_REVIEW_CURSOR_REF)

    def test_execute_ref_has_all_events(self):
        self._assert_events_in(SHIP_EXECUTE_CURSOR_REF)

    def test_review_skill_has_terminal_and_tick_events(self):
        text = read(SHIP_REVIEW_SKILL)
        for event in [TERMINAL_EVENT, TICK_STARTED_EVENT, TICK_COMPLETED_EVENT]:
            self.assertIn(event, text, f"ship-review SKILL.md missing: {event}")

    def test_execute_skill_has_terminal_and_tick_events(self):
        text = read(SHIP_EXECUTE_SKILL)
        for event in [TERMINAL_EVENT, TICK_STARTED_EVENT, TICK_COMPLETED_EVENT]:
            self.assertIn(event, text, f"ship-execute SKILL.md missing: {event}")


class TestStuckDetectionThresholds(unittest.TestCase):
    """The stuck-detection threshold (5) and hard ceiling (50) must
    match between the two references and the skill bodies."""

    def _assert_thresholds_in(self, path):
        text = read(path)
        # stuck_counter at 5
        self.assertTrue(
            re.search(
                r"stuck_counter\s*>=\s*5|stuck_counter\s+>=\s+5|stuck_counter\s+reaches\s+5|5 ticks|5 times|5 unchanging",
                text,
            ),
            f"{path.name} missing stuck threshold of 5",
        )
        # hard_ceiling at 50
        self.assertTrue(
            re.search(r"hard_ceiling.*?50|50.*?hard.ceiling|50 iterations", text),
            f"{path.name} missing hard ceiling of 50",
        )

    def test_review_ref_has_thresholds(self):
        self._assert_thresholds_in(SHIP_REVIEW_CURSOR_REF)

    def test_execute_ref_has_thresholds(self):
        self._assert_thresholds_in(SHIP_EXECUTE_CURSOR_REF)


class TestStageMapDocumented(unittest.TestCase):
    """Each skill's reference must document its stage map."""

    REVIEW_STAGES = [
        "preflight",
        "code_review_iter",
        "simplify",
        "tests",
        "spec_review",
        "goal_verify",
        "gap_analysis",
        "critic",
        "final_pass",
        "verdict",
        "demo_probe",
        "demo_user",
        "retro_step_1",
        "retro_step_2",
        "retro_step_3",
        "retro_step_4",
        "release_step_1",
        "release_step_2",
        "release_step_3",
        "archive",
        "terminal",
    ]

    EXECUTE_STAGES = [
        "preflight",
        "salvage",
        "load",
        "readiness",
        "wave_N_dispatch",
        "wave_N_boundary",
        "wave_N_build",
        "wave_N_tests",
        "wave_N_verify",
        "wave_N_gate",
        "sprint_full_build",
        "sprint_full_tests",
        "sprint_complete_gate",
        "terminal_handoff_to_review",
    ]

    def test_review_ref_has_stages(self):
        text = read(SHIP_REVIEW_CURSOR_REF)
        for stage in self.REVIEW_STAGES:
            self.assertIn(stage, text, f"ship-review pipeline-cursor.md missing stage: {stage}")

    def test_execute_ref_has_stages(self):
        text = read(SHIP_EXECUTE_CURSOR_REF)
        for stage in self.EXECUTE_STAGES:
            self.assertIn(stage, text, f"ship-execute pipeline-cursor.md missing stage: {stage}")


class TestSkillBodiesReferenceCursor(unittest.TestCase):
    """Both SKILL.md bodies must link to the pipeline-cursor reference
    and document cursor read-at-entry behavior."""

    def test_review_skill_links_cursor_ref(self):
        text = read(SHIP_REVIEW_SKILL)
        self.assertIn("pipeline-cursor.md", text)

    def test_execute_skill_links_cursor_ref(self):
        text = read(SHIP_EXECUTE_SKILL)
        self.assertIn("pipeline-cursor.md", text)

    def test_review_skill_documents_cursor_at_entry(self):
        text = read(SHIP_REVIEW_SKILL)
        self.assertIn("REVIEW-CURSOR.md", text)

    def test_execute_skill_documents_cursor_at_entry(self):
        text = read(SHIP_EXECUTE_SKILL)
        self.assertIn("EXECUTE-CURSOR.md", text)


class TestNoOpTerminalPath(unittest.TestCase):
    """Each skill must document the no-op terminal: invoking against
    already-archived / already-complete state must emit
    pipeline_terminal with outcome=noop and print the terminal marker.

    This is the exact path that fired the original /loop bug.
    """

    def test_review_ref_documents_noop_terminal(self):
        text = read(SHIP_REVIEW_CURSOR_REF)
        self.assertIn("sprint_already_archived", text)
        self.assertIn("outcome=noop", text)

    def test_execute_ref_documents_noop_terminal(self):
        text = read(SHIP_EXECUTE_CURSOR_REF)
        self.assertIn("sprint_already_complete", text)
        self.assertIn("outcome=noop", text)


class TestShipStatusRendersCursors(unittest.TestCase):
    """/ship-status must read and render both cursors so the user can
    inspect pipeline state at a glance."""

    def test_status_skill_mentions_review_cursor(self):
        text = read(SHIP_STATUS_SKILL)
        self.assertIn("REVIEW-CURSOR.md", text)

    def test_status_skill_mentions_execute_cursor(self):
        text = read(SHIP_STATUS_SKILL)
        self.assertIn("EXECUTE-CURSOR.md", text)

    def test_status_skill_renders_pipeline_state(self):
        text = read(SHIP_STATUS_SKILL)
        # Some indicator of pipeline/cursor rendering in the dashboard
        self.assertTrue(
            re.search(r"PIPELINE|[Pp]ipeline [Ss]tage|[Cc]ursor", text),
            "ship-status missing pipeline/cursor rendering section",
        )


class TestDirectVsLoopInvocationDocumented(unittest.TestCase):
    """The two invocation paths (direct chain vs /loop per-tick) must
    be documented in both references so future maintainers understand
    the dispatch contract."""

    def _assert_both_paths_in(self, path):
        text = read(path)
        self.assertIn("/loop", text)
        # Look for some form of "direct" or "single-tick" override
        self.assertTrue(
            re.search(r"Direct invocation|single-tick|chain", text),
            f"{path.name} missing direct-invocation vs /loop dispatch contract",
        )

    def test_review_ref_documents_both_paths(self):
        self._assert_both_paths_in(SHIP_REVIEW_CURSOR_REF)

    def test_execute_ref_documents_both_paths(self):
        self._assert_both_paths_in(SHIP_EXECUTE_CURSOR_REF)


class TestExecuteCursorCoexistsWithHandoff(unittest.TestCase):
    """ship-execute must document how the cursor coexists with
    HANDOFF.md so the explicit user-pause path isn't broken."""

    def test_execute_ref_documents_handoff_coexistence(self):
        text = read(SHIP_EXECUTE_CURSOR_REF)
        self.assertIn("HANDOFF.md", text)

    def test_execute_skill_documents_handoff_coexistence(self):
        text = read(SHIP_EXECUTE_SKILL)
        # Existing skill already references HANDOFF.md; new content must
        # explain interaction with the cursor.
        self.assertIn("HANDOFF.md", text)


class TestExecuteWaveGatePreserved(unittest.TestCase):
    """The verifying-wave-completion internal ScheduleWakeup pattern
    must be preserved — the cursor's wave_N_gate stage must NOT
    duplicate that loop at the outer layer."""

    def test_execute_ref_calls_out_nested_loop(self):
        text = read(SHIP_EXECUTE_CURSOR_REF)
        self.assertIn("verifying-wave-completion", text)
        self.assertTrue(
            re.search(r"nested|inside|internal", text, re.IGNORECASE),
            "execute pipeline-cursor.md must document the nested wave-gate loop",
        )


if __name__ == "__main__":
    unittest.main()
