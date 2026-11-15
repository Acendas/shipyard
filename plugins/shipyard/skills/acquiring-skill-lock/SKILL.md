---
name: acquiring-skill-lock
description: Acquire a per-project lock for the current skill.
disable-model-invocation: true
---

# Acquiring a Skill Lock

Shipyard keeps one lock per command family, in three lock files under the data dir. **A lock stops a second copy of the same command. It never stops a different command** (4.17).

| Lock | File | Held by |
|---|---|---|
| `discuss` | `.active-discuss.json` | `/ship-discuss`. Its capture and hotfix lanes run lock-free |
| `planning` | `.active-session.json` | `/ship-sprint` |
| `execution` | `.active-execution.json` | `/ship-execute` (incl. `--task`/`--hotfix`), `/ship-review`, the fix phase of `/ship-debug`: they all act on the working tree and the current sprint, one at a time |

So a discussion runs beside planning and beside a sprint, and the next sprint is planned while the current one executes. What keeps them apart is where they write, not the lock: the running sprint (`sprints/current/`, its stories and steps) is read-only to everyone else, and a sprint planned ahead lives in `sprints/next/` (`ship-sprint/references/draft-ahead.md`). Each command's startup context names what is running beside it (`SHIPYARD_RUNNING_BESIDE=`). A caller that still asks for `planning --skill ship-discuss` gets the `discuss` lock.

**Both files are CLI-owned.** `bin/skill-lock.mjs` (`shipyard-data lock acquire|release|check|status`) is the single writer. No skill body Reads or Writes these files directly — the PreToolUse hook denies any model Write/Edit to either basename, same as the pipeline cursors. Run the CLI, act on its exit code and JSON stdout line, and echo its stderr text (block message or recovery note) verbatim to the user.

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

There is no compaction counter field; a context-pressure mechanism needs its own new field.

## Session Identity

`session_id` is the Claude Code session ID: `CLAUDE_SESSION_ID` from the environment, or an explicit `--session <id>` flag. If BOTH are absent, the CLI call is **session-unverified** and degrades asymmetrically:

- **Acquiring** while unverified treats ANY fresh held lock as held-by-another-session — even one whose own `session_id` is also null. Two different unverified callers must never silently adopt each other's lock.
- **Releasing** while unverified still succeeds when the held lock's `skill` field matches the `--skill` argument passed to release — the lower-risk direction, so it falls back to name-matching rather than hard-refusing.

Skill bodies should pass `CLAUDE_SESSION_ID` through normally (it's set in the environment already); no `--session` flag is needed in ordinary use.

## Using the CLI

- **Acquire**: `shipyard-data lock acquire <planning|execution|discuss> --skill <ship-*> [--sprint <id>] [--wave <n>]`. Exit 0 with `{"acquired":true,...}` on stdout — proceed. Exit 3 with a `⛔` block message on stderr when held by another live session — echo the stderr text verbatim as your entire response and STOP, no further tool calls. A stale (>2h) or corrupt held lock is recovered automatically; the CLI prints a one-line recovery note on stderr — echo it, then proceed.
- **Release**: `shipyard-data lock release <planning|execution|discuss> --skill <name>` on clean exit. Always exit 0 from the calling skill's perspective — held-by-another is a silent no-op, already-released is idempotent.
- **Check** (read-only, no side effects): `shipyard-data lock check <planning|execution|discuss>` — use when you need to know a lock's state without acquiring it (e.g. `/ship-debug`'s pre-flight check).
- **Status** (read-only, both locks in one call): `shipyard-data lock status` — used by `/ship-status`'s dashboard rendering.

Every acquire/release call automatically enforces the cross-lock mutual exclusion (planning vs. execution) in the same call — no separate "also check the other file" step is needed in skill bodies.

## Failure Modes (CLI behavior, not skill-body procedure)

- **Held by another live session** → `lock acquire` exits 3 with the block message on stderr. Echo it verbatim and stop.
- **Stale lock (>2h)** → the CLI recovers it automatically as part of `acquire`, emits `stale_lock_recovered` to the event log, and prints a one-line recovery note on stderr. Echo the note; do not re-implement staleness detection in the skill body.
- **Corrupt lock JSON** → the CLI recovers it automatically (treated like stale), emits `corrupt_lock_recovered` with a sanitized tail of the bad content, and prints a recovery note. Same handling as above.
- **Both locks held by different live sessions** (rare — can only arise from a hand-written file or a genuine race between two first-time acquisitions on the two different lock files) → `lock acquire` exits 3 with both block messages plus a hint to run `/ship-status` to clear one.
- **Lock path unwritable** (data dir permissions, disk full) → the CLI fails loud with the OS error; do not silently proceed without a lock.
