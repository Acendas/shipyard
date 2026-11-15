# Sprint start: Step 0 worktree salvage, Step 1 load sprint plan

Stages `salvage` and `load`.

## Step 0: Worktree Salvage (stage_id: salvage) (always runs first)

**First:** `shipyard-data clean-worktrees` — removes worktrees whose branches are already merged or whose remote tracking is `[gone]`, plus orphaned `shipyard/wt-*` branches with no worktree directory.

**Also:** `shipyard-data ensure-worktree-baseref` — sets `worktree.baseRef: "head"` in the project's `.claude/settings.json` (idempotent atomic JSON read-merge-write that preserves every other key — never a model hand-edit). Verifying it every sprint is self-healing and independent of one-time setup. It is the backstop for when the `WorktreeCreate` hook does not fire (native creation would otherwise fork from `origin/<default>` and drop earlier waves' local commits).

**Also:** `shipyard-data ensure-shared-caches` — materializes the `shared_caches:` config map (package-manager download-cache env vars) into `.claude/settings.json` `env` via the same atomic read-merge-write, so every builder (parent or worktree subagent) inherits a warm download cache. No-op when `shared_caches` is empty (the default), so this is safe to run unconditionally every sprint.

**Then:** `git worktree list`. If no `shipyard/wt-*` paths remain, skip to Step 1. Otherwise, for each leftover `shipyard/wt-*` worktree (unmerged — the merged ones were cleaned above):

1. **Salvage uncommitted work** if present: `git -C <worktree> add -A` then `git -C <worktree> commit -m "wip(TASK_ID): salvage from interrupted session"`. Task ID is the branch suffix.
2. **Rebase + ff-merge** the branch onto the working branch. Conflicts → keep the branch and skip the merge; the task-status update in step 4 (`blocked`) is what emits `task_blocked` — do not also emit it here.
3. **Remove the worktree** (`git worktree remove`) and delete merged branches.
4. **Update task status** via `shipyard-data step set-status <id> <status>`: `done` if a real commit landed, `in-progress` for WIP-only salvages, `approved` (re-execute) if nothing to salvage, `blocked --reason "shipyard/wt-X has conflicts — manual merge needed"` for conflicts (this auto-emits `task_blocked`, satisfying the terminal gate's parking evidence — no separate emit needed).

The working branch now contains all recoverable work; new worktrees branch from this consolidated state.

**→ `load`** (`stuck_counter=0`).

## Step 1: Load Sprint Plan (stage_id: load)

Read SPRINT.md (wave structure — task IDs grouped by wave, critical path, execution mode) and PROGRESS.md (current wave, blockers, session log). For each task ID in the current wave, read its step file (title, effort, status, dependencies, parent feature).

**Detect session type:**

1. **`status: paused` cursor** → graceful resume (see "Recovery & resume"). Worktrees already salvaged in Step 0.
2. **No paused cursor, but PROGRESS.md shows tasks done OR Step 0 salvaged work** → crash recovery. Resume from the current wave.
3. **No paused cursor, no tasks done, Step 0 found no worktrees** → fresh start. Record the working branch: `git branch --show-current`, then `shipyard-data sprint set branch <current branch>` if not set.

**Record sprint start time (idempotent):** if SPRINT.md `started_at` is null/absent, `shipyard-data sprint set started_at <ISO 8601>`. If already set, leave it — resuming a pause must never reset the clock.

**Session budget (`execution.max_session_minutes`):** a separate clock from `started_at` (it uses CLI-owned `session_started_at`). It gates wave starts only. If `cursor advance` emits `session_budget_reached`, the run is paused, not failed: tell the user the budget stopped it before the next wave and that `shipyard-data cursor resume execute` starts a fresh clock. The clock keys on `CLAUDE_CODE_SESSION_ID`; a time gap never resets it, and any reset outside preflight is logged as `session_clock_reset`.

**Create the wave task checklist (fresh start; rebuilt on resume — mirror only).** Once the wave structure is known (parsed above from SPRINT.md `### Wave N` bodies), `TaskCreate` one task per wave plus two bookends — preflight/load and sprint-complete — in one batch, subject-prefixed `[sprint-<id>] ` to keep this checklist distinguishable from `/ship-sprint`'s `[sprint-plan] Step N:` planning checklist. Main is the sole owner of `Task*` in every dispatch shape (isolated track coordinators and nested builders have no `Task*` access at all — C1 in `references/track-mode.md`):

| Subject |
|---|
| `[sprint-<id>] Preflight & Load` |
| `[sprint-<id>] Wave 1: <n> tasks` |
| `[sprint-<id>] Wave 2: <n> tasks` |
| … one per wave … |
| `[sprint-<id>] Sprint Complete & Demo Probes` |

Mark the Preflight & Load task `completed` immediately (this step just ran it).

**Rebuild-on-resume: TaskList is session-scoped, so a fresh session sees nothing — that emptiness is not "no checklist was ever made."** `TaskList()` reflects only tasks created in THIS session, so almost every resume sees none. Branch on what `TaskList()` actually shows, not on an assumption:

- **`TaskList()` already shows `[sprint-<id>] ` tasks for this sprint** (same session as creation, or a session that already rebuilt once) → leave them as-is; a wave already `in_progress`/`completed` reflects prior progress. Do not recreate.
- **`TaskList()` shows none for this sprint, but the cursor names this sprint at a stage past `load`** (i.e. a live sprint is genuinely in flight — this is the resume case) → **rebuild**, from the record, never from guesswork: `TaskCreate` the same table above (same subjects, same `[sprint-<id>] ` prefix, from the wave structure just parsed from SPRINT.md), then set each wave's initial state by reading, not assuming:
  - A wave with a `wave_check_passed` event (or `pipeline_tick_completed stage=wave_<N>_gate`) already in the event log → `completed`.
  - The wave named by the cursor's current stage (its `wave_number`) → `in_progress`.
  - Every later wave → left at the `TaskCreate` default (pending); no update call needed.
  - Mark Preflight & Load `completed` (this step already ran, by construction). Leave Sprint Complete & Demo Probes pending — it only completes per the rule below, never inferred from the rest of the list looking done.

The rebuild never writes back to the cursor or event log; the reconstructed list is not itself evidence of anything (see the guardrail below).

**Update on wave transitions, gated.** `TaskUpdate` a wave task → `in_progress` when that wave's `wave_<N>_dispatch` stage fires; → `completed` **only after** `shipyard-data verify-wave-integrated` passes AND the cursor advances past that wave's `wave_<N>_gate` (Step 4 item 9's `→ wave_<N+1>_dispatch` advance). Never mark a wave task `completed` on a builder's return claim alone. A wave that parks a task (`needs-attention`) or escalates: leave its task `in_progress` (visible, not silently dropped) — do not mark it completed. Mark `[sprint-<id>] Sprint Complete & Demo Probes` `completed` only after `sprint_complete_gate` (Step 5.4) passes.

**Guardrail (load-bearing): the wave task list is a progress surface and a recovery anchor, NEVER authority.** Do not gate any behavior on TaskList state, do not cite task status as evidence a wave ran, and never mark a wave task completed before `verify-wave-integrated` passes. The cursor, PROGRESS.md, and the event log remain the record; the tasks are the user-visible mirror.

**→ `readiness`** (fresh) or **`wave_<current_wave>_dispatch`** (resume / crash recovery).
