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
F010 Scenario 4 contradicts .claude/rules/event-driven-first.md:
  Spec says: "periodic 1hr health check"
  Rule says: "prefer event-driven push over polling"

1. Update spec — rewrite the scenario to comply (I'll update the feature file now)
2. Send back to discuss — this feature needs rethinking (/ship-discuss F010)
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
   TERMINOLOGY MISMATCHES — F009: Maintenance Requests

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
5. **Update feature files** with resolved terminology before decomposing tasks. This prevents builders from creating `Tenant` models when `Organization` already exists.

Skip this step if the codebase is empty (greenfield project — no existing terms to conflict with).

## Step 3.6 — Definition of Ready Gate

Before decomposing, verify each feature is ready. Run the Definition of Ready checks from `planning-checklists.md`. If any feature fails → send back to `/ship-discuss` or resolve now.

Also run the **Cross-Cutting Concerns Audit** from the checklists — for each feature, check auth, logging, caching, rate limiting, analytics, feature flags, background jobs, notifications, search, migration, config. Record what's needed in task Technical Notes.

Run the **Knowledge Gap Assessment** — flag tasks in unfamiliar domains, add research time to estimates.

**Auto-generate SME skills for knowledge gaps:** If knowledge gaps cluster around a specific technology that has no existing skill in `.claude/skills/` (e.g., multiple tasks need OAuth patterns but no `/oauth-expert` skill exists), silently dispatch a `general-purpose` subagent in skill-writer mode for that specific technology. The skill is generated without user interaction. Report in the sprint plan output: "Generated /[tech]-expert skill to fill knowledge gap."

The skill-writer prompt is single-use to ship-sprint and ship-init; for ship-sprint, the inline form is:

```
Agent(subagent_type: "general-purpose", prompt: |
  You are generating a project-specific SME (Subject Matter Expert) skill for
  the technology: <TECH>. Read the codebase to learn how it's actually used in
  this project, then write a SKILL.md to .claude/skills/<TECH>-expert/ that
  captures the project's specific conventions, patterns, anti-patterns, and
  gotchas — NOT a generic tutorial.

  Sources to read: relevant files from the codebase, .claude/rules/, package
  manifests for version info, any existing usage patterns. Self-validate that
  every example you write would actually compile in this project.

  Output: write SKILL.md and any references/ files. No commits. Return the
  skill path and a one-line summary of what's covered.
)
```

## Step 9.5 — Quality Gate (self-review loop)

Before presenting the plan, review your own output. Re-read each task file and the sprint draft, checking:

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

Iterate the checklist against task files and the sprint draft, fixing failures (update task files, recompute waves) and re-running. Max 3 iterations. **Hold the table in mind across iterations — emit only per-iteration deltas (which checks fixed, which remain). Do not re-print the table on each pass.** Flag any remaining gaps in the sprint plan summary as "Planning gaps — review during execution". Then proceed to Step 9.7.

## Step 9.7 — Adversarial Critique

After the self-review quality gate passes, spawn the critic agent to challenge the sprint plan from angles the self-review doesn't cover — implicit assumptions in Technical Notes, estimate realism, wave conflict risks, and rollback gaps.

**Determine stakes level:**
- `high` if: sprint has 10+ tasks, total story_points >= 20, any feature touches auth/payments/data, or critical path has 4+ tasks
- `standard` otherwise

**Spawn the critic:** dispatch a `general-purpose` subagent with the inline critic prompt below. The critic role is reused across ship-review, ship-sprint, and ship-discuss with mode-specific framing; per the granularity criterion in S-1, the prompt stays inline (different inputs, different evaluation criteria — one combined critic capability skill would be a junk drawer).

Substitute the literal SHIPYARD_DATA path before spawning:

```
Agent(subagent_type: "general-purpose", prompt: |

You are an adversarial critic of a sprint plan. Your job is to find what
the plan misses: blind spots, optimistic estimates, wave-conflict risks,
acceptance-scenario coverage gaps, and feasibility issues.

Apply anti-sycophancy: do not agree with the plan just because it sounds
reasonable. Pre-mortem the sprint: imagine it shipped two weeks late or
half-broken — what was the failure mode?

Mode: sprint-critique
Stakes: [standard | high]   (high if 10+ tasks, ≥20 story points,
                             auth/payments/data, or critical path 4+ tasks)

Read these files:
  - SPRINT-DRAFT.md: <SHIPYARD_DATA>/sprints/current/SPRINT-DRAFT.md
  - All task files: <SHIPYARD_DATA>/spec/tasks/ (filter to sprint scope)
  - Feature specs covered: <list of feature file paths>
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

1. Read the `PRIORITY ACTIONS` section — these are mandatory fixes
2. For each FAIL item and HIGH-risk assumption:
   - Task completeness gaps → create missing tasks, update wave structure
   - Wave conflict risks → re-assign tasks to different waves
   - Estimate realism concerns → adjust effort estimates, potentially split tasks
   - Technical Notes gaps → add missing implementation detail
   - Dependency chain risks → add mitigation to risk register
   - If requires user judgment → collect into a single AskUserQuestion with the critic's evidence and your recommendation
3. For CONCERN items: note them in the `## Risks` section of SPRINT-DRAFT.md as "Critic flagged — [summary]. Mitigation: [your plan]" or fix if quick
4. For RECONSIDER verdicts from Pass 3 (steel-man challenges on implementation decisions): AskUserQuestion with both options and the critic's reasoning, plus your recommendation
5. If fixes changed the wave structure, re-verify no circular dependencies and no same-wave dependency violations

**Do NOT re-run the critic after fixes.** One round only. Address what you can, ask the user about the rest, and proceed.
