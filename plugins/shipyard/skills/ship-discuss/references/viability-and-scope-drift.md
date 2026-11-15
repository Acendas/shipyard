# Viability Gate and Scope-Drift Check (shared by NEW and REFINE)

Shared reference: loaded once per discussion by NEW mode (Phase 2, reused at Phase 4.97) and by REFINE mode (Step 4 viability re-run and the Phase 5 hand-off). Not loaded by CAPTURE, IDEA-CAPTURE, TRIAGE, or IDEA-listing modes.

## Phase 2: Viability Gate

The design deep-dive already produced a **viability pre-assessment** (per-gate evidence + a pass/concern verdict) in `<SHIPYARD_DATA>/spec/.research-draft.md` under `## Viability Pre-Assessment`. Read that section and use it as the input to this gate. **The pre-assessment is analysis, not a decision — the viability decision authority stays with the shell and the user.** If the dossier lacks the section (inline-fallback path), evaluate the 5 gates directly here.

Evaluate each feature against the 5 gates AND echo the verdicts to the user. The historical "silently evaluate" pattern hid model misjudgments — USER VALUE, SCOPED, and TESTABLE are judgment calls the user has standing on, and silent-pass leaves no feedback channel when the model reads the feature wrong.

**The gates:**

1. **USER VALUE** — Can we articulate who wants this and why? → KILL if no clear user story
2. **DEFINABLE** — Can we write testable acceptance criteria (Given/When/Then)? → KILL if too vague
3. **BUILDABLE** — Can we decompose into executable tasks? → KILL if impossible constraints
4. **TESTABLE** — Can we verify with automated tests + demo? → KILL if purely subjective
5. **SCOPED** — Is it one feature, not three in a trench coat? → SPLIT if multiple stories

**Verdict echo (MANDATORY — even on PASS).** After running the gates, render the verdict block as assistant chat text before the echo card is asked. The dossier's `## Viability Pre-Assessment` is a Read result — invisible to the user until re-emitted; the echo question's text cannot carry the five verdicts. Alongside the verdict block, render the **primary use scenario** as chat text — "When [actor] [does X] at [moment], they get [outcome]" — so "does this match your intent?" is answered against a concrete flow, not the abstract gate labels (see `references/question-design.md` § "Render an example scenario").

```
  Viability read:
    USER VALUE  ✓  [one-line summary of who + why, as the model read it]
    DEFINABLE   ✓  [acceptance theme — what the criteria will test]
    BUILDABLE   ✓  [task-decomposition shape — small/medium/large]
    TESTABLE    ✓  [verification approach — auto-test + demo path]
    SCOPED      ✓  [N feature(s) — if N>1, list the split]
```

**Delivery: this echo is an approval on the question list** (`discuss-questions add --kind gate`, Phase 1.5b), shown after the challenge decisions. Present the verdict block above alongside the challenge summary, and ask (as that call's final question): "I'm reading this as one feature, scoped to [scope], with these acceptance themes: [themes]. Does this match your intent? (looks right / refine the read / split into multiple features)". Default-recommend "looks right" only when all five gates pass cleanly. If the user picks "refine the read" or "split into multiple features", go back to Phase 1 for re-clarification before writing to spec. Do NOT skip this echo step — it stays MANDATORY however few decisions the discussion needed — users have no other way to catch a model misjudgment about USER VALUE / TESTABLE / SCOPED. (When SPLIT fires or the user picks anything other than "looks right", the split/re-clarify sub-flow below runs as its own follow-up — the merge is about the default clean-pass path, not about suppressing a needed split conversation.)

When SPLIT fires (or BUILDABLE/SCOPED fails on size grounds), follow the **`splitting-stories` playbook** with `level: feature`, the draft text, the AC list, and `domain_hints` inferred from the discussion. The skill returns split candidates with cited patterns and `acceptance_hint`s. Render each split candidate as chat text first — child title, one-line scope, and its `acceptance_hint` — then ask. The candidates are a capability-skill return the user hasn't seen, and option labels cannot hold them. "This looks like [N] stories, not one — split it? (split as suggested / pick which children to keep / capture as-is and refine later)". Reject any candidate that fails the skill's horizontal-slice check before presenting (the skill flags these in `horizontal_rejections` — re-prompt the skill if it returned any).

If viability kills the feature, run `shipyard-data draft obsolete-research --topic "<current topic>"` to set `<SHIPYARD_DATA>/spec/.research-draft.md`'s `obsolete: true` frontmatter sentinel (soft-delete sentinel — recovery logic filters it out; it stays as a soft-deleted record).

If a feature fails a gate, AskUserQuestion — don't block. Frame positively: "This feature needs X to be buildable" not "This feature fails because X is missing."
Example: "I can't write testable acceptance criteria for this yet — the scope is too broad. Can we narrow it to something specific? (narrow it / capture as-is and refine later)"

The user can override: "Just capture it as proposed, we'll refine later."

## Phase 4.97: Scope-Drift Check

**Delivery: this check is folded INTO the Phase 5 summary presentation, not run as a separate interruption before it.** The two-column diff below is shown as part of the Phase 5 summary, and its "did anything get dropped?" question is one of the approval card's choices (it does not cost its own card). The check itself still runs, once, in full — only its question is folded into the approval card.

The discussion entered Phase 1 with one shape (the user's initial topic, idea, or feature request) and may have evolved through challenge, viability, impact, and critique — sometimes losing scope on the way. Up to this point in the skill, there is no checkpoint that asks the user whether the spec they're about to approve still covers everything they originally wanted. Phase 4 captures NEW tangents that come up; this phase asks about OLD intent that may have been dropped.

Run this check exactly once per discussion, regardless of mode (NEW, IDEA-graduated-to-NEW, REFINE). Skip only on CAPTURE mode (which doesn't write acceptance criteria at all).

Compose a two-column diff in plain text:

```
  Started with:                          Landed at:
    "[paraphrase of user's initial         S012 — [title]
     topic from Phase 1 / the                  • [scenario 1 one-liner]
     IDEA file / the REFINE prompt]"          • [scenario 2 one-liner]
                                              • [scenario 3 one-liner]
                                              (RICE [score], [complexity])
                                          IDEA-007 — [title of tangent captured during Phase 4]
                                          IDEA-009 — [title of tangent captured during Phase 4]
```

The two-column diff is carried into the Phase 5 summary as the SCOPE-DRIFT DIFF section, and the question "Did anything important from the original idea NOT make it into the spec? (nothing dropped — proceed to approval / something is missing — let me add it / a piece I wanted got captured as an IDEA instead — promote it)" is asked there, as a choice on the approval card (see Phase 5's "Scope-drift question" paragraph for the full delivery, defaults, and the missing/promote branches). Default-recommend "nothing dropped" only if the spec's acceptance themes cover every noun/verb in the user's initial topic (paraphrase from Phase 1's first AskUserQuestion).

This phase is the only scope-cut check in the skill: it asks the user "what did we cut?" so scope creep prevention is never left to silent model judgment.
