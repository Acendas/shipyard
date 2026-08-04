---
name: using-worktrees
description: Give a task its own filesystem checkout.
disable-model-invocation: true
---

# Using Worktrees

Shipyard isolates parallel task execution in git worktrees so concurrent subagents don't clobber each other's edits. **Trust the platform** — pass `isolation: worktree` on the Agent call and let Claude Code handle creation, cwd, and cleanup.

**Render before asking.** Before any AskUserQuestion, render the decision context as assistant chat text. Content that exists only in a Read result, a subagent/Agent return, or the question/option strings **does not count as rendered** (the UI shows a compact card) — restate it in chat first.

## When to Use Worktrees

| Mode | Use worktrees? |
|---|---|
| Solo (1–3 tasks per wave, sequential) | No — tasks run on the working branch, one after another |
| Task / parallel (4+ tasks per wave, concurrent) | **Yes** — one worktree per task |
| Track mode (persistent feature tracks) | **Yes** — one worktree per feature track |
| `/ship-review` diff inspection | Optional — read-only; worktree only if reviewing across branches |
| Hotfix | No — work on the user's current branch directly |
| `/ship-quick` | No — single change, working branch |

The rule of thumb: **isolate when concurrency would otherwise race**. Sequential work doesn't need worktrees.

## How to Create a Worktree (the New, Simple Way)

The orchestrator dispatches a subagent with `isolation: "worktree"` on the `Agent` call:

```
Agent(
  subagent_type: "general-purpose",
  model: <caller-resolved model tier, or omit>,
  effort: <caller-resolved agent_effort tier, or omit>,
  isolation: "worktree",
  prompt: <task-loop prompt template, parameterized>
)
```

Claude Code:

1. Fires the `WorktreeCreate` hook (Shipyard's `worktree-branch.mjs`) which creates a branch named `shipyard/wt-<id>` from the current local HEAD.
2. Creates the worktree under `.claude/worktrees/<id>/` with that branch checked out.
3. Spawns the subagent with cwd = the worktree path.
4. Subagent edits / commits / runs tests in the worktree.
5. Subagent returns; Claude Code captures the cwd correctly (no leakage to parent).
6. After the orchestrator-side gate passes, orchestrator **accepts each returned commit** (`shipyard-data task accept-return <task> sprint=<id> wave=<n> commit=<sha> --data-dir <data_dir>`), which anchors the commit, records the terminal return event, and marks the task done, then rebases + ff-merges the worktree branch back onto the working branch. It discovers the branch from git ground truth (`git worktree list` → the `shipyard/wt-*` row), **never** from the Agent return's `worktreeBranch` field — that field is undefined/unreliable (Claude Code #51596), and trusting it is what skipped merge-back and orphaned six commits in the v2.8 incident.
7. Orchestrator runs `shipyard-data verify-wave-integrated` (the pre-teardown gate); only on exit 0 does it remove the worktree (`git worktree remove`) and delete the branch with `git branch -d` (never `-D`).

The orchestrator does **not** need to:
- Pre-create the worktree manually.
- Pass the worktree path in the prompt.
- Tell the subagent to `cd` into the worktree.
- Track which subagent ended up in which directory.

All of that is now Claude Code's job.

## Branch Naming

Shipyard's `WorktreeCreate` hook (`bin/hooks/worktree-branch.mjs`) names the branch `shipyard/wt-<id>` where `<id>` is derived from the worktree name Claude Code passes to the hook. Conventions:

- Per-task subagent: `<id>` = `<TASK_ID>-<short-slug>` → branch `shipyard/wt-T-042-add-user-endpoint`.
- Per-feature track (track mode): `<id>` = `<FEATURE_ID>-<short-slug>` → branch `shipyard/wt-F-007-checkout-rewrite`.
- Probe / readiness check: `<id>` = `probe-<timestamp>` → branch `shipyard/wt-probe-1715168400`.

The `shipyard/wt-` prefix is the discriminator: any branch starting with it is a Shipyard-owned worktree branch and may be safely cleaned up by the orchestrator at wave boundaries.

**Discover the branch from git, not the Agent return.** The branch name is deterministic (`shipyard/wt-<worktree-name>`) and visible in `git worktree list --porcelain`. Do NOT read it from the Agent tool's `worktreeBranch` return field: because Shipyard's hook owns branch creation, Claude Code reports `worktreeBranch: undefined` (the #51596 bug), so any logic that keys off it silently no-ops the merge-back. Integrate by the `COMMIT:` SHA from the structured return contract + the `shipyard/wt-*` row from `git worktree list` — both ground truth.

## Base Ref: `head` for In-Progress Sprints

Shipyard's worktrees must branch from **local HEAD**, not `origin/<default>`. Sprint work builds on local-only commits from earlier waves; an `origin/<default>` base would silently drop them.

Set in the project's `.claude/settings.json`:

```json
{ "worktree": { "baseRef": "head" } }
```

**Verified at execute, not just at setup.** `/ship-execute` Step 0 runs `shipyard-data ensure-worktree-baseref`, which sets this idempotently every sprint (atomic JSON merge — never a model hand-edit). Don't rely on setup having set it once: it drifts, and a missing setting is silently wrong. The setting is also the backstop for when the `WorktreeCreate` hook doesn't fire — native worktree creation then still bases on local HEAD instead of `fresh` (= `origin/<default>`), which would skip Wave N-1's commits.

## Cleanup at Wave Boundaries

After all subagents in a wave return:

1. **Accept every gate-passed return first.** `shipyard-data task accept-return <task> sprint=<id> wave=<n> commit=<sha> --data-dir <data_dir>` for each `COMPLETE` return pins a `shipyard/keep-<task>` ref to the commit and records terminal evidence. From here the commit survives rebase, teardown, and worktree-name collisions — the insurance half of the integration gate. Use bare `shipyard-data anchor-commit` only for salvage paths where a branch tip must be preserved but the task did not pass the gate and must not be marked done.
2. **Rebase each task branch sequentially onto the working branch**, in task-ID order (deterministic, replayable history even though tasks ran in parallel). Discover the branches from `git worktree list` (the `shipyard/wt-*` rows), never from `worktreeBranch`.
   ```
   for branch in shipyard/wt-T-042 shipyard/wt-T-043 ...; do
     git rebase <working-branch> $branch
     git checkout <working-branch>
     git merge --ff-only $branch
   done
   ```
   Conflicts → render the conflicting file list and the conflict hunks as chat text first (diffs read via git exist only in context and can't render inside an AskUserQuestion card), then `AskUserQuestion`. Do NOT fall back to a regular merge — that creates fork lines in the graph.
3. **Gate before teardown.** `shipyard-data verify-wave-integrated` proves every live `shipyard/wt-*` branch is merged and no return commit is dangling. Exit 3 → HARD STOP: don't remove anything; integrate the named branches and re-run. This is the structural guarantee that teardown can never precede merge-back.
4. **Remove the worktree and delete the branch — only past the gate:**
   ```
   git worktree remove .claude/worktrees/<id>
   git branch -d shipyard/wt-<id>     # -d, never -D: refuses an unmerged branch
   ```
5. **Verify clean state** — `git worktree list` should show no `shipyard/wt-*` paths after wave merge.

Anthropic's stale-worktree cleanup handles the case where a subagent crashed without committing — leftover worktrees with no uncommitted changes and no unpushed commits get reaped at session start automatically (per Claude Code's `cleanupPeriodDays` setting). Shipyard does not need to duplicate this.

## When Things Go Wrong

### Subagent's worktree branch doesn't start with `shipyard/wt-*`

This means the `WorktreeCreate` hook didn't fire correctly. Hard-stop the subagent (the prompt template instructs it to refuse to proceed). Investigate the hook before retrying — never let the subagent "fix" by checking out the working branch directly, that bypasses isolation entirely.

### The Agent return shows `worktreeBranch: undefined`

Expected, not an error. Shipyard's `WorktreeCreate` hook owns branch creation, so Claude Code has no branch of its own to report (Claude Code #51596). **Never gate merge-back on this field.** Derive the branch from `git worktree list` and integrate by the `COMMIT:` SHA from the return contract. If you find yourself thinking "I don't know which branch to merge," that's the bug — the branch is `shipyard/wt-<worktree-name>`, sitting in `git worktree list` right now. This exact confusion orphaned six verified commits in the v2.8 incident.

### Rebase conflicts at wave boundary

Two parallel subagents touched the same file. This shouldn't happen if task decomposition was clean — flag it as a planning lesson. Resolve by:

1. Render the conflict files and the two diffs as chat text, then AskUserQuestion — the AskUserQuestion card cannot carry diffs; packing them into option strings does not count as showing them.
2. User chooses which to keep, or merges manually.
3. Continue the wave.

### Stale `git worktree` administrative metadata

If a user manually `rm -rf`'d a worktree directory, git's internal `.git/worktrees/<name>/` lingers. Defend with:

```
git worktree prune
```

Run this at the start of `/ship-execute` (Step 0). It only removes admin metadata for already-deleted directories — never touches live worktrees, branches, or commits.

### Worktree branch failure (hook didn't run)

Anthropic fixed this for `--worktree` and `isolation: worktree` (changelog: "Fixed `WorktreeCreate` and `WorktreeRemove` plugin hooks being silently ignored"), so this should be rare. If it happens:

- Verify `plugins/shipyard/hooks/hooks.json` has the `WorktreeCreate` entry — hook installation isn't reported by any CLI; check the manifest directly.
- Check the recent `claude --version` against the changelog requirement.

## Pairing With Other Skills

- **`dispatching-task-loop`** uses this skill's contract when dispatching with `isolation: "worktree"`. The dispatch skill's prompt tells the subagent its branch should start with `shipyard/wt-` — that contract is owned here.
- **`acquiring-skill-lock`** is independent; locks live under `<SHIPYARD_DATA>` (outside any worktree), so worktree creation doesn't affect lock semantics.
- **`/ship-review`** can read the diff against either the merged working branch or specific worktree branches; this skill provides the branch-naming convention.

## Bottom Line

- Use worktrees for parallel concurrency, not sequential work.
- `isolation: "worktree"` on the Agent call is now the only path. No manual fallback.
- Branch naming: `shipyard/wt-<id>` (the `WorktreeCreate` hook owns this).
- `worktree.baseRef: "head"` so wave-N+1 sees wave-N's commits.
- Rebase and merge in task-ID order at wave boundary; remove worktree; delete branch.
- Trust Anthropic's stale cleanup; Shipyard's job stops at "merged + pruned + removed."
