/**
 * PostToolUse hook for Agent: restore CWD after worktree agent returns.
 *
 * Node port of project-files/scripts/cwd-restore.py.
 *
 * After an Agent with isolation: worktree completes, Claude Code's CWD may
 * be left pointing at the (possibly deleted) worktree directory. This hook
 * detects CWD drift and outputs a restore command.
 *
 * Claude Code bug #42282: sub-agents in worktrees cause persistent CWD drift.
 *
 * STDOUT CONTRACT: PostToolUse stdout becomes a conversation message.
 */

import { realpathSync } from "node:fs";
import { basename, sep } from "node:path";
import { logEvent, resolveShipyardData } from "../_hook_lib.mjs";

export async function run(hookInput, env) {
  const toolName = hookInput?.tool_name || "";
  if (toolName !== "Agent") return 0;

  const projectDir = (env && env.CLAUDE_PROJECT_DIR) || process.env.CLAUDE_PROJECT_DIR || "";
  if (!projectDir) return 0;

  // Best-effort data dir resolution for event logging. Falsy → events
  // become a no-op (logEvent handles that internally), but the cwd-restore
  // logic still runs because that's its primary job.
  const shipyardData = await resolveShipyardData();

  // Always emit "agent returned" — every Agent tool call ends here.
  // This is the primary signal for builder timing and "did the builder
  // exit cleanly or did the orchestrator move on after a failure" in
  // the bug-report timeline. Cheap (one event per agent call, not per
  // tool use) and high-value.
  logEvent(shipyardData, "agent_tool_returned", {
    subagent: hookInput?.tool_input?.subagent_type || undefined,
  });

  let cwd;
  try {
    cwd = process.cwd();
  } catch {
    logEvent(shipyardData, "cwd_drift_detected", {
      reason: "cwd_deleted",
      target: projectDir,
    });
    process.stderr.write(
      `⚠️  CWD DRIFT: Current directory no longer exists (worktree was cleaned up). ` +
        `Run: cd "${projectDir}"\n`,
    );
    process.stdout.write(`CWD_RESTORE_NEEDED: cd "${projectDir}"\n`);
    return 0;
  }

  let realCwd, realProject;
  try { realCwd = realpathSync(cwd); } catch { realCwd = cwd; }
  try { realProject = realpathSync(projectDir); } catch { realProject = projectDir; }

  if (realCwd !== realProject) {
    const worktreeMarker = sep + ".claude" + sep + "worktrees" + sep;
    const worktreeMarkerShort = sep + "worktrees" + sep;
    if (realCwd.includes(worktreeMarker) || realCwd.includes(worktreeMarkerShort)) {
      logEvent(shipyardData, "cwd_drift_detected", {
        reason: "worktree_drift",
        from: realCwd,
        to: realProject,
      });
      process.stderr.write(
        `⚠️  CWD DRIFT: Working directory is in a worktree (${basename(cwd)}), ` +
          `not the project root. Run: cd "${projectDir}"\n`,
      );
      process.stdout.write(`CWD_RESTORE_NEEDED: cd "${projectDir}"\n`);
    }
  }

  return 0;
}
