# Carry-Over Scan (Step 1.5 detail)

Before selecting new features, scan for unfinished work from previous cycles. These items take priority over new features — they represent commitments already made.

## Scan locations

### 1. Open bugs
Use Grep with `pattern: ^status: (open|investigating)`, `path: <SHIPYARD_DATA>/spec/bugs`, `glob: B*.md`, `output_mode: files_with_matches`. Read each match to get title, severity, source (sprint ID, code review, integration test).

### 2. Blocked tasks
Use Grep with `pattern: ^status: blocked`, `path: <SHIPYARD_DATA>/spec/tasks`, `glob: T*.md`, `output_mode: files_with_matches`. Read each match to get title, parent feature, blocked reason.

### 3. Carried-over ideas (retro, execute, review-gap)
Use Grep with `pattern: ^source: (execute|review-gap|retro)[-/]`, `path: <SHIPYARD_DATA>/spec/ideas`, `glob: IDEA-*.md`, `output_mode: files_with_matches`. The pattern matches three idea origins:
- **`source: retro/<sprint-id>`** — improvements the team committed to during retrospectives (new slash-separated form) OR `source: retro-sprint-<NNN>` (legacy hyphen-separated form, still recognized for backwards compatibility with IDEAs created before the source-tag convention change)
- **`source: execute/<sprint-id>`** — deferred unknowns captured by builders during task execution (per `dispatching-task-loop`'s capture-deferred-unknowns prompt section)
- **`source: review-gap/<sprint-id>`** — out-of-scope findings captured during `/ship-review` Stage 0 or Stage 4 (see `skills/ship-review/SKILL.md` → "Capture Out-of-Scope Gaps as IDEAs")

**Recency filter (important — prevents flooding):** over 10+ sprints a project accumulates many ideas, and showing all of them in every planning session is unusable. For each match, Read the frontmatter and keep the idea ONLY if either:
- its `source:` field references one of the **last 2 sprint IDs** (the previous sprint or the one before it), OR
- its `created:` date is within the **last 14 days**

Everything else stays reachable via `/ship-discuss` triage mode but doesn't clutter sprint planning.

**Display cap:** show at most **8 ideas** across all three origins combined, grouped by origin. If there are more than 8 after the recency filter, show the 8 newest and add a `+N more — see /ship-discuss triage for full list` footer line. Group by origin so retro items stay visually distinct from execute/review-gap discoveries.

**Why these three origins specifically:** they are the three writer paths — retro writes at sprint end, execute writes during task work, review-gap writes during out-of-scope findings detection. If a new writer path is added later (e.g., `debug/`, `hotfix/`), it must be added to this regex explicitly — do NOT widen to `^source: ` wildcard, because `source: "inline capture"` from ship-discuss's CAPTURE mode should NOT auto-carry (the user just captured it; they'll discuss it next via triage, not immediately re-surface it in sprint planning).

### 4. In-progress features
Use Grep with `pattern: ^status: in-progress`, `path: <SHIPYARD_DATA>/spec/features`, `glob: F*.md`, `output_mode: files_with_matches`. Filter to features NOT in an active sprint (read SPRINT.md to find current sprint feature IDs). These were started but not completed/approved in a previous sprint.

### 5. Silent-pass suspects
Use Grep with `pattern: ^kind: operational`, `path: <SHIPYARD_DATA>/spec/tasks`, `glob: T*.md`, `output_mode: files_with_matches`. For each match, Read the frontmatter and check two conditions: (a) `status: done` AND `verify_output:` field is absent or empty, OR (b) `verify_history:` exists but the most recent entry has `exit: <non-zero>` or `escalated: true`. These are operational tasks that were *marked done* in a prior sprint without captured evidence of a passing run — the exact silent-pass failure mode. Surface them under their own heading: **"PREVIOUSLY MARKED DONE WITHOUT EVIDENCE — re-verify?"**. The user should decide: re-run verify now (add as an operational carry-over task), promote findings to a new sprint, or accept-with-known-issues. Never silently re-mark these as approved and carry them into the new sprint untouched — the whole point of this scan is to break the deterministic recurrence of the silent-pass bug.

### 6. Needs-attention tasks (prior sprint escalation)
Use Grep with `pattern: ^status: needs-attention`, `path: <SHIPYARD_DATA>/spec/tasks`, `glob: T*.md`, `output_mode: files_with_matches`. These are tasks that a prior sprint's operational fix-findings loop or research dispatcher escalated — the loop ran, produced a full audit trail in `verify_history` or `research_history`, but did not converge. Distinct from silent-pass (no evidence) and blocked (waiting on a dependency): needs-attention tasks have *tried and failed*, and the user has enough information in the history to make a decision. For each match, Read the frontmatter and extract the last 3 `verify_history` entries (or `research_history` for `kind: research`) plus the escalation reason from the final entry. Surface under the heading **"⚠ NEEDS ATTENTION — prior sprint escalation"**. Do NOT auto-carry into the new sprint — the user must explicitly choose: open a debug session, re-plan findings as individual feature tasks, re-scope the research, or accept with known issues.

## Display format (carry-over before feature list)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 CARRY-OVER (from previous sprints)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 BUGS ([N] open)
  B-CR-001 — Missing null check in auth middleware (code review, must-fix)
  B-INT-002 — Payment webhook timeout (integration test failure)

 BLOCKED TASKS ([N])
  T045 — OAuth token refresh (blocked: API key not provisioned)
    Parent: F012 — Third-Party Auth

 CARRIED-OVER IDEAS ([N]/[TOTAL] — grouped by origin; recency filter: last 2 sprints or 14 days)
  retro/
    IDEA-042 — Add request tracing headers (retro/sprint-005)
    IDEA-043 — Reduce test flakiness in CI (retro/sprint-005)
  execute/
    IDEA-044 — Evaluate argon2id vs bcrypt (execute/sprint-006, from T012)
  review-gap/
    IDEA-045 — Swallowed exception in logging wrapper (review-gap/sprint-006, auth.ts:87)
  + 3 more — see /ship-discuss triage for full list

 INCOMPLETE FEATURES ([N])
  F008 — Email Notifications (in-progress, 3/5 tasks done)

 ⚠ PREVIOUSLY MARKED DONE WITHOUT EVIDENCE ([N]) — re-verify?
  T007 — Run E2E suite and fix findings (kind: operational, no verify_output)
    Last sprint: sprint-012. This is the silent-pass failure mode —
    the task was marked done but no command output was captured.

 ⚠ NEEDS ATTENTION ([N]) — from prior sprint escalation
  T007 — Run E2E suite and fix findings (kind: operational)
    Escalated: iteration_budget_exhausted (after 3 iterations, 4 patch tasks)
    Last 3 attempts:
      iter 1 — 3 findings, fixed (T007-p1a, T007-p1b, T007-p1c)
      iter 2 — 2 findings, fixed (T007-p2a, T007-p2b)
      iter 3 — 2 findings reappeared after fix — gave up
    Options: /ship-debug T007 | re-plan findings as tasks | accept with issues

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Disposition prompt

After display, AskUserQuestion: "Found [N] carry-over items from previous sprints. Include all in this sprint, pick specific items, or skip to new features? (all / pick / skip)"

- **all** → include all carry-over items, deduct their points from capacity before selecting new features
- **pick** → user selects which carry-over items to include
- **skip** → proceed to new features only (carry-over items stay for next sprint)

For bugs: create tasks from bug files (if not already decomposed). For blocked tasks: re-add to wave structure after verifying blocker is resolved. For retro items: run through a quick inline discuss (no full `/ship-discuss` — just confirm scope and create a task). For incomplete features: re-decompose remaining tasks only.
