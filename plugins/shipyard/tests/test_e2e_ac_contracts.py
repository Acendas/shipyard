"""
Cross-skill contract tests for the E2E Acceptance Criteria feature.

Validates that data flows correctly between skills:
  taxonomy → validating-e2e-coverage → extracting-acceptance-criteria → feature template
  feature E2E AC → quality-manifest → ship-review quality-gate-enforcement
"""

import os
import re
import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(TESTS_DIR)
SKILLS_DIR = os.path.join(PLUGIN_ROOT, "skills")

TAXONOMY_PATH = os.path.join(SKILLS_DIR, "discovering-edge-cases", "references", "e2e-taxonomy.md")
VALIDATING_SKILL_PATH = os.path.join(SKILLS_DIR, "validating-e2e-coverage", "SKILL.md")
EXTRACTING_SKILL_PATH = os.path.join(SKILLS_DIR, "extracting-acceptance-criteria", "SKILL.md")
FEATURE_TEMPLATE_PATH = os.path.join(PLUGIN_ROOT, "project-files", "templates", "feature.md")
QUALITY_MANIFEST_PATH = os.path.join(SKILLS_DIR, "ship-sprint", "references", "quality-manifest.md")
GATE_ENFORCEMENT_PATH = os.path.join(SKILLS_DIR, "ship-review", "references", "quality-gate-enforcement.md")
SHIP_DISCUSS_PATH = os.path.join(SKILLS_DIR, "ship-discuss", "SKILL.md")
SPEC_RULES_PATH = os.path.join(PLUGIN_ROOT, "project-files", "rules", "shipyard-spec.md")


def read_file(path):
    with open(path, "r") as f:
        return f.read()


def extract_taxonomy_slugs(content):
    slugs = []
    for m in re.finditer(r"^### \d+\.\s+(\S+)\s+\(", content, re.MULTILINE):
        slugs.append(m.group(1))
    return slugs


# --- Contract 1: Taxonomy → validating-e2e-coverage ---

class TestTaxonomyToValidatingSkill:
    """Every category slug the validating skill mentions must exist in the taxonomy."""

    def test_validating_skill_references_taxonomy_file(self):
        content = read_file(VALIDATING_SKILL_PATH)
        assert "e2e-taxonomy" in content, "validating-e2e-coverage must reference the taxonomy file"

    def test_validating_skill_mentions_known_categories(self):
        taxonomy = read_file(TAXONOMY_PATH)
        skill = read_file(VALIDATING_SKILL_PATH)
        taxonomy_slugs = extract_taxonomy_slugs(taxonomy)
        assert len(taxonomy_slugs) > 0, "Taxonomy must have category slugs"
        slugs_in_skill = re.findall(r'"(timeout|idempotency|privilege-escalation|graceful-degradation)"', skill)
        for slug in slugs_in_skill:
            assert slug in taxonomy_slugs, f"Slug '{slug}' in validating skill not found in taxonomy"


# --- Contract 2: extracting-acceptance-criteria schema → feature template ---

class TestSchemaToTemplate:
    """The feature template must accommodate the tiered AC structure the schema defines."""

    def test_extracting_skill_defines_tier_field(self):
        content = read_file(EXTRACTING_SKILL_PATH)
        assert '"tier"' in content, "extracting-acceptance-criteria must define the tier field"
        assert '"core"' in content and '"e2e"' in content, "tier must have core and e2e values"

    def test_feature_template_has_tiered_sections(self):
        content = read_file(FEATURE_TEMPLATE_PATH)
        assert "### Core AC" in content, "Feature template must have ### Core AC section"
        assert "### E2E AC" in content, "Feature template must have ### E2E AC section"

    def test_extracting_skill_defines_verification_type(self):
        content = read_file(EXTRACTING_SKILL_PATH)
        assert "verification_type" in content
        assert '"probe"' in content
        assert '"tool"' in content
        assert '"manual"' in content


# --- Contract 3: Feature E2E AC → QUALITY-GATE.md ---

class TestFeatureACToQualityManifest:
    """The quality manifest protocol must reference the AC schema fields it reads."""

    def test_manifest_references_e2e_category(self):
        content = read_file(QUALITY_MANIFEST_PATH)
        assert "e2e_category" in content or "E2E AC" in content, \
            "Quality manifest must reference e2e_category or E2E AC as source"

    def test_manifest_references_verification_type(self):
        content = read_file(QUALITY_MANIFEST_PATH)
        assert "verification" in content.lower(), \
            "Quality manifest must reference verification type for gate routing"

    def test_manifest_has_standing_and_sprint_specific(self):
        content = read_file(QUALITY_MANIFEST_PATH)
        assert re.search(r"[Ss]tanding [Gg]ate", content), "Must have Standing Gates section"
        assert re.search(r"[Ss]print.Specific [Gg]ate", content), "Must have Sprint-Specific Gates section"

    def test_manifest_has_gate_status_values(self):
        content = read_file(QUALITY_MANIFEST_PATH)
        assert "pending" in content, "Gate status must include 'pending'"
        enforcement = read_file(GATE_ENFORCEMENT_PATH)
        assert "pass" in enforcement, "Enforcement protocol must define 'pass' status"
        assert "fail" in enforcement, "Enforcement protocol must define 'fail' status"


# --- Contract 4: QUALITY-GATE.md → ship-review Stage 1.5 ---

class TestManifestToReview:
    """The review enforcement protocol must handle the manifest structure the manifest defines."""

    def test_enforcement_reads_manifest(self):
        content = read_file(GATE_ENFORCEMENT_PATH)
        assert "QUALITY-GATE.md" in content, "Enforcement must reference QUALITY-GATE.md"

    def test_enforcement_handles_probe_gates(self):
        content = read_file(GATE_ENFORCEMENT_PATH)
        assert "probe" in content.lower(), "Enforcement must handle probe gates"

    def test_enforcement_handles_manual_gates(self):
        content = read_file(GATE_ENFORCEMENT_PATH)
        assert re.search(r"[Mm]anual", content), "Enforcement must handle manual gates"

    def test_enforcement_handles_gate_failure(self):
        content = read_file(GATE_ENFORCEMENT_PATH)
        assert re.search(r"[Ff]ail", content), "Enforcement must handle gate failures"

    def test_enforcement_writes_status_back(self):
        content = read_file(GATE_ENFORCEMENT_PATH)
        assert re.search(r"[Ss]tatus", content), "Enforcement must write status back to manifest"


# --- Contract 5: Phase numbering consistency ---

class TestPhaseNumbering:
    """ship-discuss phase numbers must be monotonically ordered with no duplicates."""

    def test_phase_3_7_is_e2e_validation(self):
        content = read_file(SHIP_DISCUSS_PATH)
        match = re.search(r"Phase 3\.7[:\s].*", content)
        assert match, "Phase 3.7 must exist"
        assert re.search(r"E2E|e2e", match.group(0)), \
            f"Phase 3.7 must be E2E AC Validation, got: {match.group(0)[:80]}"

    def test_phase_3_8_is_simplification(self):
        content = read_file(SHIP_DISCUSS_PATH)
        match = re.search(r"Phase 3\.8[:\s].*", content)
        assert match, "Phase 3.8 must exist"
        assert re.search(r"[Ss]implification", match.group(0)), \
            f"Phase 3.8 must be Simplification Scan, got: {match.group(0)[:80]}"

    def test_no_stale_phase_3_7_simplification(self):
        content = read_file(SHIP_DISCUSS_PATH)
        stale = re.findall(r"Phase 3\.7[:\s]+[Ss]implification", content)
        assert len(stale) == 0, \
            f"Found stale 'Phase 3.7: Simplification' headings: {stale}"


# --- Contract 6: Backward compatibility ---

class TestBackwardCompatibility:
    """Both the schema skill and the spec rules must document the same defaults for absent fields."""

    def test_extracting_skill_documents_defaults(self):
        content = read_file(EXTRACTING_SKILL_PATH)
        assert re.search(r"default|absent", content, re.IGNORECASE), \
            "extracting-acceptance-criteria must document defaults for absent fields"

    def test_spec_rules_document_defaults(self):
        content = read_file(SPEC_RULES_PATH)
        assert re.search(r"default|absent", content, re.IGNORECASE), \
            "shipyard-spec.md must document defaults for absent fields"

    def test_both_agree_on_core_default(self):
        extracting = read_file(EXTRACTING_SKILL_PATH)
        spec = read_file(SPEC_RULES_PATH)
        assert '"core"' in extracting, "extracting skill must mention core as default tier"
        assert '"core"' in spec or "core" in spec, "spec rules must mention core as default tier"

    def test_both_agree_on_probe_default(self):
        extracting = read_file(EXTRACTING_SKILL_PATH)
        spec = read_file(SPEC_RULES_PATH)
        assert '"probe"' in extracting, "extracting skill must mention probe as default verification_type"
        assert '"probe"' in spec or "probe" in spec, "spec rules must mention probe as default"
