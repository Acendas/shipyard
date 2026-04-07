# Getting Help

## Before asking

1. Run `/ship-help` — Shipyard can answer most questions about itself.
2. Check [existing issues](https://github.com/acendas/shipyard/issues) — someone may have hit the same problem.
3. Run `/ship-status` — it auto-detects and fixes common state issues.

## Where to ask

| Channel | Use for |
|---------|---------|
| [GitHub Discussions](https://github.com/acendas/shipyard/discussions) | Questions, ideas, show-and-tell |
| [GitHub Issues](https://github.com/acendas/shipyard/issues) | Bug reports, feature requests |

## Common issues

**"Session crashed mid-sprint"** — Run `/ship-execute` again. Shipyard auto-recovers: salvages worktree work, reads PROGRESS.md, and resumes from the last completed wave.

**"Execution lock won't clear"** — Run `/ship-status`. It detects stale locks and offers to clear them.

**"Tests aren't running"** — Check that `test_commands` is configured in your project config. Run `/ship-init` to reconfigure if needed.

**"Plugin not loading"** — Make sure you installed with `claude plugin add acendas/shipyard`. Run `/reload-plugins` after any manual edits.

## What to include when reporting

- The `/ship-*` command you ran
- The error message or unexpected behavior
- Your OS, shell, and Claude Code version
- Whether this is a fresh project or mid-sprint
