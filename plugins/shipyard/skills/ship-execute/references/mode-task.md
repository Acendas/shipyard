# SINGLE TASK mode (`--task <id>`)

Two shapes share this mode. Decide by the id's record (read its frontmatter):

- **A step (`P###`, or a pre-v4 builder record `T###` with `kind: feature|operational|research` and a parent story)** — one sprint step run on its own: picking up a specific unblocked step, re-executing a failed one, or running a patch step. **Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/task-dispatch.md` (Step 3 TDD cycle, Task Kind Routing, Per-task dispatch, Post-Subagent gate). The builder writes tests + implementation (no test execution); the `single_task` stage then advances only to `terminal_single_task` — no wave REFACTOR/MUTATE/VERIFY stages run.
- **A land-now task (`T###` with `kind: chore|spike|unblocker|study|debug`, created by `/ship-discuss`'s land-now lane)** — a self-contained change outside sprint planning that keeps the land-now guarantees below. Run it in-place on the working branch, in this session, with no worktree.

## Land-now guarantees (ported from the retired one-off-change skill)

Every one is a gate, not a style note. **All test runs go through `shipyard-logcap run <ID>-<phase> -- <command>`** (`<ID>` = the task id, e.g. `T042`; phases `-baseline`, `-red`, `-green`, `-refactor`, `-mutate`, `-full-suite`, `-post-refactor`) and are read back with `shipyard-logcap tail|grep <ID>-<phase>` — never piped, never backgrounded. Read `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/verification-capture.md` once per session before the first run.

1. **Id derived, never guessed.** The task record exists at `<SHIPYARD_DATA>/spec/tasks/<ID>-*.md` (the lane allocated it with `shipyard-data next-id tasks`). No record → refuse: "no task <ID>; file it with /ship-discuss first".
2. **Baseline green before touching anything.** `shipyard-logcap run <ID>-baseline --reuse -- <full-suite-command>`. **`<full-suite-command>` is `test_commands.unit` from the config block, word for word** (never a shorter spelling such as `make test`: the configured one carries the keep-going and parallel flags; a hotfix ran the short form and a 12-minute suite took over 30, twice). `--reuse` means a tree that is already proven green is not run again (`PROVEN, not run again` is a green baseline). For `-full-suite` and `-post-refactor` use `test_commands.scoped` when it is set (only the tests the change can affect), else the same full command. A red baseline is somebody else's failure: STOP, do not touch code, and hand off (`/ship-discuss` with the failing test as a bug, or `/ship-debug`). Never refactor on top of a red tree.
3. **Classify, then test first.** Pick ONE bucket:
   - **(a) Testable behavior change** → the `tdd-cycle` Iron Law: `-red` (fails for the right reason), `-green` (minimum code), `-refactor` (only what you touched), `-mutate` (break it by one character, watch the test fail, revert), `-full-suite`.
   - **(b) Refactor with existing coverage** → Grep for tests covering the touched symbols (none → it is bucket (a)); after the change `-post-refactor` must be green **with zero edits to test files** (`git diff --name-only` shows no test file; one does → the behavior changed, reclassify as (a)). The `-baseline` and `-post-refactor` captures are the before/after proof.
   - **(c) Non-testable change** (docs, comments, config value, formatting, dependency bump) → say so in the commit body in one line; still run `-full-suite` when runtime could be affected (dependency, config, build script).
4. **One focused commit:** `chore(<ID>): <description>` or `fix(<ID>): <description>` — never `feat(...)` (feat commits belong to sprint stories and feed release notes). Wanting a second commit means the task has outgrown the lane (rule 5).
5. **Escalate instead of growing.** The moment you would make a design decision worth writing down, touch ≥2 substantive files with logically independent changes, or introduce a new public API/module/pattern, the task has outgrown land-now. Then: leave **no half-built change on the branch** — `git stash push -u -m "<ID> escalated"` (or discard if nothing worth keeping), report what was learned, `shipyard-data task set-status <ID> dropped --force` is NOT used; instead `shipyard-data task set-status <ID> open` and `shipyard-data cursor escalate execute reason=escalate_to_discuss next_action="/ship-discuss <ID>"` — the terminal outcome is `escalate_to_discuss`, never success. Tell the user: "Promote with `/ship-discuss <ID>` (refine lane)". Ambiguous description with several plausible approaches → render the approaches as chat text, then AskUserQuestion; never pick silently.
6. **Done** = capture files for every phase exist, the commit exists, `shipyard-data task set-status <ID> done`.

**Terminal (stage_id: terminal_single_task).** Print `Task complete.` first, then `shipyard-data cursor advance execute terminal_single_task status=complete outcome=success reason=task_complete next_action="Task complete"`. The CLI appends `pipeline_terminal`, re-renders PROGRESS.md, and prints the `▶ CYCLE COMPLETE — pipeline terminal. /goal should stop.` marker as the final line; echo it.

**Parked step (not success).** Still BLOCKED after the one redispatch: print `Task needs attention — <reason>`, then `shipyard-data cursor escalate execute reason=task_needs_attention next_action="Resolve, then shipyard-data cursor resume execute"`; echo its stop marker. Never `Task complete.`

Report on success:
```
✓ Task done: <ID> — [title]
  Commit: [hash]
  Tests: [bucket a/b/c — captures: <ID>-baseline … <ID>-full-suite]
```
