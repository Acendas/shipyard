# Spec Validation — rules, terminology, DoR, quality gate, adversarial critique

Detail for the validation steps in `/ship-sprint` PLAN mode (Steps 3.5, 3.55, 3.6, 9.5, 9.7).

## Step 3.5 — Rules Compliance Check

Before anything else, verify selected features comply with current project rules. Rules may have been added or updated AFTER features were discussed — specs can be stale.

**Process:**
1. Read ALL project rules: glob `.claude/rules/project-*.md` and `.claude/rules/learnings/*.md`
2. For each selected feature, read its acceptance criteria and Technical Notes
3. Check for contradictions — does any acceptance scenario violate a rule?

**Common contradictions:**
- Feature spec says "poll every N minutes" but rules say "event-driven first"
- Feature spec says "store in local file" but rules say "use database for persistent state"
- Feature spec assumes a pattern that learnings say to avoid
- Feature spec uses terminology that doesn't match domain vocabulary in rules

**For each violation found:** Output the explanation (what the spec says, what the rule says, why they conflict), then AskUserQuestion:

```
S010 Scenario 4 contradicts .claude/rules/event-driven-first.md:
  Spec says: "periodic 1hr health check"
  Rule says: "prefer event-driven push over polling"

1. Update spec — rewrite the scenario to comply (I'll update the story file now)
2. Send back to discuss — this feature needs rethinking (/ship-discuss S010)
3. Override rule — the spec is intentionally different here (document why in decision log)
4. Remove scenario — it's no longer needed

Recommended: 1 — the spec predates the rule, update to match current architecture
```

After resolving all violations, proceed. Features sent back to discuss are removed from this sprint's selection.

## Step 3.55 — Terminology Alignment Check

Verify that the language in feature specs matches what the codebase actually calls things. Mismatched terminology causes builders to create duplicate code, use wrong APIs, or implement against the wrong abstractions.

**Process:**

1. **Extract key terms from each feature spec** — entity names, API endpoints, component names, state names, event names, database table/column names mentioned in acceptance criteria, data model, or interface sections
2. **Search the codebase for each term** — Grep for the exact name and common variants (camelCase, snake_case, PascalCase, plural/singular):
   - Does this entity/component/table exist in code?
   - What is it actually called? (the spec might say "user" but code says "account", spec says "notification" but code says "alert")
   - Are there naming convention differences? (spec says "payment_status" but code enum is `PaymentState`)
3. **Check domain vocabulary** — if `.claude/rules/project-*.md` defines a domain vocabulary (term mappings, canonical names), verify spec terms match
4. **Report mismatches:**
   ```
   TERMINOLOGY MISMATCHES — S009: Maintenance Requests

   Spec says          Code uses           Where in code
   ─────────────────────────────────────────────────────
   "tenant"           "organization"      src/models/Organization.ts
   "maintenance_req"  "service_request"   src/api/serviceRequests.ts
   "submitted"        "pending"           src/types/RequestStatus.ts
   "admin"            "manager"           src/auth/roles.ts
   ```

   For each mismatch, AskUserQuestion:
   ```
   1. Update spec — use the code's terminology (recommended for existing entities)
   2. Update code — rename to match the spec (only if the spec term is better)
   3. Keep both — they're different concepts despite similar names (document the distinction)
   ```
5. **Update story files** with resolved terminology before decomposing tasks. This prevents builders from creating `Tenant` models when `Organization` already exists.

Skip this step if the codebase is empty (greenfield project — no existing terms to conflict with).

## Step 3.6 — Definition of Ready Gate

Before decomposing, verify each feature is ready. Run the Definition of Ready checks from `planning-checklists.md`. If any feature fails → send back to `/ship-discuss` or resolve now.

Also run the **Cross-Cutting Concerns Audit** from the checklists — for each feature, check auth, logging, caching, rate limiting, analytics, feature flags, background jobs, notifications, search, migration, config. Record what's needed in task Technical Notes.

Run the **Knowledge Gap Assessment** — flag tasks in unfamiliar domains, add research time to estimates.

## Step 9.5 — Quality Gate (self-review loop)

Before presenting the plan, review your own output. Re-read each step file and the sprint draft, checking:

| # | Check | Fail criteria |
|---|---|---|
| 1 | **Every task has files-to-modify identified** | Architecture section empty or says "TBD" |
| 2 | **Architecture layers mapped per task** | No layers/blast radius/boundaries listed |
| 3 | **No task depends on something undefined** | Dependency references a task ID that doesn't exist |
| 4 | **Implementation strategy is prescriptive** | "Consider X or Y" instead of "Use X" |
| 5 | **Cleanup tasks captured** | Architecture analysis found dead code/deprecated patterns but no cleanup task exists |
| 6 | **No circular dependencies** | Task A → B → C → A |
| 7 | **Every task has clear acceptance criteria** | Task description is vague ("implement feature") without specific deliverable |
| 8 | **Effort estimates present** | Any task has no S/M/L effort |
| 9 | **Critical path makes sense** | Bottleneck task has no clear reason for being the bottleneck |
| 10 | **Wave assignment respects dependencies** | A task appears in the same wave as a task it depends on |
| 11 | **Test strategy present** | Any task has no Test Strategy section |
| 12 | **Cross-cutting concerns addressed** | Feature needs auth/logging/caching but no task covers it |
| 13 | **Risk register populated** | Sprint has critical-path or external deps but no risks section |
| 14 | **MoSCoW classified** | Acceptance criteria not tagged MUST/SHOULD/COULD/WON'T |
| 15 | **PERT estimates for uncertain tasks** | High-uncertainty task has single-point estimate only |
| 16 | **Every `kind: operational` task has a non-empty `verify_command`** | Operational task missing `verify_command` → rejected at DoR. Without this the executor has no command to run and will either crash or (worse) fall back to marking the task done. See `references/task-kinds.md`. |
| 17 | **No `kind: operational` task is nested inside another operational loop** | Patch tasks created by the fix-findings loop MUST be `kind: feature`. Operational → operational recursion is forbidden. |
| 18 | **Every `kind: research` task has a non-empty `research_scope`** | Research task missing `research_scope` → rejected at DoR. Without it the researcher has no question to investigate and will fail loud at dispatch (`research_scope_missing` event). See `references/task-kinds.md`. |
| 19 | **Every `kind: feature` task has a `First failing test:` in Technical Notes** | Technical Notes missing this section means the Stage 4 Red step protocol was skipped — the builder has no TDD starting point and may silently invent scope. Re-derive the Red step and add it before approval. |
| 20 | **No `kind: feature` task title contains "and" joining two independent behaviors** | "Implement X and add Y", "Update X and fix Y" patterns indicate Stage 3 splitting was missed. Split the task; two behaviors means two tasks. |
| 21 | **Every Technical Notes deliverable maps to a task** | A feature's Technical Notes section names a concrete artifact ("Author must write a Playwright spec covering X", "One Y test covering Z", "Add a Q migration", named files like `tests/e2e/*.spec.ts`) but no step file's "Files to modify" or "Deliverables" references it. Either (a) add a task that owns the artifact, (b) elevate the artifact into an explicit acceptance criterion so it gets decomposed, or (c) capture it as an IDEA and link it (`source: backlog-deferred IDEA-NNN`). Conservative extraction — only flag concrete artifacts (named files, named tools, "must write X" patterns), NOT general guidance like "we should consider Y". |
| 22 | **Data work is decomposed (gated — data features only)** | ONLY fires when a feature in scope has a `## Data Model` section (skip entirely for non-data sprints — no false positives on, e.g., a pure-UI sprint). When it fires: the schema/migration the Data Model implies has an owning task; the constraints it names (FK / NOT NULL / UNIQUE / CHECK) are captured rather than left implicit; and an index task exists for any hot-query predicate or new foreign key called out in the feature's Technical Notes. Also flag a Data Model that ships a schema-shape anti-pattern (EAV, OTLT, god table) or a mutable-business-value primary key — those are design defects that should have been caught in discuss; surface for the user. Consult `${CLAUDE_PLUGIN_ROOT}/project-files/references/data-modeling-guide.md`. Fix by adding the missing schema/migration/index/constraint tasks (or routing the anti-pattern back to `/ship-discuss`). |
| 23 | **The plan is as parallel as its dependencies allow** | `shipyard-data sprint plan-score --draft --check` (add `--next` for a sprint drafted ahead) exits 0. It refuses a step in a later wave than its `dependencies:` require, a step that waits for its own wave, two steps of one wave that touch the same file, a step with no `touches:` in a shared wave, `solo` over a wide wave, a wave wider than `execution.max_agents`, a `needs_person: before` step outside Wave 1, and a step that waits for a `needs_person: after` step. Fix the plan, never the check. Then read the chain it names and remove every link that is not a real wait (wave-decomposition.md Step 7). |
| 23b | **Every probe fails first** | `shipyard-data sprint probes-at-base --draft` (add `--next` for a sprint drafted ahead) exits 0: each feature step's `acceptance_probe` was run on the code as it is today and fails, or the step states why a pass is right (`probe_passes_at_base:`). A probe that already passes is rewritten, never waved through. |
| 24 | **Every feature entering the sprint has a `user_flow_probe:`** | **Do NOT eyeball this row — run the gate.** Execute `shipyard-data story check-probes <all in-scope feature IDs>` (one call, space-separated, bare from the project root — it resolves the data dir itself). Exit 0 = pass; exit 3 names the features lacking a valid `user_flow_probe:` (a valid one has a `kind` of `auto`/`assisted`/`manual`, or is `skip-with-reason` with a populated `user_flow_probe_skip_reason`; a legacy scalar `demo_probe:` counts). This is the proof the feature works *for a user* — distinct from per-task `acceptance_probe` (wiring inside one task) and from the full test suite (neither exercises the path a user takes). **A non-zero exit is a hard planning blocker, not a "planning gap" to defer:** the model self-review used to pass features through here, so they built for hours before `/ship-execute`'s pre-flight gate caught the omission at sprint-completion cost. The CLI makes this row a data-artifact gate, matching the pipeline-gate rule. Fix by authoring the probe with `/ship-discuss <feature-id>`, then re-run `check-probes`; do not proceed to Step 9.7 until it exits 0. |
| 24b | **Every story entering the sprint starts from the behaviour** | Run `shipyard-data story check-scenarios <all in-scope story IDs>`. Exit 3 lists what is missing (scenario ids, one level tag each, `# why not e2e:` on a lower level, the `## Paths` map). A story written before this rule is fixed here, now: add the map and the tags from its existing scenarios, then re-run. |
| 25 | **Every UI story (`ui: true`) entering the sprint has an approved, unchanged design snapshot** (E005) | **Run the gate, do not eyeball it.** Execute `shipyard-data design check <all in-scope story IDs>`. Exit 0 = pass (non-UI stories report `NOT-UI`). Exit 3 names stories that are `MISSING` an approval, whose snapshot `DRIFTED` after sign-off, or whose file is gone — a **planning blocker**: route them to `/ship-discuss <story-id>` (DESIGN stage, `design approve` as a new version) and re-run until it exits 0. UI steps are built against the approved snapshot (render-and-look) and verified against it at the wave boundary and in review; without one there is nothing deterministic to verify. |

Iterate the checklist against step files and the sprint draft, fixing failures (update step files, recompute waves) and re-running. Max 3 iterations. **Hold the table in mind across iterations — emit only per-iteration deltas (which checks fixed, which remain). Do not re-print the table on each pass.** Flag any remaining gaps in the sprint plan summary as "Planning gaps — review during execution". Then proceed to Step 9.7.

## Step 9.7 — Adversarial Critique

After the self-review quality gate passes, spawn the critic agent to challenge the sprint plan from angles the self-review doesn't cover — implicit assumptions in Technical Notes, estimate realism, wave conflict risks, and rollback gaps.

**Determine stakes level:**
- `high` if: sprint has 10+ tasks, total story_points >= 20, any feature touches auth/payments/data, or critical path has 4+ tasks
- `standard` otherwise

**One critic per story group, in one message (4.0).** Use the groups the decomposition used. A critic reads its own group's stories and steps, plus SPRINT-DRAFT.md for context; name the group's story ids in the prompt's "filter to sprint scope" line. One group → one critic. Whether two steps of one wave collide is the CLI's answer (`shipyard-data sprint plan-score`), so no critic needs the whole plan to judge it. Merge the findings and process them once; still one round only. **Why:** one critic over a seven-story plan took 12 of 47 minutes, and most of what it checks (gaps, estimates, assumptions) is per story.

**Spawn the critic:** dispatch a `general-purpose` subagent with the inline critic prompt below. The critic role is reused across ship-review, ship-sprint, and ship-discuss with mode-specific framing; per the granularity criterion in S-1, the prompt stays inline (different inputs, different evaluation criteria — one combined critic capability skill would be a junk drawer).

Substitute the literal SHIPYARD_DATA path before spawning. **Model + effort (think):** Run `shipyard-data resolve-model think` — one line `model=<m> effort=<e>`; pass each value as a string on the Agent call and OMIT any empty field (inherit). Never hardcode a literal. Log it once: `shipyard-data events emit dispatch_model_resolved role=<role> model=<model or inherit> effort=<effort>` (a logging failure never blocks the dispatch).

```
Agent(subagent_type: "general-purpose", model: <model= from resolve-model think; omit if empty>, effort: <effort= from resolve-model think; omit if empty>, prompt: |

You are an adversarial critic of a sprint plan. Your job is to find what
the plan misses: blind spots, optimistic estimates, wave-conflict risks,
acceptance-scenario coverage gaps, and feasibility issues.

Apply anti-sycophancy: do not agree with the plan just because it sounds
reasonable. Pre-mortem the sprint: imagine it shipped two weeks late or
half-broken — what was the failure mode?

If (and only if) a feature in this sprint persists data (has a `## Data
Model` section), also challenge whether the decomposition actually captures
the data work: is there an explicit task for the schema/migration, for the
constraints (FK / NOT NULL / UNIQUE / CHECK), and for the indexes the hot
queries need — or are these left implicit inside a behavior task where the
builder will skip them? Flag missing schema/migration/index/constraint tasks
under TASK_GAPS. Consult
${CLAUDE_PLUGIN_ROOT}/project-files/references/data-modeling-guide.md.
Skip this for sprints with no data-persisting feature.

Mode: sprint-critique
Stakes: [standard | high]   (high if 10+ tasks, ≥20 story points,
                             auth/payments/data, or critical path 4+ tasks)

Read these files:
  - SPRINT-DRAFT.md: <SHIPYARD_DATA>/sprints/current/SPRINT-DRAFT.md
  - All step files: <SHIPYARD_DATA>/spec/steps/ (filter to sprint scope)
  - Feature specs covered: <list of story file paths>
  - Codebase context: <SHIPYARD_DATA>/codebase-context.md
  - Project rules: .claude/rules/project-*.md

Return:
  STATUS: CHALLENGES
  PRIORITY_ACTIONS: <ordered list — mandatory fixes>
  TASK_GAPS: <missing tasks needed to cover acceptance scenarios>
  WAVE_CONFLICTS: <tasks that should not be in the same wave>
  ESTIMATE_RISKS: <effort estimates that look optimistic — with reason>
  ASSUMPTION_RISKS: <high-risk assumptions baked into the plan>

If you genuinely have no challenges:
  STATUS: NO_CHALLENGES
  REASON: <one paragraph confirming you considered each adversarial angle>

You are READ-ONLY: no edits, no commits, no spawning subagents.
)
```

**Process the critic's findings:**

1. Read `PRIORITY_ACTIONS` — the mandatory fixes; work them first.
2. Process each returned section by its fix-shape (the critic emits exactly these sections — there are no per-item FAIL/CONCERN verdicts and no steel-man "RECONSIDER" pass):
   - `TASK_GAPS` → create the missing tasks and update the wave structure.
   - `WAVE_CONFLICTS` → re-assign the conflicting tasks to different waves.
   - `ESTIMATE_RISKS` → adjust effort estimates, potentially splitting tasks.
   - `ASSUMPTION_RISKS` → if load-bearing, first quote the critic's finding and evidence verbatim as chat text alongside your recommendation, then `AskUserQuestion` with the short question only — the critic's return exists only in this context, and evidence packed into option strings does not count as shown to the user. Otherwise note it in the `## Risks` section of SPRINT-DRAFT.md as "Critic flagged — [summary]. Mitigation: [your plan]".
   - Anything that needs a genuine scope/priority call → first quote the critic's finding and evidence verbatim as chat text alongside your recommendation, then `AskUserQuestion` with the short question only — the critic's return exists only in this context, and evidence packed into option strings does not count as shown to the user.
3. If fixes changed the wave structure, re-verify no circular dependencies and no same-wave dependency violations.

**Do NOT re-run the critic after fixes.** One round only. Address what you can, ask the user about the rest, and proceed.
