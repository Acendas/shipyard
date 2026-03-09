# Git Strategy

Shipyard works on whatever branch the user is already on. It does not create branches, push, or manage merge strategy — the user owns their git workflow.

## Principles

1. **Shipyard never pushes.** No `git push` anywhere. The user pushes when ready.
2. **Shipyard never creates branches** (except worktree task branches for parallel execution, which are temporary).
3. **Shipyard never merges to main.** The user handles their own merge/squash/PR workflow.
4. **Worktrees branch from the user's current local branch** — a WorktreeCreate hook overrides Claude Code's default (which branches from `origin/HEAD`).
5. **Atomic commits per task.** One commit per completed task, following the project's commit convention.

## Commit Convention

Shipyard reads the project's commit format from `$(shipyard-data)/config.md` (detected during `/ship-init`).
All commits must follow the project's convention. The config specifies:

```yaml
git:
  commit_format: conventional  # conventional | gitmoji | jira | freeform
  commit_scope: true           # use scopes?
  commit_case: lowercase
  commit_examples:             # real examples from the project's history
    - "feat(auth): add login page"
    - "fix(api): handle null response"
```

**During execution**, every commit follows this format. Examples per format:

| Format | Task commit |
|---|---|
| **conventional** | `feat(auth): implement login form T002` |
| **gitmoji** | `:sparkles: implement login form T002` |
| **jira** | `PROJ-42: implement login form T002` |
| **freeform** | `Implement login form T002` |

Task IDs are always included in the commit message for traceability.

## During Execution

### Solo Mode
Work directly on the user's current branch. Each task gets one atomic commit.

```bash
# User is on feature/auth (or main, or whatever they chose)
# ... work on T001 ...
git add -A && git commit -m "feat(T001): implement auth config"
# ... work on T002 ...
git add -A && git commit -m "feat(T002): build login page"
```

### Subagent Mode (parallel tasks)
Each subagent works in a worktree with its own temporary task branch.

The WorktreeCreate hook ensures worktrees branch from the user's current local branch, not `origin/HEAD`.

```
User's branch: feature/auth

Wave 2 (parallel):
  Subagent 1 → worktree branch: shipyard/wt-T002-login-page
  Subagent 2 → worktree branch: shipyard/wt-T003-auth-middleware
  Subagent 3 → worktree branch: shipyard/wt-T004-rls-policies
```

After wave completes — **rebase and merge each task branch one at a time, sequentially**:
```bash
# Process each branch IN ORDER (not parallel):
git rebase [user-branch] shipyard/wt-T002-login-page   # replay onto current HEAD
git checkout [user-branch]
git merge --ff-only shipyard/wt-T002-login-page         # always works after rebase
git worktree remove <path>
git branch -d shipyard/wt-T002-login-page

# HEAD has moved forward — next rebase starts from updated HEAD
git rebase [user-branch] shipyard/wt-T003-auth-middleware
git checkout [user-branch]
git merge --ff-only shipyard/wt-T003-auth-middleware
git worktree remove <path>
git branch -d shipyard/wt-T003-auth-middleware

# Repeat for each task branch...
```

**Never fall back to regular merge** — that creates fork lines in the git graph. If rebase has conflicts, AskUserQuestion with the conflict details. The sequential order matters: each rebase starts from the updated HEAD after the previous merge, so ff-only always succeeds.

### Team Mode (persistent teammates)
Each teammate works in a worktree on a feature branch.

```
User's branch: feature/auth

Teammate "Auth" → worktree branch: shipyard/wt-F001-email-login
  Commits while working:
    - test(T001): add auth config tests
    - feat(T001): implement auth config
    - test(T002): add login page tests
    - feat(T002): implement login page
```

When feature complete — **rebase onto user's branch**, then merge:
```bash
git checkout shipyard/wt-F001-email-login
git rebase [user-branch]
git checkout [user-branch]
git merge --ff-only shipyard/wt-F001-email-login

# Clean up
git worktree remove <path>
git branch -d shipyard/wt-F001-email-login
```

## Wave Boundary

Between waves, the orchestrator:
1. Rebases and merges completed task/feature branches onto the user's branch
2. Resolves merge conflicts — flag non-trivial conflicts to user via AskUserQuestion
3. Deletes merged task branches, cleans up worktrees
4. Delegates **integration tests** to a test subagent
5. Creates worktrees for next wave from updated user branch HEAD

## Hotfix Flow

Hotfixes follow the same principle — work on the user's current branch:

```bash
# User creates their own hotfix branch (or works on main — their choice)
# Execute TDD cycle (must include regression test)
git commit -m "fix(B-HOT-001): handle null session on login"
```

Shipyard does not merge the hotfix anywhere. The user handles merge/PR.

## Worktree Lifecycle

1. **Created** at wave start — one per parallel task/feature
2. **Branched** from user's current local branch (via WorktreeCreate hook)
3. **Named** `shipyard/wt-TASK_ID-slug` (subagent mode) or `shipyard/wt-FEATURE_ID-slug` (team mode)
4. **Rebased** onto user's branch at wave end
5. **Merged** via fast-forward (or regular merge if ff fails)
6. **Cleaned up** after successful merge: `git worktree remove` + `git branch -d`
7. **Preserved** if merge conflict — flagged to user for manual resolution

### WorktreeCreate Hook

Claude Code's default `isolation: worktree` branches from `origin/HEAD` (the remote default branch), not the user's current branch. Shipyard overrides this with a WorktreeCreate hook that creates the worktree with `git worktree add -b shipyard/wt-<name> <path> <current_sha>` — branching from the user's current HEAD, not origin/HEAD.

The builder agent verifies it's on the expected branch as its first action. If the branch is neither `shipyard/wt-*` (worktree mode) nor the working branch (solo mode), the builder hard-stops — it never falls back to checking out the working branch, which would bypass the rebase/review step.

## Known Claude Code Bugs & Workarounds

Shipyard implements workarounds for several Claude Code bugs that affect worktree and agent team workflows. These are documented here so maintainers understand why certain patterns exist.

### Worktree Bugs

| Bug | Impact | Workaround |
|-----|--------|------------|
| **#37549** — `isolation: worktree` silently ignored with `team_name` | Team mode agents run in main repo, no isolation | Manual worktree creation before spawning teammates (see team-mode.md) |
| **#34645** — Parallel worktree creation races on `.git/config.lock` | Some agents fail on spawn | File lock in worktree-branch.py serializes creation |
| **#34775** — Agent frontmatter `isolation: worktree` ignored | Builder agent runs unisolated | Always pass `isolation: "worktree"` in Agent() call, never rely on frontmatter |
| **#40262** — Hook stdout corrupts worktree path | Worktree creation fails | All hooks document STDOUT CONTRACT; only WorktreeCreate writes to stdout |
| **#43535** — Worktree branches from `origin/HEAD` not current branch | Agents work on wrong code | WorktreeCreate hook explicitly passes `current_sha` as start point |

### Data Loss Bugs

| Bug | Impact | Workaround |
|-----|--------|------------|
| **#29110** — Worktree cleanup destroys uncommitted work | Silent data loss | Builder agent has mandatory "Before Exiting" commit protocol |
| **#35862** — Three silent data-loss paths in cleanup | Resumed/concurrent worktrees deleted | Step 0 salvage runs before any execution; builders commit before exit |
| **#42282** — CWD drift after worktree agent returns | Parent session breaks | PostToolUse hook on Agent restores CWD (cwd-restore.py) |

### Permission Bugs

| Bug | Impact | Workaround |
|-----|--------|------------|
| **#39973** — `ExitPlanMode` resets permission mode to `acceptEdits` | Every wave boundary downgrades permissions | PreToolUse hook with `permissionDecision: allow` for Shipyard data paths |
| **#41763** — Writes outside project root downgrade bypass mode | Plugin data writes trigger prompts | Same PreToolUse hook — fires before permission evaluator |
| **#37442** — Subagents don't inherit `bypassPermissions` | Builder agents prompted for every write | Hooks inherited via plugin hooks.json (not session state) |

### Agent Team Bugs

| Bug | Impact | Workaround |
|-----|--------|------------|
| **#32906** — Path-scoped rules don't load in subagents | TDD/execution rules missing | Critical rules inlined into spawn prompts |
| **#39699** — Lead polling creates feedback loop + duplicate teammates | Token waste, duplicate work | Lead uses TaskList for monitoring, not SendMessage polling |

### Edge Cases

**Already on a worktree branch:** If the orchestrator is on a `shipyard/wt-*` branch (leftover from crash/previous session), new worktrees would branch from the wrong commit. The pre-spawn branch check detects this and switches to the working branch. The readiness check warns the user.

**Nested worktrees:** If the project is itself a worktree (e.g., user used `git worktree add` for the project), the WorktreeCreate hook detects this via `git-common-dir` vs `git-dir` comparison and creates new worktrees from the parent repo.

## Config

Git config in `$(shipyard-data)/config.md`:

```yaml
git:
  main_branch: main              # or master — detected during /ship-init
  commit_format: conventional    # conventional | gitmoji | jira | freeform
  commit_scope: true
  commit_case: lowercase
  commit_examples: []
```

That's it. No sprint_branch, no merge_strategy, no pr_on_sprint_complete. The user owns their branching and merge workflow.
