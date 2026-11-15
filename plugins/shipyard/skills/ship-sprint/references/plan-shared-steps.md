### Step 3: Research Before Planning

Apply the planning checklists from `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/planning-checklists.md` throughout Steps 3-9 (Definition of Ready, cross-cutting concerns, risk register, MoSCoW, three-point estimation, test strategy).

**Delegate per-feature research to `general-purpose` subagents in sprint-analyst mode — one per selected feature, all spawned in parallel** (single message, N tool calls). Each analyst returns a structured `SPRINT ANALYST REPORT`.

See `references/sprint-analyst-report.md` for the full analyst-dispatch prompt template and report schema. Use the analyst output directly in Step 4 task decomposition. If a report flags low-confidence findings, the orchestrator validates them inline (LSP first, then Grep / WebSearch).

### Planning-decisions round (Steps 3.5–3.75) — confidence-gated, one card each

Steps 3.5 (rule violations), 3.55 (terminology), 3.7 (implementation decisions), and 3.75 (simplification routing) all surface *decisions*. Run them through the confidence gate + kill-list from `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/question-design.md` before asking anything:

- **HIGH tier** (evidence converges AND two-way door) → **decide and inform.** Print one line — `Going with X — [≤10-word why]. (say 'change' to override)` — and log an `ASSUMED: <decision> — <evidence> — reversible: yes` entry in the relevant feature's `## Decision Log`. Never for one-way doors (schema shapes, external/API contracts, auth, migrations — those stay asks).
- **MEDIUM / LOW** → collect them across all four steps and ask them **one card at a time** (one question per `AskUserQuestion` call, recommended option first and labeled); a card with more than one question is refused by the hook. Say how many there are before the first.

Before each card, render that decision as chat text — options, tradeoffs, what the codebase/research found, and the recommendation. Detection output sitting in an analyst report, a Read result, or the reference files does not count as rendered, and packing tradeoffs into the option strings does not count.

The audit point is the **ASSUMPTIONS MADE** list in the Step 11 plan summary.

### Step 3.5: Rules Compliance Check

Verify selected features comply with current project rules — rules may have been added or updated AFTER features were discussed. See `references/spec-validation.md` § "Step 3.5" for the contradiction-detection process and the per-violation AskUserQuestion options (update spec / send back to discuss / override rule / remove scenario). Features sent back to discuss are removed from this sprint's selection.

### Step 3.55: Terminology Alignment Check

Verify spec language matches what the codebase actually calls things. See `references/spec-validation.md` § "Step 3.55" for term-extraction, codebase search, mismatch-table format, and the per-mismatch AskUserQuestion (update spec / update code / keep both). Skip on greenfield. Update story files with resolved terminology before decomposing tasks.

### Step 3.6: Definition of Ready Gate

Before decomposing, verify each feature is ready. Run the DoR checks, Cross-Cutting Concerns Audit, and Knowledge Gap Assessment from `planning-checklists.md`. See `references/spec-validation.md` § "Step 3.6" for details.

### Step 3.7: Surface Implementation Decisions

After research, identify every point where there's a meaningful choice — don't silently pick one. Score each through the confidence gate (Planning-decisions round, above): HIGH-tier two-way-door calls become one-line `Going with X` inform + `ASSUMED:` log entries; MEDIUM/LOW are asked one card at a time. If research can't resolve a decision, offer a POC spike (options: spike it / pick one / defer).

See `references/implementation-decisions.md` for the full catalogue of decision-point types, the explanation/AskUserQuestion templates, the POC spike subagent dispatch (`isolation: "worktree"`, throwaway), and Decision Log recording. Write findings into each step file's `## Technical Notes` after Step 4 creates them.

### Step 3.75: Simplification Opportunity Scan

Now that research has identified libraries, patterns, and utilities this sprint will introduce, scan the codebase for simplification opportunities. See `references/implementation-decisions.md` § "Step 3.75" and the full protocol at `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/simplification-scan.md`.

Skip if no selected feature introduces new libraries/utilities/patterns. Routing: trivial → extend existing task; small → new cleanup task in final wave; medium/large → IDEA file. Scope guard: trivial+small ≤ 20% of sprint capacity. Then AskUserQuestion: "Apply these simplification opportunities? (all / pick / skip)".

### Steps 4-7: Decomposition Deep-Dive (dispatched to a think-tier agent)

Steps 4-7 (task decomposition via the 5-stage protocol, dependency graph, bottleneck, wave assignment) are the heaviest analytical work in planning. Dispatch them to deep-dive agents, **one per story group, all in one message** (below). The shell keeps the user gates (Steps 3.5-3.7, 8-12), all validation, final step-file writes, and CLI-owned feature `tasks:` updates; the agent owns the decompose-and-wave analysis and returns draft task specs.

**Model + effort (think).** Run `shipyard-data resolve-model think` — it prints exactly one line `model=<m> effort=<e>`; pass each value as a string on the Agent call and OMIT any field whose value is empty (inherit). Never hardcode a model literal or re-derive the tier from config.md by hand. Log it once: `shipyard-data events emit dispatch_model_resolved role=<role> model=<model or inherit> effort=<effort>` (a logging failure never blocks the dispatch). The resolver also returns `agent_effort.think` (default `high`).

**Plan the plan in parallel (4.0).** Group the selected stories: stories that depend on each other or that the analysts found in the same files go in one group; every other story is its own group. One group (a single story, or stories that are all tied together) → one agent, as before. Two or more groups → one agent per group, all dispatched in one message; each decomposes only its own stories and returns its drafts with each step's `dependencies:` and `touches:`. No agent assigns sprint-wide waves: after the returns the shell writes the step files, puts every step in the earliest wave its `dependencies:` allow, and runs `shipyard-data sprint plan-score --draft`. A problem between two groups (two steps of one wave on one file) is fixed there: narrow the entry to `file#part` when the parts are really separate, else add the dependency. **Why:** a seven-story plan spent 13 of 47 minutes waiting for one agent to decompose stories that had nothing to do with each other.

**Dispatch** each as `Agent(subagent_type: "general-purpose", model: <model= from resolve-model think; omit if empty>, effort: <effort= from resolve-model think; omit if empty>)` with a prompt that inlines:

- Its group's stories (their file paths under `<SHIPYARD_DATA>/spec/stories/`, plus any Step 3 analyst reports / Step 3.7 decisions already gathered).
- Capacity (the story-point budget from Step 1).
- Config knobs: `max_agents` and the execution-mode thresholds (from the config block).
- The literal SHIPYARD_DATA path (substitute it — the agent may Read from it, but final task writes happen in the shell after gates resolve).
- The reference path `${CLAUDE_PLUGIN_ROOT}/skills/ship-sprint/references/wave-decomposition.md`, which the agent **Reads and follows** — it is the full protocol for all four steps (Stage 1 map AC → drafts; Stage 2 walking-skeleton foundation → Wave 1; Stage 3 splitting patterns via `splitting-stories`; Stage 4 Red step + acceptance probe via `authoring-acceptance-probe` + write step file; Stage 5 effort; then Steps 5-7 dependency graph / bottleneck / wave assignment). The agent also reads `references/task-decomposition-patterns.md`, `references/task-kinds.md`, and `references/task-tech-notes-template.md` as that protocol directs, applies the kind auto-classifier, the >8-item task-size guard, and the wave rule (every step in the earliest wave its `dependencies:` allow; a wave as wide as it comes, up to `execution.max_agents`; `execution.max_tasks_per_wave` only when the owner set it; each step declares its `touches:`; then `shipyard-data sprint plan-score --draft` until it reports no problem and every link of the longest chain is a real wait — wave COUNT is never capped), and runs the INVEST output check.

**Draft-first handoff.** The deep-dive returns draft task specs, gate flags, the wave plan, the critical path, and bottleneck; it does **not** write final step files and does **not** run `shipyard-data story set-steps`. The shell resolves any required AskUserQuestion gates before writing final step files. After all gates resolve, the shell allocates IDs with `shipyard-data next-id steps`, Writes each `<SHIPYARD_DATA>/spec/steps/TNNN-<slug>.md` from the template, then updates each parent feature's CLI-owned `tasks:` frontmatter array with `shipyard-data story set-steps <SID> <PID,PID,...>` after the final step files exist; never hand-Edit `tasks:`.

**Return contract (the agent's final text):** draft task specs grouped by parent feature (title, kind candidate, acceptance probe or verify/research fields, effort, dependencies, Technical Notes including `First failing test:` for feature tasks), the gate flags requiring shell AskUserQuestion, the draft wave plan, the critical path, the bottleneck, and points per wave. Use provisional labels (`draft-1`, `draft-2`) in the wave plan; the shell maps them to real TIDs after gates resolve.

**Shell structural verification (on return).** Before trusting the plan: (1) resolve all gate flags with the user, (2) allocate final task IDs and write the step files, (3) run `shipyard-data story set-steps` only after every referenced step file exists and belongs to that feature, (4) confirm each selected feature has ≥1 step file (Grep `feature:` frontmatter, or check the feature's `tasks:` array is non-empty), and (5) **normalize acceptance-criteria ids**: run `shipyard-data story assign-ac-ids <SID>` for each selected feature. This idempotently tags every Gherkin scenario in the feature with a stable `@AC-<n>` id so the sprint-complete AC-coverage gate (`verify-ac-coverage`) has something to key on and builders know which `// AC-<n>` markers to emit. If these hold, follow the **Exit** line at the end of these shared steps.

**Fallback.** On dispatch failure, or if the structural verification fails (missing step files, a selected feature with no task), fall back to running Steps 4-7 **inline** in the shell, following `references/wave-decomposition.md` directly (§ "Step 4" 5-stage protocol, § "Step 5" dependency graph, § "Step 7" wave assignment). Note the fallback in the user-facing text so the slower inline path is visible.

Any AskUserQuestion the protocol would raise (operational-kind classification, `effort: L` split confirmation) is surfaced by the **shell** after the deep-dive returns and **before** final step files or feature `tasks:` arrays are written. The dispatched agent flags candidates in its return, and the shell runs the user gate. Never run AskUserQuestion inside the dispatched agent. When surfacing a flagged candidate, first render as chat text what the agent found — the task in question, the signal that fired, and the split suggestions or inferred `verify_command`; then ask.

## Rules

- Capacity is a hard constraint: >10% over → AskUserQuestion (proceed / drop [ID] / adjust capacity).
- Check cross-feature dependencies — if S009 depends on S001 which isn't done → AskUserQuestion: "[Feature] depends on [dependency] which isn't done yet. Include [dependency] in this sprint, defer [feature], or proceed anyway? (include / defer / proceed)"
- Circular dependencies → reject, explain why.
- Never auto-carry-over from previous sprint — user must explicitly re-select.
- When ambiguous, run the confidence gate + kill-list from `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/question-design.md` first; only MEDIUM/LOW decisions reach `AskUserQuestion`; resolve the ambiguity before reaching for a prompt.

**Exit.** PLAN: mark Steps 4-7 checklist rows `completed`, go to Step 8. EXTEND: Steps 3-4 only (no checklist; Step 5+ and Step 11 mentions are PLAN-only); go to Step E4. Capacity: Step 1's in PLAN, E2's remaining in EXTEND.
