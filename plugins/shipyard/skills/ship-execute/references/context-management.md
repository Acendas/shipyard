# Context Window Management

Claude Code handles most context management automatically (auto-compaction at ~95% capacity, fresh 200k per subagent). These guidelines ensure Shipyard works well with those built-in features rather than fighting them.

## Orchestrator vs Subagent Split

The orchestrator (the session running `/ship-execute`) should stay lean:

| Role | Context Budget | What It Does |
|------|---------------|--------------|
| **Orchestrator** | ~10-15% of window | Reads SPRINT.md, PROGRESS.md, spawns subagents, merges branches, receives test summaries from subagents |
| **Builder Subagent** | Fresh 200k each | Reads task spec, feature spec, codebase context, writes code, runs feature tests |
| **Test Subagent** | Fresh 200k (short-lived) | Runs test commands, captures output to file, returns structured summary |

Orchestrator rules: do NOT read full source files (the subagent's job) or codebase-context.md beyond its first 50 lines; pass file PATHS to subagents, never contents; spot-check each subagent result (files exist, commits present). Subagent load order: task spec, parent feature spec, codebase-context (first 50 lines), then source files on demand.

## Test Delegation

Integration tests (wave boundary) and full regression tests (sprint completion) are delegated to the `dispatching-operational-task` capability skill, which dispatches the `shipyard-operational-task` registered agent. That agent captures output through `shipyard-logcap`, records the absolute capture path in `verify_output`, parses failures, and returns a structured verdict. This keeps raw test output — which can be hundreds of lines — out of the orchestrator's context. See `skills/dispatching-operational-task/SKILL.md` for the full contract.

## Auto-Compaction Awareness

Claude's auto-compaction clears old tool outputs first, then summarizes if needed. To work well with this:

- **State lives in files, not conversation.** The pipeline cursor (EXECUTE-CURSOR.md), the event log, PROGRESS.md, debug files — these survive compaction. (A pause is a cursor state now — `shipyard-data cursor pause execute --note …`; HANDOFF.md is retired.)
- **Don't rely on early conversation for late decisions.** If something matters, it should be in a file.
- **Large outputs get cleared first.** If you ran a big test suite, the output will be compacted before your recent messages.
- **Recovery is file-based.** If you lose track of execution state after compaction, follow the Compaction recovery row in `references/pipeline-wave.md` § Recovery & resume — read EXECUTE-CURSOR.md first (authoritative `stage:`), then PROGRESS.md (`current_wave`), SPRINT.md (wave structure), and step files (status). Full state reconstructs in ~5 tool calls.
- **Checkpoint pattern.** All long-running skills write a transient checkpoint file at their critical boundary — the point where the most autonomous work has accumulated. Each skill's Compaction Recovery section documents how to reconstruct state from these files. This pattern applies to: ship-execute (EXECUTE-CURSOR.md `stage:` + PROGRESS.md `current_wave`), ship-sprint (`<SHIPYARD_DATA>/sprints/current/SPRINT-DRAFT.md`), ship-review (`<SHIPYARD_DATA>/verify/*-verdict.md` + `RETRO-DATA.md` + `<SHIPYARD_DATA>/releases/*-draft.md`), ship-discuss (`<SHIPYARD_DATA>/releases/*-draft.md`), and ship-discuss (`<SHIPYARD_DATA>/spec/.research-draft.md`).

## Track Mode Context

Track mode coordination (main, coordinator, nested builders, TaskList as a mirror never authority) is specified in `references/track-mode.md`; nested builders get fresh context per task, as in task mode.
