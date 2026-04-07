# Test Delegation to Subagents

Test output can be hundreds of lines — running tests directly in the orchestrator pollutes its context and accelerates auto-compaction. Instead, delegate test running to a short-lived subagent that captures output to a file and returns a structured summary.

## Why Delegate

The orchestrator's ~10-15% context budget has no room for raw test output. A subagent gets a fresh 200k context window, runs the tests, reads the output file, and returns 1-30 lines of structured summary. The orchestrator acts on the summary without ever seeing the raw output.

## Subagent Setup

- **Type:** `Agent` with `subagent_type: shipyard:shipyard-test-runner` (no `isolation: worktree`) — runs on the current branch after merges
- **Model:** haiku — this is pure grunt work (run command, read output, summarize), no reasoning needed
- **Tools:** `Bash` and `Read` only (Write/Edit/Agent disallowed by agent definition)
- **Lifecycle:** Short-lived — spawns, runs tests, returns summary, dies

## Subagent Prompt Template

Use this as the `prompt` when spawning the test runner subagent. Replace `<COMMAND>` with the actual test command from config, and `<TIER>` with the test tier name (unit/integration/e2e).

**Why capture via `shipyard-logcap run`, not a raw bash redirect:** redirecting into `<SHIPYARD_DATA>/.test-output.tmp` triggers Claude Code's "suspicious path" permission prompt on every test run because the plugin data dir lives outside the project root (issue #41763). POSIX `mktemp` is not available on plain Windows cmd.exe / PowerShell, so it's not a portable fallback. `shipyard-logcap` is Shipyard's cross-platform capture primitive — a Node implementation with a `.cmd` shim on Windows. It tees stdout+stderr to a rotating file in `$TMPDIR/shipyard/<project-hash>/<session>/<name>.log`, propagates the child exit code, and is readable via `shipyard-logcap tail` / `grep` subcommands without re-running. The capture path is in the default Bash allow scope on every platform.

```
You are a test runner. Your job is to run a test command, capture the output, and return a structured summary. Do NOT attempt to fix any failures.

## Steps

1. Run the test command via `shipyard-logcap run`, which captures stdout+stderr to a rotating file in `$TMPDIR` and propagates the child's exit code:
   ```bash
   shipyard-logcap run <TIER> -- <COMMAND>
   echo "EXIT:$?"
   ```
   Cross-platform: the `shipyard-logcap` binary resolves to a Node script (`.sh` wrapper on macOS/Linux, `.cmd` wrapper on Windows). The capture directory is `$TMPDIR/shipyard/<project-hash>/<session>/` which is always in the default Bash allow scope, so no permission prompt fires. No manual cleanup is needed — the tool rotates files automatically.

2. Read the captured output to produce the summary:
   - `shipyard-logcap tail <TIER>` — prints the captured stdout+stderr (last ~200 lines by default)
   - `shipyard-logcap tail <TIER> --filter '<regex>'` — filters while tailing
   - `shipyard-logcap grep <TIER> '<pattern>' --context 3` — grep within the capture with surrounding context

3. Produce a summary based on the exit code from step 1:

   **If PASS (exit 0):**
   `shipyard-logcap tail <TIER>` and extract the framework's summary line (total tests, time, etc.).
   Return: `PASS | <summary line from output>`

   **If FAIL with few failures:**
   `shipyard-logcap tail <TIER>` and identify failure names + messages (no stack traces).
   Return:
   ```
   FAIL | <N> failures
   - <test name>: <failure message>
   - <test name>: <failure message>
   ```
   Cap at 30 lines total.

   **If FAIL with mass failure (>50% tests failed):**
   `shipyard-logcap grep <TIER> '(FAIL|ERROR|Error:)' --context 1` to pull the first error's context.
   Return: `FAIL | <N>/<M> failed — likely root cause: <first error message>`

4. Return ONLY the summary. Do NOT attempt fixes, do NOT run additional commands. `shipyard-logcap` handles capture rotation so there is nothing to clean up manually.
```

### Multi-Tier Variant (Sprint Completion)

For sprint completion, run all three tiers in a single subagent to avoid spawning overhead. Each tier gets its own capture name so the three outputs don't collide:

```
Run these test commands sequentially, each captured under a distinct shipyard-logcap name:

1. Unit tests:
   shipyard-logcap run unit -- <UNIT_COMMAND>
   echo "UNIT_EXIT:$?"
2. Integration tests:
   shipyard-logcap run integration -- <INTEGRATION_COMMAND>
   echo "INT_EXIT:$?"
3. E2E tests:
   shipyard-logcap run e2e -- <E2E_COMMAND>
   echo "E2E_EXIT:$?"

For each tier, call `shipyard-logcap tail <tier>` (or `grep <tier> <pattern>`) to read the capture and produce a one-line summary.
Skip any tier whose command is empty or "none".

Return a combined summary:
```
unit: PASS | 42 passed in 3.2s
integration: PASS | 12 passed in 8.1s
e2e: FAIL | 2/8 failed — login timeout on CI
```

No manual cleanup needed — `shipyard-logcap` rotates captures automatically.
```

## Framework-Agnostic Parsing

The subagent is an LLM, not a regex script. It handles any test framework natively:

- **Exit code** is the universal pass/fail signal (works for pytest, jest, go test, cargo test, RSpec, JUnit, etc.)
- **Last 10-20 lines** of test output contain the summary in virtually every framework
- **Failure details** are found by reading the full output file and extracting test names + messages
- The file capture keeps raw output out of the orchestrator; the LLM reads it intelligently in a fresh context

No framework-specific markers, no regex patterns, no parsing assumptions. The subagent understands test output the same way a developer would — by reading it.

## Missing Command Handling

If a test command is not configured in `<SHIPYARD_DATA>/config.md` (empty or absent for a tier), the subagent returns:

```
SKIP | no test command configured for <tier>
```

The orchestrator treats SKIP as non-blocking — missing test commands are a project configuration choice, not a failure.
