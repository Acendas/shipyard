/**
 * Which tier and model a step's builder runs on, right now (v4.11.1).
 *
 * One definition, used by `resolve-model --subject` AND by the agent-ledger
 * hook, which refuses a builder spawned on a different model. In a real
 * sprint the orchestrator resolved a model once and reused it from memory, so
 * straightforward steps kept running on Sonnet after routing had moved them
 * to Haiku: a prose instruction ("resolve per dispatch") is not routing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_TIER, readModelTier, readRoutingRules } from "./config-read.mjs";
import { routeDecision } from "./route.mjs";
import { readEvents as readEventsWithArchive } from "./event-report.mjs";
import { parseFrontmatter } from "./terminal-gate.mjs";

export const MAX_LADDER_ATTEMPTS = 2;
export const LADDER = Object.freeze(["light", "build", "think"]);

/**
 * `dispatch_attempt` events for `subject` in the CURRENT sprint (archive-aware:
 * an attempt rotated out of the live log must still count). Events without a
 * matching `sprint` are ignored. `onNoSprint` is told when the sprint id cannot
 * be read; the count is then 0.
 */
export function countDispatchAttempts(dataDir, subject, { onNoSprint = null } = {}) {
  let sprintId = "";
  const sprintPath = join(dataDir, "sprints", "current", "SPRINT.md");
  try { sprintId = String(parseFrontmatter(readFileSync(sprintPath, "utf8")).id ?? ""); } catch { /* handled below */ }
  if (!sprintId) { if (onNoSprint) onNoSprint(sprintPath); return 0; }
  let events;
  try { events = readEventsWithArchive(dataDir).events; } catch { return 0; }
  let n = 0;
  for (const e of events) if (e.type === "dispatch_attempt" && e.subject === subject && e.sprint === sprintId) n++;
  return n;
}

/**
 * @returns {{ tier, model, ladder: {attempt, exhausted}, routed: object|null, known: boolean }}
 *   known=false when routing is off or the subject has no record (static role tier).
 */
export function tierFor(dataDir, role, subject, opts = {}) {
  let tier = ROLE_TIER[role];
  let routed = null;
  if (readRoutingRules(dataDir)) {
    const rd = routeDecision(dataDir, { step: subject, role, log: false });
    // the routed tier IS the tier: routing already applied the role's floor
    if (rd.inputs.source.record !== "missing") { routed = rd; tier = rd.tier; }
  }
  const attempt = countDispatchAttempts(dataDir, subject, opts);
  const next = LADDER.indexOf(tier) + attempt;
  // one dispatch per rung: light → build → think
  const ladder = { attempt, exhausted: attempt > MAX_LADDER_ATTEMPTS || next >= LADDER.length };
  tier = LADDER[Math.min(next, LADDER.length - 1)];
  return { tier, model: readModelTier(dataDir, tier), ladder, routed, known: routed !== null };
}
