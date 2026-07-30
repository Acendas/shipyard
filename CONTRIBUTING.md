# Contributing to Shipyard

Thanks for your interest in Shipyard. This guide covers everything you need to get started.

## Development Setup

### Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI
- Python 3
- Git

### Clone and test locally

```bash
git clone https://github.com/acendas/shipyard.git
cd shipyard
```

Test by loading the plugin directly into a test project:

```bash
cd /path/to/test-project
claude --plugin-dir /path/to/shipyard
```

Then run `/ship-init` inside Claude Code to set up the test project.

After editing source files, run `/reload-plugins` inside Claude Code — no restart needed.

## Project Structure

```
shipyard/
├── .claude-plugin/
│   └── plugin.json              Plugin manifest
├── skills/*/                    Slash commands and capability skills
│   └── SKILL.md
├── agents/                      Subagent definitions (6 agents)
│   └── shipyard-*.md
├── bin/                         Node CLIs and hook modules
│   ├── shipyard-data.mjs
│   └── hooks/*.mjs
├── hooks/                       Hook configuration
│   └── hooks.json
├── project-files/               Templates and plugin-local references
│   ├── rules/shipyard-*.md      Plugin-local rules
│   └── templates/*.md           Markdown templates (9 templates)
├── tests/                       Eval framework
│   ├── eval-run.py
│   └── assertions/*.json
├── CLAUDE.md                    Development guidance for Claude Code
└── README.md
```

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
- Agents are spawned by skills (e.g., `ship-execute` spawns `shipyard-builder`)

### Rules (`project-files/rules/shipyard-*.md`)

Rules provide passive guidance for Shipyard's own skills and references. They stay plugin-local; `/ship-init` does not copy `shipyard-*.md` rules into the user's project.

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

Markdown templates with YAML frontmatter. Used by `/ship-init` and other skills to create new files.

## Running Tests

```bash
python3 tests/eval-run.py           # full eval
python3 tests/eval-run.py -v        # verbose
python3 tests/eval-run.py --skill ship-execute  # one skill
```

For hook scripts:
```bash
node --check bin/hook-runner.mjs
node --check bin/hooks/auto-approve-data.mjs
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
3. Run `python3 tests/eval-run.py` to verify
4. Test by loading plugin into a test project and trying affected commands
5. Open a PR with a clear description of what changed and why

## Architecture Decisions

**Why a Claude Code plugin?**
Plugins integrate natively — skills, agents, and hooks load automatically. No CLI needed, no manual file copying for the core tool. `/ship-init` handles project-specific setup (rules, scripts, templates).

**Why markdown files instead of a database?**
Shipyard state must survive Claude Code context resets (`/clear`). Files are the only durable medium. Markdown with YAML frontmatter is human-readable, git-diffable, and parseable.

**Why Node for hooks?**
Hooks run on frequent Claude Code tool calls, so they stay in-process Node through `bin/hook-runner.mjs` and shared modules under `bin/`. This avoids an extra interpreter dependency and keeps the edit/write hot path fast.

**Why rules are plugin-local?**
Shipyard rules describe Shipyard's own state model and command behavior. Keeping them plugin-local avoids mutating user projects and keeps upgrades authoritative.

## Questions?

Open an issue or ask in the discussions tab.
