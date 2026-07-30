# Git Strategy

Shipyard works on whatever branch the user is already on. It does not create branches, push, or manage merge strategy — the user owns their git workflow.

## Principles

1. **Shipyard never pushes.** No `git push` anywhere. The user pushes when ready.
2. **Shipyard never creates branches** (except worktree task branches for parallel execution, which are temporary).
3. **Shipyard never merges to main.** The user handles their own merge/squash/PR workflow.
4. **Worktrees branch from the user's current local branch** — a WorktreeCreate hook overrides Claude Code's default (which branches from `origin/HEAD`).
5. **Atomic commits per task.** One commit per completed task, following the project's commit convention.

## Commit Convention

Shipyard reads the project's commit format from `<SHIPYARD_DATA>/config.md` (created and updated by CLI onboarding/config).
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

### Task Mode (parallel tasks)
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

**Never fall back to regular merge** — that creates fork lines in the git graph. If rebase has conflicts, print the conflict details as chat text first — branch name, conflicting files, the relevant `git status` lines (git output is not shown to the user until printed) — then AskUserQuestion. The sequential order matters: each rebase starts from the updated HEAD after the previous merge, so ff-only always succeeds.

### Track Mode (wave-scoped track coordinators + nested per-task builders)
Track mode nests the same one-task-one-branch shape as Task Mode under a wave-scoped coordinator per feature track — it does **not** stack multiple task commits onto one feature-wide branch. Every task still gets its own worktree, its own branch, and exactly one commit; the coordinator adds sequencing and cross-task briefing, not a different git shape.

```
User's branch: feature/auth

Track coordinator "F001" → worktree branch: shipyard/wt-F001-email-login
  (isolated, but NEVER commits — the coordinator's own worktree stays at
  wave-start HEAD the whole wave; nothing to rebase or merge for it)
    ├─ nested builder T001 → worktree branch: shipyard/wt-T001-auth-config
    │     Commits while working: test(T001) / feat(T001)  — ONE commit
    └─ nested builder T002 → worktree branch: shipyard/wt-T002-login-page
          Commits while working: test(T002) / feat(T002)  — ONE commit
```

**Each nested task branch integrates exactly like a Task Mode branch** — sequentially, one at a time, in task-ID order, at the wave boundary:
```bash
git rebase [user-branch] shipyard/wt-T001-auth-config
git checkout [user-branch]
git merge --ff-only shipyard/wt-T001-auth-config
git worktree remove <path>
git branch -d shipyard/wt-T001-auth-config

git rebase [user-branch] shipyard/wt-T002-login-page
git checkout [user-branch]
git merge --ff-only shipyard/wt-T002-login-page
git worktree remove <path>
git branch -d shipyard/wt-T002-login-page
```

**The coordinator's own branch (`shipyard/wt-F001-email-login`) is never rebased or merged** — it never advanced past wave-start HEAD, so it is trivially "merged" already (`git branch -d` succeeds with nothing to lose). Remove it like any other stale worktree once the coordinator itself has finished. See `references/track-mode.md` for the full protocol, including why nested builders don't chain onto each other's commits mid-wave (every nested builder forks from the coordinator's fixed HEAD, not a sibling's branch) and how the coordinator's running TRACK NOTES compensate for that.

## Wave Boundary

Between waves, the orchestrator:
1. Rebases and merges every completed task branch onto the user's branch — one task, one branch, regardless of whether it was dispatched directly (task mode) or nested under a track coordinator (track mode); a track coordinator's own branch is removed, never merged (it never advanced)
2. Resolves merge conflicts — for non-trivial conflicts, render the conflicting branch + file list as chat text, then AskUserQuestion
3. Deletes merged task branches, cleans up worktrees
4. Delegates **wave-scoped build + tests** to a test subagent
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

1. **Created** at wave start — one per parallel task in task mode; one per parallel task PLUS one per track coordinator in track mode (the coordinator's own worktree is never committed to — see "Track Mode" above)
2. **Branched** from user's current local branch (via WorktreeCreate hook)
3. **Named** `shipyard/wt-TASK_ID-slug` (task mode, and every nested per-task builder in track mode) or `shipyard/wt-FEATURE_ID-slug` (a track coordinator's own worktree in track mode) — both conventions are live simultaneously under track mode, at two different layers
4. **Rebased** onto user's branch at wave end — task branches only; a track coordinator's own branch never advanced, so there is nothing to rebase for it (item 6 covers its cleanup)
5. **Merged** via fast-forward only — on ff failure, flagged to the user (never an automatic regular-merge fallback; see item 7 and the hard rule below)
6. **Cleaned up** after successful merge: `git worktree remove` + `git branch -d` (a track coordinator's own worktree/branch is cleaned up the same way once the coordinator itself has finished, even though nothing was ever merged from it)
7. **Preserved** if merge conflict — flagged to user for manual resolution

### WorktreeCreate Hook

Claude Code's default `isolation: worktree` branches from `origin/HEAD` (the remote default branch), not the user's current branch. Shipyard overrides this with a WorktreeCreate hook that creates the worktree with `git worktree add -b shipyard/wt-<name> <path> <current_sha>` — branching from the user's current HEAD, not origin/HEAD.

The builder agent verifies it's on the expected branch as its first action. If the branch is neither `shipyard/wt-*` (worktree mode) nor the working branch (solo mode), the builder hard-stops — it never falls back to checking out the working branch, which would bypass the rebase/review step.

## Known Claude Code Bugs & Workarounds

Shipyard implements workarounds for several Claude Code bugs that affect worktree and agent team workflows. These are documented here so maintainers understand why certain patterns exist.

### Worktree Bugs

| Bug | Impact | Workaround |
|-----|--------|------------|
| **#34645** — Parallel worktree creation races on `.git/config.lock` | Some agents fail on spawn | File lock in `worktree-branch.mjs` serializes creation |
| **#34775** — Agent frontmatter `isolation: worktree` ignored | Builder agent runs unisolated | Always pass `isolation: "worktree"` in Agent() call, never rely on frontmatter |
| **#40262** — Hook stdout corrupts worktree path | Worktree creation fails | All hooks document STDOUT CONTRACT; only WorktreeCreate writes to stdout |
| **#43535** — Worktree branches from `origin/HEAD` not current branch | Agents work on wrong code | WorktreeCreate hook explicitly passes `current_sha` as start point |

**#37549 is not in this table — it isn't a bug and there is no workaround to document.** It is a Claude Code *design decision*: Agent Teams don't get worktree isolation *automatically*. It does not mean `isolation: "worktree"` is ignored when explicitly requested — passing it explicitly isolates any agent, team-context or not (every isolated agent gets its own distinct worktree AND its own distinct `shipyard/wt-*` branch, `WorktreeCreate` firing for each one). Track mode's coordinators and every nested builder always pass `isolation: "worktree"` explicitly (`references/track-mode.md`), so #37549 never applies to anything Shipyard dispatches — there is nothing to work around.

### Data Loss Bugs

| Bug | Impact | Workaround |
|-----|--------|------------|
| **#29110** — Worktree cleanup destroys uncommitted work | Silent data loss | Builder agent has mandatory "Before Exiting" commit protocol |
| **#35862** — Three silent data-loss paths in cleanup | Resumed/concurrent worktrees deleted | Step 0 salvage runs before any execution; builders commit before exit |
| **#42282** — CWD drift after worktree agent returns | Parent session breaks | Resolved upstream — Anthropic-native CWD handling restores the parent CWD; the prior `cwd-restore` hook was retired |

### Permission Bugs

| Bug | Impact | Workaround |
|-----|--------|------------|
| **#39973** — Approval prompts may reset permission mode to `acceptEdits` | Wave boundary approvals can downgrade permissions | PreToolUse hook with `permissionDecision: allow` for Shipyard data paths |
| **#41763** — Writes outside project root downgrade bypass mode | Plugin data writes trigger prompts | Same PreToolUse hook — fires before permission evaluator |
| **#37442** — Subagents don't inherit `bypassPermissions` | Builder agents prompted for every write | Hooks inherited via plugin hooks.json (not session state) |

### Agent Team Bugs

| Bug | Impact | Workaround |
|-----|--------|------------|
| **#32906** — Path-scoped rules don't load in subagents | TDD/execution rules missing | Critical rules inlined into spawn prompts (every builder and track-coordinator brief) |
| **#39699** — Lead polling creates feedback loop + duplicate teammates | Token waste, duplicate work | Main never polls a coordinator or a builder for status via repeated `SendMessage`/`TaskList` calls — it waits on the event-log `Monitor` (armed once, per wave) for `subagent_completed`, and on each spawned agent's own background-completion notification. `TaskList` is a mirror main writes to, never a polling read main relies on for liveness (see `references/track-mode.md` § "Main's Monitoring Loop" and § "Liveness — no heartbeat file"). |

### Edge Cases

**Already on a worktree branch:** If the orchestrator is on a `shipyard/wt-*` branch (leftover from crash/previous session), new worktrees would branch from the wrong commit. The pre-spawn branch check detects this and switches to the working branch. The readiness check warns the user.

**Nested worktrees:** If the project is itself a worktree (e.g., user used `git worktree add` for the project), the WorktreeCreate hook detects this via `git-common-dir` vs `git-dir` comparison and creates new worktrees from the parent repo.

## Config

Git config in `<SHIPYARD_DATA>/config.md`:

```yaml
git:
  main_branch: main              # or master — configured during onboarding
  commit_format: conventional    # conventional | gitmoji | jira | freeform
  commit_scope: true
  commit_case: lowercase
  commit_examples: []
```

That's it. No sprint_branch, no merge_strategy, no pr_on_sprint_complete. The user owns their branching and merge workflow.
