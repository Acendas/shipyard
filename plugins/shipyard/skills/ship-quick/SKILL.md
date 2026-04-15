---
name: ship-quick
description: "Execute a single self-contained change with Shipyard's quality bar (test-first, one focused commit, Q-NNN task file) without opening a sprint. Fire when the user says things like 'quick refactor', 'quickly rename', 'small cleanup', 'tidy this up', 'drive-by change', 'one-off fix', 'while we're here', 'just quickly', or asks for any contained edit that is neither a bug (prefer /ship-bug) nor a new feature worth planning (prefer /ship-discuss). Claude tends to under-trigger this — prefer it over ad-hoc Edit loops whenever the user frames the ask as 'quick' or 'small' and the change should still land tested and committed atomically."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, LSP, AskUserQuestion]
model: sonnet
effort: medium
argument-hint: "[task description]"
---

# Shipyard: Quick Task

Execute a one-off task outside of sprint planning but with Shipyard's guarantees (write tests first, one focused commit per change, spec compliance).

## Context

!`shipyard-context path`

!`shipyard-context view config`
!`shipyard-context view codebase 30`
!`shipyard-context list quick-tasks`

## Path Rules

All file ops use the absolute SHIPYARD_DATA prefix from the context block. **No `~`, `$HOME`, or shell variables in `file_path`** — the hooks resolve paths via a shared resolver, and a tilde in `file_path` lands state in the wrong data dir on worktrees. **No bash invocation of `shipyard-data` or `shipyard-context`** in this skill body — use Read / Grep / Glob. **Never use `echo`/`printf`/shell redirects to write state files** — use the Write tool (auto-approved for SHIPYARD_DATA). The `!`-prefixed context block at the top is the only sanctioned place to shell out to the plugin CLIs.

## Input

$ARGUMENTS

## Session Guard Cleanup

**First action — planning-session mutex check:** Use the Read tool on `<SHIPYARD_DATA>/.active-session.json` (substitute the literal SHIPYARD_DATA path from the context block above). Then decide:

- **File does not exist** → no planning session active. Skip to "Execution Lock Check" below.
- **File exists.** Parse the JSON and check:
  1. If `cleared` is set OR `skill` is `null` → previous planning session ended cleanly. Use Write to overwrite the file with `{"skill": null, "cleared": "<iso-timestamp>"}` (idempotent — the soft-delete sentinel ensures `session-guard` treats it as inactive). Skip to "Execution Lock Check" below.
  2. If `started` is more than 2 hours old → stale lock from a crashed planning session. Print "(recovered stale planning lock from `/{previous skill}` started {N}h ago)", use Write to overwrite with the cleared sentinel, then proceed.
  3. Otherwise → **HARD BLOCK.** A planning session is active and quick tasks cannot start until it ends:
  ```
  ⛔ Planning session active — cannot start a quick task.
    Skill:   /{skill from file}
    Topic:   {topic from file}
    Started: {started from file}

  Finish or pause the planning session first, then run /ship-quick.
  If the planning session crashed: /ship-status (will offer to clear the stale lock)
  ```
  Print this message as the entire response and STOP.

This prevents the failure mode where a discussion is in progress and `/ship-quick` would otherwise trip the session-guard hook on every Edit. Quick tasks are implementing work — they need a clear runway.

## Execution Lock Check

**Before starting work**, check for concurrent execution:

1. Use the Read tool to read `<SHIPYARD_DATA>/.active-execution.json`. If the file exists, parse the JSON and check `cleared` (sentinel marker) and `started` timestamp. If `cleared` is not set AND `started` is less than 2 hours ago:
   ```
   ⛔ BLOCKED: Another execution session is active.
     Skill: [skill name]
     Started: [timestamp]

   Concurrent execution causes git conflicts, duplicate commits, and corrupted state.
   Finish or pause the active session first, then run /ship-quick.
   If the other session crashed or was closed: /ship-status (will ask to clear the lock)
   ```
   **Hard block — do not proceed. Do not offer an override.** Stop immediately.

2. If no lock exists, the lock has `cleared` set, or the lock is stale (>2 hours) → use the Write tool to overwrite `<SHIPYARD_DATA>/.active-execution.json` with:
   ```json
   {
     "skill": "ship-quick",
     "task": "[task description]",
     "started": "[ISO date]"
   }
   ```

3. **On completion**, use the Write tool to overwrite `<SHIPYARD_DATA>/.active-execution.json` with `{"skill": null, "cleared": "<iso-timestamp>"}` (soft-delete sentinel).

## Process

### Step 1: Understand

If no arguments or vague input → AskUserQuestion: "What's the quick task? Describe the change you'd like to make."

Parse the user's task description. Determine:
- Is this a bug fix? → AskUserQuestion: "This sounds like a bug fix. Use /ship-bug instead? (yes / no, it's a quick task)"
- Is this a new feature? → AskUserQuestion: "This sounds like a new feature. Use /ship-discuss instead? (yes / no, it's a quick task)"
- Is this a small, self-contained change? → proceed

### Step 2: Quick Spec

**Derive the next `Q-NNN` id.** The `!shipyard-context list quick-tasks` output in the context block above lists existing `Q-*` task files. Pick `NNN` = (highest existing number + 1), zero-padded to 3 digits. If none exist, start at `Q-001`. If the context output wasn't captured or is empty, use Glob on `<SHIPYARD_DATA>/spec/tasks/Q-*.md` to enumerate before picking. Do not guess — collisions silently clobber prior task files.

**Slug:** lowercase-kebab-case, ≤5 words, derived from the task title.

Create a minimal task file at `<SHIPYARD_DATA>/spec/tasks/Q-NNN-<slug>.md`:
```yaml
---
id: Q-NNN
title: "[title]"
type: quick-task
status: in-progress
created: <current ISO date, YYYY-MM-DD>
---

## What
[Task description]

## Acceptance Criteria
[Inferred from description — brief Given/When/Then if applicable]
```

### Step 3: Execute

**First, classify the task** — the execution path depends on which bucket it falls in. Pick one.

**All test/suite runs in every bucket go through `shipyard-logcap`** — never invoke the test runner directly. Use `shipyard-logcap run <Q-NNN>-<phase> -- <command>` where `<phase>` names the step (e.g. `Q-042-red`, `Q-042-green`, `Q-042-refactor`, `Q-042-mutate`, `Q-042-full-suite`, `Q-042-baseline`, `Q-042-post-refactor`). This is the same pattern the full sprint builder uses — the rationale is the same: quick tasks often re-run the suite multiple times in one session (bucket b runs it twice, bucket a runs scoped + full), and if you lose context to compaction between runs you'd re-execute them. With logcap the output is on disk, greppable, and cheap to re-read. The captures also serve as audit evidence for the commit — a reviewer can `shipyard-logcap tail Q-042-full-suite` to see exactly what you saw.

**After every `shipyard-logcap run`, query the on-disk capture — do not re-run, do not pipe, do not background.** Use `shipyard-logcap tail <Q-NNN>-<phase> --filter <regex>` or `shipyard-logcap grep <Q-NNN>-<phase> <pattern> --context 10` to read what happened. Never shell-pipe a `shipyard-logcap run` invocation through filter commands (the pipeline buffers to EOF and emits zero live output — a 0-byte visible result even though the capture file is filling normally). Never background a logcap run on the Bash tool call (the harness's 2m backgrounded-task timeout will kill the pipeline, you'll get exit 143/144 and a 0-byte capture, and it will look like logcap failed when the real cause is the outer backgrounding). Run logcap synchronously; if the suite is legitimately long, raise the Bash tool's `timeout` parameter explicitly rather than backgrounding. If a run *appears* to fail (0-byte capture, exit 143/144/137), do NOT fall back to running the command bare — run `shipyard-logcap list`, `shipyard-logcap path <Q-NNN>-<phase>`, and read the capture file directly first. The full re-analysis loop, failure-mode decoder, and recovery path live in `references/verification-capture.md` — read it once per session before any verification step.

**(a) Testable behavior change (new logic, bugfix, new branch in a function).**
Full TDD cycle:
1. **Red.** Write the failing test first, at the project's conventional test location. Run it via `shipyard-logcap run <Q-NNN>-red -- <scoped-test-command>`; confirm it fails for the right reason (assertion, not import error) by reading the capture.
2. **Green.** Implement the smallest change that makes the new test pass. Verify via `shipyard-logcap run <Q-NNN>-green -- <scoped-test-command>`.
3. **Refactor.** Clean up only what you just touched. Don't drive-by fix unrelated code. Verify via `shipyard-logcap run <Q-NNN>-refactor -- <scoped-test-command>`.
4. **Mutate-verify.** Flip the assertion or break the implementation by one character; confirm the test actually fails via `shipyard-logcap run <Q-NNN>-mutate -- <scoped-test-command>`. This catches tests that pass trivially. Revert the mutation.
5. **Full suite.** Run the project's full test command (not just your new test) before committing, via `shipyard-logcap run <Q-NNN>-full-suite -- <full-suite-command>`. A passing new test + a broken suite is a regression, not a quick task.

**(b) Refactor with existing test coverage (rename, extract, inline, reorganize — behavior unchanged).**
No new test needed — the existing suite **is** the safety net, and that's *why* refactors are safe to do quickly.
1. Confirm the touched code is currently covered: use Grep to find tests referencing the symbol(s) you're changing. If nothing covers it, treat this as bucket (c) instead.
2. **Baseline green** — run the full suite once **before** touching anything via `shipyard-logcap run <Q-NNN>-baseline -- <full-suite-command>`, to establish that the tree is green (so you don't inherit someone else's failure). If baseline fails, STOP — you've discovered an unrelated bug and need to escalate via `/ship-bug` or `/ship-debug`, not silently attempt a refactor on top.
3. Refactor.
4. **Post-refactor green** — run the full suite again via `shipyard-logcap run <Q-NNN>-post-refactor -- <full-suite-command>`. It must still pass with zero changes to test files. Any test file edit during a refactor means the behavior changed — stop and reclassify as (a). The two captures (`-baseline` and `-post-refactor`) are the before/after proof of a behavior-preserving refactor.

**(c) Non-testable change (docs, comments, config tweaks, formatting, dependency bump, UI copy, build-script cleanup).**
No test required, but still gated:
1. State in the commit body *why* it's not testable (one line — "docs only", "config value change, covered by smoke test", etc.). This prevents the escape hatch from being used on bucket (a) work in disguise.
2. Run the full suite anyway if the change could plausibly affect runtime (dependency bump, config, build script) via `shipyard-logcap run <Q-NNN>-full-suite -- <full-suite-command>`. Skip only for pure prose/comment edits.
3. For dependency bumps: confirm the lockfile updated, and run the suite (same wrapped invocation as step 2).

**Commit** (after the relevant bucket's gates pass):
- `chore(Q-NNN): <description>` — refactors, cleanups, non-feature improvements
- `fix(Q-NNN): <description>` — corrections of broken behavior that aren't formal bug reports
- **Never the `feat()` prefix for a quick task** — quick tasks aren't planned features; `feat` commits belong to sprint work so they surface in release notes under the right heading.

One focused commit per quick task. If you find yourself wanting a second commit, the task has outgrown `/ship-quick` — see the scope-escalation rule below.

### Step 4: Update Status

Mark task as done. Report:
```
✓ Quick task done: Q-NNN — [title]
  Commit: [hash]
  Tests: [passed/skipped]
```

## Rules

- **Follow TDD when the bucket calls for it** (see Step 3 classification). The reason quick tasks still get tests is that "quick" describes scope, not rigor — a three-line fix that ships untested is the exact shape of a regression nobody catches until prod. If the change is genuinely untestable, bucket (c) gives you a sanctioned escape hatch with a stated reason.
- **`chore()` for refactors/improvements, `fix()` for corrections, never `feat()`.** Because `feat()` commits populate the release-notes feature changelog under sprint-planned work. A quick task that shows up there misleads readers about what shipped in the sprint, and hides the real (planned) features below noise.
- **Promote to `/ship-discuss` when the signals say so**, not by clock or file count. Signals Claude can observe: you're about to make a design decision you'd want written down (choosing between two architectures, picking a new abstraction, introducing a new external dependency); you need to modify ≥2 *substantive* files (excluding pure mechanical renames or test file updates) where the changes are logically independent; you're about to introduce a new public API, new module, or new pattern the rest of the codebase doesn't already use. When any of those fire → AskUserQuestion: "This task is crossing the line into design territory ([reason]). Continue here, or promote to /ship-discuss for a proper feature? (continue / promote)". Pure mechanical refactors (rename across 30 files) stay quick — file count alone doesn't escalate.
- **When the task description is ambiguous or multiple approaches exist** → AskUserQuestion with options and your recommendation. Don't silently pick one — the user came to `/ship-quick` because they wanted speed, not because they wanted you to guess.

## Next Up (after task complete)

Check if there's an active sprint and suggest accordingly:

If mid-sprint:
```
▶ NEXT UP
  /ship-execute — pick up the next sprint task
  /ship-quick    — another one-off change
  (tip: /clear first for a fresh context window)
```

If no active sprint:
```
▶ NEXT UP
  /ship-status — check project status
  /ship-quick   — another one-off change
  (tip: /clear first for a fresh context window)
```
