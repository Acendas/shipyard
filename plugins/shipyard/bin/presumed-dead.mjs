/**
 * Read-only stale-agent detector (F013/T041).
 *
 * Reports claimed queue items that are past `presumed_dead_minutes` with no
 * completion and no heartbeat inside the recent window. It never
 * mutates the queue, cursor, or events, and never re-pends (a slow live
 * builder must not get a duplicate). Salvage (TaskStop, anchor, park) belongs
 * to the wrapper. Liveness comes from worker-queue's shared predicate.
 */
import { EVENTS_LOG_NAME } from "./_hook_lib.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isTaskCompletedUnackedInEvents, isTaskLiveInEvents, readQueueSnapshot } from "./worker-queue.mjs";

export const DEFAULT_PRESUMED_DEAD_MINUTES = 60;
export const DEFAULT_RECENT_MINUTES = 15; // == worker-queue.mjs LIVENESS_WINDOW_MS: one definition of "alive"

export function dedupeKey(pipeline, stage, task, attempt) {
  return [pipeline, stage, task, attempt ?? 0].join("|");
}

export function detectPresumedDead(queue, events, now = Date.now(), cfg = {}) {
  const deadMin = Number(cfg.presumed_dead_minutes);
  const recentMin = Number(cfg.recent_minutes);
  const deadMs = (deadMin > 0 ? deadMin : DEFAULT_PRESUMED_DEAD_MINUTES) * 60_000;
  const recentMs = (recentMin > 0 ? recentMin : DEFAULT_RECENT_MINUTES) * 60_000;
  const evs = Array.isArray(events) ? events : [];
  const reported = new Set();
  for (const ev of evs) {
    if (ev?.type === "subagent_presumed_dead") {
      reported.add(dedupeKey(ev.pipeline, ev.stage, ev.task, ev.attempt));
    }
  }
  const out = [];
  for (const task of queue?.tasks ?? []) {
    if (!task || task.status !== "claimed") continue;
    if (!task.claimed_at || !task.deadline_at) continue;
    const claimedMs = Date.parse(task.claimed_at);
    if (!Number.isFinite(claimedMs) || now - claimedMs < deadMs) continue;
    // A completion event on a still-claimed item is not liveness: the builder
    // finished but `queue complete` never landed. Report it for reconciliation.
    const completedUnacked = isTaskCompletedUnackedInEvents(evs, task);
    if (!completedUnacked && isTaskLiveInEvents(evs, task, now, recentMs)) continue;
    const key = dedupeKey(task.pipeline, task.stage, task.id, task.attempt);
    if (reported.has(key)) continue;
    out.push({
      pipeline: task.pipeline, stage: task.stage, task: task.id,
      attempt: task.attempt ?? 0, claimed_by: task.claimed_by ?? null,
      claimed_at: task.claimed_at, minutes: Math.floor((now - claimedMs) / 60_000),
      ...(completedUnacked ? { completed_unacked: true } : {}),
    });
  }
  return out;
}

/** Convenience: read queue + events from a data dir, then detect. Read-only. */
export function detectPresumedDeadForDataDir(dataDir, now = Date.now(), cfg = {}) {
  let events = [];
  try {
    events = readFileSync(join(dataDir, EVENTS_LOG_NAME), "utf8").split("\n").flatMap((l) => {
      try { return l.trim() ? [JSON.parse(l)] : []; } catch { return []; }
    });
  } catch { /* no log */ }
  return detectPresumedDead(readQueueSnapshot(dataDir), events, now, cfg);
}
