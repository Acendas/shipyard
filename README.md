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

<p><strong>The AI engineering org that lives inside your terminal.</strong></p>

<p>
  <a href="https://github.com/acendas/shipyard/releases"><img src="https://img.shields.io/github/v/release/acendas/shipyard?style=flat-square&color=blue" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/acendas/shipyard?style=flat-square" alt="License"></a>
  <a href="https://github.com/acendas/shipyard/issues"><img src="https://img.shields.io/github/issues/acendas/shipyard?style=flat-square" alt="Issues"></a>
</p>
</div>

---

## Stop babysitting your AI.

You're copy-pasting requirements into chat windows. You're re-explaining context every session. You're manually checking if the AI actually built what you asked for. You're debugging code that passed the AI's own "tests." You're losing work when sessions crash. You're starting from scratch every Monday.

**That's not AI-assisted development. That's you being the project manager for a junior dev with amnesia.**

Shipyard is a full engineering org — planner, builders, reviewers, critics — that runs inside Claude Code. You describe what you want. Shipyard argues about the best approach, writes a spec, plans the sprint, builds everything test-first with parallel agents, then has a *separate* agent verify the work against the spec before you even see it.

**You talk. Shipyard plans. Claude builds. You approve.**

```
┌───────┐    ┌───────┐    ┌───────┐    ┌───────┐    ┌───────┐
│ IDEA  │───►│ SPEC  │───►│ PLAN  │───►│ BUILD │───►│ SHIP  │
│       │    │       │    │       │    │       │    │       │
│  you  │    │ you + │    │ you + │    │ auto  │    │  you  │
│ talk  │    │ claude│    │ claude│    │       │    │approve│
└───────┘    └───────┘    └───────┘    └───────┘    └───────┘
/discuss     /discuss     /sprint      /execute     /review
```

Feature specs, backlog grooming, sprint planning, test-driven execution, code review, retros, and releases — all through `/ship-*` slash commands. No browser tabs. No context switching. Just you and Claude building software.

## Why Shipyard

<table>
<tr>
<td width="50%" valign="top">

### Without Shipyard

- One agent does everything — plans, builds, reviews its own work
- Spec is a document nobody checks again
- Session crashes? Start over. Hope you remember where you were
- Every session starts with a blank slate
- Tests are optional, skipped under pressure
- "It works" means "the AI said it works"
- Token spend grows linearly as your project grows
- Bugs from sprint 2 haunt you in sprint 5

</td>
<td width="50%" valign="top">

### With Shipyard

- Specialized agents — builders, reviewers, and critics that check each other's work
- Spec is a machine-enforced contract verified at every stage
- Crash recovery salvages uncommitted work from orphaned worktrees automatically
- Velocity, retro insights, and carry-over items persist across sprints
- TDD enforced at four layers — agent, skill, hook, and rule. Nearly impossible to skip
- "It works" means a separate reviewer verified every acceptance scenario against the code
- Fixed context budgets per skill — token cost doesn't grow with project size
- Bugs, blocked tasks, and retro action items auto-surface in the next sprint

</td>
</tr>
</table>

### The gap Shipyard closes

Every AI coding tool gives you a smart agent. Shipyard gives you a **team that argues**.

Before any plan reaches you, an adversarial critic runs a pre-mortem — imagining how this feature fails spectacularly in 3 months, extracting hidden assumptions, and challenging every design decision. Before any code ships, a separate reviewer verifies it against the spec. Before any test passes, mutation testing confirms the tests actually catch bugs — not just that they run green.

The result: **the intent you expressed in a conversation becomes a machine-verified guarantee on what gets shipped.** The gap between "what we said we'd build" and "what we actually built" is closed mechanically, not hopefully.

---

## Install

**Add the marketplace and install the plugin:**

```bash
/plugin marketplace add acendas/shipyard
/plugin install shipyard@acendas
```

Or from the CLI outside a session:

```bash
claude plugin marketplace add acendas/shipyard
claude plugin install shipyard@acendas
```

Then initialize any project:

```
/ship-init
```

Shipyard analyzes your codebase, detects your tech stack, generates project-specific expert skills, and configures everything. Zero git noise — all data lives in Claude's plugin data directory, not in your repo.

## The Workflow — 6 Commands

Run them in order. Shipyard handles everything between.

### 1. Discuss what to build

```
/ship-discuss user notifications
```

Describe what you want in plain English. Shipyard asks smart questions, researches how other products solve the same problem, challenges your assumptions, writes acceptance criteria, and produces a complete feature spec. An adversarial critic reviews it before you see it.

**You approve the spec.**

### 2. Prioritize the backlog

```
/ship-backlog
```

See everything that's planned. RICE-scored and ranked. Groom, reprioritize, split, archive, or kill features. Approve proposed features into the ready queue.

**You decide what matters.**

### 3. Plan a sprint

```
/ship-sprint
```

Pick features from the backlog. Shipyard researches how to build each one, surfaces implementation decisions for you to make, breaks features into tasks, finds the critical path, and groups tasks into parallel execution waves. A critic reviews the plan.

**You approve the plan.**

### 4. Build it

```
/ship-execute
```

Shipyard builds everything automatically. Tests first, then code — every task follows Red → Green → Refactor → Mutate → Verify → Commit. Tasks run in parallel via worktree isolation. Integration tests run between waves. Code review runs at the end.

**You watch.** Type `pause` to stop cleanly. Session crashed? Run `/ship-execute` again — it auto-recovers and salvages in-flight work.

### 5. Review and ship

```
/ship-review
```

Shipyard verifies every feature against its spec. Runs tests, checks coverage, confirms the feature actually works end-to-end (not just "tests pass"). Shows you the results.

**You approve to release.** Then: retro runs, changelog generated, sprint archived.

### 6. Repeat

```
/ship-discuss "next feature..."
```

Bugs, retro action items, and incomplete work from the previous sprint automatically surface at the start of the next `/ship-sprint`.

## All Commands

| Command | What it does | Who does the work |
|---|---|---|
| `/ship-init` | Setup — analyze codebase, generate rules and expert skills | Auto + you answer Qs |
| `/ship-discuss` | Feature discovery — research, challenge, write spec | You talk, Claude writes |
| `/ship-backlog` | View, groom, prioritize the backlog | You decide |
| `/ship-sprint` | Plan sprint — tasks, waves, critical path, estimates | You approve the plan |
| `/ship-execute` | Build everything with TDD | Fully automatic |
| `/ship-review` | Verify, retro, changelog, release, archive | Auto + you approve |
| `/ship-quick` | One-off task, no planning | You describe, auto builds |
| `/ship-bug` | Report a bug, auto-triage, hotfix path | You report, auto tracks |
| `/ship-debug` | Systematic debugging that survives /clear | Collaborative |
| `/ship-spec` | Browse spec, search, absorb/sync with your docs | You browse |
| `/ship-status` | Dashboard — progress, health, "what's next?" | Auto |
| `/ship-help` | Questions, guidance, or ask Shipyard to act | You ask |

## Your Spec vs Shipyard's Spec

You probably have a product spec already. Shipyard doesn't replace it — it works alongside it.

```
┌──────────────────────┐          ┌──────────────────────┐
│   YOUR PRODUCT SPEC  │          │  SHIPYARD'S SPEC     │
│                      │          │                      │
│  "What the product   │ ─absorb──►  "What we're        │
│   IS and should be"  │(new work)│   building next"     │
│                      │          │                      │
│  Lives in your repo  │          │  Lives in plugin     │
│  Your format         │ ◄─sync─── data directory        │
│  Your structure      │(outcomes)│  Shipyard format     │
└──────────────────────┘          └──────────────────────┘
```

- **`/ship-spec absorb`** — pull your docs into Shipyard for planning (guards against absorbing already-completed work)
- **`/ship-spec sync`** — push decisions and outcomes back to your docs (shipped, decided, or in-progress)

## Safety Nets

Shipyard assumes the AI will cut corners, lose context, and hallucinate — because it will. Every safety net exists because we don't trust the AI to police itself.

- **Tests before code** — TDD is enforced at four independent layers: agent instructions, skill body, hooks, and rules. Any single layer can be bypassed. All four together? Nearly impossible to skip tests.
- **Agents don't review their own work** — the builder writes code. A separate reviewer checks it against the spec. A separate critic reviews the reviewer. Three different model invocations, three different prompts, three different perspectives.
- **You approve every plan** — features, sprint plans, debug fixes, releases, and spec syncs all go through plan mode for your explicit approval. Nothing ships without your sign-off.
- **Nothing is pushed** — Shipyard never pushes to remote or creates branches. It works on your current branch. You push when ready.
- **Concurrent sessions blocked** — running `/ship-execute` in two terminals is hard-blocked. No git conflicts from parallel sessions.
- **Crash recovery** — session dies from quota, crash, or closed terminal? Run the command again. Shipyard scans for orphaned worktrees, commits their uncommitted work as salvage, rebases onto main, and resumes from the exact wave where it stopped. Zero work lost.
- **Auto-pause under pressure** — a hook tracks context compaction. At 2 compactions, it warns you. At 3, it writes a handoff file and stops the sprint before the AI gets dumber. It knows when to pull its own emergency brake.
- **Nothing gets lost** — bugs, retro action items, blocked tasks, and incomplete features persist on disk and auto-surface in the next sprint's carry-over scan. The system won't let you forget what you committed to fixing.
- **Git doesn't lie** — before any agent dismisses a test failure as "pre-existing," it must prove via `git diff` that the failing test isn't on its own branch. No excuses, no handwaving.

## Gets Smarter About YOUR Project

Most AI tools start fresh every time. Same blank slate, every conversation.

Shipyard accumulates project intelligence across sprints:

- **Velocity tracking** — points completed, throughput (pts/hour), estimate accuracy. By sprint 3, planning uses real data, not guesses.
- **Anti-pattern detection** — scope creep, estimates off by >50%, same component breaking twice, testing gaps. Patterns get flagged in retros and tracked as improvement items.
- **Carry-over scan** — every new sprint starts by surfacing open bugs, blocked tasks, retro action items, and incomplete features from previous sprints. You decide what to bring forward, what to defer, what to kill.
- **Retro items become real work** — improvements identified during retrospectives are saved as idea files. They surface during the next sprint planning. They don't live in a doc nobody reads — they enter the workflow as actionable tasks.
- **Codebase-aware planning** — `/ship-init` analyzes your stack, patterns, and conventions. Sprint planning references this context. The researcher agent investigates your actual code before proposing implementation approaches.

The result: sprint 5 is meaningfully better planned than sprint 1 — because Shipyard knows where your project underestimates, where it breaks, and what it committed to improving.

## Token Efficiency by Design

Shipyard is built for teams that care about their API bill.

- **Model routing** — Opus thinks (planning, critique). Sonnet builds (execution, review). Haiku reports (status, tests). The right model for each job, not the most expensive one for everything.
- **Effort levels** — each skill sets a thinking budget. Status checks get minimal reasoning. Sprint planning gets full depth. No wasted thinking tokens.
- **Fixed context budgets** — every skill loads project state through hard line caps (`head -50`, `head -30`). A 500-line backlog costs the same tokens as a 5-line backlog.
- **Lazy-loaded references** — detailed protocols (TDD cycle, git strategy, team mode, communication design) live in separate files, loaded only when the model actually needs them. Not inline, not always-on.
- **Subagent isolation** — each agent starts with a clean, purpose-built context and dies when done. No conversation history accumulation across a 3-hour session.
- **Hooks run outside the model** — TDD enforcement, loop detection, session guards, progress tracking, auto-approval — all Python scripts that cost zero tokens. Eight behaviors enforced for free.
- **Agent memory scoping** — the test runner loads zero project memory. The critic loads only project-level context. Every agent carries exactly the context it needs, nothing more.

The real comparison isn't "Shipyard vs one clean AI session." It's Shipyard vs the realistic cost of re-doing failed work, re-explaining lost context, and debugging code that wasn't tested properly the first time.

## Architecture

Shipyard is a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) built entirely on Claude Code primitives — no external runtime, no server, no database.

### Skills (12)

Each `/ship-*` command is a [skill](https://docs.anthropic.com/en/docs/claude-code/skills) — a markdown file with YAML frontmatter and dynamic context injection via `!` backtick commands.

### Agents (6)

| Agent | Role |
|---|---|
| **Builder** | Executes tasks in worktree isolation with strict TDD |
| **Researcher** | Investigates APIs, codebase patterns, and external docs |
| **Reviewer** | Read-only verification against acceptance criteria and code quality |
| **Critic** | Adversarial review of specs and plans before user approval |
| **Skill Writer** | Auto-generates project-specific SME skills from codebase analysis |
| **Test Runner** | Lightweight agent for running tests without polluting orchestrator context |

### Rules (7)

Path-scoped [rules](https://docs.anthropic.com/en/docs/claude-code/rules) that lazy-load when Claude touches matching files. TDD enforcement, spec formatting, execution conventions, data model, and review standards.

### Hooks (6)

Python [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) that enforce discipline automatically:

- **TDD check** — blocks commits lacking tests for staged implementation code
- **Session guard** — prevents code writes during planning/discussion sessions
- **Loop detection** — flags repeated edits to the same file without committing
- **On-commit** — captures learnings when an agent struggles
- **Worktree branch** — creates worktrees from current branch, handles nested worktrees
- **Post-compact** — restores sprint context after compaction, tracks compaction pressure

### Project Data

All Shipyard data lives **outside your project** in `${CLAUDE_PLUGIN_DATA}/projects/<hash>/`. Zero git noise — no `.shipyard/` directory in your repo. Only `.claude/rules/shipyard-*.md` files are installed in the project (plugins can't ship rules remotely).

The hash is derived from the **parent repo root**, so all worktrees of the same project share one data directory. Builder subagents running in `<repo>/.claude/worktrees/<task>` write back to the orchestrator's data dir on `main` — no state divergence across waves.

```
plugin-data/projects/<hash>/
├── config.md              Project settings
├── codebase-context.md    Auto-generated codebase analysis
├── spec/
│   ├── epics/             High-level groupings
│   ├── features/          Feature specs with acceptance criteria
│   ├── tasks/             Task breakdowns with technical notes
│   ├── bugs/              Bug reports and tracking
│   ├── ideas/             Quick-captured ideas and retro items
│   └── references/        Extracted API contracts, schemas, flows
├── backlog/
│   └── BACKLOG.md         RICE-ranked feature queue (IDs only)
├── sprints/
│   └── current/           Active sprint with wave structure
├── memory/
│   └── metrics.md         Velocity, throughput, and retro insights
├── debug/                 Persistent debug sessions
└── verify/                Review verdicts
```

**Windows note:** the `shipyard-data.cmd` and `shipyard-context.cmd` wrappers
delegate to Node and inherit cmd.exe's argument-quoting limitations. Paths
containing spaces or special characters should be passed via the
`CLAUDE_PLUGIN_DATA` environment variable rather than as command-line
arguments. Skills shipped with Shipyard do not pass such arguments.

## Key Design Decisions

<details>
<summary><strong>Why enforce TDD at four layers?</strong></summary>
<br>
Agent instructions, skill body, hooks, and rules all enforce TDD independently. Any single layer can be bypassed — all four together make it nearly impossible to skip tests.
</details>

<details>
<summary><strong>Why adversarial critique before approval?</strong></summary>
<br>
Self-review catches structural issues (missing fields, format). The critic agent catches logical issues (implicit assumptions, feasibility risks, untested hypotheses) using pre-mortem analysis and multi-persona review. Research shows this generates 30% more failure scenarios than asking "what could go wrong?"
</details>

<details>
<summary><strong>Why single-source-of-truth data model?</strong></summary>
<br>
Feature files own all feature data. Task files own all task data. BACKLOG.md and SPRINT.md are lightweight indexes storing only IDs. This eliminates sync bugs between duplicate data sources.
</details>

<details>
<summary><strong>Why plugin data instead of .shipyard/?</strong></summary>
<br>
Zero git noise. No merge conflicts on spec files. No accidental commits of planning state. The plugin data directory is per-project (keyed by git root hash) and lives outside the repo entirely.
</details>

<details>
<summary><strong>Why auto-generate SME skills?</strong></summary>
<br>
During /ship-init, the skill-writer agent scans your codebase and generates project-specific expert skills (e.g., /nextjs-expert, /postgres-expert) that encode how YOUR project uses each technology — not generic docs, but actual paths, config, patterns, and conventions.
</details>

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Python 3
- Git
- macOS or Linux

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, and conventions.

## License

MIT — see [LICENSE](LICENSE).
