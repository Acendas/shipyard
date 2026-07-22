/**
 * spec-lifecycle — canonical status transition graphs for features and
 * ideas, shared by `shipyard-data feature|idea set-status` (spec-state-cli.mjs)
 * and anything else that needs to validate a spec-entity status change.
 *
 * Single source of truth: `project-files/rules/shipyard-data-model.md`
 * documents the same graph in prose for skill bodies (ship-spec's "Valid
 * Status Transitions" section); this file is what the CLI actually enforces.
 * If the two ever drift, the rules file wins — it is the one skills quote
 * directly at users, and this graph must match it exactly (not the other
 * way around).
 *
 * Note the rules file's feature chain is `done → deployed → released` —
 * `done` does NOT skip straight to `released`. This module intentionally
 * matches that (not a broader "done can go anywhere downstream" graph).
 */

export const FEATURE_TRANSITIONS = Object.freeze({
  proposed: Object.freeze(["approved", "deferred", "rejected"]),
  approved: Object.freeze(["in-progress", "deferred"]),
  "in-progress": Object.freeze(["done", "approved"]),
  done: Object.freeze(["deployed"]),
  deployed: Object.freeze(["released"]),
  deferred: Object.freeze(["proposed"]),
  rejected: Object.freeze([]),
  released: Object.freeze([]),
});

export const IDEA_TRANSITIONS = Object.freeze({
  proposed: Object.freeze(["graduated", "rejected"]),
  graduated: Object.freeze([]),
  rejected: Object.freeze([]),
});

// Statuses that mean "no longer an active backlog candidate" — feature
// set-status auto-removes the ID from BACKLOG.md when landing on one of
// these. `approved` is deliberately excluded: approving a proposed feature
// does NOT auto-add it to the backlog (that's `backlog add`'s job), so the
// inverse (approved doesn't auto-remove) keeps the two operations symmetric.
export const BACKLOG_REMOVING_STATUSES = new Set([
  "deferred",
  "rejected",
  "done",
  "deployed",
  "released",
]);

/**
 * Validate a transition against a graph. Returns { ok: true } or
 * { ok: false, validNext: string[] } naming the legal next states from
 * `from` so callers can build an actionable error message.
 */
export function validateStatusTransition(graph, from, to) {
  const validNext = graph[from];
  if (validNext === undefined) {
    return { ok: false, validNext: [], unknownFrom: true };
  }
  if (validNext.includes(to)) {
    return { ok: true, validNext };
  }
  return { ok: false, validNext };
}
