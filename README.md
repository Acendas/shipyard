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
- TDD enforced in skill + rule prose and by orchestrator-side gates (commit-sha verification, anti-stub scan, probe-output match)
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

Shipyard is distributed through the [Acendas marketplace](https://github.com/Acendas/acendas-marketplace).

**Add the marketplace and install the plugin:**

```bash
/plugin marketplace add Acendas/acendas-marketplace
/plugin install shipyard@acendas
```

Or from the CLI outside a session:

```bash
claude plugin marketplace add Acendas/acendas-marketplace
claude plugin install shipyard@acendas
```

The marketplace pins Shipyard to a released version tag (not `main`) — so every install is deterministic. To pick up a new release, run `/plugin marketplace update` then `/plugin install shipyard@acendas` again.

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

- **Tests before code** — TDD is enforced in skill + rule prose and by orchestrator-side gates: commit-sha verification, an anti-stub scan of the diff, and a probe-output match before any task is marked complete. A model can't hand-wave "done" past a gate that checks git ground truth.
- **Agents don't review their own work** — the builder writes code. A separate reviewer checks it against the spec. A separate critic reviews the reviewer. Three different model invocations, three different prompts, three different perspectives.
- **You approve every plan** — features, sprint plans, debug fixes, releases, and spec syncs all go through plan mode for your explicit approval. Nothing ships without your sign-off. `/ship-discuss` renders the acceptance scenarios verbatim, the scope-drift check, and the spec together in one consolidated approval gate — you read the real content, not a summary count, before approving.
- **Nothing is pushed** — Shipyard never pushes to remote or creates branches. It works on your current branch. You push when ready.
- **Concurrent sessions blocked** — running `/ship-execute` in two terminals is hard-blocked. No git conflicts from parallel sessions.
- **Crash recovery** — session dies from quota, crash, or closed terminal? Run the command again. Shipyard scans for orphaned worktrees, commits their uncommitted work as salvage, rebases onto main, and resumes from the exact wave where it stopped. Zero work lost.
- **Pause on demand, resume safely** — say "pause" mid-sprint and the pipeline cursor flips to `status: paused`; a crashed or closed session self-recovers on the next run instead of needing a handoff file (there isn't one — it was retired in favor of the cursor's own state).
- **Nothing gets lost** — bugs, retro action items, blocked tasks, and incomplete features persist on disk and auto-surface in the next sprint's carry-over scan. The system won't let you forget what you committed to fixing.
- **Git doesn't lie** — before any agent dismisses a test failure as "pre-existing," it must prove via `git diff` that the failing test isn't on its own branch. No excuses, no handwaving.
- **State has one writer, not a model with a text editor** — pipeline cursors, feature/backlog frontmatter, and skill-mutex locks are all CLI-owned (`shipyard-data cursor|feature|backlog|lock ...`); a PreToolUse hook denies any model attempt to hand-Write or hand-Edit them directly.

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

- **Config-driven model tiers** — `think` (Opus by default — critique, spec review, decomposition) and `build` (Sonnet, fixed — execution labor) are set in `config.md`'s `models:` block, not hardcoded. Flip `think` to Fable for a single discussion (`/ship-discuss --think fable`, if Fable's enabled on your plan) or permanently (`shipyard-data config set-model think fable`). The right model for each job, not the most expensive one for everything.
- **Effort levels** — each skill sets a thinking budget. Status checks get minimal reasoning. Sprint planning gets full depth. No wasted thinking tokens.
- **Fixed context budgets** — every skill loads project state through hard line caps (`head -50`, `head -30`). A 500-line backlog costs the same tokens as a 5-line backlog.
- **Lazy-loaded references** — detailed protocols (TDD cycle, git strategy, team mode, communication design) live in separate files, loaded only when the model actually needs them. Not inline, not always-on.
- **Subagent isolation** — each agent starts with a clean, purpose-built context and dies when done. No conversation history accumulation across a 3-hour session.
- **Hooks run outside the model** — three Node hooks (plugin-data breadcrumb, auto-approve/deny for CLI-owned state, worktree branch setup) cost zero tokens. Everything else that used to be advisory hook enforcement moved into skill-prose Iron Laws plus the orchestrator-side gates above, which are stronger because they check git ground truth instead of trusting a model's self-report.
- **Agent memory scoping** — the test runner loads zero project memory. The critic loads only project-level context. Every agent carries exactly the context it needs, nothing more.

The real comparison isn't "Shipyard vs one clean AI session." It's Shipyard vs the realistic cost of re-doing failed work, re-explaining lost context, and debugging code that wasn't tested properly the first time.

## Architecture

Shipyard is a [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) built entirely on Claude Code primitives — no external runtime, no server, no database.

### Skills (12)

Each `/ship-*` command is a [skill](https://docs.anthropic.com/en/docs/claude-code/skills) — a markdown file with YAML frontmatter and dynamic context injection via `!` backtick commands.

### Registered agents + thin dispatch wrappers

Shipyard ships 5 registered agents under `agents/` — `shipyard-code-reviewer`, `shipyard-spec-reviewer` (both read-only), `shipyard-disciplined-builder`, `shipyard-researcher`, and `shipyard-operational-task`. Capability skills (`dispatching-task-loop`, `dispatching-spec-review`, `dispatching-code-review`, `dispatching-research-task`, `dispatching-operational-task`, and others) are thin gate wrappers around them: each dispatches the matching `subagent_type: shipyard:<name>` with a structured-return contract that the wrapper verifies independently (commit sha exists, probe exit code is 0, no stub patterns in the diff) rather than trusting the subagent's own claim of success. The verification spine — task-return contract, orchestrator gate, wave-integration check, commit anchoring — lives in the wrapper skills and CLI, not in the agents themselves.

### Rules (4)

Path-scoped [rules](https://docs.anthropic.com/en/docs/claude-code/rules) that lazy-load when Claude touches matching files: `shipyard-ask-user` (question design), `shipyard-data-model` (source-of-truth discipline), `shipyard-next-up` (routing conventions), `shipyard-spec` (spec formatting).

### Hooks (3)

Node [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) that enforce discipline automatically:

- **Plugin-data breadcrumb** (`SessionStart`) — writes a resolvable path to the plugin data directory so skill subprocesses can find it even when the platform doesn't propagate the env var.
- **Auto-approve / deny for CLI-owned state** (`PreToolUse`) — auto-approves Writes/Edits inside Shipyard's data directory, and denies outright any model attempt to hand-write a pipeline cursor, feature/BACKLOG.md frontmatter, or a skill-mutex lock file — all of those are single-writer CLI surfaces (`shipyard-data cursor|feature|backlog|lock ...`).
- **Worktree branch** (`WorktreeCreate`) — creates the task worktree's branch from the current local HEAD, guards against orphaning a prior agent's un-integrated commits on a branch-name collision.

### Project Data

All Shipyard data lives **outside your project** in `${CLAUDE_PLUGIN_DATA}/projects/<hash>/`. Zero git noise — the only in-repo artifact is a **gitignored `.shipyard` symlink** pointing at that data dir (a navigation convenience that also serves as the resolver's last-resort fallback). Only `.claude/rules/shipyard-*.md` files are installed in the project (plugins can't ship rules remotely).

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
<summary><strong>Why enforce TDD via prose + orchestrator gates, not a hook?</strong></summary>
<br>
Skill body and rule prose state the Iron Law (tests before code) at every entry point. The gates that actually catch a skipped or faked test live in the orchestrator: it verifies the returned commit sha exists in git, runs an anti-stub scan over the diff, and checks the acceptance probe's exit code — none of which trust the subagent's own "I wrote the tests" claim. A prose rule alone can be talked past; a gate checking git ground truth can't.
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
- Node.js ≥ 18 (already present wherever Claude Code runs — Shipyard's CLIs and hooks are Node)
- Git
- macOS, Linux, or Windows

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, and conventions.

## License

MIT — see [LICENSE](LICENSE).
