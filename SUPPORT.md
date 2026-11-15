# Getting Help

Most problems are answered by one of three commands. Try them in this order.

```
/ship-help <your question>   answers from your project's own state
/ship-status                 checks the records and repairs what it safely can
/ship-status diagnose        shows where the data folder is and how it was found
```

## Before asking

1. Run `/ship-help` with your question. Shipyard can answer most questions about itself.
2. Run `/ship-status`. It finds and fixes common problems with its own records.
3. Check [existing issues](https://github.com/acendas/shipyard/issues). Someone may have hit the same problem.
4. Upgrading from 3.x? Read [UPGRADING.md](UPGRADING.md). 4.0.0 has breaking changes and a migration command.

## Where to ask

| Channel | Use for |
|---------|---------|
| [GitHub Discussions](https://github.com/acendas/shipyard/discussions) | Questions, ideas, show-and-tell |
| [GitHub Issues](https://github.com/acendas/shipyard/issues) | Bug reports, feature requests |
| Email, see [SECURITY.md](SECURITY.md) | Security problems. Do not open a public issue |

## Common issues

| What you see | What to do |
|---|---|
| The session crashed in the middle of a sprint | Run `/ship-execute` again. It first saves any work left in builder worktrees, then continues from its own record of what finished |
| A command says another one is running, but nothing is | Run the command again: a lock left by a session that was closed or crashed is taken over at once. If it still blocks, run `/ship-status`. It clears a lock older than two hours and, for a recent execution lock, asks whether that run is still going. A lock only ever stops a second copy of the same command |
| `/ship-quick` or `/ship-bug` is missing | Both were removed in 4.0.0. Describe the change or the bug to `/ship-discuss`; it proposes the right lane |
| Old records (`F001`, `B001`) after upgrading | They still work. To move to the new names, ask Claude to run `shipyard-data migrate --dry-run`, read the plan, then `shipyard-data migrate`. `shipyard-data migrate --reverse` undoes it. Finish and archive a running sprint first |
| A story will not enter a sprint | The message names the problem. Usually the plan score found a step that could run earlier or two steps of one wave on the same file (`shipyard-data sprint plan-score`), or a step's check already passes on today's code (`shipyard-data sprint probes-at-base`) |
| The build did not ask me anything | That is the 4.0.0 default (`execution.unattended`). Every decision it made for you is listed in the sprint review, where you can overturn it |
| Tests are not running | Check `test_commands` in the project's settings. Ask `/ship-help`, or have Claude run `shipyard-data config set test-commands-unit "<your command>"` |
| Records look out of date after a sprint | Run `/ship-status`. It runs `shipyard-data reconcile` and reports what it repaired. `shipyard-data doctor` checks the records and lists anything still wrong |
| The plugin is not loading | Add the Acendas marketplace and install with `claude plugin install shipyard@acendas`. Run `/reload-plugins` after manual edits |
| A rule seems not to apply after an upgrade | Restart your Claude Code sessions. Hooks are read when a session starts |

## What to include when reporting

- The `/ship-*` command you ran, and what you typed after it
- The message or the behaviour you did not expect
- The Shipyard version (`/ship-help what version is this`) and your Claude Code version
- Your operating system and shell
- The output of `/ship-status diagnose`
- Whether this is a new project, an upgraded one, or the middle of a sprint
