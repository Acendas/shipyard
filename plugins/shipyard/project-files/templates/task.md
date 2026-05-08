---
id: ""
title: ""
type: task
kind: feature          # feature | operational | research — see ship-sprint/references/task-kinds.md
feature: ""
status: approved       # pending|in-progress|done|blocked|needs-attention — see ship-status/SKILL.md
effort: ""
dependencies: []
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

See parent feature acceptance scenarios: [FEATURE_ID]

## Technical Notes
