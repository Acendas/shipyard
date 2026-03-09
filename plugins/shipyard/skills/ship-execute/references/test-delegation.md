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

```
You are a test runner. Your job is to run a test command, capture the output, and return a structured summary. Do NOT attempt to fix any failures.

## Steps

1. Run the test command with output captured to a file:
   ```bash
   <COMMAND> > $(shipyard-data)/.test-output.tmp 2>&1; echo "EXIT:$?"
   ```

2. Read the exit code from the last line of $(shipyard-data)/.test-output.tmp

3. Produce a summary based on the result:

   **If PASS (exit 0):**
   Read the last 10 lines of the output file. Extract the summary line (total tests, time, etc.).
   Return: `PASS | <summary line from output>`

   **If FAIL with few failures:**
   Read the output file. Identify failure names and messages (no stack traces).
   Return:
   ```
   FAIL | <N> failures
   - <test name>: <failure message>
   - <test name>: <failure message>
   ```
   Cap at 30 lines total.

   **If FAIL with mass failure (>50% tests failed):**
   Return: `FAIL | <N>/<M> failed — likely root cause: <first error message>`

4. Clean up: `rm -f $(shipyard-data)/.test-output.tmp`

5. Return ONLY the summary. Do NOT attempt fixes, do NOT run additional commands.
```

### Multi-Tier Variant (Sprint Completion)

For sprint completion, run all three tiers in a single subagent to avoid spawning overhead. Replace the prompt's step 1 with sequential runs:

```
Run these test commands sequentially, capturing each to a separate temp file:

1. Unit tests:
   <UNIT_COMMAND> > $(shipyard-data)/.test-output-unit.tmp 2>&1; echo "EXIT:$?"
2. Integration tests:
   <INTEGRATION_COMMAND> > $(shipyard-data)/.test-output-integration.tmp 2>&1; echo "EXIT:$?"
3. E2E tests:
   <E2E_COMMAND> > $(shipyard-data)/.test-output-e2e.tmp 2>&1; echo "EXIT:$?"

For each tier, read the output file and produce a one-line summary.
Skip any tier whose command is empty or "none".

Return a combined summary:
```
unit: PASS | 42 passed in 3.2s
integration: PASS | 12 passed in 8.1s
e2e: FAIL | 2/8 failed — login timeout on CI
```

Clean up all temp files when done.
```

## Framework-Agnostic Parsing

The subagent is an LLM, not a regex script. It handles any test framework natively:

- **Exit code** is the universal pass/fail signal (works for pytest, jest, go test, cargo test, RSpec, JUnit, etc.)
- **Last 10-20 lines** of test output contain the summary in virtually every framework
- **Failure details** are found by reading the full output file and extracting test names + messages
- The file capture keeps raw output out of the orchestrator; the LLM reads it intelligently in a fresh context

No framework-specific markers, no regex patterns, no parsing assumptions. The subagent understands test output the same way a developer would — by reading it.

## Missing Command Handling

If a test command is not configured in `$(shipyard-data)/config.md` (empty or absent for a tier), the subagent returns:

```
SKIP | no test command configured for <tier>
```

The orchestrator treats SKIP as non-blocking — missing test commands are a project configuration choice, not a failure.
