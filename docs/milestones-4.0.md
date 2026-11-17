# Shipyard 4.0.0: development milestones

4.0.0 was built through milestones numbered 3.27 and 4.0 to 4.21. They were never published on their own. Where a skill, a message or a note says "(4.17)" or "v4.20", it names the milestone that introduced the behaviour. Newest first.

For what changes when you upgrade from 3.26.0, read [UPGRADING.md](../UPGRADING.md).

## A person at the start or at the end, never in the middle

- A step that a person must do says so: `needs_person: before` (its result changes what gets built) or `after` (it only confirms what was built), with `person_task:` and optionally `person_minutes:` and `person_where:`.
- The plan check keeps `before` steps in the first wave and refuses a step that waits for an `after` step. The plan summary carries a line such as `you: 2 things at the start (about 10 min): … · 3 checks at the end`, and the planner asks once whether you can do the start items when the sprint starts. If not, the stories that depend on them leave the sprint instead of parking halfway.
- `shipyard-data sprint needs-you` prints the phrase the build puts on its progress line: `you: needed now · …` or `you: not needed until the review (3 checks)`.
- A step waiting for you at the review no longer counts as a parked step. The review lists the waiting checks grouped by where they are done, so one sitting covers them.

## 4.0.3 (released 2026-11-16)

Found on the day 4.0.2 was installed, by reading the sessions of two real projects. In the first: tickets taken in, refined, split into more tickets, sent to the tracker, then planned into a sprint. In the second: a long sprint that paused once to ask its owner two questions.

- **A reworded outbox table no longer holds the send.** The session rewrote the outbox table its own way and left out the path column the hook looked for. The person chose "send all now" and five sends came back in red; they answered four cards for one decision. `tracker outbox` now logs each listed file with a hash of its text; the hook passes a text once it was listed, its record was named in a message after that, and the person answered. A file edited after the listing is shown again. The table calls a new bug a Bug.
- **A scratch folder is not the project.** A discussion may not edit the project, and "the project" was everything outside the data folder: three drafts written to the session's own scratch folder were refused, and went into the data folder instead. The rule now covers the project's folder and the repository it sits in.
- **An old session is stopped at the door.** A session keeps the plugin it started with. One opened under the previous version was resumed after the new version had worked on the project: it announced the old version as an upgrade, stamped the data folder back, and its health check asked for fields that are no longer required, which the session wrote by hand. When the data was last used by a newer version and a newer copy is installed beside the running one, every command now says so and stops (`SHIPYARD_ONBOARDING_REASON=older_session`); nothing is stamped. `SHIPYARD_ALLOW_OLDER_SESSION=1` is the way past it. This protects from this version on: an older plugin cannot be taught it.
- **Confidence is a percentage.** The spec text asks for `rice_confidence` from 0 to 100 and the score multiplied it as it stood: 840 beside a sibling's 8.4. A value above 1 is read as a percentage.
- **Approval inside a discussion checks the sources for every story.** Two stories were approved on one card; the one bound to a question list was refused for its sources and the other went through. A story with no list of its own, approved by the session that holds the discussion, now owes the same record. Another session approving beside it, and the quick lanes, owe nothing.
- **A discussion can be paused.** An approval card went unanswered for ten minutes. The session could not ask the ticket question either, so the release was refused and the lock stayed with a session that had ended its turn. `lock release discuss --pause` releases it while a question still waits or a queue has items left; what it owes (its sources, the ticket question) passes to the next discussion.
- **Refining a story is one call.** `refined: false` blocked approval and nothing said how it becomes true: two sessions each wrote a script that rewrote the story file. `shipyard-data story refine <S###> --body <draft.md> [--points n] [--rice reach,impact,confidence %,effort] [--probe auto|assisted|manual --probe-command "…" --probe-steps <file>]` replaces the body (title, ticket text and decision log kept), marks it refined, sets the numbers, assigns the criteria ids and prints the approval checks.
- **A slice ships with what it was split from.** Five stories split out of a story in a release had no release; the sprint took "the release" without them and the owner asked where they went. `story add --version <name>`; with no epic, a new story takes the one release of the stories it waits for and says so. `story set <id> fix_version=<name>` now does it (it was refused three ways).
- **A release says what a sprint can take.** `version show <name>` ends with `For a sprint:` lines: ready (with points), in a sprint, not ready and why, closed and why (for example "merged into S002"). Sprint planning prints them and names what the sprint leaves out.
- **A merged ticket follows its story.** Two tickets were one fix and became one story; the second ticket got a comment and stayed open. The tracker plan now lists the ticket of a story closed with `--replaced-by` whenever the story it was merged into changes.
- **A resumed sprint is built under its lock again.** A sprint paused to ask its owner two questions and was resumed ten minutes later in the same session with `cursor resume`. A pause gives the execution lock back, and the resume did not take it again, so the last six hours ran with no lock: the agent list recorded no builder, no builder's model was checked at its start, a question in the middle of the build would not have been held, and a second `/ship-execute` could have started beside it. `cursor resume execute` now takes the lock (and refuses when another session is building the sprint).
- **A builder cannot leave a command running.** A builder started its test run in the background, had no tool to wait for it or stop it, and returned. Its work was merged, and for six hours the agent list showed it "waiting on 1 shell"; Shipyard's own list said nothing was running. A new hook (`builder-foreground`, on shell commands) refuses `run_in_background` inside the builder agent, which then runs the command in the foreground. Probed on CLI 2.1.326. It costs nothing on any other command.
- **Smaller things.** `wave_integration_failed` names its dangling tasks (they were logged as `[object Object]`). Several backlog items move together in the order given (`backlog move S2 S3 S4 --below S1 --why …`; one by one they ended up reversed). An edit may use a command-owned field line as its anchor when it does not change it. The health check no longer lists other projects' folders that hold only hook notes. The texts a held question hands the session no longer talk about its reasoning.

## 4.0.2 (released 2026-11-16)

Found in the owner's own discussion on 4.0.1, the same evening, and by checking that project's data afterwards.

- **A held question is one calm line, and it is not written twice.** The first question of two discussions was sent back: once the explanation was only in the session's reasoning, once it was written correctly but the card was called in the same message, where the card hook cannot see it yet. The owner saw a red block of six lines of instructions meant for the session, and in the second case the whole explanation a second time. Now the visible line is `Shipyard: one moment. This question comes back as soon as its explanation is on screen.`; the steps reach the session without being shown; and a held card may simply be asked again: when its explanation was text in the same message as the first call, it passes. The same for the `/ship-backlog` board.
- **Ticket texts are previewed as a table, not pasted.** Told to refine eleven epics and update their tickets, the session sent three descriptions nobody had seen (held, as it should be, but as three red blocks), then pasted every description into the chat: 2,800 words before one "go". A description, or more than one ticket, is now written to `tracker/outbox/<record id>.md`; `shipyard-data tracker outbox` prints the table (ticket, record, what is sent, where the whole text is); one card asks (send all now / show me one in full first / not now). The write hook lets a text through when it is one of those files, its row was shown and the person has answered since. A short comment is still shown word for word. Sent files move to `tracker/sent/`.

- **A record's ticket is explicit; a ticket it only mentions is never written to.** `external_refs` held both "this is ABC-12" and "relates to ABC-12", and the first key was taken for the record's ticket. On a real project 52 stories written under eleven epics each named their epic's ticket, and four named a ticket in another project: the sync plan offered to update each epic's ticket once per child story, with the story's text, and to rewrite the other project's tickets. Now the own ticket is the `ticket:` field (written by `tracker link` and `tracker pull`), else the ticket the record was imported from, else what `tracker link` logged on 4.0.1. A record that only mentions tickets is listed as having none, with what it mentions. Reading a tracker is unchanged (a pulled ticket still refreshes what mentions it), except that a child repeating its parent's ticket is left alone.
- **Breaking an epic down has verbs.** `shipyard-data story add --title … --epic E### [--ui] [--as … --want … --so …] [--after ids]` writes a coarse story (`refined: false`, no points, no criteria); `shipyard-data task add --title … --kind spike --parent E### --question … --timebox …` writes a spike. There was none, so a discussion wrote 55 story files by hand, each missing fields and carrying its epic's ticket. `/ship-discuss --chain` takes epics too.
- **"Not these, for now" lasts.** `shipyard-data tracker hold <id>... | --under <E###>` takes records off the plan's "no ticket yet" list until `--off`; the plan counts them in one line. New records under one parent are one line of the plan.
- **One release has one name.** `v4.2`, `4.2` and `v4.2.0` are the same release: `version add` refuses a twin, and a tracker import puts its tickets in the version the project already has. `version rename <a> <b> --merge` folds one version into another; `version remove <name>` deletes an empty one. A rename no longer marks every sent record as "changed since last sent".
- **The health check asks a story only for what is read.** It demanded the score fields (`rice_*`), `complexity`, `token_estimate` and `references` of every story: 400 findings on a project whose backlog is in the owner's order, burying the one that mattered.
- **A worktree that is not a builder's is left alone.** The worktree hook named every worktree created in the project `shipyard/wt-<name>`, so an unrelated workflow's worktree was reported as a builder's leftover on every run, and the end-of-sprint sweep would have removed a clean one. Only a worktree made while an execution lock is held gets that name; any other is `worktree-<name>`, reused as it is when asked for again.
- Smaller: `idea capture` accepts `--description` (and `--reason`); the backlog file of a new project no longer says "Ordered by RICE score".

## 4.0.1 (released 2026-11-15)

- **`/ship-backlog` shows the board.** The skill told the model to read every story, epic and idea file and compose the board by hand; most runs showed a one-line summary and a question, and no list. `shipyard-data backlog board` now prints the whole board (the sprint, the backlog in rank order by epic, what is not scored, proposed stories, open ideas, numbered across sections) in a fifth of a second, the skill prints that output as it is, and the card hook refuses a `/ship-backlog` question until the board is in the chat. Probed live: text written in the same message as a question reaches the transcript only after the hook has answered, and a hook's own message is not shown before the card, so the board is the session's whole message and the question comes in the next one (see the next item).
- **A discussion's own cards are never refused.** 4.0.0 refused the third card of a discussion that had not started the question list. The owner met it as an error while sorting his backlog; the triage flow never starts a list. The hook now records such a card (`discuss_card_asked`) and lets it through. A card is still refused when a list is current and the card is not the one it handed out.
- **A question comes after its explanation, in every command.** The owner's rule (a summary that reads in 15 seconds, then a picture, a table or a real example, written in the chat, then the card) was in every skill and still skipped: after its first message a session asked card after card with no text of its own, and the screen showed only the client's one-line summary of its thinking. The card hook now reads the chat and refuses a question in a Shipyard command when, since the person last answered, there is no short summary or no picture. How the text gets there took three tries, each run live on a real discussion. "Write it, run a small command, then ask" failed twice in a row: the explanation went into the session's reasoning, or text, command and card were sent as one message. A command that handed the text back "to be written as it is" failed the same way. What a session does every time is write its last message as text, so that is the route: the explanation ends with the line `Question follows.` and the turn ends; a new hook on the end of the turn (`ask-after-explain`) hands the turn straight back, and the card is the next message. Measured after the change: a triage discussion, the backlog (16 seconds to the first card) and two questions in a row each showed summary, table and card with no refused question.
- **A planner finishes the sprint it is still writing.** `sprint set` refused a planner at its last step, 97 steps in, because another session held the execution lock, although no sprint was running: the lock belonged to something else. The running sprint is read-only to everyone but its executor; a sprint that is still `planned`, has never started and has no execute cursor is its planner's, so the session holding the planning lock may fill it in. A started sprint and a third session are refused as before.
- **A question card a few characters too long is no longer refused.** The card hook refused a planning question whose first choice had a 123-character description (limit 110), and the owner saw a red error. The written lengths (question 160, label 40, description 110) stay what a session aims at and what the question list checks; the hook refuses only a card half as long again, and more than one question per card.
- **An epic follows its stories at once, in both directions.** Its status was only brought in line by `reconcile` (at archive and at the next plan), so an epic read "proposed" while its stories were being built; and a finished epic that got a new story still read "done" (five of them on a real project). A story's status change, and moving a story between epics, now roll the epic up immediately, and a done epic with a story still to build reopens.
- **Releases are fix versions, and the backlog follows Large-Scale Scrum (the owner's direction).** A discussion about "the v4.2.0 release" made an epic to stand for the release: Shipyard had no other place for it. Now:
  - `shipyard-data version add|list|show|set|clear|check|release`: a fix version is the release an item is expected to ship in. Epics, stories, tasks and ideas carry `fix_version` (a story or task with none takes its epic's). Moving an item between versions needs `--reason` and is logged. A version is released only when nothing in it is unfinished or never broken down, and its release checks (the work "done" does not cover, such as a look on the device or a configuration push) are confirmed with the person's words.
  - A batch of intents comes in as ideas that keep their link: `tracker pull` makes an idea of a ticket typed epic, initiative or theme (it used to make an "unrefined story" of it), reads a tracker's CSV export directly (`--csv`), and carries the tracker's fix version.
  - `shipyard-data idea promote <IDEA-NNN> --to epic|story|task`: one call writes the item, carries the links and the version, and marks the idea promoted. An epic gets a rough size (S to XL), not points.
  - The backlog board opens with the planned releases. The discuss skill reads `references/less-backlog.md` when the input is a release or a batch of tickets: one backlog, fine at the top and coarse below, nothing broken down at intake, the splitting order, ordering by what a delay costs.
- **The tracker link is for every kind of record, and a discussion ends by asking about it (the owner's direction, run live on a real project).** `tracker pull` maps each ticket type to its own record (epic, initiative, theme → an idea; task, spike → a task; bug and the rest → an unrefined story), reads a CSV export, refuses to guess when an export has no type column (`--as ideas|stories|tasks`), puts a child under the epic that carries its parent, and refreshes whichever record carries a ticket. An idea and an intent are one thing; refined, an idea becomes an epic (`idea promote`, which carries links, the sync block and the version, and moves work that came in under the same ticket beneath the epic). `tracker plan` lists what has no ticket and what changed here since it was last sent; `link`, `unlink`, `synced`, `decided` record the rest. The discussion says so when research finds work no ticket covers, offers to draft and create the tickets, and asks to sync at the end; the discuss lock is not released until the person's answer (applied, later, none) is recorded. Shipyard never writes to the tracker without that answer. Ideas that sit in a release or stand for a ticket no longer count against the idea limit that holds a new sprint. `version rename` for a release whose number is learned later.
- **A linked ticket is kept in step up to completion.** The same "what does the tracker not know yet" list is shown, and the question asked, when a sprint is planned (the ticket learns it is in a sprint: status, sprint, points, fix version) and when the sprint is reviewed and accepted (done, fix version, what was delivered). The build asks nothing. `tracker_sync` in the project's config chooses how: `ask` (default), `auto` (send and report; creating a ticket still needs a yes), `off`. A single ticket key given to `/ship-discuss` now comes in through `tracker pull`, so it carries the link and the sync block from the start.
- **A source that is connected is searched.** The hooks read which wiki, tracker and drive tools a session has from its transcript and log it once; "not connected" is then refused for a kind the session has tools for, and "not relevant" is refused until that source was really searched ("searched X: nothing relevant" is the honest answer). Before this a session with 39 drive tools recorded "shared drive: not connected".
- **A refined idea becomes an epic, with no shortcut.** `idea promote` no longer takes `--to story|task`.
- **The backlog is in the owner's order.** `backlog move <id> --top|--above|--below|--to --why "<what a delay costs>"` places an item and keeps the reason ("why here" on the board, which then shows one flat list). After the first placement a new story waits at the bottom and nothing re-sorts by score (`backlog rank` refuses unless `--by-score`). The planner takes stories from the top, in order.
- **The sprint review inspects and adapts.** It asks "does the sprint do what we wanted?" (close the sprint / something should change / it is not done) and then whether what was seen changes what comes next, with the backlog in front of the person. It no longer asks to "accept".
- **Shipyard's own `.shipyard` link is hidden from git by whoever makes it** (the repository's local exclude file). On a fresh project the build's readiness check had asked the owner what to do about it.
- **A record imported from a tracker keeps its own status and type for every reader.** The shared frontmatter reader let the ticket's mirrored `status`, `type` and `updated` replace the record's own (present since tracker import shipped): boards and gates then saw a "To Do" story of type "story". `tracker synced --ticket-status` keeps the mirror true after Shipyard moves a ticket.
- **Acceptance criteria are explained one plain line each (the owner's rule).** An approval used to paste every scenario in full Given/When/Then. Now each criterion is its id and what a person would see, in a few everyday words; `shipyard-data story acs <id>` lists them; the full scenarios stay in the story file and one is shown in full only on request. A card whose explanation pastes six or more Given/When/Then lines is sent back.
- **What is sent to a ticket was on the screen first.** A hook sends back a connector write (a comment, a description, a page) whose text was not in the session's own messages; a live sprint planning had asked to "send both comments as drafted above" with the drafts in its reasoning. And each question card's explanation must now be the message right before it: an older table in the same stretch no longer lets a bare card through.
- **Research looks inside the organisation first.** Discuss research now searches the wiki, the tracker, the shared drive and the project's own documents that the session can reach before the web, records where it looked, one line per kind of source (`discuss-questions sources --wiki … --tracker … --drive … --external …`: searched and found, not connected, or not relevant with the reason), and asks the person once, after showing that table, whether a document exists that no session can reach (a PDF, a contract, an email), reading what they give. A hook counts the wiki, tracker, drive and web calls made during a discussion (the tool's name only), and a line that claims a search with no such call behind it is refused: in live runs a session first recorded "looked at" from its memory notes with no call at all, then let one tracker search stand for all three. A story cannot be approved, the question list cannot be closed and the discussion cannot end until both are on record; the approval summary shows them.
- **Found by watching a second real project's discussion (work project, 4.0.0).**
  - `/clear` in the middle of a discussion left that session's discuss lock behind (the session-end cleanup covered planning and execution only), and the next `/ship-discuss` in the same terminal was refused twice. Session end releases all three now, and the refusal names the command that frees a closed session's lock.
  - A card the list did not hand out was refused ("every question card comes from the question list"), and the owner met it as an error. With nothing handed out, such a card is now recorded as a question whose answer is owed before approval; a different card while one is handed out is still refused.
  - A reply that is a question ("please advise") was recorded as an answer, with the session's own advice as the text. `discuss-questions ask-again <Q#> --their-words …` keeps their words, reopens the question and shows it again with the advice above it.
  - `discuss-questions bind --story` kept only the last story, so three of four stories from one discussion were not held by its open questions. A topic holds every story bound to it.
  - `discuss-questions next` with nothing waiting exited 3 and showed as a red error after every last answer. It exits 0; only a draft that needs rewording is an error.
  - "ship-discuss stopped halfway" (the owner): one story waited on a fact only they had and the turn ended on a plain "want that?", with the critic, the approval card and finalize not done. While a session holds the discuss lock, a turn that ends with no card on its way and no background research running is handed back once by the Stop hook.
  - The hooks read the last 1.5 MB of the transcript; that discussion's transcript was 3.9 MB and the `/ship-discuss` line was above the window, so every rule that needs to know the command would have gone quiet partway through. The command is now found in the whole file when the tail does not hold it.
  - A story written with the template's `$(shipyard-data)/…` reference got the absolute path of the same file added beside it and no verb could take either out. `add-ref` knows both spellings; `story remove-ref` exists; refusals name `story …` commands.
  - Five ideas were captured with nine `next-id` calls and a shell here-document inside the data folder. `shipyard-data idea capture --title …` allocates, writes and logs in one call.
  - Skills name the Grep and Glob tools, which that Claude Code session did not have; each first search failed. The start-up rules say to use `grep` and `find` through the shell straight away.
- **CI:** one instruction check passed only by the order files were read in; the runner sorts now.

## More fixes found while testing on a real project

- **From the first full sprint on the new machinery (sprint-015).** Build and test time in the review is clock time: it printed "178 minutes, 50% of active time" from the sum of ten builders' runs, which no clock showed; it now reports the time during which a run was going, and the sum beside it. A green `a && b && c` run proves each part, so a step that ran `make && make -k -j8 test && make ui-check` has proven the test tier on that code (15 proofs were recorded in the sprint and none could be reused, because each sat inside a longer command). The stage graph has the path from waiting on wave N+1 back to wave N's checks; the session had forced it.

- **A sprint starts over a finished hotfix or single task.** Their finished cursor sat in the folder the sprint's run reads, and the sprint's first step was refused as "already terminal"; a live sprint start read the plugin's source for two minutes and then forced past it. A run that begins at its first stage now replaces such a cursor. A finished sprint's cursor still refuses.

- **A step's dependencies have a command.** `shipyard-data step set-deps <step> <ids|none>`. The field is CLI-owned and had no verb, so a planner repairing a plan stopped and asked the owner to edit the file by hand. It refuses an unknown step, the step itself and a loop.

- **The urgent-bug lane reaches a fix without a detour.** It wrote a story with no "how to see it working" check, and the build refused it 27 seconds later; it now writes and verifies that check. A hotfix's finished work is accepted against the story id (the command refused anything but a step). Task and hotfix runs use the configured test command, skip the "before" run when the code is already proven, and run only affected tests after the change: one small fix had taken 1 hour 22 minutes on a suite run serially, twice.
- **A builder does not run a project script to read its help.** One ran a device tool with `--help`; the tool ignored the flag and started a full test on two real devices.

- **A check the owner left open survives the archive.** A device look answered "not yet" at the review belonged to a step that was archived with the sprint; an hour later the owner had looked and the answer had nowhere to go. `sprint person-check` finds archived steps, and `sprint needs-you` lists every check still open from earlier sprints.
- **Changing a running sprint re-checks its plan.** `shipyard-data sprint check` only confirmed that the waves parse. An extension pushed "turn the devices on" (a start-of-sprint step for the owner) into wave 2 and nothing said so. The check now also runs the plan's shape rules, and the extend path releases the planning lock, which it had left held.
- **Retiring a story says where the project still names it.** A story was retired as already built while a code comment still read "placeholder until that story lands"; the owner found the placeholder on the device. The note lists the files; it never refuses.
- **The lane card no longer says "rounds".** The router printed `refine_rounds=3` and the card repeated it to the person; it prints `question_budget` now.

- **A task that outgrows its lane leaves nothing behind.** `/ship-execute --task` escalated back to discussion before any stage had run, and the escalated cursor it wrote sat in the sprint's folder: the sprint could not start until someone ran `cursor resume`. With nothing in flight, an escalation now records the event and writes no cursor.
- **The test-setup task says what to do when half of it is too big, and is filed once.** On the test project every test binary was built from all the sources, so "only the affected tests" needed a change to how tests are linked. The task now tells the builder to build the small part, set its command and hand the rest to a discussion; a closed task is never filed again.

- **A built step still waits for the person's own check.** `sprint needs-you` listed an end-of-sprint check only while its step was not done; two steps were built and reviewed, and the list said nothing waited for the owner at the start of the review that had to ask. The check now has its own record: `shipyard-data sprint person-check <step> --answer "<their words>" [--failed]`, required words included, and the list shows the step until that record exists.

- **A discussion beside a running sprint commits its decision record, with no way around it.** The release check accepted a reason (`--leave-changes`); a live discussion gave "a commit is made only on request" and left the design record changed while a sprint ran its final tests on the same checkout. The reason is no longer accepted for a file the discussion itself wrote while another command runs there.

- **A story that will not be built is retired in one move.** `story set-status <id> rejected --reason "<why>" --replaced-by <ids>` works from `approved`, and the reason and the replacing stories are saved in the story and the event. A discussion had to force `approved → deferred → rejected` and write the reason into a document. An idea marked `landed` by mistake can go back to `captured`.

- **A discussion cannot stay off the question list.** "Every card comes from the list" was checked only after a topic had been started, and starting it was a sentence in a skill. A discussion over 26 open items never started one and asked its seven questions as free cards. The card hook now allows a discussion two cards of its own (the lane confirmation and one follow-up) and refuses the third with the commands that start the list.

- **Shipyard sets up the project's test infrastructure (the owner's expectation).** `shipyard-data infra check` reports four things: a test command, one run that lists every failure, a failed-only run, and an affected-tests run, plus the measured time of the whole suite. `infra apply` sets what the project's own tool already supports (jest, vitest, pytest, make's `-k`; go and gradle need nothing) and, when the rest has to be built once and the suite takes a minute or more, files one land-now task with a measurable "done when". The planner runs it at the start of every plan. On the test project both fast modes were empty and the suite had grown to 13 minutes.

- **Evidence instead of a second run (the owner's rule: tests must not be the bottleneck).** Every green `shipyard-logcap run` now records itself as proof of that command on that code; no skill has to remember to. A test tier is run with `--reuse`, which does not run a command already proven on this exact code. A proof is found by its command whatever name it was recorded under. A proof is tied to the project's own folder, so a commit in a sibling project of the same repository no longer spoils it, and `verify_ignore` lists paths (a changelog, a design document) whose commits keep it fresh. A builder's worktree neither records nor reuses a proof of the main checkout.

- **The discussion checks a story's numbers against the code.** Its critic now opens the code, data and design record behind every criterion that states a number or a claim about today's behaviour, and reports the ones that cannot be met (`UNMEETABLE_CRITERIA`) as questions before approval. A planner had found four of these after the stories were approved.
- **Refining a story and working on an epic ask from the question list too.** Both still used free cards, and the epic mode told the model to put four questions on one card, which the hook refuses.

- **The review shows what build and test runs cost.** Every captured run now records its time (`command_run`). The review's numbers show the count, the minutes, the share of the sprint's active time and the three longest runs, and say so when that share is 20% or more and the project has no affected-tests command (`test_commands.scoped`). In one sprint these runs were about 44 of 140 minutes and nothing showed it.

- **A wave's green whole-suite run counts as proof.** It was never recorded, so the sprint's final test stage ran the same suite again on the same tree. It is now recorded in the proof ledger and reused when nothing was committed since.

- **After a fix at a wave boundary, only the tests that failed are run again.** The whole suite ran after every fix; a seven-story sprint ran a ten-minute suite four times inside one boundary. The next wave's run and the sprint's final run still cover everything on the merged code.
- **A quoted list item that contains a comma is one item.** `touches: ["src/a.c#one,two", "b.c"]` was read as three items with stray quotes, so the declared file matched nothing.
- **The declared-files check works for a project in a subfolder of its repository.** Its first live run reported every declared file as undeclared, because the repository's paths start with the project's folder name.

- **The plan is planned in parallel.** Decomposition and the critic each ran as one agent over the whole sprint. A seven-story plan spent 25 of 47 minutes waiting for those two. Both now run one agent per story group in one message; the shell merges the drafts and the plan score is the check between groups.
- **Three places still told a command to put several questions on one card** (planning decisions, the fallback review's manual gates, the discussion's critic decisions). The hook refuses such a card, so the text now says one card each.

- **A builder that leaves its step's file list is named.** The plan is scored on each step's `touches:` list, but nothing checked that a builder kept to it. When a return is accepted the CLI now compares the commit with the list, prints a note, records `step_outside_touches`, and names a file that another step of the same wave declared. It never refuses an accepted commit; the sprint review lists the steps so the next plan can declare better.

- **An idea typed into a discussion is not a finding of the sprint running beside it.** The rule "findings captured in a sprint are decided in it" counted every idea created since the sprint began, so a running sprint had to triage ten ideas its owner had just captured in another session before its gates would pass. Ideas captured through `/ship-discuss` are now left to the discussion.
- **The cleanup stage can open a fix wave.** The stage graph had no edge from `sprint_refactor` to a new wave, so a fix step from the mutation check needed a forced cursor. The edge exists now.
- **A plugin problem found in a review is written down locally.** `shipyard-data plugin-issue add --title … --detail …` saves it in the project's data folder (`plugin-issues.md`) and prints one line that says nothing was sent. The review used to improvise that sentence and twice wrote that it was "sending" the problem to the maintainers; nothing was ever sent, but the wording was wrong.
- The review says "not needed (one story)" for the cross-story code review of a one-story sprint, instead of "not run".

- **A wave made only of fix steps skips its own build and test run.** Reviews add small fix steps at different points, and each became its own wave with a full build and suite. In one sprint that was about 40 of 110 minutes spent re-proving one-line test and document changes. Each fix step's own check still runs in its builder, the review still reads the change, and the sprint's full build and suite cover everything once at the end. `execution.patch_wave_tests: wave` restores a run per fix wave. Fix steps found at the same point go into one wave.

- **A dependency link is one-way.** `story add-dep A B` means A waits for B. B now records A under `dependents:`. Before, the reverse was written into B's `dependencies:` as well, so every link was a loop; an epic of eight stories had to be untangled by hand. A link that would close a loop is refused, and `remove-dep` clears a pair in both directions, the old form included.
- **Planned quality gates reach the review.** The planner writes `QUALITY-GATE.md` for every sprint, but the default review never read it. The review document now lists each gate and is not shown until every gate has a result.
- **A discussion commits the decision document it wrote, even beside a running sprint.** The write hook records which listed document a discussion wrote; `lock release discuss` then refuses while that file is uncommitted. Before, with a sprint running in the same folder, the check only warned, and the uncommitted file sat in the way of the sprint's next merge.
- The `.shipyard` link in your project is excluded from git locally (`.git/info/exclude`); nothing is added to your `.gitignore`.
- The CLI's help line lists the `sprint` verbs and every `discuss-questions` verb.

## Fixes after the 4.21.1 milestone (found while planning a live sprint)

- `story assign-ac-ids` gave a second id to a scenario that has a comment line (such as `# why not e2e:`) between its tag and `Scenario:`. It now reads the whole header.
- A discussion's question pictures are written under `spec/.questions/<topic>/` and removed when the question list is closed.
- A discussion no longer tells you the work comes "in rounds".

## 4.21.0 → 4.21.1

- **A discussion may write the project's rule files and its decision record, nothing else.** `CLAUDE.md`, `AGENTS.md` and `.claude/rules/` are always allowed (Phase 6 amends them after you say so). A project that records decisions in its own documents lists them once: `shipyard-data config set discuss-writable docs/decisions.md,docs/design/**`. Found live: an approved discussion records its decisions in the project's design document, which 4.20.0 would have refused.

## 4.20.0 → 4.21.0

**A step's probe must fail before the work is done.**

```
shipyard-data sprint probes-at-base        (--draft before the sprint exists, --next for a sprint drafted ahead)

  P144: fails (exit 1) · 6s
  P145: PASSES already · 4s
probes on today's code: 1 of 2 fail first, 1 already pass
  ✗ P145 already passes: it would prove nothing. Rewrite it to check what the step adds, or set probe_passes_at_base: "<reason>".
```

- The planner runs it after writing the steps. Each feature step's `acceptance_probe` runs once on the working tree, in the project's folder; results are kept in the plan folder (`.probes-at-base.json`) and an unchanged probe is not run again.
- **The gate.** A story cannot enter a sprint, and a drafted sprint cannot be queued, while a step's probe is unrun, was changed since it ran, or passes with no stated reason.
- A pass can be right (a pure refactor guarded by an existing check): the step says so with `probe_passes_at_base: "<reason>"`.
- `execution.probe_must_fail_first: false` turns the gate off. A sprint already running is not affected.
- Why: in a real sprint four of five probes passed before anything was built, so "the probe passes" proved nothing. The rule existed as one line in a planning checklist.

## 4.19.0 → 4.20.0

**A discussion asks its questions as they come up, and research never waits for you.**

```
researcher (background)               question list (CLI-owned)             main session (you)
  finds a real unknown ──── add ─────▶ Q3 open ───────────────── next ────▶ written in chat, one card
  carries on with other branches                                               │
  checkpoint: answers ◀──────────────── Q3 answered ◀────────── answer ───────┘
```

| | Before | Now |
|---|---|---|
| When you are asked | In "rounds": up to four questions after each phase | One card as soon as a question exists; the one that unblocks research first |
| Research while you think | Waited for a hand-off message after round 1 | Keeps going; reads your answers at its own checkpoints |
| Too many small questions | Dropped to assumptions silently | Past the budget they are shown as one table with the recommended answers and one card |
| The approval | Could be asked while a late finding was still coming | Always the last card: after every decision and after research ends |
| A session that was cut off | Asked you to summarize what was decided | The list remembers what was asked and answered; nothing is asked twice |

- New CLI: `shipyard-data discuss-questions start|add|revise|assume|next|answer|answer-bundle|answers|drop|research|wait|bind|status|pause|reset`. The file is `.discuss-questions.json`, one section per topic.
- **Every card in a discussion comes from the list.** Once a topic is started, the card hook refuses a question the list did not hand out. A story is not approved while its discussion has a question waiting, research running, or an answer the researcher never read.
- A badly shaped question is kept as a draft and reworded, never lost. "You decide" is an answer: the recommended choice is recorded as ASSUMED and shown before approval.
- **A discussion never edits the project.** While a session holds the discussion lock (and is not building), the write hook refuses a project file; only the project's rule files under `.claude/rules/` may be amended. A small change is filed as a task for `/ship-execute --task`. Found live: a chained discussion edited a document and a test file itself.
- Applies to new stories and ideas (NEW mode). Refining an existing story and epic discussions still ask as before.

## 4.18.0 → 4.19.0

**The planner aims for the most parallel work, and the CLI measures it.**

```
shipyard-data sprint plan-score            (--draft before the sprint exists, --next for a sprint drafted ahead)

plan score: 9 steps in 3 waves · widest wave 6 · longest chain 3 (P001 → P004 → P009)
  wave  1 ██████ 6
  wave  2 ██ 2
  wave  3 █ 1
```

| Change | Before | Now |
|---|---|---|
| Where a step goes | Any wave after its dependencies | The earliest wave its `dependencies:` allow; a later one is refused (`late`) |
| Same-wave steps and files | Not checked | Each step lists `touches:`; two steps of one wave on the same file are refused. `"src/app.c#input"` names a part when a file must be shared |
| Small sprints | 1 to 3 steps were built one at a time ("solo") | Any wave with two or more steps builds them at the same time; solo only when every wave has one step |
| Wave width | 6 steps (12 for a merged layer) | As wide as the dependencies allow, up to `execution.max_agents` |
| The chain | Named in prose | Printed by the CLI; the planner must question every link ("is this a real wait?") |

- **The gate.** A story cannot enter a sprint (`story set-status <id> in-progress`), and a drafted sprint cannot be queued, while the plan has a problem. The message says what to move or declare. `execution.parallel_plan: false` turns the gate off; the score still prints.
- **Existing configs.** `max_tasks_per_wave: 6` and `max_tasks_per_wave_merged: 12` are the old template's values and are ignored. A number you chose yourself is kept.
- **A sprint already running is not affected.** A sprint drafted ahead before this version and not yet started needs `touches:` on its steps (or the switch above) when it is promoted.
- Not checked yet: that a builder changed only the files its step declared.

## 4.17.2 → 4.18.0

**At most 100 agents alive at once, and the CLI holds the limit.**

| | Before | Now |
|---|---|---|
| Setting | `execution.max_parallel_agents: 3` (1 to 4) | `execution.max_agents: 100` (any whole number from 1) |
| What it counts | Builders in one wave | Every named agent a Shipyard command started and has not stopped: builders, reviewers, researchers, helpers |
| Who enforces it | A sentence in a skill | The agent hook: a spawn over the limit is denied and logged (`agent_spawn_refused`) |
| A wave of 6 steps | Two batches of three | All six builders at once |

- Change it with `shipyard-data config set-max-agents <n>`. `shipyard-data agents live --json` shows the limit.
- **Your existing config needs no edit.** A `max_parallel_agents: 3` line is the old template's value and is ignored. If you had changed it to 1, 2 or 4, that number is still honoured until you set `max_agents`.
- More builders at once means more worktrees on disk and more merges per wave boundary. Lower the number if a wave gets slower, not faster.
- New, not yet used by a command: `shipyard-data discuss-questions` (the question list for the asynchronous discussion that ships next).

## 4.17.1 → 4.17.2

- **A story's risk is scored on its own change.** `risk score --story <id>` now covers the files that story's own steps changed. Before, every story finished in a wave was scored on the whole wave's diff: a 53-line document audit came out "high" because a sibling story touched busy source files, and its small fix step was sent one model tier up instead of to the light model. A story with no recorded step commit is scored on the whole range, as before. The output and the `risk_scored` event carry `scope: story|range`.
- A file named `test_<something>` counts as a test for the "no tests touched" signal (the pytest and C naming).
- `patch-budget` uses the default of 2 fix steps per story when the config has no `patch_steps_per_story` key. A config written before 4.14.1 was read as 0, so the budget stayed at the flat floor.
- **A sprint built in place is measured like any other.** `execution_mode: solo` spawns its builders without the queue, and the numbers only read the queue: the review said "0 builder runs" and `archive-sprint` recorded no points per hour. A `builder-<step>` spawn and its recorded return now count as a builder run.
- **A sprint drafted ahead starts its clock when its work starts.** `next_sprint_queued` and `next_sprint_promoted` carry the next sprint's id while the previous sprint is still under review; they no longer open the sprint's event window (review numbers, points per hour, progress file, fix-step budget).
- The sprint review states that a built and reviewed story stays `in-progress` until the owner accepts the sprint. Two reviews had reported it as a plugin bug.
- The review never files a plugin issue itself; it tells the owner where to report it.

## 4.17.0 → 4.17.1

- `sprint queue-next` says to promote at once when the running sprint was archived while the next one was being planned.
- The execute decision ladder names `shipyard-data patch-budget` where a defect becomes a fix step. Before, the command was named only in a reference; an orchestrator counted "5 of 5" by hand from a config comment when the cap was 10.

## 4.16.0 → 4.17.0

**Commands no longer block each other.** A lock stops a second copy of the same command, nothing else.

| Lock | Held by | Blocks |
|---|---|---|
| `discuss` (new file `.active-discuss.json`) | `/ship-discuss` | another `/ship-discuss` |
| `planning` | `/ship-sprint` | another `/ship-sprint` |
| `execution` | `/ship-execute`, `/ship-review`, `/ship-debug` fix phase | each other |

- Before: discuss and sprint planning shared one lock, and planning and execution excluded each other except for discuss beside execute.
- **Plan the next sprint while one runs.** With a sprint in `sprints/current/`, `/ship-sprint` drafts into `sprints/next/` and touches nothing of the running sprint. On approval `shipyard-data sprint queue-next` marks it ready (no story changes status, nothing leaves the backlog). Once the running sprint is archived, `/ship-sprint` finds it (`SHIPYARD_NEXT_SPRINT_READY`), runs `shipyard-data sprint promote-next`, checks it still fits and finishes it as a normal plan. New verbs: `sprint plan-dir [--json]`, `sprint queue-next`, `sprint promote-next [--force]`, `sprint check --next`, `draft set-sprint-status <status> --next`.
- Each command's startup context names what runs beside it (`SHIPYARD_RUNNING_BESIDE=`); a discussion also gets `SHIPYARD_READONLY_STORIES=` (the running sprint's stories and those of a sprint that is approved and waiting).
- Safety for two commands in one checkout: `sprint set` refuses from another session while a sprint is being run; `stray set-aside` refuses while another command is working on the project (`--force` to override); the "commit what you wrote" gates at planning release and at the review's archive only warn in that case, because a changed file may be the other command's.
- A caller that still asks for `lock … planning --skill ship-discuss` gets the discuss lock.

## 4.15.4 → 4.16.0

**How Shipyard talks.** The rules in `skills/ship-discuss/references/communication-design.md` and `question-design.md` changed, and every command now gets the short form at startup.

- **The reader is not assumed to be an expert.** Plain everyday words; a technical term only with its meaning beside it; what a person would notice before how it works. (Was: written for architects and lead engineers.)
- **Every explanation and question starts with a 15-second summary** (40 words or fewer), then shows it with a picture, a table or a real example, and gives the underlying detail only when needed.
- **Quiet while it works.** A progress update is one line: a few words plus a small visual (`Wave 2 merged  [████████░░░░] 6/9 steps`). One line per boundary; a helper finishing is not a boundary.
- **One question per card, written in the chat first.** For each question the explanation and the question itself are chat text; then the question tool is called for that one question. The card holds only the question and the choices. A hook enforces this inside any Shipyard command: more than one question, a question over 160 characters, a choice label over 40 or a description over 110 is refused with instructions.
- **What you will notice:** fewer lines during a sprint; questions arrive one at a time, each under its own short explanation.

## 4.15.3 → 4.15.4

- The behaviour-first check also runs where a story enters a sprint (`story set-status <id> in-progress` from `approved`). A story approved before 4.15 is refused there with the list of what to add; the planner fixes it. Same exemptions as approval.

## 4.15.2 → 4.15.3

- **Approval is the behaviour-first gate.** `story set-status <id> approved` on a `proposed` story runs the `check-scenarios` rules and refuses (exit 3) with the list of problems. Every lane approves through this call, so none can skip the check: in 4.15.2 the idea and chained lanes approved a story without it. Not applied to a hotfix (`lane: hotfix`), to a story returning from a sprint, or with `spec.behaviour_first: false` (new config key, default true).
- **What you will see after upgrading:** a `proposed` story written before 4.15 is refused at approval until it has a `## Paths` map, a level tag on each scenario and a reason on each level below the journey. Stories already approved are untouched; `/ship-sprint` check 24b brings them to the rules when they enter a sprint.

## 4.15.1 → 4.15.2

- **`shipyard-data story check-scenarios <ID> …`** is the behaviour-first gate: every scenario has an `@AC-n` id and exactly one level tag, a level below the journey carries `# why not e2e: <reason>` on the line under its tags, and `## Paths` names every scenario. Exit 3 lists each problem. `/ship-discuss` runs it before finalizing and `/ship-sprint` runs it as check 24b, where a story written before the rule is brought to it. It is never part of `/ship-execute`, so a sprint already planned is not stopped. Before, the first stories written after 4.15.0 had no path map and unit-level tags: prose did not carry the rule.

## 4.15.0 → 4.15.1

- **A review commits what it wrote.** The first tick of a cycle (`cursor advance … preflight`) writes `sprints/current/.tree-baseline-<pipeline>.json`: the tracked files that were already uncommitted. `archive-sprint --via-review` is refused (exit 3) while a file that became dirty during the review is uncommitted, with the same three ways out as the planning lock: commit those paths, `stray set-aside`, or `--leave-changes "<why>"` (logged). Before, two reviews ended with the owner's decisions uncommitted and a line offering to commit them.

## 4.14.1 → 4.15.0

**Tests start from the behaviour.** The test rules (`skills/tdd-cycle/references/test-economy.md`) now follow one method end to end:

- A criterion is one scenario: Given (starting state), When (what the user or the outside world does), Then (what someone outside the system can observe). Before the scenarios, the story maps every path from the trigger to each ending (`## Paths`): each ending has a scenario or a stated reason it cannot happen. `story check-probes` adds a note to a tagged story with no path map (never a failure).
- **The default level changed.** It was `@component` when unsure; it is now `@e2e`, the journey through the real code with fakes only at the true edges (hardware, network, clock). `@component` only for a fault, race or timing the journey cannot stage; `@unit` only for a rule with many input values, as one table. Existing stories keep their tags; new ones get the new default.
- Tests are written from the scenario before reading the code, and watched failing.
- **`verify-ac-coverage` checks both directions.** A test file added or changed in the sprint with no scenario id (`AC-<n>`) is an orphan test, reported beside orphan scenarios and blocking under `execution.enforce_ac_coverage`. A test with a real reason says `no-scenario: <reason>`. Only applies when the sprint has tagged scenarios.
- If scenario and code disagree, one of them is a bug and both are fixed in the same step: a builder returns `ESCALATION_CODE: spec_disagrees` with `SPEC_FIX: <AC id>: …` instead of coding around it.

## 4.14.0 → 4.14.1

- **The fix-step budget grows with the sprint and is counted by the CLI.** `shipyard-data patch-budget [--json]` prints what is left: the cap is the larger of `execution.max_patch_tasks` (5) and `execution.patch_steps_per_story` (new, default 2) × the sprint's stories, and the count comes from the event log. Exit 3 means the budget is spent. Before, a flat 5 counted by hand ran out on healthy story-review fixes in a seven-story sprint.
- Warm fixes are for work that is not merged yet; a finding against merged work is a patch step. A warm fix or redispatch re-runs the step's own probe.

## 4.13.6 → 4.14.0

- **A story probe no longer re-runs the full suite.** `shipyard-data story probe-command <ID> [--json]` prints what to run for an automatic probe: when the probe ends with `&& <a configured test command>` and the ledger holds a fresh proof of that exact command for this tree, that trailing part is left out (`run`), and the probe's own command is kept for the record (`record_as`). Only a trailing `&&` part is ever dropped, never the whole probe, and never without a fresh proof. `/ship-execute` uses it at the sprint-end probe stage. Measured on a real sprint: seven probes each ended with the project's five-minute suite, about 30 minutes of a 2-hour sprint.
- `story check-probes` adds a note to a probe that ends with a full test command; `/ship-discuss` is told a probe proves the story, not the project.

## 4.13.5 → 4.13.6

- **Asking a verb for help never runs it.** `shipyard-data <verb> … --help` (or `-h`) prints the verb's usage line and "nothing was run"; `shipyard-context <cmd> --help` prints its usage. Before, an unknown flag was ignored and the verb ran: `next-id steps --help` used up an id. Arguments after a literal `--` belong to a wrapped command and are left alone.

## 4.13.4 → 4.13.5

- **A planning command commits what it wrote.** `lock acquire planning` notes which project files were already uncommitted; `lock release planning` is refused (exit 3) while a file that became dirty during the command is uncommitted, and names the three ways out: commit those paths, `stray set-aside`, or `--leave-changes "<why>"` (logged). Files that were dirty before the command are never counted. Before, the rule to commit a decision record by path was prose and was skipped.

## 4.13.3 → 4.13.4

- **Review reuses the proof execute recorded.** `shipyard-data verify list [--json]` shows every recorded proof, fresh or stale, with the command and the exact `verify check` line that reuses it. `review-pack` prints "Full suite proof: fresh … reuse it" (or why it is stale). Each proof now stores its command text. Before, review looked the suite up under a key of its own and re-ran it.
- The progress file shows the current sprint only, and patch rows read v4 `step` / `story` names. Before, it carried every earlier sprint's patch steps and activity.
- Planning check 7: anything a step needs outside the repository is checked at planning.

## 4.13.2 → 4.13.3

- `story set-status <id> released` writes `released_at` itself (kept if already set). The release step no longer asks for a second command; the old one named a key `story set` refuses, so stories were released with no date.

## 4.13.1 → 4.13.2

- `review-pack` facts show **Built and reviewed** beside **Accepted (done)**. At review time every story is still `in-progress`, so the old single "Delivered" column read 0 for a finished sprint. New fields: `outcome.stories_ready`, `outcome.points_ready`.
- `/ship-review` creates its cursor at `preflight` before anything else, and the cursor's "no existing cursor" refusal now prints the command that fixes it.

## 4.13.0 → 4.13.1

- **Untracked files no longer block a verification proof.** The clean-tree check now looks at tracked files only, and each proof stores a fingerprint of the untracked (not ignored) files in the project's folder: path, size and modification time. A later check is fresh only when the committed tree and that fingerprint are both unchanged. Before, any untracked file (a scratch folder left by a tool) made a proof impossible, so every sprint review re-ran the full suite. More than 5000 untracked files is still refused, with a pointer to `.gitignore`. Proofs recorded before this version hold only while there are no untracked files.

## 4.12.2 → 4.13.0

- **Stray changes are set aside.** `shipyard-data stray list` shows tracked files changed in the project's folder with no commit; `stray set-aside --reason "<who or what>"` moves them into a git stash and prints how to get them back. Nothing is discarded, untracked files are only listed, and the tree is clean again. `/ship-execute` runs it after a read-only agent returns and before a wave gate. Before, a reviewer's `tool --help` regenerated a tracked file in the owner's checkout and the unattended sprint was left saying "still needs you".
- Reviewer agents are told not to run a project script they have not read; `--help` is not safe.
- `/ship-discuss` commits the decision record it wrote (by path, with the stories' approval), so the planner no longer asks at the start of each sprint.

## 4.12.1 → 4.12.2

- An idea triaged as a defect with `fixed_by: <step>` becomes `landed` when the sprint that built the step is archived. `/ship-backlog` knows `landed` as the status for "already fixed or built".

## 4.12.0 → 4.12.1

- `idea set-status` no longer refuses an idea whose status is not a lifecycle word (`new`, `pending`, `open`, or none): it is read as captured and the move is recorded. Builders are now told to write `status: captured`. `idea repair` still lists such records.

## 4.11.2 → 4.12.0

The sprint review is one document, shown whole, and a human look is recorded only from that person's answer.

- **`shipyard-data review-pack --write`** writes `sprints/current/REVIEW-PACK.md` with twelve numbered sections. Every fact the CLI knows is already in it: outcome table, per-story evidence, design pictures, quality work, every decision with its basis and reason, points per hour, steps per model, waves, what was not done, what was found and why it was left. The parts only a reviewer can write are `<!-- FILL: ... -->` markers. `review-pack check` exits 3 while a section is missing or a marker remains, and `/ship-review` cannot reach the owner's question until it passes. The review on screen is that file, unshortened. Before, the screen text was written freehand and left out what went badly, the proposed actions and what comes next.
- **`story record-proof` needs `answer="<their words>"`.** Accepting a sprint does not confirm a "look at it on the device" check: at a real review four were recorded as confirmed by the owner on acceptance. A probe is recorded only from its own answer; otherwise it stays pending and is listed as not verified. `story retract-proof <id> reason="..."` takes a wrong one back (the log keeps both; readers take the later).
- **`design approve <story> --from <other story>`** reuses an approved design for another story and carries its fidelity, crop and scene.
- `reconcile` and `doctor` no longer call a finished sprint's branches leftover before that sprint's review.

## 4.11.1 → 4.11.2

- **A stale exit file can no longer look like a finished run.** `shipyard-logcap run --exit-file` removes an existing file before the command starts. An agent waiting on the file had reported green from a previous run's file while the suite was still running.
- **The verification ledger works for a project inside a larger repository.** The clean-tree check is scoped to the project's own folder (the session's project directory when it sits inside the repository root), and the proof records that folder. Before, untracked sibling projects made the tree "dirty" forever, so no proof was ever recorded and every sprint review re-ran the full suite. Dirt inside the project still blocks a proof.

## 4.11.0 → 4.11.1

- **The routed model is enforced at spawn.** A hook refuses a `shipyard-disciplined-builder` spawned for a step on a model other than the one the step is routed to, and names the model to use. In a real sprint the orchestrator resolved a model once and reused it, so small steps kept running on Sonnet after routing had moved them to Haiku. Applies only inside `/ship-execute`, only to builders named after a step, and follows the failure ladder.
- The operational agent no longer ends its turn to wait: it waits inside one Monitor call and speaks when it has a result.

## 4.10.0 → 4.11.0

Quick decisions are a CLI call with a forced answer, and the Haiku call is lean.

- **`shipyard-data decide`.** The quick-decision rung is now `decide --question "<q>" --option "A=<text>" --option "B=<text>" [--facts-file <f>] --stage <s> --subject <id>`. The CLI asks the light model through `claude -p` (your Claude Code login, no API key), forces a JSON answer (`choice` from the given labels, `reason`, `confidence`), and takes only a high-confidence choice (exit 0, logged as `execute_decision source=quick`). Anything else is exit 3: go to the think-tier consult. About four seconds and a tenth of a cent. Off switch: `routing.quick_decisions: false`.
- **Lean call shape.** The Haiku calls (this one and the opt-in intake router) now run with their own short system prompt, no tools, no MCP servers, no slash commands, no saved session, `--effort low` and `--json-schema`. Measured on Claude Code 2.1.325: 7.8 s and $0.0094 before, 4.0 to 5.1 s and $0.0012 after, because the default `-p` run loaded about 45k tokens of session context for a question that used none of it. `--bare` still refuses a subscription login, and thinking cannot be switched off from the command line.
- `SHIPYARD_CLAUDE_BIN` names the `claude` binary to use when it is not the one on PATH.

## 4.9.2 → 4.10.0

Three speeds: Haiku for straightforward work, Sonnet for work that needs reasoning, Opus for hard work.

- **Routing by size.** A feature, bug, fixer or unblocker step is routed by its size: **S → light, M → build, L and XL → think** (`routing.size_tiers`). Before, the builder role floored every step at the build tier, so the light tier was reachable only by track coordinators. Risk still only raises (high: one tier up; critical: think), `debug` never goes below build, operational steps and chores run light, research runs think. A step can pin itself up with `tier: build|think` in its frontmatter.
- **Failure ladder.** One dispatch per rung from where the step started: light → build → think. A light-tier step gets up to three dispatches, a build-tier step two, as before. A light-tier builder gets no warm retry for a failed gate; it climbs.
- **Quick decisions.** The decision ladder has a new rung before the think-tier consult: a bounded call (the options are written down) goes to one light-tier agent (`resolve-model decide`); only a high-confidence answer is taken.
- **Nothing changes until a light model is set.** If `models.light` is empty (every project created before 4.10), light means build, exactly as before. Turn it on with `shipyard-data config set-model light haiku`. New projects get `light: haiku`.
- **Large steps now run on the think model.** This does change existing projects: an L step used to run on build at high effort. To keep that: `shipyard-data config set routing-size-tiers "S=light,M=build,L=build,XL=think"`.
- The sprint review shows how many steps each model finished and how many had to climb.
- Planners: S must mean straightforward (one or two files, an exact spec, no design choice). A wrongly sized S costs one failed dispatch before it climbs.

## 4.9.1 → 4.9.2

- **A builder's return is one command.** `shipyard-data task-return` now writes `capture_file` and closes the builder's queue item itself. Before, a builder had to run `queue complete` as a second step: that command needed a field the first never wrote, and a worktree sandbox refused it, so three finished builders left their items claimed and an unattended sprint stopped to ask. `queue complete` repeated with the same artifact is a harmless yes; `capture_file` in an artifact is optional (when given it must exist); `queue reconcile` can be re-run on an item it failed for a bad artifact.
- **Finished builder worktrees are removed.** `archive-sprint`, `branches sweep` and `reconcile --fix` remove every clean `shipyard/wt-*` worktree (plain `git worktree remove`, never `--force`), then sweep its branch. A worktree with uncommitted changes is left and named (`worktree-with-uncommitted-work`): Shipyard does not delete uncommitted work.

## 4.9.0 → 4.9.1

- **No helper agent is left listed after a command.** A new hook records every named agent a Shipyard command starts and every `TaskStop`; `shipyard-data lock release` refuses (exit 3, names them) while one this command started is still listed. `/ship-discuss` and `/ship-sprint` stop their deep-dive, analyst and critic agents before releasing. Agents you start yourself outside a Shipyard command are not recorded. `lock release --force` still releases.
- Restart Claude Code sessions after upgrading: hooks are read at session start.

## 4.8.1 → 4.9.0

Shipyard leaves the repository as it found it, and a builder cannot quietly lower a bar.

- **Branch sweep.** Every accepted step leaves a `shipyard/keep-*` anchor and every isolated builder a `shipyard/wt-*` branch; nothing removed them (a real project had 569 after six sprints). `archive-sprint` now deletes the ones already contained in the working branch and moves the rest to `refs/shipyard/archive/<sprint>/`: out of `git branch` and the default push, still refs, so the commits are never garbage-collected. A branch checked out in a worktree is never touched; nothing outside `shipyard/keep-*` and `shipyard/wt-*` is read or written. `shipyard-data branches status|sweep [--dry-run]` does it by hand; `reconcile` reports `stale-shipyard-branches` when no sprint is running and `--fix` sweeps. Existing projects: run `shipyard-data reconcile --fix` once between sprints. Opt out: `execution.sweep_branches: false`. To bring one back: `git branch <name> refs/shipyard/archive/<label>/<name>`.
- **Weakened tests are flagged.** `scan-stubs` now also reports, for existing test files, a line that differs only in its numbers (`test-number-changed`), a hunk that removes more assertions than it adds (`test-assertion-removed`) and a deleted test file (`test-file-deleted`). They are MEDIUM flags (exit code unchanged) the per-step gate must check against the step's spec. The builder has a new iron rule and a new return code, `check_needs_owner`: a check it cannot meet is parked for the owner, never lowered.
- `scan-stubs` accepts `--base <ref> --head <ref>` as well as `<base>..<head>`; `step accept-return` reports every missing argument at once.
- The blocked-code routes in `dispatching-task-loop` follow the unattended ladder (consult, then park) instead of asking.

## 4.8.0 → 4.8.1

- **`review-pack` no longer hangs on a long design note.** A pattern that read a story's `design:` block backtracked exponentially; on a real project the command took five minutes. The block is now read in linear time everywhere (`review-pack`, `story set-status approved`, `design`). No data change.
- Execute references no longer tell the orchestrator to ask on a rebase conflict or an uncovered blocker: the conflict goes back to the builder that wrote the branch, or the step is parked.
- The operational agent waits on a long run with one Monitor and does not poll it.

## 4.7.2 → 4.8.0

The delivered screen is compared with the approved design, inside the sprint.

- **Review gate.** `story-review record` for a `ui: true` story with an approved design now needs `--design MATCHES|DIFFERS|UNVERIFIED`. MATCHES and DIFFERS need a `ui verify --level screen` run for that story in this sprint; MATCHES is refused after a failed pixel diff; DIFFERS cannot be `approve`; UNVERIFIED needs `--note` and is listed at the sprint review as not compared. Opt out with `execution.design_review: false`. A project with `ui.adapter: none` can still compare a pre-rendered image with `--image`.
- **Mockups.** `design approve --fidelity mockup [--crop x,y,w,h] [--scene <name>]` marks a drawing or page export. `ui verify --level screen` then writes `ui/<story>/compare/side-by-side.png` (design left, delivered right), prints layout and colour similarity as information, and returns `look` instead of pass or fail. Set `ui.min_layout` / `ui.min_palette` (0..1) to turn the numbers into errors. Designs approved before 4.8 stay `exact`; re-approve as a mockup if the snapshot is a drawing.
- The review pack shows each story's recorded comparison and lists the side-by-side images.

## 4.7.1 → 4.7.2

- **Findings captured in a sprint are decided in the sprint.** `shipyard-data idea triage <IDEA-id> --kind defect|improvement|question [--severity low|medium|high] [--fixed-by <step>] [--reason "..."]` records the decision. Leaving a wave gate is refused while an idea captured since the sprint started is untriaged, or a defect above low severity has no fix step; the execute terminal also waits for that fix step to return (a parked fix is allowed and reported). Calling a defect low needs a reason, shown in the review pack. Capture itself is never refused. Opt out: `execution.triage_sprint_findings: false`.
- **Native frames in a sub-folder project.** The `frames` adapter runs `ui.frame_command` where the command was typed (a monorepo sub-project, a builder's worktree) and a failure shows the exit code, directory and output. `ui screenshot --scene <name>` writes one `frame.png` (no web width labels), and `ui verify --level screen --scene <name> --story <id>` needs no spec file.
- The patch budget under unattended execution is decided by the ladder (consult, then park with `reason=patch_budget`), not by an inline question.
- Frontmatter values containing `$` are written literally.

## 4.7.0 → 4.7.1

Three rules that were instructions are now enforced, because an orchestrator skipped them in a real sprint and the owner had to step in.

- **Overlap is a gate.** With `execution.overlap_waves` on and worktree isolation, `cursor advance execute wave_<N>_build` is refused until wave N+1 has been dispatched; the refusal prints the two commands. The last wave, `overlap_waves: false` and in-place (isolation none) work are exempt.
- **No questions mid-execute.** A PreToolUse hook denies `AskUserQuestion` in the session running the sprint once builders have started, and names the decision ladder. Start-of-sprint stages, task and hotfix modes, other sessions, a paused cursor and `execution.unattended: false` are allowed. Denials log `unattended_ask_denied`.
- **A worker's name is its claim.** `queue claim` gives a worker named after a step (`builder-T427`, `w2-T427`) that step, with or without `--task`, and never a different one.

## 4.6.0 → 4.7.0

Robustness release: what happens when a session dies, a sprint is paused, a cycle ends, or the plugin is upgraded. No action needed; each item is automatic.

**A killed session no longer blocks you.** The skill lock records the Claude Code process that owns it. When that process is gone (hard kill, crash, closed terminal) the next session takes the lock at once instead of waiting out the 2-hour stale window, and logs `stale_lock_recovered reason=owner_process_gone`. A live session's lock still blocks. The dead session's builders stay on the agent ledger until you account for them (`shipyard-data agents stopped <name> --reason dead`), and their queue items are requeued by `queue requeue-stale` as before.

**The end of a cycle leaves clean state.** `archive-sprint` now finishes the sprint's stories itself on every path: a story still in-progress becomes `done` when its review verdict recommends approve, otherwise it goes back to the backlog as `approved` (carried over); each move logs `sprint_story_finalized`. Epics follow their stories and backlog rows for closed work are removed.

**`shipyard-data reconcile [--fix] [--json]`.** Finds state that drifted when a cycle ended: a story in-progress that no sprint holds, an epic behind its stories, a cursor left in `sprints/current/` with no sprint and no running session, backlog rows for finished or missing stories, a reviewed sprint that was never archived. `--fix` repairs through the typed verbs and logs `state_reconciled`. `/ship-sprint` runs it before planning, `/ship-status` runs and reports it, `doctor` lists the findings as `state-drift`.

**Upgrade notice.** The data dir remembers the plugin version that last worked on it (`.shipyard-version`). The first skill started under a different version says so once, points at this file, and runs `doctor` and `reconcile`.

**Migration guards.** `migrate` refuses while a sprint is in flight (the event log keeps the old ids, so renumbering mid-sprint would strand the gates' evidence); finish and archive first, or pass `--force`. After a migration `doctor` follows `aliases:` from an event's old id to the renamed file and accepts `steps:` in place of `tasks:` on stories (it used to report every migrated story).

## 4.5.0 → 4.6.0

Behavior change. One config key decides it (`execution.code_review`, default on); a sprint already in flight keeps working, with one new requirement noted below.

**Code review and its fixes moved into `/ship-execute`.** When a story's last step merges, its review is spec review, gap analysis **and a code review** (security, bugs, silent failures, patterns, tests, observability, data). Findings are fixed in the sprint, preferably by the builder that wrote the code. `shipyard-data story-review record` now needs `--code CLEAN|FINDINGS [--code-findings <n>]` and refuses without it — a sprint in flight records its next story review with the flag. A sprint with two or more stories gets one cross-story pass at a new stage, `sprint_code_review`, before the final build and suite. Before the first builder starts, execute captures "before" evidence for the review (a frame per UI story, the probe output for a behavior story).

**`/ship-review` is the sprint review.** When the code review is on record from execute, review scans and fixes nothing: it builds a review pack and asks you once. The pack: sprint goal and outcome; what you can do now and how to see it; evidence per story with before/after and design conformance; the quality work done during the sprint and where each finding went; decisions made without asking, with their basis; numbers (time, dispatches, retries, suite runs, code and test delta, velocity trend); what was not done and why; what was found and left, and why; what was not verified, risks and debt; what went well and what did not; proposed action items with owners; and what is next. Every number comes from `shipyard-data review-pack [--sprint <id>] [--base <sha> --head <sha>] [--json]`. The retro is sections of the same pack; the release keeps its own approval. The old scan-and-fix stages remain as the fallback for sprints executed before 4.6, `execution.code_review: false`, `--hotfix` and single-story reviews.

## 4.4.0 → 4.5.0

Behavior change, no data migration. Shipped from running Shipyard on a real project (a C/SDL game for a handheld device) as its owner, after the 4.4.0 walkthrough.

**Waves overlap (`execution.overlap_waves: true`, the default).** As soon as wave N is merged at its boundary, wave N+1's builders are dispatched from the merged HEAD; wave N's build, tests, spec verify, per-story review and any fix steps run alongside and land on the working branch, and N+1's branches rebase onto them at their own boundary. The stage graph gained three edges for this (`boundary → next dispatch`, `dispatch(N+1) → build(N)`, `gate(N) → waiting(N+1)`); `false` restores the serial boundary. Patch steps from a review join the earliest wave not yet dispatched, or a new final wave.

**Any renderer can be the pixel source: `ui.adapter: frames`.** Set `ui.frame_command` to the project's own command that writes a PNG for a scene (`{scene}` and `{out}` placeholders — a game harness, a device screenshot tool, a terminal recorder). `ui screenshot` runs it; `ui verify --level screen` diffs the frame against the approved design with a pure-Node PNG diff, no browser; `ui verify --level screen --image <frame.png>` does the same for any PNG you already have (adapter `none` included). Component and flow levels stay the project's own checks under `frames`. The DESIGN stage now has a Step D0 that decides and records the pixel source (`shipyard-data config set ui-adapter …`, `ui-frame-command …`) the first time a project meets a UI story.

**Test economy is a rule, not a hope.** `skills/tdd-cycle/references/test-economy.md`: every test proves one promised behaviour at its scenario's level tag (`@unit` / `@component` / `@e2e`, chosen in discuss) and nowhere else; scenarios sharing a `Given` share one test (grouped assertions, a journey, or a table) with one labelled assertion per `Then`; interaction-only, wiring and coverage-padding tests are banned; a test that stays green with the production line deleted is deleted; `@e2e` asserts every outcome channel by value and compares rendered output against golden files; a touched feature's tests migrate in the same change. The builder's fourth non-negotiable, the code reviewer's `tests` concern, and the discuss spec writer all carry it.

**No agent outlives its work.** `shipyard-data agents spawned|stopped|live|check` keeps an event-derived ledger of the agents a pipeline spawned (queue claims are recorded automatically). Builders stay resumable until their wave's gate and are stopped there; reviewers, analysts and runners are stopped on return; `cursor advance` out of a wave gate refuses while that wave's agents are live, and no terminal is reachable with an agent unaccounted for. Workers are named `builder-<step>` and claim their own step (`queue claim --task`).

**Agents talk instead of restarting.** Review findings and gate misses on a finished step go back to the builder that wrote it over `SendMessage` (a warm fix) instead of to a cold new agent; a blocked or silent builder still gets a fresh agent one tier up, and the two-attempt cap holds. Builders can send two kinds of message while they work: `INTERFACE` (a shared contract changed — relayed to the sibling builders it affects) and `QUESTION` (one decision with a recommended answer, answered by the decision ladder).

**Decision ladder, final shape.** already decided (the approved plan or decision log) → rule → think-tier consult → Claude Code's advisor, when you have enabled it (`/advisor opus`) → park. `/ship-sprint` pre-clears owner-gated rule changes at plan approval so execute never has to ask. `doctor` hints when the advisor is off and a sonnet/haiku tier is configured.

**Platform features used as designed.** The review fan-outs ship as named workflows (`shipyard:review-scan`, `shipyard:story-review`, still opt-in via `review.workflow`). A plain `/ship-execute` and `/goal` both run to a terminal (the skill used to contradict itself); for a long sprint: `/goal run /ship-execute until its last line says CYCLE COMPLETE`. Wakeups are for external waits only. Step files never tell a builder to run the full suite — the wave boundary runs it once.

**Smaller things.** `config set` accepts `test-commands-unit|integration|e2e|scoped`, `build-commands-full|scoped`, `project-type`, `testing-framework`, `e2e-framework` and the `ui-*` keys. Chained `/ship-discuss` finalizes a bug record like a story (probe, approval, backlog) and re-reads newer owner decisions before approving. Ideas fixed on the spot are `landed`, not `rejected`. Legacy `B-###` bug ids are read everywhere. `doctor` ignores pre-v4 placeholder patch ids.

## 4.3.0 → 4.4.0

Behavior change, no data migration. Everything here came out of one end-to-end customer walkthrough (a fresh Node project, every command, two sprints) and the rule the walkthrough confirmed: **a question in the middle of `/ship-execute` is a gap in discuss or sprint planning, not something to ask the user.**

**Execute runs unattended (`execution.unattended: true`, the default).** After the readiness step `/ship-execute` asks nothing. Anything a stage would have asked goes through a decision ladder: a defect found during the sprint (spec-review or gap-analysis finding, failing probe, design drift, a checklist that misses scenarios) is fixed **in this sprint** as a patch step that also folds the behavior into the story's spec; only a `severity: low` finding may become a bug story on the backlog or an accepted gap; anything the rules do not decide gets one think-tier consult and a medium/high-confidence recommendation is taken; otherwise the item is parked with `cursor escalate`. Every decision is logged as an `execute_decision` event and `/ship-review` renders them as **Decisions made for you** at the approval ask and in the retro — that is where you weigh in. Human probes (`user_flow_probe.kind: assisted|manual`) no longer stop execute: it records `PENDING_HUMAN` and `/ship-review` Stage 5 collects your verdict before approval. Set `execution.unattended: false` for the 4.3 pause-and-ask behavior.

**Fewer zero-information questions elsewhere.** `/ship-sprint` states the first-sprint capacity (`execution.default_capacity`, 20) instead of asking, selects the only approved story that fits instead of asking which, and never asks to "save as default" (velocity comes from `archive-sprint`). `/ship-review` runs the retro by default (`--skip-retro` to skip) and writes the three retro answers from the data instead of asking them; the release approval also commits `CHANGELOG.md`. `/ship-backlog` prints an empty board and stops. `/ship-status` runs onboarding instead of asking you to say the word, and every skill continues in the same turn after onboarding instead of telling you to re-type the command.

**UI stories decide their design in discuss, on the Claude Design artifact.** The DESIGN stage prototypes on a Design artifact (the HTML mock is a fallback only when the Artifact tool is absent) and the decision is recorded by the CLI: `shipyard-data design approve` or the new `shipyard-data design waive <S###> --reason "…"`. `story set-status approved` refuses a `ui: true` story with neither on record, so `/ship-sprint` Check 25 can no longer send you back to discuss. `design check` reports `WAIVED` and passes for a waived story. A terminal cannot show "the design above": sign-off names the artifact link or the PNG path.

**Shipyard no longer commits your files.** The readiness step commits only Shipyard-written residue (`CHANGELOG.md`, `.claude/settings.local.json`) by path; a tree dirty with your own files is a one-time ask at the start (commit, stash, or continue), never `git add -A`. `ensure-worktree-baseref` writes `.claude/settings.local.json` (excluded repo-locally) instead of the tracked `settings.json`.

**Fixes.** `--task` / `--hotfix` runs end cleanly (their terminal is gated on the task's own evidence, not on sprint evidence — before this every land-now run ended in a refusal and a stale cursor). `risk score` no longer treats `ledger` as a payments path and counts `// AC-<n>` markers in test files. `shipyard-data onboarding bootstrap` seeds `project_type`, `tech_stack`, `testing_framework`, `test_commands.unit` and `build_commands.full` from the project's manifests (package.json, pyproject, go.mod, Cargo.toml, Gradle, Maven, SwiftPM). `doctor` accepts a standalone task without a `feature` field and no longer reports an archived patch step as dangling; idea counts ignore `.id-seq`. `done → released` is a legal story transition. `shipyard-data help` lists every verb one per line; an unknown command is one short line; `shipyard-data ui` alone is a usage error. `--plugin-dir` sessions resolve the data dir from a skill preamble (the breadcrumb tag is derived from `CLAUDE_CONFIG_DIR`). The builder checks `ui doctor` once and skips render-and-look when the adapter is `none` instead of searching for Playwright.

## 4.2.0 → 4.3.0

Non-breaking. Everything below is opt-in per story (`ui: true`) and per project (`ui.adapter`); projects without UI stories see no change.

**A design stage for UI stories.** In `/ship-discuss`, a story that changes what a user sees can get a prototype (within the repo's own components and tokens, with stable element ids) and a signed-off snapshot: `shipyard-data design approve <S###> --file <snapshot>` records version and sha256 in the story's `design:` block and copies the file to `spec/designs/`. `/ship-sprint` Check 25 (`shipyard-data design check`) refuses a UI story whose design is missing or changed after sign-off — re-approve as a new version. Artifacts are never published without your confirmation.

**Render-and-look for builders.** A UI step's brief names the approved design; after the acceptance probe the builder screenshots its screen (`shipyard-data ui screenshot`), looks at the captures next to the design, and fixes visible deviations before committing.

**Three-level visual verification, deterministic first.** `shipyard-data ui verify --level component|screen|flow`: computed styles, boxes, states and the accessibility tree against expectations; a tolerant screenshot diff (masks) against the approved design plus a design-lint rule pack (built-in rules such as 44 px touch targets, 4.5:1 contrast, no horizontal scroll at 375 px, `img` alt; verified rules are errors, draft rules warnings; `ui.rule_pack` extends them); and scripted flows with a screenshot per step. The wave boundary runs the screen level for a merged UI story, `/ship-review` Stage 2 runs all three. The CLI's verdict is the verdict — a model may flag, never approve.

**Fixes from the 4.3.0 code review.** `shipyard-data step accept-return|accept-operational` work again (a duplicate dispatcher case made them unreachable since 4.0.0 — every v4 sprint's execute terminal would have starved). `queue reconcile` now emits `worker_queue_failed` for a failed item (was `worker_queue_stale_parked`), so the claim closes in `report time`/active time. One liveness window: `requeue-stale` and the presumed-dead detector both use 15 minutes. `risk score --cap` counts distinct critical stories, not repeated scores of the same one. The review `terminal_changes`/`terminal_issues` gate only counts a patch step or bug story created after this review's preflight (tracker imports log `story_imported`, never `story_created`). Multiline inline lists in story frontmatter rewrite again. Wave bullets like `PR12`/`Part2` are no longer read as step ids. The boundary integration gate needs a tick into the boundary to scope its verdict (no more locks from a stale failure in another sprint).

**Second review pass (also in 4.3.0).** `risk score` no longer reports `churn=high` for a docs-only or tests-only change (an empty pathspec made `git log` count every commit in the repo). `resolve-model --subject` counts `dispatch_attempt` events that have rotated into `events-archive/`, so the retry ladder never resets mid-sprint. `verify findings --tasks` accepts the same ids `SPRINT.md` waves carry (`T-P003`, `T-HOT1`), and a story whose remaining steps are patch tasks can complete its per-story review. The review terminal accepts a block-form `stories:`/`features:` list like every other reader. Hotfix stories (`B-HOT-###`) are stories for `story-review`, `design`, `tracker ack` and `route --story` too (one `isStoryId` in `vocab.mjs`). `design approve|check` read and write CRLF story files correctly. `archive-sprint` parses the event history once.

**Web adapter only, and it uses your Playwright.** `ui.adapter: web` drives the Playwright already in your project (`node_modules/playwright[-core]`), or the directory in `ui.playwright_root`; the plugin downloads nothing. `ui.adapter: none` (the default) skips every UI stage with one line. An Android adapter is planned, not shipped.

## 4.1.0 → 4.2.0

Non-breaking. No action is required; the notes below describe behavior you will notice.

**A business risk profile, captured when first needed.** The first `/ship-sprint` in a project asks (at most three questions) what must never happen — "a user is charged twice" — with a severity and the areas it lives in, and records it with `shipyard-data risk profile add-harm` into `risk-profile.json` (CLI-owned). "Floors only" is a valid answer: with or without a profile, baseline floors treat auth, secrets, migrations and payments paths as high risk and deploy/dependency-manifest changes as medium.

**Reviews are sized by a CLI risk score.** `shipyard-data risk score` reads the diff from git (size, missing tests, churn, AC markers) and the profile, combines every signal by MAX over the whole story or sprint range, and returns `low|medium|high|critical`. The per-story review (`/ship-execute` item 3b) and the sprint scanners use it as the review effort floor; `critical` adds a human gate (the verdict needs your confirmation) and `risk.max_critical_per_sprint` (default 3) caps critical reviews per sprint — `--cap` refuses past it. `shipyard-data risk drift` lists risky-looking files no harm covers, for the retro.

**Rules-first model routing.** `shipyard-data route` picks a tier and effort from a step's kind, effort and latest risk level (a risk level or a role only raises; a missing kind/effort falls back one tier up; an unscored risk counts as medium). `resolve-model <role> --subject <step>` consults it by default (`routing.rules: true`) and prints `routed=<tier>:<effort>`; set `routing.rules: false` to keep the static tiers and `agent_effort` exactly as before. On the labeled set of 153 past steps nothing moved up and 57 moved to a cheaper effort.

**Haiku as an intake escalator (opt-in).** `routing.haiku_router: true` lets `/ship-discuss` consult a Haiku `claude -p` run when its own classification sits in the ambiguous middle; Haiku can raise ambiguity, risk or urgency, never lower them. It spends your own quota (~$0.01, ~5 s per consult) and is logged.

## 4.0.0 → 4.1.0

Non-breaking. No action is required; the notes below describe behavior you will notice.

**Per-story review happens inside the sprint.** When a story's last step merges at a wave boundary, `/ship-execute` runs spec review and gap analysis for that story (sequential, no builders running) and records the verdict with `shipyard-data story-review record`. A `changes` verdict settles only after its findings are routed (`story-review disposition`). The execute terminal gate, sprint-complete invariant 9 and `/ship-review` all read the same rule, so the sprint review no longer repeats per-story findings — it keeps the cross-story checks, the full build, the demo and the retro. Set `execution.story_review: false` to restore the sprint-end-only review. `shipyard-data story-review check` lists every sprint story with its steps, verdict and settled state.

**Claude Code's built-in `code-review` skill as a scanner (opt-in).** `review.code_review: off|low|medium|high` (default `off`) adds the built-in review to the Stage 0a scanner wave through the Skill tool. `ultra` and `max` are refused (`shipyard-data doctor` reports them): they start many cloud reviewers and are the user's call, never the pipeline's. Findings take the normal `review plan` path; `--fix` is never used.

**Read-only review fan-out as a Workflow (opt-in).** `review.workflow: true` (default `false`) runs the scanner wave and the per-story review pair through the `Workflow` tool instead of one `Agent` call each. The CLI stays the ledger (every result is recorded the moment it returns) and the plain dispatch is the fallback whenever the tool is missing or refuses. Builders never run in a workflow.

**Deferred on evidence.** `shipyard-data report stages` over this project's finished sprints is **undecided** (two of three sprints have execute data; median boundary share 32% against a provisional 25% bar), so the wave-overlap work (pipelined boundaries, small PRs per slice) stays deferred until a third sprint with execute data is archived. Re-run the report after your next sprint.

## 3.x → 4.0 (breaking: one vocabulary, one front door)

Run `shipyard-data migrate --dry-run`, read the plan, then `shipyard-data migrate`. It is idempotent and `shipyard-data migrate --reverse` restores the original tree byte for byte (the journal is `spec/.migration-v4.json`). Nothing is rewritten in the event log.

**Vocabulary.** idea → epic → **story** (`type: feature | bug`) → **task** (enabling work: spike, unblocker, study, debug, chore) → hidden **step** (the TDD builder unit `/ship-sprint` creates). Ids: stories `S###` (legacy `F###`/`B###` files stay where they are and resolve as aliases), steps `P###` (migrate renames pre-v4 builder `T###` records and records `aliases:`), tasks `T###`. Directories: `spec/stories/` and `spec/steps/` are written; `spec/features/`, `spec/bugs/`, pre-v4 `spec/tasks/` are read. CLI: `shipyard-data story …` (`feature`/`bug` accepted), `step …` (`task …` on a pre-v4 builder record still works), `task …` (new entity), `epic set-status`, `idea set-status … promoted --to <S###|E###>` (`graduated` accepted). Idea statuses: captured | assessing | promoted | rejected | parked. Epic statuses: decided | refined | in-progress | done. Events: writers emit `patch_step_created`, `story_*`, `story_created`; readers accept the old names, so old logs stay valid. A lint (`tests/test_retired_terms.mjs`) keeps retired terms out of shipped skills.

**One front door.** `/ship-quick` and `/ship-bug` are removed. Describe anything to `/ship-discuss`: a deterministic ceremony ladder (`shipyard-data route-intake`) proposes **capture** (an idea), **refine** (a story with acceptance criteria), **land-now** (a `T###` task built by `/ship-execute --task T###` with the quick-task guarantees: baseline green, test first, no test edits during refactor, one `chore()/fix()` commit, escalation back to discuss when it outgrows the lane) or **hotfix** (`--hotfix` → a `type: bug, lane: hotfix` story and a debug session, then `/ship-execute --hotfix S###`); you confirm in one keypress and every routing decision is logged. Capture and hotfix never wait on the planning lock. Bugs are first-class stories: reproduction, expected vs actual, environment, severity, a failing test as the first acceptance criterion, points and backlog presence; an unknown root cause attaches a `kind: debug` task that blocks the story through `dependencies:`. Concrete defects found in review become bug stories or tasks, never ideas.

**Chained discuss and tracker pull.** `/ship-discuss --chain <ids>` (or "all" in triage) refines a CLI-owned queue (`shipyard-data discuss-queue`) one item at a time with only the queue state and a short decisions-so-far note as context; a dead session resumes where it stopped. `/ship-discuss --pull "<JQL>"|my-sprint` imports tickets as unrefined stories (`shipyard-data tracker pull`); Jira keeps status and assignee under `upstream:`, Shipyard owns the refined spec, write-back is opt-in per action, ticket text is data, and an unrefined story cannot be approved until `/ship-discuss` refines it.

**Removed:** `/ship-quick`, `/ship-bug`, `shipyard-context quick-task|bug-context`, the `quick-tasks` list kind, `Q-NNN` ids (migrated to `T###`), `B-HOT-NNN` ids (migrated to `S###` with `lane: hotfix`).

## 3.26.0 → 3.27.0

Non-breaking. No action is required; the notes below describe behavior you will notice.

**Planner numbers come from the CLI.** `/ship-sprint` now calls `shipyard-data capacity` for capacity (mean of the last 3 *finished* sprints), the fit of a planned total ("13 pts fits at 67% — 2 of the last 3 finished sprints delivered at least 13 pts"), and a calibration line that always accompanies a fit. Below 3 finished sprints you get the honest range and no percentage. New optional flags `/ship-sprint --hours <n>` and `--until <time>` convert a time budget to points **only** through a measured points-per-hour rate; with none, the planner says so and plans by points. You may seed your own observed rate with `execution.assumed_points_per_hour` (off by default, labeled "not measured" wherever it is used; a measured rate overrides it; junk values are reported by `shipyard-data doctor`).

**Throughput has one writer.** `shipyard-data archive-sprint` now records `throughput.recent` (points per hour = delivered points / active hours from the event log) for every completed sprint that has builder claim/completion events. `shipyard-data metrics record-retro` **refuses** a `throughput=` field (exit 2) — drop it from any custom retro command. The retro still *displays* its wall-clock figure.

**The wave boundary cannot be left after a failed integration gate.** `cursor advance execute wave_N_build` is refused (exit 3, `--force` included) while the latest `wave_integration_*` event in that boundary is `wave_integration_failed`. Integrate or anchor the named branches and re-run `shipyard-data verify-wave-integrated`; its `wave_integration_verified` clears the gate.

**Ids never collide with the archive.** `shipyard-data next-id` also scans `spec/archive/<kind>/`, so a stale counter can no longer re-issue a task id that lives in an archived task file.

**Fresh projects get a backlog index.** Onboarding seeds `backlog/BACKLOG.md`, so the first `backlog add` works. `shipyard-data doctor` no longer flags `epic: ""` (the documented "no epic" state).

**Removed:** the hidden, flag-gated stepwise prototype (`shipyard-context next`, `shipyard-data cursor step`, the `step` cursor field) after its spike ended NO-GO.

**New report:** `shipyard-data report stages` prints each stage class's share of active time per finished sprint, the median, silent time by class, and the v4.1 overlap decision rule.

**Versioned `claude-*` model ids removed.** The Agent tool's `model` parameter accepts only `fable|opus|sonnet|haiku`, so a `claude-*` id reaching a dispatch failed at runtime. `shipyard-data config set-model` now rejects `claude-*` values (exit 2) and `/ship-discuss --think` ignores them. A `claude-*` value already in `config.md` still works: `resolve-model` maps it to its family tier (`claude-opus-*` to `opus`, `claude-sonnet-*` to `sonnet`, `claude-haiku-*` to `haiku`, `claude-fable-*` to `fable`; any other `claude-*` is treated as unset and inherits the session model), and `shipyard-data doctor` prints a `warning:` naming the key. Fix it with `shipyard-data config set-model <think|build|light|orchestrate> <fable|opus|sonnet|haiku|inherit>`.

**Terminal gate reads `features:` tolerantly (GH #6).** The review terminal gate now parses SPRINT.md `features:` with the shared list helper, so quoted ids (`features: ["F003"]`) resolve to `F003` instead of looking up `verify/"F003"-verdict.md`. It is also stricter in two cases: a `features:` list that parses to **zero ids** and a YAML **block list** (`- F001` lines) now DENY `terminal_approved`, naming the raw value. Use the inline form `features: [F001, F002]`.

