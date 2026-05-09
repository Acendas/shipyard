---
name: acquiring-skill-lock
description: Use at the entry of any Shipyard command skill that mutates project state — /ship-execute, /ship-discuss, /ship-sprint, /ship-review, /ship-init. Prevents two terminals on the same repo from racing on the same sprint or spec. Returns acquired or refused with the holder's identity so the caller can proceed or surface a clean "another session is active" message.
disable-model-invocation: true
---

# Acquiring a Skill Lock

Shipyard tracks one active skill per project at a time, in two lock files under the data dir:

- `<SHIPYARD_DATA>/.active-session.json` — held by **planning** skills (`/ship-discuss`, `/ship-sprint`, `/ship-spec`).
- `<SHIPYARD_DATA>/.active-execution.json` — held by **execution** skills (`/ship-execute`, `/ship-review`).

These are mutually exclusive: a planning session in one terminal must release before an execution skill starts in another, and vice versa. The lock is what prevents two terminals from racing on the same sprint.

## The Lock Contract

A held lock is a JSON object with this shape:

```json
{
  "skill": "ship-execute",
  "sprint": "sprint-007",
  "wave": 2,
  "started": "2026-05-08T14:23:00Z",
  "session_id": "01HXY1Z2A3B4C5D6E7F8G9H0J1",
  "cleared": null,
  "tracks_compaction_pressure": true,
  "compaction_count": 0
}
```

A released (soft-deleted) lock has the same path but content `{"skill": null, "cleared": "<iso>"}`. We never `unlink` the file — soft-delete keeps the file on disk for diagnosability and avoids races where another process reads the file between unlink and create.

`session_id` is the Claude Code session ID (read from hook input field `session_id` or, in skill bodies, from the `CLAUDE_SESSION_ID` env var). It is the **identity stamp**: a hook or skill in a different session that sees a held lock with a non-matching `session_id` knows the lock belongs to someone else and exits 0 instead of blocking. This is the Ralph Loop pattern adapted to Shipyard.

## Acquire Procedure

When a skill enters and needs the lock:

1. **Determine the lock path.** Planning skills target `.active-session.json`; execution skills target `.active-execution.json`. Always use the literal `<SHIPYARD_DATA>` path from the context block — no `~`, no shell vars in `file_path`.

2. **Read the lock file with the `Read` tool.** Three branches:

   a. **File does not exist** → no active lock. Skip to step 4 (write).

   b. **File exists, `cleared` is set OR `skill` is `null`** → previous holder released cleanly. Skip to step 4.

   c. **File exists, `cleared` is null, `skill` is non-null** → potentially active. Continue to step 3.

3. **Decide held vs stale vs ours.** Parse the JSON:

   - **`session_id` matches the current session's ID** → it's our own lock from earlier in this skill (re-entry, e.g., resume after `/clear`). Treat as held by us; skip to step 5.
   - **`started` is older than 2 hours** → stale lock from a crashed session. Print a one-line recovery message: `(recovered stale {skill} lock started {N}h ago)`. Continue to step 4 (overwrite).
   - **Otherwise** → genuinely held by another live session. **HARD BLOCK.** Print:
     ```
     ⛔ {skill}-class lock active in another session.
        Skill:      {skill from file}
        Sprint:     {sprint, if present}
        Started:    {started}
        Session ID: {session_id from file}

     Finish or pause that session first, or run /ship-status to clear a stale lock.
     ```
     Stop. Do not load further context, do not call other tools.

4. **Write the lock.** Use the `Write` tool to overwrite the lock file with the JSON shape above:
   - `skill`: the entering skill's name (e.g., `ship-execute`).
   - `sprint`: current sprint ID if applicable (else null).
   - `wave`: current wave number for execution skills (else null).
   - `started`: current ISO 8601 timestamp.
   - `session_id`: current Claude Code session ID.
   - `cleared`: null.
   - `tracks_compaction_pressure`: true for `ship-execute` (long-running), else false.
   - `compaction_count`: 0.

5. **Cross-lock guard.** Before proceeding, also Read the *other* lock file (planning vs execution). If it shows held with a non-matching session_id and not stale, hard-block as in step 3 — planning and execution are mutually exclusive. If it shows our session, that's the same Claude session re-entering through a different command — usually fine, but flag in the report so the user understands why the previous skill's state may still be present.

## Release Procedure

When the skill exits cleanly (sprint completion, pause, finished planning, or skill returns):

1. Use `Write` to overwrite the lock file with `{"skill": null, "cleared": "<current ISO 8601>"}`. The soft-delete sentinel.

2. Cross-skill counters (e.g., `compaction_count`) live as fields on the lock object. They die with the soft-delete — no separate reset step needed. This is intentional: the counter belongs to the lock's lifetime, not the project's.

3. **Do not delete the file.** Other inspections (`/ship-status`, future skill entries) read the soft-deleted shape and treat it as released. Deletion would race with a concurrent inspection.

## Re-Entry Within the Same Session

If your skill calls into another Shipyard command (e.g., `/ship-execute` invokes `/ship-status` for a pre-flight check, or `/ship-review` chains into `/ship-discuss` for retro), the inner skill MUST:

1. Read the relevant lock.
2. If the held lock's `session_id` matches the current session, **do not re-acquire**. The outer skill owns the lock. Proceed without writing to it. Do not soft-delete on inner exit.
3. If session IDs differ, hard-block as in the standard acquire procedure.

This avoids the bug where a nested skill clears a lock its parent still depends on.

## Stale Lock Recovery

A "stale" lock is one whose `started` is more than 2 hours old. The implicit assumption: no Shipyard skill should run continuously for >2 hours; if it has, the session almost certainly crashed.

When recovering a stale lock:

- Print the one-line recovery message so the user knows what happened.
- Overwrite the lock with the new session's data (step 4 of acquire).
- Emit a `stale_lock_recovered` event to the structured event log via `shipyard-data events emit stale_lock_recovered prior_session_id=<id> prior_skill=<skill> prior_age_hours=<N>`. This makes the recovery observable in `/ship-status diagnose`.

If the user wants to use a longer-than-2h skill (rare, but possible for very large sprints), they override by running with explicit consent — that's a future feature; for now, 2h is the bright line.

## Why session-ID Stamping Matters

Without it, a held lock blocks every session on the same project regardless of which session acquired it. The customer scenario this fixes:

- Terminal A runs `/ship-discuss`. Lock held with no session_id (legacy behavior).
- Terminal B opens a new session in the same project, intends to run `/ship-status` (read-only).
- A hook fires in Terminal B, reads the held lock, blocks the tool call. User confused: "Why is Shipyard blocking me? I'm not even running it."

With session_id stamping, Terminal B's hooks see "lock held by session X, but I'm session Y — not mine" and exit 0. Terminal A still owns its lock; nothing weird happens.

This is the same primitive Ralph Loop's Stop hook uses: state file embeds the session ID, hooks compare, mismatched sessions ignore the state. The pattern is proven and trivially small.

## Failure Modes to Surface, Not Hide

- **Lock JSON is corrupt:** treat as stale-and-recover; emit `corrupt_lock_recovered` event with the raw content tail.
- **Two locks held simultaneously** (planning + execution both non-null, different session IDs, both fresh): rare but possible after partial recovery. Hard-block both, print both, ask the user to choose which to clear via `/ship-status`.
- **Lock path unwritable** (data dir permissions, disk full): fail loud with the OS error. Do not silently proceed without a lock — that re-introduces the race condition the lock exists to prevent.

## Bottom Line

- Acquire on entry. Release on exit. Stamp the session ID.
- Stale at 2h. Soft-delete on release.
- Same-session re-entry never re-acquires.
- Mismatched session ID never blocks.

These four rules cover every concurrency scenario Shipyard has hit in production. Don't add a fifth without evidence.
