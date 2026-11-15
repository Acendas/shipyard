# Phase 5 Approval Gate and Phase 6 Finalize — Detail

This is the full protocol for Phase 5 (Spec Approval Gate) and Phase 6 (Finalize) in `/ship-discuss`, shared by NEW, REFINE, EPIC and IDEA-graduated runs. The SKILL router holds only the headings, the Read lines and the terminal lock-release calls; this file holds the how.

## Phase 5: Spec Approval Gate (NOT an Implementation Plan)

Story files are already written with `status: proposed`. This is a spec approval summary — implementation belongs to `/ship-execute` after `/ship-sprint` plans the work. It is never this skill's job.

**STOP rule — read before presenting the summary.**

The summary is *past-tense outcomes only*. What was discovered, decided, and written to spec files. No future-tense implementation verbs (`will modify`, `add function`, `edit class`, `change file`). If you catch yourself composing any of the following, you are in the wrong skill — stop and resume the discussion:

- File paths outside `<SHIPYARD_DATA>/` as steps to change
- A task list that reads like TODO items for building the feature
- Anything that looks like `/ship-execute`'s output

Output the discussion outcome as text. Use these sections only — describe what already exists in the spec files, not what should be built:

- **FEATURES DEFINED** — per feature: ID, title, points, RICE, complexity, one-line user story, acceptance-scenario count, NFRs, high-RPN failure modes, edge cases, dependencies
- **ACCEPTANCE SCENARIOS (VERBATIM)** — for each feature, list **every acceptance scenario in full Given/When/Then text** exactly as it was written to the spec file.
  For each feature, group scenarios by tier:
  - **Core AC** — happy path + edge cases
  - **E2E AC** — taxonomy-validated scenarios (show `[category]` tag for context) Do not paraphrase, do not summarize, do not list "N scenarios" without showing them. These scenarios are the test contract that `/ship-execute` will treat as authoritative — the user must read the actual text, not approve on a count.
- **HOW WE'LL PROVE IT WORKS** — per feature, the `user_flow_probe`: its `kind` and, verbatim, the `command` and/or `steps`. This is the proof the feature works *for a user*, and it is part of what "Approve everything" approves — a probe the user never read is a bar they never agreed to. Flag `kind: manual`/`assisted` explicitly ("this one needs you to confirm on a device at sprint end") so the later interruption is expected rather than a surprise, and flag any `skip-with-reason` as a known gap.
- **IDEAS CAPTURED** — tangential ideas filed during discussion
- **EPIC** — if assigned, show epic with all features
- **IMPACTS** — cross-feature changes already applied to spec files
- **BACKLOG EFFECT** — re-estimation notes, priority shifts
- **ASSUMPTIONS MADE** — every `ASSUMED:` entry from the feature Decision Logs (the HIGH-tier decisions the confidence gate resolved without asking), each with its evidence one-liner and reversibility. Lead the section with "flag any to change before approval" — this is the one cheap audit point for the decide-and-inform assumptions (see `references/question-design.md`).
- **SCOPE-DRIFT DIFF** — the Phase 4.97 two-column "Started with → Landed at" diff (defined in `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/viability-and-scope-drift.md` § "Phase 4.97: Scope-Drift Check"; NEW and REFINE have already read it), shown here rather than as a separate interruption.
- **UNRESOLVED** — quality-gate items flagged for follow-up

**One approval card, asked last.** Everything the user approves — the acceptance scenarios, the scope coverage, and the spec — is approved in ONE gate. Render-before-ask applies (see `references/question-design.md` § "Render before asking"): every acceptance scenario is quoted VERBATIM in the summary text above (the ACCEPTANCE SCENARIOS (VERBATIM) section), the SCOPE-DRIFT DIFF is shown, and the ASSUMPTIONS MADE are listed — all as chat text — BEFORE the single AskUserQuestion. The user reads the real scenario text and scope diff on screen; the tool call carries only the short question and option labels. Approving is therefore approve-having-read, not approve-a-count.

Render the full summary as text first (all sections above — this is the render-before-ask step), including what was decided without asking: every ASSUMED line and every dropped question with its reason (`shipyard-data discuss-questions status`). Then the approval, as the list's last card: `shipyard-data discuss-questions add --kind gate --by main --summary "<the 15-second summary>" --question "Approve the story as written?" --option "Approve everything::…" …` with the choices below, and `discuss-questions next`. The list hands it out only when no decision is open and no research is running:

- **Approve everything (Recommended)** — approves the acceptance scenarios as written, confirms nothing was dropped from the original scope, and approves the spec. Proceeds to Phase 6 (Finalize). The discussion is not complete until Phase 6 runs in full.
- **Fix an acceptance scenario** — a scenario is wrong, unclear, or missing. A follow-up `AskUserQuestion` captures which scenario and the correction; update the story file, re-render the affected scenario(s) as text, and re-present this gate.
- **Something's missing from the original scope** — using the SCOPE-DRIFT DIFF, the user names a dropped concern. Re-enter Phase 1 with it as the seed (re-run 1.5b → 2 → 3), or promote a captured IDEA back into the feature (inline-merge or split into a sibling feature); then re-render and re-present this gate.
- **Refine** — broader iteration; stay in discussion, re-enter Phase 5 when ready. Do not run `lock release` — the planning lock stays held.
- **Reject** — leave features at `status: proposed`, run `shipyard-data discuss-questions pause` (any question still waiting is kept for the resume), stop the researcher if it is still listed, then release the planning mutex with `shipyard-data lock release planning --skill ship-discuss` as the last action and stop. User can resume with `/ship-discuss [ID]`. Keep the lock only for nonterminal **Refine** paths.

**Do not skip rendering the verbatim scenarios and the scope-drift diff before this gate.** The render-before-ask guarantee puts the actual scenario text on screen, so the user never approves a bare count. Loop the "Fix an acceptance scenario" and "Something's missing" adjust paths — re-rendering and re-asking — until the user picks **Approve everything**.

---

## Phase 6: Finalize (only on Approve)

## Ordering invariant

Run these steps in order. The active-skill mutex stays active until the **very last** step so that any accidental Edit to a source file during Finalize still gets blocked — that's the whole point of the ordering. Do not reorder to "optimize" the cleanup.

0. **Gate: every approved feature has a `user_flow_probe`.** Before flipping any status, run `shipyard-data story check-probes <all approved IDs>` (one call, space-separated). It exits 0 only when every named feature carries a valid `user_flow_probe:` (any `kind`, or a `skip-with-reason` with a populated `user_flow_probe_skip_reason`; a legacy `demo_probe:` counts). **On a non-zero exit, do NOT proceed to step 1** — the CLI names the offending features. This is the omission Phase 3 is supposed to prevent but does not enforce; authoring the probe *here*, before finalize, is what makes the field a real bar rather than a rubber stamp added after a sprint has already built the feature. For each named feature, author its `user_flow_probe:` now (see `references/phase-3-write-spec.md` for the shape and the `kind` decision table — pick `auto` for a callable surface, `assisted`/`manual` for on-device/UI-only flows), render the drafted probe as chat text so the user sees the bar they are approving, then re-run `check-probes` until it exits 0. Only a deliberate `skip-with-reason` (no proof of any kind exists) may pass without a probe command/steps. Do not "approve" a feature past this gate on the promise of a later probe. **Second gate, same moment:** `shipyard-data story check-scenarios <all approved IDs>` — exit 3 names each scenario with no id, no level tag, a level below the journey with no `# why not e2e:` line, or a story with no `## Paths` map. Fix the story and re-run; do not finalize on exit 3. This applies to every lane that writes scenarios (new, refine, idea, chained). `story set-status <id> approved` runs the same check on a `proposed` story and refuses with the same list, so no lane can approve around it.
1. **Update feature statuses.** For each approved feature, run `shipyard-data story set-status SNNN approved`. It refuses while the story's discussion still has a question waiting, research running, or an answer the researcher never read: finish those, do not force it. Then close the question list: `shipyard-data discuss-questions reset` (it logs the counts; the cards in the steps below are no longer checked against it).
2. **Append to BACKLOG.md.** Run `shipyard-data backlog add <IDs>` (one call, all approved IDs together — the CLI inserts each in RICE-sorted position).
3. **Mark graduated ideas.** If any features were sourced from an IDEA file (IDEA mode), run `shipyard-data idea set-status IDEA-NNN promoted --to SNNN` (writes `status: promoted` + `promoted_to: SNNN` atomically, plus the legacy `graduated_to:` key) now. These `shipyard-data` Bash calls run fine inside the guarded window — the active-skill mutex only blocks accidental Edits to source files, not CLI state mutations. Doing this here — inside the guarded window — keeps the lifecycle change inside the mutex window.
4. **Constitution amendment prompt.** If `.research-draft.md` has a `## Constitution Gaps` section with unresolved-or-resolved entries, surface them now. For each gap, the Phase 1.5b discussion produced an explicit decision (the user picked an approach for the gray area) — those decisions are candidate constitution rules. Render the gap list as chat text first — one line per gap: "how to handle X — decision: Y — would land in project-<area>.md" — then a single AskUserQuestion carrying only "Add these decisions to the project rules? (yes/pick/no)". The gaps live in `.research-draft.md` (a Read result); a bullet list packed into the question string renders as a compact card and does not count as shown. On `yes`/`pick`, append to the most relevant existing `project-*.md` (or create `project-<area>.md` if none fits) with the decision, the *why*, and the feature ID that prompted it as the rationale anchor. Do this BEFORE step 5 so the rules land inside the mutex window.
4b. **Commit the decision record this discussion wrote.** When the discussion edited tracked project files (a decision log, a design doc the project's own rules say to keep current), they must reach builders, who work from the last commit. Name those paths in the approval ask ("…and commit the decisions recorded in `<path>`"); on approval commit exactly those paths, by name, never `git add -A`: `git add <path> [<path> …] && git commit -m "docs: decisions for <story ids>"`. No push. If the owner declines, say that builders will not see the lines. Before this the planner asked the same question at the start of every sprint. The planning lock enforces it: `lock release` is refused while a project file this command changed is uncommitted. While a sprint is building in the same folder there is no way around it (`--leave-changes` is refused for a file this discussion wrote): the approval the person gave covers this commit, and it is not a commit "made without being asked".
5. **Mark `.research-draft.md` obsolete via CLI** if it still exists with the current topic — run `shipyard-data draft obsolete-research --topic "<current topic>"` to set `obsolete: true` in its frontmatter.
6. **Print the Next Up block** (see SKILL.md "Next Up" section). The user sees it and the conversation is effectively over.
7. **Last action — after everything above has flushed:** run `shipyard-data lock release planning --skill ship-discuss` (soft-delete sentinel — CLI-owned, never a hand Write). Until this step, the active-skill mutex still claims this session for `/ship-discuss` and other skills entering will refuse. After this step, do **not** continue with any tool calls — the discussion is done. If the user wants to build the feature, they will run `/ship-sprint` in a new session.

## REFINE-mode differences

REFINE-specific differences from the NEW-mode finalize:

- Phase 6 step 1 is a no-op for features that were already `status: approved` before this session — leave the status alone.
- Phase 6 step 2 is a no-op if the feature ID is already in BACKLOG.md (REFINE edits an existing backlog entry, it does not append a duplicate).
- Phase 6 step 3 (idea promotion via `shipyard-data idea set-status ... promoted --to ...`) only applies if this REFINE run just graduated an idea; otherwise skip.
- Phase 6 step 4 (constitution amendment prompt) runs when this REFINE pass produced constitution decisions worth recording; otherwise skip it.
- Phase 6 step 5 (draft cleanup) runs when a current `.research-draft.md` exists; otherwise skip it.
- Phase 6 steps 6 and 7 (Next Up + `lock release planning`) always run, in that order. The guard cleanup is still the very last action so any accidental source-code Edit during the wrap-up is still blocked.

If the REFINE run was interrupted by the "cancel" branch of the Sprint Impact Check (Step 0), the active-skill mutex still needs to be cleaned up — run `shipyard-data lock release planning --skill ship-discuss` as the last action before returning control to the user.

## Idea graduation target

The graduation target for IDEA-mode features is:
```
<SHIPYARD_DATA>/spec/ideas/IDEA-NNN-[slug].md
```

When Phase 6 runs for an idea-sourced feature, after appending to BACKLOG.md, run `shipyard-data idea set-status IDEA-NNN promoted --to SNNN`. Confirm: "IDEA-NNN has been promoted to [SNNN: title]." Doing this inside Phase 6 keeps it inside the mutex window. Listings filter `status: promoted` (and legacy `graduated`) ideas out by default; physical removal is manual for now.
