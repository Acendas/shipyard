/**
 * SessionEnd hook: release skill-mutex locks held by the ending session.
 *
 * A Shipyard command skill (`/ship-discuss`, `/ship-sprint`, `/ship-execute`,
 * `/ship-quick`) acquires a planning/execution lock at start and is supposed
 * to release it at its finalize step. A skill that aborts on an error or a
 * gate halt never reaches that step, so the lock lingers until the 2-hour
 * stale threshold or a manual `/ship-status`. This hook is the "on exit,
 * release" cleanup: when the session ends, it releases any lock still held by
 * THIS session (matched by recorded `session_id`, so a concurrent session's
 * lock is never touched).
 *
 * SessionEnd fires for every end reason (clear, logout, prompt-input-exit,
 * other). The hook is best-effort and always exits 0 — a shutdown hook must
 * never fail the shutdown. If the data dir can't be resolved or the ending
 * session id is absent, there is nothing to attribute, so it no-ops.
 */

import { reapSessionLocks } from "../skill-lock.mjs";

export function run(hookInput, env) {
  const dataDir = (env && env.SHIPYARD_DATA) || process.env.SHIPYARD_DATA;
  if (!dataDir) return 0; // resolver couldn't find the data dir — nothing to reap

  const sessionId = hookInput && hookInput.session_id ? String(hookInput.session_id) : null;
  if (!sessionId) return 0; // can't attribute a lock without the ending session's id

  try {
    reapSessionLocks(dataDir, sessionId);
  } catch {
    // best-effort — never block or fail session shutdown
  }
  return 0;
}
