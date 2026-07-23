# Team Mode Protocol

Team Mode uses Claude Code Agent Teams (shared task list + mailbox) for sprints with 10+ tasks. Teammates **persist across multiple tasks** in their feature track — a teammate reads the feature spec once and works through all its tasks.

## Concurrency Cap

**Maximum `execution.max_parallel_agents` concurrent teammates** (read from config, default 3, hard ceiling 4). If a sprint has more feature tracks than the cap, spawn the first N and queue the rest. When a teammate finishes all tasks in its feature track and shuts down, spawn the next queued feature track's teammate in its place. This prevents resource exhaustion and quality degradation from too many parallel agents (Sprint 001/002 showed 6-7 agents degrading — agents return early or hit context limits).

The lead maintains a simple queue:
1. Sort feature tracks by wave priority (features with earlier wave tasks first)
2. Spawn the first `max_parallel_agents` as the initial batch
3. As each teammate completes (shutdown_response received + worktree merged), spawn the next queued track
4. If fewer feature tracks than the cap exist, spawn them all — no queuing needed

## Feature Track Mapping

Before spawning teammates, group wave tasks by parent feature:

1. Read wave task IDs from SPRINT.md
2. For each task, read the task file's `feature:` field
3. Group into feature tracks: `{F001: [T001, T002, T003], F005: [T004, T005]}`
4. One teammate per feature track
5. Cross-feature dependencies are handled naturally by wave ordering — tasks with cross-feature deps land in later waves

If a feature has only 1 task, it still gets its own teammate (simpler than special-casing).

## Within-Track Autonomy

Teammates are not limited to a strict lead-assigns-one-task-at-a-time loop:

- A teammate MAY spawn its own subagents (e.g. via `dispatching-task-loop`, or an ad-hoc `Agent(...)` call) to parallelize sub-work within a task it owns, as long as it stays responsible for that task's commit and structured completion.
- A teammate MAY proactively pick up the next pending task IN ITS OWN TRACK without waiting for the lead to assign it — the whole point of a persistent per-track teammate is that it doesn't need lead intervention between tasks in the same feature.
- **Never cross tracks.** A teammate must not pick up, edit, or commit to another track's task or worktree, even when idle and another track is backlogged — track boundaries are the lead's concurrency control, not a suggestion.
- Dependency ordering and the Wave Sync gate are always authoritative over this autonomy: a teammate does not skip a same-track dependency it hasn't seen complete, and does not proceed past a wave boundary until it receives the `WAVE SYNC` message, no matter how idle it is.

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
4. Spawn teammates up to the concurrency cap (max 4), queue the rest. Dispatch via `general-purpose` with `team_name` set; the `shipyard:dispatching-task-loop` capability skill is NOT used directly because team-mode teammates persist across multiple tasks (a teammate works through ALL tasks in its assigned feature track, not one-task-one-dispatch). The teammate spawn prompt is inlined below. **Model tier (build)** — teammates do implementation labor: read `models.build` from `<SHIPYARD_DATA>/config.md`; if non-empty pass `model: <value>` on the `Agent(...)` call below, if empty or absent OMIT the `model:` field so the teammate inherits the session model. Never hardcode a literal.

   ```
   Agent(name: "teammate-FEATURE_ID",
         subagent_type: "general-purpose",
         team_name: "sprint-NNN",
         model: <models.build — omit this line entirely if the config value is empty/absent>,
         prompt: [teammate spawn prompt with WORKTREE_PATH filled in — see below])
   ```

**Why no `isolation: worktree`?** When `team_name` is set, Claude Code skips worktree creation entirely. The agent runs in the main repo. Multiple teammates editing the same directory causes race conditions and corrupted files. Manual worktree creation + prompt-based `cd` is the workaround until Claude Code supports team-mode worktree isolation natively. See the "Using Worktrees" reference for current status.

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
7. **MANDATORY — persist the structured return FIRST:** `shipyard-data task-return [TASK_ID] status=COMPLETE commit=<sha-of-your-commit> probe-exit=<n> output-tail-file=<path-to-captured-output>`. The CLI refuses to record COMPLETE with a nonzero probe-exit — if it refuses, the task is NOT done; fix the failure and retry this step before proceeding.
8. `shipyard-data task set-status [TASK_ID] done` (canonical status record — only after step 7 succeeds)
9. TaskUpdate(taskId: "N", status: "completed") — coordination signal for the lead
10. **You are NOT done until step 7 has written `.subagent-returns/[TASK_ID].json`.** Done-without-task-return is a contract violation — the lead treats a task reported complete with no matching `.json` as BLOCKED and re-dispatches it.
11. Go to step 1

NOTE: The task file's `status: done` is the single source of truth (Shipyard data model).
The TaskUpdate status is a coordination signal for the lead's monitoring loop only.
If they ever diverge, the task file wins. On recovery, read task file status.

NOTE: PROGRESS.md is a derived artifact — the render-progress hook regenerates it from the event log. Neither teammates nor the lead write it directly.

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

**The verification spine is delegation-shape-independent: every task — solo, subagent, or teammate, however many layers of sub-delegation produced it — exits through task-return → this gate → `task_dispatch_returned`. A teammate cannot self-certify.**

```
while tasks remain incomplete:
  1. TaskList() — get current status of all wave tasks
  2. For each task a teammate reports "completed" (via TaskUpdate):
     - Read `<SHIPYARD_DATA>/sprints/current/.subagent-returns/[TASK_ID].json`.
       Missing or unparseable → TaskUpdate the task back to "in_progress",
       SendMessage(type: "message", recipient: "teammate-FEATURE_ID",
         content: "RECHECK: [TASK_ID] — no valid task-return found; you are not done until `shipyard-data task-return` succeeds",
         summary: "Missing task-return for [TASK_ID]") and treat the task as BLOCKED
       (do not emit `task_dispatch_returned` for it).
     - If the `.json` exists, run the SAME orchestrator-side gate `wave_N_recovery`
       runs, per `dispatching-task-loop`'s "Orchestrator-Side Parsing and Gating":
       the commit sha exists (`git cat-file -e <sha>`), `probe_exit_code === 0`,
       a non-empty output tail, and an anti-stub-scan pass on the diff.
     - Gate fails → SendMessage(type: "message", recipient: "teammate-FEATURE_ID",
         content: "RECHECK: [TASK_ID] — [which check failed]",
         summary: "Verification gate failed for [TASK_ID]") — single re-dispatch;
       if the retry also fails, park the task `needs-attention` via
       `shipyard-data task set-status [TASK_ID] needs-attention --reason "..."`
       rather than looping indefinitely.
     - Gate passes → `shipyard-data anchor-commit [TASK_ID] <sha>`, then emit
       `shipyard-data events emit task_dispatch_returned pipeline=ship-execute sprint=<id> wave=<N> task=[TASK_ID] status=complete commit_sha=<sha>`.
  3. For each blocked task (in_progress + lead received BLOCKED message):
     - Apply standard blocker handling from SKILL.md (reassign → swap-in → escalate → park)
  4. Check teammate heartbeats for liveness:
     For each active teammate with tasks in_progress:
       Read <SHIPYARD_DATA>/agents/<FEATURE_ID>.heartbeat
       Age = now - heartbeat.ts

       if age > 5 minutes (heartbeat_stale_threshold):
         SendMessage(type: "message", recipient: "teammate-FEATURE_ID",
           content: "HEALTH CHECK: No activity for [N] minutes (last: [tool] on [target]). If stuck, report blocker. If working on a long operation, acknowledge.",
           summary: "Health check for teammate-FEATURE_ID")

       if age > 15 minutes (heartbeat_dead_threshold):
         Log "Teammate FEATURE_ID appears dead — no tool call in [N] min"
         Initiate crash recovery (see below)

       if no heartbeat file exists:
         Teammate may have failed before any tool call — initiate crash recovery
  5. Brief pause, then repeat
```

Exit the loop when all tasks show completed and spot-checks pass.

## Teammate Failure / Crash Recovery

Detect: a teammate's heartbeat file at `<SHIPYARD_DATA>/agents/<FEATURE_ID>.heartbeat` is stale (>15 min since last tool call), absent, or the teammate has a task `in_progress` with no BLOCKED message and no new commits. The heartbeat is the primary signal — it fires on every tool call, so staleness means the agent is truly idle or dead, not just between commits.

Recovery steps:
1. **Salvage uncommitted work first** — `git -C <worktree-path> status --porcelain` to check for changes
2. If uncommitted changes exist: `git -C <worktree-path> add -A && git -C <worktree-path> commit -m "wip(TASK_ID): salvage from crashed teammate"`
3. If committed work exists (ahead of working branch): rebase + ff-only merge onto working branch
4. `TaskUpdate` the task back to `pending`
5. Spawn a replacement teammate with the recovery prompt below

**CRITICAL: Never remove a worktree or create a fresh one without first checking for and salvaging uncommitted changes. A system crash kills agents mid-work — their worktrees contain unsaved progress.**

## Session Resume Prompt

When re-spawning teammates after a session break (resuming from a paused cursor — its body note carries the `team_name` / teammate list) or after a crash, use the standard teammate prompt with this addition appended:

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

1. **Feature-level rebase and merge** — for each completed feature branch, rebase onto the working branch, then fast-forward merge. If ff fails, render the conflict details as chat text first (feature branch, conflicting files, relevant `git status` lines — teammate messages and git output do not count as shown until printed), then AskUserQuestion (never fall back to regular merge — it creates fork lines).
1a. **Integration gate — `shipyard-data verify-wave-integrated` — BEFORE any teardown.** Run it immediately after the rebase+ff-merge above and before worktree cleanup (step 2). Exit 3 is a HARD STOP: do not remove any worktree, do not shut down any teammate. Integrate the branches it names, re-run the gate once; if it still fails, this is an `integration_gate` escalation trigger — invoke `shipyard:escalating-to-thinker`, do not tear down unverified state on your own judgment.
2. **Clean up finished worktrees** — `git worktree remove` for completed feature tracks only, and only after step 1a has passed
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
