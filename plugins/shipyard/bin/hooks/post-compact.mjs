/**
 * PostCompact hook: re-inject sprint context and track compaction pressure.
 *
 * After compaction, Claude loses conversation history but files persist.
 * This hook outputs a state summary and — for skills that opt in —
 * increments a compaction counter stored INSIDE `.active-execution.json`.
 *
 * Counter contract (single source of truth: `references/context-pressure.md`
 * in the ship-execute skill):
 *
 *   - The counter lives on the execution lock object as `compaction_count`.
 *   - A skill opts into pressure tracking by setting
 *     `tracks_compaction_pressure: true` on its lock.
 *   - The counter is incremented ONLY when the lock is held by such a skill.
 *   - The counter dies with the lock: when a skill clears its lock (writes
 *     `{"skill": null, "cleared": ...}`), the counter is gone. No separate
 *     reset step, no cross-skill leakage.
 *
 * This replaces the earlier `.compaction-count` sentinel file, which leaked
 * increments across skills because the hook fired on any execution lock but
 * only `ship-execute` read/reset the counter. `ship-quick` runs would
 * silently inflate the counter, and a subsequent `ship-execute` sprint could
 * auto-pause prematurely (at ~60% context on 1M) off the accumulated cruft.
 *
 * STDOUT CONTRACT: PostCompact stdout becomes a conversation message to
 * Claude. State summary and warnings go there intentionally.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, logEvent, resolveShipyardData } from "../_hook_lib.mjs";

const SAFE_VALUE_RE = /^[A-Za-z0-9._/-]{1,80}$/;

// Thresholds tuned for 1M-context models. Raise both by 1 for 200k if ever
// needed — the contract doc has the rationale.
const COMPACTION_WARN_AT = 4;
const COMPACTION_PAUSE_AT = 5;

function safeValue(s, fallback = "unknown") {
  if (typeof s !== "string") return fallback;
  if (SAFE_VALUE_RE.test(s)) return s;
  return fallback;
}

function readFrontmatterField(filepath, field) {
  try {
    const content = readFileSync(filepath, "utf8");
    const lines = content.split("\n");
    let inFm = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === "---" && !inFm) {
        inFm = true;
        continue;
      }
      if (line === "---" && inFm) break;
      if (inFm && line.startsWith(`${field}:`)) {
        return line
          .slice(field.length + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // file missing or unreadable
  }
  return null;
}

/**
 * Read the execution lock JSON. Returns `null` if the file is missing,
 * unreadable, or unparseable. Callers treat any of those as "no active
 * execution" and skip counter tracking.
 */
function readExecLock(execLockPath) {
  try {
    const raw = readFileSync(execLockPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Increment the `compaction_count` field inside the lock object and write
 * it back atomically. Returns the new count, or `null` if tracking is not
 * enabled on this lock.
 *
 * A skill opts in by setting `tracks_compaction_pressure: true` when it
 * creates the lock. Locks without the flag are untouched — the hook never
 * mutates their state — so ship-quick / ship-bug / ship-debug runs can
 * never pollute a counter they don't own.
 *
 * The `cleared`/null-skill soft-delete sentinel is also treated as
 * tracking-disabled, so the hook won't bump the counter on a cleared lock.
 */
function bumpLockCounter(execLockPath) {
  const lock = readExecLock(execLockPath);
  if (!lock || typeof lock !== "object") return null;
  if (lock.cleared || lock.skill === null || lock.skill === undefined) {
    return null;
  }
  if (lock.tracks_compaction_pressure !== true) return null;

  const prev = Number.isFinite(lock.compaction_count)
    ? Math.max(0, Math.trunc(lock.compaction_count))
    : 0;
  const next = prev + 1;
  const updated = {
    ...lock,
    compaction_count: next,
    last_compaction: new Date().toISOString(),
  };
  try {
    atomicWrite(execLockPath, JSON.stringify(updated, null, 2));
  } catch {
    // Best effort — if we can't persist the bump, report nothing (returning
    // null) rather than claim a count we didn't write. Losing a single
    // count is better than a phantom warning.
    return null;
  }
  return next;
}

export async function run(_hookInput, _env) {
  // Fail-loud per CLAUDE.md "Data Dir Discovery": if we cannot locate the
  // Shipyard data dir, return silently. Do NOT fall back to
  // `<cwd>/.shipyard` — that phantom path is exactly the "helpful fallback"
  // the repo rules forbid. No data dir → no state → nothing for this hook
  // to do.
  const shipyardData = await resolveShipyardData();
  if (!shipyardData) return 0;

  const sprintFile = join(shipyardData, "sprints", "current", "SPRINT.md");
  const progressFile = join(shipyardData, "sprints", "current", "PROGRESS.md");
  const handoffFile = join(shipyardData, "sprints", "current", "HANDOFF.md");
  const execLock = join(shipyardData, ".active-execution.json");

  if (!existsSync(sprintFile)) return 0;

  const status = readFrontmatterField(sprintFile, "status");
  if (status !== "active") return 0;

  const sprintId = safeValue(readFrontmatterField(sprintFile, "id"));
  const branch = safeValue(readFrontmatterField(sprintFile, "branch"));

  let currentWave = null;
  if (existsSync(progressFile)) {
    const rawWave = readFrontmatterField(progressFile, "current_wave");
    currentWave = rawWave ? safeValue(rawWave, null) : null;
  }

  const parts = [`Active sprint: ${sprintId}`, `Branch: ${branch}`];
  if (currentWave) parts.push(`Current wave: ${currentWave}`);
  if (existsSync(handoffFile)) parts.push("HANDOFF.md exists — read it for pause state");

  // Compaction pressure: only skills that opt in via
  // `tracks_compaction_pressure: true` on their lock get a counter bump.
  // Returns null for no-op locks (ship-quick, ship-bug, ship-debug, cleared
  // sentinels, or a missing lock).
  if (existsSync(execLock)) {
    const count = bumpLockCounter(execLock);
    if (count !== null) {
      // Emit a structured event so bug-report diagnostics can see
      // exactly when compactions fired and which sprint they hit.
      // This is the primary signal for disambiguating "orchestrator
      // auto-paused" from "subagent ran out of context" in support cases.
      logEvent(shipyardData, "compaction_detected", {
        sprint: sprintId,
        wave: currentWave || undefined,
        count,
        warn: count >= COMPACTION_WARN_AT,
        pause: count >= COMPACTION_PAUSE_AT,
      });
      if (count >= COMPACTION_PAUSE_AT) {
        parts.push(
          `⚠ CONTEXT PRESSURE: conversation history has been reconstructed ` +
            `${count} times this sprint. Recommend pausing at the next wave ` +
            `boundary — type 'pause' to save progress, then '/clear' and ` +
            `/ship-execute to resume with a fresh working memory.`,
        );
      } else if (count >= COMPACTION_WARN_AT) {
        parts.push(
          `⚠ Context summarised ${count} times this sprint — working memory ` +
            `is degrading. Will auto-recommend a pause at the next wave ` +
            `boundary if another compaction fires.`,
        );
      } else {
        parts.push(`Compaction #${count} this sprint`);
      }
    } else {
      // Non-ship-execute lock present (ship-quick, ship-bug, ship-debug, or
      // a cleared sentinel). Still worth logging the compaction fact — just
      // without a counter — so the timeline shows compactions during
      // non-tracked skills too. Helps diagnose "my ship-quick task died".
      logEvent(shipyardData, "compaction_detected", {
        sprint: sprintId,
        wave: currentWave || undefined,
        tracked: false,
      });
    }
  }

  parts.push("Read SPRINT.md and PROGRESS.md for full state");

  process.stdout.write(`[Shipyard context restored] ${parts.join(" | ")}\n`);
  return 0;
}
