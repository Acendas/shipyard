# Upgrading Shipyard

> **Note:** `/ship-init` was removed in v3.20.0. Onboarding now runs automatically on the first `/ship-status` in a project. Older sections below still mention `/ship-init` as historical record.

## 4.0.4 → 4.0.5

No migration and no breaking change. Things you may notice:

| What | Detail |
|---|---|
| Builds wait their turn | The tool named in `test_commands` and `build_commands` is held at the build gate when it is run through `shipyard-logcap run`. The first builds of a project run one at a time until one was measured alone. `shipyard-data build-gate status` shows the room and the reason |
| Exit 75 and 69 | `shipyard-logcap run` can now end with 75 (queued, or "your turn": not run, run the same command again) and, with a runner, 69 (the runner could not run it). Neither is recorded as a run. A script of your own that wraps `shipyard-logcap run` should treat both as "again" |
| Builders | A builder that runs the build tool outside `shipyard-logcap run` is sent back with the command to use |
| Ready check | `/ship-execute` runs `shipyard-data build-gate check` before the first wave. Gradle and Maven projects get a configure-only call; for other tools set `test_commands.ready` to a command that takes seconds, or the check is skipped with one line. When the build does not start you are shown its output and asked once |
| New settings | Under `execution:` in `config.md`: `build_slots: <n>`, `runner_command: <script>`, `build_gate: false`. Under `test_commands:`: `ready`. None is required |
| A runner script | Called as `<script> --worktree <dir> -- <command...>`; its output and exit code are the command's. `<script> --capacity` prints how many runs it takes at once; a script that does not answer is not used |

## 4.0.3 → 4.0.4

No migration and no breaking change. Things you may notice:

| What | Detail |
|---|---|
| One question per project | The first time a story is approved in a discussion (or a discussion that wrote specs ends), you are asked where the project's knowledge lives, besides the code. Your answer is kept in `sources.json` in the project's data folder. To see or change it: `shipyard-data sources list`, `sources add "<name>" --holds "<what it holds>" [--tool <word>\|--path <folder>\|--url <address>] [--always] --answer "<your words>"`, `sources remove`, `sources none` |
| A project with no other sources | Answer "only the repository". No search of a tracker, wiki or drive is made, and no record of one is asked for |
| `discuss-questions sources` | The flags `--wiki`, `--tracker` and `--drive` are gone. It takes one line per place you named: `--looked`, `--skipped` or `--unreachable`. A record made on 4.0.3 or earlier still counts |
| Open windows | Close Claude Code windows opened before the update and start new ones. A window on 4.0.3 stops at its first command once 4.0.4 has worked on the project, and says so |

## 4.0.2 → 4.0.3

No migration and no breaking change. Things you may notice:

| What | Detail |
|---|---|
| Open windows | A session keeps the plugin version it started with. After updating, close open Claude Code windows on the project and start new ones. From 4.0.3 on, a window older than the version that last worked on the project stops at its first command and says so. `SHIPYARD_ALLOW_OLDER_SESSION=1` is the way past it |
| `rice_confidence` | A value above 1 is a percentage: `70` and `0.7` give the same score. A score computed from a whole number on 4.0.2 was 100 times too high; `shipyard-data story set <id> rice_confidence=<n>` recomputes it |
| Stories without a release | A story split from a story in a release now takes that release. Slices made on 4.0.2 have none: `shipyard-data story set <id> fix_version=<name>` |
| `story refine` | The way a `refined: false` story becomes refined. Do not edit the field by hand |
| Background commands in a builder | Refused by a hook; the builder runs the command in the foreground. Nothing to set |
| A new hook | `builder-foreground` runs before shell commands and returns at once unless the command asks to run in the background |

## 4.0.1 → 4.0.2

No migration and no breaking change. Things you may notice:

| What | Detail |
|---|---|
| The `ticket:` field | A record's own ticket is now `ticket:`, written by `tracker link` and `tracker pull`. Records imported or linked on 4.0.1 are recognised as before. A record that only lists a key in `external_refs` (added by hand, or on 4.0.0 and earlier) is shown on the tracker plan as having no ticket, with the key it mentions: if that key is its own ticket, run `shipyard-data tracker link <id> <KEY>` once |
| Fewer rows to update | The tracker plan no longer proposes updating a ticket from a record that only mentions it. If you were on 4.0.1, do the next sync on 4.0.2 |
| Version names | `version add v4.2` is refused when `v4.2.0` exists (the same release). To fold two existing versions: `shipyard-data version rename <from> <into> --merge` |
| Health check | Stories without `rice_*`, `complexity`, `token_estimate` or `references` are no longer reported |
| Worktree branches | A worktree created in the project while no sprint is building is on a branch `worktree-<name>`, not `shipyard/wt-<name>` |

## 4.0.0 → 4.0.1

No migration and no breaking change. Things you may notice:

| What | Detail |
|---|---|
| Two new hooks | One counts which kinds of source (wiki, tracker, shared drive, web) a discussion read; one sends back a ticket write whose text was not shown to you first. Neither records what was asked or returned |
| New setting | `tracker_sync` in the project's config: `ask` (default), `auto`, `off`. Set it with `shipyard-data config set tracker-sync <value>` |
| Tracker import | A ticket typed epic now comes in as an idea, and a ticket typed task as a task. Before, both came in as unrefined stories |
| Backlog | Once you place an item with `backlog move`, new stories are added at the bottom and `backlog rank` refuses unless you pass `--by-score` |
| Ideas | `idea promote` turns an idea into an epic. Break the epic down with `/ship-discuss <E###>` |
| End of a discussion | A discussion that wrote specs records where its research looked, and asks about tracker tickets, before it can end |

## 3.26.0 → 4.0.0

4.0.0 is the first published release after 3.26.0. **It has breaking changes.** Read this section, then run the migration.

```
shipyard-data migrate --dry-run      read the plan
shipyard-data migrate                apply it (idempotent)
shipyard-data migrate --reverse      restore the original tree byte for byte
```

### What is different for you

| Area | 3.26.0 | 4.0.0 |
|---|---|---|
| Words and ids | features `F###`, bugs `B###`, tasks `T###` | stories `S###` (feature or bug), builder **steps** `P###`, enabling **tasks** `T###`. Old ids still resolve |
| Front door | `/ship-discuss`, `/ship-quick`, `/ship-bug` | `/ship-discuss` only. It proposes a lane: capture, refine, land now, or hotfix. `/ship-quick` and `/ship-bug` are removed |
| Questions in a discussion | Asked in rounds | Asked one card at a time as research finds them; research runs in the background and never waits for you |
| A discussion and the project | Could edit project files | Writes specs only. A small change becomes a task for `/ship-execute --task` |
| Planning | Small steps, waves capped at 6 | The plan is scored for parallel work (`sprint plan-score`); steps go in the earliest wave their dependencies allow; same-wave steps may not touch the same file; each step's check must fail before the work (`sprint probes-at-base`) |
| Agents at once | 3 builders, written in a skill | At most 100 agents alive at once (`execution.max_agents`), enforced when an agent is started |
| Executing a sprint | Could stop to ask | Unattended after readiness: it decides by a written ladder and records every decision for the review |
| Quality work | At sprint review | Inside execute, per story: spec review, gap analysis, code review, fixes in the same sprint |
| Sprint review | Scans and fixes | A twelve-section review document the CLI writes, shown whole, with one acceptance question |
| Models | One build model | Three speeds by step size: small steps on the light model, reasoning on the build model, hard work on the think model (`models.light`) |
| Tests | Test first | Behaviour first: one scenario per criterion, a journey test by default, scenario ids checked both ways |
| UI stories | Not checked against a design | A signed-off design in the discussion, compared with the delivered screen at review |
| Commands running together | One at a time | A lock only stops a second copy of the same command. You can discuss, and draft the next sprint, while a sprint runs |
| After a sprint | Branches and stale state left behind | Branches swept, drift repaired (`shipyard-data reconcile`), a dead session no longer blocks |
| When a person is needed | Whenever a step that needed you came up | At the start (spikes, tests, decisions whose result changes what is built) or at the end (looks and checks, in one sitting). Never in the middle. The plan says what it needs from you, and the progress line says when (`sprint needs-you`) |
| Test runs | Re-run at every stage | A passing run on this exact code is evidence and is not run again; a fix is confirmed with the failed tests only. `shipyard-data infra check` reports your test setup and `infra apply` sets up what is missing |
| Urgent bugs | `/ship-bug --hotfix` | `/ship-discuss` proposes the hotfix lane and writes the story with its check; `/ship-execute --hotfix S###` builds it beside a running sprint |
| Retiring a story | Edit the file | `shipyard-data story set-status <id> rejected --reason "<why>" --replaced-by <ids>`; it also lists where your project still names the story |
| How it talks | Assumed an engineer | Plain words, a short summary first, a picture or example, one question per card |

### Settings to know

| Setting | Default | Meaning |
|---|---|---|
| `execution.max_agents` | 100 | Most agents alive at once. Replaces `max_parallel_agents` |
| `execution.parallel_plan` | true | A story cannot enter a sprint while the plan score reports a problem |
| `execution.probe_must_fail_first` | true | A step's check must fail on today's code |
| `verify_ignore` | (empty) | Paths that cannot change a build or test result; a commit touching only these keeps a test proof fresh |
| `execution.patch_wave_tests` | sprint | A wave made only of fix steps skips its own build and test run; the sprint's full run covers it. `wave` runs them every time |
| `execution.unattended` | true | Execute does not ask questions mid-sprint |
| `execution.overlap_waves` | true | The next wave starts as soon as the previous one is merged |
| `models.light` | unset | Set it (for example `haiku`) to turn on the light tier for small steps |
| `spec.behaviour_first` | true | Scenario rules are checked when a story is approved |
| `discuss_writable` | empty | Project documents a discussion may write (your decision record) |

Old template values left in your `config.md` are ignored where the default changed (`max_parallel_agents: 3`, `max_tasks_per_wave: 6`, `max_tasks_per_wave_merged: 12`). A number you chose yourself is kept.

### How this release was built

4.0.0 was developed through milestones numbered 3.27 and 4.0 to 4.21. They were never published on their own. Where a skill, a message or a note says "(4.17)" or "v4.20", it names the milestone inside 4.0.0 that introduced the behaviour.

## Development milestones inside 4.0.0

The notes for each milestone (3.27 and 4.0 to 4.21), newest first, are in [docs/milestones-4.0.md](docs/milestones-4.0.md).

## 1.x → 2.0

Shipyard 2.0 is a substantial overhaul. Most installs upgrade cleanly via `claude plugin update`, but there are two situations that need a manual touch.

### Empty `/ship-init` after upgrade — orphan data recovery

**Symptom.** You upgrade, run `/ship-init` in a project where you previously had a Shipyard sprint or backlog, and Shipyard reports a fresh install — your prior sprint state, backlog, codebase context, and memory are all missing.

**Cause.** 2.0 changed how project hashes are computed for git worktrees. If your previous Shipyard sessions ran inside a user-owned worktree, the data was stored under the *parent repo's* hash. After the upgrade the resolver hashes the worktree path itself — so it looks at a different (empty) directory and reports no install.

**Recovery.** Your old data is still on disk; nothing was deleted. Two options:

1. **Repoint via env var (fast, non-destructive).** Set `CLAUDE_PLUGIN_DATA` to the parent repo's data dir before launching Claude Code:

   ```bash
   # Find the parent-repo data dir
   ls ~/.claude/plugins/data/shipyard/projects/

   # Identify the one that matches your repo (each has a .project-root breadcrumb)
   for d in ~/.claude/plugins/data/shipyard/projects/*/; do
     echo "$d → $(cat "$d/.project-root" 2>/dev/null)"
   done

   # Launch Claude Code pointed at the matching dir
   CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/shipyard/projects/<hash>/ claude
   ```

   You can persist this in your shell profile if you always work in the same worktree.

2. **Copy into the new location (one-time).** Identify the new (empty) data dir Shipyard 2.0 expects:

   ```bash
   # From inside your worktree
   shipyard-data
   # → prints the expected path, e.g. ~/.claude/plugins/data/shipyard/projects/<new-hash>/
   ```

   Copy the populated dir's contents over:

   ```bash
   cp -R ~/.claude/plugins/data/shipyard/projects/<old-hash>/* <new-path>/
   # Update the breadcrumb so the resolver agrees
   echo "$(pwd)" > <new-path>/.project-root
   ```

   Re-run `/ship-init` to verify it now sees your sprint and backlog.

If you previously had two worktrees of the same repo whose Shipyard sessions co-mingled state under the parent hash, only one worktree can claim that data. The other will start fresh; there's no automatic way to de-interleave a shared dir.

### Legacy footprint cleanup

Pre-2.0 `/ship-init` silently installed two things into your project that 2.0 removed:

1. Rule files in `.claude/rules/shipyard-*.md` — these loaded into *every* Claude Code session in the project, not just Shipyard ones. 2.0 keeps rules in the plugin and loads them only inside `/ship-*` skills.
2. Permission entries in `.claude/settings.local.json` — silently merged. 2.0 makes permissions opt-in with explicit consent.

Run `/ship-init` once after upgrading. It detects both kinds of legacy footprint and offers cleanup with a clear before/after. Shipyard-specific entries are offered separately from generally-useful entries (`Bash(git:*)`, `Bash(ls:*)`, `WebSearch`, `WebFetch`) so you can keep your everyday allowlist.

### Retired CLI surface

These `shipyard-data` and `shipyard-context` subcommands were removed:

| Subcommand | Replacement |
|---|---|
| `shipyard-data migrate <src>` | None — manual recovery (above) for upgraders |
| `shipyard-data find-orphans` | None — see manual recovery |
| `shipyard-data drop-orphan <hash>` | `rm -rf` the dir directly after confirming via `.project-root` breadcrumb |
| `shipyard-data project-id` | `node ${CLAUDE_PLUGIN_ROOT}/bin/shipyard-resolver.mjs project-hash` |
| `shipyard-data project-root` | `node ${CLAUDE_PLUGIN_ROOT}/bin/shipyard-resolver.mjs project-root` |
| `shipyard-data reap-obsolete` | None — soft-deleted records stay on disk; manual cleanup if needed |
| `shipyard-data events {tail,grep,since,json}` | Read `<SHIPYARD_DATA>/.shipyard-events.jsonl` directly with `tail -f`, `jq`, etc. |
| `shipyard-context legacy-check` | None — `/ship-init`'s footprint cleanup section subsumes it |

If you have automation that called any of the above, update it to the replacement column.

### Hook surface trimmed

12 hooks → 3. The retired ones (TDD enforcement, session-guard, subagent-stop, agent-heartbeat, cwd-restore, loop-detect, on-commit, post-compact, block-bash-state-write) were *advisory* enforcement that 2.0 moves into prose-level "Iron Laws" inside the dispatching skills, with orchestrator-side gates as the safety net (commit-sha verification, anti-stub-scan, probe-output match). Surviving hooks: `SessionStart` plugin-data breadcrumb, `PreToolUse` auto-approve for SHIPYARD_DATA writes, `WorktreeCreate` branch setup.

If you depended on a retired hook (e.g., your CI grepped logs for tdd-check output), the replacement is the structured event log at `<SHIPYARD_DATA>/.shipyard-events.jsonl`.

### Registered agents removed

The `shipyard-builder`, `shipyard-critic`, `shipyard-investigator`, `shipyard-discovery-scout`, `shipyard-researcher`, `shipyard-test-runner`, `shipyard-skill-writer`, `shipyard-sprint-analyst`, and the six `shipyard-review-*` scanners are gone. Their work was folded into capability skills (`dispatching-task-loop`, `dispatching-spec-review`, `dispatching-code-review`, `discovering-edge-cases`, etc.) that dispatch fresh-context `general-purpose` subagents with structured-return contracts.

If you had `Task(subagent_type: "shipyard:shipyard-builder", …)` in custom workflow code, it won't resolve. Switch to invoking the relevant Shipyard `/ship-*` command skill instead.

**Note (3.12.0):** registered agents came back, under new names. `agents/shipyard-code-reviewer`, `shipyard-spec-reviewer`, `shipyard-disciplined-builder`, `shipyard-researcher`, `shipyard-operational-task`, and `shipyard-track-coordinator` are dispatched by thin `dispatching-*` capability-skill wrappers that own the verification spine (task-return contract, orchestrator gate, wave-integration check). See the 3.11.0 → 3.12.0 section below.

## 3.11.0 → 3.12.0

Registered agents, added back: 6 named agents live under `plugins/shipyard/agents/` (`shipyard-code-reviewer`, `shipyard-spec-reviewer`, `shipyard-disciplined-builder`, `shipyard-researcher`, `shipyard-operational-task`, `shipyard-track-coordinator`), dispatched via `subagent_type: shipyard:<name>` from the matching `dispatching-*` capability skill. This reverses the 2.0-era "no registered agents" position (see above) — the difference this time is that the verification spine (structured task-return contract, orchestrator-side gate, `verify-wave-integrated`, commit anchoring) stays in the thin wrapper skills and the `shipyard-data` CLI, not in the agents. Agents own the work; wrappers own the trust.

No user action required — same `/ship-*` commands, same pipeline behavior. Other changes in this release:

- `shipyard-data scan-stubs` — the anti-stub scan moved from skill prose into a CLI subcommand.
- `/ship-execute` and `/ship-review` gained a lightweight per-wave / per-stage task mirror (TaskList-visible progress, mirror-only — never authority, same discipline as the existing discuss/sprint task mirrors).
- Mode-semantics correction: Agent Teams do **not** get worktree isolation. Subagent mode (`isolation: "worktree"`) remains the build default; Teams is opt-in for large parallel waves.

## 3.24.0 → 3.25.0

The idea-backlog guard moved off the capture path. Previously `shipyard-data next-id ideas` **refused to allocate** once undispositioned ideas reached `execution.max_ideas_per_sprint` (default 12). That made writing a finding down the thing that failed: builders and reviewers hitting the cap had no sanctioned override in their agent bodies, so real findings ended up in task-scoped files and return notes instead of the backlog, where nothing indexes them.

Now:

- **`next-id ideas` always allocates.** Over cap it prints a warning to stderr and still returns a valid id on stdout. Capture is never blocked.
- **The cap gates opening a new sprint instead** — `/ship-sprint` Step 0.5 runs `shipyard-data check-idea-backlog` (exit 3 = over cap) and offers grooming, raising the cap, or explicit acceptance. That's the point where an ungroomed backlog is a real decision to defer rather than a bookkeeping lag.
- **New config key: `execution.max_undispositioned_ideas`** (default 12), set via `shipyard-data config set max-undispositioned-ideas <n>`. The old `max_ideas_per_sprint` is still read as a fallback, so **no action is required** — but the old name promised a per-sprint scoping that never existed (the count has always been a lifetime scan of `spec/ideas/`). Rename it when convenient; if both are present, the new key wins.
- **Escape hatch:** `shipyard-data events emit idea_backlog_accepted count=<n>` lets planning proceed over cap, but only while the backlog stays at or below `<n>`. It is not a permanent bypass.

**If you're already wedged** (a large backlog that was silently refusing allocations), run `/ship-backlog` and groom — then check what got lost during the refusal window: findings from that period may be sitting in task-scoped filenames or builder return notes rather than `spec/ideas/`.

## Older versions

Pre-2.0 in-project `.shipyard/` directories were migrated by 1.x's `/ship-init`. If you're upgrading from a much older version that still has `.shipyard/`, install 1.12.x first to migrate, then upgrade to 2.0.
