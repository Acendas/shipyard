```
                                                               
                                                            _T_
                                                      ______|░|___
  _T_                                                /      |░|   \
__|░|_________                                    |░|░|     |░|    |
  |░|         \                                   |░|░|     |░| ██████╗
  |░|          |                                            |░| ██╔══██╗
  |░|          &                                            |░| ██║  ██║
  |░| ███████╗██╗  ██╗██╗██████╗ ░░╗   ░░╗  █████╗ ██████╗  |░| ██║  ██║
  |░| ██╔════╝██║  ██║██║██╔══██╗╚░░╗ ░░╔╝ ██╔══██╗██╔══██╗ |░| ██████╔╝
  |░| ███████╗███████║██║██████╔╝ ╚░░░░╔╝  ███████║██████╔╝ |░| ╚═════╝
  |░| ╚════██║██╔══██║██║██╔═══╝   ╚░░╔╝   ██╔══██║██╔══██╗ |░|
  |░| ███████║██║  ██║██║██║        ░░║    ██║  ██║██║  ██║ |░|
  |░| ╚══════╝╚═╝  ╚═╝╚═╝╚═╝        ╚═╝    ╚═╝  ╚═╝╚═╝  ╚═╝ |░|
░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

<div align="center">

<h1>Shipyard</h1>

<p><strong>From an idea to tested code, in four commands, inside Claude Code.</strong></p>

<p>
  <a href="https://github.com/acendas/shipyard/releases"><img src="https://img.shields.io/github/v/release/acendas/shipyard?style=flat-square&color=blue" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/acendas/shipyard?style=flat-square" alt="License"></a>
  <a href="https://github.com/acendas/shipyard/issues"><img src="https://img.shields.io/github/issues/acendas/shipyard?style=flat-square" alt="Issues"></a>
</p>
</div>

---

## Stop babysitting your AI.

You paste requirements into a chat window. You explain the project again every session. You check by hand whether the AI built what you asked. You debug code that passed the AI's own tests. A session dies and the work goes with it.

**That is not AI-assisted development. That is you managing a junior developer with amnesia.**

Shipyard is an engineering team that lives inside [Claude Code](https://docs.anthropic.com/en/docs/claude-code): a planner, builders, reviewers and a critic, held to written rules by a command-line tool that refuses shortcuts. You say what you want. Shipyard turns it into checks, plans the work so as much as possible runs at the same time, builds it test-first without asking you anything, has a different agent review the result, and hands you the evidence.

**You decide. Shipyard plans, builds and proves. You accept.**

## Why Shipyard

<table>
<tr>
<td width="50%" valign="top">

### Without Shipyard

- One agent plans, builds and marks its own homework
- The spec is a document nobody opens again
- You are interrupted all day with questions
- "It works" means the AI said so
- A crashed session means starting over
- The rules live in a prompt, and prompts get ignored

</td>
<td width="50%" valign="top">

### With Shipyard

- Separate agents build, review and criticise. A builder never approves its own work
- Every acceptance scenario has an id, a test that carries it, and a check that both exist
- You are needed at the start and at the end. The build in between asks nothing
- "It works" means a check that failed before the work now passes, and a reviewer compared the result with the spec
- Work is committed step by step. A new session carries on where the old one stopped
- The rules are code. A command-line tool and hooks refuse the shortcut

</td>
</tr>
</table>

### What you get in 4.0

| | |
|---|---|
| **Questions that do not block** | Research runs in the background. Its questions reach you one card at a time, and it keeps working while you think |
| **Plans built for speed** | Every plan is scored for parallel work. Up to 100 agents run at once |
| **A build you can walk away from** | No questions after the start. Every decision made for you is written down for the review |
| **Checks that mean something** | A step's check must fail before the work is done, so passing it afterwards proves something |
| **Tests that do not slow you down** | A test run that passed on this exact code is evidence and is not run again. After a fix only the failed tests rerun. Shipyard checks your test setup at the start of every plan and sets up what is missing |
| **A review you can trust** | One document in twelve sections: what you can do now, the evidence, what was not done, what went badly. Shown whole |
| **The right model for the job** | Small steps on the fast model, reasoning on the middle one, hard work on the strongest |

Shipyard holds itself to the same standard: its rules are covered by more than 950 Node tests, 500 Python tests and 5,000 checks on its own instructions.

## What Shipyard is

Shipyard is a plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). You say what you want and accept the result. In between, Shipyard writes down what was agreed, plans the work, builds it with tests first, and checks it.

```
  you decide                                               you accept
      │                                                        ▲
      ▼                                                        │
┌───────────┐    ┌───────────┐    ┌──────────────┐    ┌───────────┐
│  DISCUSS  │───►│   PLAN    │───►│    BUILD     │───►│  REVIEW   │
│ what and  │    │ steps, in │    │ tests first, │    │ evidence, │
│ why       │    │ waves     │    │ no questions │    │ one answer│
└───────────┘    └───────────┘    └──────────────┘    └───────────┘
/ship-discuss    /ship-sprint     /ship-execute       /ship-review
      ▲                                                    │
      └────── next idea, unfinished work, lessons ◄────────┘
```

Words used on this page:

| Word | Meaning |
|---|---|
| Story | One thing the product should do (or one bug to fix), with the checks that prove it. Id `S001` |
| Backlog | The ordered list of approved stories waiting to be built |
| Sprint | A batch of stories planned and built together |
| Step | One small piece of a story that one builder finishes. Id `P001` |
| Wave | The steps of a sprint that can be built at the same time |
| Agent | A separate Claude helper with one job: build a step, review a story, research a question |
| CLI | A command-line program. Shipyard's is `shipyard-data`; it owns the records and enforces the rules |
| Hook | A small program Claude Code runs before an action. It can refuse the action |

## Install and first run

```
/plugin marketplace add Acendas/acendas-marketplace
/plugin install shipyard@acendas
```

Outside a session the same two commands start with `claude plugin …`. The [Acendas marketplace](https://github.com/Acendas/acendas-marketplace) pins Shipyard to a version tag. To pick up a new release, run `/plugin marketplace update`, install again, and restart open Claude Code sessions.

Then open your project and type:

```
/ship-status
```

The first run sets the project up (`shipyard-data onboarding bootstrap`) and shows a dashboard with the next command to run. There is no separate init command.

Coming from 3.x? Read [UPGRADING.md](UPGRADING.md) first.

## The workflow

### 1. `/ship-discuss`: say what you want

```
/ship-discuss let people reset their password by email
```

| You do | Shipyard does | You get |
|---|---|---|
| Describe an idea, a bug or a small change in your own words | Proposes how much process it needs (a "lane"). You confirm with one key. For a story it researches in the background and asks its questions one card at a time, each under a short explanation | A written story with scenarios (Given, When, Then), shown word for word before you approve it |

| Lane | For | What happens next |
|---|---|---|
| Capture | A thought to keep | Saved as an idea (`IDEA-001`). Nothing is built |
| Refine | Real work | A story with acceptance scenarios, approved by you, added to the backlog |
| Land now | A tiny, clear change | A task (`T001`) you build at once with `/ship-execute --task T001` |
| Hotfix | A production bug | A bug story you fix at once with `/ship-execute --hotfix S001` |

A story that changes a screen also gets a design: you sign it off, or waive it with a reason, before the story can be approved. A discussion writes specifications. It does not edit your code.

Useful forms: `/ship-discuss S001` (refine a story), `--idea <text>` (save and stop), `--chain <ids>` (several in a row), `--pull "<JQL>"` (import tickets from your tracker), or an issue key such as `SYS-123`.

**Releases and big requests.** A release is a *fix version*, not an epic: `shipyard-data version add v4.2.0 --date 2027-01-15`, and every epic, story, task and idea can say which release it is expected to ship in. Hand `/ship-discuss` a tracker export or a list of tickets and each coarse one comes in as an idea that keeps its link; the ones near the top are promoted to epics and broken down into spikes and stories, the rest stay coarse until they are next. `shipyard-data version show v4.2.0` shows what is in a release, what is done, and what still has to be checked by a person before it ships.

### 2. `/ship-sprint`: plan the work

| You do | Shipyard does | You get |
|---|---|---|
| Pick the stories, or accept the suggestion. Approve the plan once | Brings forward unfinished work. Splits stories into steps and puts each step in the earliest wave it can run in. Scores the plan. Runs every step's check on today's code | A plan with waves, a score, and one line that says what the sprint needs from you |

The score is printed by `shipyard-data sprint plan-score`. Example output:

```
plan score: 9 steps in 3 waves · widest wave 6 · longest chain 3 (P001 → P004 → P009)
  wave  1 ██████ 6
  wave  2 ██ 2
  wave  3 █ 1
```

A story cannot enter the sprint while the score reports a problem: a step placed later than it needs to be, or two steps of one wave changing the same file. A step's check must also fail before the work is done (`shipyard-data sprint probes-at-base`); a check that already passes proves nothing.

Other forms: `--hours <n>` or `--until <time>` (plan to a time budget), `--cancel`. While a sprint is running, `/ship-sprint` can draft the next one without touching it.

### 3. `/ship-execute`: build it

| You do | Shipyard does | You get |
|---|---|---|
| Start it. Type `pause` if you want it to stop cleanly | Gives each step to a builder agent in its own copy of the code (a git worktree). The builder writes a failing test, then the code. When a story's last step is merged, the story is checked against its scenarios (spec review), for what is missing (gap analysis) and for code problems (code review). Findings are fixed in the same sprint | Commits on the branch you started from, and a log of every decision made for you |

It reports once per stage or wave, in one line:

```
Wave 2 merged  [████████░░░░] 6/9 steps · you: not needed until the review (3 checks)
```

After the readiness check at the start, the build asks nothing. Where it would have asked, it works down a written ladder and records the outcome:

```
already decided in the plan → a written rule → quick choice (light model)
   → one consult (think model) → Claude Code's advisor, if you turned it on → park the step, carry on
```

If the session dies, run `/ship-execute` again. It first saves any work left in builder worktrees, then continues.

### 4. `/ship-review`: accept the sprint

| You do | Shipyard does | You get |
|---|---|---|
| Read one document. Do the checks that need a person. Answer one question: accept or not | Writes the sprint review and shows it whole. After you accept: a retrospective, a changelog you approve, and the sprint is archived and its branches cleaned up | `CHANGELOG.md` in your project, finished stories, and a clean start for the next sprint |

The review always has the same twelve sections: goal and outcome · what you can do now · evidence, before and after · quality work during the sprint · decisions made without asking · numbers · not done · found but not done · not verified, risks and debt · what went well and what did not · what to improve · next.

Shipyard does not push, create git tags or publish a release. You do that when you are ready.

### The other commands

| Command | You do | Shipyard does | You get |
|---|---|---|---|
| `/ship-backlog` | Look at what is waiting; say what matters | Shows the running sprint, the backlog, proposed stories and ideas, ranked by RICE (reach × impact × confidence ÷ effort) | An ordered backlog. Options: `groom`, `rank`, `approve`, `bankruptcy` |
| `/ship-spec` | Browse or search what was agreed | Shows epics (groups of stories), stories and progress. `absorb` pulls one of your documents in as a reference; `sync` writes outcomes back to your documents | One place to read the specification |
| `/ship-status` | Ask where things stand | Checks the records, repairs what it safely can, shows the dashboard | Progress and the next command to run |
| `/ship-debug` | Describe a problem | Investigates step by step and keeps its notes in a file, so nothing is lost when the conversation is cleared. `--resume` continues | A cause, a fix plan you approve, and a verified fix |
| `/ship-help` | Ask a question, or ask for a change ("set the build model to opus") | Answers from your project's state, or makes the change through the CLI | An answer, or a confirmed change |

## When it needs you

At the start and at the end. Never in the middle.

```
        START                         MIDDLE                        END
 ┌────────────────────┐      ┌────────────────────┐      ┌────────────────────┐
 │ decisions          │      │ nothing            │      │ looks and checks,  │
 │ spikes and tests   │ ───► │ the build decides  │ ───► │ in one sitting     │
 │ whose result       │      │ and writes down    │      │ accept the sprint  │
 │ changes the plan   │      │ why                │      │                    │
 └────────────────────┘      └────────────────────┘      └────────────────────┘
```

| Moment | Example | Where you see it |
|---|---|---|
| Start | "Try the two payment providers and say which one we use" (a spike: a short trial whose result changes what gets built) | The plan: `you: 2 things at the start (about 10 min): … · 3 checks at the end` |
| Middle | Nothing. A question here is denied by a hook | The progress line: `you: not needed until the review (3 checks)` |
| End | "Look at the new screen on your phone" | The review lists the waiting checks grouped by where you do them |

If you cannot do the start items when the sprint starts, the stories that depend on them leave the sprint; they do not stop halfway. A check done by a person is recorded only from that person's answer; accepting the sprint does not confirm it. `shipyard-data sprint needs-you` prints the current line.

## What is new in 4.0.3

A patch release from the first day of 4.0.2 on two real projects. No migration is needed.

| Area | What changed |
|---|---|
| Sending tickets | After "send all now" the sends go through. The preview table may be worded the session's way, as long as each record was listed and named. A new bug is called a Bug |
| Drafts | A discussion may write drafts in its own scratch folder. Only the project's folder and its repository are off limits |
| Old windows | A window opened before an update says so and stops, when a newer version has since worked on the project. Start a new window |
| Refining | `shipyard-data story refine` rewrites a coarse story in one call and marks it refined |
| Releases | A story split from another takes its release (`story add --version`, or the release of what it waits for). `version show` ends with what a sprint can take and what it leaves out, with the reason |
| Scores | `rice_confidence` above 1 is read as a percentage |
| Approval | Every story approved in a discussion owes the sources record, with or without its own question list |
| Pausing | `shipyard-data lock release discuss --pause` frees a discussion that is waiting for an answer; what it owes passes to the next one |
| Merged tickets | A ticket merged into another story stays on the tracker plan and follows that story |
| Resumed sprints | A sprint resumed after a pause is built under its lock again, so the agent list, the model check and the question hold keep working |
| Builders | A builder runs every command in the foreground. It can no longer return while its own test run is still going |

## What is new in 4.0.2

A patch release from the first full discussion run on 4.0.1. No migration is needed.

| Area | What changed |
|---|---|
| Held questions | When a question or a ticket update is held back, you see one short line, not a block of instructions. A question whose explanation was already on screen is not explained twice |
| Ticket texts | Descriptions for the tracker are previewed as a short table (ticket, record, what is sent, where the full text is) with one question, in place of every text pasted into the chat |
| Tickets | A record's own ticket is a separate `ticket:` field. A ticket it only mentions (its epic's, a related one, one in another project) is never written to |
| Breaking down | `shipyard-data story add` and `shipyard-data task add` write a coarse story or a spike in one call. `/ship-discuss --chain` takes epics |
| Tracker plan | `shipyard-data tracker hold` keeps records you do not want tickets for off the list until you say otherwise |
| Releases | `v4.2`, `4.2` and `v4.2.0` are one release. `version rename <a> <b> --merge` folds two versions; `version remove` deletes an empty one |
| Health check | No longer asks every story for score fields |
| Worktrees | Shipyard only claims worktrees made while a sprint is building. Your own are left alone |

## What is new in 4.0.1

A patch release from running 4.0.0 on real projects. No migration is needed.

| Area | What changed |
|---|---|
| Questions | Every question card now comes after its own short explanation (a summary and a table or example). Acceptance criteria are shown one plain line each, not as Given/When/Then |
| Releases | A release is a *fix version* (`shipyard-data version …`), not an epic. Epics, stories, tasks and ideas can each say which release they are expected to ship in |
| Backlog | One list in your order: `shipyard-data backlog move <id> --top --why "<what a delay costs>"`. Nothing re-sorts it by score behind you |
| Trackers | Tickets come in by type (an epic as an idea, a story or bug as a story, a task as a task), each keeping its link. Shipyard tells you when new work has no ticket, offers to create it, and asks to sync when a discussion, a sprint plan or a sprint review ends. `tracker_sync: ask \| auto \| off` |
| Research | Discussion research searches your connected wiki, tracker and shared drive before the web, records where it looked, and asks once whether a document exists that it could not reach |
| Sprint review | Asks whether the sprint does what you wanted and whether that changes what comes next, in place of "accept" |
| Fixes | A discussion no longer stops halfway; `/clear` no longer leaves a lock behind; a story imported from a tracker keeps its own status; `/ship-backlog` always shows the board |

The full list is in [docs/milestones-4.0.md](docs/milestones-4.0.md).

## What is new in 4.0.0

4.0.0 is the first release after 3.26.0 and has breaking changes. Read [UPGRADING.md](UPGRADING.md) and run `shipyard-data migrate --dry-run`, then `shipyard-data migrate`. `shipyard-data migrate --reverse` undoes it. The history behind each change is in [docs/milestones-4.0.md](docs/milestones-4.0.md).

| Change | What you notice |
|---|---|
| New words | "Features" and "bugs" are now **stories** (`S001`); the builder's units are **steps** (`P001`). Old ids still work |
| One front door | `/ship-quick` and `/ship-bug` are gone. Everything starts at `/ship-discuss` |
| Questions arrive as they come up | One card at a time while research keeps running in the background. Approval is always the last card |
| A plan scored for parallel work | `shipyard-data sprint plan-score` shows waves, the widest wave and the longest chain, and blocks a plan that is slower than it has to be |
| Up to 100 agents at once | `execution.max_agents` (default 100) counts every helper alive; a hook refuses one more. It replaces the old limit of 3 builders |
| Checks that must fail first | Each step's check is run on today's code before the sprint starts |
| Unattended build, quality work inside it | No questions mid-sprint. Reviews and their fixes happen per story during the build; the next wave starts as soon as the previous one is merged |
| A review document shown whole | Twelve sections written by the CLI, then one acceptance question |
| Three model speeds | Small steps on the light model, steps that need reasoning on the build model, hard work on the think model. A failed step climbs one level |
| Behaviour-first tests | One scenario per criterion, written from what a user can observe. A test through the real code is the default. Scenario ids are checked against tests in both directions |
| Design sign-off for screens | The delivered screen is compared with the design you approved |
| Commands side by side | A lock only stops a second copy of the same command. You can discuss, or draft the next sprint, while one is being built |
| Cleanup after a sprint | Shipyard's branches and finished worktrees are removed, and stale records repaired (`shipyard-data reconcile`). A dead session no longer blocks the next one |
| A person at the start or the end | See [When it needs you](#when-it-needs-you). A check you leave open stays listed after the sprint is archived (`shipyard-data sprint needs-you`) and is recorded from your own words (`sprint person-check`) |
| Evidence instead of a second run | Every passing build or test run is recorded as proof of that command on that code. A test tier already proven is not run again, a fix is confirmed with the failed tests only, and a wave made only of fix steps skips its own build and test run |
| Test setup done for you | `shipyard-data infra check` reports four things (a test command, one run listing every failure, a failed-only run, an affected-tests run) and the measured time of your suite. `infra apply` sets what your test tool supports and files one small task for the rest |
| What tests cost, in the review | Count, clock time, share of the sprint and the three longest runs |
| Urgent fixes | A bug you report can be built at once with `/ship-execute --hotfix`, test first, without touching the running sprint |
| Plain language | A short summary first, then a picture or an example. One question per card |

## All commands

| Command | What it does | Options |
|---|---|---|
| `/ship-discuss` | Takes in any new work: capture, refine, land now, hotfix | `[topic]`, `S###`, `E###`, `IDEA-###`, issue key, `--idea`, `--hotfix`, `--chain`, `--pull`, `--think <model>` |
| `/ship-backlog` | Shows and orders what is waiting | `groom`, `rank`, `approve`, `bankruptcy` |
| `/ship-sprint` | Plans a sprint, or cancels the active one | `--cancel`, `--hours <n>`, `--until <time>` |
| `/ship-execute` | Builds the sprint, test first, in waves | `--task <id>`, `--hotfix <id>`, `--mode solo\|task\|track`, `--isolation true\|false` |
| `/ship-review` | Sprint review, retrospective, changelog, archive | `[story id]`, `--demo`, `--hotfix <id>`, `--retro-only`, `--skip-retro` |
| `/ship-status` | Dashboard and next step. Sets a project up on first run | `sprint`, `backlog`, `health`, `spec`, `diagnose` |
| `/ship-spec` | Browse, search and manage the specification | `[id]`, `[search term]`, `ideas`, `absorb`, `sync` |
| `/ship-debug` | Debugging that keeps its notes between sessions | `[problem]`, `--resume` |
| `/ship-help` | Answers questions and makes small changes for you | `[question or request]` |

## Settings

Settings live in `config.md` in the project's data folder. The file is created with the defaults below. Ask `/ship-help` to change one, or ask Claude to run the CLI command shown.

| Setting | Default | Meaning |
|---|---|---|
| `test_commands.unit` / `integration` / `e2e` | empty, or what setup detected | The commands that run your tests. Set with `shipyard-data config set test-commands-unit "<command>"` |
| `models.think` / `build` / `light` | `opus` / `sonnet` / `haiku` | The model for hard work, for reasoning, and for small steps. A project created before 4.0.0 has no `light` until you set it: `shipyard-data config set-model light haiku` |
| `models.orchestrate` | `opus` | The model that runs the four main commands |
| `routing.size_tiers` | `S=light,M=build,L=think,XL=think` | Which model a step gets, by its size |
| `execution.max_agents` | 100 | Most agents alive at once. `shipyard-data config set-max-agents <n>` |
| `execution.isolation` | `worktree` | `worktree`: builders work in separate copies, in parallel. `none`: one at a time, in place. `shipyard-data config set-isolation <worktree\|none>` |
| `execution.parallel_plan` | true | A story cannot enter a sprint while the plan score reports a problem |
| `execution.probe_must_fail_first` | true | A step's check must fail on today's code |
| `execution.unattended` | true | The build does not ask questions mid-sprint |
| `execution.overlap_waves` | true | The next wave starts as soon as the previous one is merged |
| `execution.story_review` / `code_review` | true / true | Each story is reviewed, code review included, during the build |
| `execution.design_review` | true | A screen story is reviewed only after its screen was compared with the design |
| `execution.enforce_ac_coverage` | true | A sprint cannot complete while a tagged scenario has no `AC-<n>` marker in the sprint's changes, or a changed test names no scenario |
| `execution.max_parked_ratio` | 0.34 | Largest share of a sprint's steps that may be set aside before the sprint needs your explicit acceptance |
| `execution.max_undispositioned_ideas` | 12 | Once this many ideas are waiting for a decision, a new sprint waits until you groom the backlog |
| `execution.default_capacity` | 20 | Story points assumed for the first sprint, before there is history |
| `execution.sweep_branches` | true | Remove Shipyard's branches when a sprint is archived |
| `spec.behaviour_first` | true | Scenario rules are checked when a story is approved |
| `review.code_review` | `off` | Also run Claude Code's built-in code review during `/ship-review`: `off`, `low`, `medium`, `high` |
| `ui.adapter` | `none` | How screens are rendered for checking. `web` uses the Playwright already in your project; `frames` runs your own command (`ui.frame_command`) |
| `quality_gates.standing` | empty | Checks applied to every sprint, in your words |
| `discuss_writable` | empty | Project documents a discussion may write, for example your decision record |
| `test_commands.scoped` / `rerun_failed` | empty, or what `infra apply` set | Run only the tests a change can affect; run only the tests that failed last time |
| `verify_ignore` | empty | Paths that cannot change a test result (a changelog). A commit touching only these keeps a test proof fresh |
| `execution.patch_wave_tests` | `sprint` | A wave made only of fix steps skips its own build and test run; `wave` runs them every time |

The full list, with comments, is the template: [config.md](plugins/shipyard/project-files/templates/config.md).

## Safety

Shipyard does not rely on a model remembering a rule. The rules that matter are checked by the CLI or by a hook, and the action is refused.

| What is refused | Why |
|---|---|
| Claude editing Shipyard's state by hand (progress, sprint and story headers, locks) | One writer keeps the records and the event log in agreement |
| A question in the middle of a build | You may not be there. A mid-build question means planning left a gap |
| A question card with two questions, or a long one | The explanation belongs in the chat, where it can be read |
| A discussion editing project files, apart from the project's rule files and documents you list in `discuss_writable` | A discussion decides; building happens in a sprint or a task |
| Approving a story with a scenario that has no id, no level tag, or no place in the story's path map | Every promised behaviour needs one named check |
| Approving a screen story with no design decision | The design is decided before the work is planned |
| A story entering a sprint with a plan problem, or a step whose check already passes | Slower than needed, or a check that proves nothing |
| Starting an agent past the limit, or a builder on the wrong model | The limit and the routing are enforced when the agent starts |
| Leaving a wave whose work is not all merged, or whose findings are undecided | Unmerged work and unanswered findings get lost |
| Completing a sprint with too many steps set aside, a scenario with no test, or a story with no settled review | A sprint cannot reach "done" by putting work aside |
| Recording a person's check without that person's answer | Accepting a sprint is not the same as having looked |
| Showing a review with a section missing | You should see what went badly, not only what went well |
| Deleting a change nobody committed | Shipyard cannot prove it is not yours. It is set aside in a git stash (`shipyard-data stray set-aside`) |
| A second copy of the same command | Two planners or two builds would write the same files |
| Migrating while a sprint is in progress | The sprint's evidence uses the old ids |
| Pushing, tagging, or `git add -A` on your project (Shipyard never does these) | Your history and your releases are yours |

## How it is built

Shipyard uses Claude Code's own building blocks. There is no server and no database: the records are Markdown and JSON files.

```
you ──► command (skill) ──► agents do the work
              │                   │
              ▼                   ▼
        shipyard-data CLI ◄── results are checked here, not taken on trust
              │
              ▼
        data folder (outside your project)        hooks watch edits, questions and agents
```

| Part | Count | What it is |
|---|---|---|
| Skills | 30 | 9 commands you type (`ship-*`) and 21 internal ones the commands follow, such as `tdd-cycle` and `verifying-wave-completion` |
| Agents | 7 | Helpers with one job each. First table below |
| Hooks | 6 | Programs that can refuse an action. Second table below |
| CLIs | 3 | `shipyard-data` (records and gates), `shipyard-context` (reads for the commands), `shipyard-logcap` (captures the output of a long run) |
| Rules | 4 | Short texts on asking questions, the data model, next-step hints and spec format. They stay in the plugin |
| Workflows | 2 | `review-scan` and `story-review`: optional, read-only review runs, off unless `review.workflow` is true |

Shipyard ships 7 registered agents. Each is started through an internal skill that hands over the brief and checks what comes back.

| Agent | Job |
|---|---|
| `shipyard-disciplined-builder` | Builds one step: failing test, code, check, commit |
| `shipyard-spec-reviewer`, `shipyard-code-reviewer`, `shipyard-gap-analyst` | Read-only reviewers: scenarios against code and tests; security, bugs and silent failures in the change; what is still missing |
| `shipyard-researcher` | Investigates one question and writes one findings document |
| `shipyard-operational-task` | Runs a build, test or lint command until it passes |
| `shipyard-track-coordinator` | Runs one story's steps in order inside a wave |

| Hook | Runs | What it does |
|---|---|---|
| `plugin-data-breadcrumb` | When a session starts | Notes where the data folder is, so every command finds it |
| `auto-approve-data` | Before Claude edits or writes a file | Lets writes to the data folder through without a prompt; refuses hand-edits to CLI-owned state; keeps a discussion out of project files |
| `unattended-ask` | Before Claude asks a question | Refuses a question mid-build, a card with more than one question, and a question with no summary and picture written above it |
| `ask-after-explain` | When Claude ends its turn | After an explanation that ends with "Question follows.", hands the turn back so the question card comes next. Also hands a discussion back once when it stops halfway |
| `builder-foreground` | Before a shell command | Inside the builder agent, refuses a command started in the background: a builder has no tool to wait for it or stop it, and one left running keeps the agent listed after it returns. Silent for every other command |
| `tracker-write` | Before a comment, ticket or page is written through a connector | Inside a Shipyard command, holds the write until the person has seen it: a short text shown word for word in the chat, or a ticket text listed in the outbox table (`shipyard-data tracker outbox`) that the person has answered |
| `source-ledger` | After a connector or web tool runs | During a discussion, counts which kinds of source were read (wiki, tracker, shared drive, web); the tool's name only, never what was asked or returned |
| `agent-ledger` | Before an agent is started or stopped | Keeps the list of live agents; enforces the agent limit and the routed model |
| `worktree-branch` | When a worktree is created | Starts it from your current branch. Only a worktree made while Shipyard is building is named `shipyard/wt-*`; any other is `worktree-<name>` and Shipyard never renames, sweeps or removes it |
| `lock-reap` | When a session ends | Releases any lock the session still holds |

**The data folder.** Everything Shipyard records lives under Claude Code's plugin data folder, one folder per project. `/ship-status diagnose` prints the path. Your repository gets one link, `.shipyard`, that points there; add it to your `.gitignore`.

```
<plugin data>/projects/<hash>/
├── config.md                 settings
├── spec/
│   ├── epics/  stories/  steps/  tasks/  ideas/
│   ├── designs/              signed-off designs for screen stories
│   └── references/           documents you pulled in
├── backlog/BACKLOG.md        ordered list of story ids
├── sprints/
│   ├── current/              the sprint being built
│   └── next/                 a sprint drafted ahead
├── memory/metrics.md         velocity and points per hour
├── debug/   verify/   releases/
└── .shipyard-events.jsonl    the event log the gates read
```

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- Node.js. Shipyard's CLIs and hooks are Node programs; the project's own tests run on Node 20
- Git
- macOS or Linux. Windows wrappers (`.cmd`) are included; the automated tests run on Linux
- Optional: Playwright in your project, for `ui.adapter: web`

## Upgrading

[UPGRADING.md](UPGRADING.md) lists what changes from 3.26.0 and the migration command. [docs/milestones-4.0.md](docs/milestones-4.0.md) has the detail.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Questions and bug reports: [SUPPORT.md](SUPPORT.md). Security reports: [SECURITY.md](SECURITY.md).

## License

MIT — see [LICENSE](LICENSE).
