# Question Design — how /ship-discuss asks (and when it doesn't)

The discovery frameworks (JTBD, ATAM, EARS, ISO 25010) structure the ANALYSIS. This file governs what actually reaches the user: few questions, in bulk, scenario-framed, and only when the recommendation is genuinely uncertain. Sourced from product-discovery practice (The Mom Test, Teresa Torres story-based interviewing, JTBD timeline interviews), form-design research (NN/g cognitive-load principles, GOV.UK one-thing-per-page), spec-driven AI tooling (GitHub Spec Kit's ≤5-question /clarify), and the two-way-door reversibility framework.

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
- **Question budget: ≤5 total asks across Phases 1–2** for a typical feature. Overflow items are promoted to HIGH assumptions, not asked.

**Assumption logging.** Every HIGH decision appends to the feature file's `## Decision Log` as:

```
ASSUMED: <decision> — <evidence one-liner> — reversible: yes
```

(distinct from `DECIDED:` entries, which record explicit user answers). The Phase 5 approval summary includes an **ASSUMPTIONS MADE** section listing all of them with "flag any to change before approval" — one cheap audit point instead of N interruptions. Each HIGH decision still prints its one inform-line at the moment it's made, so the veto is live, not buried.

## The rulebook (every user-facing question passes all ten)

**Q1. Scenarios, not frameworks.** Framework vocabulary (JTBD, ATAM, EARS, ISO 25010, "quality attributes", "NFRs", "functional/emotional/social dimensions") never appears in a question. Translate every probe into a concrete situation with named actors, times, and consequences.
> Before: "What functional/emotional/social dimensions of the job?"
> After: "When a payment fails at 2am, what does the on-call person actually need — a page right away, or a summary when they sit down in the morning?"

**Q2. Past behavior, not hypothetical futures.** "The last time this came up, what did you do?" produces facts; "would you use X?" produces confabulation.
> Before: "What triggers usage? What's the full before/during/after flow?"
> After: "Walk me through the last time this came up — what were you doing right before, and what did you do instead, since the feature doesn't exist yet?"

**Q3. One decision per question item.** Never fuse "who uses it AND what happens on error". Batches of related items in one AskUserQuestion call are good (that's the bulk rule); fused items are not — each must be independently answerable.

**Q4. Options are outcomes, not mechanisms.** Label options by what the user experiences; tradeoff in parentheses; implementation nouns only if the user introduced them. "Survives restarts (adds Redis)" / "Simpler, resets on deploy (in-memory)". Mechanism detail goes in Layer 3.

**Q5. Answerable in one breath.** If a correct answer needs more than ~10 seconds of thought or a paragraph, the question is doing the model's job — split it, or convert it to a HIGH assumption with a veto line. Question text <100 words; option labels ≤12 words.

**Q6. Every open question carries an example answer.**
> Before: "Any constraints, compliance, or technical requirements?"
> After: "Anything that limits how we build this — e.g. 'must stay on Postgres', 'EU data can't leave EU', 'no new services'? If nothing comes to mind, there probably isn't one."

**Q7. Explicit cheap exit on every open question** — "nothing", "don't know", or "you decide" must be a legitimate answer. "You decide" answers get logged as ASSUMED.

**Q8. Never ask what the record already answers.** Before composing any question, check: the codebase/config, the spec + Decision Logs + constitution, git history, and the user's own words this session. If found, STATE it ("You're on Postgres with row-level tenancy, so I'll scope this per-tenant") — never confirm it as a question.

**Q9. Edge cases are mini-stories with a recommended ruling.**
> Before: "Concurrency: optimistic vs pessimistic locking?"
> After: "Two people edit the same draft at once — last save silently wins today. I recommend showing 'someone else edited this' with a merge offer. OK, or is silent-last-write fine for v1?"

**Q10. Formal syntax is output format, never input format.** Write acceptance criteria in EARS/Given-When-Then internally; when asking the user to confirm one, read it back as a plain scenario sentence: "So: someone pastes a 10MB file → we reject with 'max 5MB' before uploading anything. Right?" (The Phase 5 verbatim-AC gate keeps the formal text in the spec; the question framing stays plain.)

## The kill-list (MUST NOT ask — check before every AskUserQuestion call)

1. **Derivable from code/config**: stack, framework, DB, existing auth, test framework, deployment shape, naming conventions → state what you found instead.
2. **Derivable from the spec data dir**: existing features, Decision Log entries, constitution rules, backlog priorities → Grep first.
3. **Restating what the user said this session** ("So you want retry logic?" after they asked for webhook retry) → reflect as a statement; ask only the genuinely open part.
4. **Universal-yes questions**: "should errors be user-friendly?", "should it be secure/tested/fast?"
5. **Framework-vocabulary questions**: anything containing JTBD / ATAM / EARS / ISO 25010 / NFR / "quality attribute" aimed at the user.
6. **Hypothetical-opinion questions**: "would you use…", "do you think users would want…" → replace with past-behavior/scenario asks (Q2).
7. **Two-way-door implementation minutiae with a conventional answer** → HIGH tier: decide, inform, log.
8. **Questions whose answer won't change the spec** — if every option produces the same acceptance criteria, don't ask.

## Bulk-ask discipline (perceived speed)

- **Think first, ask once.** Derive everything derivable, run the confidence gate over every open item, THEN compose one AskUserQuestion call with up to 4 questions (each with up to 4 options + Other). A second call in the same phase only when the first call's answers genuinely fork the design.
- **Target interruption budget for a full feature discussion: 4–5 rounds total** (bulk understanding → challenge+viability → post-spec decisions → consolidated approval). Round 4 is a SINGLE gate: the acceptance scenarios (verbatim), the scope-drift check, and the spec are approved together. Every ask-round beyond that needs a reason.
- **Never leave silence.** Long-running work (research deep-dive, critic) gets a one-line dispatch banner with an expected duration, runs concurrently with the user's thinking time wherever possible, and announces its return with a one-line summary. Between rounds, narrate transitions in one line ("→ Impact analysis: 2 ripples found").

## Render before asking (applies to every skill, not just discuss)

Before every `AskUserQuestion`, render the decision context as chat text — the concrete scenarios, examples, tradeoffs, and any verbatim content the user is being asked to approve. The tool call then carries only the short question and the option labels. The AskUserQuestion window is small: labels and descriptions cannot hold a scenario, a diagram, or a block of acceptance criteria. A bare ask with no rendered context above it is a bug (the 2026-07-21 ship-backlog blind-ask class: a delegated gather produced an AskUserQuestion with nothing rendered).

For hard questions — the LOW-tier / one-way-door decisions, and anything a non-expert user can't answer from a label alone — the rendered context MUST include concrete scenarios and examples (the same scenario-framing the rulebook requires), not just a restated question. This is what makes the consolidated Phase 5 approval safe: the acceptance scenarios are quoted verbatim on screen, so "Approve" means approve-having-read.
