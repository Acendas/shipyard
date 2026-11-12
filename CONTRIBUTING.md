# Contributing to Shipyard

Thanks for your interest in Shipyard. This guide covers everything you need to get started.

## Development Setup

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Node.js ≥ 18 (Shipyard's CLIs and hooks are Node; CI uses Node 20)
- Python 3 (the eval suite and pytest tests)
- Git

### Clone and test locally

```bash
git clone https://github.com/acendas/shipyard.git
cd shipyard
```

Test by loading the plugin directly into a test project:

```bash
cd /path/to/test-project
claude --plugin-dir /path/to/shipyard/plugins/shipyard
```

Then run any `/ship-*` command inside Claude Code, such as `/ship-status`. On first run its onboarding gate creates the test project's data directory and `config.md`, then stops. Fill in the test and build commands in `config.md` if you want to exercise the full pipeline.

After editing source files, run `/reload-plugins` inside Claude Code — no restart needed.

## Project Structure

```
shipyard/                            Repo root
├── plugins/shipyard/                The plugin itself
│   ├── .claude-plugin/
│   │   └── plugin.json              Plugin manifest
│   ├── skills/*/                    11 slash commands + 21 capability skills
│   │   └── SKILL.md
│   ├── agents/                      Subagent definitions (7 agents)
│   │   └── shipyard-*.md
│   ├── bin/                         Node CLIs and hook modules
│   │   ├── shipyard-data.mjs
│   │   └── hooks/*.mjs
│   ├── hooks/                       Hook configuration
│   │   └── hooks.json
│   ├── project-files/               Templates and plugin-local references
│   │   ├── references/*.md          Plugin-local reference guides
│   │   ├── rules/shipyard-*.md      Plugin-local rules
│   │   └── templates/*.md           Markdown templates (9 templates)
│   └── tests/                       Evals and unit tests
│       ├── eval-run.py              Eval suite
│       ├── assertions/*.json        Eval assertions
│       ├── test_*.py                pytest tests
│       └── test_*.mjs               Node tests (node:test)
├── README.md
├── UPGRADING.md
└── CONTRIBUTING.md
```

Paths in the rest of this guide are relative to `plugins/shipyard/` unless they start with `plugins/`.

## What to Work On

### Skills (`skills/ship-*/SKILL.md`)

Each skill is a self-contained markdown file with:
- **YAML frontmatter** — `name`, `description`, `allowed-tools`, `model`, `effort`, `paths`, `argument-hint`
- **Dynamic context** — `` !`command` `` blocks that run at invocation to load project state
- **Instructions** — what Claude should do when this skill triggers

Key conventions:
- Skills read project state via `!` backtick commands, never hardcoded paths
- Use `$ARGUMENTS` to access user input after the slash command
- Keep skills under 500 lines — split reference material into `references/` subdirectories
- The `description` field controls when Claude triggers the skill — make it specific

### Agents (`agents/shipyard-*.md`)

Agent definitions follow [Claude Code agent format](https://docs.anthropic.com/en/docs/claude-code/agents):
- YAML frontmatter with `name`, `description`, `model`, `allowed-tools`, `maxTurns`, `memory`
- Markdown body with instructions
- Agents are dispatched by the thin `dispatching-*` capability skills, which verify each agent's structured return rather than trusting it (e.g., `dispatching-task-loop` dispatches `shipyard-disciplined-builder` during `/ship-execute`)

### Rules (`project-files/rules/shipyard-*.md`)

Rules provide passive guidance for Shipyard's own skills and references. They stay plugin-local; onboarding does not copy `shipyard-*.md` rules into the user's project.

### Hook Scripts (`bin/hooks/`)

Node modules invoked by Claude Code's hook system via `bin/hook-runner.mjs`. They receive JSON on stdin:

```json
{
  "tool_name": "Bash",
  "tool_input": {"command": "git commit -m 'feat: ...'"},
  "tool_response": "..."
}
```

Conventions:
- All errors go to stderr (stdout is for user-facing messages)
- Exit 0 to allow, exit 2 to block (PreToolUse only)
- Keep hot paths in-process Node; hooks run on frequent tool calls
- Use the shared helpers in `bin/_hook_lib.mjs` for containment, logs, atomic writes, and lockfiles

### Templates (`project-files/templates/`)

Markdown templates with YAML frontmatter. Onboarding (`shipyard-data onboarding bootstrap`) creates each project's `config.md` from the `config.md` template and syncs the templates into the project's data directory; skills use them to create new files (features, tasks, bugs, sprints and so on).

## Running Tests

From the repo root:

```bash
python3 plugins/shipyard/tests/eval-run.py                       # full eval
python3 plugins/shipyard/tests/eval-run.py -v                    # verbose
python3 plugins/shipyard/tests/eval-run.py --skill ship-execute  # one skill
python3 -m pytest plugins/shipyard/tests/                        # Python tests
node --test plugins/shipyard/tests/*.mjs                         # Node tests
```

CI runs the eval suite and the pytest tests. Run the Node tests locally too; CI doesn't run them separately.

For hook scripts:
```bash
node --check plugins/shipyard/bin/hook-runner.mjs
node --check plugins/shipyard/bin/hooks/auto-approve-data.mjs
```

## Conventions

### Commits

```
type(scope): description
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`

Scopes: `skill`, `agent`, `rule`, `hook`, `plugin`, `template`, `docs`

### Skill naming

- Directory: `ship-<name>/` (lowercase, hyphenated)
- YAML name: `ship-<name>`
- User-facing: `/ship-<name>`

## Pull Requests

1. Fork the repo and create a feature branch
2. Make your changes
3. Run the eval suite, pytest and Node tests (see [Running Tests](#running-tests)) to verify
4. Test by loading plugin into a test project and trying affected commands
5. Open a PR with a clear description of what changed and why

## Architecture Decisions

**Why a Claude Code plugin?**
Plugins integrate natively — skills, agents, and hooks load automatically. No manual file copying for the core tool. Project-specific setup is a CLI step (`shipyard-data onboarding bootstrap`) that every command's onboarding gate runs on first use: it creates the project's data directory and `config.md` and syncs templates into it, without installing anything into the user's project.

**Why markdown files instead of a database?**
Shipyard state must survive Claude Code context resets (`/clear`). Files are the only durable medium. Markdown with YAML frontmatter is human-readable, git-diffable, and parseable.

**Why Node for hooks?**
Hooks run on frequent Claude Code tool calls, so they stay in-process Node through `bin/hook-runner.mjs` and shared modules under `bin/`. This avoids an extra interpreter dependency and keeps the edit/write hot path fast.

**Why rules are plugin-local?**
Shipyard rules describe Shipyard's own state model and command behavior. Keeping them plugin-local avoids mutating user projects and keeps upgrades authoritative.

## Questions?

Open an issue or ask in the discussions tab.
