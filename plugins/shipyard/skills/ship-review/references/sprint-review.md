# Sprint review (4.6): show the owner what the sprint did

`/ship-execute` does the quality work — spec review, gap analysis, code review and their fixes, per story while the work is fresh. `/ship-review` is therefore the sprint review: the owner and stakeholders see evidence, numbers, the decisions that were made for them, what was not done and why, what went badly, and what to change. It scans nothing and fixes nothing.

## When this path applies

At `preflight`, run `shipyard-data story-review check --json`. Take this path when `execution.code_review` is on (the default) **and** every sprint story is settled with a code-review result on record. Advance `shipyard-data cursor advance review review_pack --note "Sprint review: build the review pack"`.

Otherwise — a sprint executed before 4.6, `execution.code_review: false`, `--hotfix`, or a single-story review by id — say in one line why and take the scan-and-fix path in SKILL.md (Stage 0a onward). A story that is unsettled here is not reviewed here: it goes back to `/ship-execute`, which owns that work.

## Stage: build the pack (stage_id: review_pack)

Work quietly; nothing in this stage is a question.

1. **Facts.** `shipyard-data review-pack --base <sprint base sha> --head <HEAD> --json` (and once without `--json` for the tables). Every number in the review comes from this output — never from memory of the sprint.
2. **Fresh proof.** The facts name it: "Full suite proof: fresh … reuse it" means the suite is NOT run again. `shipyard-data verify list` shows every recorded proof (the full suite is key `sprint_full_tests`, probes are `demo_probe.<id>`) with the exact `verify check` line that reuses it. Re-run only a proof listed STALE, and record it under the same key, never a new one.
   **Quality gates.** The pack lists every gate the planner wrote in `QUALITY-GATE.md`. A gate checked by a command is satisfied by a fresh proof of that same command (`verify list`), by the story's recorded user-flow check, or by running it now and recording it (`shipyard-data verify record --key quality_gate.<n> …`). A gate checked by a person goes to the end-of-sprint sitting. Write each gate's result where the pack asks for it; a gate is never left unmentioned.
3. **Before and after.** For each story, show what changed for a user, with evidence the owner can open:
   - a UI story with a design: the side-by-side image `review-pack` lists under "Design beside delivered", and the recorded comparison (matches / differs / not compared);
   - a UI story: the frame captured before the sprint (`<SHIPYARD_DATA>/ui/<story>/before/`) beside one captured now (`shipyard-data ui screenshot --url <scene> --story <id> --label after`), and the approved design; run `shipyard-data ui verify --level screen --story <id>` and report the difference from the design as a number;
   - a behavior story: a small input → output table from the acceptance probe or a scenario run at the sprint base and at HEAD;
   - a fix: the failing case before, the passing case now.
   Give paths (or publish a private page when the owner asks for one); a terminal cannot show an image.
4. **Verdict files.** For each story write `<SHIPYARD_DATA>/verify/<id>-verdict.md` from the facts (`recommendation: approve` only when its story review is settled, its user flow passed or awaits the owner's look, and no parked step belongs to it).
5. **Write the review as one document.** `shipyard-data review-pack --write --base <sprint base sha> --head <HEAD>` creates `<SHIPYARD_DATA>/sprints/current/REVIEW-PACK.md` with all twelve sections: every fact the CLI knows is already in it, and each part only you can write is a `<!-- FILL: ... -->` marker. Replace every marker (Edit the file), then `shipyard-data review-pack check`. Leaving this stage is refused while a section is missing or a marker remains. Then `shipyard-data agents check` and advance: `shipyard-data cursor advance review demo_user --note "Present the sprint review"`.

## The pack (show the file itself at `demo_user`: whole, in order, unshortened)

Read `REVIEW-PACK.md` and output it as the review. Do not rewrite it into a shorter status report: the first real review did, and the owner never saw what went badly, the proposed actions or what comes next. You may add one or two sentences above it; nothing is left out below.

| # | Section | Content |
|---|---|---|
| 1 | Sprint goal and outcome | The goal, met / partly / not met in one line; planned vs delivered stories, points and steps (facts table) |
| 2 | What you can do now | Per delivered story, one line a user would recognise, plus how to see it yourself (command, scenario, device steps) |
| 3 | Evidence | Per story: scenarios met with their proof (test or probe names, capture paths), before/after, design conformance, the user-flow verdict |
| 4 | Quality work during the sprint | Findings by source (wave verify, spec review, gap analysis, code review, test suite) and where each went: fixed in the sprint, backlog (low severity only), accepted — with counts |
| 5 | Decisions made without asking | The `execute_decision` table: what, why, on what basis (plan, rule, consult, advisor), and which ones are easy to reverse |
| 6 | Numbers | Active time and span, builder dispatches, retries (warm vs cold), consults, suite runs and reuses, wave durations, code and test delta, velocity trend; add test-suite duration and test count before/after when the project reports them |
| 7 | Not done | Stories and steps not finished, each with the reason and where it goes next |
| 8 | Found but not done | Ideas captured, low-severity bugs sent to the backlog, risks noticed — each with why it was left |
| 9 | Not verified, risks and debt | What was not checked on real hardware or by a person, assumptions still open, known limitations shipped, anything the next sprint inherits |
| 10 | What went well / what did not | Data-derived, two short lists; name tooling (Shipyard) problems separately from project problems |
| 11 | What to improve — proposed action items | Each with an owner (the project, the plugin, the owner), where it lands (idea, config change, rule, plugin issue) and the evidence behind it |
| 12 | Next | The recommended next sprint goal with the top backlog items, release readiness (changelog draft, version), and the decisions only the owner can make |

Keep it short and visual: tables and one diagram of the sprint (waves, patches, overlaps) beat paragraphs. Above the document, open with a 15-second summary (40 words or fewer: was the goal met, what the owner can do now, what needs them). Plain words throughout: the owner may not be an engineer, so say what a person would notice, and explain any technical word the first time.

## The one ask (stage_id: demo_user)

`shipyard-data cursor pause review --note "awaiting user: sprint review"`, then **one inspection question** on its own card. A sprint review is where the people the product is for look at what was built and the plan adapts to what they see; it is not a sign-off on the team. Ask what they saw: **It does what we wanted: close the sprint (Recommended when the goal is met)** / Something should change (say what: it becomes a fix now or a backlog item) / It is not done (say what is missing). After their answer, **adapt the backlog**: run `shipyard-data backlog board`, show its RELEASES and BACKLOG parts, and ask one more card: does what you saw change what comes next? **No, keep the order** / Yes (say what moves or what is new). A move is `shipyard-data backlog move <id> --top|--above <id> --why "<what a delay costs>"`; something new is `shipyard-data idea capture …`; a release that slips is `shipyard-data version set <next> <id> --reason "..."`. When they name other people who should see the result (users, operators, the client), list them in section 12 as "to show"; a review seen by nobody outside the team says so in section 9. Then the checks that waited for a person, as **one sitting**: run `shipyard-data sprint needs-you` and write its list in the chat, grouped by where each is done (one device session covers its whole group), with the exact steps for each. After it, one card at a time and each written in chat first (a 40-word summary of that one check, a small table or example of what to look at, then the line `Question follows.` ending the turn, then the card; a card with nothing written above it is refused), ask one question per `needs_person: after` step ("[step] — done? yes / it failed / not yet"; yes → `shipyard-data sprint person-check <PID> --answer "<their words>"`, failed → the same with `--failed`, plus a fix step or story, not yet → record nothing: it stays on the `needs-you` list and section 9 lists it. A step that was only waiting for the person and had no code of its own (`blocked --reason waiting_for_person`) is also set done on yes: `shipyard-data step set-status <PID> done`), one per pending human probe ("[story] — did you see this on the device? yes / no / not yet") and per decision in section 12 that only the owner can make. **Accepting the sprint is not looking at a screen:** record a human probe only from its own answer — `shipyard-data story record-proof <id> verdict=pass|fail confirmed-by=<who> commit=<sha> answer="<their words>"` — and when the answer is "not yet" or the question was not asked, record nothing: the probe stays pending, the story is still accepted on its tests and reviews, and section 9 lists it as not verified. On "close the sprint": mark the stories done, and advance `process_approved` → `retro_step_1`: the retro's data, lists and action items are sections 10 and 11 of the pack, written to RETRO-DATA.md without asking; create the action-item ideas (five at most), record metrics, then the release step (its own approval) and the archive. "Refine" on a decision or a finding creates the patch step or story it needs and ends at `terminal_changes`.
