---
name: using-worktrees
description: Give a task its own filesystem checkout.
disable-model-invocation: true
---

# Using Worktrees

Shipyard isolates parallel task execution in git worktrees so concurrent subagents don't clobber each other's edits. **Trust the platform** — pass `isolation: worktree` on the Agent call and let Claude Code handle creation, cwd, and cleanup.

## When to Use Worktrees

| Mode | Use worktrees? |
|---|---|
| Solo (1–3 tasks per wave, sequential) | No — tasks run on the working branch, one after another |
| Subagent / parallel (4+ tasks per wave, concurrent) | **Yes** — one worktree per task |
| Team mode (10+ tasks, persistent feature tracks) | **Yes** — one worktree per feature track |
| `/ship-review` diff inspection | Optional — read-only; worktree only if reviewing across branches |
| Hotfix | No — work on the user's current branch directly |
| `/ship-quick` | No — single change, working branch |

The rule of thumb: **isolate when concurrency would otherwise race**. Sequential work doesn't need worktrees.

## How to Create a Worktree (the New, Simple Way)

The orchestrator dispatches a subagent with `isolation: "worktree"` on the `Agent` call:

```
Agent(
  subagent_type: "general-purpose",
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
6. Orchestrator rebases + merges the worktree branch back onto the working branch.
7. Orchestrator removes the worktree (`git worktree remove`) and deletes the merged branch.

The orchestrator does **not** need to:
- Pre-create the worktree manually.
- Pass the worktree path in the prompt.
- Tell the subagent to `cd` into the worktree.
- Track which subagent ended up in which directory.

All of that is now Claude Code's job.

## Branch Naming

Shipyard's `WorktreeCreate` hook (`bin/hooks/worktree-branch.mjs`) names the branch `shipyard/wt-<id>` where `<id>` is derived from the worktree name Claude Code passes to the hook. Conventions:

- Per-task subagent: `<id>` = `<TASK_ID>-<short-slug>` → branch `shipyard/wt-T-042-add-user-endpoint`.
- Per-feature track (team mode): `<id>` = `<FEATURE_ID>-<short-slug>` → branch `shipyard/wt-F-007-checkout-rewrite`.
- Probe / readiness check: `<id>` = `probe-<timestamp>` → branch `shipyard/wt-probe-1715168400`.

The `shipyard/wt-` prefix is the discriminator: any branch starting with it is a Shipyard-owned worktree branch and may be safely cleaned up by the orchestrator at wave boundaries.

## Base Ref: `head` for In-Progress Sprints

Shipyard's worktrees should branch from **local HEAD**, not from `origin/<default>`. Sprint work builds on uncommitted-but-local commits from earlier waves; an `origin/<default>` base would lose them.

Set in project `.claude/settings.json` (handled by `/ship-init` going forward):

```json
{
  "worktree": {
    "baseRef": "head"
  }
}
```

Without this setting, Anthropic defaults to `fresh` (= `origin/<default>`). Sprint Wave 2's worktrees would skip Wave 1's local commits — silently broken, hard to debug.

## Cleanup at Wave Boundaries

After all subagents in a wave return:

1. **Rebase each task branch sequentially onto the working branch.** Even if tasks ran in parallel, merge in a deterministic order (task ID ascending) for replayable git history.
   ```
   for branch in shipyard/wt-T-042 shipyard/wt-T-043 ...; do
     git rebase <working-branch> $branch
     git checkout <working-branch>
     git merge --ff-only $branch
   done
   ```
2. **If a rebase has conflicts** → `AskUserQuestion` with conflict details. Do NOT fall back to a regular merge — that creates fork lines in the graph.
3. **Remove the worktree and delete the branch:**
   ```
   git worktree remove .claude/worktrees/<id>
   git branch -d shipyard/wt-<id>
   ```
4. **Verify clean state** — `git worktree list` should show no `shipyard/wt-*` paths after wave merge.

Anthropic's stale-worktree cleanup handles the case where a subagent crashed without committing — leftover worktrees with no uncommitted changes and no unpushed commits get reaped at session start automatically (per Claude Code's `cleanupPeriodDays` setting). Shipyard does not need to duplicate this.

## When Things Go Wrong

### Subagent's worktree branch doesn't start with `shipyard/wt-*`

This means the `WorktreeCreate` hook didn't fire correctly. Hard-stop the subagent (the prompt template instructs it to refuse to proceed). Investigate the hook before retrying — never let the subagent "fix" by checking out the working branch directly, that bypasses isolation entirely.

### Rebase conflicts at wave boundary

Two parallel subagents touched the same file. This shouldn't happen if task decomposition was clean — flag it as a planning lesson. Resolve by:

1. AskUserQuestion with the conflict files and the two diffs.
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

- Check `shipyard-context diagnose` (or its successor `doctor`) for hook installation status.
- Verify `plugins/shipyard/hooks/hooks.json` has the `WorktreeCreate` entry.
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
