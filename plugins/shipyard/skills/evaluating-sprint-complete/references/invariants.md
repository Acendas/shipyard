# Sprint-Complete Invariants — Detailed Reference

Seven invariants, each evaluated as PASS or FAIL. Unlike wave-completion (which has RECOVERABLE plus retry), sprint-complete halts cleanly on any FAIL — recovery is the user's call at this layer.

The deterministic primitives backing these checks live in the `shipyard-context` CLI — use them instead of inline git/jq prose so the predicate is script-verifiable.

## Invariant 1 — Every task has a commit_sha that exists in git

**What it checks.** For each task ID in this sprint (read from SPRINT.md's wave structure), find its `task_dispatch_returned` event with `status="complete"`, extract `commit_sha`, and confirm it's reachable from `sprint_head_sha` AND in `sprint_base_sha..sprint_head_sha`.

**Primitive.**

```text
shipyard-context scan-events --tail 1000 task_dispatch_returned
shipyard-context check-commit-exists <sha>     # per sha
git merge-base --is-ancestor <sha> <sprint_head_sha>
! git merge-base --is-ancestor <sha> <sprint_base_sha>
```

**Verdict.** PASS = every task in the sprint has a verified commit in range. FAIL = any task lacks a commit or the commit is outside the sprint's range.

## Invariant 2 — Sprint-boundary verify-probe exits 0 with non-empty capture

**What it checks.** `sprint_verify_exit_code == 0` AND `sprint_verify_capture` is on disk AND its last 50 lines contain a real verdict (not just startup noise).

**Primitive.** Direct Read on the capture file plus the exit-code parameter. No CLI primitive needed.

**Verdict.** PASS = exit 0 + non-empty + verdict visible. FAIL = non-zero OR empty.

## Invariant 3 — Every linked spec item is marked done

**What it checks.** For each `feature_id` in SPRINT.md, the feature file's frontmatter has `status: done` (or `status: released` if /ship-review has already advanced it). Same for any directly-linked AC entries.

**Primitive.** Read the feature files; parse YAML frontmatter.

**Verdict.** PASS = every linked spec item is in a terminal-done state. FAIL = one or more `in-progress` or `approved`.

## Invariant 4 — Spec coverage shows no orphan AC for the sprint slice

**What it checks.** Every acceptance criterion in every linked feature maps to either a passing test (via the existing `acceptance_probe` / `demo_probe` linkage) or an implementation marker in the diff. Orphan AC = no mapping.

**Primitive.** Read feature spec files and the diff `sprint_base_sha..sprint_head_sha`. For each AC, search the diff and the linked task files for either:

- An `acceptance_probe:` field on a task that references this AC, AND a passing run of that probe in the event log (`task_loop_iteration` with `probe_exit: 0`), OR
- A test file in the diff whose path matches the AC's `tests:` field, OR
- An implementation file in the diff containing a comment-marker like `// AC-<id>` or `# AC-<id>`.

If none of these exist, the AC is an orphan.

**Verdict.** PASS = zero orphan AC. FAIL = one or more orphans (report them with their feature ID).

## Invariant 5 — No silent-failure markers in the sprint event-log window

**What it checks.** No events of these types in the sprint's window:

- `silent_failure`
- `loop_detected`
- `operational_task_bogus_pass`
- `anti_stub_finding`
- `wave_check_escalated` (any from any wave in the sprint)

**Primitive.**

```text
shipyard-context scan-events --tail 2000 silent_failure loop_detected operational_task_bogus_pass anti_stub_finding wave_check_escalated
```

Filter to events whose timestamp is after the sprint's `started_at` (from SPRINT.md frontmatter).

**Verdict.** PASS = none of these in the window. FAIL = one or more present.

## Invariant 6 — No uncommitted state across any builder worktree

**What it checks.** No `shipyard/wt-*` worktree carries uncommitted state at sprint completion. By this point all should have been merged back and pruned during wave-boundary cleanup; any survivor with dirty state is a leak.

**Primitive.**

```text
shipyard-context check-dirty-worktrees
# stdout = one absolute path per dirty shipyard/wt-* worktree, empty if all clean
```

**Verdict.** PASS = no leftover worktrees, or all leftover worktrees are clean. FAIL = one or more dirty.

## Invariant 7 — Code-review scanners report no must-fix findings

**What it checks.** Read `review_verdict_path` if provided. The verdict's `recommendation:` field must be `approve` or `issues` (issues tracked as IDEAs/B-CR/follow-ups count as accepted). `recommendation: changes` is a FAIL.

**Special case at first invocation.** `/ship-execute` Step 5 calls this skill BEFORE running `/ship-review`. At that point `review_verdict_path` is null, and this invariant is expected to FAIL — that's the gate's purpose: surface invariants 1–6 BEFORE the user spends review time on a sprint that's structurally incomplete. After `/ship-review` has run, re-invoke the predicate with the verdict path supplied.

**Verdict.** PASS = verdict recommends approve or issues. FAIL = recommends changes, OR `review_verdict_path` is null (the latter is only "FAIL" at the post-review invocation; the pre-review call expects this).

## Aggregation

Sprint-complete does NOT do recovery. The aggregation is simple:

```text
All seven PASS → STATUS: COMPLETE
Any FAIL       → STATUS: INCOMPLETE with the failing-invariant list
```

The user (not the skill) decides next action on FAIL — re-dispatch a task, fix a missing AC, re-run review.
