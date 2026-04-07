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
├── skills/ship-*/               Slash commands (15 skills)
│   └── SKILL.md
├── agents/                      Subagent definitions (4 agents)
│   └── shipyard-*.md
├── hooks/                       Hook configuration
│   └── hooks.json
├── project-files/               Files copied into projects by /ship-init
│   ├── rules/shipyard-*.md      Path-scoped rules (7 rules)
│   ├── scripts/*.py             Python hook scripts (6 scripts)
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

Rules load automatically based on file path globs in their frontmatter (or `alwaysApply: true`). They provide passive guidance — Claude sees them when working in matching directories. Plugins can't ship rules directly, so `/ship-init` copies them into the project's `.claude/rules/`.

### Hook Scripts (`project-files/scripts/`)

Python scripts invoked by Claude Code's hook system. They receive JSON on stdin:

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
- Use atomic file writes (`tempfile.mkstemp` + `os.replace`) for state files

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
echo '{"tool_name":"Bash","tool_input":{"command":"git commit -m test"}}' | python3 project-files/scripts/tdd-check.py
echo $?  # should be 0
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

**Why Python for hooks?**
Python 3 ships with macOS and most Linux distributions. The scripts are simple (< 200 lines each) and have zero dependencies beyond the standard library.

**Why rules are project-local, not in the plugin?**
Claude Code plugins can't ship `.claude/rules/` files. Rules need path-scoped frontmatter relative to the project root, so they belong in the project anyway. `/ship-init` copies them from `project-files/rules/`.

## Questions?

Open an issue or ask in the discussions tab.
