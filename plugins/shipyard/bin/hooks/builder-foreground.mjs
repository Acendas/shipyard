/**
 * PreToolUse hook (matcher: Bash): a builder runs its commands in the foreground.
 *
 * After 4.0.2, on a real sprint: a builder started its test run in the
 * background, could not wait for it (a builder has no tool to watch or stop a
 * background command; it tried one and was told it does not exist), polled it
 * with `pgrep`, and returned. Its work was merged and its worktree removed,
 * and for six hours the agent list showed it as "waiting on 1 shell". The
 * owner found it; Shipyard's own agent list said nothing was running.
 *
 * Probed on CLI 2.1.326: a tool call made inside a subagent reaches this hook
 * with `agent_id` and `agent_type`; a background agent that returns while a
 * background command of its own still runs stays listed until that command
 * ends or is stopped; when the background call is refused here the agent runs
 * the command in the foreground and nothing is left behind.
 *
 * Only the builder agent. First rule: `run_in_background: true`. A command in
 * the foreground may take up to ten minutes, which is more than any one step
 * should need: the whole suite belongs to the wave boundary, not to a builder.
 */
import { logEvent } from "../_hook_lib.mjs";
import { heavySignatures, readGateConfig, ungatedHeavy } from "../build-gate.mjs";

export const BUILDER_FOREGROUND = "Shipyard: a builder runs its commands in the foreground. Run this again without run_in_background (set a timeout of up to 600000 ms if it is slow). A command left in the background keeps this agent listed after it returns, and a builder has no tool to wait for it or stop it. If it cannot finish in ten minutes it is not this step's command: run the narrower one (the step's own tests), and say so in your return.";

/**
 * The second rule of this hook (after 4.0.4): a builder runs the project's
 * build or test tool through `shipyard-logcap run`, where the build gate
 * decides when there is room. Five builders each ran the tool directly at the
 * same moment on a real sprint; the machine's load went to four times its
 * cores and builds failed for reasons unrelated to the code.
 */
export const BUILDER_GATED = (part) => `Shipyard: a builder runs the project's build and test tool through the build gate. Run it as \`shipyard-logcap run <name> --wait 8m -- ${part}\` (one plain command, nothing chained after it) with a timeout of 600000 ms. The gate lets it start when the machine has room; exit 75 means QUEUED, not run: run the same command again.`;

const isBuilder = (hookInput) => /(^|:)shipyard-disciplined-builder$/.test(String(hookInput?.agent_type ?? ""));

/** A deny reason, or null. */
export function decide(hookInput, dataDir = null) {
  if (hookInput?.tool_name !== "Bash" || !isBuilder(hookInput)) return null;
  if (hookInput?.tool_input?.run_in_background === true) return { reason: BUILDER_FOREGROUND, event: "builder_background_refused" };
  if (!dataDir) return null;
  const cfg = readGateConfig(dataDir);
  if (!cfg.enabled) return null;
  const part = ungatedHeavy(String(hookInput?.tool_input?.command ?? ""), heavySignatures(cfg.commands), String(hookInput?.cwd ?? process.cwd()));
  return part ? { reason: BUILDER_GATED(part.slice(0, 160)), event: "builder_ungated_build_refused" } : null;
}

export function run(hookInput, env) {
  let v = null;
  const dataDir = (env && env.SHIPYARD_DATA) || process.env.SHIPYARD_DATA;
  try { v = decide(hookInput, dataDir); } catch { v = null; }
  if (!v) return 0;
  try { if (dataDir) logEvent(dataDir, v.event, { agent: String(hookInput.agent_id ?? "").slice(0, 40), command: String(hookInput.tool_input?.command ?? "").replace(/\s+/g, " ").slice(0, 120) }); } catch { /* best-effort */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: v.reason } }));
  return 0;
}
