# Sprint-Complete Invariants — Detailed Reference

Eight invariants, each evaluated as PASS or FAIL. Unlike wave-completion (which has RECOVERABLE plus retry), sprint-complete halts cleanly on any FAIL — recovery is the user's call at this layer.

The deterministic primitives backing these checks live in the `shipyard-context` CLI — use them instead of inline git/jq prose so the predicate is script-verifiable.

## Invariant 1 — Every completed task has integration evidence

**What it checks.** For each task ID in this sprint (read from SPRINT.md's wave structure), find its `task_dispatch_returned` event. `status="complete"` tasks must have a `commit_sha` that exists, and the sprint's wave-integration primitive must prove all live `shipyard/wt-*` branches are merged and returned commits are still reachable through the working branch or `shipyard/keep-*` anchors. Do **not** require the original returned SHA to be an ancestor of `sprint_head_sha`: successful worktree rebases legitimately rewrite that SHA.

**Primitive.**

```text
shipyard-context scan-events --tail 1000 task_dispatch_returned
shipyard-context check-commit-exists <sha>     # per sha
shipyard-data verify-wave-integrated
```

**Verdict.** PASS = every completed task in the sprint has verified integration/reachability evidence. Parked tasks require `task_dispatch_returned status=blocked` or `task_blocked` evidence. FAIL = any task lacks evidence, any complete task lacks a valid commit, or the integration primitive reports unmerged/dangling work.

## Invariant 2 — Sprint-boundary verify-probe exits 0 with non-empty capture

**What it checks.** `sprint_verify_exit_code == 0` AND `sprint_verify_capture` is on disk AND its last 50 lines contain a real verdict (not just startup noise).

**Primitive.** Direct Read on the capture file plus the exit-code parameter. No CLI primitive needed.

**Verdict.** PASS = exit 0 + non-empty + verdict visible. FAIL = non-zero OR empty.

## Invariant 3 — Every linked spec item is marked done

**What it checks.** For each `feature_id` in SPRINT.md, the feature file's frontmatter has the lifecycle state expected by the caller. During the pre-review `/ship-execute` call, features remain `status: in-progress` because `/ship-review` owns the transition to `done`. During post-review/release verification, features must be `done` or `released`. Same for any directly-linked AC entries.

**Primitive.** Read the feature files; parse YAML frontmatter.

**Verdict.** PASS = every linked spec item is in a terminal-done state. FAIL = one or more `in-progress` or `approved`.

## Invariant 4 — Spec coverage shows no orphan AC for the sprint slice

**What it checks.** Every `@AC-<n>`-tagged acceptance criterion in every linked feature has an `AC-<n>` marker (a `// AC-<n>` / `# AC-<n>` code marker, or the `@AC-<n>` tag copied into a test) somewhere in the sprint diff. A tagged AC with no marker is an orphan. This is the single sprint invariant that structurally resists a deferral-heavy sprint passing, so it is CLI-backed (not prose-adjudicated) — the deferral-bias review flagged it as previously the softest-enforced invariant with no primitive.

**Primitive (deterministic).**

```text
shipyard-data verify-ac-coverage --base <sprint_base_sha> --head <sprint_head_sha>
# exit 0 = no orphans; exit 3 = orphan AC(s) (listed) when execution.enforce_ac_coverage is true.
# Features with NO @AC-<n> tags print WARN and never fail — the migration-safety valve.
```

Acceptance criteria get stable `@AC-<n>` ids from `shipyard-data feature assign-ac-ids <FID>` (run at authoring and normalized at sprint-plan time); builders emit `// AC-<n>` markers for the criteria their task implements. A feature that has never had ids assigned is advisory only, so this gate cannot false-block a project mid-adoption.

**Verdict.** PASS = `verify-ac-coverage` exits 0. FAIL = exit 3 (orphans listed with their feature ID). Advisory-only (WARN, PASS) when `execution.enforce_ac_coverage` is false or the feature has no tagged ACs.

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

**What it checks.** No `shipyard/wt-*` worktree carries uncommitted state at sprint completion. By this point all should have been merged back and pruned during wave-boundary cleanup; any survivor with dirty state is a leak. **Isolation off (in-place sprint):** there are no `shipyard/wt-*` worktrees, so also assert the shared main working tree is clean — a failed in-place builder's residue lives there, invisible to the wt-scoped check.

**Primitive.**

```text
shipyard-context check-dirty-worktrees
# stdout = one absolute path per dirty shipyard/wt-* worktree, empty if all clean
shipyard-context check-dirty-tree
# isolation-off only: porcelain of the main working tree, empty if clean
```

**Verdict.** PASS = no leftover worktrees, all leftover worktrees clean, AND (isolation off) the main working tree is clean. FAIL = one or more dirty.

## Invariant 7 — Code-review scanners report no must-fix findings

**What it checks.** Read `review_verdict_path` if provided. The verdict's `recommendation:` field must be `approve` or `issues` (issues tracked as IDEAs/B-CR/follow-ups count as accepted). `recommendation: changes` is a FAIL.

**Special case at first invocation.** `/ship-execute` Step 5 calls this skill BEFORE running `/ship-review`. At that point `review_verdict_path` is null, and this invariant is SKIPPED — not failed. The pre-review call surfaces invariants 1–6 and 8 BEFORE the user spends review time on a sprint that's structurally incomplete. After `/ship-review` has run, re-invoke the predicate with the verdict path supplied.

**Verdict.** PASS = verdict recommends approve or issues. SKIP = `review_verdict_path` is null on the pre-review invocation. FAIL = recommends changes, or `review_verdict_path` is null on a post-review invocation.

## Invariant 8 — Every shipped feature's `user_flow_probe` was proven in the sprint window

**What it checks.** This is the cross-task proof that the feature works *for a user* — added in v2.6.0 after the confedit/sprint-001 incident demonstrated that "all unit tests pass + all per-task probes pass" does NOT imply "the feature's user-facing flow works." Per-task probes test isolated wiring; the per-feature `user_flow_probe` tests the integrated flow (e.g., "load schema → fill form → see validation → download data" rather than just "the download component renders").

**Proof comes in two forms, and they are equally valid.** A machine verdict (an `auto` probe's exit code) and a human verdict (an `assisted`/`manual` probe confirmed by a person) both satisfy this invariant. Accepting only the machine form is what forced every on-device or hand-checked flow through `skip-with-reason` — i.e. filed the *strongest* available evidence as an ABSENCE of proof.

For each `feature_id` in SPRINT.md, read the feature file's `user_flow_probe:` (legacy scalar `demo_probe:` reads as `kind: auto`):

- **Absent / null** → FAIL with `missing-user_flow_probe` for the feature.
- **`skip-with-reason` + populated `user_flow_probe_skip_reason`** → PASS-with-warning. This now means *no proof of any kind exists*; a hand-checked flow is `kind: manual`, which takes the confirmation path below. The warning is surfaced in the verdict but doesn't block.
- **`kind: auto`** → PASS iff the event log has `acceptance_probe_completed feature=<feature_id> probe_type=demo exit_code=0` with `ts >= sprint.started_at`.
- **`kind: assisted` or `manual`** → PASS iff the event log has `user_flow_probe_confirmed feature=<feature_id> verdict=pass` with `ts >= sprint.started_at` AND whose `commit` is an ancestor of `sprint_head_sha` (`git merge-base --is-ancestor <commit> <sprint_head_sha>`). The ancestry check is what stops a confirmation against work that was later rebased away or reverted from counting as proof of the shipped tree.

**Primitives.**

```text
shipyard-context scan-events --tail 2000 acceptance_probe_completed
shipyard-context scan-events --tail 2000 user_flow_probe_confirmed
```

Filter the first by `feature`, `probe_type=demo`, `exit_code=0`; the second by `feature`, `verdict=pass`. Both within the sprint window.

**Verdict.** PASS = every feature has a passing probe by either form (or explicit skip-with-reason). FAIL = one or more features missing proof.

**Why this is sprint-complete, not just review.** Before v2.6.0, demo_probe ran only in `/ship-review` Stage 4.8 — AFTER `/ship-execute` had already flipped SPRINT.md to `status: completed`. So a sprint with broken cross-task wiring could be declared complete by execute, and the user had to wait for review to discover the breakage. Moving demo_probe into the sprint-complete predicate inverts the sequence: execute halts at `sprint_demo_probes` stage on probe failure, SPRINT.md stays `in-progress` until the wiring works, and the "Sprint complete" report becomes a real claim instead of a wishful one.

## Aggregation

Sprint-complete does NOT do recovery. The aggregation is simple:

```text
All eight PASS → STATUS: COMPLETE
Any FAIL       → STATUS: INCOMPLETE with the failing-invariant list
```

The user (not the skill) decides next action on FAIL — re-dispatch a task, fix a missing AC, author a missing `user_flow_probe`, re-run review.
