# Review auto-fix doctrine and stuck warning

Moved verbatim from references/review-stages-fix.md; stage order, cursor and gates stay in SKILL.md.

## Auto-fix before asking

**Auto-fix before asking.** `/ship-review` is expected to repair review findings, not ask the user whether routine findings should be fixed. For must-fix code-review findings, spec gaps, quality-gate probe failures, user-flow FAILs, simple in-scope gaps, and critic-confirmed blind spots: dispatch the appropriate fixer (`dispatching-task-loop` or `dispatching-operational-task`) and re-check. AskUserQuestion only for load-bearing approval gates or genuinely severe/risky cases: destructive migration, irreversible data change, credential/security-policy choice, large dependency/platform change, ambiguous product/spec decision, accepting a known defect, BLOCKED tool/agent state, or hard-ceiling escalation. If the fix is merely tedious, expensive, or spans multiple files, create/dispatch patch work; do not ask for permission just because findings exist.

## Stuck warning

- If `stuck_counter >= 5` (5 ticks without state change): for `code_review_iter_N` (the fixer has stalled with an unchanged must-fix set), FIRST follow the `escalating-to-thinker` playbook (trigger: `repeated_fix_failure`, subject: `code_review_iter`) — a think-tier consult may diagnose why the fixer isn't converging and recommend a normal-path unstick. Then, whether or not the consult ran (it may be capped), emit `shipyard-data events emit pipeline_stuck pipeline=ship-review sprint=<id> stage=<id> iterations=<N> reason=no-state-change` AND surface a non-blocking one-line warning in the user-facing text: `⚠ Stage [X] has run [N] times without state change. /ship-status to inspect; consider manual intervention.` The loop keeps running — the warning is informational.
