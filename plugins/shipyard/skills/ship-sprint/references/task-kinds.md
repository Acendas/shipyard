# Task Kinds

Every Shipyard task has a `kind:` field in its frontmatter. The `kind:` determines **which agent executes the task** and **what "done" means for that task class**. Get the kind wrong and the execution pipeline silently fails — the builder will exit clean on an empty tree for a task that was supposed to run a command, and mark it done without ever running anything.

This file is the authoritative definition of the taxonomy. When planning a sprint, read this before writing task files.

## The three kinds

| Kind | Executor | "Done" means | Required fields |
|---|---|---|---|
| `feature` (default) | `shipyard-builder` | Atomic commit containing impl + tests (Red → Green → Refactor) | — |
| `operational` | `shipyard-test-runner` | `verify_output:` points at a non-empty logcap capture from a passing run | `verify_command:` |
| `research` | `shipyard-researcher` | `research_output:` points at a findings doc under `<SHIPYARD_DATA>/research/` | — |

Absent `kind:` is treated as `feature` — every legacy task file keeps working without migration.

## `kind: feature`

The default. A task that writes new code or modifies existing code. The builder runs the TDD cycle: write the failing test first (RED), implement the smallest change that passes it (GREEN), refactor (REFACTOR), commit atomically (`feat(TASK_ID): …`). The exit gate is a clean git tree + a commit whose subject contains the task ID.

Examples:
- "Add JWT refresh to the auth middleware"
- "Extract the pricing engine into its own module"
- "Fix the off-by-one in paginator.nextPage()"

Don't use this kind when the work is primarily "run something and respond to output" — that's `operational`.

## `kind: operational`

A task whose deliverable *is* running a command and responding to the output. There is no Red step (the command already exists), no atomic commit (no code to write up front), and the "done" condition is **output captured from a passing run**, not a commit landing.

### Required frontmatter
```yaml
kind: operational
verify_command: test_commands.e2e     # config-key reference, OR
verify_command: "npm run test:e2e"    # literal shell command
```

The `verify_command` is either a literal shell command or a reference into `<SHIPYARD_DATA>/config.md` (dotted path — e.g. `test_commands.e2e` resolves to the `e2e` key under `test_commands`). Literal commands are the common case for one-offs; config references are preferred when the same command shows up in multiple tasks so it can be updated in one place.

### Optional frontmatter
```yaml
verify_max_iterations: 5        # override the default (3) for a known-flaky suite
verify_output: <logcap-path>    # populated by ship-execute on success — do NOT set by hand
verify_history:                 # appended by ship-execute on each attempt
  - attempt: 1
    at: 2026-04-08T10:14:00Z
    exit: 1
    capture: <logcap-name>
    findings: 3
  - attempt: 2
    at: 2026-04-08T10:42:00Z
    exit: 0
    capture: <logcap-name>
    findings: 0
```

### Execution contract

1. ship-execute reads `kind:` and routes operational tasks through `skills/ship-execute/references/operational-tasks.md`, NOT through the builder.
2. The dispatcher resolves `verify_command` against `config.md` if it's a config reference, then runs it via `shipyard-logcap run <task-id>-verify -- <cmd>`.
3. On pass (exit 0, capture non-empty) → write `verify_output:` to the task file, append to `verify_history`, mark done.
4. On fail → parse findings from the capture, create `kind: feature` patch tasks inline (recursion forbidden — patch tasks cannot themselves be operational), dispatch the builder for each, then re-run verify. Up to `operational_tasks.max_iterations` *verify runs total* (default 3 — meaning the initial failed verify plus at most 2 re-verifies, then escalate). See `skills/ship-execute/references/operational-tasks.md` Step 4 for the exact counter semantics.
5. On the 4th failure (or cumulative patch tasks > 5 across iterations), escalate: `AskUserQuestion` to promote the findings into a proper patch-task set for a future wave, rather than growing the sprint silently.
6. **`shipyard-builder` HARD STOPs if dispatched an operational task.** Routing bug detection. Emits `task_kind_mismatch` event.

### Examples

**"Run the full E2E suite and fix findings"** — the task that motivated this kind:
```yaml
id: T07
kind: operational
title: Run E2E suite and fix findings
verify_command: test_commands.e2e
effort: L
```

**"Run `npm audit` and patch criticals"**:
```yaml
id: T12
kind: operational
title: Audit dependencies and patch criticals
verify_command: "npm audit --audit-level=critical"
effort: M
```

**"Benchmark query planner, investigate regressions > 10%"**:
```yaml
id: T19
kind: operational
title: Benchmark query planner
verify_command: "npm run bench:planner"
effort: M
```

### Anti-patterns

- **Don't hide an operational task inside a feature task body.** If the acceptance criterion is "E2E passes," and you route it through the builder, the builder will not run E2E (the "never run the full suite during TDD" rule forbids it) and will mark the task done on a clean tree. That is the exact silent-pass bug this kind exists to prevent.
- **Don't nest operational tasks.** A patch task spawned inside the fix-findings loop must be `kind: feature`. If the patch work itself is operational ("run migration N and verify"), promote it to its own top-level operational task in a follow-up sprint — don't recurse.
- **Don't skip `verify_command`.** It's required for a reason: without it, the executor has no command to run and will either crash or (worse) fall back to marking the task done. The Definition-of-Ready gate in ship-sprint Step 9.5 rejects operational tasks without `verify_command`.

## `kind: research`

A task whose deliverable is a written findings doc — no code change, no command run. Dispatched to `shipyard-researcher` in **task-driven mode** (the agent has `Write` scoped *by contract* to the single findings doc at the dispatch path — out-of-scope writes are caught by the post-subagent porcelain check and fail the task). Done = `research_output:` field points at a markdown file under `<SHIPYARD_DATA>/research/` that contains at least one `### Finding` section.

### Required frontmatter
```yaml
kind: research
research_scope: "Should we use Temporal or home-grown for sprint orchestration?"
```

The `research_scope` is a string — a problem statement, research question, or decision to make. Must be non-empty at Definition-of-Ready, or ship-sprint will reject the task.

### Optional frontmatter
```yaml
research_output: <TASK_ID>-<slug>.md   # populated by ship-execute on success — DO NOT set by hand
research_history:                      # appended on each attempt
  - attempt: 1
    at: 2026-04-08T10:14:00Z
    output: <TASK_ID>-<slug>.md
    findings_count: 5
```

### Execution contract

1. ship-execute reads `kind:` and routes research tasks through `skills/ship-execute/references/research-tasks.md`, NOT through the builder.
2. The dispatcher validates `research_scope:` is present, then spawns `shipyard-researcher` in task-driven mode. The agent receives the task file path, the scope, and an exact output path (`<SHIPYARD_DATA>/research/<TASK_ID>-<slug>.md`).
3. The researcher investigates using its standard process (codebase search, external docs, cross-verify), then uses its scoped `Write` tool to create the findings doc following the template in the agent body.
4. On success → dispatcher validates the output file exists, is non-empty, and has at least one `### Finding` section. Writes `research_output:` to the task file, appends to `research_history`, marks done. Emits `research_task_passed`.
5. On failure (missing output, empty doc, zero findings) → dispatcher emits `research_task_bogus_pass` and does NOT mark done. Single transient retry allowed for network/timeout failures; otherwise escalate to `status: needs-attention`.
6. **No fix-findings loop.** Unlike operational tasks, research is one-shot. A failed research attempt needs user re-scoping, not more agent iterations.
7. **`shipyard-builder` HARD STOPs if dispatched a research task.** Same routing-bug detection pattern as operational.

### Example

**"Research whether Temporal fits our sprint executor"** — a classic research task:
```yaml
id: T05
kind: research
title: Research whether Temporal fits sprint executor
research_scope: "Evaluate Temporal vs home-grown for wave execution. Compare: ops burden, learning curve, operational visibility, cost, lock-in. Recommend one."
effort: M
```

The researcher investigates, writes `<SHIPYARD_DATA>/research/T05-temporal-evaluation.md` with findings (Problem Statement, Methodology, Findings with confidence levels, Recommendation, Gotchas, Sources), and returns the path. The dispatcher updates the task to `status: done`, `research_output: T05-temporal-evaluation.md`.

### Anti-patterns

- **Don't smuggle code work into a research task.** If the task involves writing code, it's `kind: feature`. Research is pure investigation — no Edit, no Bash, no commits.
- **Don't use research for "fix flaky test by re-running".** That's operational (a command is being run repeatedly to gather data). Research is for decisions and investigations that produce written conclusions.
- **Don't accept an empty findings doc.** A stub doc with "TODO: investigate" as the only content is worse than no doc — it looks like work was done. The gate in `research-tasks.md` catches this (`reason=empty_findings_doc` / `no_findings_reported`), but authors should know: if the researcher couldn't find useful findings, the task should escalate, not produce a placeholder.
- **Don't nest research tasks.** If a research investigation uncovers another investigation need, create a new top-level task for the next sprint, not a nested dispatch.

## Classifier heuristics (for ship-sprint Step 4)

When decomposing a feature into tasks, scan the task description for signals that it should be `kind: operational`:

| Signal | Example | Suggested kind |
|---|---|---|
| "run the \_\_\_ tests" / "run the full suite" / "run all \_\_\_" | "run the integration tests against staging" | operational |
| "audit" / "scan for" / "check for" | "audit dependencies for CVEs" | operational |
| "benchmark" / "measure" / "profile" | "benchmark the API latency" | operational |
| "verify" / "validate" (where the verification IS the deliverable) | "verify all migrations apply cleanly" | operational |
| "investigate" (command-driven) | "investigate the flaky test XYZ by re-running 50 times" | operational |
| Contains only "write/implement/add/fix \_\_\_ code" | "add refresh-token rotation to auth middleware" | feature |
| Contains only "document \_\_\_" / "research whether \_\_\_" | "research whether Temporal fits our sprint executor" | research |

When the signal fires, ship-sprint should `AskUserQuestion` to confirm the kind before writing the task file — auto-assigning operational silently would surprise users. If confirmed, populate `verify_command:` from the task description or prompt the user for it.
