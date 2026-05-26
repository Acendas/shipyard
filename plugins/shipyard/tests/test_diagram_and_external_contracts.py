"""
Contract tests for diagram generation/persistence and external issue key linking.

Validates:
1. Diagram instructions flow from Phase 1.5 → Phase 3 → Flows section → Quality Gate
2. External refs flow from templates → ship-discuss → ship-spec absorb/sync
3. External issue fetch protocol references valid MCP patterns
"""

import os
import re
import pytest

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
PLUGIN_ROOT = os.path.dirname(TESTS_DIR)
SKILLS_DIR = os.path.join(PLUGIN_ROOT, "skills")

SHIP_DISCUSS_PATH = os.path.join(SKILLS_DIR, "ship-discuss", "SKILL.md")
PHASE_1_RESEARCH_PATH = os.path.join(SKILLS_DIR, "ship-discuss", "references", "phase-1-research.md")
PHASE_3_WRITE_SPEC_PATH = os.path.join(SKILLS_DIR, "ship-discuss", "references", "phase-3-write-spec.md")
QUALITY_GATE_PATH = os.path.join(SKILLS_DIR, "ship-discuss", "references", "phase-quality-and-critique.md")
EXTERNAL_FETCH_PATH = os.path.join(SKILLS_DIR, "ship-discuss", "references", "external-issue-fetch.md")
COMM_DESIGN_PATH = os.path.join(SKILLS_DIR, "ship-discuss", "references", "communication-design.md")
SHIP_SPEC_PATH = os.path.join(SKILLS_DIR, "ship-spec", "SKILL.md")
FEATURE_TEMPLATE_PATH = os.path.join(PLUGIN_ROOT, "project-files", "templates", "feature.md")
EPIC_TEMPLATE_PATH = os.path.join(PLUGIN_ROOT, "project-files", "templates", "epic.md")
TASK_TEMPLATE_PATH = os.path.join(PLUGIN_ROOT, "project-files", "templates", "task.md")
SPEC_RULES_PATH = os.path.join(PLUGIN_ROOT, "project-files", "rules", "shipyard-spec.md")


def read_file(path):
    with open(path, "r") as f:
        return f.read()


# ============================================================
# DIAGRAM GENERATION & PERSISTENCE CONTRACTS
# ============================================================

class TestDiagramGenerationChain:
    """Diagram instructions must form a complete chain: Phase 1.5 Step 4 -> Phase 3 Flows -> Quality Gate check."""

    def test_phase_1_research_has_numbered_diagram_step(self):
        content = read_file(PHASE_1_RESEARCH_PATH)
        assert re.search(r"4\.\s+\*\*[Aa]rchitecture [Vv]isualization", content), \
            "Phase 1.5 must have Step 4: Architecture visualization as a numbered step"

    def test_phase_1_research_c4_trigger(self):
        content = read_file(PHASE_1_RESEARCH_PATH)
        assert "C4" in content, "Phase 1.5 Step 4 must mention C4 diagrams"
        assert re.search(r"2\+.*service|multiple.*service|span.*service", content), \
            "C4 trigger must mention multi-service features"

    def test_phase_1_research_sequence_trigger(self):
        content = read_file(PHASE_1_RESEARCH_PATH)
        assert re.search(r"[Ss]equence diagram", content), "Phase 1.5 Step 4 must mention sequence diagrams"
        assert re.search(r"3\+.*component|three.*component", content, re.IGNORECASE), \
            "Sequence trigger must mention 3+ components"

    def test_phase_1_research_state_machine_trigger(self):
        content = read_file(PHASE_1_RESEARCH_PATH)
        assert re.search(r"[Ss]tate machine", content), "Phase 1.5 Step 4 must mention state machine diagrams"
        assert re.search(r"lifecycle|state.*transition", content, re.IGNORECASE), \
            "State machine trigger must mention lifecycle or state transitions"

    def test_phase_1_research_skip_criteria(self):
        content = read_file(PHASE_1_RESEARCH_PATH)
        assert re.search(r"[Ss]kip.*single.*component|one component|entirely within one", content), \
            "Step 4 must have skip criteria for single-component features"

    def test_phase_3_captures_diagrams_to_flows(self):
        content = read_file(PHASE_3_WRITE_SPEC_PATH)
        assert re.search(r"[Mm]ermaid", content), "Phase 3 must mention Mermaid for diagram persistence"
        assert re.search(r"Flows", content), "Phase 3 must reference the Flows section"
        assert re.search(r"Phase 1\.5|Phase 1\.5.*diagram|diagram.*Phase 1\.5", content), \
            "Phase 3 must reference diagrams from Phase 1.5"

    def test_phase_3_mermaid_syntax_types(self):
        content = read_file(PHASE_3_WRITE_SPEC_PATH)
        mermaid_types = ["C4Context", "C4Container", "sequenceDiagram", "stateDiagram", "journey",
                         "graph TD", "graph LR"]
        found = [t for t in mermaid_types if t in content]
        assert len(found) >= 3, \
            f"Phase 3 must list at least 3 Mermaid syntax types, found: {found}"

    def test_phase_3_flows_overflow_to_reference(self):
        content = read_file(PHASE_3_WRITE_SPEC_PATH)
        assert re.search(r"FNNN-flows\.md|flows\.md", content), \
            "Phase 3 must document overflow path to FNNN-flows.md reference file"

    def test_quality_gate_has_diagram_check(self):
        content = read_file(QUALITY_GATE_PATH)
        assert re.search(r"\|\s*16\s*\|", content), "Quality gate must have check #16"
        # Find the line containing check 16 and verify it mentions diagrams
        lines = content.split("\n")
        check_16_text = ""
        for line in lines:
            if re.search(r"\|\s*16\s*\|", line):
                check_16_text = line
                break
        assert re.search(r"[Dd]iagram|[Ff]lows", check_16_text), \
            "Check #16 must be about diagrams/Flows"

    def test_skill_summary_mentions_step_4(self):
        content = read_file(SHIP_DISCUSS_PATH)
        assert re.search(r"\(4\).*[Aa]rchitecture [Vv]isualization|\(4\).*diagram", content), \
            "ship-discuss SKILL.md Phase 1.5 summary must mention Step 4"

    def test_skill_summary_mentions_diagram_persistence(self):
        content = read_file(SHIP_DISCUSS_PATH)
        assert re.search(r"[Dd]iagram.*persist|persist.*diagram|[Mm]ermaid.*Flows|Flows.*[Mm]ermaid", content), \
            "ship-discuss SKILL.md must mention diagram persistence to Flows section"

    def test_communication_design_has_c4_patterns(self):
        content = read_file(COMM_DESIGN_PATH)
        assert "C4" in content, "communication-design.md must have C4 patterns"

    def test_communication_design_has_sequence_patterns(self):
        content = read_file(COMM_DESIGN_PATH)
        assert re.search(r"[Ss]equence", content), "communication-design.md must have sequence diagram patterns"


class TestDiagramFeatureTemplate:
    """Feature template must support diagram content."""

    def test_feature_template_has_flows_section(self):
        content = read_file(FEATURE_TEMPLATE_PATH)
        assert "Flows" in content or "flows" in content, \
            "Feature template must have a Flows section for diagrams"

    def test_feature_template_mentions_mermaid(self):
        content = read_file(FEATURE_TEMPLATE_PATH)
        assert re.search(r"[Mm]ermaid", content), \
            "Feature template Flows section must mention Mermaid"


# ============================================================
# EXTERNAL ISSUE KEY LINKING CONTRACTS
# ============================================================

class TestExternalRefSchema:
    """external_refs must be consistently defined across all entity types."""

    def test_feature_template_has_external_refs(self):
        content = read_file(FEATURE_TEMPLATE_PATH)
        assert "external_refs" in content, "Feature template must have external_refs field"

    def test_epic_template_has_external_refs(self):
        content = read_file(EPIC_TEMPLATE_PATH)
        assert "external_refs" in content, "Epic template must have external_refs field"

    def test_task_template_has_external_refs(self):
        content = read_file(TASK_TEMPLATE_PATH)
        assert "external_refs" in content, "Task template must have external_refs field"

    def test_spec_rules_document_external_refs(self):
        content = read_file(SPEC_RULES_PATH)
        assert "external_refs" in content, "shipyard-spec.md must document external_refs"
        assert re.search(r"[Ee]xternal [Rr]eferences", content), \
            "shipyard-spec.md must have an External References section"

    def test_all_templates_default_to_empty_array(self):
        for path, name in [(FEATURE_TEMPLATE_PATH, "feature"),
                           (EPIC_TEMPLATE_PATH, "epic"),
                           (TASK_TEMPLATE_PATH, "task")]:
            content = read_file(path)
            assert re.search(r"external_refs:\s*\[\]", content), \
                f"{name} template external_refs must default to []"


class TestExternalIssueFetchProtocol:
    """External issue fetch reference must have complete protocol."""

    def test_fetch_ref_exists(self):
        assert os.path.exists(EXTERNAL_FETCH_PATH), "external-issue-fetch.md must exist"

    def test_fetch_has_detection_pattern(self):
        content = read_file(EXTERNAL_FETCH_PATH)
        assert re.search(r"\[A-Z\]\+-\\d\+|\[A-Z\].*\\d|uppercase.*hyphen.*digit", content), \
            "Must document the issue key detection pattern"

    def test_fetch_has_mcp_tool_discovery(self):
        content = read_file(EXTERNAL_FETCH_PATH)
        assert re.search(r"[Mm]CP.*tool|tool.*available|[Dd]iscover.*tool", content), \
            "Must document MCP tool discovery step"

    def test_fetch_has_jira_tool_patterns(self):
        content = read_file(EXTERNAL_FETCH_PATH)
        assert "jira" in content.lower(), "Must mention Jira tool patterns"

    def test_fetch_has_github_tool_patterns(self):
        content = read_file(EXTERNAL_FETCH_PATH)
        assert "github" in content.lower() or "GitHub" in content, \
            "Must mention GitHub tool patterns"

    def test_fetch_has_fallback_to_paste(self):
        content = read_file(EXTERNAL_FETCH_PATH)
        assert re.search(r"[Pp]aste|no.*MCP|no.*tool.*available|fall.*back", content), \
            "Must have fallback when no MCP tools are available"

    def test_fetch_auto_links_external_refs(self):
        content = read_file(EXTERNAL_FETCH_PATH)
        assert "external_refs" in content, "Must auto-link to external_refs"

    def test_fetch_has_duplicate_detection(self):
        content = read_file(EXTERNAL_FETCH_PATH)
        assert re.search(r"already linked|already.*feature|duplicate", content, re.IGNORECASE), \
            "Must check if issue key is already linked to an existing feature"

    def test_fetch_has_bidirectional_linking(self):
        content = read_file(EXTERNAL_FETCH_PATH)
        assert re.search(r"[Bb]i.directional|push.*link.*back|link back|comment.*external", content), \
            "Must offer to push a link back to the external issue"

    def test_fetch_excludes_shipyard_ids(self):
        content = read_file(EXTERNAL_FETCH_PATH)
        assert re.search(r"F001|E001|T001|IDEA|Shipyard.*ID|NOT.*Shipyard", content), \
            "Must explicitly exclude Shipyard's own ID patterns"


class TestShipDiscussExternalMode:
    """ship-discuss must route external issue keys correctly."""

    def test_mode_detection_has_external(self):
        content = read_file(SHIP_DISCUSS_PATH)
        assert re.search(r"EXTERNAL", content), "Mode detection must include EXTERNAL mode"

    def test_external_mode_references_fetch_protocol(self):
        content = read_file(SHIP_DISCUSS_PATH)
        assert "external-issue-fetch" in content, \
            "EXTERNAL mode must reference external-issue-fetch.md"

    def test_external_mode_before_heuristic(self):
        content = read_file(SHIP_DISCUSS_PATH)
        external_pos = content.find("EXTERNAL")
        heuristic_pos = content.find("Heuristic-classified")
        assert external_pos < heuristic_pos, \
            "EXTERNAL mode must be in the unambiguous section (before heuristic)"

    def test_argument_hint_includes_issue_key(self):
        content = read_file(SHIP_DISCUSS_PATH)
        assert re.search(r"issue key|issue.*key", content[:500]), \
            "argument-hint must mention issue key as valid input"


class TestShipSpecExternalSync:
    """ship-spec sync must handle external keys and push to trackers."""

    def test_sync_accepts_external_key(self):
        content = read_file(SHIP_SPEC_PATH)
        assert re.search(r"sync.*SYS-123|sync.*external.*key", content), \
            "ship-spec must document sync by external issue key"

    def test_sync_resolves_via_grep(self):
        content = read_file(SHIP_SPEC_PATH)
        assert re.search(r"[Gg]rep.*external_refs|external_refs.*[Gg]rep|resolve.*external", content), \
            "sync by external key must resolve via grepping external_refs"

    def test_sync_handles_no_match(self):
        content = read_file(SHIP_SPEC_PATH)
        assert re.search(r"[Nn]o.*feature.*match|[Nn]o.*match|[Nn]o Shipyard feature", content), \
            "sync must handle case where no feature matches the external key"

    def test_sync_handles_multiple_matches(self):
        content = read_file(SHIP_SPEC_PATH)
        assert re.search(r"[Mm]ultiple.*feature|multiple.*match|both", content), \
            "sync must handle case where multiple features match the external key"

    def test_sync_pushes_to_external(self):
        content = read_file(SHIP_SPEC_PATH)
        assert re.search(r"[Pp]ush.*external|[Ee]xternal.*push|comment.*external|post.*sync|tracker.*MCP", content), \
            "sync F001 must push state to linked external issues"

    def test_sync_preserves_external_refs(self):
        content = read_file(SHIP_SPEC_PATH)
        assert re.search(r"[Pp]reserve.*external_refs|external_refs.*[Pp]reserve|never overwrite.*external", content), \
            "sync must never overwrite or clear external_refs"

    def test_absorb_detects_issue_keys(self):
        content = read_file(SHIP_SPEC_PATH)
        assert re.search(r"[Dd]etect.*issue.*key|[A-Z]\+-\\d\+|absorb.*external", content), \
            "absorb must detect issue keys in absorbed documents"
