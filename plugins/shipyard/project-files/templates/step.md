---
id: ""
title: ""
type: step
kind: feature          # feature | operational | research — see ship-sprint/references/task-kinds.md
story: ""              # the S### story this step builds (legacy records use `feature:`)
status: approved       # pending|approved|in-progress|done|blocked|needs-attention — see ship-status/SKILL.md
effort: ""
dependencies: []       # only the steps this one truly waits for: each entry lengthens the sprint's chain
# needs_person: before    # only when a person must do this step. before = its result changes what is built (wave 1);
#                          # after = it only confirms what was built (collected at the sprint review). Never mid-sprint.
# person_task: ""          # one line: what the person does
# person_minutes: 10       # optional
# person_where: ""         # optional, e.g. the device: groups the end-of-sprint checks into one sitting
touches: []            # the files this step changes; "path#part" when another step of the same wave changes the same file
external_refs: []           # links to external systems: "JIRA-123", "GH-456", "https://..."
created: null
# For kind: feature — REQUIRED at Definition-of-Ready (Shipyard 2.0):
# acceptance_probe: |
#   <single shell command, exit 0 == pass, observable output, deterministic,
#    bounded ≤60s, fails today against the unimplemented state. Authored by
#    /ship-sprint per skills/authoring-acceptance-probe; consumed by
#    skills/dispatching-task-loop and skills/running-acceptance-probe.>
# Examples:
#   acceptance_probe: |
#     curl -fsS -X POST localhost:3000/api/users -d '{"name":"x"}' | jq -e .id
#   acceptance_probe: 'node -e ''require("./dist").newFn(42) === 84 || process.exit(1)'''
# The planner proves "fails today" with `shipyard-data sprint probes-at-base`; when a pass on
# today's code is right (a pure refactor guarded by an existing check), say why:
# probe_passes_at_base: "<reason>"
# Without one, dispatching-task-loop refuses to dispatch the task. Either
# author one (preferred) or change kind to research and produce a findings doc.
# For kind: operational only — required at Definition-of-Ready:
# verify_command: ""            # literal command or config key ref (e.g., "test_commands.e2e")
# verify_max_iterations: 3      # optional override of operational_tasks.max_iterations
# verify_output: ""             # populated by ship-execute on success — do NOT set by hand
# verify_history: []            # appended by ship-execute on each attempt
# For kind: research only — required at Definition-of-Ready:
# research_scope: ""            # problem statement or research question
# research_output: ""           # populated by ship-execute on success — do NOT set by hand
# research_history: []          # appended by ship-execute on each attempt
---

# [Title]

## What

## Acceptance Criteria

See parent story acceptance scenarios: [STORY_ID]

## Technical Notes
