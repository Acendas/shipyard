# Team Mode Protocol

Team Mode uses Claude Code Agent Teams (shared task list + mailbox) for sprints with 10+ tasks. Teammates **persist across multiple tasks** in their feature track — a teammate reads the feature spec once and works through all its tasks.

## Concurrency Cap

**Maximum 4 concurrent teammates.** If a sprint has more than 4 feature tracks, spawn the first 4 and queue the rest. When a teammate finishes all tasks in its feature track and shuts down, spawn the next queued feature track's teammate in its place. This prevents resource exhaustion from too many parallel agents.

The lead maintains a simple queue:
1. Sort feature tracks by wave priority (features with earlier wave tasks first)
2. Spawn the first 4 as the initial batch
3. As each teammate completes (shutdown_response received + worktree merged), spawn the next queued track
4. If fewer than 4 feature tracks exist, spawn them all — no queuing needed

## Feature Track Mapping

Before spawning teammates, group wave tasks by parent feature:

1. Read wave task IDs from SPRINT.md
2. For each task, read the task file's `feature:` field
3. Group into feature tracks: `{F001: [T001, T002, T003], F005: [T004, T005]}`
4. One teammate per feature track
5. Cross-feature dependencies are handled naturally by wave ordering — tasks with cross-feature deps land in later waves

If a feature has only 1 task, it still gets its own teammate (simpler than special-casing).

## Setup

**WORKAROUND: `isolation: worktree` is silently ignored when `team_name` is set (Claude Code bug #37549).** Teammates spawned with both parameters run in the main repo directory — no isolation. Shipyard works around this by manually creating worktrees before spawning teammates, then passing the worktree path in the prompt.

1. `TeamCreate(team_name: "sprint-NNN")`
2. `TaskCreate` per task — subject: `"TASK_ID: title"`, description: task file path + feature file path + dependencies
3. **Create worktrees manually** (serialized — one at a time to avoid git lock contention, bug #34645):
   ```bash
   # For each feature track, create a worktree from the working branch:
   CURRENT_SHA=$(git rev-parse HEAD)
   git worktree add -b shipyard/wt-FEATURE_ID-slug .claude/worktrees/FEATURE_ID "$CURRENT_SHA"
   ```
4. Spawn teammates up to the concurrency cap (max 4), queue the rest. **Do NOT pass `isolation: worktree`** — it will be ignored and may cause confusing behavior:
   ```
   Agent(name: "teammate-FEATURE_ID", subagent_type: shipyard:shipyard-builder,
         team_name: "sprint-NNN",
         prompt: [teammate spawn prompt with WORKTREE_PATH filled in])
   ```

**Why no `isolation: worktree`?** When `team_name` is set, Claude Code skips worktree creation entirely. The agent runs in the main repo. Multiple teammates editing the same directory causes race conditions and corrupted files. Manual worktree creation + prompt-based `cd` is the only reliable workaround until the bug is fixed.

## Teammate Spawn Prompt

```
You are a Shipyard builder working on feature [FEATURE_ID] as part of team "sprint-NNN".

Working branch: [branch from SPRINT.md]
Worktree path: [WORKTREE_PATH]

## Setup (do this once)
Read these files for full context:
- <SHIPYARD_DATA>/spec/features/[FEATURE_ID]-*.md (your feature spec — read fully, then check its `references:` frontmatter array and read each listed path in `<SHIPYARD_DATA>/spec/references/`; these hold full API contracts, schemas, and protocol specs you must implement against)
- <SHIPYARD_DATA>/codebase-context.md (codebase patterns, first 50 lines)

## Task Loop
Repeat until no pending tasks remain for your feature:
1. Call TaskList() (no parameters — returns all tasks). Filter the returned list
   in-memory: keep only tasks whose subject starts with a TASK_ID belonging to
   your feature [FEATURE_ID] and whose status is "pending".
2. Pick the first pending task (they're ordered by dependency)
3. TaskUpdate(taskId: "N", status: "in_progress")
4. Read the task spec: <SHIPYARD_DATA>/spec/tasks/[TASK_ID]-*.md
5. Read Technical Notes in task and feature files — follow research findings
6. Execute TDD cycle:
   - RED: Write failing tests matching acceptance scenarios. Run only those tests.
   - GREEN: Write minimum code to pass. Run only your tests.
   - REFACTOR: Clean up, your tests still pass.
   - MUTATE: Flip a key line, verify your test catches it.
   - COMMIT: feat([TASK_ID]): [description]
7. Update task file frontmatter status to `done` (this is the canonical status record)
8. TaskUpdate(taskId: "N", status: "completed") — coordination signal for the lead
9. Go to step 1

NOTE: The task file's `status: done` is the single source of truth (Shipyard data model).
The TaskUpdate status is a coordination signal for the lead's monitoring loop only.
If they ever diverge, the task file wins. On recovery, read task file status.

NOTE: PROGRESS.md is updated by the lead, not teammates. Don't write to it.

## Interface Change Protocol
When you modify a shared type, API endpoint, schema, or public interface:
- SendMessage(type: "broadcast", content: "INTERFACE CHANGE: [file]:[symbol] — [what changed]",
    summary: "Interface change in [file]")
- This lets other teammates adapt before they hit a merge conflict

## Blocker Protocol
If you cannot proceed on a task:
1. Update the task description with the reason:
   TaskUpdate(taskId: "N", description: "BLOCKED: [reason]")
   The task stays in_progress — the lead distinguishes blocked from crashed by
   checking for your SendMessage (crashed teammates go silent).
2. SendMessage(type: "message", recipient: "lead",
     content: "BLOCKED: [TASK_ID] — [reason]", summary: "Task [TASK_ID] blocked")
3. Move to next unblocked task in your feature track (don't wait)
4. If no unblocked tasks remain:
   SendMessage(type: "message", recipient: "lead",
     content: "IDLE: all remaining tasks blocked", summary: "Teammate idle")

## Wave Sync Protocol
Between waves, the lead rebases and merges completed features onto the working branch.
When you receive a message containing "WAVE SYNC":
1. Rebase your feature branch onto the updated working branch: `git rebase <working-branch>`
2. Resolve any conflicts (flag non-trivial ones to lead via SendMessage)
3. Continue your task loop from step 1

## Shutdown Protocol
When you receive a shutdown_request:
1. Finish current commit if mid-TDD (don't leave uncommitted work)
2. TaskUpdate any in_progress task back to "pending" if not yet committed
3. Respond: SendMessage(type: "shutdown_response", request_id: [request_id from
   the shutdown_request message], approve: true)

## Inline Rules (path-scoped rules don't load in teammates — Claude Code bug #32906)

**Execution rules:**
- Read task spec first, understand acceptance criteria before writing code
- Atomic commits per task — one commit, one task
- Update task file status to `done` after committing
- Never assume — if the spec is ambiguous, report to lead via SendMessage
- Scope discipline: no scope creep, no gold-plating, no bonus features

**TDD rules:**
- Write failing tests BEFORE implementation (Red phase)
- Never modify test assertions to make them pass — fix the implementation
- Mutation testing after GREEN: flip a key conditional, verify test catches it
- Only mock external dependencies — never mock internal modules
- Every acceptance scenario in the spec maps to at least one test

## Before Exiting (MANDATORY — prevents data loss)

Before shutdown or reporting completion, ensure no uncommitted work:
```bash
cd "[WORKTREE_PATH]" && git status --porcelain
```
If changes exist: `cd "[WORKTREE_PATH]" && git add -A && git commit -m "wip([TASK_ID]): partial progress"`
If commit fails: `cd "[WORKTREE_PATH]" && git stash`
Claude Code may delete worktree directories when agents exit — uncommitted work is permanently lost (bug #29110).

Rules: Never skip TDD. Never modify assertions to pass. Never build beyond acceptance criteria.
If blocked: describe the blocker and move on — do not guess.
```

## Lead Monitoring Loop

```
while tasks remain incomplete:
  1. TaskList() — get current status of all wave tasks
  2. For each newly completed task:
     - Spot-check: verify files exist + commits present in worktree
     - If spot-check fails → TaskUpdate back to "in_progress",
       SendMessage(type: "message", recipient: "teammate-FEATURE_ID",
         content: "RECHECK: [TASK_ID] — [issue found]",
         summary: "Spot-check failed for [TASK_ID]")
  3. For each blocked task (in_progress + lead received BLOCKED message):
     - Apply standard blocker handling from SKILL.md (reassign → swap-in → escalate → park)
  4. Check for stuck tasks (in_progress, no BLOCKED message, no new commits)
     — likely teammate crash (see recovery below)
  5. Brief pause, then repeat
```

Exit the loop when all tasks show completed and spot-checks pass.

## Teammate Failure / Crash Recovery

Detect: a task stays `in_progress` with no new commits in the worktree and no BLOCKED message received from the teammate.

Recovery steps:
1. **Salvage uncommitted work first** — `git -C <worktree-path> status --porcelain` to check for changes
2. If uncommitted changes exist: `git -C <worktree-path> add -A && git -C <worktree-path> commit -m "wip(TASK_ID): salvage from crashed teammate"`
3. If committed work exists (ahead of working branch): rebase + ff-only merge onto working branch
4. `TaskUpdate` the task back to `pending`
5. Spawn a replacement teammate with the recovery prompt below

**CRITICAL: Never remove a worktree or create a fresh one without first checking for and salvaging uncommitted changes. A system crash kills agents mid-work — their worktrees contain unsaved progress.**

## Session Resume Prompt

When re-spawning teammates after a session break (from HANDOFF.md resume) or after a crash, use the standard teammate prompt with this addition appended:

```
RECOVERY NOTE: You are resuming after a session break or teammate crash.
- Read task files to determine true status (task file `status: done` = completed,
  regardless of what TaskList shows)
- Check your worktree for any WIP commits — continue from where the previous
  session left off
- If resuming a specific task [TASK_ID]: check for partial work before starting fresh
```

## Wave Boundary Protocol

When all wave tasks complete and spot-checks pass:

1. **Feature-level rebase and merge** — for each completed feature branch, rebase onto the working branch, then fast-forward merge. If ff fails, AskUserQuestion with conflict details (never fall back to regular merge — it creates fork lines).
2. **Clean up finished worktrees** — `git worktree remove` for completed feature tracks only
3. **Create next wave tasks** — `TaskCreate` for each task in the new wave
4. **Message continuing teammates** — tell them to rebase onto updated working branch:
   ```
   SendMessage(type: "message", recipient: "teammate-FEATURE_ID",
     content: "WAVE SYNC: rebase onto <working-branch> to pick up cross-feature changes. Wave N+1 tasks available.",
     summary: "Wave N+1 ready")
   ```
5. **Shutdown finished teammates** — `SendMessage(type: "shutdown_request", recipient: "teammate-FEATURE_ID", content: "No remaining tasks for your feature track")` to any teammate whose feature track has no remaining tasks
6. **Spawn queued teammates** — after each shutdown_response, if queued feature tracks remain, spawn the next one (maintains max 4 concurrent)
7. **Delegate integration tests** to a test subagent on the working branch (same as subagent mode wave boundary)

## Sprint End Teardown

After the final wave completes:

1. `SendMessage(type: "shutdown_request", ...)` to all remaining teammates
2. Wait for `shutdown_response` (approve: true) from each teammate before proceeding
3. Rebase and merge any remaining feature branches onto the working branch
4. `TeamDelete(team_name: "sprint-NNN")`
5. Continue to Step 5 in SKILL.md (full test suite, PR, sprint report)
