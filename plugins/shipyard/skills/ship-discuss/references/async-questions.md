# Asynchronous questions (4.20)

Research runs in the background. When it reaches something only the person can decide, it puts a question on a list and keeps working. You show the person one question at a time and record each answer; the researcher reads the answers when it reaches a checkpoint. Nobody waits for anybody.

```
researcher (background)               question list (CLI-owned)             you (the main session)
  finds a real unknown ──── add ─────▶ Q3 open ───────────────── next ────▶ write it in chat, one card
  carries on with other branches                                               │
  checkpoint: answers ◀──────────────── Q3 answered ◀────────── answer ───────┘
  only parked branches left: PARKED ─────────────────────────────────────────▶ ask what is left, resume it
```

Why a list and not messages: a message that arrives while a card is open waits for that turn to end, and a message to a busy agent is read only when it finishes. The list is the transport both ways. A message is only a wake-up.

## Your loop

1. **Start the list** as soon as the lane is confirmed and you have a topic slug: `shipyard-data discuss-questions start --topic <slug> --budget <refine_rounds × 4>`. From here on, **every card in this discussion comes from the list**: the card hook refuses any other question.
2. **Dispatch the researcher** in the background (Phase 0.6) with the protocol below.
3. **Add your own unknowns** the same way it does (`add … --by main`), after the kill-list and the confidence gate. Do not hold them for a "round", and never tell the person the work comes in "rounds": say research has started and questions come one at a time. Write each question's show file under `<SHIPYARD_DATA>/spec/.questions/<slug>/` (`start` prints the folder; `reset` removes it).
4. **Ask, record, repeat:**

   | `discuss-questions next` prints | You do |
   |---|---|
   | A question | Write its SUMMARY and SHOW in the chat, then one `AskUserQuestion` with the QUESTION word for word and the CHOICES in order. Then `answer <Q#> --choice <n>` |
   | "Answered since this was raised" above it | Check the question still stands. Settled by one of those answers: `drop <Q#> --reason "…"` and run `next` again |
   | "SHOWN BEFORE, not answered" | The answer is in this conversation: record it. Otherwise say in one line that you are asking again, and ask |
   | A table of smaller questions | Write the table in the chat (question, recommended answer, what it means), ask the one card, then `answer-bundle --accept` or `--one-by-one` |
   | A draft that cannot be shown | Reword it with `revise <Q#> …`, then `next` |
   | Nothing, research running | `shipyard-data discuss-questions wait` as a **background command**, one quiet line (`→ Research is still running · 3 answered`), end your turn |
   | Nothing, research parked | `SendMessage` the researcher: "answers are in, carry on". Then `wait` as above |
   | Nothing, research done | Go on to the next phase |

   What the person did → what you record: picked an option → `--choice <n>`; typed their own answer → `--text "<their words>"`; "you decide" or "whatever you recommend" → `--you-decide` (the recommended option, logged as ASSUMED); closed the card → ask once more in one line; closed again → `--text "not answered"` and treat the branch as parked.
5. **When `wait` returns**, or a message from the researcher arrives, or it returns: run `next`. On `wake: timeout`, check the researcher is still in the agent list. Gone: `research --state abandoned --note "<why>"` and run the research inline (`phase-1-research.md`).
6. **Later phases use the same list.** Challenge themes, post-spec decisions and critic items are questions (`--by main`, or the critic adds its own). The viability echo, a design sign-off and the spec approval are approvals: `add --kind gate …`. The list shows an approval only when no decision is open and no research is running, so it is always asked last.
7. **Bind the story** when its id exists (Phase 3): `shipyard-data discuss-questions bind --story <S###>`. `story set-status <S###> approved` is then refused while a question waits, research is unfinished, or the researcher has not read an answer.
8. **End.** Approved and finalized: `shipyard-data discuss-questions reset`. Stopped, rejected or paused: `shipyard-data discuss-questions pause`; the questions stay and the next `/ship-discuss` on this topic picks them up (`SHIPYARD_DISCUSS_QUESTIONS_WAITING` in the context, then `start --topic <slug>` and `next`). A parked researcher is kept while the discussion is open and stopped (`TaskStop`) when it ends or pauses.

Before the approval card, show what was decided without asking: `shipyard-data discuss-questions status` lists every ASSUMED line and every dropped question with its reason. The person can ask for any of them back.

## The researcher's protocol (put this block in its prompt, with the topic and its name filled in)

```
You work in the background while the person is being asked questions. Never ask them yourself.
The question list is how you reach them. Topic: <slug>. Your name: <name>.

First command:  shipyard-data discuss-questions research --state running --by <name> --topic <slug>

When you reach something only the person can decide:
  1. Look for the answer first: the code and config, the spec and its decision logs, the project's rules.
  2. You are sure, and it is easy to change later → decide it and record it:
       shipyard-data discuss-questions assume --topic <slug> --by <name> --statement "<what you decided>" --basis "<the evidence>"
  3. Otherwise add a question, then carry on with every branch that does not depend on it:
       shipyard-data discuss-questions add --topic <slug> --by <name> \
         --summary "<40 words or fewer, plain words: what this is about and what you recommend>" \
         --show-file <SHIPYARD_DATA>/spec/.questions/<slug>/<short-name>.md \
                     (a file you write there with one picture, table or real example; the folder is removed when the discussion ends) \
         --question "<one sentence, 160 characters or fewer>" \
         --option "<recommended choice, 26 characters or fewer>::<what choosing it means>" \
         --option "<another choice, 40 or fewer>::<what it means>" \
         --checked "<where you looked>" --confidence medium|low \
         --parks "<the part of your work that waits for this, if any>"
     Write for someone who is not an engineer. Add --weight high when the choice is hard to undo.
     Then send main one message, "QUESTION <Q#>", as a wake-up. Do not wait for a reply.
     If the command says DRAFT, fix what it lists with `revise <Q#> …`.

After each numbered step of your work (a checkpoint):
       shipyard-data discuss-questions answers --topic <slug> --after <the cursor you last saw, 0 at first> --ack --by <name>
  Fold every answer in. If an answer changes work you already did, redo that part and list it in the
  dossier under "## Changed after answers".

Write the dossier section by section as you finish each one, not all at the end.

When the only work left waits on open questions:
       shipyard-data discuss-questions research --state parked --by <name> --topic <slug> --note "waiting on <Q#, Q#>"
  and return the single line  PARKED: <Q#, Q#>.  Main will message you when they are answered. Then read the
  answers, finish, and close with:
       shipyard-data discuss-questions research --state done --by <name> --topic <slug>
  (it refuses until you have read every answer to your own questions).

If shipyard-data is refused, put each question in your return text as a line starting "QUESTION:" with
its choices; main will add it for you.
```

## Numbers

`shipyard-data discuss-questions status --json` gives, per question, seconds from raised to shown and from shown to answered, the cards shown, and what was assumed. `reset` logs the totals (`discuss_questions_closed`).
