# Contributing to Shipyard

Thanks for your interest in Shipyard. In short: change the plugin under `plugins/shipyard/`, add a check for the behaviour you changed, run the three test commands below, and open a pull request.

```
edit a skill, agent, hook or CLI ──► add or update its check ──► run the tests ──► try it in another project ──► pull request
```

## Development setup

### What you need

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- Node.js (CI uses Node 20). The plugin's CLIs, hooks and most tests are Node programs
- Python 3 (CI uses 3.10 and 3.12), for the eval runner and the Python tests only
- Git

### Clone and try it

```bash
git clone https://github.com/acendas/shipyard.git
cd /path/to/another-project
claude --plugin-dir /path/to/shipyard/plugins/shipyard
```

Then run `/ship-status` in that session. The first run sets the test project up.

- After editing a skill or an agent, run `/reload-plugins`. No restart is needed.
- After editing a hook or `hooks/hooks.json`, restart the session. Hooks are read when a session starts.
- **Do not run Shipyard on its own repository.** Test in a throwaway project or another real one.

## Project structure

```
shipyard/
├── README.md  UPGRADING.md  CONTRIBUTING.md  SUPPORT.md  SECURITY.md
├── docs/milestones-4.0.md        history of the changes inside 4.0.0
├── .github/                      CI workflow, issue and pull request templates
└── plugins/shipyard/             the plugin itself
    ├── .claude-plugin/plugin.json    manifest (name, version)
    ├── skills/<name>/SKILL.md        30 skills: 9 commands (ship-*) and 21 internal ones
    │   └── references/*.md           longer instructions a skill reads when it needs them
    ├── agents/shipyard-*.md          7 agents
    ├── hooks/hooks.json              which hook runs on which event
    ├── bin/                          Node programs
    │   ├── shipyard-data(.mjs/.cmd)      records and gates
    │   ├── shipyard-context(.mjs/.cmd)   reads for the commands
    │   ├── shipyard-logcap(.mjs/.cmd)    captures the output of a long run
    │   ├── hook-runner.mjs               starts a hook module
    │   ├── hooks/*.mjs                   6 hook modules
    │   └── vocab.mjs                     the one table of names, ids and folders
    ├── project-files/
    │   ├── rules/shipyard-*.md       4 rules; they stay in the plugin
    │   ├── templates/                11 templates for the files Shipyard creates
    │   └── references/               3 guides the skills read
    ├── workflows/*.js                2 optional review workflows
    └── tests/                        eval runner, assertions, Node and Python tests
```

## Running the tests

Run all three from the repository root before you open a pull request. CI runs the first two.

| Command | What it checks |
|---|---|
| `python3 plugins/shipyard/tests/eval-run.py` | Every skill, agent, hook and template against the written rules, and the Node tests. Add `-v` for detail or `--skill ship-execute` for one skill |
| `python3 -m pytest plugins/shipyard/tests/` | The Python tests |
| `node --test plugins/shipyard/tests/test_*.mjs` | The Node tests on their own (quicker when you are working on a CLI) |

For one hook or CLI file, `node --check plugins/shipyard/bin/hooks/auto-approve-data.mjs` catches syntax errors.

## What to work on

### Skills (`skills/<name>/SKILL.md`)

A skill is a Markdown file with a short header (YAML frontmatter) and instructions.

| Rule | Why |
|---|---|
| `name` is the folder name, lowercase with hyphens | The folder name is the command. The eval checks it |
| `description` is one short instruction of 5 to 10 words | It is shown as the label in the command picker |
| An internal skill sets `disable-model-invocation: true` | It must not appear in the picker. The eval checks it |
| Keep `SKILL.md` under 500 lines; move detail to `references/` | The whole file is loaded every time the command runs |
| Shell lines that load context call only `shipyard-context`, `shipyard-data` or `shipyard-logcap` | `head`, `cat`, `grep` and friends do not exist or behave differently on Windows |
| No `mktemp`, `readlink -f`, `stat -c` or similar in shell examples | Same reason. The eval lists the tokens it refuses |
| No model name written into a skill that starts an agent | Models come from the project's settings |
| Use the 4.0.0 words: story, step, task, idea, epic | `tests/test_retired_terms.mjs` fails on a retired word in a skill, agent or rule |

Other header fields in use: `allowed-tools`, `argument-hint`, `model`, `effort`. Skills read project state through `` !`shipyard-context …` `` lines, never through a path written into the skill. `$ARGUMENTS` is what the user typed after the command.

### Agents (`agents/shipyard-*.md`)

The header has `name`, `description` and `tools`; the body is the agent's instructions. Agents are started by the matching internal skill (for example `dispatching-task-loop` starts `shipyard-disciplined-builder`), and that skill checks what the agent returns. The agent does the work; the skill and the CLI decide whether it counts.

If you add or remove an agent, update the count and the names in `README.md`. The eval compares them with this folder.

### The CLI (`bin/*.mjs`)

- A rule that matters is a CLI check or a hook, with a test. A sentence in a skill is not enforcement.
- State files have one writer: the CLI. Skills call `shipyard-data …`; they do not edit progress files, sprint or story headers, or locks.
- Names, id shapes and folders come from `bin/vocab.mjs`. Do not spell them again in another file.
- A check belongs on a decision, not on writing something down. Recording a finding must always succeed.
- No Python under `bin/`. The plugin needs only Node at run time; the eval checks this.

### Hooks (`hooks/hooks.json` and `bin/hooks/<name>.mjs`)

A hook is wired in two places: an entry in `hooks/hooks.json`, and a module in `bin/hooks/` that exports `run(hookInput, env)` and returns an exit code. `bin/hook-runner.mjs` reads the JSON that Claude Code sends, for example:

```json
{
  "tool_name": "Edit",
  "tool_input": {"file_path": "/path/to/file.md"}
}
```

- To refuse a tool call, write a `permissionDecision: "deny"` answer with a reason to stdout (see `bin/hooks/unattended-ask.mjs`). Diagnostics go to stderr.
- `worktree-branch` prints only the worktree path to stdout. Anything else there breaks it.
- Hooks run on frequent tool calls. Keep the work small and in-process, and use the helpers in `bin/_hook_lib.mjs` for path checks, logs, atomic writes and lock files.
- A hook that only records things must not block when it fails.

### Templates and rules (`project-files/`)

Templates are Markdown files with a YAML header, used when Shipyard creates a new file. Every setting and its default is in `templates/config.md`, with a one-line comment; `README.md` has a shorter table. Keep the two in step when you add a setting. Rules stay in the plugin; setup does not copy them into the user's project.

## Conventions

### Commits

```
type(scope): description
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`. The scope is optional: `skill`, `agent`, `rule`, `hook`, `plugin`, `template`, `docs`. Say why, not only what.

### What does not belong in this repository

- No `CLAUDE.md` and no `.claude/` folder. Both are in `.gitignore`.
- No project data. Shipyard keeps its records outside the repository it works on.

### Documents

Write for a reader who may not be an engineer: the answer first, then a picture, a table or an example, then only the text that is needed. Count anything you state as a number.

## Pull requests

1. Fork the repository and create a branch.
2. Make the change, and add or update its check: an assertion in `tests/assertions/<skill>.json` for a skill, a test file for a CLI or hook.
3. Run the three test commands above.
4. Load the plugin into another project and try the commands you touched.
5. Open a pull request that says what changed and why.

## Design decisions

**Why a Claude Code plugin?**
Skills, agents and hooks load on their own. There is nothing else to install, and the first `/ship-status` sets a project up.

**Why Markdown files instead of a database?**
Shipyard's state must survive a cleared conversation (`/clear`). Files are the only durable medium. Markdown with a YAML header can be read by a person and by a program.

**Why Node for hooks and CLIs?**
Hooks run on frequent tool calls, so they run in-process through `bin/hook-runner.mjs`. One runtime also keeps Windows working without a second interpreter.

**Why do rules stay in the plugin?**
They describe Shipyard's own state and commands. Keeping them in the plugin avoids changing the user's project, and an upgrade replaces them in one place.

**Why is the data outside the project?**
Planning records do not show up in the user's git history, and they cannot be committed by accident.

## Questions?

See [SUPPORT.md](SUPPORT.md), open an issue, or ask in the discussions tab.
