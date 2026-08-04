# Scanner Dispatch — How the batched review wave fires

This reference holds the detail for Stage 0 (scanner wave, deterministic fix planning, fix waves, validation ladder) and Stage 0.5 (Simplification) of the review pipeline. SKILL.md keeps the stage handler summary; the mechanics of dispatch, fix batching, scope guards, and out-of-scope routing live here.

## Stage 0a-0d — Batched Review Mechanics

The default review path is no longer "scanner → one fix → full tests → scanner" repeated. It is:

1. read-only scanner wave
2. deterministic `shipyard-data review plan`
3. parallel fix batches by wave
4. validation ladder

### Scanner Wave

Run all read-only review scanners before dispatching any fixer. The code-review scanner still follows `references/code-review-orchestration.md` and may split high-stakes concerns into parallel dispatches:

- security
- bugs / silent-failures / data
- patterns / tests
- spec compliance
- quality-gate gaps
- user-flow/demo probe risk
- build/config drift

Normalize all scanner returns into `<SHIPYARD_DATA>/sprints/current/REVIEW-FINDINGS.json`:

```json
{
  "findings": [
    {
      "id": "R001",
      "title": "Session expiry path can silently fail",
      "severity": "high",
      "files": ["src/auth/session.ts", "tests/auth/session.test.ts"],
      "required_validation": ["npm test -- auth"],
      "confidence": 92,
      "source": "silent-failures"
    }
  ]
}
```

Do not include low-confidence preferences as actionable findings. If a scanner reports a concrete defect outside the sprint diff scope, capture it as an IDEA using the Stage 4 out-of-scope protocol with `found_during: code-review-stage-0`; do not put it into the current review fix plan.

### Deterministic Fix Plan

Run:

```bash
shipyard-data review plan <SHIPYARD_DATA>/sprints/current/REVIEW-FINDINGS.json --out <SHIPYARD_DATA>/sprints/current/REVIEW-FIX-PLAN.json
```

The command:

- filters non-actionable low/advisory findings
- merges findings that touch the same files or require the same validation
- emits stable `review-fix-N` batch ids
- assigns non-conflicting batches to waves
- produces a validation ladder with per-batch probes, wave-boundary probes, and final build/test placeholders

The plan is the grouping authority. Do not split a batch into per-finding work and do not merge batches by hand after the CLI writes the plan.

### Fix Waves

For each wave, dispatch all listed batches in parallel through `dispatching-task-loop`. Each batch is a synthetic continuation task. Pass:

- `task_id`: the batch id, e.g. `review-fix-1`
- `task_file_path`: a small model-authored task artifact or the JSON plan path plus the batch id
- `working_branch`: the sprint working branch
- `worktree_path`: null unless the installed dispatch path supports isolated review-fix worktrees
- `acceptance_probe`: the batch's `required_probes` joined with `&&`; if empty, require a commit SHA plus targeted reviewer evidence
- `continuation_note`: *"Fix every finding in batch review-fix-N. Stay inside the batch file scope. Run the listed per-batch probes before returning. Commit once: `refactor: address review batch review-fix-N`."*
- `data_dir`: literal SHIPYARD_DATA path

Accept only structured, gate-passed returns. If a batch touches files outside its `files` scope, reject the return and redispatch or escalate if the expanded scope is severe/risky.

### Validation Ladder

Do not run full build/test after every batch. Validation order is:

1. Per-batch probes inside each fixer return.
2. Each unique command in `validation_ladder.wave_boundary` once after all waves merge.
3. Full build/test once in `review_validation`, guarded by `shipyard-data verify check` and recorded by `shipyard-data verify record`.
4. Re-scan only after failed validation, blocked fixer state, or out-of-scope file touch.

### Legacy Code Review Loop

Older cursors may still resume at `code_review_iter_N`. **Goal-mode default (legacy):** keep dispatching the fixer against residual findings without user interruption until scanners come back clean; do not ask the user at iteration 2. For that legacy route, run the previous code-review loop semantics: `dispatching-code-review`, `CODE-REVIEW.md`, `dispatching-task-loop` fixer, `code_review_iteration` events, and `code_review_escalated` at the hard ceiling. Fresh review starts do not use this route.

## Stage 0.5 — Code Simplification (mechanics)

Skip if `--skip-code-review` is passed (same gate as Stage 0).

After the code review loop exits clean, run a simplification pass on the sprint's changed code. The code review fixer may have introduced quick patches; this pass cleans them up for clarity, consistency, and reuse before tests and demo.

1. Get the sprint diff file list:
   ```bash
   git diff --name-only $(git merge-base HEAD <main_branch>)...HEAD
   ```
2. Spawn the simplifier agent. **Model tier (build)** — simplification is implementation labor: read `models.build` from `<SHIPYARD_DATA>/config.md` (the `/ship-review` context block already carries config, or Read it); if non-empty pass `model: <value>` on the Agent call, if empty or absent OMIT `model:` so it inherits the session model. Never hardcode a literal. **Effort tier (simplifier)** — read `agent_effort.simplifier` from config.md (default `low`); if non-empty pass `effort: <value>`, if empty/absent OMIT `effort:`.
   ```
   Agent(subagent_type: "general-purpose", model: <models.build — omit if empty>, effort: <agent_effort.simplifier — omit if empty>, prompt: |
     You are a code simplifier. Review and simplify the following files that were changed in this sprint.
     Focus on: reducing unnecessary complexity, eliminating redundant code,
     improving naming, consolidating related logic, and applying project
     conventions from CLAUDE.md. Preserve all functionality.

     Changed files:
     [list from step 1]

     Commit your changes as: refactor: simplify sprint code)
   ```
3. Verify a commit exists after the agent returns. If no commit → the simplifier found nothing to improve (clean pass).
4. Emit `task_status_changed type=simplification files=<N>` (PROGRESS.md auto-renders the entry).

**Scope guard:** The simplifier only touches files in the sprint diff. It must not modify files outside the diff scope. If the agent's commit touches unexpected files, revert with `git reset --hard HEAD~1` and proceed without simplification.

## Stage 4 — Existing-code Inline Fix Path (v2.6.0)

Before classifying a Stage 4 gap as a patch task, evaluate whether it fits the **existing-code one-line / template defect** boundary. If so, route through `dispatching-task-loop` for an inline fix instead of filing manual work for the user. More broadly, Stage 4 fixes before asking: simple in-scope gaps become patch tasks and are dispatched immediately; complex in-scope gaps become debug/patch artifacts and are dispatched when an acceptance probe can be stated. Ask only for BLOCKED, severe/risky, or product-decision cases.

### Boundary criteria (all must hold)

1. **Diff size ≤5 lines.** Anything larger means more state to verify; bias toward patch-task.
2. **Files exist on the working branch.** No new file creation, no new modules. The gap is "this thing was wired wrong," not "this thing was never built."
3. **No new dependencies / no new test scaffolding.** Importing a new lib or setting up a new test runner is patch-task work, not inline-fix.
4. **Regression test exists or can be added in ≤30 lines.** A real probe must demonstrate the fix works. Without one we're just shipping a hopeful change.

### Shape examples (route inline)

- Missing `liveValidate` prop on an existing `<Form>` — one prop add, existing tests already render the form.
- `cloneElement(child, {aria-describedby})` failing on `React.Fragment` — replace with a guard in the existing template, regression test ≤20 lines.
- Forgotten `await` before an async call returning a Promise that the caller treats as the resolved value — one keyword add, existing test detects the type mismatch.
- Missing null guard on a known-nullable input where the test fixture already includes the null case but didn't fail because the bug short-circuits another way.

### Shape examples (do NOT route inline, file patch-task)

- Missing Playwright e2e spec entirely (`tests/e2e/` empty, no Playwright config) — new test scaffolding, new dependency surface.
- Missing API endpoint (`POST /api/foo` returns 404 because route is unwired) — needs route registration, controller, request schema, tests — multi-file change.
- Behavior bug where the fix requires algorithmic changes (>5 lines diff in the implementation) — too much state to verify inline.

### Inline-fix dispatch

For a gap matching the boundary, allocate a patch task ID via `shipyard-data next-id tasks`, write the synthetic task file with `kind: patch`, `source: review-inline-fix`, `acceptance_probe:` populated with the regression test command, and `First failing test:` describing the gap. Then follow the `dispatching-task-loop` playbook with the synthetic task. The capability skill enforces the same structured-return contract as a Stage 0 fixer dispatch.

After the dispatched commit lands, re-enter `gap_analysis_iter_<N+1>` on the patched diff. If the same gap reappears, fall through to patch-task auto-dispatch — the inline fix failed, but the review should still attempt the normal builder path before interrupting the user.

Emit `patch_task_created task_id=<id> feature=<F> source=review-inline-fix verdict=<outcome>` for observability — **only after `spec/tasks/<id>-*.md` exists** (written above). Never emit `patch_task_created` for an id with no task file: everything that frontmatter-checks tasks (ship-status, this review's evidence check, next sprint's carry-over scan) then sees a dangling reference. `shipyard-data doctor` flags any that slip through.

## Stage 4 — Out-of-Scope Gap Capture (IDEA mechanics)

Out-of-scope gaps are real defects — they deserve tracking — but they don't belong in the current feature's patch-task list (which would blow up sprint scope) or the debug session (which is feature-specific). The existing destinations (`bugs/`, `debug/`, patch tasks) are all scope-locked to the thing being reviewed. IDEAs are the overflow valve for "real but not now."

**Hard cap: 5 IDEAs per review stage** (5 for Stage 0 code-review findings, 5 for Stage 4 gap findings — 10 total per review run). If you have more than 5 out-of-scope findings in a stage, write exactly ONE summary IDEA with `overflow: true` in the frontmatter and a bulleted list of the additional items in the body. Why 5? Same reasoning as the builder's 3-per-task cap — idea farms are how signal gets drowned in noise.

**When to capture vs when to let it go:**

- **Capture** — concrete defects, latent bugs, architectural smells with a specific citation (file:line), security concerns that aren't in the current feature's threat model, deprecated API usage, silent failure modes.
- **Do NOT capture** — style preferences, "this could be cleaner", "I would have designed this differently", refactor wishes without a concrete defect, things already tracked in bugs/ or debug/ sessions (would duplicate), gaps that are actually in-scope for the feature being reviewed.

**How to capture** (mechanical):

1. Allocate an ID atomically: run `shipyard-data next-id ideas` — returns a zero-padded 3-digit string (e.g., `042`). **Do NOT `ls` and guess** — parallel reviewers would race.

2. Write the IDEA file via the Write tool at `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` (slug is lowercase-kebab-case, ≤5 words):
   ```yaml
   ---
   id: IDEA-<id>
   title: "<one-line observation>"
   type: gap
   status: proposed
   source: review-gap/<sprint-id>
   found_during: surface-gap-stage-4     # or code-review-stage-0
   feature_reviewed: <feature-id>        # the feature you were reviewing when you found this
   created: <current ISO date>
   ---

   ## Observation

   <2–3 sentences: what you found, where (file:line), why it's a real defect, not a preference>

   ## Evidence

   - File: <path:line>
   - Pattern: <what the scanner / review flagged>
   - Severity estimate: low | medium | high
   - Why out-of-scope: <why this doesn't belong in the current feature's patch tasks>
   ```

3. Repeat up to 5 per stage. On overflow, collapse to one `overflow: true` IDEA.

**Hard rule — out-of-scope only.** In-scope must-fix items still become bugs (`B-CR-*.md` in Stage 0). Complex in-scope issues still become debug sessions. Simple in-scope issues still become patch tasks. IDEAs are EXCLUSIVELY for observations that are real but belong to a different feature, a different sprint, or a future cleanup pass. Violating this rule floods the IDEA backlog with bugs masquerading as ideas and makes `/ship-discuss` unusable.
