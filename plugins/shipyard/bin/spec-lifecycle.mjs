/**
 * spec-lifecycle — canonical status transition graphs for stories (features
 * and bugs), ideas, epics and tasks, shared by `shipyard-data story|idea|epic|task
 * set-status` (spec-state-cli.mjs)
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

/**
 * Story lifecycle (v4: a story is `type: feature` or `type: bug`). The status
 * VALUES are unchanged from the 3.x feature lifecycle — terminology-v4 renames
 * the unit, not its states — so FEATURE_TRANSITIONS stays as an alias for
 * readers that still import it.
 */
export const STORY_TRANSITIONS = Object.freeze({
  proposed: Object.freeze(["approved", "deferred", "rejected"]),
  // 4.0: an approved story that will not be built (replaced by a newer one)
  // is retired in one move, with the reason on the record. The only path was
  // approved -> deferred -> rejected with --force twice, and the reason went
  // into a document.
  approved: Object.freeze(["in-progress", "deferred", "rejected"]),
  "in-progress": Object.freeze(["done", "approved"]),
  done: Object.freeze(["deployed", "released"]),
  deployed: Object.freeze(["released"]),
  deferred: Object.freeze(["proposed"]),
  rejected: Object.freeze([]),
  released: Object.freeze([]),
});
export const FEATURE_TRANSITIONS = STORY_TRANSITIONS;

/**
 * Legacy bug records (spec/bugs/B###, `status: open|done`) read as stories:
 * `open` is `proposed`. Writers always emit story statuses.
 */
export const LEGACY_BUG_STATUS_ALIASES = Object.freeze({ open: "proposed", fixed: "done" });

/**
 * Idea lifecycle (terminology-v4 D-9, A-07): captured, assessing, promoted
 * (to an epic or a story), rejected, parked. Old values read through
 * IDEA_STATUS_ALIASES (`proposed` = captured, `graduated` = promoted); writers
 * emit the new values.
 */
export const IDEA_TRANSITIONS = Object.freeze({
  captured: Object.freeze(["assessing", "promoted", "rejected", "parked", "landed"]),
  assessing: Object.freeze(["promoted", "rejected", "parked", "captured", "landed"]),
  parked: Object.freeze(["captured", "assessing", "rejected", "landed"]),
  promoted: Object.freeze([]),
  rejected: Object.freeze([]),
  // 4.4: the idea was small enough to fix on the spot (a one-line doc fix, a
  // typo); it is done, not rejected — "rejected" misrecorded 2 of 14 ideas live.
  // 4.0: a wrong "landed" can be taken back (three ideas were marked landed
  // that were only filed as tasks, and nothing could undo it).
  landed: Object.freeze(["captured"]),
});
export const IDEA_STATUS_ALIASES = Object.freeze({ proposed: "captured", graduated: "promoted" });
/** Idea statuses that count as a disposition (the backlog guard ignores them). */
export const IDEA_DISPOSITIONED = Object.freeze(["promoted", "graduated", "rejected", "parked", "landed"]);

/**
 * Epic lifecycle (terminology-v4 D-10, A-08): decided, refined, in-progress,
 * done. `proposed` is the pre-v4 template value and reads as the entry state.
 */
export const EPIC_TRANSITIONS = Object.freeze({
  proposed: Object.freeze(["decided", "refined"]),
  decided: Object.freeze(["refined", "in-progress"]),
  refined: Object.freeze(["in-progress", "decided"]),
  "in-progress": Object.freeze(["done", "refined"]),
  done: Object.freeze([]),
});

/**
 * Task (enabling work) lifecycle (terminology-v4 T-4): open, in-progress,
 * done, dropped. Distinct from a step's statuses (see spec-state-cli
 * TASK_STATUS_ALLOWED, which keeps the builder-unit vocabulary).
 */
export const TASK_TRANSITIONS = Object.freeze({
  open: Object.freeze(["in-progress", "done", "dropped"]),
  "in-progress": Object.freeze(["done", "dropped", "open"]),
  done: Object.freeze([]),
  dropped: Object.freeze(["open"]),
});

/** Map a stored status through an alias table (unknown values pass through). */
export function normalizeStatus(aliases, status) {
  const s = String(status ?? "").trim();
  return aliases[s] ?? s;
}

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
