# Live Verification Capture

> **`shipyard-logcap` (with a `p`) is Shipyard's output-capture wrapper.** Not to be confused with Android's `adb logcat` (with a `t`) — which is a separate tool that emits device logs. Shipyard-logcap can *wrap* an `adb logcat` invocation to capture Android device logs (see "Android `adb logcat`" section below), but the two names/tools are distinct. When in doubt: logc**a**p = Shipyard wrapper; log**ca**t = Android device log stream.

## The principle

When a verification step runs a command and you want to watch its output, wrap it so the output is re-analyzable without re-running. The cost of re-running a verification is tokens, wall-clock time, and sometimes money (device minutes, cloud builds, flaky repros). The cost of keeping the raw stream around is a temp file that gets deleted afterward. The math is always in favor of capture.

The failure this prevents: you pipe a live stream into a filter focused on what you *think* matters, you see something suspicious, you realize you need a different signal — and the unfiltered stream is already gone. Your only option is to re-run the thing and hope it reproduces the same way. Don't be in that position.

**Capture once. Analyze many times.**

## When to wrap, when to skip

Wrap the command when:

- It streams to stdout/stderr and you or the user are watching it.
- It produces output you might want to re-inspect with a different filter.
- It's slow, flaky, device-dependent, or otherwise expensive to re-run.
- You're reviewing completed work and running things to verify behavior.
- You're investigating a bug repro.

Skip the wrapper when:

- The command already writes its own log file to a known path. Wrapping would double-capture and confuse whoever reads it later. Use the file the command already produces.
- The command is genuinely one-shot and trivially cheap to re-run (`ls`, `git status`, `pwd`). Wrapping adds ceremony without benefit.
- The command is interactive and expects a real TTY. `shipyard-logcap` passes stdin through, but heavily interactive programs can behave differently under a pipe. When in doubt, skip the wrapper for these.

Once you've decided to wrap, jump straight to **Choosing bounds** below — that's the only real decision left before you run.

## The contract

`shipyard-logcap` is dumb I/O plumbing: it tees a command's stdout+stderr to a rotating file and to the parent's stdout, unchanged. It does not parse, filter, classify, or analyze. That's your job.

```
shipyard-logcap run <name> --max-size <size> --max-files <n> -- <command...>
  Run the command, tee output to a rotating file. Exits with the wrapped command's exit code.

shipyard-logcap tail <name> [--filter <regex>] [--follow]
  Stream the captured file. With --filter, apply a regex to shown lines
  (the capture itself is always unfiltered).

shipyard-logcap grep <name> <pattern> [--context N]
  Post-hoc search of the capture. Your primary re-analysis tool.

shipyard-logcap list [--project]
  Show recent captures for the current project.

shipyard-logcap path <name>
  Print the absolute file path. Useful when handing the path to the user or another tool.

shipyard-logcap probe
  Print platform facts (tmp path, tmp type, free space, project hash).
  Useful when deciding bounds.

shipyard-logcap prune [--older-than 24h]
  Explicit cleanup of old capture directories. Never runs automatically.
```

Every `run` prints a one-line startup banner to stderr showing the capture file path and chosen bounds, so the user can see what they got and why. The banner is the primary "did this work?" signal.

## The re-analysis loop

When a capture surfaces something interesting, suspicious, or confusing:

1. **Do not re-run the command.** The capture is your source of truth. The command may behave differently next time — that's often the exact problem that led you to wrap it.
2. **Grep the existing capture with a different pattern first.** `shipyard-logcap grep <name> "<broader pattern>" --context 10`. Nine times out of ten you'll find what you needed without re-running anything.
3. **Only re-run if the command genuinely needs to have done something different** (different args, different env, different fixture state). In that case, wrap the re-run too — under a different `<name>` so both captures survive for comparison.
4. **Keep captures across a session** so you can diff them. `shipyard-logcap list` shows what's available.

Step 1 is the rule, not the exception. The whole feature exists to make it the cheap default. Break the rule only when you can articulate why the existing capture is insufficient for the question you're asking.

## Choosing bounds

You pick `--max-size` and `--max-files` when you invoke `shipyard-logcap run`. The primitive does not auto-detect. That's on purpose: you have the full project context, the sprint state, and the command you're about to run; the primitive sees none of that. You're the smart layer.

Pick from this decision table and extrapolate for cases not listed:

| Command profile | Suggested bounds | Why |
|---|---|---|
| Short smoke / health check, one-shot (`curl`, `./scripts/check.sh`, a single unit test) | `--max-size 500K --max-files 5` | Output is small. The ring is mostly empty. Conservative is fine. |
| Test suite with verbose output (`pytest -s`, `cargo test --nocapture`, `go test -v`, `jest --verbose`) | `--max-size 2M --max-files 8` | Bursty but bounded. You want enough room for a full failing traceback plus surrounding context. |
| Long-running dev server / container logs (`npm run dev`, `docker compose up`, `cargo run`, `tail -f service.log`) | `--max-size 4M --max-files 10` | Steady high-volume stream. You want a wide sliding window so the last ~40MB of traffic is always available. |
| Chatty build (webpack, gradle, `cargo build --verbose`, Next.js build) | `--max-size 1M --max-files 10` | Many medium files keeps individual files navigable for grep. |
| **Android `adb logcat` (streaming device logs)** | **`--max-size 4M --max-files 20`** | High-rate, can be 1000+ lines/sec on a busy device. Wider ring than dev servers because logcat emits everything from every process, not just one service. See the dedicated Android section below for filter tips. |
| **Android `adb logcat -d` (one-shot dump)** | **`--max-size 8M --max-files 3`** | Bounded by buffer size, typically 1–4 MB per dump. Few files is fine because there's no rotation pressure. |
| Unknown or can't classify | `--max-size 1M --max-files 5` | Conservative middle. Override if it overflows. |

**Minimum `--max-size` is 1K** — the primitive rejects smaller values as not worth the rotation overhead. For most real captures this floor is invisible; the smallest recommended entry in the table above (`500K`) is ~500× the floor.

**Check free space before picking bounds for a high-volume command.**

```bash
shipyard-logcap probe
# or: df -h "$TMPDIR"
```

If free tmp is below ~500MB, halve your picked bounds. Never plan to eat more than ~5% of free tmp. Running the user's dev machine out of tmp is a worse failure than losing old capture lines.

**When in doubt, err generous.** This feature exists to avoid re-runs. Losing the earliest lines of a chatty run is a recoverable annoyance; not capturing them at all is the failure this feature was built to prevent.

**When a capture overflows.** If the user says "I needed the first line and it's gone," the fix is not to raise the global default — it's to set a larger `--max-size` for *that specific command* next time. Defaults stay modest on purpose.

## Examples across stacks

```bash
# Python test suite
shipyard-logcap run pytest-e2e --max-size 2M --max-files 8 -- pytest -s tests/e2e/

# Node dev server
shipyard-logcap run web-dev --max-size 4M --max-files 10 -- npm run dev

# Docker compose stack
shipyard-logcap run compose-up --max-size 4M --max-files 10 -- docker compose up

# Rust integration test
shipyard-logcap run cargo-test --max-size 2M --max-files 8 -- cargo test --nocapture

# Go tests across all packages
shipyard-logcap run go-integ --max-size 2M --max-files 8 -- go test -v ./...

# Gradle build
shipyard-logcap run gradle-build --max-size 1M --max-files 10 -- ./gradlew build

# Custom smoke script
shipyard-logcap run smoke --max-size 500K --max-files 5 -- ./scripts/smoke.sh

# Bug repro wrapped under a bug ID
shipyard-logcap run bhot-042-repro --max-size 1M --max-files 5 -- ./repro.sh

# Android device log stream (wraps adb logcat)
shipyard-logcap run device-logs --max-size 4M --max-files 20 -- adb logcat -v threadtime

# Android one-shot dump (adb logcat -d exits immediately)
shipyard-logcap run crash-snapshot --max-size 8M --max-files 3 -- adb logcat -d -b crash
```

## Android `adb logcat`

Shipyard-logcap is a first-class wrapper for Android device logs via `adb logcat`. Three quirks to know:

**Streaming vs dump.** `adb logcat` runs until interrupted (`Ctrl-C` / SIGTERM); `adb logcat -d` dumps the current buffer and exits. Shipyard-logcap handles both — there is no internal timeout in `run`, so streaming commands work, and signal forwarding propagates `Ctrl-C` to the child so `adb` exits cleanly on POSIX. (On Windows, signal propagation to spawned children is unreliable per Node's limitations — the wrapper kills cleanly but `adb` may linger for a few seconds before its own socket closes.)

**Line boundaries across rotation.** Earlier versions of logcap cut lines mid-message at rotation boundaries, which broke `grep` context on high-rate streams like logcat (thousands of lines per second). The current implementation uses a carry-over buffer keyed on `\n` — the capture file always ends on a newline, so every rotation boundary is clean and `grep` matches full lines regardless of where rotation happened. You can verify this: run a logcat session with a tight `--max-size` so rotation triggers frequently, then `shipyard-logcap grep device-logs "ActivityManager: Starting activity"` — every match will be a complete line with the full message intact.

**Filter specs with shell-hostile tokens.** Android logcat filters use syntax like `ActivityManager:I '*:S'` — the `*:S` means "silence everything else", and the `*` is a literal logcat wildcard, not a shell glob. On POSIX shells the single quotes protect it; on Windows `cmd.exe`, `%*` expansion in the `.cmd` wrapper strips quotes and the shell expands `*` against the current working directory, which corrupts the filter.

The fix is the `--cmd-file` flag, which reads the command from a newline-delimited argv file instead of shell tokens. Write your logcat invocation to a file once, then pass the file path to logcap — no shell tokenization involved. See the dedicated section below.

### `--cmd-file` — bypass shell tokenization

For commands with quotes, spaces, globs, or other cmd.exe-hostile tokens, `--cmd-file <path>` lets you read the wrapped command from a file instead of passing it on the command line:

```bash
# Write the command once — each line is one argv token, no shell interpretation
cat > logcat-cmd.txt <<'EOF'
# Blank lines and # comments are ignored
adb
logcat
-v
threadtime
ActivityManager:I
*:S
EOF

shipyard-logcap run device-logs --max-size 4M --max-files 20 --cmd-file logcat-cmd.txt
```

The `--cmd-file` flag:
- Reads the file. Each non-empty, non-comment line is one argv token (verbatim — no quote handling, no variable expansion, no shell splitting).
- Is mutually exclusive with `-- <command...>` — pick one form per invocation.
- Works identically on POSIX and Windows — it bypasses cmd.exe's `%*` handling entirely.
- Is also useful for any command with multi-line arguments, embedded newlines, or tokens that are awkward to shell-quote (JSON payloads, complex `find` expressions, `awk` programs).

### Logcat tips

- **Clear the buffer before a fresh capture** with `adb logcat -c` (one-shot, no capture needed) so your capture doesn't start with stale lines from a previous session.
- **Skip `-v color`** when capturing. Color escapes land as raw `\e[...m` bytes in the capture file and pollute `tail`/`grep` readability. Use `-v threadtime` for a clean tabular format.
- **Scope by PID** with `adb logcat --pid=$(adb shell pidof <your.package>)` to drop noise from unrelated processes.
- **Re-analyze without re-running** — logcat will behave differently next time (different crash, different ordering, different device state). The capture is your source of truth. `shipyard-logcap grep device-logs "FATAL EXCEPTION"` is how you investigate, not another `adb logcat` run.
- **Rotation under a chatty device.** With `--max-size 4M --max-files 20` you get up to 80 MB of rolling buffer — enough to hold ~20 seconds of a noisy emulator at full tilt. Raise `--max-files` if you need a longer history.

Then analyze without re-running:

```bash
shipyard-logcap grep pytest-e2e "FAIL" --context 20
shipyard-logcap tail web-dev --filter "ERROR|WARN"
shipyard-logcap path bhot-042-repro        # get the file path to reference in bug notes
shipyard-logcap list                         # see what captures exist for this project
```

## Where captures live

`$TMPDIR/shipyard/<project-hash>/<session>/<name>.log[.1][.2]...`

- `<project-hash>` comes from Shipyard's resolver — the same hash used for plugin data, which is worktree-aware. All worktrees of one project share one capture dir, so a builder subagent running in `.claude/worktrees/foo/` and the orchestrator on `main` write to the same place and can read each other's captures.
- `<session>` resolution priority (first wins): (1) `$SHIPYARD_LOGCAP_SESSION` env var if set, (2) `<SHIPYARD_DATA>/.active-logcap-session` file contents if present and valid, (3) per-day bucket `session-YYYYMMDD`. `ship-execute` writes `<sprint-id>-wave-<N>` to the file at wave boundaries — this is the bulletproof mechanism that works across Claude Code Bash tool calls (each call spawns a fresh shell, so env vars don't propagate between invocations; the file is read fresh by each `shipyard-logcap run`).
- Captures are ephemeral. Tmp cleanup will eventually reap them; `shipyard-logcap prune` does it explicitly. **Do not treat captures as long-term storage.** If you need something to survive past the session, copy it out or paste the relevant excerpt somewhere durable.

## Redaction

Captures contain raw stdout+stderr. That can include:

- API tokens in error messages
- Database URLs with credentials
- User PII in test fixtures
- Internal hostnames and IPs
- Customer data that happened to show up in a debug log

**Do not paste a raw capture into a bug report, PR description, or external chat without reviewing it first.** If a command is emitting secrets into its output, the right fix is almost always to stop emitting them at the source — scrub the logging in the code, don't scrub the capture after the fact.

When quoting from a capture in user-visible output, quote only the specific lines you need and check them.

## Line boundaries and rotation

Rotation is **line-boundary-based**. The primitive accumulates incoming stdout/stderr chunks in an in-memory carry buffer, finds the last `\n`, and writes everything up to and including that newline to the capture file. The trailing partial line stays in carry until the next chunk arrives (or until EOF, where it's flushed even if there's no trailing newline). Rotation only ever happens on a line-aligned boundary — the capture file always ends with a complete line (except at EOF when the child emitted an unterminated final line).

**Why this matters:** without line-boundary rotation, a single log line straddling a rotation boundary would be split across `file.log.1` and `file.log`, and `grep` against either file would miss the match. For high-rate streams like `adb logcat` (1000+ lines/sec) this is the difference between "I can find the crash" and "I need to re-run the device".

**Carry buffer safety cap:** if a stream produces no newlines at all for 1 MB (pathological binary dump or single-line input), the carry is force-flushed and rotation becomes chunk-aligned for that stretch. The capture stays bounded; only the line-boundary guarantee is relaxed under pathological input.

**Size overshoot per rotation:** a line that itself exceeds `--max-size` will push the current file past the bound by up to one line's worth. The next line triggers rotation. Over a whole capture, total size is bounded by `max_files × (max_size + longest_line)`, not `max_files × max_size` exactly — within tolerance for all realistic workloads.

**`--max-size` floor is 1K.** With line-boundary rotation, chunk size no longer sets a floor; the minimum exists only so rotation bookkeeping doesn't dominate real capture bytes at extremely small sizes.

## Failure modes

- **Resolver error (no plugin root, no project).** `shipyard-logcap` exits non-zero with an actionable message naming the env var to set. Do not create a phantom capture dir. Fix the resolver error first.
- **`$TMPDIR` unwritable or full.** Clear error on startup. Point `TMPDIR` somewhere else or free space before retrying.
- **Rotation lock contention or rename failure mid-run.** The primitive logs a one-line warning to stderr and **keeps the child command running.** Losing capture is always preferable to killing the user's test run. The warning lands in `.logcap.log` for diagnosis via `shipyard-context diagnose`.
- **`list` shows nothing when you expected captures.** Almost always a resolver mismatch. `shipyard-logcap probe` prints the project hash and tmp path it's looking at; compare against where you thought captures were going.
- **Child command exited but capture file is empty.** The command wrote nothing to stdout/stderr. Not a capture bug. Check the command itself.
- **Pipeline after `run` produces zero live output.** If you write `shipyard-logcap run <name> -- <cmd> | grep ... | tail -N`, the visible pipeline will emit nothing until the wrapped command exits — `tail -N` blocks until stdin closes, and block-buffered `grep` over a pipe compounds it. The capture file on disk is filling normally the whole time. Do not interpret a silent pipeline as "capture is broken." Stop piping the `run` through filters at all; query the capture afterwards with `shipyard-logcap tail <name> --filter <regex>` / `shipyard-logcap grep <name> <pattern>`, or watch progress live from a second shell with `shipyard-logcap tail <name> --follow`.
- **Backgrounded `run` killed by the harness, 0-byte capture, exit 143/137/144.** `shipyard-logcap` has no internal timeout on `run` and does not spawn background tasks itself. If you invoke logcap through Claude Code's Bash tool with `run_in_background: true`, the Bash tool's own backgrounded-task timeout (default 2 minutes) will kill the entire pipeline when it fires. `SIGTERM` propagates through logcap to the wrapped child; the child dies before flushing; the capture file stays at 0 bytes; the visible exit code is 143 (SIGTERM), 137 (SIGKILL if something escalates), or 144 (signal 16 — observed on macOS under Claude Code's Bash tool). **None of these are logcap failures.** They are externally-killed runs. Remediation: do not background `shipyard-logcap run`. Run it synchronously and, if the suite is legitimately long, raise the Bash tool's `timeout` parameter explicitly instead of backgrounding. If you need live observability while a long run is in progress, open a second Bash call and `shipyard-logcap tail <name> --follow` against the on-disk capture.
- **Apparent-wrapper-failure reasoning trap.** When a `run` surfaces anything unexpected (0-byte capture, non-zero exit, silent terminal), the wrong first hypothesis is "logcap is broken, fall back to running the command bare." The wrapper is dumb I/O plumbing; the exit code you see is the wrapped command's exit code (or a signal from the layer above logcap). Diagnose in this order before touching any fallback: (1) `shipyard-logcap list` to confirm the capture exists, (2) `shipyard-logcap path <name>` + read the file directly for partial output, (3) check whether you backgrounded the Bash call, (4) check whether the wrapped command genuinely hung (infinite loop, clock mismatch, wedged daemon). Falling back to a bare run loses the audit trail, re-rolls device/daemon state, and almost never diagnoses the real problem — because the real problem was virtually never the wrapper.

## Override precedence

Narrowest wins:

```
built-in safety fallback (500KB × 10, only if nothing else is set)
  ← this reference's choosing-bounds table (you pick per command)
       ← SHIPYARD_LOGCAP_MAX_SIZE / SHIPYARD_LOGCAP_MAX_FILES env vars (project-wide override)
            ← explicit --max-size / --max-files CLI flags (one-off)
```

You — the skill reading this — are responsible for picking reasonable bounds via the table. Env vars are for project-wide overrides users set once in shell init or an `.envrc`. CLI flags are for one-off deviations. The built-in fallback exists only so the tool doesn't crash if something upstream forgot to pick bounds. It is a safety net, not a feature.
