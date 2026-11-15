# Verification Capture — land-now tasks and hotfixes (`/ship-execute --task|--hotfix`)

> The default verification path is the **`dispatching-operational-task`** capability skill, which uses `shipyard-logcap` for full-fidelity capture plus a filtered live view. This file distills the subset a land-now task (`/ship-execute --task T###`) or hotfix (`--hotfix S###`) needs and documents the failure modes that destroy an audit trail. The `shipyard-logcap` CLI is also available directly for long-running streams (dev servers, watch mode, log tails) where signal forwarding and line-boundary rotation matter.

## The principle, restated for land-now tasks

Land-now tasks re-run the suite multiple times in one session (bucket a runs scoped + full; bucket b runs baseline + post-refactor). Each run costs tokens, wall-clock time, and device minutes. If you pipe a live stream into a filter and realize later you needed a different signal, the unfiltered stream is gone and your only option is to re-run.

`shipyard-logcap run` tees every byte of stdout+stderr to a rotating file on disk **and** to the parent's stdout, unchanged. You then query the on-disk file as many times as you want with `shipyard-logcap tail` and `shipyard-logcap grep`. Capture once, analyse many times.

## The run → query loop

For every bucket (a/b/c) phase the SKILL body names — `-red`, `-green`, `-refactor`, `-mutate`, `-full-suite`, `-baseline`, `-post-refactor` — the flow is the same (`<ID>` is the task id, e.g. `T042`, or the hotfix story id, e.g. `S012`):

1. **Run synchronously.** `shipyard-logcap run <ID>-<phase> -- <command>`. Do **not** set `run_in_background: true` on the Bash tool call. Do **not** pipe `shipyard-logcap run` through `grep`, `tail`, `head`, or any other filter. The capture file already has every byte you need; the parent stdout is just a convenience echo.
2. **Read the banner.** The one-line startup banner on stderr prints the capture file path and bounds. That is your "did this work?" signal — not the filtered tail of a shell pipeline.
3. **Query the capture.** After the command exits (or in a second Bash call while it's still running), use:
   - `shipyard-logcap tail <ID>-<phase> --filter "FAILED|BUILD|tests completed"` for the last N lines matching a regex.
   - `shipyard-logcap grep <ID>-<phase> "<pattern>" --context 10` for post-hoc search with surrounding context.
   - `shipyard-logcap tail <ID>-<phase> --follow` if you want a live stream while the command is still running from another call.
   - `shipyard-logcap path <ID>-<phase>` to print the absolute file path.
4. **Never re-run to re-filter.** If the first query surfaced something confusing, the next move is another `grep` with a wider pattern against the **same** capture. Re-running the command re-rolls the dice: the test may hang differently, the device may be in a different state, the daemon may be warmer or colder.

## Anti-patterns — what not to do

- **Pipe `run` through `grep`/`tail`.** `tail -N` emits nothing until stdin closes and `grep` block-buffers over a pipe, so the terminal shows zero live output while the capture fills normally. Run `shipyard-logcap run T###-phase -- <command>` with nothing after it; query afterwards with `shipyard-logcap tail` / `grep`.
- **Background the run and poll it.** The Bash tool's backgrounded-task timeout (2 minutes) sends `SIGTERM` through logcap to the child, leaving a 0-byte capture and a non-zero exit. Run synchronously; to watch progress, use `shipyard-logcap tail <ID>-<phase> --follow` from a second call; for a long suite raise the Bash `timeout`.
- **Fall back to a bare run when logcap "looks broken".** The capture is the only record of the run that already went wrong, and a bare re-run loses the audit trail, loses the phase-to-phase comparison (`-red` vs `-green`, `-baseline` vs `-post-refactor`), and re-rolls device/daemon/flake state. Use the diagnosis below first.

## When logcap appears to fail — diagnosis

`shipyard-logcap` spawns no background tasks, has no internal timeout on `run`, and returns the wrapped command's exit code, so a run that *looks* broken failed in the harness above it or the command below it.

### Decoder: 0-byte capture file + non-zero exit

| Exit code | What it means | Likely cause | Remediation |
|---|---|---|---|
| 143 | `SIGTERM` (128 + 15) | Externally killed. Most common case: the Bash tool's backgrounded-task timeout fired. | Do not background `shipyard-logcap run`. If the suite is legitimately long, raise the Bash call's `timeout` instead. |
| 137 | `SIGKILL` (128 + 9) | OOM killer, `kill -9`, container OOM killer, or a user/harness `pkill -9`. | Check memory pressure and whether anything in the session ran `pkill`. |
| 144 | Signal 16 (macOS `SIGURG` / Linux `SIGSTKFLT`). Observed in practice when Claude Code's Bash tool kills a backgrounded pipeline on macOS. | Treat as "externally killed by the harness," same class as 143. | Same as 143 — stop backgrounding. |
| 124 | `timeout` coreutil fired (unlikely unless you wrapped `timeout` around logcap yourself). | Remove the outer `timeout` wrapper; `shipyard-logcap run` has no internal timeout and does not need one. | Let logcap run until the child exits. |
| non-zero, not in this table | The wrapped command itself exited non-zero before producing output, or crashed before flushing. | The problem is in the command, not logcap. | Proceed to "Recovery path" below. |

A signal-based exit means the child was killed before it could flush; the 0-byte capture follows from that, not from logcap.

### Recovery path (before reaching for any fallback)

In order, from cheapest to most invasive:

1. `shipyard-logcap list` — does the capture directory contain your `<ID>-<phase>` at all? If not, you may be looking at the wrong project hash; run `shipyard-logcap probe` and compare against where you expected captures to land.
2. `shipyard-logcap path <ID>-<phase>` — print the absolute capture path. Read that file directly with `Read`. Even a partial capture (a few hundred bytes of daemon startup) tells you whether the command got far enough to emit stdout.
3. `shipyard-logcap tail <ID>-<phase>` — confirms what the tee wrote. If the output is non-empty, you have signal; work with it.
4. If all three show empty, the child was killed before writing a single byte. That is a fact about the child or the harness, **not** about logcap. Investigate in this order:
   - Did you background the Bash call? (Check whether `run_in_background: true` was set on the call.) If yes, re-run synchronously.
   - Is the test suite genuinely hanging? (e.g. an infinite loop, a `while` on virtual time, a `Thread.sleep` against a clock that never advances.) Fix the hang in the code — the capture was never going to be meaningful on a hung run.
   - Did some prior step leave a daemon wedged? (Gradle, Pants, Bazel, a dev server.) Diagnose and kill the daemon. This is the only legitimate reason to use `pkill`, and even then: kill the daemon, then **re-run through logcap**, not bare.
5. Only after 1–4 return nothing actionable consider running the command outside logcap.

## Quick reference: the commands you actually type

```
# Run a phase (bucket a/b/c)
shipyard-logcap run T042-red -- pytest tests/test_thing.py::test_new_behaviour
shipyard-logcap run T042-green -- pytest tests/test_thing.py::test_new_behaviour
shipyard-logcap run T042-mutate -- pytest tests/test_thing.py::test_new_behaviour
shipyard-logcap run T042-full-suite -- pytest

# Check what just happened
shipyard-logcap tail T042-red --filter "FAIL|PASS"
shipyard-logcap grep T042-mutate "assertion" --context 10
shipyard-logcap path T042-full-suite

# See all captures from this task
shipyard-logcap list
```

Note the absence of `| tail`, `| grep`, `| head`, `&`, `run_in_background`, or any surrounding shell plumbing. That's the whole point.

## Why not `BashOutput`

`BashOutput` reads backgrounded Bash calls — and verification runs are never backgrounded here. There is one way to observe a run: `shipyard-logcap tail`/`grep` against the on-disk capture.
