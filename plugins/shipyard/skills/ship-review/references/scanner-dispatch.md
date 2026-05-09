# Scanner Dispatch — How the multi-agent code review fires

This reference holds the detail for Stage 0 (Code Review Loop) and Stage 0.5 (Simplification) of the review pipeline. SKILL.md keeps the one-paragraph "what runs" summary; the mechanics of dispatch, fix iteration, scope guards, and out-of-scope routing live here.

## Stage 0 — Code Review Loop (mechanics)

The orchestration logic (6 parallel scanners + an opus investigator) lives in `references/code-review-orchestration.md`. Read that at the start of Stage 0.

Per iteration (max 3):

1. **Checkpoint.** `git tag pre-code-review-$(date +%s)` — rollback point for failed fix iterations.
2. **Orchestrate.** Follow `code-review-orchestration.md` end-to-end. Iteration 1 uses `git diff $(git merge-base HEAD <main_branch>)...HEAD`; iteration 2+ uses the cumulative delta `git diff <pre-code-review-tag>..HEAD`. Phase 5 writes `<SHIPYARD_DATA>/sprints/current/CODE-REVIEW.md` with VERDICT / COUNTS / ---ACTIONABLE--- sections.
3. **Evaluate.** Append counts to the Code Review table in PROGRESS.md. Zero must-fix + zero should-fix → clean pass, proceed to Stage 1. Only consider items → acceptable, proceed to Stage 1. Must-fix or should-fix → continue.
4. **Diminishing returns** (iteration 2+). Read the previous count from PROGRESS.md. If unchanged or increased, AskUserQuestion: "Code review isn't converging — [N] must-fix issues remain after [iteration] fix attempts. Proceed to demo with current state, or investigate manually?"
5. **Fix.** Invoke the **`shipyard:dispatching-task-loop` capability skill** with a synthetic continuation task that points at the CODE-REVIEW.md findings. Pass:
   - `task_id`: a synthetic ID like `CR-FIX-iter-N`
   - `task_file_path`: `<SHIPYARD_DATA>/sprints/current/CODE-REVIEW.md` (the findings doc serves as the spec — the capability skill's prompt instructs the subagent to skip everything above `---ACTIONABLE---` and fix all M/S items below)
   - `working_branch`: the sprint working branch
   - `worktree_path`: null (works directly on the working branch — no isolation; this is a fix-up pass on already-merged code)
   - `acceptance_probe`: `git log -1 --format='%s' | grep -q '^refactor: address code review'` (probe verifies a refactor commit landed)
   - `continuation_note`: *"Fix all M and S items in CODE-REVIEW.md below the ---ACTIONABLE--- separator. Follow TDD. Commit: `refactor: address code review (iteration N)`."*
   - `data_dir`: literal SHIPYARD_DATA path

   The capability skill's structured-return + sha verification handle the "verify a new commit exists" check that previously lived inline. If it returns `STATUS: BLOCKED` (no fixes possible), `git reset --hard` to the most recent `pre-code-review-*` tag and flag the iteration as failed (don't count toward the cap).
6. **Repeat** from step 2.

**Exit:** clean pass → Stage 1. 3 iterations reached with remaining must-fix → use Write to create `<SHIPYARD_DATA>/spec/bugs/B-CR-[slug].md` per finding so they surface in the next sprint, then AskUserQuestion whether to proceed to demo. After exit, delete checkpoint tags: `git tag --list 'pre-code-review-*' | xargs -I {} git tag -d {}`.

**Out-of-scope findings in Stage 0 code review.** If any scanner surfaces a concrete defect that is real but *outside the sprint's diff scope* (e.g., while reviewing the auth feature's diff, the silent-failures scanner flagged a swallowed exception in a helper that wasn't touched by the sprint), capture it as an IDEA — not a `B-CR-*` bug. The B-CR bugs are for in-scope code-review findings that need fixing before this sprint ships; out-of-scope findings are for the next sprint's planning to consider. See Stage 4's "Capture Out-of-Scope Gaps as IDEAs" section for the full protocol — it applies to Stage 0 findings too, with `found_during: code-review-stage-0` in the frontmatter instead of `surface-gap-stage-4`. Hard cap: 5 per stage (enforced separately from Stage 4's cap — Stage 0 and Stage 4 have independent budgets).

Log each iteration in PROGRESS.md:
```
## Code Review
| Iteration | Must-fix | Should-fix | Consider | Action |
| 1         | 3        | 5          | 2        | Fixer addressed 8 findings |
| 2         | 0        | 1          | 2        | Fixer addressed 1 finding |
| 3         | 0        | 0          | 2        | Clean — proceeding |
```

## Stage 0.5 — Code Simplification (mechanics)

Skip if `--skip-code-review` is passed (same gate as Stage 0).

After the code review loop exits clean, run a simplification pass on the sprint's changed code. The code review fixer may have introduced quick patches; this pass cleans them up for clarity, consistency, and reuse before tests and demo.

1. Get the sprint diff file list:
   ```bash
   git diff --name-only $(git merge-base HEAD <main_branch>)...HEAD
   ```
2. Spawn the simplifier agent:
   ```
   Agent(subagent_type: code-simplifier:code-simplifier, prompt: |
     Review and simplify the following files that were changed in this sprint.
     Focus on: reducing unnecessary complexity, eliminating redundant code,
     improving naming, consolidating related logic, and applying project
     conventions from CLAUDE.md. Preserve all functionality.

     Changed files:
     [list from step 1]

     Commit your changes as: refactor: simplify sprint code)
   ```
3. Verify a commit exists after the agent returns. If no commit → the simplifier found nothing to improve (clean pass).
4. Log in PROGRESS.md: `Simplification: [N files touched | no changes needed]`

**Scope guard:** The simplifier only touches files in the sprint diff. It must not modify files outside the diff scope. If the agent's commit touches unexpected files, revert with `git reset --hard HEAD~1` and proceed without simplification.

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
