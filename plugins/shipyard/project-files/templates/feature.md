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
external_refs: []           # links to external systems: "JIRA-123", "GH-456", "https://..."
children: []
tasks: []
created: null
updated: null
# REQUIRED — authored by /ship-discuss alongside acceptance criteria, gated at
# sprint-plan time, consumed by /ship-execute Step 5.3 and /ship-review Stage 4.8.
#
# user_flow_probe proves THE FEATURE WORKS FOR A USER. Unit/JVM/e2e-in-CI tests
# do not exercise the path a user takes; per-task acceptance_probe proves wiring
# within one task. This proves the cross-task, user-facing flow — by whatever
# means actually demonstrates it, including a human on a real device.
#
# user_flow_probe:
#   kind: auto | assisted | manual
#   command: |     # required for auto + assisted; omit for manual
#     <shell command; for auto, exit 0 == the user flow works>
#   steps: |       # required for assisted + manual; omit for auto
#     <numbered user steps + the expected observable outcome>
#
#   auto     — machine runs `command`, exit code is the verdict.
#              Deterministic, observable output, bounded ≤120s.
#   assisted — machine runs `command` to set up (deploy to device, seed data,
#              launch to the screen), then a human observes `steps` and confirms.
#   manual   — a human follows `steps` and confirms. No command.
#
# Example (auto):
#   user_flow_probe:
#     kind: auto
#     command: |
#       curl -fsS -X POST localhost:3000/auth/signup -d '{"email":"d@d.io","password":"x"}' \
#         | jq -e .id
#
# Example (assisted):
#   user_flow_probe:
#     kind: assisted
#     command: ./gradlew installDebug && adb shell am start -n com.app/.SignupActivity
#     steps: |
#       1. Enter a new email + password, tap Create Account.
#       2. Expect: lands on the home screen with the account name in the header.
#       3. Force-quit and reopen. Expect: still signed in.
#
# An assisted/manual verdict is RECORDED EVIDENCE, never a skip:
#   shipyard-data feature record-proof FNNN verdict=pass confirmed-by=<who> commit=<sha>
# which emits user_flow_probe_confirmed and satisfies sprint-complete invariant 8
# exactly as an exit-0 auto run does.
#
# skip-with-reason means NO PROOF OF ANY KIND EXISTS — not "it was checked by
# hand" (that is kind: manual). Rare, and surfaced to the user as a limitation:
#   user_flow_probe: skip-with-reason
#   user_flow_probe_skip_reason: "<why no user-facing flow can be demonstrated>"
#
# Legacy: a bare scalar `demo_probe: <command>` still reads as
# {kind: auto, command: <command>} for one release. Prefer the mapping.
---

# [Title]

## User Story

As a [user], I want [capability] so that [benefit].

## Why This Matters

## Acceptance Criteria

### Core AC

```gherkin
Feature: {{title}}

  Scenario: Happy path
    Given [context]
    When [action]
    Then [expected result]

  Scenario: Error / edge case
    Given [context]
    When [action]
    Then [expected result]
```

### E2E AC

<!-- Taxonomy-validated scenarios added by Phase 3.7 (E2E AC Validation). -->
<!-- Each scenario is tagged with its category: [timeout], [idempotency], etc. -->
<!-- Remove this section if no E2E AC apply to this feature. -->

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

<!-- C4, sequence, state machine, ER, deployment, data-flow, user journey — use Mermaid. Remove this section if not applicable. -->
<!-- If this section exceeds ~50 lines, extract to $(shipyard-data)/spec/references/FNNN-flows.md -->

## Error Handling

<!-- Failure modes, error codes/messages, recovery strategies. Remove this section if not applicable. -->

## Technical Notes

## Decision Log

| Date | Decision | Options | Chosen | Reasoning |
|------|----------|---------|--------|-----------|
