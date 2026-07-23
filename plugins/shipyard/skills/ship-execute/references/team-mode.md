# Team Mode Protocol

Team Mode uses Claude Code Agent Teams (shared task list + mailbox) for coordination-heavy, file-partitioned work — it is opt-in and experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), NOT the default build shape (see `ship-execute` Step 2: Subagent mode is the build default; Team is for partitioned coordination). Teammates **persist across multiple tasks** in their feature track — a teammate reads the feature spec once and works through all its tasks.

**Teams do not get worktree isolation — this is a Claude Code design decision (#37549), not a bug to work around.** Agent Teams isolate teammates by *file-ownership partition*, not by directory: each teammate shares the ONE main working tree and is scoped to a disjoint set of files (its feature track), and there are NO per-task `shipyard/wt-*` branches in team mode. This has a direct consequence for the verification spine: `verify-wave-integrated`'s branch-merge check (Check A) has nothing to check in team mode — there are no worktree branches to merge — so it is a structural no-op here. Only Check B (every verified return commit reachable from the working branch) still applies, and it holds trivially once teammates commit directly to the working branch. Integration safety in team mode rests entirely on file-partition discipline (teammates never touching another track's files), not on branch isolation.

## Concurrency Cap

**Maximum `execution.max_parallel_agents` concurrent teammates** (read from config, default 3, hard ceiling 4). If a sprint has more feature tracks than the cap, spawn the first N and queue the rest. When a teammate finishes all tasks in its feature track and shuts down, spawn the next queued feature track's teammate in its place. This prevents resource exhaustion and quality degradation from too many parallel agents (Sprint 001/002 showed 6-7 agents degrading — agents return early or hit context limits).

The lead maintains a simple queue:
1. Sort feature tracks by wave priority (features with earlier wave tasks first)
2. Spawn the first `max_parallel_agents` as the initial batch
3. As each teammate completes (shutdown_response received + all its commits verified via the integration gate), spawn the next queued track
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

**No worktrees are created for teammates.** `isolation: worktree` is not passed on team-mode `Agent(...)` calls at all — teams don't get directory isolation by platform design (#37549), so there's nothing to request. Every teammate operates directly in the main repo working tree, on the working branch, scoped to its own feature track's files. Concurrent-write safety comes entirely from file-partition discipline (below, "Within-Track Autonomy": never cross tracks) — there is no branch or directory boundary backing it up.

1. `TaskCreate` per task — subject: `"TASK_ID: title"`, description: task file path + feature file path + dependencies. (No `TeamCreate` call — that tool doesn't exist; the team is created implicitly by the first `Agent(...)` spawn below that carries `team_name`.)
2. Spawn teammates up to the concurrency cap (max 4), queue the rest. Dispatch via `general-purpose` with `team_name` set; the `shipyard:dispatching-task-loop` capability skill is NOT used directly because team-mode teammates persist across multiple tasks (a teammate works through ALL tasks in its assigned feature track, not one-task-one-dispatch). The teammate spawn prompt is inlined below. **Model tier (build)** — teammates do implementation labor: read `models.build` from `<SHIPYARD_DATA>/config.md`; if non-empty pass `model: <value>` on the `Agent(...)` call below, if empty or absent OMIT the `model:` field so the teammate inherits the session model. Never hardcode a literal.

   ```
   Agent(name: "teammate-FEATURE_ID",
         subagent_type: "general-purpose",
         team_name: "sprint-NNN",
         model: <models.build — omit this line entirely if the config value is empty/absent>,
         prompt: [teammate spawn prompt — see below])
   ```

## Teammate Spawn Prompt

```
You are a Shipyard builder working on feature [FEATURE_ID] as part of team "sprint-NNN".

Working branch: [branch from SPRINT.md] (you commit directly to this branch — there is no per-feature worktree or branch)

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
Between waves, the lead runs the integration gate (no rebase/merge needed — you already commit directly to the working branch).
When you receive a message containing "WAVE SYNC":
1. `git pull`/`git status` to confirm you're current with the working branch (other teammates may have committed since your last check)
2. Continue your task loop from step 1

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

Before shutdown or reporting completion, ensure no uncommitted work in the shared working tree:
```bash
git status --porcelain
```
If changes exist: `git add -A && git commit -m "wip([TASK_ID]): partial progress"`
If commit fails: `git stash`
Since there is no dedicated worktree per teammate, uncommitted work sits in the one shared checkout — commit or stash before exiting rather than relying on any directory surviving teardown.

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

Recovery steps (all against the shared working tree — there is no per-teammate worktree to isolate the crash's blast radius; file-partition discipline is what limits it instead):
1. **Salvage uncommitted work first** — `git status --porcelain` to check for changes
2. If uncommitted changes exist: `git add -A && git commit -m "wip(TASK_ID): salvage from crashed teammate"` (already on the working branch — no rebase/merge needed, since the crashed teammate never had its own branch)
3. `TaskUpdate` the task back to `pending`
4. Spawn a replacement teammate with the recovery prompt below

**CRITICAL: Never discard uncommitted changes without first checking for and salvaging them. A system crash kills agents mid-work; because all teammates share one working tree, unsaved progress from a crashed teammate is sitting in the same checkout the lead and every other teammate are using.**

## Session Resume Prompt

When re-spawning teammates after a session break (resuming from a paused cursor — its body note carries the `team_name` / teammate list) or after a crash, use the standard teammate prompt with this addition appended:

```
RECOVERY NOTE: You are resuming after a session break or teammate crash.
- Read task files to determine true status (task file `status: done` = completed,
  regardless of what TaskList shows)
- Check the shared working tree for any WIP commits — continue from where the previous
  session left off
- If resuming a specific task [TASK_ID]: check for partial work before starting fresh
```

## Wave Boundary Protocol

When all wave tasks complete and spot-checks pass. There is no feature-branch rebase/merge step here — teammates commit directly to the working branch as they go (no per-feature worktree or branch exists to integrate), so by wave-boundary time every verified commit is already on the working branch.

1. **Integration gate — `shipyard-data verify-wave-integrated` — BEFORE any teardown.** Run it before shutting down any teammate. In team mode, Check A (worktree branches merged) is a structural no-op — there are no `shipyard/wt-*` branches to check — so only Check B (every verified return commit reachable from the working branch) is meaningful, and it holds trivially given direct-to-branch commits. Still run the gate rather than skip it: a Check B failure would mean a teammate's claimed commit isn't actually reachable, which is real signal (a lost/rewritten commit) even without Check A's involvement. Exit 3 is a HARD STOP: do not shut down any teammate. Re-run the gate once after investigating; if it still fails, this is an `integration_gate` escalation trigger — invoke `shipyard:escalating-to-thinker`, do not tear down unverified state on your own judgment.
2. **Create next wave tasks** — `TaskCreate` for each task in the new wave
3. **Message continuing teammates** — tell them the next wave's tasks are ready (no rebase needed — they're already working off the current tip of the shared branch):
   ```
   SendMessage(type: "message", recipient: "teammate-FEATURE_ID",
     content: "WAVE SYNC: wave N+1 tasks available.",
     summary: "Wave N+1 ready")
   ```
4. **Shutdown finished teammates** — `SendMessage(type: "shutdown_request", recipient: "teammate-FEATURE_ID", content: "No remaining tasks for your feature track")` to any teammate whose feature track has no remaining tasks
5. **Spawn queued teammates** — after each shutdown_response, if queued feature tracks remain, spawn the next one (maintains max 4 concurrent)
6. **Delegate integration tests** to a test subagent on the working branch (same as subagent mode wave boundary)

## Sprint End Teardown

After the final wave completes:

1. `SendMessage(type: "shutdown_request", ...)` to all remaining teammates
2. Wait for `shutdown_response` (approve: true) from each teammate before proceeding
3. Run `shipyard-data verify-wave-integrated` one final time (same Check-B-only meaning as above) before continuing
4. Continue to Step 5 in SKILL.md (full test suite, PR, sprint report). No `TeamDelete` call — that tool doesn't exist; the team's lifecycle ends when its teammates shut down.
