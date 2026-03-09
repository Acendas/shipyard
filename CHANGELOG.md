# Changelog

All notable changes to Shipyard are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/).

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
