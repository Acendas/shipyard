# REFACTOR Loop

Full algorithm for the orchestrator-driven test→fix loop that runs at every wave boundary after the initial wave-refactor builder returns. This is the single source of truth for loop behavior — ship-execute/SKILL.md points here.

## Why this exists

The initial wave-refactor builder (iteration 1) runs REFACTOR + tests + MUTATE in one pass. If tests fail it cannot self-retry beyond its maxTurns budget. This loop gives the orchestrator up to 3 total attempts — each with a fresh builder context and full failure context from the previous iteration — before logging the gap and proceeding. It also replaces the old "spawn one fixer then AskUserQuestion" path, giving consistent behavior whether failure comes from REFACTOR or from subsequent test-runner measurement.

## Inputs

- `wave_files` — list of source + test files from ALL wave tasks' Technical Notes
- `failing_prev` — set of failing test names from the previous iteration (empty on first check)
- `iteration` — current iteration number (1 after the initial builder returns)
- `main_branch` — from `<SHIPYARD_DATA>/config.md` `git.main_branch`

## Full Loop Algorithm

```
STATE:
  iteration      = 1              # the initial wave-refactor builder IS iteration 1
  failing_prev   = {}             # test names from N-1 (empty first check)
  failing_curr   = {}             # test names from latest test-runner run
  loop_history   = []             # [{iteration, failing_tests, status}]

──────────────────────────────────────────────────────────────
STEP 1  — measure state after the initial wave-refactor builder
──────────────────────────────────────────────────────────────

If the initial wave-refactor builder exited without evidence of running tests
(no logcap output at wave-N-refactor, no structured result in its reply):
  Spawn a measurement-only test-runner (see §Measurement Runner below).
  Do NOT count this measurement run as a loop iteration.

Spawn the extended test-runner (see §Extended Test-Runner Contract):
  scope:   wave_files
  logcap:  wave-N-refactor (same session as what the builder used internally)
  
failing_curr = result.failing_tests   # [] if status: pass
loop_history.append({iteration: 1, failing_tests: failing_curr, status: result.status})

If failing_curr is empty AND result.status == pass:
  emit: refactor_loop_success  wave=N  iterations_used=1
  → proceed to VERIFY (no loop needed)

emit: refactor_loop_started  wave=N  failing_count=len(failing_curr)

──────────────────────────────────────────────────────────────
STEP 2+  — fix-focused iterations (2 and 3)
──────────────────────────────────────────────────────────────

For iteration in [2, 3]:

  STUCK CHECK (applies from iteration 3 onward — no previous for iter 2):
    If iteration >= 3 AND failing_curr == failing_prev:
      # Same test name set: this iteration made zero progress
      emit: refactor_loop_stuck  wave=N  iteration=iteration  tests=failing_curr
      Write PROGRESS.md (see §PROGRESS.md schema)
      break → proceed to VERIFY

  failing_prev = failing_curr

  git_log = run: git log --oneline $(git merge-base HEAD <main_branch>)..HEAD

  Spawn shipyard-builder (fix-focused — NO isolation: worktree, runs on working branch):
    subagent_type: shipyard:shipyard-builder
    prompt: |
      Mode: wave-refactor
      Iteration: {iteration}
      Wave: {N}
      Working branch: {branch from SPRINT.md}
      Failing tests:
        {bulleted list of failing_curr test names}
      Previous attempts git log:
        {git_log}
      Data dir: {literal SHIPYARD_DATA path}

      Fix the failing tests listed above. Focus REFACTOR on those tests only.
      Skip MUTATE — it already ran in iteration 1.
      Run logcap: wave-{N}-refactor-iter-{iteration}
      COMMIT any changes before returning.

  Spawn the extended test-runner:
    scope:   wave_files
    logcap:  wave-N-refactor-iter-{iteration}

  failing_curr = result.failing_tests
  loop_history.append({iteration: iteration, failing_tests: failing_curr, status: result.status})

  If failing_curr is empty AND result.status == pass:
    emit: refactor_loop_success  wave=N  iterations_used=iteration
    break → proceed to VERIFY

  If iteration < 3:
    emit: refactor_loop_progress
          wave=N  iteration=iteration
          prev_count=len(failing_prev)  curr_count=len(failing_curr)

──────────────────────────────────────────────────────────────
AFTER LOOP
──────────────────────────────────────────────────────────────

If failing_curr is non-empty (cap hit or broke out stuck):
  emit: refactor_loop_exhausted
        wave=N  iterations_used=len(loop_history)  remaining_failing_count=len(failing_curr)
  Write PROGRESS.md deviation (see §PROGRESS.md Schema)
  # REFACTOR failure is not a wave blocker — proceed regardless

→ Continue to VERIFY (shipyard-review-spec)
```

---

## Extended Test-Runner Contract

Spawn `shipyard-test-runner` with the wave-scoped command. The orchestrator requires the **Structured Result** section from the test-runner's reply to drive the loop. This section is added by the extended test-runner contract in `agents/shipyard-test-runner.md`.

```
Run scoped tests for wave [N] REFACTOR loop iteration [M].
Scope: [wave_files list]
Command: shipyard-logcap run wave-[N]-refactor[-iter-M] -- <SCOPED_COMMAND> [paths]
Return the structured summary including the Structured Result block.
```

Fall back order for the test command (same as existing wave boundary logic):
1. `test_commands.scoped` + wave file paths
2. `test_commands.unit`
3. `test_commands.integration`

**Parsing the Structured Result** — extract the `## Structured Result` block from the test-runner's return message. Read `status`, `failing_tests`, and `build_error` fields from it. If the block is absent (test-runner did not produce it), treat as `status: fail` with `failing_tests: ["<structured-result-missing — see logcap>"]` — this prevents stuck detection from firing but still counts the iteration.

---

## Measurement-Only Runner

When the initial wave-refactor builder exits without running tests, spawn a lightweight measurement subagent before starting the iteration count:

```
Spawn shipyard-test-runner:
  scope:   wave_files
  logcap:  wave-N-refactor-measure
  prompt:  "Run scoped tests and return the Structured Result block only.
            Command: shipyard-logcap run wave-[N]-refactor-measure -- <SCOPED_COMMAND>
            Return only the structured summary — no explanation needed."
```

This does NOT consume a loop iteration. The result seeds `failing_curr` for the stuck-detection comparison at iteration 2.

---

## Stuck Detection

**Signal:** `failing_curr == failing_prev` — the exact set of failing test name strings is identical to the previous iteration. This means the builder made zero progress on test failures this iteration.

**Why test names, not error messages:** error messages contain line numbers, stack traces, and timing data that vary between runs even for identical failures. Test names are stable.

**Build failures:** The test-runner returns `status: build_error` with `build_error: "<first 200 chars of error>"` and `failing_tests: []`. The loop treats this identically to a test failure — the spawned builder fixes the build error. Stuck detection for build errors: two consecutive `status: build_error` iterations with the same `build_error` prefix (first 100 chars) → stuck. Different build errors → not stuck (progress).

**Progressive partial progress:**
- iter 1: {A, B, C, D, E} → iter 2: {A, B} (progress, failing_prev={A,B,C,D,E} → failing_curr={A,B})
- iter 3: {A, B} → stuck (failing_curr == failing_prev == {A, B}), break

---

## PROGRESS.md Schema

Write this block when the loop ends without all tests passing (cap hit or stuck). Do NOT write anything on success.

**1. Deviations table row** (append to the existing `## Deviations` table):
```
| Wave N | REFACTOR | loop exhausted — 2 tests still failing | 3 iter, stuck after iter 3 |
```

**2. Detail section** (append below the deviations table):
```markdown
### Wave N REFACTOR Loop (exhausted | stuck at iter M)
| Iter | Result         | Failing Tests                                        |
|------|----------------|------------------------------------------------------|
| 1    | 5 failing      | TestAuthRefresh, TestTokenExpiry, TestLogin, ...     |
| 2    | 2 failing      | TestAuthRefresh, TestTokenExpiry                     |
| 3    | 2 failing (stuck) | TestAuthRefresh, TestTokenExpiry                  |

Remaining failures will surface in /ship-review.
```

If the loop ends because of stuck detection mid-cap (e.g., stuck at iteration 2), label it `stuck at iter 2` and note what iteration it stopped at.

---

## Pause Mid-Loop

If the user says "pause" while the loop is running (between builder spawns), add `refactor_loop` to HANDOFF.md frontmatter:

```yaml
refactor_loop:
  wave: 2
  current_iteration: 2
  failing_tests: ["TestAuthRefresh", "TestTokenExpiry"]
  iteration_history:
    - iteration: 1
      failing_tests: ["TestAuthRefresh", "TestTokenExpiry", "TestLogin"]
    - iteration: 2
      failing_tests: ["TestAuthRefresh", "TestTokenExpiry"]
```

**On resume:** if `refactor_loop` is present in HANDOFF.md, reconstruct the loop state from it. Continue from `current_iteration + 1` with `failing_prev` = the last entry in `iteration_history`. Do NOT restart the loop from iteration 1 — that would re-run REFACTOR on code that was already partially fixed.

If `current_iteration` is already 3 when resuming (cap was hit but user paused before the PROGRESS.md write completed): write the deviation entry and proceed to VERIFY.

---

## Shipyard Events

| Event | When | Key Fields |
|-------|------|------------|
| `refactor_loop_started` | First test failure detected after iter 1 | `wave`, `failing_count` |
| `refactor_loop_progress` | Iter 2/3 completes with fewer failures | `wave`, `iteration`, `prev_count`, `curr_count` |
| `refactor_loop_stuck` | Same failing tests as previous iteration | `wave`, `iteration`, `failing_tests` |
| `refactor_loop_exhausted` | Cap hit, tests still failing | `wave`, `iterations_used`, `remaining_failing_count` |
| `refactor_loop_success` | All tests pass in iter 2 or 3 | `wave`, `iterations_used` |

Emit via the standard `shipyard-data events emit <type> [k=v ...]` CLI.

---

## Fast Mode

Skip the entire REFACTOR loop in `--fast` mode. No tests run at the wave boundary. Proceed directly to VERIFY after the initial wave-refactor builder returns.
