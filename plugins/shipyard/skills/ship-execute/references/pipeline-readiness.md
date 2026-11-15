# Sprint start: Step 1.5 readiness check

Stage `readiness`; also the `readiness-check` verdict and ask protocol that `--hotfix` uses.

## Step 1.5: Execution Readiness Check (stage_id: readiness) (fresh-start only)

State a compact READINESS banner before any code is written, then advance straight to `wave_1_dispatch` — **invoking `/ship-execute` IS the consent to execute**, so a clean fresh start never asks "Begin?". Skip entirely on resume / crash recovery.

```
STARTING sprint-NNN: N tasks / M waves, <solo|task|track> mode, baseline tests <pass|fail|not-run>.
  Branch: <current> [matches SPRINT.md branch]
  Wave 1: <task IDs + titles + effort>
  Risks: <top 2-3 from SPRINT.md>
Type "pause" any time to stop.
```

**Start items with the person (4.0).** Run `shipyard-data sprint needs-you`. When it says `you: needed now · <step and task>`, the plan put work at the start that needs the person, and this is the moment they are there. For each such step (they are all in Wave 1): write in the chat what to do and how long it takes, then one card: **Done** / **It failed** (say what happened) / **Not now**. Done → record what they reported in the step file and `shipyard-data step set-status <PID> done`. Failed → the result is the step's answer: record it, and follow the story's stated fallback (or park the dependants with `step set-status <PID> blocked --reason "<what failed>"`). Not now → `step set-status <PID> blocked --reason waiting_for_person` and the same for the steps that depend on it; say in one line which stories will not finish this sprint. Steps that do not depend on a start item are dispatched as usual. This is the only place the build asks for a person's time.

**Derive before asking — `shipyard-data readiness-check [--baseline-failing]`.** Do NOT judge the readiness conditions yourself; the CLI adjudicates them and returns one JSON verdict. Pass `--baseline-failing` only when the baseline suite actually ran red. Read three fields:

- **`actions[]`** — deterministic, reversible fixes. **Apply each, state it in one line, do not ask.** `switch_branch` → `git checkout <target>`; `commit_dirty` → commits only Shipyard-written residue (`CHANGELOG.md`, `.claude/settings.local.json`) by path, never `git add -A`. A tree dirty with the user's own files is an ask reason (`dirty_tree`: commit, stash, or continue without it) — Shipyard never commits a user's files for them. Each action carries its own `command` and an undo hint.
- **`must_ask`** — `false` means proceed. There is no second opinion to form.
- **`ask_reasons[]`** — only when `must_ask` is true. Each has a `code` and a `detail` sentence.

**Inform lines (no ask).** State what was done, one line each:

```
→ Switched to feat/sprint-008 (was shipyard/wt-agent-3 — leftover worktree branch).
→ Committed 3 uncommitted paths as 'wip: pre-sprint' — worktree agents build from the last commit. Undo: git reset --soft HEAD~1
```

**The ask (only when `must_ask` is true — one ask max, merged).** Render each reason's `detail` verbatim as chat text first, plus its evidence — the `git status --porcelain` listing, the two branch names, or the failing baseline test tail. Evidence sitting in a Bash result the user never saw does not count; the option labels carry only the choice. Then fire ONE `AskUserQuestion` with a question item per reason:

| `code` | Options |
|---|---|
| `dirty_and_branch_mismatch` | **Switch and carry the changes** (Recommended) / Commit here first / Stash / Continue as-is |
| `target_branch_missing` | **Create `<target>` from HEAD** (Recommended) / Pick a different branch / Abort |
| `baseline_failing` | **Investigate** (Recommended) / Proceed anyway |

`baseline_failing` is deliberately never derived — whether a red baseline is tolerable is a judgment about this repo (known-flaky vs real regression), not something the CLI can compute.

**Before the AskUserQuestion, run `shipyard-data cursor pause execute --note "readiness anomaly: <codes>"`** (pause-before-blocking-ask — `/goal` must stop instead of re-running readiness and re-asking; the pause note is the resume surface). The `using-worktrees` capability skill encodes the trust-the-platform model; `dispatching-task-loop`'s HARD STOP catches genuinely-broken isolation.

**→ `wave_1_dispatch`** (`wave_number=1 iteration=1`) when clean, or after the anomaly prompt resolves toward proceeding. If the user aborts from the anomaly prompt: `shipyard-data cursor escalate execute reason=readiness_anomaly_aborted`; echo and halt.
