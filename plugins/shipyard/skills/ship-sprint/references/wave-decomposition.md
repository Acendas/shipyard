# Task Decomposition (Step 4: 5-stage protocol) and Wave Assignment (Steps 5-7)

Detail for `/ship-sprint` PLAN-mode task decomposition and wave grouping.

## Step 4 — Decompose Tasks (5-stage protocol)

**Read first:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/task-decomposition-patterns.md` — contains the splitting patterns, walking skeleton rules, Red step examples, and effort anchors (the canonical 11 patterns are walked by `splitting-stories` at Stage 3).

Always include cleanup as explicit tasks — not afterthoughts. If architecture analysis found dead code, deprecated patterns, stale config, or migration shims, create dedicated cleanup tasks in the final wave so they don't block feature work.

**Do not write step files until Stage 4.** Follow these stages in order for each selected feature.

### Stage 1: Map acceptance criteria to task drafts

Check the feature's `tasks:` frontmatter array first — if tasks already exist from a prior session, verify each has a `First failing test:` entry in its Technical Notes (sign that the protocol was followed). If yes, skip to Stage 3 for any remaining `approved`-status tasks. If no Red step is present, re-decompose from here.

Read the feature spec's acceptance criteria (written by `/ship-discuss` in Gherkin form). List one draft entry per criterion — no step files yet, just a named mapping:

```
Criterion: "User can refresh an expired access token"  → draft: "Add JWT refresh endpoint"
Criterion: "Refresh token is invalidated after use"    → draft: "Invalidate refresh token on use"
Criterion: "Expired refresh token returns 401"         → draft: "Return 401 for expired refresh token"
```

Every final task traces to exactly one acceptance criterion or carries a label: `[infrastructure]`, `[cleanup]`, or `[spike]`.

### Stage 2: Extract the walking skeleton (Wave 1 foundation)

Before any behavior task, identify what must exist across all layers for any behavior to be testable: schema migrations, new route registrations, type/interface/enum definitions, service stubs, dependency injection wiring. Extract these into a single foundation task (see the patterns reference for the task template).

**Data features (gated):** when the feature has a `## Data Model` section or otherwise persists data, consult `${CLAUDE_PLUGIN_ROOT}/project-files/references/data-modeling-guide.md` while shaping the foundation task — ensure schema/migration, constraint (`FK`/`NOT NULL`/`UNIQUE`/`CHECK`), and index work that the feature's Data Model and Technical Notes imply are captured as explicit tasks rather than left implicit, and apply the guide's right-sizing routine to keep those tasks neither over- nor under-scoped. Skip for features with no persistence concern.

**Rule:** when the sprint needs a foundation step, it is alone in Wave 1 and every behaviour step that uses it lists it in `dependencies:`. This enforces vertical slicing — each behaviour step is a thin, independently testable end-to-end slice through the foundation. Keep the foundation as small as the contract the others need (types, a route, a stub): the smaller it is, the sooner everything else starts. A sprint whose steps need nothing new underneath has no foundation step, and its behaviour steps start in Wave 1.

If the feature has no cross-layer infrastructure needs (e.g., a pure UI wording change or isolated function fix), skip this stage and place behavior tasks in Wave 1 directly.

### Stage 3: Run each behavior draft through the splitting-stories capability skill

For each behavior draft from Stage 1, follow the **`splitting-stories` playbook** with `level: task`, the draft title and description, the AC text from the parent feature, and `domain_hints` (inferred from the parent feature's tech stack and frontmatter). The skill applies the "and" test, walks the 11 splitting patterns, rejects horizontal slices structurally, and returns either a no-split signal or a list of vertical child candidates with cited patterns and `acceptance_hint`s.

If the skill returns `candidates`, replace the draft with those children before continuing. Re-invoke on any child the model is unsure about — a single draft may need multiple passes. Do not proceed to Stage 4 until the skill returns no-split (or `partial: true` in a complex domain — see the skill's Cynefin handling) for every remaining draft.

The capability skill is the single source of truth for the patterns; the trigger phrases, examples, stack-specific notes, and selection tiebreaker live in `${CLAUDE_PLUGIN_ROOT}/skills/splitting-stories/references/patterns.md`. The local `task-decomposition-patterns.md` is kept as a sprint-level summary and may lag the canonical catalogue — when in doubt, the capability skill wins. Patterns that fire most often in software sprints:

- **Workflow steps** — sequential process steps bundled into one draft
- **CRUD operations** — "manage X" or multiple data verbs on the same entity
- **Happy path vs. edge cases** — "implement X and handle errors / validate / edge cases"
- **Make-it-work vs. make-it-fast** — any mention of caching, performance, or optimization

### Stage 4: Write the Red step, author the acceptance probe, then write the step file

For each draft that survived Stage 3:

1. **Red step.** Complete this sentence before creating the file:

   > "The first failing test for this task is: `[specific assertion]`"

   If the sentence requires "and" — Stage 3 applies again, split.
   If the sentence is vague ("tests for the auth flow") — scope is unresolved; do not write the file. Clarify the acceptance criterion before proceeding.

2. **Acceptance probe.** For `kind: feature` tasks, follow the **`authoring-acceptance-probe` playbook** to derive the smoke command from the task's acceptance criteria. Pass `feature_text` (the AC text), `parent_context` (parent feature path), and `domain_hints` (inferred from the feature's tech stack and frontmatter). The capability skill:

   - Asks the canonical "what one shell command, run from a clean state, prints observable evidence the wiring works" question.
   - Walks the probe-pattern catalogue (HTTP, CLI, library, migration, refactor, frontend, background job, config) plus the anti-patterns table.
   - Runs the quality checklist: one command, self-contained, exit-0-means-pass, observable output, deterministic, bounded ≤60s, AND fails today against the unimplemented state.
   - Returns the probe command as a YAML-ready string.

   Write the returned probe to the task's frontmatter `acceptance_probe:` field (use a YAML block scalar `|` for multi-line probes). **"Fails today" is checked by the CLI, not by eye (4.21):** once the step files and the wave list are written, run `shipyard-data sprint probes-at-base --draft` (`--next` for a sprint drafted ahead). It runs every feature step's probe on the code as it is now. A probe that already passes proves nothing when it passes later: rewrite it so it checks what the step adds, and run the command again (unchanged probes are not re-run). Only when a pass is right — a pure refactor guarded by an existing check — say so in the step: `probe_passes_at_base: "<reason>"`. A story cannot enter the sprint while a probe is unrun or passes with no reason. **Without a probe, dispatching-task-loop refuses to dispatch — task is unauthorable.** If the probe is genuinely elusive after the patterns are tried, surface to the user:

   > *"This task's acceptance criteria don't reduce to a single observable command. Should we (a) refine the criteria, (b) split into smaller tasks, or (c) mark this task `kind: research` and produce a findings doc instead? Recommended: (a)."*

   Skip probe authoring for `kind: operational` (the verify_command IS the probe — see operational task guidance) and `kind: research` (no code commit, no probe — research_output is the deliverable).

3. **Write the step file.** Use the Write tool to create `<SHIPYARD_DATA>/spec/steps/TNNN-[slug].md` from `${CLAUDE_PLUGIN_ROOT}/project-files/templates/task.md`. Required frontmatter:
   - `id`, `title`, `feature` (parent ID), `status`, `effort` (S/M/L), `dependencies`
   - **`touches`** (4.19): the files this step changes, as a list (`touches: [src/hud.c, tests/test_hud.c]`). When two steps must change the same file, name the part each one changes (`"src/app.c#render queue"`, `"src/app.c#input"`), cut the work so each has its own file, or make one wait for the other. `dependencies:` lists only what this step truly waits for: every entry adds to the chain that sets how long the sprint takes.
   - **`needs_person`** when a person has to do the step (4.0): `before` if its result changes what gets built (a spike, a device test, a decision, access to something), `after` if it only confirms what was built (a look, a manual test). With it, `person_task: "<what the person does, one line>"`, and optionally `person_minutes:` and `person_where:` (for example the device, so the end-of-sprint checks can be done in one sitting). A `before` step goes in Wave 1 and the steps that need its result list it in `dependencies:`. Nothing may depend on an `after` step. **There is no third kind:** a person is never needed in the middle of a sprint.
   - **Size is also the model (4.10).** `effort` routes the step: **S** = straightforward, runs on the light tier (Haiku) — one or two files, an exact spec, no design choice, nothing to find out; **M** = needs reasoning (build tier, Sonnet) — several files, a choice between approaches, or behaviour to work out from the code; **L** = hard (think tier, Opus) — cross-cutting, subtle, or easy to get wrong. Size honestly: an S that is not straightforward costs a failed dispatch before it climbs. A small step that still needs judgment gets `tier: build` (or `think`) in its frontmatter; a pin only raises.
   - **`kind`** (see Task Kinds below)
   - **`acceptance_probe`** for `kind: feature` (the probe authored in step 2)
   - **`verify_command`** for `kind: operational`
   - **`research_scope`** for `kind: research`

   Write the Red step into `## Technical Notes` under the heading `First failing test:`.

Step files are the **single source of truth** — title, effort, status, dependencies, touches, kind, and probe all live there.

### Stage 5: Assign effort using the adapted 8/80 rule

| Effort | Range | When to use |
|--------|-------|-------------|
| **S** | 1-4 hrs | One clear Red step, obvious implementation, pattern exists in codebase |
| **M** | 4-8 hrs | Some exploration needed, bounded scope |
| **L** | 1-2 days | Significant implementation, one coherent area, no splitting pattern fired |

For any task assigned `effort: L`: confirm the splitting patterns were checked and none fired, and the Red step covers exactly one behavior. If uncertain — AskUserQuestion: *"This task is estimated L (1-2 days). Could it split into [specific suggestions]? (split / no, it's cohesive)"*. Write the justification in Technical Notes: "L effort because: [reason]."

**No task exceeds L.** A task requiring more than 1-2 days is a feature, not a task — return it to the backlog.

---

After all stages: populate `## Technical Notes` in each step file using findings from Steps 3-3.5: architecture impact, files to modify, implementation strategy, Decision Log choices, patterns to follow, gotchas, cleanup items. Use the template in `references/task-tech-notes-template.md`. Every task must have Technical Notes — the builder reads these before writing any code. Update the feature's `tasks:` array with all final task IDs.

**INVEST output check.** After all tasks are written for a feature:
- **I (Independent):** No task in the same wave depends on another task in the same wave. Same-wave dependencies indicate a missed foundation task — revisit Stage 2.
- **T (Testable):** Every task has exactly one specific done-condition (one Red step). Multiple or ambiguous conditions — split.

**Task Kinds.** Every task has a `kind:` field that tells the executor *which agent runs it* and *what "done" means*. See `references/task-kinds.md` for the full taxonomy. Summary:
- **`kind: feature`** (default) — task writes new code or modifies existing code. Follows the TDD cycle (Red → Green → Refactor). Dispatched via the `dispatching-task-loop` capability skill (general-purpose subagent, inline prompt). Done = atomic commit containing impl + tests. This is the implicit default if `kind:` is absent.
- **`kind: operational`** — task's deliverable IS running a command and responding to its output. Examples: "run the full E2E suite and fix findings", "run `npm audit` and patch vulnerabilities", "benchmark the query planner and investigate regressions". **Requires `verify_command:`** — either a literal shell command or a config-key reference like `test_commands.e2e`. Dispatched via `dispatching-operational-task` (NOT the builder loop) because operational tasks have no Red step and no code commit. Done = `verify_output:` field populated pointing at a non-empty `shipyard-logcap` capture from a passing run.
- **`kind: research`** — task's deliverable is written findings / a decision doc; no code expected. Dispatched via `dispatching-research-task`, which owns the research execution contract and its escalation gate.

**Why this matters.** The silent-pass failure mode — task marked done without tests actually running — happens when an operational-shaped task is routed to the builder, which exits clean on an empty tree because there's no code for it to write. The `kind:` field is the load-bearing signal that prevents this.

**Kind auto-classifier.** Before writing each step file, scan the task description for operational signals — they are easy to miss by eye and the classifier is how users surface them. Signal phrases (case-insensitive):
- `run the … tests`, `run the full suite`, `run all …`
- `audit`, `scan for`, `check for` (when used as a command, not as a metaphor)
- `benchmark`, `measure`, `profile`
- `verify` / `validate` when the verification IS the deliverable (not "implement X and verify it works")
- `investigate` when the investigation is command-driven (e.g., re-run a flaky test N times)

When a signal fires, **do NOT auto-assign `kind: operational` silently.** Use AskUserQuestion: *"This task looks operational (its deliverable is running a command and responding to output, not writing code). Classify as `kind: operational` with `verify_command: [inferred]`? (yes, operational / no, it's a feature task / no, research)"* — because misclassification in either direction is costly (silent-pass for false-negative; wrong agent dispatched for false-positive). Make the recommended option first in the AskUserQuestion list. If confirmed operational and the `verify_command` is not obvious from the task description, prompt the user for it with examples from their `config.md` test_commands block.

**Task size guard:** A single builder agent has limited context. Tasks with many discrete items (migrations, endpoints, config entries, etc.) MUST be split so no single task has more than **8 discrete items** to implement. For example, "migrate 24 ConfigLoader calls" becomes 3 tasks of 8 each, not one task of 24. The builder will lose items past ~10 and silently mark the task done. Count the items in Technical Notes — if >8, split the task. Each sub-task should list its specific items in an explicit checklist in Technical Notes so the builder can verify completeness.

## Step 5 — Build Task Dependency Graph

Build the dependency graph from step files. Read each step file's frontmatter to determine which tasks depend on which. Do NOT duplicate task data into SPRINT.md — the sprint file only stores task IDs grouped by wave.

## Step 6 — Find the Bottleneck

The longest chain of steps that must wait for each other sets how long the sprint takes; everything else can run beside it. Do not work it out by hand: `shipyard-data sprint plan-score` prints it (Step 7).

## Step 7 — Wave Assignment: as wide as the dependencies allow

A wave is a group of steps that run at the same time. The aim is the **fewest waves** and the **shortest chain**, so the most work runs in parallel.

1. **Put every step in the earliest wave its `dependencies:` allow.** Wave 1: steps that wait for nothing. Wave N: steps whose dependencies all finish by wave N-1. A step in a later wave than that is refused by the CLI (`late`).
2. **Steps in one wave never depend on each other and never change the same file.** The CLI checks both from `dependencies:` and `touches:`.
3. **A wave is as wide as it comes.** The only ceiling is `execution.max_agents` (default 100 agents alive at once; `shipyard-data resolve-wave-caps` prints the numbers in force). Each story is reviewed when its own last step merges, so a wide wave does not make reviews rarer. Never cap the number of waves: that is the depth of the dependencies.
4. **Score the plan and shorten the chain.** Write the wave list into the sprint draft, then run:

   ```
   shipyard-data sprint plan-score --draft        (--next for a sprint drafted ahead)
   ```

   ```
   plan score: 9 steps in 3 waves · widest wave 6 · longest chain 3 (P001 → P004 → P009)
     wave  1 ██████ 6
     wave  2 ██ 2
     wave  3 █ 1
   ```

   Fix every problem it lists by changing the plan, never by loosening the check. Then look at the chain it names and ask of each link: **is this a real wait?**

   | The link exists because | Make it parallel by |
   |---|---|
   | Both steps change the same file | Cutting the work along the file: each step owns its file, or names its own part (`file#part`) |
   | The second needs a type, a route or a data shape from the first | Moving that contract into a small first step, so the rest of both steps runs side by side |
   | One step does two things | Splitting it (Stage 3) so the independent half leaves the chain |
   | The second really needs the first's behaviour | Nothing. That is the chain; say so |

   Re-run the score after each change. Stop when every remaining link is a real wait.
5. **Run the probes on today's code:** `shipyard-data sprint probes-at-base --draft`, and fix every probe it says already passes (Stage 4).
6. **A person at the start or at the end, never in the middle.** The score's `you:` line says what the sprint needs from the person: `you: 2 things at the start (about 10 min): … · 3 checks at the end`. The CLI refuses a `needs_person: before` step outside Wave 1 and a step that waits for an `after` step. When a person step could go either way, the rule decides: its result changes what is built → `before`; it only confirms → `after`.
7. **Show the score in the plan summary** (the first line, the bars and the `you:` line), so the owner sees how parallel the sprint is and what it needs from them before approving it.

The gate behind this: a story cannot enter the sprint, and a sprint drafted ahead cannot be queued, while `plan-score` reports a problem. `execution.parallel_plan: false` is the owner's switch to turn it off.
