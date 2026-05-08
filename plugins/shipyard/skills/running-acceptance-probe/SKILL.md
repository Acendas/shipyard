---
name: running-acceptance-probe
description: Use whenever Shipyard needs to verify that a task's wiring works end-to-end — orchestrator-side validation of a subagent's claimed probe pass, /ship-review demo-path verification, or any "does this actually run from a clean state" check. Runs the probe in a fresh shell, captures output verbatim, returns a pass/fail signal with evidence the caller can paste into commits or reports.
disable-model-invocation: true
---

# Running an Acceptance Probe

A probe is the smoke-test command that demonstrates a task's wiring works end-to-end — distinct from unit/integration tests, which assert behavior in isolation. The probe is the most important reliability artifact in Shipyard 2.0: it is the difference between "tests pass against a stub" and "the thing actually works."

## What Counts as an Acceptance Probe

A valid probe is a **single shell command** that:

1. **Exits 0 on success.** Non-zero exit means the wiring failed.
2. **Produces observable output** that demonstrates the change worked end-to-end. Empty output passing is rare and suspicious.
3. **Runs from a clean state** — no prerequisite session-only setup.
4. **Completes in a bounded time** — typically <60s, hard cap 5m.
5. **Is deterministic enough to run twice and get the same exit code.**

Examples of good probes (per task type):

| Task type | Probe shape |
|---|---|
| New API endpoint | `curl -fsS -X POST localhost:3000/api/users -d '{"name":"x"}' \| jq -e .id` |
| New CLI subcommand | `node bin/mytool.mjs <new-subcommand> --help \| grep -q "<expected text>"` |
| Library function | `node -e 'const m = require("./dist/index.js"); if (!m.newFn) process.exit(1); console.log(m.newFn(42))'` |
| Migration | `psql -c "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='new_col'" \| grep -q new_col` |
| Refactor (no behavior change) | `npm run build && npm test -- --testPathPattern=touched-module` |
| Frontend feature | a Playwright check, or `curl -fsS localhost:3000/the-new-page \| grep -q "<expected element>"` |

Examples of bad probes:

- `npm test` — that's a test suite, not a probe. Probes are *narrower*: they exercise this one feature's wiring.
- `echo done` — produces no observable evidence.
- `cat <known-fixture>.json` — doesn't exercise any new code.
- An interactive command that needs user input.
- A command that depends on state from earlier in the session.

The probe is authored alongside acceptance criteria (see `authoring-acceptance-probe`). This skill is about *running* one that already exists.

## Inputs

- `probe_command` — the shell command string. Must come from the task file's `acceptance_probe:` frontmatter.
- `cwd` — the directory to run the probe from (typically the worktree path or the working branch checkout).
- `timeout_seconds` — optional, default 60, max 300.
- `session_name` — optional logcap session label (e.g., `T-042-probe`); see `## Output Capture`.

## How to Run It

The orchestrator runs the probe via the `Bash` tool with **`run_in_background: false`** and a **timeout**:

```
Bash(
  command: <probe_command>,
  description: "Run acceptance probe for {task_id}",
  timeout: <timeout_seconds * 1000>
)
```

Capture the full output (stdout + stderr) and the exit code from the Bash tool's return.

**Run in a fresh shell.** The Bash tool already does this — each invocation spawns its own shell. Do not chain probes with `;` or `&&` to other setup commands; the probe must be self-contained. If setup is needed, that's a problem with the probe — fix the probe, not the runner.

**Capture once, do not re-run.** Re-running the probe to "double-check" wastes tokens and risks flaky-test syndrome (the second run passes, you assume the first was a flake, you ship a real bug). One run, one exit code, one verdict.

## Output Shape

After running, return this structure to the caller:

```
{
  "exit_code": <integer>,
  "output_tail": "<last 20 lines, verbatim, newline-joined>",
  "duration_ms": <integer>,
  "timed_out": <boolean>,
  "verdict": "PASS" | "FAIL" | "TIMEOUT" | "ERROR"
}
```

Verdict mapping:

- **PASS** — `exit_code == 0` and `output_tail` is non-empty.
- **FAIL** — `exit_code != 0`.
- **TIMEOUT** — Bash tool reported the timeout. Treated as FAIL but distinguished so the caller can re-author the probe (a probe that times out is poorly authored).
- **ERROR** — couldn't even run (command not found, etc.). Distinguished from FAIL so the caller knows to fix the probe definition rather than the implementation.

The caller (`dispatching-task-loop` orchestrator-side, `/ship-review`, etc.) decides what to do with each verdict.

## Output Capture

By default, the probe's output is captured by the Bash tool's return value. For wave-level retrospectives or `/ship-review` audit trails, the orchestrator can also tee output to a file by wrapping the probe:

```
<probe_command> 2>&1 | tee <SHIPYARD_DATA>/captures/{session_name}/{task_id}-probe.log
```

This is optional. The structured return above is the primary contract; the file capture is for human review later. The `shipyard-logcap` CLI offers richer rotation/grouping, but a plain `tee` is sufficient for the probe-run case.

## Probe Failure Interpretation

A probe FAIL is a **different signal** from a test FAIL:

| Signal | Means | Caller's response |
|---|---|---|
| Test FAIL, probe not run | Unit/integration test caught a bug | Fix implementation, re-test |
| Tests PASS, probe FAIL | Tests passed against incomplete or stubbed code | Re-dispatch subagent — wiring is broken (the most important case this whole architecture exists to catch) |
| Tests FAIL, probe FAIL | Implementation is broken at multiple levels | Fix from the test outward, then re-probe |
| Tests PASS, probe PASS | Real done | Mark `done`, commit, advance |
| Probe TIMEOUT | Probe is poorly authored, OR the implementation hangs | Inspect; if hang, fix; if probe is too broad, narrow it |
| Probe ERROR | Probe definition is wrong | Fix the probe in the task frontmatter; re-run |

The middle row — **tests pass, probe fails** — is the one that justifies probes existing at all. It's the false-completion vector that pure unit-test discipline cannot catch.

## When to Run a Probe

1. **After a subagent returns `STATUS: COMPLETE`** in `dispatching-task-loop` — the orchestrator MUST verify the subagent's claimed `PROBE_EXIT: 0` by running the probe itself, in the orchestrator session, against the subagent's commit. This catches subagents that fabricate probe output.
2. **At `/ship-review`** — the reviewer runs each task's probe (or the wave-level demo-path probe, if defined) before approving. No probe pass = no approval.
3. **Manually**, when a user wants to confirm a feature still works after a merge or a config change — the probe is durable, not session-bound.

## Probe Hygiene

Probes are first-class artifacts. They are authored once (`authoring-acceptance-probe`) and re-run on demand. Some hygiene rules:

- **Probes live in the task file's frontmatter** (`acceptance_probe:`), not in scripts or fixtures. They are the spec's smoke contract.
- **Probes are versioned with the task.** When the task's behavior changes, the probe must change.
- **Probes are not load tests.** A probe runs once and proves wiring; performance is a separate concern.
- **Probes are not security tests.** Security is `/ship-review`'s scanner pass.

## What This Skill Does NOT Do

- It does not author probes. See `authoring-acceptance-probe` (built during `/ship-sprint` planning).
- It does not decide whether to re-dispatch on failure. See `dispatching-task-loop` for the orchestrator-side action rules.
- It does not validate probe quality (whether the probe actually exercises the wiring). That's a `/ship-review` concern, surfaced via `anti-stub-scan` for stub-shaped probes.

## Bottom Line

- One command, one shell, one exit code.
- PASS only if exit 0 AND output tail non-empty.
- TIMEOUT and ERROR are distinct from FAIL — they tell the caller to fix the probe, not the implementation.
- The "tests pass, probe fails" case is the whole point. Catch it.
