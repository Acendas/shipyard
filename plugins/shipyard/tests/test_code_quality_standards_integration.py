"""
Contract tests for the shared build/verify code-quality standard (v3.13.0).

Validates that the shared reference exists, that the seven general dimensions
each carry both a Construct and a Verify half, that `data` stays a
cross-reference stub (not a duplicate of data-implementation-guide.md), that
both consumers (builder side + reviewer side) are wired and gated, and that
the Construct halves stay construction guidance rather than a second
adjudication surface.
"""

import os
import re

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(TESTS_DIR)
SKILLS_DIR = os.path.join(PLUGIN_ROOT, "skills")
REFS_DIR = os.path.join(PLUGIN_ROOT, "project-files", "references")
AGENTS_DIR = os.path.join(PLUGIN_ROOT, "agents")

QUALITY_STANDARDS = os.path.join(REFS_DIR, "code-quality-standards.md")

TASK_LOOP = os.path.join(SKILLS_DIR, "dispatching-task-loop", "SKILL.md")
CODE_REVIEW = os.path.join(SKILLS_DIR, "dispatching-code-review", "SKILL.md")
BUILDER_AGENT = os.path.join(AGENTS_DIR, "shipyard-disciplined-builder.md")
CODE_REVIEWER_AGENT = os.path.join(AGENTS_DIR, "shipyard-code-reviewer.md")
SPEC_REVIEWER_AGENT = os.path.join(AGENTS_DIR, "shipyard-spec-reviewer.md")

GENERAL_DIMENSIONS = [
    "security", "bugs", "silent-failures", "patterns", "tests",
    "observability", "simplicity",
]

# Vocabulary that belongs to adjudication (scoring/classifying a finding),
# never to construction guidance.
ADJUDICATION_VOCAB = [
    r"confidence",
    r"(?:≥|>=)\s*80",
    r"FINDINGS:",
    r"\bMET\b",
    r"\bPARTIAL\b",
    r"OVER-BUILT",
]


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def norm(text):
    """Collapse whitespace (including line-wrap newlines) to single spaces so
    a multi-word phrase assertion doesn't break on markdown line-wrapping."""
    return re.sub(r"\s+", " ", text)


def section_body(text, heading_pattern, heading_level_pattern=r"##"):
    """Return the text between a `## <heading>` (or given level) match and the
    next heading of the same or higher level, or EOF."""
    m = re.search(rf"^{heading_level_pattern}\s+{heading_pattern}\s*$", text, re.MULTILINE)
    assert m, f"heading not found: {heading_pattern}"
    start = m.end()
    rest = text[start:]
    next_heading = re.search(rf"^{heading_level_pattern}\s+", rest, re.MULTILINE)
    return rest[: next_heading.start()] if next_heading else rest


# ── The file exists ─────────────────────────────────────────────────────────

class TestFileExists:
    def test_quality_standards_exists(self):
        assert os.path.exists(QUALITY_STANDARDS)


# ── Each general dimension has both halves ──────────────────────────────────

class TestDimensionsHaveConstructAndVerify:
    def test_each_general_dimension_has_both_halves(self):
        c = read(QUALITY_STANDARDS)
        for dim in GENERAL_DIMENSIONS:
            body = section_body(c, re.escape(dim))
            assert re.search(r"^###\s+Construct\s*$", body, re.MULTILINE), \
                f"`## {dim}` is missing a `### Construct` half"
            assert re.search(r"^###\s+Verify\s*$", body, re.MULTILINE), \
                f"`## {dim}` is missing a `### Verify` half"

    def test_data_is_a_cross_reference_stub_not_a_duplicate(self):
        c = read(QUALITY_STANDARDS)
        body = section_body(c, "data")
        assert "data-implementation-guide.md" in body, \
            "the data entry must point at data-implementation-guide.md"
        assert "### Construct" not in body and "### Verify" not in body, \
            "the data entry must be a pointer, not a duplicated Construct/Verify block"

    def test_simplicity_construct_states_the_necessity_ladder(self):
        c = read(QUALITY_STANDARDS)
        body = section_body(c, "simplicity")
        construct = section_body(body, "Construct", heading_level_pattern=r"###")
        for rung in ["does it need to exist", "already in the codebase",
                     "stdlib", "installed dependency"]:
            assert re.search(rung, construct, re.IGNORECASE), \
                f"simplicity Construct must state the ladder rung: {rung}"

    def test_simplicity_verify_defers_to_patterns_and_over_built(self):
        c = read(QUALITY_STANDARDS)
        body = section_body(c, "simplicity")
        verify = section_body(body, "Verify", heading_level_pattern=r"###")
        assert re.search(r"patterns", verify, re.IGNORECASE)
        assert re.search(r"OVER-BUILT", verify)
        assert re.search(r"do not add a separate simplicity scan", verify, re.IGNORECASE)


# ── Both consumers are wired ────────────────────────────────────────────────

class TestConsumersWired:
    def test_builder_side_references_quality_standards(self):
        c = read(TASK_LOOP) + read(BUILDER_AGENT)
        assert "code-quality-standards.md" in c, \
            "the builder side (dispatching-task-loop + shipyard-disciplined-builder) must reference the shared standard"

    def test_reviewer_side_references_quality_standards(self):
        c = read(CODE_REVIEW) + read(CODE_REVIEWER_AGENT)
        assert "code-quality-standards.md" in c, \
            "the reviewer side (dispatching-code-review + shipyard-code-reviewer) must reference the shared standard"

    def test_builder_wiring_is_gated(self):
        c = read(TASK_LOOP)
        assert "quality_standards_digest" in c, \
            "dispatching-task-loop must name the quality_standards_digest input"
        assert re.search(r"effort:\s*S|omitted for effort|gated", c, re.IGNORECASE), \
            "the quality_standards_digest wiring must carry a visible skip/gate clause"

    def test_reviewer_side_reads_it_as_part_of_the_brief(self):
        c = read(CODE_REVIEW)
        assert "quality_standards_path" in c


# ── Construct halves are construction guidance, not adjudication ────────────

class TestNoAdjudicationVocabInConstruct:
    def test_construct_halves_have_no_adjudication_vocabulary(self):
        c = read(QUALITY_STANDARDS)
        for dim in GENERAL_DIMENSIONS:
            body = section_body(c, re.escape(dim))
            construct = section_body(body, "Construct", heading_level_pattern=r"###")
            for pattern in ADJUDICATION_VOCAB:
                assert not re.search(pattern, construct, re.IGNORECASE), \
                    f"`## {dim}` ### Construct contains adjudication vocabulary matching {pattern!r}"


# ── The builder's Construction Standards section ────────────────────────────

class TestBuilderConstructionStandardsSection:
    def test_builder_has_construction_standards_section(self):
        c = read(BUILDER_AGENT)
        assert re.search(r"^#\s+Construction Standards\s*$", c, re.MULTILINE)

    def test_construction_standards_names_the_scope_bound(self):
        c = read(BUILDER_AGENT)
        body = section_body(c, "Construction Standards", heading_level_pattern=r"#")
        assert re.search(r"OVER-BUILT", body), \
            "Construction Standards must name the OVER-BUILT scope bound"
        assert re.search(r"build to spec", body, re.IGNORECASE), \
            "Construction Standards must state the build-to-spec bound"

    def test_construction_standards_is_not_an_adjudication_surface(self):
        c = read(BUILDER_AGENT)
        body = norm(section_body(c, "Construction Standards", heading_level_pattern=r"#"))
        assert re.search(r"do not score confidence, classify findings, or self-review", body, re.IGNORECASE)

    def test_construction_standards_precedes_required_return_shape(self):
        c = read(BUILDER_AGENT)
        cs = re.search(r"^#\s+Construction Standards\s*$", c, re.MULTILINE)
        rrs = re.search(r"^#\s+Required Return Shape\s*$", c, re.MULTILINE)
        assert cs and rrs and cs.start() < rrs.start(), \
            "Construction Standards must sit before Required Return Shape (which must stay the last section)"


# ── Spec reviewer's OVER-BUILT counterweight ────────────────────────────────

class TestSpecReviewerOverBuiltCounterweight:
    def test_over_built_definition_names_quality_hardening(self):
        c = read(SPEC_REVIEWER_AGENT)
        assert re.search(r"OVER-BUILT", c)
        assert re.search(r"[Qq]uality-hardening beyond what an AC requires", c)
