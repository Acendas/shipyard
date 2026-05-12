# Monitor Filter Recipes

Per-runner filter regex suggestions for `dispatching-operational-task`'s Phase 1 Monitor command. Goals:

- ~50 notifications per run (one per major phase + every failure).
- Cover progress AND failure tokens (silence is not success).
- Prefer summary lines over per-case PASS to keep notification volume bounded on large suites.

## vitest

```
^\s*(✓|✗|×|FAIL|PASS)\s|^Tests:\s|^Suites:\s|Test Files\s|Error|Traceback
```

Vitest emits `✓ filename` per file (summary) and `✗ test name` per failure. The trailing `Tests:` / `Suites:` lines fire once at the end. Avoid `passed|failed` standalone — they appear too often in test names.

## jest

```
^(PASS|FAIL)\s|^Tests:\s|^Test Suites:\s|^\s+✕\s|Error|Traceback
```

Jest's `PASS path/to/file` / `FAIL path/to/file` is one line per file — good signal density. The leading `✕ test name` lines fire only on failure.

## pytest

```
^(PASSED|FAILED|ERROR|SKIPPED)\s|^={5,}.*={5,}$|Traceback|^E\s|^FAILED\s
```

The `=== short test summary ===` separator and `=== N passed in Xs ===` end-of-run line both match. `^E\s` catches assertion-error continuation lines. With `pytest -q`, drop `^(PASSED|FAILED|...)` since quiet mode hides per-test status.

## go test

```
^(--- PASS|--- FAIL|=== RUN|FAIL|ok|PASS)\s|panic:|Error
```

`--- FAIL: TestName` and the trailing `FAIL\tpkg\t0.123s` are the actionable lines. Including `=== RUN` keeps progress visible on long-running tests; drop it if it's too chatty.

## npm/yarn build

```
^>\s|error\s|Error|warning|Failed to compile|webpack compiled|Compiled|ERROR in
```

Build runners tend to be noisy. Prefer terminal markers (`Compiled`, `Failed to compile`, `webpack compiled`) plus error-line catches.

## eslint / ruff / typecheck

```
\d+\s+(error|warning)|^\s*\d+:\d+\s+error|✖\s+\d+\s+problems|^All checks passed|Found \d+ errors
```

Linters are usually fast; the summary line at end is the most useful event. Drop progress markers entirely for these — exit code carries the verdict.

## Generic fallback

When the runner is unknown:

```
PASS|FAIL|✓|✗|Tests:|Suites:|Ran [0-9]+|Traceback|Error|FAILED|assert|Killed|OOM|Segmentation fault|panic:|exit code [^0]
```

Broader than ideal but won't go silent.

## Anti-pattern: success-only filter

```
PASS|✓     ← WRONG. A crash produces no events. Looks identical to "still running."
```

The point of the rule is that the filter must surface failure modes. If the runner doesn't emit a clear failure marker, broaden the alternation or include `Error|Traceback|panic:` as defensive wildcards.

## Related: ScheduleWakeup discipline

When the verify-run is genuinely long (multi-minute test suite, CI runner, external service) and `Monitor` isn't the right primitive, callers schedule a `ScheduleWakeup` to come back later. The cache-TTL rules for picking `delaySeconds` live in a sibling reference — see `schedule-wakeup-discipline.md`. Short version: 60–270s warm-cache window or 1200s+ idle window; never 300s (worst-of-both region).
