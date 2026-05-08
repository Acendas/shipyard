# Live Capture

**Status:** Most live-capture concerns moved to **`shipyard:dispatching-operational-task`** in 2.0. See `skills/dispatching-operational-task/SKILL.md`. The `shipyard-logcap` CLI remains for advanced rotation/grouping use cases until F-19/F-20 in the action items retire it.

## What this reference used to cover

Pre-2.0 documented the `shipyard-logcap run <name> --max-size <S> --max-files <N> -- <command>` capture primitive end-to-end: rotation semantics, per-session grouping via the `<SHIPYARD_DATA>/.active-logcap-session` sentinel, exit-code propagation, signal forwarding for long-running streams, the `tail` / `grep` / `path` query subcommands, and a decision table for `--max-size` / `--max-files` bounds per workload class (test runs / dev servers / E2E suites / one-shot probes).

## What replaces most of it in 2.0

- **For verification commands (tests, builds, E2E suites)** — invoke `shipyard:dispatching-operational-task`. It captures stdout+stderr to `<SHIPYARD_DATA>/captures/<task_id>/run-<N>.log` via plain `tee` and parses the structured return for the orchestrator-side gate. No `shipyard-logcap` involvement on the basic path.
- **For dev-server/E2E observation during `/ship-review`** — still uses `shipyard-logcap` if available, falling back to direct command + skill-side Read of stdout. The full retire of logcap is F-19/F-20 (Sprint 3 / future).
- **For `/ship-debug` long-running streams** (`tail -f`, `adb logcat`) — `shipyard-logcap` is still the right tool until something else surfaces. Signal forwarding and line-boundary rotation matter for this workload.

## Bounds (when you do use `shipyard-logcap`)

| Workload class | `--max-size` | `--max-files` |
|---|---|---|
| Unit/integration test run (one-shot) | 5MB | 2 |
| E2E suite | 20MB | 3 |
| Dev server / watch mode | 10MB | 5 |
| `tail -f` / log stream | 50MB | 10 |
| Quick probe (one curl/grep) | 1MB | 1 |

> **Naming:** `shipyard-logcap` (with a `p`) is Shipyard's wrapper. Not the same as Android's `adb logcat` (with a `t`). Logcap can *wrap* an `adb logcat` invocation; they remain distinct tools.

## Migration

Skill bodies that reference this file (`ship-debug`, `ship-review`, `ship-bug`, `ship-quick/references/verification-capture.md`) continue to point here for the bounds table and the legitimate logcap-only use cases. When F-19/F-20 lands, those references will move to the capability-skill flow or deeper trim.

This file went from 248 lines to a thin reference; full deletion follows F-19/F-20.
