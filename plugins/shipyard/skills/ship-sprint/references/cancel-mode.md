0. If the sprint status is `completed`, STOP: cancel is for active sprints (`sprint set status cancelled` is refused). Run `/ship-review`, or `archive-sprint <id> --unreviewed` to archive knowingly.
1. AskUserQuestion: "Why are you cancelling this sprint? (This feeds the retro — 'skip' is fine.)"
2. For each task in the sprint:
   - **Done tasks** → keep commits, status stays `done`
   - **In-progress tasks** → commit work-in-progress with `wip(cancel):` prefix, then per task `shipyard-data step set-status <PID> approved`; per parent feature `shipyard-data story set-status <SID> approved` followed by `shipyard-data backlog add <SID>`
   - **Not started tasks** → per task `shipyard-data step set-status <PID> approved`; per parent feature `shipyard-data story set-status <SID> approved` followed by `shipyard-data backlog add <SID>`
   - For all cancelled features (not done): `shipyard-data story clear-steps <SID>` so the next sprint planning re-decomposes them fresh
3. Sprint status → `cancelled` via `shipyard-data sprint set status cancelled` (not a hand Edit of SPRINT.md frontmatter)
4. Git cleanup:
   - Any uncommitted work is committed as WIP
   - Clean up any isolated working copies (worktrees)
   - Stay on current branch (user handles branch switching)
5. Archive the cancelled sprint: run `shipyard-data archive-sprint sprint-NNN` (substitute the real sprint ID). This atomically renames `current/` → `sprint-NNN/` and recreates an empty `current/` in a single allowlisted call. Do NOT fall back to raw `cp`/`mv`/`mkdir` against the data dir — those prompt for permission because the plugin data dir is outside the project root.
6. Report: "Sprint cancelled. [N] tasks done (kept), [M] returned to backlog."
