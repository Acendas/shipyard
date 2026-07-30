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

Integration tests (wave boundary) and full regression tests (sprint completion) are delegated to the `dispatching-operational-task` capability skill, which dispatches the `shipyard-operational-task` registered agent. That agent captures output through `shipyard-logcap`, records the absolute capture path in `verify_output`, parses failures, and returns a structured verdict. This keeps raw test output — which can be hundreds of lines — out of the orchestrator's context. See `skills/dispatching-operational-task/SKILL.md` for the full contract.

## Subagent Context Loading

Each subagent gets a fresh 200k context window. Front-load the important files:

1. Task spec (small, critical)
2. Parent feature spec with acceptance criteria (small, critical)
3. Codebase context (first 50 lines for patterns)
4. Existing source files to modify (as needed during work)

Don't pre-load files the subagent might not need. Let it read on demand.

## Auto-Compaction Awareness

Claude's auto-compaction clears old tool outputs first, then summarizes if needed. To work well with this:

- **State lives in files, not conversation.** The pipeline cursor (EXECUTE-CURSOR.md), the event log, PROGRESS.md, debug files — these survive compaction. (A pause is a cursor state now — `shipyard-data cursor pause execute --note …`; HANDOFF.md is retired.)
- **Don't rely on early conversation for late decisions.** If something matters, it should be in a file.
- **Large outputs get cleared first.** If you ran a big test suite, the output will be compacted before your recent messages.
- **Recovery is file-based.** If you lose track of execution state after compaction, follow the Compaction Recovery protocol in SKILL.md — read EXECUTE-CURSOR.md first (authoritative `stage:`), then PROGRESS.md (`current_wave`), SPRINT.md (wave structure), and task files (status). Full state reconstructs in ~5 tool calls.
- **Checkpoint pattern.** All long-running skills write a transient checkpoint file at their critical boundary — the point where the most autonomous work has accumulated. Each skill's Compaction Recovery section documents how to reconstruct state from these files. This pattern applies to: ship-execute (EXECUTE-CURSOR.md `stage:` + PROGRESS.md `current_wave`), ship-sprint (`<SHIPYARD_DATA>/sprints/current/SPRINT-DRAFT.md`), ship-review (`<SHIPYARD_DATA>/verify/*-verdict.md` + `RETRO-DATA.md` + `<SHIPYARD_DATA>/releases/*-draft.md`), ship-discuss (`<SHIPYARD_DATA>/releases/*-draft.md`), and ship-discuss (`<SHIPYARD_DATA>/spec/.research-draft.md`).

## Solo Mode Context

Solo mode still uses subagents — tasks run sequentially (one at a time) instead of in parallel, but each task gets a fresh context window. This keeps the orchestrator lean regardless of sprint size.

The orchestrator in solo mode: reads SPRINT.md, spawns one subagent, waits for it, spot-checks the result, spawns the next. No TDD cycle output accumulates in the orchestrator's window.

## Track Mode Context

Track mode has no shared task list or mailbox to coordinate through — isolated agents (both the track coordinator and its nested builders) have no `Task*` access at all (constraint C1: isolation and the shared checklist are mutually exclusive on this platform). Coordination flows entirely through `SendMessage` (advisory: blockers, interface changes) and the shared event log / `.subagent-returns/` directory (authoritative: what actually landed). See `references/track-mode.md` for the full protocol.

### Main Session (~10-15% context)
Main holds only coordination state:
- SPRINT.md wave structure and feature track mapping
- The per-track handle/timeout list and the per-task `pending_subagents` list (`references/track-mode.md` § "Main's Monitoring Loop") — reconciled from the event log, never from polling a coordinator
- Integration test results at wave boundaries
- `Task*` — main is the SOLE owner and writer; it is a progress mirror main maintains from evidence (task-return records + the event log), never a coordination channel and never authority (v2.11.0 `task_list_never_authority`, unaffected by this design)

Main does NOT hold: task spec contents, implementation details, full codebase context, or a coordinator's own reasoning. There is no shared task list or mailbox for main to read state from — everything above is either main's own bookkeeping or derived from the event log.

### Track Coordinator Sessions (fresh 200k, persistent for one wave)
A track coordinator's context persists across its track's tasks **for one wave only** — not across the whole feature, and not across a wave boundary (`references/track-mode.md` § "Wave-scoped, not sprint-persistent"). It holds no code:
- **No feature spec, no codebase context, no diffs.** The coordinator's `tools:` allowlist is `Read, ToolSearch, Agent, SendMessage` — deliberately no `Bash`/`Write`/`Edit` (this is what makes it structurally unable to self-certify a task). It dispatches; it does not read source or write code.
- **What actually persists is TRACK NOTES** — a short running block of interfaces introduced or renamed, decisions taken, gotchas hit, and files touched, built from each nested builder's return text and prepended to the next builder's brief. This is a curated few-hundred-token artifact, not accumulated raw context.

### Nested Builder Sessions (fresh 200k per task — unchanged from task mode)
Each nested builder is `shipyard-disciplined-builder`, dispatched exactly as it would be under task mode: a fresh context window per task, reading its own feature spec and codebase context from scratch every time. Track mode does **not** give a builder a persistent, accumulating context across its track's tasks — that would require the coordinator to hold and forward full context, which its allowlist structurally prevents. The one thing a track-mode builder gets that a task-mode builder doesn't is the coordinator's TRACK NOTES prepended to its brief — informed sequencing, not context reuse.

### When Track Mode > Task Mode
- Features with **3+ tasks each** in the same wave — a coordinator's TRACK NOTES let each subsequent task's builder start from the naming/interface decisions its siblings actually made, instead of guessing independently and colliding at the wave-boundary merge (`references/track-mode.md` § "The Track Coordinator Contract"). This is the same "3+" threshold as before, but the mechanism it justifies has changed: it buys better-informed briefs and centralized per-track triage, not context-window amortization — nested builders still each pay the full feature-spec-read cost every task, same as task mode. Track mode does not buy additional build throughput over task mode (concurrency is capped the same way at either granularity); the extra coordinator agent per track is a real cost paid only for the briefing benefit.
- If most features have **1-2 tasks**, task mode is more efficient (no coordinator overhead, no extra agent per track, simpler monitoring).
