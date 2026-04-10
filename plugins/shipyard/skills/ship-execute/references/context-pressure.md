# Context Pressure Counter — Contract

This is the single source of truth for how Shipyard tracks auto-compaction during a sprint. If you are reading hook code, a skill body, or tests and you disagree with this file, fix the drift here first and then update the implementation — not the other way around.

## Why this exists

Claude Code auto-compacts the conversation when its context window fills. Each compaction is a **lossy summarisation**: fine-grained tool-call history, intermediate reasoning, and partial file reads are collapsed into a few summary paragraphs. After several compactions in the same session, Claude is operating on a summary of a summary of a summary and the loss accumulates — you start to see forgotten file paths, wrong variable names, and confident hallucinations about code that does not exist.

The counter exists to detect this quality degradation and recommend a fresh session **before** Claude starts making things up mid-sprint. It is a **quality hygiene** signal, not a quota signal. On 1M-context models rate limits hit long before compaction does — this counter is about working-memory fidelity, not about running out of tokens.

## The previous design (and why it was broken)

Before April 2026 the counter lived in its own sentinel file, `<SHIPYARD_DATA>/.compaction-count`. The PostCompact hook incremented it on every compaction that occurred while any `.active-execution.json` lock was held, and `ship-execute` reset it at the start of each sprint.

The failure mode: **any skill that wrote `.active-execution.json` leaked increments into the counter.** `ship-quick` writes a lock and never touched `.compaction-count`; `ship-debug` reads the lock; `ship-bug` may in future. Each compaction during one of those skills bumped a counter that nothing in those skills owned or reset. The cruft survived across sessions and, when a real sprint eventually started, `ship-execute`'s reset step would *usually* zero the file — but any crash-recovery path that skipped step 1 carried the cruft through, and the first real compaction tripped the auto-pause at ~60% of a 1M context window. The user never had three genuine compactions; they had two dead-session ghosts plus one real one.

The real bug was an **abstraction boundary error**: the hook treated the counter as a plugin-wide concept, while only one skill consumed it.

## The current design

The counter lives **inside the execution lock**, as a field on `.active-execution.json`:

```json
{
  "skill": "ship-execute",
  "sprint": "S001",
  "wave": "2",
  "started": "2026-04-07T17:10:00Z",
  "tracks_compaction_pressure": true,
  "compaction_count": 0
}
```

Two fields are relevant:

- **`tracks_compaction_pressure: true`** — the opt-in flag. A skill that wants pressure tracking sets this when it creates its lock. Skills without the flag (`ship-quick`, `ship-bug`, `ship-debug`, anything future) are automatically excluded by construction — the hook will not mutate their locks.
- **`compaction_count`** — the count itself, managed by the hook. Skills read it at wave boundaries but should not write it directly during normal operation (the hook owns the write path; see "Reset" below for the one exception).

### Opt-in by default is OFF

This is deliberate. Compaction tracking is only meaningful for skills that (a) run long enough for multiple compactions to plausibly fire, and (b) have a natural wave-boundary checkpoint at which a pause is cheap. `ship-execute` qualifies. `ship-quick` does not (too short). `ship-debug` does not (read-only investigation, compaction is fine). If you add a new long-running execution skill, opt it in explicitly by setting the flag when it writes its lock.

### Lifecycle

| Event | Who does it | Effect on the counter |
|---|---|---|
| Skill creates lock with `tracks_compaction_pressure: true` | Skill body (ship-execute step 1) | Counter initialised to `0` as part of the lock write |
| Claude Code auto-compacts | Claude Code fires PostCompact → `post-compact.mjs` | Hook reads lock, checks flag, increments `compaction_count` in place, atomic-writes lock |
| Skill checks pressure | Skill body (ship-execute at wave boundary) | Read-only: parse lock, read `compaction_count` |
| Skill clears lock on pause / completion / auto-pause | Skill body writes `{"skill": null, "cleared": "..."}` | Counter dies with the old lock object — the soft-delete sentinel has no `compaction_count` field, so it effectively resets to zero without a separate write |
| Subsequent compaction on cleared lock | Hook | No-op. Hook checks `cleared` / `skill === null` before incrementing. |
| Skill without the flag creates a lock | Skill body | Hook never touches the lock. `compaction_count` is never added. |

There is **no separate `.compaction-count` file** and **no separate reset step**. The counter is a field on the lock; it is born and dies with the lock. This is the single most important invariant of the design — every drift bug in the old design stemmed from those two things living in separate files with separate lifecycles.

### Reset

The only "reset" is clearing the lock. You do not write `compaction_count: 0` by itself. Three cases:

1. **Normal sprint start** — the new lock is written with `compaction_count: 0` inline. No extra step.
2. **Pause / completion** — the lock is overwritten with the cleared sentinel `{"skill": null, "cleared": "..."}`. The counter field vanishes with the old lock. On the next `/ship-execute` start, the new lock begins at `compaction_count: 0`.
3. **Auto-pause** — same as (2). The auto-pause step overwrites the lock with the cleared sentinel as part of writing HANDOFF.md. The next resume starts clean.

If you ever find yourself wanting to "reset the counter without clearing the lock," stop — the lock and the counter are conceptually the same object. Wanting to reset one without the other means you have a stale lock problem, not a counter problem, and the fix is to clear the lock properly.

## Thresholds

Current values (see `post-compact.mjs` constants and `ship-execute/SKILL.md` wave-boundary check):

| Count | Behaviour | Rationale |
|---|---|---|
| 1–3 | Silent note in wave report | Normal long-sprint operation. One to three compactions is expected on a 50+ task sprint; working memory is still coherent. |
| 4 | Warn in wave report | Working memory is measurably degraded — the summary now contains summaries of summaries. Give the user a heads-up. |
| 5+ | Auto-pause at the next wave boundary | Beyond this, hallucination risk is high enough that continuing is strictly worse than a fresh resume. Paused work is recoverable; corrupted work is not. |

Shipyard targets 1M-context Claude models — both Opus and Sonnet are generally available with 1M windows, and there is no 200k fallback to support. The thresholds are hardcoded as module constants in `post-compact.mjs` (`COMPACTION_WARN_AT`, `COMPACTION_PAUSE_AT`) and should stay hardcoded unless a future model changes compaction semantics enough to warrant re-tuning.

The thresholds deliberately sit well above where they used to (warn 2 / pause 3) because:

- 1M context plus Shipyard's lean orchestrator design (delegation to subagents, file-backed state) means far fewer compactions per hour of wall-clock work than the old 200k era.
- The old thresholds were calibrated for a world where compaction pressure correlated with quota exhaustion. That conflation is no longer true on 1M plans — rate limits hit first, and compaction is purely a working-memory fidelity signal.
- Auto-pausing a sprint mid-flow is disruptive — the cost of a false positive is high. Raising the bar trades slightly later fidelity warnings for far fewer spurious pauses.

## Wording

The user-facing messages at the warn and pause thresholds talk about **working memory** and **conversation history being reconstructed** — not about quota, not about running out of tokens. The old "pause before quota runs out" framing from the 200k era is incorrect on 1M and has been removed.

If you touch the copy, keep it grounded in the real signal: "Claude has lost conversation context N times and is rebuilding from files." That is what the counter actually measures.

## Files

- `bin/hooks/post-compact.mjs` — the hook that increments the counter. Gates on `tracks_compaction_pressure`. Defines `COMPACTION_WARN_AT` and `COMPACTION_PAUSE_AT` constants.
- `skills/ship-execute/SKILL.md` — Execution Lock step sets `tracks_compaction_pressure: true` and `compaction_count: 0` on lock creation. Wave-boundary step reads `compaction_count` from the lock and applies the thresholds.
- `skills/ship-quick/SKILL.md`, `skills/ship-bug/SKILL.md`, `skills/ship-debug/SKILL.md` — deliberately do **not** set the flag. Their locks are invisible to the counter. Do not add the flag without thinking through whether their workflows actually benefit from auto-pause.
- `tests/assertions/ship-execute.json` — asserts the lock carries the flag and the wave-boundary check reads from the lock.
- `tests/assertions/ship-quick.json` — asserts ship-quick does NOT reference the counter (negative assertion — catches regressions where someone copy-pastes ship-execute's lock template).
- `tests/test_hook_runner.mjs` — end-to-end tests that exercise the hook against a ship-execute lock (counter increments) and a ship-quick lock (counter untouched).

## If the counter ever seems wrong

Read the lock directly: `cat <SHIPYARD_DATA>/.active-execution.json`. The `compaction_count` field is the authoritative value. If it disagrees with the wave report, the wave-boundary read path has drifted and needs fixing. If the counter is climbing during a non-ship-execute run, the opt-in gate in the hook has drifted and needs fixing. In both cases, re-read this file before patching — the contract lives here.
