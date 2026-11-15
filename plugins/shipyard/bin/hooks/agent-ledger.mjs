/**
 * PreToolUse hook for Agent and TaskStop: the agent ledger keeps itself (v4.9.1).
 *
 * The ledger (`shipyard-data agents`) stops finished agents from lingering,
 * but only /ship-execute recorded into it, and only because its prose said
 * so. In a real /ship-discuss a design deep-dive finished and then sat in the
 * agent list for a quarter of an hour: nothing recorded it, so nothing could
 * notice it. This hook records what actually happens, for every Shipyard
 * command:
 *   Agent    with a `name`, while THIS session holds a Shipyard lock
 *            (planning or execution)            → `agent_spawned`
 *   TaskStop on a name the ledger lists as live → `agent_stopped`
 * `lock release` then refuses while an agent this command started is still
 * listed, and the execute gates read the same ledger as before.
 *
 * Scoped to a held lock so an agent the user starts for unrelated work in
 * the same project is never recorded. Any error is swallowed (fail open).
 *
 * One refusal (v4.11.1): a builder spawned on a model other than the one the
 * step is routed to. Routing (size, risk, the ladder) picks the model; in a
 * real sprint the orchestrator resolved it once and reused it from memory, so
 * small steps kept running on Sonnet after they were routed to Haiku. The
 * hook compares the `model:` of every `shipyard-disciplined-builder` spawn
 * named after a step with `tierFor()` and denies a mismatch, naming the model
 * to use.
 *
 * A second refusal (v4.18): a named agent that would take the project past
 * `execution.max_agents` (default 100) alive at once. Nothing else is ever
 * blocked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCK_FILES } from "../skill-lock.mjs";
import { logEvent } from "../_hook_lib.mjs";
import { readEvents, liveAgents } from "../terminal-gate.mjs";
import { tierFor } from "../model-for.mjs";
import { readMaxAgents } from "../config-read.mjs";

const STEP_IN_NAME = /(?:^|-)([PT]\d{3,})$/;

/**
 * A builder for a known step must run on the model its step is routed to.
 * Returns a deny reason, or null. Only inside /ship-execute; only for the
 * builder agent; only when the step has a record and routing names a model.
 */
export function wrongBuilderModel(dataDir, hookInput) {
  const input = hookInput?.tool_input ?? {};
  if (hookInput?.tool_name !== "Agent" || !/disciplined-builder$/.test(String(input.subagent_type ?? ""))) return null;
  const m = String(input.name ?? "").match(STEP_IN_NAME);
  if (!m) return null;
  const session = hookInput.session_id ? String(hookInput.session_id) : "";
  if (heldSkill(dataDir, session) !== "ship-execute") return null;
  const t = tierFor(dataDir, "build", m[1]);
  if (!t.known || !t.model || t.ladder.exhausted) return null;
  const given = String(input.model ?? "").trim();
  if (given === t.model) return null;
  return {
    step: m[1], expected: t.model, given: given || "(none)", tier: t.tier,
    reason: `${input.name} must run on ${t.model}: step ${m[1]} is routed to the ${t.tier} tier${t.ladder.attempt ? ` (dispatch ${t.ladder.attempt + 1}, one rung up per failed attempt)` : ""}, and this spawn asks for ${given || "no model"}. ` +
      `Spawn it again with model: "${t.model}". Resolve every step at its own dispatch (\`shipyard-data resolve-model build --subject ${m[1]}\` prints model and effort); never reuse the model of an earlier step.`,
  };
}

/**
 * No more than `execution.max_agents` (default 100) agents alive at once
 * (v4.18, the owner's rule). Counted from the ledger: every named agent a
 * Shipyard command started and has not stopped, in any session. Returns a
 * deny reason, or null. An agent with no name is not in the ledger and is
 * never refused here.
 */
export function tooManyAgents(dataDir, hookInput) {
  const input = hookInput?.tool_input ?? {};
  if (hookInput?.tool_name !== "Agent") return null;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return null;
  const session = hookInput.session_id ? String(hookInput.session_id) : "";
  if (!heldSkill(dataDir, session)) return null;
  const cap = readMaxAgents(dataDir);
  const live = liveAgents(readEvents(dataDir, 20000));
  if (live.some((a) => a.name === name) || live.length < cap) return null; // the same name again replaces itself
  return {
    live: live.length, cap,
    reason: `${live.length} agents are already running in this project (limit execution.max_agents = ${cap}). ` +
      `Do not start ${name} yet: wait for one to return, or stop the finished ones (\`shipyard-data agents live\` lists them, \`shipyard-data agents stopped <name>\` records one that ended). ` +
      "The owner changes the limit with `shipyard-data config set-max-agents <n>`.",
  };
}

/** The Shipyard skill whose lock this session holds, or null. */
export function heldSkill(dataDir, sessionId) {
  for (const base of Object.values(LOCK_FILES)) {
    try {
      const o = JSON.parse(readFileSync(join(dataDir, base), "utf8"));
      if (!o || !o.skill || o.cleared) continue;
      if (!o.session_id || !sessionId || o.session_id === sessionId) return String(o.skill);
    } catch { /* no lock file */ }
  }
  return null;
}

export function record(dataDir, hookInput) {
  if (!dataDir || !hookInput) return null;
  const input = hookInput.tool_input ?? {};
  const session = hookInput.session_id ? String(hookInput.session_id) : "";
  if (hookInput.tool_name === "Agent") {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) return null;
    const skill = heldSkill(dataDir, session);
    if (!skill) return null;
    logEvent(dataDir, "agent_spawned", { agent: name, purpose: String(input.description ?? "").slice(0, 80), via: "hook", session, skill });
    return { type: "agent_spawned", agent: name };
  }
  if (hookInput.tool_name === "TaskStop") {
    const id = typeof input.task_id === "string" ? input.task_id.trim() : "";
    if (!id) return null;
    if (!liveAgents(readEvents(dataDir, 20000)).some((a) => a.name === id)) return null;
    logEvent(dataDir, "agent_stopped", { agent: id, reason: "done", via: "hook", session });
    return { type: "agent_stopped", agent: id };
  }
  return null;
}

export function run(hookInput, env) {
  const dataDir = (env && env.SHIPYARD_DATA) || process.env.SHIPYARD_DATA;
  let wrong = null;
  try { wrong = wrongBuilderModel(dataDir, hookInput); } catch { wrong = null; }
  if (wrong) {
    try { logEvent(dataDir, "builder_model_refused", { step: wrong.step, expected: wrong.expected, given: wrong.given, tier: wrong.tier }); } catch { /* best-effort */ }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: wrong.reason } }));
    return 0; // the spawn did not happen: nothing to record
  }
  let many = null;
  try { many = tooManyAgents(dataDir, hookInput); } catch { many = null; }
  if (many) {
    try { logEvent(dataDir, "agent_spawn_refused", { agent: String(hookInput.tool_input?.name ?? ""), live: many.live, cap: many.cap }); } catch { /* best-effort */ }
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: many.reason } }));
    return 0;
  }
  try { record(dataDir, hookInput); } catch { /* fail open */ }
  return 0;
}
