# Review stages: gap analysis, critic, final pass, user-flow probe, demo, process decision

Moved verbatim from SKILL.md; cursor, stage order and gates stay there.

## Stage 4: Surface Gap Analysis

**Scope (F028).** Stories with a settled per-story review (`shipyard-data story-review check --json`, `settled: true`, recorded `head` == HEAD) were gap-analysed at their wave boundary; this stage runs gap analysis across the sprint SLICE (cross-story seams, integration AC, the full-build and demo evidence) and only re-opens an individual story that is unsettled or changed since its record. Never re-list a per-story finding that is already recorded and dispositioned.

**Dispatch the analytical body via `dispatching-gap-analysis` (per gap_analysis tick).** The surface-gap detection below AND the Stage 4.5 10-check self-review are reasoning-heavy read-only analysis — follow the `dispatching-gap-analysis` playbook so this substantial prompt goes through the registered `shipyard-gap-analyst` agent, not a hand-rolled generic subagent. The reviewer shell keeps everything with a side effect: the cursor advance, the `stuck_counter` computation, the gap→persistence-target actions (patch task / debug session / IDEA file / inline-fix dispatch in the classification tree below), and all user-facing surfacing. The agent only analyzes and returns.

Pass to the capability skill: the sprint's feature and step file paths (under `<SHIPYARD_DATA>/spec/`), the verdict-relevant evidence paths gathered so far (Stage 1 test-output captures, Stage 1b spec-review findings, Stage 3 goal-verification results as recorded), the literal SHIPYARD_DATA path, `base_ref`, `head_ref`, `scope`, and target feature IDs. The playbook handles the think-tier model rule, read-only contract, silent-return re-dispatch, and structured `STATUS: CLEAN|GAPS|BLOCKED` parsing.

The shell then acts on the returned gap list using the classification tree below (Stage 4) and drives the Stage 4.5 loop: it computes `stuck_counter` (set-equal on the gap list), advances the cursor, and re-dispatches `dispatching-gap-analysis` on the next `gap_analysis` tick when the gap list is still changing. If the dispatch returns BLOCKED twice or violates read-only, surface that BLOCKED state; do not invent an inline generic-agent fallback.

Additionally detect:
- **Untested scenarios** — acceptance scenarios without end-to-end tests
- **Missing edge cases** — empty states, error states, loading states
- **Accessibility gaps** — missing screen reader labels, keyboard navigation, contrast
- **Security concerns** — hardcoded values, missing input validation
- **Anti-patterns** — TODO comments, console.log left in, empty catch blocks

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-autofix.md` § Auto-fix before asking and follow it.

For each gap, classify into one of four destinations — this is a decision tree, not a menu, and the classification determines which persistence target the gap lands in:

- **Existing-code one-line / template defect** → **inline-fix** via `dispatching-task-loop` with a synthetic patch task. Mirrors Stage 0's auto-fix pattern. Boundary criteria: fix is ≤5 lines of diff, touches files already on the working branch, needs no new dependencies/modules/test scaffolding, and the regression test either exists or can be written in ≤30 lines. Concrete shape: a missing prop on an existing component, a faulty `cloneElement` in an existing template, a forgotten `await`, a missing null guard with an existing test that already exercises the path. After the synthetic task lands its commit, re-enter Stage 4 once (`gap_analysis_iter_<N+1>`) on the patched diff — the gap should no longer appear. If the boundary check is uncertain or the inline fix introduces a new gap, fall through to the **patch task** classification below; uncertainty biases toward the patch task. Emit `patch_step_created task_id=<id> feature=<F> source=review-inline-fix` for traceability.
- **Simple and in-scope, new functionality** (missing test for this feature, missing endpoint, missing widget, TODO left in this feature's files, missing validation on this feature's inputs) → **patch task + auto-dispatch**. Use the existing patch-task creation flow, then immediately follow `dispatching-task-loop` for that patch task in the same review cycle. After the task lands, re-enter `gap_analysis` on the patched diff. Do not defer to Stage 5's `Fix first` branch unless the patch task returns BLOCKED, hits a severe/risky exception, or cannot be verified.
- **Complex and in-scope** (feature doesn't work but tests pass, wiring broken within this feature, behavior contradicts this feature's spec) → **debug/patch task + auto-dispatch when bounded**. Use the Write tool to create `<SHIPYARD_DATA>/debug/[feature-id]-[gap].md` with the symptoms and evidence from the review, then create and dispatch a patch task when the acceptance probe can be stated. Ask only when the gap requires a product/spec decision or an unsafe migration rather than implementation.
- **Out-of-scope, concrete defect** (a real bug outside the story being reviewed — e.g., while reviewing payments the scanner flagged a race condition in the auth middleware) → **bug story**: allocate `shipyard-data next-id stories`, Write `<SHIPYARD_DATA>/spec/stories/S<id>-<slug>.md` with `type: bug`, `status: proposed`, `severity`, `source: review-gap/<sprint-id>`, `found_during`, `feature_reviewed: <story-id>`, the reproduction you observed under `## Steps to Reproduce` and the first acceptance criterion "a failing test reproduces it". Small enabling work that is not a deliverable (a measurement, a spike) → a **task** (`next-id tasks`, `spec/tasks/T<id>-<slug>.md`, `kind: spike|chore`). Only a non-defect **observation** (a smell, a question, an opportunity) becomes an **IDEA** — see "Capture Out-of-Scope Observations as IDEAs" below. A concrete defect filed as an idea is lost to grooming (terminology-v4 §1).

**Patch-task budget (deferral guard).** Before creating another review patch task (any `patch_step_created source=review-*` path above), run `shipyard-data patch-budget` (the CLI counts and computes the cap from `execution.max_patch_tasks` and `execution.patch_steps_per_story` — do NOT count from memory). On exit 3, STOP auto-creating: render the accumulated list and `AskUserQuestion` whether to keep patching, defer the rest to a follow-up sprint, or cut scope. Mirrors the execute-side guard and `operational_tasks.max_patch_tasks`.

**Capture Out-of-Scope Observations as IDEAs.** Out-of-scope observations (smells, questions, opportunities — never a concrete defect, which is a bug story) don't belong in the current story's patch-task list or debug session. Allocate an ID via `shipyard-data next-id ideas` (never `ls`-and-guess), then Write `<SHIPYARD_DATA>/spec/ideas/IDEA-<id>-<slug>.md` with `source: review-gap/<sprint-id>`, `found_during: surface-gap-stage-4` (or `code-review-stage-0`), and `feature_reviewed: <feature-id>`. **Hard cap: 5 per stage** (Stage 0 and Stage 4 budgets are independent); on overflow, write one `overflow: true` summary IDEA. **Hard rule — out-of-scope observations only:** in-scope must-fix → bug stories (`type: bug`, Stage 0), in-scope complex → debug session, in-scope simple → patch step; an out-of-scope concrete defect → bug story or task, never an IDEA. Full IDEA frontmatter schema, capture-vs-skip criteria, and frontmatter template in `references/scanner-dispatch.md`.

## Stage 4.5: Quality Gate (self-review loop)

**The 10-check evaluation itself runs inside the Stage 4 gap-analysis agent** (dispatched above) — the agent applies this table to its findings and returns the per-check results alongside the gap list. The **shell** owns the loop control: it reads the returned results, updates the gap list, computes `stuck_counter`, advances the cursor, and decides whether to re-dispatch (gap list still changing) or proceed to `stage: critic` (gap list stable). On dispatch failure, surface the wrapper's BLOCKED outcome rather than evaluating the table in a hand-rolled generic subagent.

Before writing the verdict, the self-review re-reads the feature spec and the findings against this table:

| # | Check | Fail criteria |
|---|---|---|
| 1 | **Every acceptance scenario has a test** | A Given/When/Then scenario exists in spec but no corresponding test found |
| 2 | **Every test maps to a scenario** | Tests exist that don't trace to any acceptance scenario (over-building or orphan) |
| 3 | **Goal verification is complete** | Observable truths list has items not checked |
| 4 | **Wiring verified** | Components built but not connected — no integration path tested |
| 5 | **Edge cases covered** | Only happy path tested — error states, empty states, boundary conditions missing |
| 6 | **No implementation gaps** | Story file describes behavior that isn't implemented at all |
| 7 | **No spec gaps** | Implementation exists that isn't described in the spec (scope creep) |
| 8 | **Cleanup completed** | Task Technical Notes listed cleanup items that weren't addressed |
| 9 | **Security basics** | Auth/validation/input sanitization specified in spec but not verified |
| 10 | **Anti-patterns clean** | TODOs, console.log, empty catches still present in sprint diff |

Iterate the checklist against your findings. If any check reveals a missed gap, add it to the gap list and re-run. **There is no arbitrary iteration cap** — loop until the checklist stabilizes (no new gaps added in a pass). Stuck detection: `pipeline_stuck` warns when `stuck_counter >= 5` (5 ticks with the same gap-list set), non-blocking, the loop keeps running. Hard ceiling: `hard_ceiling: 50` is the absolute safety stop. See the "Self-looping stages" section of SKILL.md for the protocol. **Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-autofix.md` § Stuck warning and follow it for the ≥5 protocol. **Run this loop quietly (quiet-by-default § self-looping stages) — do NOT narrate each pass or re-print the table. Surface at most a one-line result** (`→ Gap analysis: N gaps, converged`); the gaps ride into the verdict file and the Stage 5 summary. Proceed to verdict (`stage: critic`) when the checklist stabilizes.

- **Cursor advance**: on iteration completing with a non-empty gap-list delta: run `shipyard-data cursor advance review gap_analysis iteration=<N+1> stuck_counter=<n> --note "Re-run self-review iteration <N+1>"` (pass `stuck_counter=0` only when the gap-list set changed — otherwise the CLI auto-increments). On iteration completing with the gap-list stable: run `shipyard-data cursor advance review critic`. On hard ceiling: `shipyard-data cursor escalate review reason=hard_ceiling_stage_gap_analysis`.

## Stage 4.6: Critic Challenge

After the self-review loop stabilizes, dispatch a **`general-purpose`** subagent in critic mode to challenge the review findings. The critic reads the feature spec, implementation, and the review's results to find what the reviewer missed — blind spots, false positives, and false negatives. Anti-sycophancy + pre-mortem framing; read-only. **Model + effort (think):** Run `shipyard-data resolve-model think` — it prints exactly one line `model=<m> effort=<e>`; pass each value as a string on the Agent call and OMIT any field whose value is empty (inherit). Never hardcode a model literal or re-derive the tier from config.md by hand. Log it once: `shipyard-data events emit dispatch_model_resolved role=<role> model=<model or inherit> effort=<effort>` (a logging failure never blocks the dispatch).

The full subagent prompt template (with `<SHIPYARD_DATA>`, `[FEATURE_ID]`, stakes, and findings substitutions) and the consumption protocol live in `references/critic-prompt.md`. The critic returns a structured `STATUS: CHALLENGES` or `STATUS: NO_CHALLENGES` report — Stage 4.7 processes the findings with one surgical pass.

- **Cursor advance**: run `shipyard-data cursor advance review final_pass --note "Run Stage 4.7 final pass on critic findings"`.

## Stage 4.7: Final Review Pass

**Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-autofix.md` § Auto-fix before asking and follow it.

Process the critic's findings with **one** targeted pass — no iteration loop:

1. For each FAIL or HIGH-risk finding from the critic: verify it by checking the code/tests directly
2. If the critic identified a real blind spot → add it to the gap list with classification (simple/complex)
3. If the critic flagged a false positive in the review (something marked ✅ that isn't actually working) → downgrade it and add to gaps
4. If the critic's finding is itself a false positive (the review was correct) → discard it

Do not re-run the full review pipeline. This is a surgical pass on the critic's specific findings only. Update the gap counts and classifications, then proceed to the verdict.

**Critic deadlock.** If the critic's verdicts contradict the review's conclusions (e.g., the critic insists a ✅ is broken while direct verification says it holds, or vice versa) and a single reconciliation pass over the disputed items does NOT resolve which is right, follow the `escalating-to-thinker` playbook (trigger: `critic_deadlock`, subject: the feature ID / disputed finding) before recording a verdict — a think-tier consult breaks the tie with a fresh reading. Only if it declines (cap reached), returns low confidence, or its recommendation also fails do you surface the contradiction to the user — render each disputed finding as chat text first (the review's claim, the critic's counter-claim, and the direct-verification evidence; critic/agent returns do not count as shown until printed) — via AskUserQuestion. Do not silently pick a side.

- **Cursor advance**: run `shipyard-data cursor advance review verdict --note "Write verdict file"`.

## Stage 4.8: User-Flow Verification

`/ship-execute` runs the user-flow probes at its `sprint_demo_probes` stage (Step 5 item 3), before flipping SPRINT.md to `status: completed`. By the time `/ship-review` reaches this stage, they have usually already passed. This stage's job is to **re-verify on freshly-checked-out HEAD** as a sanity check (defends against "passed during execute, broken at merge" race conditions), with a skip-if-already-passed preflight to keep review fast on the happy path.

(The stage id and ledger key stay `demo_probe` / `demo_probe.<SID>` — they are internal identifiers in the stage graph and the verify ledger, and renaming them would strand any in-flight cursor and invalidate every recorded entry. The user-facing field is `user_flow_probe:`.)

**Preflight — ledger predicate, not event-window.** Stage 0 (code-review fixer) and Stage 0.5 (simplifier) commit BEFORE this stage runs, so an execute-time probe pass can be stale here: freshness comes from the verify ledger (tree-id), never from event-log presence.

For each feature in scope, resolve its `user_flow_probe:` and run `shipyard-data verify check --key demo_probe.<SID> --command "<probe.command, or the skip/manual marker>"`:

- **Exit 0 (FRESH)** — the probe already passed against this exact working tree, clean, recently (recorded by `/ship-execute`'s `sprint_demo_probes` stage, or by an earlier Stage 4.8 tick in this same review). Skip re-running it for this feature.
- **Exit 3 (STALE)** — tree changed since the last pass (e.g. Stage 0/0.5 committed a fix touching this feature), or it never ran, or the record expired/is missing. Run the full sequence below for this feature.

Render the per-feature skip/run decision as chat text (same form as Stage 1a in `references/review-stages-verify.md` — a skip the user can't see is indistinguishable from a stage that silently didn't run). If every feature in scope comes back FRESH, emit `stage_4_8_skipped reason=already_passed_in_execute` and advance straight to `stage: demo_user` — still fast on the genuine happy path, now for a sound reason instead of an event-presence guess. Otherwise, run the full sequence below only for the features that came back STALE.

For each feature whose probe wasn't already verified:

1. Read the feature's frontmatter `user_flow_probe:` (legacy scalar `demo_probe:` reads as `kind: auto`).
2. **If it is missing**: this is a planning-gate escape, not a decision for this stage — `/ship-sprint` refuses to plan a feature without one and `/ship-execute` Step 0 re-checks it. Refuse to advance to Stage 5, name the feature, and point at `/ship-discuss [S###]` to author one. Do not offer to skip.
3. **If `user_flow_probe: skip-with-reason`** with a `user_flow_probe_skip_reason` populated: include the reason in the per-feature summary (Stage 5) as a known limitation — this means no proof of any kind exists. Allow approval to proceed.
4. **`kind: auto`**: follow the **`running-acceptance-probe` playbook** with `probe_command: <probe.command>`, `cwd: <repo root>`, `timeout_seconds: 120`. The capability skill runs the probe in a fresh shell and returns the structured verdict.
5. **`kind: assisted` / `manual`**: a human already confirmed this during execute. Check for `user_flow_probe_confirmed feature=<F> verdict=pass` whose `commit` is an ancestor of HEAD (`git merge-base --is-ancestor`). **Ancestor → PASS, carried forward into the Stage 5 summary with the confirmer and commit; do not re-ask.** **Not an ancestor** (Stage 0/0.5 rewrote the code since) → render `probe.steps` verbatim as chat text, `shipyard-data cursor pause review --note "user_flow_probe re-confirmation for <F>"`, then ask for a fresh verdict and record it via `shipyard-data story record-proof <F> verdict=… confirmed-by=… commit=<HEAD>`.
6. For `auto`, emit `acceptance_probe_completed feature=<F> probe_type=demo exit_code=<n>` to the event log via `shipyard-data events emit ...` and include the verdict in the Stage 5 per-feature summary (PROGRESS.md auto-renders the verdict from the event):
   - **PASS** → ✅ User flow verified (last 5 lines of output captured below); run `shipyard-data verify record --key demo_probe.<SID> --command "<probe.command>" --exit 0 --capture <capture path>` so a later tick, or a resumed review, reuses this proof instead of re-running the probe.
   - **FAIL** → ❌ User flow failed; the probe doesn't exit 0 against the merged feature
   - **TIMEOUT** → ⚠ Demo exceeded 120s; probe is too broad — split or narrow it
   - **ERROR** → ⚠ Demo couldn't run; probe definition is wrong (likely missing dependency or misconfigured command)

**Approval gate.** **Read** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/review-autofix.md` § Auto-fix before asking and follow it. A feature with a FAIL or TIMEOUT verdict cannot be approved. The reviewer must first re-dispatch task-loops to fix the cross-task wiring, then re-run this stage. Only flag the feature as `needs-attention` or ask the user when the fix is blocked, severe/risky, or requires a product/spec decision. ERROR verdicts are different: render the probe command and its error output (from the probe return — not shown until printed) as chat text, then route through AskUserQuestion only when the probe definition itself needs user/product clarification; otherwise create and dispatch a probe-fix patch task.

- **Cursor advance**: on all probes PASS (or skip-with-reason): run `shipyard-data cursor advance review demo_user --note "Present results, AskUserQuestion approval"` and echo its output. On any FAIL/TIMEOUT: create/dispatch the appropriate patch task or task-loop fix, then self-loop/re-enter `demo_probe`; do not ask just because the probe failed. On BLOCKED, severe/risky, or user/product-decision cases only, run `shipyard-data cursor pause review --note "Awaiting user decision on demo failure"` (keeps `stage: demo_probe`, sets `status: paused`) before invoking AskUserQuestion.

## Stage 5: Demo to User

After all features are reviewed and verdicts written, present the complete review results as text.

**Decisions made for you (unattended execute, 4.4).** Read every `execute_decision` event of this sprint from the event log (`shipyard-context scan-events` / `.shipyard-events.jsonl`, `sprint=<id>`) and render them as a table — stage, subject, decision, rationale, source (`rule` / `consult` / `parked`) — before anything else in this stage. These are the calls `/ship-execute` made instead of asking (findings fixed in-sprint as patch steps, low-severity findings sent to the backlog, deferred human gates, parked items); the user overturns one by choosing **Refine** below and naming it. Nothing here is a question on its own.

**Pending human probes.** For each story whose `user_flow_probe` is `assisted`/`manual` and whose latest `acceptance_probe_completed` carries `verdict=PENDING_HUMAN`, render the probe's `steps` verbatim as chat text (for `assisted`, run `probe.command` first so the thing to look at exists) and add ONE question per story to the approval call below ("[S###] — does the flow above work? — yes / no / can't check now"). On **yes** record it before approving: `shipyard-data story record-proof <S###> verdict=pass confirmed-by=user commit=<sprint HEAD sha> answer="<their words>"` (never from an approval of the sprint as a whole); on **no** the story takes the **Fix first** path; "can't check now" leaves the review paused (`cursor pause review`). Approval of a story with an unconfirmed human probe is not allowed.

**Per-feature summary** — for each feature:
- Tests: pass/fail counts (unit, integration, E2E)
- Coverage: % vs threshold
- TDD compliance: tests committed before implementation?
- Goal verification: N/M observable truths confirmed
- Wiring: N/M artifacts connected
- Gaps found: count and brief descriptions
- Screenshots: location if UI feature

**Sprint aggregate** (if reviewing whole sprint):
- Features: N complete, M with issues
- Total tests: passed/failed
- Average coverage
- Gaps found across all features
- Tests-first violations

**Quality Gate Results** (if QUALITY-GATE.md exists):
- Standing gates: [N] pass / [M] fail
- Sprint-specific gates: [N] pass / [M] fail
- Integration gates: [N] pass / [M] fail
- **Manual verification checklist** — render the full manual-gate checklist (each gate's description and what to verify) as chat text first — question/option strings render as a compact card and do not count as showing the gates; then ask the manual gates **one card per gate** (one question per `AskUserQuestion` call: "[Gate description]. Verified? — yes / no / not applicable"); say how many there are before the first. A card with more than one question is refused by the hook, so never fold a gate into the approval card. Review cannot auto-approve if manual gates remain unverified.

**Recommended action** per feature:
- ✅ Approve — all checks passed
- ⚠️ Issues — only unresolved non-blocking gaps remain after auto-fix attempts
- ❌ Needs changes — severe/risky, blocked, or product-decision gaps remain after auto-fix attempts

**Pause before the approval ask** (per the pause-before-ask rule in SKILL.md): run `shipyard-data cursor pause review --note "awaiting user: sprint approval decision"` before invoking `AskUserQuestion`. Then use `AskUserQuestion` for approval (this approval is load-bearing — NEVER skip user approval; batch the manual-gate questions above into this same call when there are few of them):
- **Approve (Recommended)** — update feature statuses to `done`, proceed to Sprint Retrospective
- **Refine** — give feedback on specific features, iterate
- **Fix first** — only for findings that auto-fix could not safely resolve; create patch tasks, show: "/ship-execute --task [patch task ID]"

On the user's answer, run `shipyard-data cursor resume review`, then advance:

- **Cursor advance**: after the user answers, run `shipyard-data cursor advance review process_approved` (or `... process_issues` / `... process_changes` per the answer) with `--note "Process Stage 6 decision branch"` and echo its output.

## Stage 6: Process Decision

Based on the approval:
- **Approved** → `shipyard-data story set-status <SID> done`. Proceed to Retro Decision (SKILL.md § Sprint Retrospective), unless `--skip-retro` was passed; then proceed directly to Release Step 1.
- **Issues found** → File each as a bug story (`type: bug`, per `ship-discuss/references/bug-lane.md`: reproduction, expected vs actual, a failing test as AC-1). **Emit `story_created` per bug** (`shipyard-data events emit story_created bug=<id>`) — the terminal gate requires at least one such event in the review window before it will allow the `terminal_issues` cursor write (the Terminal-gate enforcement bullet in SKILL.md). `shipyard-data story set-status <SID> approved` (not `in-progress` — it needs re-planning) followed by `shipyard-data backlog add <SID>` so the next `/ship-sprint` picks it up.
- **Needs changes** → Update spec with new criteria. Create patch tasks — **write each `spec/steps/<id>-<slug>.md` file first**, then **emit `patch_step_created` per task** (`shipyard-data events emit patch_step_created task=<id>`). Order matters: a `patch_step_created` event for an id with no step file leaves a dangling reference that ship-status validation, this review's evidence check, and the next sprint's carry-over scan all trip over (`shipyard-data doctor` flags it). The terminal gate requires the event before allowing the `terminal_changes` cursor write (the Terminal-gate enforcement bullet in SKILL.md). `shipyard-data story set-status <SID> approved` followed by `shipyard-data backlog add <SID>`. Show:
  ```
  ▶ NEXT UP: Fix the gaps and re-verify
    /ship-execute --task [patch task ID]
    (tip: /clear first for a fresh context window)
  ```
