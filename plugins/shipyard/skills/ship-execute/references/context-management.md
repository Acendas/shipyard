# Context Window Management

Claude Code handles most context management automatically (auto-compaction at ~95% capacity, fresh 200k per subagent). These guidelines ensure Shipyard works well with those built-in features rather than fighting them.

## Orchestrator vs Subagent Split

The orchestrator (the session running `/ship-execute`) should stay lean:

| Role | Context Budget | What It Does |
|------|---------------|--------------|
| **Orchestrator** | ~10-15% of window | Reads SPRINT.md, PROGRESS.md, spawns subagents, merges branches, receives test summaries from subagents |
| **Builder Subagent** | Fresh 200k each | Reads task spec, feature spec, codebase context, writes code, runs feature tests |
| **Test Subagent** | Fresh 200k (short-lived) | Runs test commands, captures output to file, returns structured summary |

### What the orchestrator should NOT do:
- Read full source files (that's the subagent's job)
- Read detailed codebase-context.md beyond the first 50 lines
- Hold implementation details in conversation — let subagents handle that

### What the orchestrator SHOULD do:
- Pass file PATHS to subagents, not file contents
- Track task status via PROGRESS.md (small file, always current)
- Spot-check subagent results: verify files exist, commits present
- Make wave-level decisions: merge, delegate tests to subagents, proceed to next wave

## Test Delegation

Integration tests (wave boundary) and full regression tests (sprint completion) are delegated to `shipyard:shipyard-test-runner` subagents (haiku model — cheap and fast for grunt work). This keeps raw test output — which can be hundreds of lines — out of the orchestrator's context. The subagent captures output to a temp file, reads it, and returns a 1-30 line structured summary. See `references/test-delegation.md` for the full pattern and prompt template.

## Subagent Context Loading

Each subagent gets a fresh 200k context window. Front-load the important files:

1. Task spec (small, critical)
2. Parent feature spec with acceptance criteria (small, critical)
3. Codebase context (first 50 lines for patterns)
4. Existing source files to modify (as needed during work)

Don't pre-load files the subagent might not need. Let it read on demand.

## Auto-Compaction Awareness

Claude's auto-compaction clears old tool outputs first, then summarizes if needed. To work well with this:

- **State lives in files, not conversation.** PROGRESS.md, HANDOFF.md, debug files — these survive compaction.
- **Don't rely on early conversation for late decisions.** If something matters, it should be in a file.
- **Large outputs get cleared first.** If you ran a big test suite, the output will be compacted before your recent messages.
- **Recovery is file-based.** If you lose track of execution state after compaction, follow the Compaction Recovery protocol in SKILL.md — re-read PROGRESS.md (`current_wave`), SPRINT.md (wave structure), and task files (status). Full state reconstructs in ~5 tool calls.
- **Checkpoint pattern.** All long-running skills write a transient checkpoint file at their critical boundary — the point where the most autonomous work has accumulated. Each skill's Compaction Recovery section documents how to reconstruct state from these files. This pattern applies to: ship-execute (PROGRESS.md `current_wave`), ship-sprint (`<SHIPYARD_DATA>/sprints/current/SPRINT-DRAFT.md`), ship-review (`<SHIPYARD_DATA>/verify/*-verdict.md` + `RETRO-DATA.md` + `<SHIPYARD_DATA>/releases/*-draft.md`), ship-discuss (`<SHIPYARD_DATA>/releases/*-draft.md`), and ship-discuss (`<SHIPYARD_DATA>/spec/.research-draft.md`).

## Solo Mode Context

Solo mode still uses subagents — tasks run sequentially (one at a time) instead of in parallel, but each task gets a fresh context window. This keeps the orchestrator lean regardless of sprint size.

The orchestrator in solo mode: reads SPRINT.md, spawns one subagent, waits for it, spot-checks the result, spawns the next. No TDD cycle output accumulates in the orchestrator's window.

## Team Mode Context

### Lead Session (~10-15% context)
The lead (orchestrator) holds only coordination state:
- SPRINT.md wave structure and feature track mapping
- Wave-level status from `TaskList()` — task IDs and statuses, not details
- Integration test results at wave boundaries
- Feature track assignments (which teammate owns which feature)

The lead does NOT hold: task spec contents, implementation details, full codebase context, or teammate conversation history. All coordination flows through the shared task list and mailbox.

### Teammate Sessions (fresh 200k, persistent across tasks)
Each teammate gets a fresh context window that persists across their feature track:
- **Read once, reuse across tasks:** Feature spec, codebase context, and shared patterns are loaded once at start. This context carries forward as the teammate works through multiple tasks.
- **Task spec replaced each task:** When picking up a new task, the teammate reads just that task's spec file. Old task output gets auto-compacted naturally.
- **Feature context retained:** Unlike subagent mode (which rebuilds context per task), teammates accumulate understanding of their feature's types, patterns, and interfaces.

### When Team Mode > Subagent Mode
- Features with **3+ tasks each** — teammate amortizes feature spec reading and pattern understanding across tasks
- If most features have **1-2 tasks**, subagent mode is more efficient (less coordination overhead, simpler monitoring)
