/**
 * session-clock — pure reconciliation of the session-budget clock (F005 / T033).
 * No I/O; callers inject `now`, the env id and the last event timestamp.
 *
 * Primary key: CLAUDE_CODE_SESSION_ID (probe: docs/references/shipyard/session-id-probe.md).
 *   - equal to the stored id      -> keep the clock
 *   - different from the stored   -> new session, restart the clock
 *   - stored id absent (legacy)   -> adopt the env id, keep the clock
 * Env var missing: never invent a session; keep the stored clock (key "gap").
 * A time gap never resets it (waves run up to 245 min apart inside one run).
 *
 * UNVERIFIED: whether the env var changes across /compact, --continue or
 * --resume (the probe only verified visibility and same-session constancy).
 * So every ambiguous input (missing/unparseable times, no events, no env id and
 * a recent event) KEEPS the clock: a wrongly kept clock pauses early, a wrongly
 * reset clock silently disables the budget. Never reset on ambiguity.
 */

import { toMs } from "./session-budget.mjs";

/**
 * @returns {{startedAt: string|undefined, sessionId: string|undefined, key: "env"|"gap", reset: boolean}}
 */
export function reconcileSessionClock({ now, envId, storedId, storedStartedAt, } = {}) {
  const nowDate = now instanceof Date ? now : new Date(toMs(now ?? Date.now()));
  const nowIso = nowDate.toISOString();
  const env = typeof envId === "string" && envId.trim() !== "" ? envId.trim() : "";
  const stored = typeof storedId === "string" && storedId.trim() !== "" ? storedId.trim() : "";
  const keep = (key, sessionId) => ({ startedAt: storedStartedAt, sessionId, key, reset: false });
  const restart = (key, sessionId) => ({ startedAt: nowIso, sessionId, key, reset: true });

  if (env) {
    if (!stored || stored === env) return keep("env", env);
    return restart("env", env);
  }
  // No env id: never invent one; keep whatever was stored.
  return keep("gap", stored || undefined);
}
