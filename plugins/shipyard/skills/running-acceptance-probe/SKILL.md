---
name: running-acceptance-probe
description: Run a task's acceptance probe and capture output.
disable-model-invocation: true
---

# Running an Acceptance Probe

A probe is the smoke-test command that demonstrates a task's wiring works end-to-end — distinct from unit/integration tests, which assert behavior in isolation. It is the difference between "tests pass against a stub" and "the thing actually works."

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

- `probe_command` — the shell command string. Must come from the step file's `acceptance_probe:` frontmatter.
- `cwd` — the directory to run the probe from (typically the worktree path or the working branch checkout).
- `timeout_seconds` — optional, default 60, max 300.
- `session_name` — optional logcap session label (e.g., `T-042-probe`); see `How to Run It`.

## How to Run It

The orchestrator runs the probe via the `Bash` tool with **`run_in_background: false`** and a **timeout**. The command itself is wrapped in `shipyard-logcap` on the first run:

```
Bash(
  command: "shipyard-logcap run {session_name-or-task_id}-probe -- <probe_command>",
  description: "Run acceptance probe for {task_id}",
  timeout: <timeout_seconds * 1000>
)
```

Capture the full output (stdout + stderr) in the logcap file and the exit code from the Bash tool's return. Resolve the durable file with `shipyard-logcap path {session_name-or-task_id}-probe`. Never use raw `tee` or run the probe bare first: the logcap file is the audit trail and recovery surface when the first run fails.

**Run in a fresh shell.** The Bash tool already does this — each invocation spawns its own shell. Do not chain probes with `;` or `&&` to other setup commands; the probe must be self-contained. If setup is needed, that's a problem with the probe — fix the probe, not the runner.

**Capture once, do not re-run.** Re-running the probe to "double-check" wastes tokens and risks flaky-test syndrome (the second run passes, you assume the first was a flake, you ship a real bug). One logcap run, one exit code, one verdict. If the output needs a different slice, use `shipyard-logcap grep/view/tail` against the existing capture.

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

A probe FAIL while tests pass means the wiring is broken (tests passed against incomplete or stubbed code): re-dispatch. ERROR means fix the probe; TIMEOUT means the probe is poorly authored OR the implementation hangs (inspect; if a hang, fix the implementation, otherwise narrow the probe).

## When to Run a Probe

1. **Inside `dispatching-task-loop` subagents** — the builder runs the task's `acceptance_probe:` in its own worktree before recording `STATUS: COMPLETE`. The orchestrator does **not** re-run that probe during task-loop gating; it verifies the structured captured result (`PROBE_EXIT: 0`, non-empty output tail, commit exists, anti-stub scan). Pre-merge worktree state is not reliably reconstructable in the orchestrator session, so the captured exit code is the authoritative task-loop signal.
2. **At `/ship-review` or other post-merge checks** — the reviewer may run each task's probe again against the merged tree when the stage explicitly calls for durable proof. No probe pass = no approval.
3. **Manually**, when a user wants to confirm a feature still works after a merge or a config change — the probe is durable, not session-bound.

## Probe Hygiene

Probes are first-class artifacts. They are authored once (`authoring-acceptance-probe`) and re-run on demand. Some hygiene rules:

- **Probes live in the step file's frontmatter** (`acceptance_probe:`), not in scripts or fixtures. They are the spec's smoke contract.
- **Probes are versioned with the task.** When the task's behavior changes, the probe must change.

This skill does not author probes (`authoring-acceptance-probe`), choose redispatch on failure (`dispatching-task-loop`), or judge probe quality (`/ship-review`).
