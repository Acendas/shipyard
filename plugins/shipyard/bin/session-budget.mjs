/**
 * session-budget — pure evaluator for the optional session wall-clock budget
 * (`execution.max_session_minutes`, default OFF). No I/O; callers inject `now`.
 *
 * Ambiguity never resets or trips the clock: a missing/unparseable start, or a
 * `now` earlier than the start (clock skew), yields elapsed 0 and not-exceeded.
 */

/** Coerce Date | number | ISO string to epoch ms; NaN for anything non-finite/unparseable. */
export function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string" && v.trim() !== "") return Date.parse(v);
  return NaN;
}

/**
 * @returns {{enabled:boolean, exceeded:boolean, elapsedMinutes:number, maxMinutes:number}}
 */
export function evaluateSessionBudget({ now, startedAt, maxMinutes } = {}) {
  const max = typeof maxMinutes === "number" && Number.isFinite(maxMinutes) && maxMinutes > 0 ? maxMinutes : 0;
  const nowMs = toMs(now ?? Date.now());
  const startMs = toMs(startedAt);
  let elapsedMinutes = 0;
  if (Number.isFinite(nowMs) && Number.isFinite(startMs) && nowMs > startMs) {
    elapsedMinutes = (nowMs - startMs) / 60000;
  }
  const enabled = max > 0;
  return { enabled, exceeded: enabled && elapsedMinutes >= max, elapsedMinutes, maxMinutes: max };
}
