# Question Design — how /ship-discuss asks (and when it doesn't)

The discovery frameworks (JTBD, ATAM, EARS, ISO 25010) structure the ANALYSIS. This file governs what actually reaches the user: few questions, in bulk, scenario-framed, and only when the recommendation is genuinely uncertain.

## The confidence gate (run BEFORE composing any question)

Score every pending decision on two axes:

1. **Evidence convergence** — do the codebase conventions, the spec/constitution, and industry practice (research dossier) point the same way?
2. **Reversibility** — two-way door (internal structure, naming, most library picks — cheap to change later) vs one-way door (schema shapes, external contracts, auth model, migrations, anything user-visible).

| Tier | Condition | Action |
|---|---|---|
| **HIGH** | Evidence converges AND two-way door | **Decide and inform.** One line: "Going with X — [≤10-word why]. (say 'change' to override)". No AskUserQuestion. Log as ASSUMED (below). |
| **MEDIUM** | Evidence mostly converges, OR converges but one-way door | Ask, with the recommended option FIRST and labeled "(Recommended)", tradeoff named, reversibility flagged. |
| **LOW** | Evidence conflicts, user-value judgment call, or one-way door with no clear winner | Ask open, scenario-framed (rules Q1/Q2/Q9), showing what was found on each side. |

Hard rules:
- **One-way doors are never HIGH** — at minimum a MEDIUM ask.
- **User-value questions are never HIGH** (whether it's worth building, who it's for) — the Phase 2 viability echo stays mandatory.
- **Question budget: the question list holds it** (`discuss-questions start --budget <n>`, 12 unless the lane says otherwise). Past the budget the smaller questions that are left are shown together as one table and one card ("use the recommended answers?"). Decide and log ASSUMED what the confidence gate lets you decide; that is how the count stays low.
- **Estimates, scores, and process mechanics never enter the gate — they are not decisions to be tiered (kill-list #9/#10).** The gate scores product decisions only.

**Assumption logging.** Every HIGH decision appends to the story file's `## Decision Log` as:

```
ASSUMED: <decision> — <evidence one-liner> — reversible: yes
```

(distinct from `DECIDED:` entries, which record explicit user answers). The Phase 5 approval summary includes an **ASSUMPTIONS MADE** section listing all of them with "flag any to change before approval" — one cheap audit point instead of N interruptions. Each HIGH decision still prints its one inform-line at the moment it's made, so the veto is live, not buried.

## The rulebook (every user-facing question passes all ten)

**Q1. Scenarios, not frameworks.** Framework vocabulary (JTBD, ATAM, EARS, ISO 25010, "quality attributes", "NFRs", "functional/emotional/social dimensions") never appears in a question. Translate every probe into a concrete situation with named actors, times, and consequences.
> After: "When a payment fails at 2am, what does the on-call person actually need — a page right away, or a summary when they sit down in the morning?"

**Q2. Past behavior, not hypothetical futures.** "The last time this came up, what did you do?" produces facts; "would you use X?" produces confabulation.
> After: "Walk me through the last time this came up — what were you doing right before, and what did you do instead, since the feature doesn't exist yet?"

**Q3. One decision per question item.** Never fuse "who uses it AND what happens on error". Each decision is its own card, asked after its own explanation in chat; fused items are never acceptable — each must be independently answerable.

**Q4. Options are outcomes, not mechanisms.** Label options by what the user experiences; tradeoff in parentheses; implementation nouns only if the user introduced them. Mechanism detail goes in Layer 3.

**Q5. Answerable in one breath.** If a correct answer needs more than ~10 seconds of thought or a paragraph, the question is doing the model's job — split it, or convert it to a HIGH assumption with a veto line. Question text <100 words; option labels ≤12 words.

**Q6. Every open question carries an example answer.**
> After: "Anything that limits how we build this — e.g. 'must stay on Postgres', 'EU data can't leave EU', 'no new services'? If nothing comes to mind, there probably isn't one."

**Q7. Explicit cheap exit on every open question** — "nothing", "don't know", or "you decide" must be a legitimate answer. "You decide" answers get logged as ASSUMED.

**Q8. Never ask what the record already answers.** Before composing any question, check: the codebase/config, the spec + Decision Logs + constitution, git history, and the user's own words this session. If found, STATE it ("You're on Postgres with row-level tenancy, so I'll scope this per-tenant") — never confirm it as a question.

**Q9. Edge cases are mini-stories with a recommended ruling.**
> After: "Two people edit the same draft at once — last save silently wins today. I recommend showing 'someone else edited this' with a merge offer. OK, or is silent-last-write fine for v1?"

**Q10. Formal syntax is output format, never input format.** Write acceptance criteria in EARS/Given-When-Then internally; when asking the user to confirm one, read it back as a plain scenario sentence: "So: someone pastes a 10MB file → we reject with 'max 5MB' before uploading anything. Right?"

## The kill-list (MUST NOT ask — check before every AskUserQuestion call)

1. **Derivable from code/config**: stack, framework, DB, existing auth, test framework, deployment shape, naming conventions → state what you found instead.
2. **Derivable from the spec data dir**: existing features, Decision Log entries, constitution rules, backlog priorities → Grep first.
3. **Restating what the user said this session** ("So you want retry logic?" after they asked for webhook retry) → reflect as a statement; ask only the genuinely open part.
4. **Universal-yes questions** ("should it be secure/tested/fast?").
5. **Framework-vocabulary questions**: anything containing JTBD / ATAM / EARS / ISO 25010 / NFR / "quality attribute" aimed at the user.
6. **Hypothetical-opinion questions**: "would you use…", "do you think users would want…" → replace with past-behavior/scenario asks (Q2).
7. **Two-way-door implementation minutiae with a conventional answer** → HIGH tier: decide, inform, log.
8. **Questions whose answer won't change the spec** — if every option produces the same acceptance criteria, don't ask.
9. **Derivable-by-analysis judgments** — story points, RICE components, complexity, token estimates, confidence scores, counts, classifications: anything the analysis can compute from evidence in hand. Producing the number is the model's job. Compute it, show it with a one-line basis ("5 points — 4 scenarios, one new table, no migration"), log as ASSUMED; the user vetoes through the approval gate. Never a question, never an option list of point values.
10. **Process/orchestration mechanics** — never ask whether to wait for, skip, retry, or proceed without the skill's own background work (deep-dive, critic, any dispatched agent), or in what order to run phases. The skill owns its execution — narrate it with a one-line status; surface only genuine timeout/failure, as a statement of the fallback taken, never as a question.

## Bulk-ask discipline (perceived speed)

- **Think first, then add each question to the list.** Derive everything derivable and run the confidence gate over every open item BEFORE adding, so the person is asked only what is truly theirs. Questions are asked one card at a time, as soon as they exist: a question that unblocks background research goes first, a hard-to-undo choice next, then the oldest (`async-questions.md`).
- **No rounds.** Research never waits for the person and the person never waits for research: a question is shown as soon as it is raised, and the approval is a single card shown last, after every decision is in and no research is running.
- **Never leave silence.** Long-running work (research deep-dive, critic) gets a one-line dispatch banner with an expected duration, runs concurrently with the user's thinking time wherever possible, and announces its return with a one-line summary. A status line while waiting is chat text, never an AskUserQuestion — the ask tool is for decisions, not for pausing. Sequencing background work is the skill's decision, never a question (kill-list #10).

## Render before asking (applies to every skill, not just discuss)

**One question per card, written in the chat first.** For each question: the explanation and the question itself as chat text, then the tool call for that question alone. A hook refuses a card with more than one question inside any Shipyard command.

**The card holds the question and the choices, nothing else.** Explanations, examples, reasons and trade-offs are chat text above the card, where there is room to read them. Limits, enforced by a hook inside any Shipyard command: the question 160 characters, a choice's label 40, its description 110. A card that needs more is a sign the explanation has not been written yet.

**Shape of what you render:** a 15-second summary first (40 words or fewer: what is going on, what it means for them, what you recommend), then show it with a picture, a table or a real example, in plain words a non-expert follows (`communication-design.md`, the 3-layer pattern).

Render before asking: render the decision context as chat text before every AskUserQuestion (rules printed at startup under SHIPYARD_STARTUP_RULES). The provenance and recovery rules live there, not here.

## Render an example scenario, not just a restated question

For any question the user has to reason about, the context rendered above the ask includes at least one concrete example scenario — a named actor, a specific moment, and the consequence — showing what the question actually decides, in the same scenario form rules Q1/Q6/Q9 demand of the question text. The scenario is chat text; the tool card holds only the short question and options.

**Escalate the example with the stakes.** For LOW-tier / one-way-door decisions, and anything a non-expert can't answer from a label alone, the example scenario is MANDATORY and shows BOTH sides — what happens under each option, not just the situation. This is what keeps the consolidated Phase 5 approval safe: the acceptance scenarios are quoted verbatim on screen, so "Approve" means approve-having-read.

**Skip the example only when the ask is genuinely self-evident:** a binary confirmation of content already rendered in full immediately above (e.g. "Approve everything?" after the verbatim summary), or a pick-from-a-list where every option is itself a concrete outcome. When unsure, render it.
