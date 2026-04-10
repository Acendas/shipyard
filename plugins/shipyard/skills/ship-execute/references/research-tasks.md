# Research Task Dispatch Protocol

This reference defines how `ship-execute` runs `kind: research` tasks. Research tasks are the third leg of the task-kind taxonomy: their deliverable is a written findings doc, not code and not a command execution. Research tasks go to `shipyard-researcher` in task-driven mode (see `agents/shipyard-researcher.md` — the agent has Write scoped to `<SHIPYARD_DATA>/research/` specifically for this path).

Read `skills/ship-sprint/references/task-kinds.md` first if you're new to the three-kind taxonomy. Read `operational-tasks.md` first if you want context on why the dispatch-per-kind pattern exists (short answer: every task was implicitly `kind: feature` and "write code → atomic commit" shaped work — operational and research tasks have no code to write, so they need their own paths).

## When to use this protocol

Use this protocol **when and only when** the task file frontmatter has `kind: research`. Read the task file BEFORE spawning any agent. Do not guess the kind from the task title.

- `kind: feature` or absent → standard builder dispatch (see parent `SKILL.md` Step 3)
- `kind: operational` → `operational-tasks.md`
- `kind: research` → follow this file

**Critical:** `shipyard-builder` Step 0 HARD GATE rejects `kind: research` — if you dispatch a research task to the builder by mistake, the builder refuses with `TASK KIND MISMATCH` and emits a `task_kind_mismatch` diagnostic event. Route correctly here before the builder ever sees the task.

## Why this dispatch path exists (separate from operational)

Research tasks look superficially like operational tasks ("go do a thing and produce an output"), but the shape is different:
- **Operational** produces captured command output, iterates on findings, needs a fix-findings loop, and gates done on a non-empty `shipyard-logcap` capture from a passing run.
- **Research** produces a *written findings doc*, doesn't iterate, and gates done on a non-empty markdown file under `<SHIPYARD_DATA>/research/`. If the research fails, there's no "fix findings and re-verify" — research either produced useful findings or it didn't, and a bad answer needs human re-scoping, not another iteration.

Keeping the paths separate prevents the fix-findings loop from being misapplied to research failures (which would just produce more half-formed docs).

## Step 1 — Resolve `research_scope`

Read `research_scope:` from the task frontmatter. It's a string — either a problem statement, a research question, or a decision to make. Examples:
- `"Should we use Temporal or a home-grown executor for sprint orchestration?"`
- `"What are the tradeoffs between PostgreSQL row-level security and application-level authz for the multi-tenant API?"`
- `"Find every file in the codebase that imports the deprecated pricing.v1 module and assess migration risk."`

**If `research_scope:` is absent or empty:** HARD FAIL. Do not guess the scope from the task title. Emit `research_scope_missing` and return to the orchestrator with:
```
⛔ research_scope unresolved for task <TASK_ID>.
  Fix: add a `research_scope:` field to the task frontmatter with the question or problem
  statement the researcher should investigate, then re-run /ship-execute.
```

## Step 2 — Dispatch `shipyard-researcher` in task-driven mode

**Emit the start event** via the context block:
```
!`shipyard-data events emit research_task_started task=<TASK_ID> scope=<brief-scope-summary>`
```

**Compute the research output path.** **Do not derive the slug freshly from the task title** — that produces a slug that may not match the existing task file on disk, which causes two related bugs: (a) a human grepping for `T05-*` to find "all artifacts for this task" will miss the research doc because the slug diverges, and (b) the `research_output` field stored on the task file points at a name that doesn't share a prefix with the task filename.

Instead, **read the task's existing slug from its filename** under `<SHIPYARD_DATA>/spec/tasks/`. Use Glob with pattern `<SHIPYARD_DATA>/spec/tasks/<TASK_ID>-*.md` to find the task file, then strip the `<TASK_ID>-` prefix and `.md` suffix from the basename to get the canonical slug. The research output path is:

```
<SHIPYARD_DATA>/research/<TASK_ID>-<slug>.md
```

where `<slug>` is the exact slug already used in the task filename. Fall back to title-derivation (lowercase-kebab-case, ≤5 words) only if the task filename uses an unnumbered format without a slug separator.

**Directory creation.** Do NOT shell out to create the parent directory: POSIX `mkdir` flags do not exist on Windows cmd.exe, where they are interpreted as literal directory names (e.g., a `-p` flag becomes a folder named `-p`). Instead, rely on the `Write` tool's auto-parent-directory behavior — `Write` creates missing parents on all platforms. The `<SHIPYARD_DATA>/research/` directory will be created the first time the researcher agent writes a findings doc, no explicit step needed.

**Spawn the agent:**
```
subagent_type: shipyard:shipyard-researcher
isolation: omit (research tasks are read-only with respect to the codebase and do not need worktree isolation)
prompt: |
  Task-driven mode — kind: research

  Task: <TASK_ID>
  Task file: <SHIPYARD_DATA>/spec/tasks/<TASK_ID>-<slug>.md
  Research scope: <verbatim research_scope from task frontmatter>
  Research output path: <SHIPYARD_DATA>/research/<TASK_ID>-<slug>.md

  Read your agent body for the full task-driven-mode contract. Summary:
  1. Read the task file for context.
  2. Investigate using your standard Process (codebase search, external docs,
     cross-verify).
  3. Write the findings doc at the exact Research output path above, using
     the Findings Doc Template from your agent body.
  4. Return a structured response with research_output pointing at the path
     you wrote, a one-paragraph summary, and the findings count.

  Rules:
  - Write tool is scoped to the Research output path only. Never write elsewhere.
  - Never Edit or Bash anything — those tools are disallowed.
  - If the scope is unresolvable, return a failure message. Do NOT create a stub doc.
```

**Why no worktree isolation.** Research tasks only read the codebase and write to the SHIPYARD_DATA directory, which is outside the working tree. Isolation adds worktree setup/teardown overhead for no benefit.

## Step 3 — Parse the result

The researcher returns. Read its response for two things: the `research_output:` value (path to the doc it wrote) and the findings count.

**Success path:**

1. **Verify the output path is where you expected.** The researcher should have written exactly the `Research output path` you gave it. If it wrote somewhere else, the agent drifted — do NOT mark done, emit `research_task_bogus_pass` with `reason=unexpected_output_path`, and escalate.

2. **Verify the file exists and is non-empty.** Use the Read tool on the path:
   - File missing → `research_task_bogus_pass` with `reason=missing_output_file`.
   - File exists but has fewer than ~20 lines of substance (just a frontmatter block and empty sections) → `research_task_bogus_pass` with `reason=empty_findings_doc`.
   - File exists and is substantive → proceed.

3. **Verify the doc has at least one Finding section.** Grep for `^### Finding` in the output file. If zero matches → `research_task_bogus_pass` with `reason=no_findings_reported`. The Findings Doc Template in the agent body requires at least one numbered finding.

4. **Update the task file frontmatter.** Set:
   ```yaml
   research_output: <TASK_ID>-<slug>.md   # relative to <SHIPYARD_DATA>/research/
   status: done
   ```
   Append to `research_history:` (create the list if absent):
   ```yaml
   research_history:
     - attempt: 1
       at: <current ISO timestamp, UTC>
       output: <TASK_ID>-<slug>.md
       findings_count: <N>
   ```

5. **Emit the success event:**
   ```
   !`shipyard-data events emit research_task_passed task=<TASK_ID> output=<TASK_ID>-<slug>.md findings=<N>`
   ```

6. **Done.** Move on to the next task in the wave.

**Failure path:**

The researcher returned a failure message, or any of the gates above triggered a `research_task_bogus_pass` event. Do NOT mark the task done.

1. Append a failure entry to `research_history`:
   ```yaml
   research_history:
     - attempt: <N>
       at: <ISO timestamp>
       output: null
       findings_count: 0
       failure_reason: <the reason code from the bogus_pass event, or the agent's failure message>
   ```

2. **Decide between single-retry and escalation.** Unlike operational tasks (which have a 3-iteration fix-findings loop), research is one-shot by default. However, if the failure reason is transient (`unreachable_external_docs`, `rate_limited`, `timeout`), a single retry is appropriate:
   - **Transient failure, first attempt:** re-dispatch the agent once with the same prompt. Emit `research_task_retry` before re-dispatch. This is the only looping allowed for research.
   - **Non-transient failure, OR second attempt failed:** escalate (Step 4).

## Step 4 — Escalation

Research escalation is simpler than operational — there's no fix-findings sub-wave to try. When the task can't produce a usable findings doc:

1. Append a final `research_history` entry with `escalated: true` and the termination reason.
2. Set `status: needs-attention` on the task file. This is the same status used by operational escalation — it's recognized by `ship-sprint`'s carry-over scan (Step 1.5, check #6) and will surface on the next planning cycle for user decision.
3. Emit `research_task_escalated` with the reason.
4. Surface to the user via AskUserQuestion:
   ```
   Research task <TASK_ID> could not produce a usable findings doc.

   Scope: <research_scope>
   Reason: <termination reason>
   Attempts: <N>

   Options:
     1. Re-scope — the question may be too broad, too narrow, or ambiguous.
        Edit research_scope on the task file and I'll try again.
     2. Convert to a manual investigation — I'll create a placeholder findings
        doc and you populate it yourself.
     3. Mark the task cancelled and move on.
   ```

## Post-Subagent gate (for research tasks)

This extends the parent `SKILL.md` Step 2 "Post-Subagent" spot-check. After the research dispatch completes, before considering the task truly done, verify five things:

1. Task file has `research_output:` field (not empty, not commented out).
2. The path in `research_output:` resolves to an existing file under `<SHIPYARD_DATA>/research/`.
3. That file has non-zero byte count and contains at least one `### Finding` heading.
4. The final `research_history` entry has no `escalated: true` flag and has a `findings_count` ≥ 1.
5. **Write-scope enforcement (porcelain check).** Before this dispatch, capture the output of `git status --porcelain` on the working branch and the set of files under `<SHIPYARD_DATA>/research/`. After the dispatch, diff both. The researcher is only allowed to have modified a *single* file — the findings doc at the dispatch path. Specifically:
   - **No working-tree changes.** `git status --porcelain` must be identical to the pre-dispatch snapshot. Any new or modified file under the working tree is an out-of-scope write by the researcher.
   - **No other research/ changes.** The set of files under `<SHIPYARD_DATA>/research/` must differ by exactly one file (the expected findings doc path) — no other files added, no other files modified.
   - **No task-file mutations.** `<SHIPYARD_DATA>/spec/tasks/*.md` must be byte-identical before and after. The researcher is forbidden from editing any task file; the orchestrator owns that write and does it after this gate passes.

If any of checks 1–4 fail → emit `research_task_bogus_pass` with the specific reason (`missing_research_output`, `output_file_missing`, `empty_findings_doc`, `no_findings_reported`, `final_history_escalated`) and re-dispatch (once, transient only) or escalate.

If check 5 fails → emit `research_out_of_scope_write` with the list of unexpectedly touched files. This is more serious than a bogus pass — the researcher violated its contract. Do NOT mark the task done, do NOT retry (retrying would just produce another out-of-scope write). Escalate directly to Step 4 with `reason=out_of_scope_write`. The user needs to see the offending writes, decide whether to revert them, and decide whether the researcher prompt or the agent body needs tightening.

This is the last line of defense for the research path — same pattern as the operational gate, plus the write-scope enforcement that operational tasks don't need (because `shipyard-test-runner` is fully read-only with no Write tool at all).

## Event taxonomy

| Event | When | Fields |
|---|---|---|
| `research_task_started` | Step 2, before spawning the researcher | `task`, `scope` (brief) |
| `research_task_passed` | Step 3 success path, after gate | `task`, `output`, `findings` |
| `research_task_retry` | Step 3 failure path, transient retry before re-dispatch | `task`, `reason` |
| `research_task_bogus_pass` | Post-subagent gate catches missing/empty/invalid output | `task`, `reason` |
| `research_out_of_scope_write` | Post-subagent porcelain check catches researcher writes outside the dispatch path | `task`, `files` |
| `research_task_escalated` | Step 4, escalation | `task`, `reason`, `attempts` |
| `research_scope_missing` | Step 1, `research_scope:` absent or empty | `task` |
| `research_task_started` NOT followed by `_passed` or `_escalated` | Smoking gun — research started but never resolved | — |

A missing `research_task_passed` for a task whose status is `done` and `kind` is `research` is the diagnostic signature for research silent-pass (same shape as the operational smoking gun). `shipyard-context diagnose` surfaces this class.

## What NOT to do

- **Do not spawn `shipyard-builder` for a research task.** The builder has a HARD STOP guard (Step 0) and will refuse — if you somehow bypass it, the task gets silently marked done on an empty tree, same silent-pass failure mode as operational.
- **Do not write `research_output:` to the task file by hand** or from a skill body before the gate passes. It is set by this protocol after Step 3 validation.
- **Do not loop-iterate on research failures.** Research is one-shot with a single transient retry. If the researcher can't produce a usable doc, the answer is user decision, not more agent attempts.
- **Do not create a stub findings doc** to satisfy the gate. An empty-ish `### Finding` heading with placeholder text is worse than no doc — it looks like the work was done.
- **Do not nest research tasks.** Research tasks cannot spawn nested work of any kind in this release. If a research investigation surfaces the need for follow-up research, surface it as a new task for the next sprint, not inline.
