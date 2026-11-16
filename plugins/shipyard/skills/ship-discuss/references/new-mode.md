# NEW Mode: Discover Features (Phases 0 through 4.97)

Loaded by SKILL.md for NEW mode (and IDEA-graduated-to-NEW). Phase 5 (approval gate) and Phase 6 (finalize) are read from references/phase-finalize.md via the SKILL router. Mode detection, the session mutex, onboarding gate and Rules are in SKILL.md.

### Phase 0: Create the Phase Checklist (task list)

On entering NEW mode, `TaskCreate` one task per phase so the user can see where the discussion is and skipped phases become visible instead of silent:

| # | Subject |
|---|---------|
| 1 | Phase 1: Understand — discovery conversation |
| 2 | Phase 1.5: Research (constitution, internal, external, diagrams) |
| 3 | Phase 1.5b: Challenge & Surface |
| 4 | Phase 2: Viability Gate (5 gates) |
| 5 | Phase 3: Write to Spec |
| 6 | Phase 3.5: Impact Analysis |
| 7 | Phase 3.7: E2E AC Validation |
| 8 | Phase 3.8: Simplification Scan |
| 9 | Phase 4: Capture Tangential Ideas |
| 10 | Phase 4.5: Backlog Re-evaluation |
| 11 | Phase 4.9: Quality Gate (self-review loop) |
| 12 | Phase 4.95: Adversarial Critique |
| 13 | Phase 4.97: Scope-Drift Check |
| 14 | Phase 5: Spec Approval Gate |
| 15 | Phase 6: Finalize |

Create all 15 in one batch (subjects prefixed with the topic slug, e.g. `[auth-flow] Phase 2: Viability Gate`, so parallel sessions don't collide). `TaskUpdate` each to `in_progress` when its phase starts and `completed` when it ends. If a mode variant legitimately skips a phase (e.g. REFINE entering mid-flow), mark the skipped tasks `completed` with a `skipped: <reason>` note in the description — never delete them silently.

**Deep-dive dispatch coverage.** The analytical bulk of Phases 1.5, 3.5, and 3.8 runs inside the single dispatched **design deep-dive** agent (see Phase 1.5), which produces the dossier those phases consume. Those phases still exist as shell steps — they present the dossier's findings and drive the user-facing gates — so keep their tasks in the checklist. The deep-dive is dispatched **concurrently at Phase 0.6** (seeded with the topic) so its no-user-input passes overlap the Phase-1 conversation; mark task 2 (Phase 1.5) `in_progress` at that dispatch and `completed` once the dossier is written and presented. Tasks 6 (Phase 3.5) and 8 (Phase 3.8) track the shell's present-and-apply steps as usual.

**Questions are asynchronous (4.20, load-bearing).** There are no question "rounds". Read `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/async-questions.md` now and follow its loop for the whole discussion: research runs in the background and puts its questions on the question list, you add your own to the same list, and the person is shown one card at a time, the one that unblocks research first. Every card after `discuss-questions start` comes from the list (the card hook refuses any other). The phases below stay as work and checklist steps; wherever one says to ask, it means "add it to the list and run the loop".

**Guardrail (load-bearing): the task list is a progress surface and a recovery anchor, NEVER authority.** Do not gate any behavior on TaskList state, do not cite task status as evidence a phase ran, and never mark a phase's task completed before the phase's file/event artifacts exist. The spec files, `.research-draft.md`, and the event log remain the record; the tasks are the user-visible mirror. (Same discipline as PROGRESS.md vs the event log.)

### Phase 0.6: Dispatch the design deep-dive in the background (concurrent)

**Immediately after mode detection routes to NEW (or IDEA-graduated-to-NEW), before your first question:** (1) start the question list: `shipyard-data discuss-questions start --topic <slug> --budget <refine_rounds × 4, or 12>`; (2) dispatch the design deep-dive agent **in the background**, seeded with the TOPIC and the researcher's protocol from `async-questions.md`. It runs the whole research protocol on its own, adds a question whenever it reaches something only the person can decide, and keeps working. See Phase 1.5 for the exact dispatch.

**Fallback:** if background dispatch is unavailable or the launch fails, still start the question list, ask your own questions through it, then dispatch the deep-dive as one synchronous agent (Phase 1.5 fallback). Questions it adds are asked when it returns.

### Phase 1: Understand

**Read the two authorities for this phase:**
- `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/question-design.md` — **how to ask**: the confidence gate (run BEFORE composing any question), the ten-rule rulebook and the kill-list. This governs everything user-facing below.
- `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/discovery-techniques.md` — JTBD, user journey mapping, pre-mortem, ISO 25010, ATAM, EARS, IEEE 830. **These structure YOUR analysis only** — their vocabulary never reaches the user (rule Q1 + kill-list #5). Apply them throughout Phases 1-3 as scaffolding, then translate every probe into a concrete scenario before asking.

**Communication design:** When surfacing something the user hasn't considered, use the 3-layer pattern from `references/communication-design.md` — one-liner (what + recommendation), context (why it matters, tradeoff, analogy if helpful), detail (only for high-stakes). Max 3–4 new concepts and 2–3 options per question. Under 100 words per decision message. Name the tradeoff on each option. Always recommend a default.

**Think first (bulk understanding).** Do the derivation BEFORE composing any question:

1. **List every unknown** the spec would need answered. Use the JTBD and journey lenses as scaffolding: who is the user, what job are they hiring this for, what do they do today without it, what triggers usage, what's the before/during/after flow, where can they abandon, what's the business value, what constraints exist.
2. **Kill what the record already answers** (kill-list + rule Q8). Grep the codebase/config, the spec + Decision Logs + constitution, git history, and the user's own words this session. For anything found, STATE it rather than ask ("You're on Postgres with row-level tenancy, so I'll scope this per-tenant").
3. **Run the confidence gate** over every remaining item (question-design.md). HIGH items (evidence converges AND two-way door) are decided, informed in one line, and logged as ASSUMED — they never reach AskUserQuestion. Only MEDIUM and LOW items are asked.
4. **Add everything that remains to the question list** (`shipyard-data discuss-questions add … --by main`, one question each: a 40-word summary, one picture or example, one sentence, 2 to 4 choices with the recommended one first), then run the loop in `async-questions.md`. Do not hold questions back to ask them together, and do not ask one the researcher already added: `add` prints the questions on the list. Every question is scenario-framed and past-behaviour-anchored per the rulebook — never framework vocabulary, never a hypothetical-opinion probe.

If this discussion arrived via the detailed-topic heuristic (NEW-by-assumption), fold the stated mode assumption into your first line ("Treating this as a full feature discussion — say 'just stash it' to capture as an IDEA instead") rather than spending a separate confirmation.

**Always use AskUserQuestion — never plain text — to ask questions**, and only for the question `discuss-questions next` handed out. AskUserQuestion suspends execution and waits for input; plain text does not.

**There is no hand-off message.** The researcher reads every answer from the list at its own checkpoints (a message to a busy agent is not read until it finishes). Only when it has returned `PARKED:` do you message it once, "answers are in, carry on".

**Key behaviors during conversation:**
- **Splitting:** If the user describes multiple distinct features, use AskUserQuestion: "I'm hearing two things: [X] and [Y]. Want to capture them separately?"
- **Branching:** If something tangential comes up, capture it as an idea inline and state it as plain text: "That's a good point — I'll capture that as IDEA-NNN. Let's stay focused on [current topic]." (This is a statement, not a question — no AskUserQuestion needed.)
- **Referencing:** If it relates to an existing feature, use AskUserQuestion: "This connects to S003 — should we extend that or keep this separate?"
- **Parking:** If user says "not now" about something, record it in the decision log as deferred with their reasoning.

### Phase 1.5: Research (via the design deep-dive dispatch)

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-1-research.md`

The analytical bulk of this phase runs in **one dispatched design deep-dive agent** — the shell (this session) stays lean for conversation and gates; the heavy reasoning (research, diagram generation, viability pre-assessment, impact + simplification prep) runs on the think tier. The shell then **presents the dossier's findings conversationally** and drives the user-facing gates itself.

**Dispatch it once, in the background, at Phase 0.6.** It needs no hand-off: what the person answers reaches it through the question list.

- **Launch (Phase 0.6).** `run_in_background: true`, a stable `name` from the topic slug (`deepdive-<slug>`), the TOPIC, and the researcher's protocol block from `async-questions.md` with the topic and its name filled in. Print the dispatch banner: `→ Research started in the background · questions will come one at a time`.
- **While it runs.** Run the loop in `async-questions.md`: ask what is on the list, record answers, and when nothing is waiting start `shipyard-data discuss-questions wait` in the background and end your turn. It returns `PARKED: Q…` when only branches that wait on open questions are left; ask those, then message it to carry on.

When the agent returns, **lead with its one-line summary** ("→ Deep-dive back: 3 findings, viability clean, 1 data-model risk").

**Fallback (background dispatch unavailable or failed).** Dispatch **the whole deep-dive as ONE synchronous subagent** after your own questions are answered, with the same prompt. Note the fallback to the user in one line. Questions it added are on the list when it returns: run the loop. If it could not run `shipyard-data`, its return text carries `QUESTION:` lines; add each one yourself.

**Model + effort (think).** If a `--think` override is active, add `--override <think_override>` (the CLI skips config for the model); run `shipyard-data resolve-model think [--override <think_override>]` — it prints exactly one line `model=<m> effort=<e>`; pass each value as a string on the Agent call and OMIT any field whose value is empty (inherit). Never hardcode a model literal or re-derive the tier from config.md by hand. Log it once: `shipyard-data events emit dispatch_model_resolved role=<role> model=<model or inherit> effort=<effort>` (a logging failure never blocks the dispatch). `agent_effort.think` (default `high`) is resolved by the same call. **Spawn-failure fallback:** if the dispatch errors at spawn because the requested model is unavailable, print one line ("`<model>` unavailable — falling back to the configured think tier") and re-run `shipyard-data resolve-model think` WITHOUT `--override`, then re-dispatch with that result.

```
Agent(subagent_type: "general-purpose", model: <model= from resolve-model think; omit if empty>, effort: <effort= from resolve-model think; omit if empty>, prompt: |

You are the design deep-dive for a Shipyard feature discussion. Perform the
analytical bulk of the discovery pipeline and write a structured design
dossier. You have Read/Grep/Glob/LSP/WebSearch/WebFetch, and Bash ONLY for
`shipyard-data discuss-questions …`. You are READ-ONLY on source; the only
files you WRITE are the dossier below and the small "show" files for your
questions (under <SHIPYARD_DATA>/spec/.questions/<topic>/). No commits, no subagents.

# How you reach the person
<paste the researcher's protocol block from
 ${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/async-questions.md here,
 with the topic slug and your agent name filled in>

# Input
Feature topic (always provided at dispatch):
  <the topic string>
What the person has said so far (anything in the request itself; everything
else reaches you as answers on the question list, which you read at each
checkpoint — do every step you can on what you know, and park only the
branch that truly waits for an answer):
  <users, core behavior, value, constraints, and any decisions already made>
Data dir: <SHIPYARD_DATA>
Plugin root: ${CLAUDE_PLUGIN_ROOT}

# Do (in order)
1. Run the full Phase 1.5 research protocol in
   ${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-1-research.md,
   in its documented order: (1) constitution check (tensions + gaps);
   (2) internal research; (3) how others solve it (WebSearch established
   products / complaints / security pitfalls; WebFetch docs);
   (4) Architecture visualization — diagrams gated on architectural
   significance, not participation (the seven types, each with its own
   trigger, plus the skip criteria); (5) data-modeling guidance (gated) —
   when the feature persists data (ER/data-model trigger fired or a
   `## Data Model` concern exists), Read and apply
   ${CLAUDE_PLUGIN_ROOT}/project-files/references/data-modeling-guide.md;
   skip for features with no persistence concern.
2. Viability pre-assessment against the 5 gates (USER VALUE, DEFINABLE,
   BUILDABLE, TESTABLE, SCOPED): per gate, cite the evidence and a
   pass/concern verdict. This is INPUT for the shell to walk with the user —
   you do NOT decide viability, you assess it.
3. Impact-analysis prep: which existing features/specs/code areas this feature
   depends on, overlaps, or would invalidate (Glob spec/{stories,features}/[SF]*.md).
4. Simplification-scan candidates: places the feature's new libraries /
   utilities / patterns could replace hand-rolled equivalents.

# Return contract
Create the dossier checkpoint at <SHIPYARD_DATA>/spec/.research-draft.md with the frontmatter below. This is the initial narrative artifact creation step; subsequent state changes to this file's frontmatter, such as `obsolete: true`, go through `shipyard-data draft ...` only.
`topic:` + `created:` and these sections (extend the existing checkpoint file;
do not invent a new file):
  ## Research Findings         (HIGH/MEDIUM/LOW confidence, prescriptive "Use X")
  ## Constitution Gaps         (one line per gray area, per the protocol)
  ## Diagrams                  (each diagram as Mermaid, labeled by type)
  ## Viability Pre-Assessment  (per-gate evidence + pass/concern verdict)
  ## Impact Analysis           (affected features/specs/code areas)
  ## Simplification Candidates (reuse opportunities)
Your final text is a SHORT summary (which gates look clean, top findings,
biggest risk). The dossier file is the artifact the shell consumes.
)
```

**Then lead with the one-line result — do NOT dump the dossier as chat prose.** Read `<SHIPYARD_DATA>/spec/.research-draft.md` and open with the one-line summary the agent returned (`→ Deep-dive back: 3 findings, viability clean, 1 data-model risk`). That is all that reaches the chat *now*. Do NOT re-emit the whole `## Research Findings` / `## Diagrams` as running prose just because you read them — that's the commentary quiet-by-default cuts. **Render the specific findings and diagrams in full only at the round that acts on them** (render-before-ask): every dossier section a later round's AskUserQuestion depends on (viability verdicts, impact ripples, simplification candidates) must be rendered as chat text — with a diagram inline (ASCII per `references/communication-design.md`) where it clarifies the decision — immediately before *that round's* ask fires, not here. Later phases consume the remaining sections: Phase 1.5b resolves `## Constitution Gaps`, Phase 2 walks `## Viability Pre-Assessment`, Phase 3.5 reads `## Impact Analysis`, Phase 3.8 reads `## Simplification Candidates`. Phase 3 absorbs Research Findings into the feature's `## Technical Notes` (HIGH/MEDIUM/LOW labels) and persists the Diagrams to `## Flows` as Mermaid.

**If the dossier is not finished and the researcher is still running, wait with the CLI — waiting is never a user decision:** `shipyard-data discuss-questions wait` as a background command, one quiet line (`→ Research is still running`), end your turn. It returns when a question is ready, when research parks or ends, or after its timeout; on timeout check the agent is still listed, and only if it is gone take the inline fallback below — announced as a STATEMENT, never as a question.

**Fallback (dispatch failed or unusable dossier).** If the Agent call fails, returns nothing, or the dossier is missing the sections above, fall back to running the `phase-1-research.md` protocol **inline** in the shell (the pre-4.0 path — the reference is still the protocol either way). Note the fallback to the user in one line and continue; the shell can do the analysis itself, it just costs more of the session's context.

### Phase 1.5b: Challenge & Surface

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-1-5b-challenge.md`

Once you have a reasonable understanding of the feature, **proactively challenge it** before moving to spec. Follow the **`discovering-edge-cases` playbook** to walk the seven discovery categories (boundary inputs, concurrency, failure modes, adversarial input, observability gaps, NFRs, domain-specific) and return structured findings. Pass `feature_text`, `parent_context`, `domain_hints`, and `data_dir`. The capability skill returns a structured list (~3-5k tokens). Also run a quick pre-mortem inline (from `discovery-techniques.md`).

**Presentation.** Follow `references/communication-design.md`. Present ALL findings at once in the compact visual summary (no per-finding drip) as assistant chat text. Then put each ❓/⚠️ theme that needs the person on the question list (one question per theme, its recommended first choice **"Apply all recommendations"**), and the Phase 2 viability echo as an approval (`--kind gate`). The loop asks them one card at a time; the echo comes after the decisions. Each question's show block carries a **mini-story per challenge item** — who hits it, when, what breaks (rule Q9): the one-line finding is the summary, not the example the person reasons from (see `references/question-design.md` § "Render an example scenario").

```
  ⚠️  [Finding]           → [impact], recommend [action]
  ⚠️  [Finding]           → [impact], recommend [action]
  ✅  [Finding]           → [status — no action needed]
  ❓  [Finding]           → needs decision
```

What goes on the list here:
- **Up to 3 themed challenge questions** — group the resolvable findings into ≤3 themes (e.g. security, data model, failure modes); each question's recommended default option is **"Apply all recommendations"** for that theme, so the trusting user resolves a whole theme with one pick. For each item inside a theme: what I found → why it matters → what I recommend.
- **The 4th question is the Phase 2 viability-echo confirmation** (see Phase 2 — mandatory, never dropped): "I'm reading this as one feature, scoped to [scope], with these acceptance themes: [themes]. Does this match your intent?"

**One question per theme, not per finding.** Group the resolvable findings into ≤3 themes; findings the record or the research already settles are stated, not asked. Create/update the dossier body in `<SHIPYARD_DATA>/spec/.research-draft.md` (initial frontmatter `topic:` + `created:` only; later state flags use `shipyard-data draft ...`; body sections `## Research Findings` and `## Challenge Resolutions`).

### Phase 2: Viability Gate

**Read and follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/viability-and-scope-drift.md` § "Phase 2: Viability Gate" (five gates, mandatory verdict echo, default-recommend rule, SPLIT flow, kill/override handling). Read it once here; Phase 4.97 reuses the same file. The dossier-section input (`## Viability Pre-Assessment`) and the delivery rule in Phase 1.5b above still apply: the echo is an approval (`--kind gate`) on the question list, shown after the decisions.

### Phase 3: Write to Spec

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-3-write-spec.md`

For each well-defined feature: generate the next SNNN ID, determine the epic (existing, new, or empty — see reference for the decision tree), and write `<SHIPYARD_DATA>/spec/stories/SNNN-[slug].md` with full required frontmatter (id, title, type, epic, status, story_points, complexity, token_estimate, all RICE fields, feasibility, dependencies, references, external_refs, children, tasks, created, updated).

**External linking:** If the user mentioned an external issue key during discussion (e.g., "this is JIRA-123" or "relates to GH-456"), add it to `external_refs` in the story frontmatter. Don't ask — if they said it, link it. Body sections: user story, Why This Matters, **acceptance criteria in Given/When/Then format** (happy path + at least one edge case), optional Interface / Data Model / Configuration / Flows / Error Handling sections (include only if discussed), Technical Notes (absorbed from `.research-draft.md`), Decision Log. **Hard limit: 200 lines per file** — split into sub-features (S001a/b) or extract to `<SHIPYARD_DATA>/spec/references/SNNN-<slug>.md` if larger. Fill every RICE component field; `rice_score` is the derived cached score `(reach × impact × confidence) / effort` and must match those components. Mark `.research-draft.md` obsolete via `shipyard-data draft obsolete-research --topic "<current topic>"` only after Phase 3 finishes (it is the recovery checkpoint until then).

**Diagram persistence:** Every diagram shown during Phase 1.5 — C4, sequence, state machine, ER, deployment, data-flow, or user-journey — is converted to Mermaid and written to the feature's `## Flows` section (an ER diagram may live under `## Data Model` instead when the schema is the feature's primary artifact). Diagrams shown in conversation are ephemeral — this is the only chance to persist them. The canonical diagram-type → Mermaid-syntax mapping is the single source of truth in `references/phase-3-write-spec.md`; keep this list in lock-step with it. See that reference for format rules.

**ASSUMED logging in the Decision Log.** Every HIGH-tier decision the confidence gate resolved without asking (Phase 1 and throughout) is recorded in the feature's `## Decision Log` in the ASSUMED form, distinct from user-confirmed `DECIDED:` entries:

```
ASSUMED: <decision> — <evidence one-liner> — reversible: yes
DECIDED: <decision> — <user's explicit answer>
```

These ASSUMED entries are what Phase 5's ASSUMPTIONS MADE section reads back for the one cheap audit point. See `references/question-design.md` § "Assumption logging."

**Narrate the write in one line** ("→ Wrote S012 to spec — 4 acceptance scenarios, RICE 24") so the transition into the post-spec decisions is visible, never silent.

### Post-spec decisions (Phases 3.5 → 3.7 → 3.8 → 4.5)

The four post-spec phases below all run their **analysis and present-and-apply work as usual and keep their checklist tasks**. Run all four analyses first, then put each decision that needs the person on the question list (impact ripples to confirm (3.5), E2E AC gaps to accept (3.7), simplification candidates to route (3.8), cross-feature dependency edges (4.5) — never estimate approvals) and run the loop. Each impact ripple that changes existing behaviour carries a one-line **before/after example scenario** in its show block, and each simplification candidate a one-line "today [X] is hand-rolled in [place]; [lib] would do [Y]" example; E2E gaps already carry draft scenarios. Right after writing the story file, bind it: `shipyard-data discuss-questions bind --story <S###>`.

### Phase 3.5: Impact Analysis

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/impact-analysis.md`

**Consume the dossier first.** The design deep-dive wrote the affected features/specs/code areas to `<SHIPYARD_DATA>/spec/.research-draft.md` under `## Impact Analysis`. Read that section and use it as the starting point — present and confirm-then-apply per the protocol rather than re-deriving the ripple set from scratch. If the section is absent (inline-fallback), run the analysis here as before.

**Presentation:** Keep impact summaries under 200 words. Bold the single most important finding. Use the 3-layer pattern for any impact that changes existing behavior. Show an impact diagram for features with multiple ripple effects:
```
  S007 (new) ──impacts──▶ S003 (criteria change)
             ──depends──▶ S001 (must be done first)
             ──overlaps─▶ S005 (shared data model)
```
**Persist it (≥2 ripple edges):** the inline ASCII is ephemeral. When the impact diagram has 2+ ripple edges, convert it to a Mermaid `graph LR` and write it into the new/refined feature's `## Decision Log` so the ripple map survives the session — see `references/impact-analysis.md` § "What Gets Changed on Approval". A single dependency edge stays a sentence (per `references/communication-design.md` "fewer than 3 data points").

**Its ripple confirmation goes on the question list** with the other post-spec decisions.

Skip if Glob `<SHIPYARD_DATA>/spec/{stories,features}/[SF]*.md` returns no results.

### Phase 3.7: E2E AC Validation

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-e2e-validation.md`

After impact analysis, validate the feature's acceptance criteria against the E2E taxonomy. Follow the `validating-e2e-coverage` playbook with the story file path, existing AC, and domain hints. The skill detects touch surfaces from the spec content, maps to the E2E taxonomy, and returns coverage gaps with draft scenarios.

**Skip if:** feature is trivial (`story_points <= 2` AND `complexity == "low"`) or no touch surfaces detected.

**Its accepted-gap decision goes on the question list** with the other post-spec decisions. For accepted gaps, write to the story file under `### E2E AC` within `## Acceptance Criteria`. If adding E2E AC would push the file over 200 lines, extract to `<SHIPYARD_DATA>/spec/references/SNNN-e2e-ac.md`.

### Phase 3.8: Simplification Opportunity Scan

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/simplification-scan.md`

Scan the codebase for places that hand-roll what this feature's new libraries, utilities, or patterns provide. The scan detects five types of opportunities: new dependency replacements, new utility reuse, pattern consolidation, abstraction adoption, and dead code from supersession.

**Skip if:** the feature is purely additive (new endpoint, new UI page) with no reusable infrastructure — nothing introduced that other code could benefit from.

**Consume the dossier first.** The design deep-dive wrote reuse candidates to `<SHIPYARD_DATA>/spec/.research-draft.md` under `## Simplification Candidates`. Read that section and use it as the starting point for the findings below; if absent (inline-fallback), run the scan here.

**At discuss time**, the scan operates on the feature's Technical Notes and research findings (not implementation code, which doesn't exist yet). Focus on:
- Libraries referenced in Technical Notes → grep for hand-rolled equivalents
- Patterns decided in the Decision Log → grep for ad-hoc variations
- Shared utilities mentioned in research → grep for inline duplicates

**Routing at discuss time:** All findings become IDEA files (since there's no sprint to fold tasks into yet). The sprint planning step (Step 3.75) will re-evaluate these and promote trivial/small items into sprint tasks if the feature is selected.

**Its routing decision goes on the question list** with the other post-spec decisions. If no opportunities found, contribute nothing and move on silently.

### Phase 4: Capture Tangential Ideas

Any tangential features mentioned → create as idea files via the same logic as CAPTURE mode (`${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/capture-mode.md`).

### Phase 4.5: Backlog Re-evaluation

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/backlog-reeval.md`

**Only cross-feature dependency edges go on the question list;** re-estimations are decide-and-inform (rendered + ASSUMED-logged), never a question. (Other-feature mutations still follow the protocol's evidence rule; each is a question on the list.)

Skip if BACKLOG.md is empty or doesn't exist.

### Phase 4.9: Quality Gate (self-review loop)

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-quality-and-critique.md`

Before presenting to the user, re-read each story file and run the 15-check quality gate (Given/When/Then formatting, happy + edge cases, no ambiguous words, no TBDs, RICE populated, dependencies identified, prescriptive research, NFRs, EARS syntax, all states covered, etc. — full table in the reference). Iterate fixes up to 3 passes. **This is a no-input self-review loop — run it quietly: do NOT narrate each pass or print the table. Surface at most a one-line result** (`→ Quality gate: passed` or `→ Quality gate: 2 items unresolved`); flag any remaining gaps as "Unresolved — needs follow-up in /ship-discuss [ID]" (they ride into the Phase 5 summary), then proceed to Phase 4.95.

### Phase 4.95: Adversarial Critique

**Read the full protocol:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/phase-quality-and-critique.md`

After the quality gate passes, spawn a `general-purpose` critic subagent (inline prompt in the reference — kept inline per S-1 granularity) to challenge the spec from angles self-review misses: implicit assumptions, feasibility risks, ambiguities, missing error states. Determine stakes level: `high` if feature is part of an epic, story_points ≥ 8, touches auth/payments/data, or has 6+ acceptance scenarios; `standard` otherwise.

**Dispatch the critic CONCURRENTLY with composing the Phase 5 summary.** The critic and the Phase 5 summary composition are independent — launch the critic (background where available), then compose the FEATURES DEFINED / one-line-per-criterion summary while it runs. **Reconcile the critic's findings BEFORE asking the user anything** (the approval card must reflect the reconciled spec, not a pre-critic one; the list does not show it while the critic is marked running): when the critic returns, apply its mechanical fixes silently, then hold its judgment-call items for the merged batch below.

**If the summary is composed before the critic returns, wait for it silently — waiting is never a user decision and never an AskUserQuestion.** Mark it `shipyard-data discuss-questions research --state running --by critic-<slug>` when you dispatch it and wait with `discuss-questions wait` in the background; the approval is not shown while it runs. On critic timeout or failure, state it in one line ("Critic didn't return — proceeding with self-review only, noted in the Decision Log"), record `research --state abandoned --note "critic did not return"`, and continue; do not ask whether to proceed.

**Process the critic's findings in ONE merged batch.** Fix what's fixable without user input. Then put the critic's judgment-call items AND the silent-assumption-surfacing items on the question list, one question each, with the finding, the critic's evidence and your recommendation in the summary and the show block. The critic's return is a subagent payload the person has never seen; the loop writes each one in the chat before its card. When its items are in, record `research --state done --by critic-<slug>`.

### Phase 4.97: Scope-Drift Check ("did we drop something?")

**Follow** `${CLAUDE_PLUGIN_ROOT}/skills/ship-discuss/references/viability-and-scope-drift.md` § "Phase 4.97: Scope-Drift Check" (already loaded at Phase 2 — do NOT Read it a second time; if Phase 2 was skipped, Read it now). Delivery is folded into the Phase 5 summary and its approval card.
