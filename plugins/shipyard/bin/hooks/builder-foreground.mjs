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
 * Only the builder agent, and only `run_in_background: true`. A command in
 * the foreground may take up to ten minutes, which is more than any one step
 * should need: the whole suite belongs to the wave boundary, not to a builder.
 */
import { logEvent } from "../_hook_lib.mjs";

export const BUILDER_FOREGROUND = "Shipyard: a builder runs its commands in the foreground. Run this again without run_in_background (set a timeout of up to 600000 ms if it is slow). A command left in the background keeps this agent listed after it returns, and a builder has no tool to wait for it or stop it. If it cannot finish in ten minutes it is not this step's command: run the narrower one (the step's own tests), and say so in your return.";

/** A deny reason, or null. */
export function decide(hookInput) {
  if (hookInput?.tool_name !== "Bash" || hookInput?.tool_input?.run_in_background !== true) return null;
  if (!/(^|:)shipyard-disciplined-builder$/.test(String(hookInput.agent_type ?? ""))) return null;
  return { reason: BUILDER_FOREGROUND };
}

export function run(hookInput, env) {
  let v = null;
  try { v = decide(hookInput); } catch { v = null; }
  if (!v) return 0;
  const dataDir = (env && env.SHIPYARD_DATA) || process.env.SHIPYARD_DATA;
  try { if (dataDir) logEvent(dataDir, "builder_background_refused", { agent: String(hookInput.agent_id ?? "").slice(0, 40), command: String(hookInput.tool_input?.command ?? "").replace(/\s+/g, " ").slice(0, 120) }); } catch { /* best-effort */ }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: v.reason } }));
  return 0;
}
