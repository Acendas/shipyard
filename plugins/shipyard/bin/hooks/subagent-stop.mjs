/**
 * SubagentStop hook: commit enforcement for builder subagents.
 *
 * Fires when any subagent considers stopping. If the subagent is a
 * shipyard-builder during an active sprint execution, this hook checks
 * for uncommitted changes and blocks exit until the builder commits.
 *
 * Inspired by Anthropic's ralph-loop plugin (Stop hook that blocks exit
 * and re-feeds the prompt until the task is complete).
 *
 * Block budget: max 2 blocks per subagent session. After 2 blocks, allow
 * exit and let the orchestrator's post-subagent salvage handle it. This
 * prevents infinite loops when the builder genuinely cannot commit (e.g.,
 * syntax errors blocking compilation, out of context).
 *
 * STDOUT CONTRACT: SubagentStop stdout is a JSON object with:
 *   { "decision": "block"|"approve", "reason": "...", "systemMessage": "..." }
 * Exit code 2 = block the stop. Exit code 0 = allow.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { logEvent, resolveShipyardData } from "../_hook_lib.mjs";

const MAX_BLOCKS = 2;

/**
 * Check if the current working directory has uncommitted changes.
 * Returns the porcelain output (empty string = clean tree).
 */
function gitStatusPorcelain(cwd) {
  try {
    return execSync("git status --porcelain", {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    // If git fails (not a repo, etc.), treat as clean — don't block.
    return "";
  }
}

/**
 * Read/increment the block counter for this subagent session.
 * Counter is stored at $SHIPYARD_DATA/.subagent-stop-counters/<session_id>.
 * Returns the count AFTER incrementing.
 */
function incrementBlockCount(dataDir, sessionId) {
  if (!dataDir || !sessionId) return 1;

  const counterDir = join(dataDir, ".subagent-stop-counters");
  // Sanitize sessionId to prevent path traversal
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  const counterPath = join(counterDir, safeId);

  try {
    mkdirSync(counterDir, { recursive: true });
  } catch {
    return 1;
  }

  let count = 0;
  try {
    count = parseInt(readFileSync(counterPath, "utf8").trim(), 10) || 0;
  } catch {
    count = 0;
  }

  count += 1;

  try {
    writeFileSync(counterPath, String(count));
  } catch {
    // Best effort — if we can't persist, treat as first block
  }

  return count;
}

/**
 * Determine if this subagent is a shipyard-builder.
 *
 * Check hook input fields first (subagent_type, agent_type). If those
 * aren't available, check the CWD — builder agents run in worktrees
 * on branches named shipyard/wt-*.
 */
function isBuilderAgent(hookInput, cwd) {
  // Check hook input for agent type metadata
  const agentType =
    hookInput?.subagent_type ||
    hookInput?.agent_type ||
    hookInput?.tool_input?.subagent_type ||
    "";

  if (agentType.includes("shipyard-builder")) return true;
  if (agentType && !agentType.includes("shipyard-builder")) return false;

  // Fallback: check if we're on a shipyard worktree branch
  try {
    const branch = execSync("git branch --show-current", {
      cwd,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return branch.startsWith("shipyard/wt-");
  } catch {
    return false;
  }
}

export async function run(hookInput, env) {
  const cwd = hookInput?.cwd || process.cwd();
  const sessionId = hookInput?.session_id || "";

  // Best-effort data dir for event logging and execution lock check
  const shipyardData =
    (env && env.SHIPYARD_DATA) || (await resolveShipyardData());

  // Gate 1: Only enforce for builder subagents
  if (!isBuilderAgent(hookInput, cwd)) {
    return 0;
  }

  // Gate 2: Only enforce during active sprint execution
  if (shipyardData) {
    const lockPath = join(shipyardData, ".active-execution.json");
    if (!existsSync(lockPath)) {
      // No active execution — allow exit (could be a POC spike, quick task, etc.)
      return 0;
    }
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      if (lock.skill !== "ship-execute" || lock.cleared) {
        return 0;
      }
    } catch {
      // Can't parse lock — allow exit rather than block on corrupt state
      return 0;
    }
  }

  // Gate 3: Check for uncommitted changes
  const porcelain = gitStatusPorcelain(cwd);

  if (!porcelain) {
    // Clean tree — allow exit
    logEvent(shipyardData, "builder_stop_allowed", {
      session: sessionId,
      reason: "clean_tree",
    });
    return 0;
  }

  // Dirty tree detected — check block budget
  const blockCount = incrementBlockCount(shipyardData, sessionId);

  if (blockCount > MAX_BLOCKS) {
    // Budget exhausted — allow exit, let orchestrator salvage
    logEvent(shipyardData, "builder_stop_allowed", {
      session: sessionId,
      reason: "block_budget_exhausted",
      block_count: blockCount,
      dirty_files: porcelain.split("\n").length,
    });
    process.stderr.write(
      `⚠️  SubagentStop: Builder exiting with uncommitted changes after ${MAX_BLOCKS} block attempts. ` +
        `Orchestrator will salvage.\n`,
    );
    return 0;
  }

  // Block the exit — force the builder to commit
  logEvent(shipyardData, "builder_stop_blocked", {
    session: sessionId,
    block_count: blockCount,
    dirty_files: porcelain.split("\n").length,
  });

  const dirtyCount = porcelain.split("\n").length;
  const response = {
    decision: "block",
    reason:
      `You have ${dirtyCount} uncommitted file(s). Worktree directories are deleted on agent exit ` +
      `and uncommitted work is permanently lost. Run:\n\n` +
      `  git add -A && git commit -m "feat(TASK_ID): description"\n\n` +
      `Then verify with git status --porcelain (must be empty). ` +
      `This is block ${blockCount}/${MAX_BLOCKS} — after ${MAX_BLOCKS} blocks your exit will be forced.`,
    systemMessage: `SubagentStop: ${dirtyCount} uncommitted files detected. Block ${blockCount}/${MAX_BLOCKS}.`,
  };

  process.stdout.write(JSON.stringify(response));
  // Exit code 2 = block the stop
  return 2;
}
