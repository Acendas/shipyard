"""Tests for the pipeline cursor protocol used by /ship-review and /ship-execute.

The cursor (REVIEW-CURSOR.md, EXECUTE-CURSOR.md) is the persistence
mechanism that makes both skills /goal-friendly: each invocation reads
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
   - Marker text `/goal should stop`
4. The stuck-detection threshold (5) and hard ceiling (50) are
   documented consistently between the two references.
5. The event vocabulary is identical between the two references
   (pipeline_tick_started, pipeline_tick_completed, pipeline_terminal,
   pipeline_stuck).
6. The no-op terminal path (already-archived sprint, already-complete
   sprint) is documented in both skills.

Regression test: the original bug was that /goal /ship-review kept
firing wakeups after sprint archive because there was no terminal
signal. The terminal_marker_strings test guards against that
regression.
"""

import json
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
LOOP_STOP_MARKER = "/goal should stop"
TICK_MARKER = "TICK COMPLETE"
LOOP_CONTINUE_MARKER = "/goal continues"


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

    Regression: original /goal bug fired wakeups indefinitely because
    no terminal marker was printed. The skill bodies + cursor refs MUST
    print "CYCLE COMPLETE" with "/goal should stop" and emit
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
    """Non-terminal ticks must print the 'continue' marker so /goal
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

    def test_review_skill_advances_via_cli_and_echoes_marker(self):
        # v2.9.0: the CLI prints the tick marker; the skill's contract is to
        # advance via `cursor advance` and echo the CLI output.
        text = read(SHIP_REVIEW_SKILL)
        self.assertIn("cursor advance review", text)
        self.assertRegex(text, r"[Ee]cho (the CLI|its output|the CLI's)")

    def test_execute_skill_advances_via_cli_and_echoes_marker(self):
        text = read(SHIP_EXECUTE_SKILL)
        self.assertIn("cursor advance execute", text)
        self.assertRegex(text, r"[Ee]cho (the CLI|its output|the CLI's)")


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
        "review_scan",
        "review_plan",
        "review_fix_wave_N",
        "review_validation",
        "code_review_iter",
        "simplify",
        "tests",
        "spec_review",
        "quality_gates",
        "goal_verify",
        "gap_analysis",
        "critic",
        "final_pass",
        "verdict",
        "demo_probe",
        "demo_user",
        "retro_step_N",
        "release_step_1",
        "release_step_N",
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
        "sprint_refactor",
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

    This is the exact path that fired the original /goal bug.
    """

    def test_review_ref_documents_noop_terminal(self):
        text = read(SHIP_REVIEW_CURSOR_REF)
        self.assertIn("already archived", text)
        self.assertIn("outcome=noop", text)

    def test_execute_ref_documents_noop_terminal(self):
        text = read(SHIP_EXECUTE_CURSOR_REF)
        self.assertIn("already complete", text)
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
    """The two invocation paths (direct chain vs /goal per-tick) must
    be documented in both references so future maintainers understand
    the dispatch contract."""

    def _assert_both_paths_in(self, path):
        text = read(path)
        self.assertIn("/goal", text)
        # Look for some form of "direct" or "single-tick" override
        self.assertTrue(
            re.search(r"Direct invocation|single-tick|chain", text),
            f"{path.name} missing direct-invocation vs /goal dispatch contract",
        )

    def test_review_ref_documents_both_paths(self):
        self._assert_both_paths_in(SHIP_REVIEW_CURSOR_REF)

    def test_execute_ref_documents_both_paths(self):
        self._assert_both_paths_in(SHIP_EXECUTE_CURSOR_REF)


class TestExecuteCursorCoexistsWithHandoff(unittest.TestCase):
    """ship-execute must document explicit pause/resume cursor handling."""

    def test_execute_ref_documents_pause_resume(self):
        text = read(SHIP_EXECUTE_CURSOR_REF)
        self.assertIn("cursor pause execute", text)
        self.assertIn("cursor resume execute", text)

    def test_execute_skill_documents_handoff_coexistence(self):
        text = read(SHIP_EXECUTE_SKILL)
        # Existing skill already references HANDOFF.md; new content must
        # explain interaction with the cursor.
        self.assertIn("HANDOFF.md", text)


class TestExecuteWaveGatePreserved(unittest.TestCase):
    """The verifying-wave-completion gate remains a bounded stage."""

    def test_execute_ref_calls_out_nested_loop(self):
        text = read(SHIP_EXECUTE_CURSOR_REF)
        self.assertIn("verifying-wave-completion", text)
        self.assertIn("wave_N_gate", text)


# Load-bearing strings for the v2.8.2 handoff-seam wakeup-leak fix.
LOOP_LEAK_EVENT = "pipeline_repeated_noop_detected"
LOOP_LEAK_MARKER = "REPEATED NOOP"


class TestHandoffSeamWakeupLeak(unittest.TestCase):
    """v2.8.2 regression guard. A customer's auto-bootstrapped /goal
    (firing /shipyard:ship-execute) kept re-firing after the sprint had
    completed and been archived, because:

      1. The execute->review handoff terminal printed the NEXT-UP line
         AFTER the /goal-stop marker, so the loop-driver's last-read line
         said "keep going to review" instead of "stop".
      2. The no-op terminal sweep (the safety net) only *printed* an
         advisory marker and treated its event emit as optional — in the
         affected project the noop terminal event had NEVER fired, so a
         leaked wakeup left no audit-log trace and the loop never died.

    Fix: the /goal-stop marker is the FINAL signal at the handoff
    terminal; the no-op emit is non-optional; a repeat no-op against the
    same dead sprint self-detects and screams (pipeline_repeated_noop_detected
    + a hard REPEATED NOOP marker) so the leak is loud and self-terminating.
    """

    def test_execute_handoff_stop_marker_is_the_last_signal(self):
        """In the execute terminal_handoff banner, the /goal-stop marker
        must come AFTER the NEXT UP /ship-review line. Since v2.9.0 the CLI
        prints the banner (cursor-cli.mjs — behavior pinned in
        test_cursor_cli.mjs); this asserts the skill documents the same
        ordering so the model doesn't append output after the marker."""
        text = read(SHIP_EXECUTE_SKILL)
        anchor = text.find("cursor advance execute terminal_handoff_to_review")
        self.assertNotEqual(anchor, -1, "terminal_handoff advance block not found")
        region = text[anchor:anchor + 1400]
        nextup = region.find("NEXT UP: /ship-review")
        stop = region.find(LOOP_STOP_MARKER)
        self.assertNotEqual(nextup, -1, "handoff banner missing NEXT UP: /ship-review")
        self.assertNotEqual(stop, -1, "handoff banner missing /goal-stop marker")
        self.assertGreater(
            stop, nextup,
            "execute handoff: /goal-stop marker must be the FINAL line, "
            "printed AFTER NEXT UP — else the loop-driver reads 'keep going'",
        )

    def test_execute_handoff_frames_review_as_separate_cycle(self):
        text = read(SHIP_EXECUTE_SKILL) + read(SHIP_EXECUTE_CURSOR_REF)
        self.assertTrue(
            re.search(
                r"SEPARATE cycle you start yourself"
                r"|separate cycle the user starts"
                r"|does NOT (chain into|continue into) /ship-review",
                text,
            ),
            "execute handoff must frame /ship-review as a separate user-started "
            "cycle, not a continuation of the execute /goal",
        )

    def test_both_refs_document_loop_leak_event(self):
        for p in (SHIP_EXECUTE_CURSOR_REF, SHIP_REVIEW_CURSOR_REF):
            self.assertIn(
                LOOP_LEAK_EVENT, read(p),
                f"{p.name} must document the {LOOP_LEAK_EVENT} event in its vocabulary",
            )

    def test_both_skills_have_hard_leak_marker(self):
        for p in (SHIP_EXECUTE_SKILL, SHIP_REVIEW_SKILL):
            self.assertIn(
                LOOP_LEAK_MARKER, read(p),
                f"{p.name} must print the hard '{LOOP_LEAK_MARKER}' marker on a repeat no-op",
            )

    def test_noop_leak_detection_is_cli_owned(self):
        # v2.9.0: repeat-leak detection moved from a model-side
        # `shipyard-context scan-events` sweep into `cursor noop` itself
        # (behavior pinned in test_cursor_cli.mjs). The refs must route the
        # no-op path through the CLI and document that it self-detects.
        for p in (SHIP_EXECUTE_CURSOR_REF, SHIP_REVIEW_CURSOR_REF):
            text = read(p)
            self.assertIn("cursor noop", text, f"{p.name} must route the no-op path through the CLI")
            self.assertRegex(
                text, r"repeat-leak|pipeline_repeated_noop_detected",
                f"{p.name} must document the CLI's repeat-leak self-detection",
            )

    def test_noop_emit_is_non_optional(self):
        for p in (SHIP_EXECUTE_CURSOR_REF, SHIP_REVIEW_CURSOR_REF):
            self.assertRegex(
                read(p), r"non-optional|[Ee]mitting (it )?is mandatory",
                f"{p.name} must state the no-op terminal emit is non-optional "
                f"(skipping it is what made the original leak invisible)",
            )

    def test_terminal_paths_have_no_legacy_driver_fallback(self):
        for p in (SHIP_EXECUTE_SKILL, SHIP_REVIEW_SKILL):
            text = read(p)
            self.assertNotIn("CronCreate", text)
            self.assertNotIn("CronDelete", text)
            self.assertNotIn("pipeline_goal_driver_fallback", text)
            self.assertNotIn("/loop", text)


class TestSessionBudgetDocumented(unittest.TestCase):
    """The wave-start session budget gate must be documented in the execute cursor reference."""

    def test_session_budget_pauses_before_wave_dispatch(self):
        text = read(SHIP_EXECUTE_CURSOR_REF)
        for needle in (
            "session_budget_reached",
            "max_session_minutes",
            "session_started_at",
            "wave_N_dispatch",
            "exit 0",
            "--force",
        ):
            self.assertIn(needle, text, f"pipeline-cursor.md must document {needle}")
        self.assertIn("cursor resume", text)


SHIP_EXECUTE_TASK_DISPATCH_REF = SKILLS_DIR / "ship-execute" / "references" / "task-dispatch.md"
SHIP_EXECUTE_MODE_REFS = (
    SKILLS_DIR / "ship-execute" / "references" / "mode-task.md",
    SKILLS_DIR / "ship-execute" / "references" / "mode-hotfix.md",
)


class TestRedispatchHandlerSingleHome(unittest.TestCase):
    """F019/T074: the wave_N_redispatch_iter handler has exactly one home,
    references/task-dispatch.md. SKILL.md keeps only the stage-id routing the
    cursor graph pins plus a pointer; F010/T083 edits the handler in that one place."""

    HANDLER_HEADING = "## wave_N_redispatch_iter handler"
    # Phrases that only the complete handler carries (the redispatch pre-dispatch emit + model resolution).
    HANDLER_ONLY = ("dispatch_attempt subject=<task>", "resolve-model build --subject")

    def _ship_execute_files(self):
        base = SKILLS_DIR / "ship-execute"
        return [base / "SKILL.md"] + sorted((base / "references").glob("*.md"))

    def test_redispatch_handler_heading_has_one_home(self):
        homes = [f.name for f in self._ship_execute_files() if self.HANDLER_HEADING in read(f)]
        self.assertEqual(homes, ["task-dispatch.md"], f"handler heading homes: {homes}")

    def test_redispatch_handler_text_not_duplicated(self):
        for needle in self.HANDLER_ONLY:
            homes = [f.name for f in self._ship_execute_files() if needle in read(f)]
            self.assertEqual(homes, ["task-dispatch.md"], f"{needle!r} homes: {homes}")

    def test_redispatch_stage_ids_stay_in_skill_and_cursor_ref(self):
        skill = read(SHIP_EXECUTE_SKILL)
        self.assertIn("wave_<N>_redispatch_iter_<K>", skill)
        self.assertIn("wave_<N>_redispatch_iter_1 iteration=<n+1>", skill)
        self.assertIn("wave_N_redispatch_iter_K", read(SHIP_EXECUTE_CURSOR_REF))

    def test_redispatch_router_and_sync_modes_read_task_dispatch(self):
        self.assertIn("references/task-dispatch.md", read(SHIP_EXECUTE_SKILL))
        for ref in SHIP_EXECUTE_MODE_REFS:
            self.assertIn("skills/ship-execute/references/task-dispatch.md", read(ref), ref.name)
        for needle in ("## Step 3: Per-Task Execution", "## Blocked Task Handling",
                       "## Loop Detection & Debug Escalation", "## Deviation Rules",
                       "Patch-task budget"):
            self.assertIn(needle, read(SHIP_EXECUTE_TASK_DISPATCH_REF), needle)


SHIP_EXECUTE_WAVE_REF = SKILLS_DIR / "ship-execute" / "references" / "pipeline-wave.md"


class TestWaveStageGroupSingleHome(unittest.TestCase):
    """F019/T075: the wave stage group (Step 2 dispatch, Step 4 boundary incl. the
    verify-wave-integrated procedure, Recovery & resume) lives in
    references/pipeline-wave.md; the per-task dispatch core (Task Kind Routing,
    Per-task dispatch, Post-Subagent gate) lives in references/task-dispatch.md
    because --task/--hotfix read it too. SKILL.md keeps the headings with their
    stage ids, a Read pointer, the cursor contract and the router-pinned strings."""

    def _files(self):
        base = SKILLS_DIR / "ship-execute"
        return [base / "SKILL.md"] + sorted((base / "references").glob("*.md"))

    def _homes(self, needle):
        return [f.name for f in self._files() if needle in read(f)]

    def test_isolation_and_integration_gate_text_has_one_home(self):
        # F019 AC-4 / AC-5: sequential-only no-isolation rule, the enqueue
        # --require-isolation call, and the verify-wave-integrated procedure
        # are present in pipeline-wave.md and ABSENT from SKILL.md.
        for needle in ("sequential-only by construction", "--require-isolation <resolved",
                       "Gate before teardown", "originally-returned sha"):
            self.assertEqual(self._homes(needle), ["pipeline-wave.md"], f"{needle!r} homes")

    def test_dispatch_core_has_one_home_in_task_dispatch(self):
        for needle in ("## Task Kind Routing", "## Per-task dispatch", "## Post-Subagent gate"):
            self.assertEqual(self._homes(needle), ["task-dispatch.md"], f"{needle!r} homes")

    def test_wave_headings_with_stage_ids_in_reference(self):
        text = read(SHIP_EXECUTE_WAVE_REF)
        for heading in (
            "## Step 2: Execute Waves (stage_id: wave_N_dispatch)",
            "### Wave waiting handler (stage_id: wave_N_waiting)",
            "### Wave recovery handler (stage_id: wave_N_recovery)",
            "## Step 4: Wave Boundary Check (stage_ids: wave_N_boundary → _build → _refactor → _tests → _verify → _gate)",
            "## Recovery & resume",
        ):
            self.assertIn(heading, text, heading)

    def test_router_keeps_stage_headings_and_reads_reference(self):
        skill = read(SHIP_EXECUTE_SKILL)
        for heading in (
            "### Step 2: Execute Waves (stage_id: wave_N_dispatch)",
            "### Step 4: Wave Boundary Check (stage_ids: wave_N_boundary → _build → _refactor → _tests → _verify → _gate)",
            "### Recovery & resume",
        ):
            self.assertIn(heading, skill, heading)
        for tail in ("pipeline-wave.md` § Step 2;", "pipeline-wave.md` § Step 4.",
                     "pipeline-wave.md` § Recovery & resume on any resume"):
            self.assertIn(tail, skill, tail)
        self.assertIn("wave_<N>_redispatch_iter_1 iteration=<n+1>", skill)

    def test_router_rereads_stage_reference_after_compaction(self):
        # T071 probe: compaction re-read is UNVERIFIED, so the router carries the instruction.
        skill = read(SHIP_EXECUTE_SKILL)
        self.assertIn("After compaction, first re-Read the reference for the current cursor stage", skill)
        self.assertIn("references/pipeline-wave.md", skill)

    def test_router_keeps_no_isolation_one_liner(self):
        self.assertIn("no-isolation is sequential-only — see Step 2's Isolation resolution rule",
                      read(SHIP_EXECUTE_SKILL))

    def test_sync_modes_read_dispatch_core_not_wave_reference(self):
        for ref in SHIP_EXECUTE_MODE_REFS:
            self.assertIn("Task Kind Routing, Per-task dispatch, Post-Subagent gate", read(ref), ref.name)
        self.assertNotIn("pipeline-wave", read(SHIP_EXECUTE_MODE_REFS[1]))
        self.assertNotIn("Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/pipeline-wave",
                         read(SHIP_EXECUTE_MODE_REFS[0]))


SHIP_EXECUTE_REFS = SKILLS_DIR / "ship-execute" / "references"


class TestSprintStageGroupsSingleHome(unittest.TestCase):
    """F019/T076: Step 0 + Step 1 (salvage, load) live in references/pipeline-start.md,
    Step 1.5 (readiness) in references/pipeline-readiness.md, Step 5 items 0-4
    (sprint_refactor .. sprint_complete_gate) in references/pipeline-sprint-complete.md.
    SKILL.md keeps the headings with their stage ids, a Read pointer each, and the
    Step 5 item 5 terminal_handoff_to_review block (the pinned stop-marker ordering)."""

    def _homes(self, needle):
        base = SKILLS_DIR / "ship-execute"
        files = [base / "SKILL.md"] + sorted((base / "references").glob("*.md"))
        return [f.name for f in files if needle in read(f)]

    def test_moved_text_has_one_home(self):
        for needle, home in (
            ("Dedupe identical tiers before dispatching", "pipeline-sprint-complete.md"),
            ("Check the verification ledger before grouping", "pipeline-sprint-complete.md"),
            ("resolve-refactor-scope", "pipeline-sprint-complete.md"),
            ("Create the wave task checklist", "pipeline-start.md"),
            ("shipyard-data ensure-worktree-baseref", "pipeline-start.md"),
            ("Derive before asking", "pipeline-readiness.md"),
        ):
            self.assertEqual(self._homes(needle), [home], f"{needle!r} homes")

    def test_stage_headings_with_stage_ids_in_references(self):
        for name, headings in (
            ("pipeline-start.md", ("## Step 0: Worktree Salvage (stage_id: salvage)",
                                   "## Step 1: Load Sprint Plan (stage_id: load)")),
            ("pipeline-readiness.md", ("## Step 1.5: Execution Readiness Check (stage_id: readiness)",)),
            ("pipeline-sprint-complete.md", ("stage_id: sprint_refactor", "stage_id: sprint_full_build",
                                             "stage_id: sprint_full_tests", "stage_id: sprint_demo_probes",
                                             "stage_id: sprint_complete_gate")),
        ):
            text = read(SHIP_EXECUTE_REFS / name)
            for heading in headings:
                self.assertIn(heading, text, f"{name}: {heading}")
        self.assertNotIn("stage_id: terminal_handoff_to_review", read(SHIP_EXECUTE_REFS / "pipeline-sprint-complete.md"))

    def test_router_keeps_headings_and_reads_references(self):
        skill = read(SHIP_EXECUTE_SKILL)
        for heading in (
            "### Step 0: Worktree Salvage (stage_id: salvage)",
            "### Step 1: Load Sprint Plan (stage_id: load)",
            "### Step 1.5: Execution Readiness Check (stage_id: readiness)",
            "### Step 5: Sprint Completion (stage_ids: sprint_refactor → sprint_full_build → sprint_full_tests → sprint_demo_probes → sprint_complete_gate → terminal_handoff_to_review)",
        ):
            self.assertIn(heading, skill, heading)
        for tail in ("references/pipeline-start.md` § Step 0.", "references/pipeline-start.md` § Step 1.",
                     "references/pipeline-readiness.md`.", "references/pipeline-sprint-complete.md` § Step 5 items 0-4"):
            self.assertIn(tail, skill, tail)

    def test_compaction_line_names_each_new_reference(self):
        skill = read(SHIP_EXECUTE_SKILL)
        self.assertIn("After compaction, first re-Read the reference for the current cursor stage", skill)
        for stage_ref in ("`salvage`/`load` → `references/pipeline-start.md`",
                          "`readiness` → `references/pipeline-readiness.md`",
                          "`sprint_refactor` through `sprint_complete_gate` → `references/pipeline-sprint-complete.md`"):
            self.assertIn(stage_ref, skill, stage_ref)

    def test_terminal_handoff_block_stays_in_skill(self):
        # Step 5 item 5 (terminal gate wording + stop-marker ordering) is pinned by
        # test_execute_handoff_stop_marker_is_the_last_signal; its single home is SKILL.md.
        self.assertEqual(self._homes("cursor advance execute terminal_handoff_to_review status=complete"), ["SKILL.md"])
        self.assertEqual(self._homes("SEPARATE cycle you start yourself"), ["SKILL.md"])

    def test_hotfix_reads_readiness_protocol(self):
        self.assertIn("skills/ship-execute/references/pipeline-readiness.md", read(SHIP_EXECUTE_MODE_REFS[1]))
        self.assertNotIn("pipeline-readiness", read(SHIP_EXECUTE_MODE_REFS[0]))

    def test_sprint_complete_reference_loads_checklist_rule(self):
        # The rule APPLIES at sprint_complete_gate, which never runs the load handler: needs a load verb.
        self.assertIn("**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/pipeline-start.md` § Step 1 checklist rules",
                      read(SHIP_EXECUTE_REFS / "pipeline-sprint-complete.md"))

    def test_compaction_line_rereads_checklist_rules(self):
        line = [l for l in read(SHIP_EXECUTE_SKILL).splitlines() if "After compaction, first re-Read" in l][0]
        self.assertIn("`wave_N_dispatch`, `wave_N_gate`, `sprint_complete_gate` and any resume tick also re-Read "
                      "`references/pipeline-start.md` § Step 1 checklist rules", line)

    def test_wave_reference_points_at_moved_checklist_rule(self):
        wave = read(SHIP_EXECUTE_WAVE_REF)
        self.assertIn("**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/pipeline-start.md` § Step 1 checklist rules", wave)
        self.assertIn("rebuild-on-resume rule (in `pipeline-start.md`)", wave)
        self.assertIn("verifying-wave-completion/references/invariants.md` invariant 2", wave)


SHIP_EXECUTE_RESUME_REF = SHIP_EXECUTE_REFS / "resume-from-event-log.md"
EVENT_TYPES_REF = SKILLS_DIR / "dispatching-operational-task" / "references" / "event-types.md"
BIN_DIR = PROJECT_ROOT / "bin"
TRIGGER_VALUES = ("verify_findings", "blocked", "gate_failure", "recovery")


class TestRedispatchTriggerFlag(unittest.TestCase):
    """F010/T083: every entry into wave_N_redispatch_iter passes the cause via
    `--trigger`, and the wave spec review reports counts via `verify findings`.
    The text must stay in the single handler home and match the real CLI."""

    def _handler(self):
        text = read(SHIP_EXECUTE_TASK_DISPATCH_REF)
        start = text.index("## wave_N_redispatch_iter handler")
        end = text.index("\n## ", start + 5)
        return text[start:end]

    def test_trigger_flag_values_match_cli_set(self):
        # AC-18: the documented values are the CLI's set.
        cli = read(BIN_DIR / "cursor-cli.mjs")
        m = re.search(r"REDISPATCH_TRIGGERS = \[([^\]]*)\]", cli)
        cli_values = tuple(re.findall(r'"([a-z_]+)"', m.group(1)))
        self.assertEqual(cli_values, TRIGGER_VALUES)

    def test_trigger_flag_handler_names_all_values_and_command(self):
        handler = self._handler()
        self.assertIn("cursor advance execute wave_<N>_redispatch_iter_1 iteration=<n+1> --trigger <value>", handler)
        for v in TRIGGER_VALUES:
            self.assertIn(f"`{v}`", handler, v)
        self.assertIn("trigger_missing", handler)

    def test_trigger_flag_handler_maps_cause_to_value(self):
        # AC-18: each cause maps to one trigger value.
        handler = self._handler()
        for cause, value in (("spec review FINDINGS", "verify_findings"), ("BLOCKED", "blocked"),
                             ("gate", "gate_failure"), ("crash", "recovery")):
            self.assertRegex(handler, rf"`{value}` \([^)]*{cause}", f"{value} <- {cause}")

    def test_trigger_flag_each_entry_point_passes_one(self):
        # AC-18: every entry into the redispatch stage passes --trigger (absent is AC-20 trigger_missing).
        wave = read(SHIP_EXECUTE_WAVE_REF)
        td = read(SHIP_EXECUTE_TASK_DISPATCH_REF)
        resume = read(SHIP_EXECUTE_RESUME_REF)
        # recovery decide-next: BLOCKED vs gate failure
        self.assertIn("any BLOCKED → `wave_<N>_redispatch_iter_1 iteration=<n+1> --trigger blocked`", wave)
        self.assertIn("gate failure → `... --trigger gate_failure`", wave)
        # wave spec review FINDINGS
        self.assertIn("`→ wave_<N>_redispatch_iter_1 iteration=<n+1> --trigger verify_findings`", wave)
        # crash during wave_N_waiting
        self.assertIn("(`wave_<N>_redispatch_iter_1 iteration=<n+1> --trigger recovery --force`, per the handler)", wave)
        # sync --task/--hotfix gate
        self.assertIn("any BLOCKED or failed gate → stay in `single_task`/`hotfix`", td)
        self.assertIn("`wave_<N>_redispatch_iter_*` is unreachable here", td)
        self.assertNotIn("wave_<N>_redispatch_iter_1 iteration=<n+1> --trigger blocked", td)
        # event-log crash resume
        self.assertIn("`--trigger recovery --force` per the task-dispatch.md handler", resume)

    def test_trigger_flag_handler_states_force_for_mid_wave_recovery(self):
        handler = self._handler()
        self.assertIn("`recovery` from a mid-wave cursor (`wave_<N>_waiting`, `wave_<N>_boundary`) needs `--force`: "
                      "`... --trigger recovery --force`", handler)
        self.assertIn("entry only from `wave_<N>_dispatch`, `wave_<N>_recovery` and `wave_<N>_verify` (no `--force`)", handler)
        # the other triggers never carry --force in the entry-point text
        wave = read(SHIP_EXECUTE_WAVE_REF)
        for frag in ("--trigger blocked`", "--trigger gate_failure`", "--trigger verify_findings`"):
            self.assertIn(frag, wave)

    def test_trigger_flag_recovery_command_needs_force_from_waiting_real_cli(self):
        # AC-18: the documented recovery entry is accepted by the real cursor graph only with --force.
        import os, shutil, subprocess, tempfile
        wave = read(SHIP_EXECUTE_WAVE_REF)
        m = re.search(r"`(wave_<N>_redispatch_iter_1 iteration=<n\+1> --trigger recovery --force)`", wave)
        self.assertIsNotNone(m)
        doc_args = m.group(1).replace("<N>", "1").replace("<n+1>", "2").split()
        self.assertEqual(doc_args[-1], "--force")
        root = tempfile.mkdtemp(prefix="t083-force-")
        try:
            proj, pdata = Path(root, "proj"), Path(root, "pdata")
            proj.mkdir(); pdata.mkdir()
            env = dict(os.environ, CLAUDE_PROJECT_DIR=str(proj), CLAUDE_PLUGIN_DATA=str(pdata))
            env.pop("SHIPYARD_DATA", None)
            git = ["git", "-c", "user.email=t@t", "-c", "user.name=t"]
            subprocess.run(["git", "init", "-q", str(proj)], check=True)
            subprocess.run(git + ["-C", str(proj), "commit", "-q", "--allow-empty", "-m", "init"], check=True)
            cli = [str(PROJECT_ROOT / "bin" / "shipyard-data.mjs")]

            def run(*args):
                return subprocess.run(["node", *cli, *args], cwd=proj, capture_output=True, text=True, env=env)

            self.assertEqual(run("init").returncode, 0)
            self.assertEqual(run("init-sprint", "sprint-001").returncode, 0)
            r = run("cursor", "advance", "execute", "wave_1_waiting", "wave_number=1", "--force")
            self.assertEqual(r.returncode, 0, r.stderr)
            denied = run("cursor", "advance", "execute", *[a for a in doc_args if a != "--force"])
            self.assertEqual(denied.returncode, 3, denied.stdout + denied.stderr)
            ok = run("cursor", "advance", "execute", *doc_args)
            self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
            logs = list(pdata.rglob(".shipyard-events.jsonl"))
            self.assertEqual(len(logs), 1)
            ticks = [json.loads(l) for l in logs[0].read_text().splitlines() if "pipeline_tick_completed" in l]
            last = ticks[-1]
            self.assertEqual((last["stage"], last["next_stage"], last.get("trigger")),
                             ("wave_1_waiting", "wave_1_redispatch_iter_1", "recovery"))
        finally:
            shutil.rmtree(root, ignore_errors=True)

    def test_trigger_flag_router_pin_unchanged_and_no_handler_copy(self):
        self.assertIn("wave_<N>_redispatch_iter_1 iteration=<n+1>", read(SHIP_EXECUTE_SKILL))
        self.assertNotIn("--trigger", read(SHIP_EXECUTE_SKILL))

    def _scratch_run(self, args):
        import os, shutil, subprocess, tempfile
        d = tempfile.mkdtemp(prefix="t083-")
        try:
            env = dict(os.environ, CLAUDE_PROJECT_DIR=d)
            r = subprocess.run(["node", str(BIN_DIR / "shipyard-data.mjs"), *args, "--data-dir", d],
                               capture_output=True, text=True, env=env)
            log = Path(d) / ".shipyard-events.jsonl"
            return r, (log.read_text() if log.exists() else "")
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_trigger_flag_verify_findings_command_parses_against_real_cli(self):
        # AC-17: the skill text invokes the real verify-findings verb, counts only.
        wave = read(SHIP_EXECUTE_WAVE_REF)
        cmds = re.findall(r"`shipyard-data (verify findings [^`]*)`", wave)
        self.assertEqual(len(cmds), 1, cmds)
        cmd = cmds[0]
        for flag in ("--wave", "--tasks", "--met", "--partial", "--missing", "--over-built"):
            self.assertIn(flag, cmd)
        argv = cmd.replace("<N>", "3").replace("<P001,P002>", "P001,P002").replace("<n>", "2").split()
        r, log = self._scratch_run(argv)
        self.assertEqual(r.returncode, 0, r.stderr)
        ev = [json.loads(l) for l in log.splitlines() if "wave_verify_findings" in l][0]
        self.assertEqual((ev["wave"], ev["task_ids"], ev["finding_count"]), (3, "P001,P002", 8))
        self.assertIn("never finding text", wave)

    def test_trigger_flag_verify_findings_precedes_advance_or_redispatch(self):
        wave = read(SHIP_EXECUTE_WAVE_REF)
        item = [l for l in wave.splitlines() if l.startswith("7. **Wave VERIFY")][0]
        self.assertLess(item.index("verify findings"), item.index("redispatch_iter_1"))
        self.assertIn("BEFORE advancing or re-dispatching", item)

    def test_trigger_flag_event_types_registered(self):
        # AC-1, AC-17, AC-18, AC-20: new fields and events are documented in the shipped catalog.
        text = read(EVENT_TYPES_REF)
        row = [l for l in text.splitlines() if l.startswith("| `wave_verify_findings`")][0]
        for f in ("wave", "task_ids", "finding_count", "met", "partial", "missing", "over_built"):
            self.assertIn(f"`{f}`", row, f)
        tick = [l for l in text.splitlines() if l.startswith("| `pipeline_tick_completed`")][0]
        self.assertIn("`trigger`", tick)
        self.assertIn("`trigger_missing`", tick)
        for t in ("task_dispatch_returned", "subagent_completed"):
            line = [l for l in text.splitlines() if l.startswith(f"| `{t}`")][0]
            for f in ("role", "model", "effort", "attempt", "tokens"):
                self.assertIn(f"`{f}`", line, f"{t} {f}")
        for t in ("worker_queue_completed", "worker_queue_failed"):
            line = [l for l in text.splitlines() if l.startswith(f"| `{t}`")][0]
            self.assertIn("`claim_attempt`", line)
            self.assertIn("`kind`", line)
        self.assertIn("completed_unacked", text)


if __name__ == "__main__":
    unittest.main()
