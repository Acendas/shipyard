# Review stages: tests, spec review, quality gates, visual, goal verification

Moved verbatim from SKILL.md; cursor, stage order and gates stay there.

## Stage 1: Run Tests & Spec Verification

**1a. Run all tests — check-first against the verification ledger.** `/ship-execute` already ran these exact tiers against this exact commit before handing off to review. For each tier configured in `<SHIPYARD_DATA>/config.md` (`test_commands.unit`, `test_commands.integration`, `test_commands.e2e`), resolve the literal command string first, then run `shipyard-data verify check --key test_commands.<tier> --command "<resolved command>"` BEFORE dispatching anything:

- **Exit 0 (FRESH)** — a clean pass for this exact command is already recorded against the current working tree (same `git rev-parse HEAD^{tree}`, recorded with a clean porcelain status, within TTL, capture file intact). Skip dispatching this tier entirely — reuse the recorded exit code + capture path as this tier's verdict for Stages 3–5.
- **Exit 3 (STALE)** — no fresh proof exists (never recorded, tree changed, TTL expired, capture missing, or any other unevaluable condition — the ledger fails safe to STALE, never to a skip). Run it exactly as before: follow the **`dispatching-operational-task` playbook**; the capability skill captures output through `shipyard-logcap` and returns the structured verdict (PASS/FAIL counts in `LAST_LINES:`). On the tier passing (exit 0), run `shipyard-data verify record --key test_commands.<tier> --command "<same resolved command>" --exit 0 --capture <capture path>` so a later check (a subsequent tick, or the release-approval gate) can reuse it.

One operational dispatch per stale tier, or one combined dispatch if your project supports a single command (check/record that combined command under one key, e.g. `test_commands.all`, instead of per-tier).

**This is never a blanket skip.** Stage 0 (code-review fixer) and Stage 0.5 (simplifier) run before Stage 1a and both commit whenever they find something to fix — so on any review that found something, the working tree has changed since `/ship-execute` recorded its tiers, and `verify check` correctly reports STALE (the recorded tree-id no longer matches `HEAD^{tree}`) — that re-run is intended behavior, not a bug to work around. On a clean review (nothing for Stage 0/0.5 to fix), the tree is unchanged and every tier reports FRESH.

**Render the decision as chat text** — a skip the user can't see is indistinguishable from a stage that silently didn't run. One line per tier, naming which were skipped (with the evidence: tree-id prefix + when recorded) and which ran (with why: dirty tree since fixer commit, no prior record, TTL expired, etc.):

```
→ Stage 1a: unit SKIPPED (fresh — tree a3f9c21…, recorded 4m ago)
→ Stage 1a: integration SKIPPED (fresh — tree a3f9c21…, recorded 4m ago)
→ Stage 1a: e2e RAN (stale — working tree changed since recording) → PASS
```

Use the returned or reused verdicts for Stages 3–5 either way — do not run a tier a second time in this invocation.

- **Cursor advance (after 1a)**: run `shipyard-data cursor advance review spec_review --note "Run Stage 1b spec review per feature"`.

**1b. Spec review via specialized scanner** — **first run `shipyard-data story-review check --json` (F028).** A story whose per-story review is `settled: true` was reviewed at the wave boundary where its last step merged; do NOT repeat its spec review here — the sprint-level review covers only the cross-story checks, the full build, the demo and the retro. Re-review a story only when it is unsettled, or when its recorded `head` no longer matches HEAD (a Stage 0/0.5 fixer commit touched it). For each story that still needs it, follow the **`dispatching-spec-review` playbook** with `scope: "feature"` and `target_ids: [FEATURE_ID]`. The capability skill:

- Reads the feature spec at `<SHIPYARD_DATA>/spec/stories/[FEATURE_ID]-*.md` and each path listed in its `references:` frontmatter array (skill body handles the conditional inclusion automatically — no need to construct two prompt variants).
- Reads the related step files filtered by feature.
- Reads the diff (`base_ref` = sprint base, `head_ref` = current HEAD).
- Maps every acceptance criterion to code, classifies as MET/PARTIAL/MISSING/OVER-BUILT, and returns structured findings.
- Enforces read-only via post-return `git status --porcelain` check.

Pass to the capability skill:

| Parameter | Value |
|---|---|
| `scope` | `"feature"` |
| `target_ids` | `[FEATURE_ID]` |
| `base_ref` | `git merge-base HEAD <main_branch>` |
| `head_ref` | Current HEAD |
| `data_dir` | Literal SHIPYARD_DATA path |

Use the capability skill's structured findings (`STATUS: PASS` or `STATUS: FINDINGS` with classification) in Stages 3–5. Security, bugs, silent failures, patterns, and tests are NOT this skill's job — those went through `dispatching-code-review` in Stage 0.

- **Cursor advance (after 1b)**: run `shipyard-data cursor advance review quality_gates --note "Run Stage 1.5 quality gate enforcement"`.

## Stage 1.5: Quality Gate Enforcement

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-review/references/quality-gate-enforcement.md`

Read `<SHIPYARD_DATA>/sprints/current/QUALITY-GATE.md`. For each probe/tool gate, dispatch via `dispatching-operational-task`. Collect manual gates into a checklist for Stage 5. Write results back to QUALITY-GATE.md. If >50% of gates fail, render the per-gate results (gate, verification type, pass/fail) as chat text, then AskUserQuestion: continue or abort.

**Skip if:** QUALITY-GATE.md doesn't exist or is empty.

- **Cursor advance**: on completion, run `shipyard-data cursor advance review visual` (or `... goal_verify` if no UI) and echo its output.

## Stage 2: Visual Verification (UI tasks)

If a story in scope has `ui: true` (E005) — otherwise record `visual: skipped (no UI stories)` and advance:
1. `shipyard-data ui doctor` — `ui.adapter: none` or a missing Playwright means this stage is **skipped with one line**, never faked; say what to configure.
2. Ensure the dev server is running (auto-start if needed; `ui.base_url`).
3. Three deterministic levels, in order, each through the CLI (a model may flag, never approve):
   - **component** — `shipyard-data ui verify --level component --spec <SHIPYARD_DATA>/ui/<S###>/component.json --story <S###>`: computed styles, boxes, states and the accessibility tree for the story's stable element ids (from its Interface section) against the expectations you write into the spec file from the acceptance criteria.
   - **screen** — `shipyard-data ui verify --level screen --spec <SHIPYARD_DATA>/ui/<S###>/screen.json --story <S###>` at 375 px (then 768, 1024): tolerant screenshot diff against the approved design snapshot (`spec/designs/<S###>-v<n>.png`, masks for dynamic regions) plus the design lint rule pack (verified rules are errors, draft rules warnings; `shipyard-data ui rules` lists them).
   - **flow** — `shipyard-data ui verify --level flow --spec <SHIPYARD_DATA>/ui/<S###>/flow.json --story <S###>`: the user flow's steps with a screenshot each, diffed against the prototype flow's baselines when the design stage produced them.
4. Each run writes a report under `<SHIPYARD_DATA>/ui/reports/` and logs `ui_verified`; every `error` finding is a review finding (deviation from the approved design or a design-lint failure). Read the captures with the Read tool before writing the finding text — the number says *that* it differs, your eyes say *what*.

**Live-capture the dev server and E2E runs.** Anything you run here to observe behavior (dev server startup logs, E2E runner output, `curl` sanity checks against the running app) goes through `shipyard-logcap run <name> --max-size <S> --max-files <N> -- <command>` unless the command already writes its own log file. Review re-runs are the most expensive kind — Opus-level reasoning burning tokens on output you already saw. If the first run surfaces something you want to inspect more closely, `shipyard-logcap grep` the existing capture with a different pattern **before** re-running the thing. For bound-picking guidance, see the logcap usage notes in `${CLAUDE_PLUGIN_ROOT}/skills/ship-execute/references/context-management.md`.

- **Cursor advance**: run `shipyard-data cursor advance review goal_verify --note "Run Stage 3 goal verification"`.

## Stage 3: Did We Actually Achieve the Goal?

Tests passing is necessary but not sufficient. A component can pass its own tests but never be imported anywhere. This stage checks whether the *feature actually works end-to-end*, not just whether individual tasks completed.

For each feature, answer three questions:

**1. Observable Truths** — What must be TRUE for the feature to work?
Derive 3-7 behaviors from the acceptance scenarios. Verify each by running the app or checking code paths.
```
Example for S001 (Email Login):
  ✅ User can submit email + password → verified via E2E
  ✅ Invalid credentials show error → verified via E2E
  ✅ 5 failed attempts trigger rate limit → verified via integration test
  ❌ Session persists across page reload → no test, no implementation found
```

**2. Required Artifacts** — What files/components must EXIST?
Check each artifact is substantive (not a stub, placeholder, or TODO):
```
  ✅ src/app/login/page.tsx — 142 lines, renders form
  ✅ src/lib/auth.ts — 89 lines, handles auth logic
  ⚠️ src/middleware.ts — exists but auth check is commented out (STUB)
```

**3. Wiring Check** — Are the pieces actually CONNECTED?
Grep for imports/usage to verify component A actually calls component B:
```
  ✅ login/page.tsx imports auth.ts → confirmed
  ✅ middleware.ts imported in next.config → confirmed
  ❌ auth.ts → database client → no import found (ORPHANED)
```

**Verdicts per artifact:**
| Exists | Has real code | Connected | What it means |
|--------|--------------|-----------|---------------|
| Yes | Yes | Yes | ✅ Good to go |
| Yes | Yes | No | ⚠️ Built but nothing uses it yet |
| Yes | No | — | ⚠️ Placeholder — needs real implementation |
| No | — | — | ❌ Not built yet |

Any item that isn't "Good to go" → flag as a gap.

**4. Operational Task Evidence Check** — For any task in this feature with `kind: operational`, the standard Wiring Check is useless: operational tasks produce no code artifacts to import-check. They need a different verdict based on captured command output instead.

For each `kind: operational` task in the feature:
```
  ✅ P007 — verify_output: P007-verify-iter2, 8412 bytes, last exit: 0
  ❌ P012 — verify_output: absent (SILENT-PASS: task marked done without running command)
  ⚠️ P019 — verify_output: P019-verify-iter1, 0 bytes (capture empty — broken runner?)
```

Check each operational task:
1. Step file has `verify_output:` field populated (not empty string, not commented out). Missing → **SILENT-PASS**, the exact failure mode the operational dispatch path exists to prevent.
2. `verify_output` resolves to an existing non-empty file. For new operational tasks this is an absolute `shipyard-logcap path ...` result; for older step files that stored only a logcap capture name, resolve it once with `shipyard-logcap path <verify_output>`. Missing file → **capture lost**, needs re-run.
3. Byte count is non-zero. Zero bytes → **broken runner**, the command reported success but produced no output.
4. Final `verify_history` entry has `exit: 0`. Non-zero → task shouldn't be done at all.

Any operational task that fails any of these is a **critical gap** — automatically upgraded to must-fix regardless of what the acceptance criteria say, because the task's deliverable was running a command and we have no evidence the command ran. If you find a silent-pass, also recommend the user add the task to `ship-sprint`'s carry-over scan (Step 1.5, check #5) as a safety net for the next sprint.

- **Cursor advance**: run `shipyard-data cursor advance review gap_analysis --note "Run Stages 4 + 4.5 surface-gap + self-review"`.
