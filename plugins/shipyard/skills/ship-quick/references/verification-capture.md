# Verification Capture — ship-quick

> Companion to `skills/ship-execute/references/live-capture.md`. That file teaches the capture primitive end-to-end; this file distills the subset a quick task needs and documents the specific failure modes that cost a customer their audit trail on Q-002. Read both if you have time; read this one first if you're executing a `/ship-quick`.

## The principle, restated for quick tasks

Quick tasks re-run the suite multiple times in one session (bucket a runs scoped + full; bucket b runs baseline + post-refactor). Each run costs tokens, wall-clock time, and device minutes. If you pipe a live stream into a filter and realize later you needed a different signal, the unfiltered stream is gone and your only option is to re-run.

`shipyard-logcap run` tees every byte of stdout+stderr to a rotating file on disk **and** to the parent's stdout, unchanged. You then query the on-disk file as many times as you want with `shipyard-logcap tail` and `shipyard-logcap grep`. Capture once, analyse many times.

## The run → query loop

For every bucket (a/b/c) phase the SKILL body names — `-red`, `-green`, `-refactor`, `-mutate`, `-full-suite`, `-baseline`, `-post-refactor` — the flow is the same:

1. **Run synchronously.** `shipyard-logcap run <Q-NNN>-<phase> -- <command>`. Do **not** set `run_in_background: true` on the Bash tool call. Do **not** pipe `shipyard-logcap run` through `grep`, `tail`, `head`, or any other filter. The capture file already has every byte you need; the parent stdout is just a convenience echo.
2. **Read the banner.** The one-line startup banner on stderr prints the capture file path and bounds. That is your "did this work?" signal — not the filtered tail of a shell pipeline.
3. **Query the capture.** After the command exits (or in a second Bash call while it's still running), use:
   - `shipyard-logcap tail <Q-NNN>-<phase> --filter "FAILED|BUILD|tests completed"` for the last N lines matching a regex.
   - `shipyard-logcap grep <Q-NNN>-<phase> "<pattern>" --context 10` for post-hoc search with surrounding context.
   - `shipyard-logcap tail <Q-NNN>-<phase> --follow` if you want a live stream while the command is still running from another call.
   - `shipyard-logcap path <Q-NNN>-<phase>` to print the absolute file path.
4. **Never re-run to re-filter.** If the first query surfaced something confusing, the next move is another `grep` with a wider pattern against the **same** capture. Re-running the command re-rolls the dice: the test may hang differently, the device may be in a different state, the daemon may be warmer or colder.

## Anti-patterns — what not to do

### ❌ Pipe `run` through `grep` and `tail`

`shipyard-logcap run Q-NNN-phase -- <command> | grep -E "..." | tail -10`

Two stacked buffering traps:

- `tail -N` emits nothing until stdin closes. It must read the whole stream to know which lines are the last N. While the wrapped command is still running, tail holds everything and emits zero bytes.
- `grep` without `--line-buffered` is block-buffered over a pipe; it won't flush matches to tail until a ~4KB block fills.

Result: the on-disk capture fills normally, but the pipeline to the terminal produces zero live output. If you backgrounded the Bash call and polled it, you see `(No output)` and incorrectly conclude "capture is broken" or "backgrounding is broken."

**Correct form:** `shipyard-logcap run Q-NNN-phase -- <command>` with nothing after. Query the capture afterwards with `shipyard-logcap tail` / `shipyard-logcap grep`.

### ❌ Background the logcap run and poll its output

`run_in_background: true` on the Bash tool call, then `cat` the task output file, or re-read via `BashOutput`, to watch progress.

Two problems:

- The Bash tool applies its own timeout (2 minutes by default) to backgrounded tasks. If your suite runs longer than the timeout, the harness kills the pipeline with `SIGTERM`, which propagates through logcap to the wrapped command. You get a **0-byte capture file** and a non-zero exit code, and it looks like "logcap failed."
- Claude Code's backgrounded-Bash output file is a harness implementation detail. `cat`-ing a guessed path at `/private/tmp/claude-501/.../tasks/<id>.outputfile` is not the supported read surface. `BashOutput` is, but it reads the same buffered stream — same pipe-buffering traps apply.

**Correct form:** run logcap synchronously. If you need to watch progress while it runs, open a second Bash call and do `shipyard-logcap tail <Q-NNN>-<phase> --follow` against the on-disk file. If the suite is genuinely long enough that 2m is too short, raise the Bash tool's `timeout` parameter explicitly.

### ❌ Fall back to running the command bare when logcap "looks broken"

If a run surfaces unexpected behaviour — 0-byte file, non-zero exit, no output on the terminal — the temptation is to abandon logcap and run `./gradlew …` (or whatever) directly "to see what's really happening."

Do not do this. The capture file is the only thing preserving what happened on the run that already went wrong. Running the command bare:

- Loses the audit trail for the quick task's commit.
- Loses the ability to compare against prior phase captures (`-red` vs `-green`, `-baseline` vs `-post-refactor`).
- Re-rolls device/daemon/flake state, which may make the bug disappear or mutate.
- Almost never diagnoses the actual problem, because the problem was virtually never logcap itself.

**Correct form:** use the diagnosis flow in the next section before reaching for any fallback.

## When logcap appears to fail — diagnosis

`shipyard-logcap` is dumb I/O plumbing. It does not spawn background tasks, it has no internal timeout on `run`, and its exit code is the wrapped command's exit code (see `live-capture.md` "The contract"). When a run *looks* broken, the failure is almost always one layer above (the harness that invoked logcap) or one layer below (the wrapped command). It is essentially never logcap itself.

### Decoder: 0-byte capture file + non-zero exit

| Exit code | What it means | Likely cause | Remediation |
|---|---|---|---|
| 143 | `SIGTERM` (128 + 15) | Externally killed. Most common case: the Bash tool's backgrounded-task timeout fired. | Do not background `shipyard-logcap run`. If the suite is legitimately long, raise the Bash call's `timeout` instead. |
| 137 | `SIGKILL` (128 + 9) | OOM killer, `kill -9`, container OOM killer, or a user/harness `pkill -9`. | Check memory pressure and whether anything in the session ran `pkill`. |
| 144 | Signal 16 (macOS `SIGURG` / Linux `SIGSTKFLT`). Observed in practice when Claude Code's Bash tool kills a backgrounded pipeline on macOS. | Treat as "externally killed by the harness," same class as 143. | Same as 143 — stop backgrounding. |
| 124 | `timeout` coreutil fired (unlikely unless you wrapped `timeout` around logcap yourself). | Remove the outer `timeout` wrapper; `shipyard-logcap run` has no internal timeout and does not need one. | Let logcap run until the child exits. |
| non-zero, not in this table | The wrapped command itself exited non-zero before producing output, or crashed before flushing. | The problem is in the command, not logcap. | Proceed to "Recovery path" below. |

**Any of the signal-based exits above mean the wrapped command was killed before it could flush.** The 0-byte capture is a direct consequence of being killed early, not evidence that logcap is broken.

### Recovery path (before reaching for any fallback)

In order, from cheapest to most invasive:

1. `shipyard-logcap list` — does the capture directory contain your `<Q-NNN>-<phase>` at all? If not, you may be looking at the wrong project hash; run `shipyard-logcap probe` and compare against where you expected captures to land.
2. `shipyard-logcap path <Q-NNN>-<phase>` — print the absolute capture path. Read that file directly with `Read`. Even a partial capture (a few hundred bytes of daemon startup) tells you whether the command got far enough to emit stdout.
3. `shipyard-logcap tail <Q-NNN>-<phase>` — confirms what the tee wrote. If the output is non-empty, you have signal; work with it.
4. If all three show empty, the child was killed before writing a single byte. That is a fact about the child or the harness, **not** about logcap. Investigate in this order:
   - Did you background the Bash call? (Check whether `run_in_background: true` was set on the call.) If yes, re-run synchronously.
   - Is the test suite genuinely hanging? (e.g. an infinite loop, a `while` on virtual time, a `Thread.sleep` against a clock that never advances.) Fix the hang in the code — the capture was never going to be meaningful on a hung run.
   - Did some prior step leave a daemon wedged? (Gradle, Pants, Bazel, a dev server.) Diagnose and kill the daemon. This is the only legitimate reason to use `pkill`, and even then: kill the daemon, then **re-run through logcap**, not bare.
5. Only after 1–4 return nothing actionable should you consider running the command outside logcap. In practice this case effectively never happens in a `/ship-quick` session.

### Common misattributions to watch for

- "logcap spawned background tasks that timed out" — **logcap does not spawn background tasks.** If you see backgrounding in the trace, you (the Bash tool caller) backgrounded the logcap invocation. Own that layer.
- "The wrapper is eating output" — the wrapper tees stdout+stderr unchanged to parent stdout and to the capture file. If you don't see output, either (a) the child didn't write any, (b) your pipeline downstream of logcap is buffering (see the `| tail -N` anti-pattern), or (c) the child was killed before flushing.
- "The gradle/pants/bazel daemon got wedged because of logcap" — daemons wedge because of their own state (clock mismatches, held locks, prior OOMs). logcap does not interact with daemon state at all; it just spawns a child that happens to talk to one.

## Quick reference: the commands you actually type in a quick task

```
# Run a phase (bucket a/b/c)
shipyard-logcap run Q-042-red -- pytest tests/test_thing.py::test_new_behaviour
shipyard-logcap run Q-042-green -- pytest tests/test_thing.py::test_new_behaviour
shipyard-logcap run Q-042-mutate -- pytest tests/test_thing.py::test_new_behaviour
shipyard-logcap run Q-042-full-suite -- pytest

# Check what just happened
shipyard-logcap tail Q-042-red --filter "FAIL|PASS"
shipyard-logcap grep Q-042-mutate "assertion" --context 10
shipyard-logcap path Q-042-full-suite

# See all captures from this quick task
shipyard-logcap list
```

Note the absence of `| tail`, `| grep`, `| head`, `&`, `run_in_background`, or any surrounding shell plumbing. That's the whole point.

## Why `BashOutput` is not in `ship-quick`'s allowed-tools

`ship-quick`'s frontmatter `allowed-tools` intentionally omits `BashOutput`. `BashOutput` is the correct tool for reading backgrounded Bash calls — but quick tasks never background their verification runs. Making `BashOutput` unavailable makes the wrong path literally impossible, which is the posture we want: there is one way to observe a verification run, and it is `shipyard-logcap tail`/`grep` against the on-disk capture.

If you find yourself wanting `BashOutput` during a `/ship-quick`, stop and re-read the anti-patterns section above. The answer is almost certainly "run logcap synchronously and query the capture afterwards."
