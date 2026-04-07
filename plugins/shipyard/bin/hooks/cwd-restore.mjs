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

export async function run(hookInput, env) {
  const toolName = hookInput?.tool_name || "";
  if (toolName !== "Agent") return 0;

  const projectDir = (env && env.CLAUDE_PROJECT_DIR) || process.env.CLAUDE_PROJECT_DIR || "";
  if (!projectDir) return 0;

  let cwd;
  try {
    cwd = process.cwd();
  } catch {
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
      process.stderr.write(
        `⚠️  CWD DRIFT: Working directory is in a worktree (${basename(cwd)}), ` +
          `not the project root. Run: cd "${projectDir}"\n`,
      );
      process.stdout.write(`CWD_RESTORE_NEEDED: cd "${projectDir}"\n`);
    }
  }

  return 0;
}
