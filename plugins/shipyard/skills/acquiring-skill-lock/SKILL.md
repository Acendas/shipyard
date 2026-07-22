---
name: acquiring-skill-lock
description: Acquire a per-project lock for the current skill.
disable-model-invocation: true
---

# Acquiring a Skill Lock

Shipyard tracks one active skill per project at a time, in two lock files under the data dir:

- `<SHIPYARD_DATA>/.active-session.json` — held by **planning** skills (`/ship-discuss`, `/ship-sprint`, `/ship-quick`'s planning phase).
- `<SHIPYARD_DATA>/.active-execution.json` — held by **execution** skills (`/ship-execute`, `/ship-review`, `/ship-quick`'s execution phase).

These are mutually exclusive: a planning session in one terminal must release before an execution skill starts in another, and vice versa. The lock is what prevents two terminals from racing on the same sprint.

**v3.7.0: both files are CLI-owned.** `bin/skill-lock.mjs` (`shipyard-data lock acquire|release|check|status`) is the single writer. No skill body Reads or Writes these files directly anymore — the PreToolUse hook denies any model Write/Edit to either basename, same as the pipeline cursors. Run the CLI, act on its exit code and JSON stdout line, and echo its stderr text (block message or recovery note) verbatim to the user.

## The Lock Shape (for reference — never hand-construct this)

A held lock:

```json
{
  "skill": "ship-execute",
  "sprint": "sprint-007",
  "wave": 2,
  "started": "2026-05-08T14:23:00Z",
  "session_id": "01HXY1Z2A3B4C5D6E7F8G9H0J1",
  "cleared": null,
  "depth": 1
}
```

A released (soft-deleted) lock: `{"skill": null, "cleared": "<iso>"}` — the file is never `unlink`ed, only overwritten in place.

`depth` replaces the old ad-hoc "same-session re-entry, don't re-acquire" prose rule: `lock acquire` on an already-mine lock increments `depth` instead of duplicating the acquire, and `lock release` decrements it — the lock only fully releases (writes the sentinel) when depth reaches 0. This makes nested re-entry (e.g. `/ship-execute` invoking `/ship-status` for a pre-flight check) structurally safe without every skill having to reason about "am I the outermost caller."

`compaction_count` (a pre-v3.7.0 field) is gone — it was initialized but never incremented once the `post-compact` hook that used to bump it was retired, so the `/ship-execute` warning gated on it never fired. Do not resurrect it; a future context-pressure mechanism should be a new field, not this one.

## Session Identity

`session_id` is the Claude Code session ID: `CLAUDE_SESSION_ID` from the environment, or an explicit `--session <id>` flag. If BOTH are absent, the CLI call is **session-unverified** and degrades asymmetrically:

- **Acquiring** while unverified treats ANY fresh held lock as held-by-another-session — even one whose own `session_id` is also null. Two different unverified callers must never silently adopt each other's lock.
- **Releasing** while unverified still succeeds when the held lock's `skill` field matches the `--skill` argument passed to release — the lower-risk direction, so it falls back to name-matching rather than hard-refusing.

Skill bodies should pass `CLAUDE_SESSION_ID` through normally (it's set in the environment already); no `--session` flag is needed in ordinary use.

## Using the CLI

- **Acquire**: `shipyard-data lock acquire <planning|execution> --skill <ship-*> [--sprint <id>] [--wave <n>]`. Exit 0 with `{"acquired":true,...}` on stdout — proceed. Exit 3 with a `⛔` block message on stderr when held by another live session — echo the stderr text verbatim as your entire response and STOP, no further tool calls. A stale (>2h) or corrupt held lock is recovered automatically; the CLI prints a one-line recovery note on stderr — echo it, then proceed.
- **Release**: `shipyard-data lock release <planning|execution> --skill <name>` on clean exit. Always exit 0 from the calling skill's perspective — held-by-another is a silent no-op, already-released is idempotent.
- **Check** (read-only, no side effects): `shipyard-data lock check <planning|execution>` — use when you need to know a lock's state without acquiring it (e.g. `/ship-debug`, `/ship-quick`'s pre-flight checks).
- **Status** (read-only, both locks in one call): `shipyard-data lock status` — used by `/ship-status`'s dashboard rendering.

Every acquire/release call automatically enforces the cross-lock mutual exclusion (planning vs. execution) in the same call — no separate "also check the other file" step is needed in skill bodies.

## Failure Modes (CLI behavior, not skill-body procedure)

- **Held by another live session** → `lock acquire` exits 3 with the block message on stderr. Echo it verbatim and stop.
- **Stale lock (>2h)** → the CLI recovers it automatically as part of `acquire`, emits `stale_lock_recovered` to the event log, and prints a one-line recovery note on stderr. Echo the note; do not re-implement staleness detection in the skill body.
- **Corrupt lock JSON** → the CLI recovers it automatically (treated like stale), emits `corrupt_lock_recovered` with a sanitized tail of the bad content, and prints a recovery note. Same handling as above.
- **Both locks held by different live sessions** (rare — can only arise from a pre-v3.7.0 hand-written file or a genuine race between two first-time acquisitions on the two different lock files) → `lock acquire` exits 3 with both block messages plus a hint to run `/ship-status` to clear one.
- **Lock path unwritable** (data dir permissions, disk full) → the CLI fails loud with the OS error; do not silently proceed without a lock.

## Bottom Line

- Run the CLI. Act on the exit code and the JSON line. Echo the stderr text.
- Never Read, parse, or Write either lock file directly — that's the deny-listed, CLI-owned surface now.
- Stale/corrupt recovery, cross-lock mutual exclusion, and re-entry depth are the CLI's job, not the skill body's.
