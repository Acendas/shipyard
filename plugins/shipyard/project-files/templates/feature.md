---
id: ""
title: ""
type: feature
epic: ""
status: proposed
story_points: 0
complexity: ""
token_estimate: 0
rice_reach: 0
rice_impact: 0
rice_confidence: 0
rice_effort: 0
rice_score: 0
feasibility: 0
dependencies: []
references: []  # full relative paths: $(shipyard-data)/spec/references/FNNN-slug.md
children: []
tasks: []
created: null
updated: null
# REQUIRED at /ship-review approval-time (Shipyard 2.0 — F-44):
# demo_probe: |
#   <single shell command, exit 0 == feature works end-to-end, observable
#    output, deterministic, bounded ≤120s. Distinct from per-task acceptance
#    probes — this exercises the cross-task user-facing flow. Authored by
#    /ship-discuss alongside acceptance criteria; consumed by /ship-review's
#    Stage 4.8 demo verification before user approval is offered.>
# Example:
#   demo_probe: |
#     curl -fsS -X POST localhost:3000/auth/signup -d '{"email":"d@d.io","password":"x"}' \
#       | jq -e .id
# Without one, /ship-review refuses to advance to user approval. If the
# feature is genuinely too cross-cutting to demo (rare), explicitly mark:
#   demo_probe: skip-with-reason
#   demo_probe_skip_reason: "<why the cross-task flow can't be one shell command>"
# and reviewer surfaces it to user as a known limitation.
---

# [Title]

## User Story

As a [user], I want [capability] so that [benefit].

## Why This Matters

## Acceptance Criteria

```gherkin
Feature: [Title]

  Scenario: [Happy path]
    Given [context]
    When [action]
    Then [expected result]

  Scenario: [Error/edge case]
    Given [context]
    When [action]
    Then [expected result]
```

## Interface

<!-- API endpoints, method signatures, events, request/response shapes. Remove this section if not applicable. -->
<!-- If this section exceeds ~50 lines, extract to $(shipyard-data)/spec/references/FNNN-api.md -->

## Data Model

<!-- Schema definitions, field types, constraints, relationships. Remove this section if not applicable. -->
<!-- Use Mermaid ER diagrams for complex schemas -->
<!-- If this section exceeds ~50 lines, extract to $(shipyard-data)/spec/references/FNNN-schema.md -->

## Configuration

<!-- Settings, environment variables, feature flags with types and defaults. Remove this section if not applicable. -->
<!-- If this section exceeds ~30 lines, extract to $(shipyard-data)/spec/references/FNNN-config.md -->

## Flows

<!-- Sequence diagrams, state machines, user journeys — use Mermaid. Remove this section if not applicable. -->
<!-- If this section exceeds ~50 lines, extract to $(shipyard-data)/spec/references/FNNN-flows.md -->

## Error Handling

<!-- Failure modes, error codes/messages, recovery strategies. Remove this section if not applicable. -->

## Technical Notes

## Decision Log

| Date | Decision | Options | Chosen | Reasoning |
|------|----------|---------|--------|-----------|
