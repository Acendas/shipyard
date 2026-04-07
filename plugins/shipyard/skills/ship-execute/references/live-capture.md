# Live Verification Capture

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
| Unknown or can't classify | `--max-size 1M --max-files 5` | Conservative middle. Override if it overflows. |

**Minimum `--max-size` is 64K** — the primitive rejects smaller values. Reason: Node's child-process pipe delivers data in chunks up to 64K, and chunks can't be split mid-text without breaking lines. Any bound below 64K would be silently overflowed by the first chunk. For most real captures this floor is invisible; the smallest recommended entry in the table above (`500K`) is already ~8× the floor.

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
```

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
- `<session>` is `$SHIPYARD_LOGCAP_SESSION` if set, otherwise a timestamp from the first `run` in the shell. `ship-execute` sets it to `<sprint-id>-wave-<N>` so captures from one sprint wave group together.
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

## Chunk boundaries

Rotation is chunk-boundary-based, not byte-exact. When a chunk arrives that would push the live file over `--max-size`, the primitive rotates *before* writing the chunk, then writes the whole chunk into the fresh file. This means:

- A single chunk larger than `--max-size` (unusual but possible — e.g. a program that dumps a huge stack trace in one write) lands in a file whose size briefly exceeds the bound by up to one chunk. The next chunk rotates again. Over a capture, the total size stays bounded by `max_files × (max_size + chunk_size)`.
- This is why `--max-size` has a 64K floor: smaller bounds would make "one chunk" dominate the file size and the rotation cap would lose meaning.

You can rely on rotation to bound capture growth for normal output. If a command is known to emit single giant writes you need to keep, raise `--max-size` to cover a reasonable multiple of the expected chunk size.

## Failure modes

- **Resolver error (no plugin root, no project).** `shipyard-logcap` exits non-zero with an actionable message naming the env var to set. Do not create a phantom capture dir. Fix the resolver error first.
- **`$TMPDIR` unwritable or full.** Clear error on startup. Point `TMPDIR` somewhere else or free space before retrying.
- **Rotation lock contention or rename failure mid-run.** The primitive logs a one-line warning to stderr and **keeps the child command running.** Losing capture is always preferable to killing the user's test run. The warning lands in `.logcap.log` for diagnosis via `shipyard-context diagnose`.
- **`list` shows nothing when you expected captures.** Almost always a resolver mismatch. `shipyard-logcap probe` prints the project hash and tmp path it's looking at; compare against where you thought captures were going.
- **Child command exited but capture file is empty.** The command wrote nothing to stdout/stderr. Not a capture bug. Check the command itself.

## Override precedence

Narrowest wins:

```
built-in safety fallback (500KB × 10, only if nothing else is set)
  ← this reference's choosing-bounds table (you pick per command)
       ← SHIPYARD_LOGCAP_MAX_SIZE / SHIPYARD_LOGCAP_MAX_FILES env vars (project-wide override)
            ← explicit --max-size / --max-files CLI flags (one-off)
```

You — the skill reading this — are responsible for picking reasonable bounds via the table. Env vars are for project-wide overrides users set once in shell init or an `.envrc`. CLI flags are for one-off deviations. The built-in fallback exists only so the tool doesn't crash if something upstream forgot to pick bounds. It is a safety net, not a feature.
