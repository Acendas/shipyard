# Changelog

All notable changes to Shipyard are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Live verification capture via `shipyard-logcap`.** New primitive in `plugins/shipyard/bin/` that wraps an arbitrary verification command, tees raw stdout+stderr to a rotating file in `$TMPDIR/shipyard/<project-hash>/<session>/`, and propagates the child's exit code. Subcommands: `run`, `tail`, `grep`, `list`, `path`, `probe`, `prune`. Cross-platform (Node `.mjs` + symlink-aware `.sh` wrapper + Windows `.cmd` wrapper).
  - **Why it exists:** when reviewing a sprint or debugging a flaky repro, the moment live output passes through a grep or a filtered tail the unfiltered stream is gone. If the filter was wrong or missed a signal, the only recourse is to re-run the command — burning tokens, wall-clock time, and sometimes device/cloud minutes. `shipyard-logcap` lets the orchestrator re-analyze from the captured file instead, which costs almost nothing. The three skills that do live verification (`ship-execute`, `ship-review`, `ship-bug`) now point Claude at the primitive at the exact moments it matters.
  - **Primitive is intentionally dumb.** No log parsing, keyword classification, platform-specific sources, or auto-tuning. The smart layer is the orchestrator: `skills/ship-execute/references/live-capture.md` teaches Claude the principle (capture once, analyze many), the re-analysis loop, a decision table for picking `--max-size` / `--max-files` per command profile, stack-neutral examples, redaction warnings, and failure modes. Skills pick bounds by reasoning over project context, not by magic inside the binary.
  - **Storage is project-local-by-hash in tmp**, not in the plugin data dir and not inside the project tree. Reuses `shipyard-resolver.mjs` for worktree-aware project-hash computation, so all worktrees of one project share one capture dir (matching plugin-data semantics).
  - **Session grouping:** `ship-execute` sets `SHIPYARD_LOGCAP_SESSION=<sprint-id>-wave-<N>` so each wave's captures land under one session folder, keeping `shipyard-logcap list` readable across a multi-wave sprint.
  - **Minimum `--max-size` is 64K**, matching Node's child-process pipe high-water mark so a single chunk can't silently overflow the ceiling beyond one chunk's worth. Lower values are rejected with a clear error.
  - **Security:** strict allowlist on capture names (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, no path traversal, no reserved `.lock` suffix), same shape on `SHIPYARD_LOGCAP_SESSION`. No `shell:true` on child spawn. Fail-loud on resolver errors (no phantom capture dirs). Breadcrumb log at `$TMPDIR/shipyard/<hash>/.logcap.log` mirrors the `.auto-approve.log` pattern — capped, rotated, errors swallowed so diagnostics never break capture.
  - **`shipyard-context diagnose` now surfaces logcap activity** (recent breadcrumb tail and active sessions) so self-serve bug reports include capture history without the user needing to know where tmp is on their platform.
- New reference doc: `skills/ship-execute/references/live-capture.md` (canonical guide, shared by all three modified skills via `${CLAUDE_PLUGIN_ROOT}`).
- New test module: `tests/test_shipyard_logcap.py` (29 tests covering run semantics, rotation, name allowlist, bounds validation, read subcommands, probe, prune, and project isolation).
- Assertions added to `tests/assertions/ship-execute.json`, `ship-review.json`, `ship-bug.json` covering the live-capture integration in each skill.

### Changed
- `ship-execute` SKILL.md gained a "Live Verification Capture" top-level section and a per-wave `SHIPYARD_LOGCAP_SESSION` export note in Step 2.
- `ship-review` SKILL.md Stage 2 now wraps dev-server and E2E observation commands through `shipyard-logcap` and prefers grepping the capture before re-running anything — review re-runs are the most expensive kind.
- `ship-bug` SKILL.md HOTFIX mode now wraps the repro command, since bug repros are often flaky and re-triggering them is the most expensive part of debugging.

## [0.9.0] - 2026-04-05

### Added
- Marketing-focused README with "Why Shipyard" comparison, token efficiency, and project learning sections
- Community files: CODE_OF_CONDUCT.md, SECURITY.md, SUPPORT.md, CHANGELOG.md
- GitHub issue templates (bug report, feature request) and PR template
- CI workflow for eval tests
- `.editorconfig` and `.gitattributes` for contributor consistency
- `shipyard-context` script for token-efficient context loading with hard line caps
- Reference files for ship-discuss: communication-design.md, simplification-scan.md
- Reference file for ship-execute: lsp-strategy.md

### Changed
- README rewritten with stronger positioning and sales copy
- Safety Nets section rewritten with adversarial trust model framing

## [0.8.5] - 2026-03-31

### Added
- Auto-approve hook for Shipyard data file writes (zero permission prompts)
- `auto-approve-data.py` script with path-scoped approval

### Fixed
- Permission prompt interruptions during sprint execution

## [0.8.4] - 2026-03-28

### Added
- Workarounds for Claude Code agent team and worktree bugs
- `cwd-restore.py` hook to fix agent directory context after spawning

## [0.7.0] - 2026-03-20

### Added
- Critic agent — adversarial pre-approval review with pre-mortem analysis
- Plan mode expansion — 7 skills now use EnterPlanMode/ExitPlanMode
- Handover files for crash recovery
- Compaction counter and auto-pause at 3 compactions

### Fixed
- Crash recovery for orphaned worktrees with uncommitted work

## [0.6.0] - 2026-03-10

### Changed
- Major restructure — converted to Claude Code plugin architecture
- All data moved to plugin data directory (zero git noise)
- Skills use `shipyard-data` script for path resolution

### Removed
- `.shipyard/` project directory (replaced by plugin data)
- Homebrew distribution (replaced by `claude plugin add`)

## [0.5.0] - 2026-02-28

### Added
- Sprint velocity tracking and retrospective data persistence
- Carry-over scan for bugs, blocked tasks, and retro items
- Metrics.md for cross-sprint learning
- Anti-pattern detection in retros

[0.9.0]: https://github.com/acendas/shipyard/compare/v0.8.5...v0.9.0
[0.8.5]: https://github.com/acendas/shipyard/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/acendas/shipyard/compare/v0.7.0...v0.8.4
[0.7.0]: https://github.com/acendas/shipyard/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/acendas/shipyard/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/acendas/shipyard/releases/tag/v0.5.0
