# Upgrading Shipyard

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

## Older versions

Pre-2.0 in-project `.shipyard/` directories were migrated by 1.x's `/ship-init`. If you're upgrading from a much older version that still has `.shipyard/`, install 1.12.x first to migrate, then upgrade to 2.0.
