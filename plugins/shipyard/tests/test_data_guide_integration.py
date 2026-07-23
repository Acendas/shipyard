"""
Contract tests for the gated database-design reference integration.

Validates that the two shared guides exist, are significance-gated, are split by
altitude (modeling vs implementation), and are wired into the four consumers:
  - discuss (Phase 1.5)        -> data-modeling-guide.md
  - sprint (wave-decomposition) -> data-modeling-guide.md
  - execute (dispatching-task-loop builder) -> data-implementation-guide.md
  - code-review (dispatching-code-review)   -> data-implementation-guide.md
"""

import os
import re

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(TESTS_DIR)
SKILLS_DIR = os.path.join(PLUGIN_ROOT, "skills")
REFS_DIR = os.path.join(PLUGIN_ROOT, "project-files", "references")

MODELING_GUIDE = os.path.join(REFS_DIR, "data-modeling-guide.md")
IMPL_GUIDE = os.path.join(REFS_DIR, "data-implementation-guide.md")

PHASE_1_RESEARCH = os.path.join(SKILLS_DIR, "ship-discuss", "references", "phase-1-research.md")
SHIP_DISCUSS = os.path.join(SKILLS_DIR, "ship-discuss", "SKILL.md")
WAVE_DECOMP = os.path.join(SKILLS_DIR, "ship-sprint", "references", "wave-decomposition.md")
TASK_LOOP = os.path.join(SKILLS_DIR, "dispatching-task-loop", "SKILL.md")
CODE_REVIEW = os.path.join(SKILLS_DIR, "dispatching-code-review", "SKILL.md")
AGENTS_DIR = os.path.join(PLUGIN_ROOT, "agents")
CODE_REVIEWER_AGENT = os.path.join(AGENTS_DIR, "shipyard-code-reviewer.md")
BUILDER_AGENT = os.path.join(AGENTS_DIR, "shipyard-disciplined-builder.md")


def read(path):
    with open(path) as f:
        return f.read()


# ── The guides exist and are gated ──────────────────────────────────────────

class TestGuidesExistAndGated:
    def test_modeling_guide_exists(self):
        assert os.path.exists(MODELING_GUIDE)

    def test_implementation_guide_exists(self):
        assert os.path.exists(IMPL_GUIDE)

    def test_modeling_guide_has_gate(self):
        c = read(MODELING_GUIDE)
        assert re.search(r"^##\s+GATE", c, re.MULTILINE), "modeling guide must start with a GATE section"
        assert re.search(r"skip this guide entirely|no persistence concern", c, re.IGNORECASE), \
            "modeling guide gate must tell the reader to skip for non-data features"

    def test_implementation_guide_has_gate(self):
        c = read(IMPL_GUIDE)
        assert re.search(r"^##\s+GATE", c, re.MULTILINE), "implementation guide must start with a GATE section"
        assert re.search(r"skip this guide|doesn't touch the database", c, re.IGNORECASE), \
            "implementation guide gate must tell the reader to skip for non-DB work"


# ── The split is correct (altitude separation) ──────────────────────────────

class TestAltitudeSplit:
    def test_modeling_guide_covers_modeling_topics(self):
        c = read(MODELING_GUIDE)
        for topic in ["normaliz", "surrogate", "right.siz", "EAV", "OTLT", "dimensional|OLAP"]:
            assert re.search(topic, c, re.IGNORECASE), f"modeling guide must cover {topic}"

    def test_implementation_guide_covers_impl_topics(self):
        c = read(IMPL_GUIDE)
        for topic in ["index", "N\\+1", "SARGable|execution plan", "shard|partition|replica", "connection pool"]:
            assert re.search(topic, c, re.IGNORECASE), f"implementation guide must cover {topic}"

    def test_modeling_guide_is_not_implementation_dump(self):
        # The modeling half should NOT be the primary home for index/query mechanics.
        c = read(MODELING_GUIDE)
        assert "covering index" not in c.lower(), \
            "covering-index mechanics belong in the implementation guide, not the modeling guide"


# ── The four consumers are wired, each gated ────────────────────────────────

class TestConsumersWired:
    def test_discuss_phase1_gated_modeling_read(self):
        c = read(PHASE_1_RESEARCH)
        assert "data-modeling-guide.md" in c, "Phase 1.5 must reference the modeling guide"
        assert re.search(r"persists or models data|Data-modeling guidance \(gated\)", c), \
            "Phase 1.5 modeling-guide read must be gated on the data signal"
        assert re.search(r"[Ss]kip entirely for features with no persistence", c), \
            "Phase 1.5 must tell the model to skip the guide for non-data features"

    def test_discuss_skill_body_points_to_guide(self):
        c = read(SHIP_DISCUSS)
        assert "data-modeling-guide.md" in c, "ship-discuss SKILL.md summary must point to the modeling guide"

    def test_sprint_decomposition_gated_modeling_read(self):
        c = read(WAVE_DECOMP)
        assert "data-modeling-guide.md" in c, "wave-decomposition must reference the modeling guide"
        assert re.search(r"Data features \(gated\)|no persistence concern", c), \
            "sprint decomposition modeling-guide consult must be gated"

    def test_execute_builder_gated_impl_read(self):
        # Phase 3 split the builder's environment/reading-list/methodology body
        # into the registered shipyard-disciplined-builder agent; the wrapper
        # skill keeps only the gated-input summary. Check the combined surface,
        # same pattern Phase 1 used for the code-reviewer split.
        c = read(TASK_LOOP) + read(BUILDER_AGENT)
        assert "data-implementation-guide.md" in c, "builder reading list must include the implementation guide"
        assert "ONLY if this task touches the database" in c, \
            "builder implementation-guide read must be gated on DB-touching tasks"

    def test_code_review_gated_data_concern(self):
        # Phase 1 split the concern definitions (incl. the data concern) into
        # the registered shipyard-code-reviewer agent; the wrapper skill keeps
        # the auto-gate summary. Check the combined surface.
        c = read(CODE_REVIEW) + read(CODE_REVIEWER_AGENT)
        assert "data-implementation-guide.md" in c or "data-implementation guide" in c, \
            "code review must reference the implementation guide"
        assert re.search(r"auto-gat", c), "code review data concern must be auto-gated"
        assert re.search(r"touches NO database code, skip|skip this concern", c, re.IGNORECASE), \
            "code review must skip the data concern on non-DB diffs"


# ── Gating discipline: no consumer applies a guide unconditionally ───────────

class TestNoUnconditionalLoad:
    def test_every_consumer_reference_has_a_skip_clause(self):
        # Each wiring site that names a guide must also carry a skip/gate word nearby.
        for path, name in [(PHASE_1_RESEARCH, "phase-1-research"),
                           (WAVE_DECOMP, "wave-decomposition"),
                           (TASK_LOOP, "dispatching-task-loop"),
                           (CODE_REVIEW, "dispatching-code-review")]:
            c = read(path)
            assert re.search(r"[Ss]kip|ONLY if|gated|no persistence|NO database", c), \
                f"{name} references a guide but lacks a visible gate/skip clause"


# ── Review + critique surfaces are actually wired (the goal's named gaps) ────

ORCHESTRATION = os.path.join(SKILLS_DIR, "ship-review", "references", "code-review-orchestration.md")
DISCUSS_CRITIC = os.path.join(SKILLS_DIR, "ship-discuss", "references", "phase-quality-and-critique.md")
SPRINT_VALIDATION = os.path.join(SKILLS_DIR, "ship-sprint", "references", "spec-validation.md")
REVIEW_CRITIC = os.path.join(SKILLS_DIR, "ship-review", "references", "critic-prompt.md")


class TestCodeReviewDataConcernIsLive:
    """Regression guard for the dead-concern bug: a `## data` section that isn't
    in the iterated concerns array never runs."""

    def test_data_is_in_the_concerns_array(self):
        c = read(CODE_REVIEW)
        # The default concerns enumeration must include "data", or the
        # `for each concern in concerns_csv` loop never reaches the section.
        assert re.search(r'"observability",\s*"data"|"data"\s*\]', c), \
            "`data` must be a member of the concerns array, else the data concern is dead code"

    def test_data_concern_section_exists(self):
        # The concern definitions (including the `## data` section) live in
        # the registered shipyard-code-reviewer agent as of Phase 1.
        c = read(CODE_REVIEWER_AGENT)
        assert re.search(r"##\s+data \(auto-gated", c), "the data concern section must exist"

    def test_orchestration_lists_data_concern(self):
        c = read(ORCHESTRATION)
        assert re.search(r"`data`|\"data\"", c), "ship-review orchestration must list the data concern"
        assert re.search(r"exactly one subagent", c), \
            "parallel-split must assign data to exactly one subagent (no drop/duplicate)"

    def test_wave_verify_fires_on_data(self):
        c = read(CODE_REVIEW)
        assert re.search(r"database/persistence|persistence.*code", c), \
            "wave VERIFY trigger must fire for data/persistence-touching waves"


class TestCriticsAreDataAware:
    """All three critic prompts (discuss / sprint / review) challenge data-modeling
    decisions when the work persists data — and skip cleanly otherwise."""

    def test_discuss_critic_data_aware_and_gated(self):
        c = read(DISCUSS_CRITIC)
        assert re.search(r"persists or models data", c), "discuss critic must gate on persistence"
        assert re.search(r"EAV,\s*OTLT|unnormalized schema|missing constraints", c), \
            "discuss critic must name data anti-patterns"
        assert re.search(r"[Ss]kip entirely\s+for features with no persistence", c), \
            "discuss critic data dimension must be skippable for non-data features"

    def test_sprint_critic_data_aware_and_gated(self):
        c = read(SPRINT_VALIDATION)
        assert re.search(r"persists data", c), "sprint critic must gate on persistence"
        assert re.search(r"schema/migration/index/constraint|captures the data work", c), \
            "sprint critic must check the data decomposition"
        assert re.search(r"[Ss]kip this for sprints with no data-persisting feature", c), \
            "sprint critic data dimension must be skippable"

    def test_review_critic_data_aware_and_gated(self):
        c = read(REVIEW_CRITIC)
        assert re.search(r"persists or models data", c), "review critic must gate on persistence"
        assert re.search(r"data-modeling failure modes", c), "review critic must pre-mortem data failures"
        assert re.search(r"[Ss]kip this entirely for features\s+with no persistence", c, re.DOTALL), \
            "review critic data dimension must be skippable"


class TestSprintDataModelCheck:
    def test_check_22_exists_and_is_gated(self):
        c = read(SPRINT_VALIDATION)
        assert re.search(r"\|\s*22\s*\|", c), "spec-validation must have Check 22"
        assert re.search(r"Data work is decomposed", c), "Check 22 must be the data-decomposition check"
        assert re.search(r"skip entirely for non-data sprints|data features only", c, re.IGNORECASE), \
            "Check 22 must be gated on data features (no false positives on non-data sprints)"
