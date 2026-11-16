---
id: ""
title: ""
type: feature           # feature | bug (a bug is a story with type: bug — reproduction fields below)
epic: ""
status: proposed
fix_version: ""             # the release this is expected to ship in (empty: its epic's); set with: shipyard-data version set <version> <id>
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
references: []  # leave empty here; add each with: shipyard-data story add-ref <id> <path>   (files live in $(shipyard-data)/spec/references/SNNN-slug.md)
external_refs: []           # links to external systems: "JIRA-123", "GH-456", "https://..."
children: []
steps: []               # builder steps (P###) created by /ship-sprint; the hidden TDD units
ui: false               # true = a UI story (E005): needs an approved design (`shipyard-data design approve`) before its steps run, gets the render-and-look loop and visual verification
# For type: bug (first-class stories, F025). Required at refinement:
# repro_steps: |          # numbered steps that reproduce it
# expected: ""            # what the spec says should happen
# actual: ""              # what happens
# environment: ""         # version / device / branch
# severity: medium        # low | medium | high | critical
# lane: ""                # hotfix when filed through the hotfix lane (ship-execute --hotfix)
# debug_task: ""          # T### debug-spike task when the root cause is unknown (blocks via dependencies)
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
#   shipyard-data story record-proof SNNN verdict=pass confirmed-by=<who> commit=<sha>
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

## Paths

Every way the trigger can end, written before the scenarios. Each ending has a scenario or the reason it cannot happen.

| Ending | Covered by |
|---|---|
| [success] | @AC-1 |
| [a refusal, failure or timeout] | @AC-2 |
| [an ending that cannot happen] | cannot happen: [reason] |

## Acceptance Criteria

### Core AC

```gherkin
Feature: {{title}}

  Scenario: Happy path
    Given [context]
    When [action]
    Then [what someone outside the system can observe]

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
<!-- If this section exceeds ~50 lines, extract to $(shipyard-data)/spec/references/SNNN-api.md -->

## Data Model

<!-- Schema definitions, field types, constraints, relationships. Remove this section if not applicable. -->
<!-- Use Mermaid ER diagrams for complex schemas -->
<!-- If this section exceeds ~50 lines, extract to $(shipyard-data)/spec/references/SNNN-schema.md -->

## Configuration

<!-- Settings, environment variables, feature flags with types and defaults. Remove this section if not applicable. -->
<!-- If this section exceeds ~30 lines, extract to $(shipyard-data)/spec/references/SNNN-config.md -->

## Flows

<!-- C4, sequence, state machine, ER, deployment, data-flow, user journey — use Mermaid. Remove this section if not applicable. -->
<!-- If this section exceeds ~50 lines, extract to $(shipyard-data)/spec/references/SNNN-flows.md -->

## Error Handling

<!-- Failure modes, error codes/messages, recovery strategies. Remove this section if not applicable. -->

## Technical Notes

## Decision Log

| Date | Decision | Options | Chosen | Reasoning |
|------|----------|---------|--------|-----------|
