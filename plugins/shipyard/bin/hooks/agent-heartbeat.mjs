/**
 * PostToolUse hook: writes heartbeat file for builder liveness monitoring.
 *
 * Fires on every tool call. When the CWD is inside a builder worktree
 * (`.claude/worktrees/<id>/`), writes a single JSON heartbeat file to
 * `<SHIPYARD_DATA>/agents/<agentId>.heartbeat`. The orchestrator reads
 * these files to detect stuck/dead agents and understand what they were
 * doing when they failed.
 *
 * Non-worktree CWDs (solo mode, orchestrator) are silently skipped — solo
 * mode is sequential and blocking, so the orchestrator inherently knows
 * if it is stuck.
 *
 * STDOUT CONTRACT: NEVER writes to stdout. Zero token cost.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, resolveShipyardData, sanitizeForLog } from "../_hook_lib.mjs";

// Match worktree paths on both POSIX and Windows.
// Captures the <id> segment from `.claude/worktrees/<id>/...`
const WORKTREE_RE = /[/\\]\.claude[/\\]worktrees[/\\]([^/\\]+)/;

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LSP"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const EXEC_TOOLS = new Set(["Bash"]);

function classifyTool(name) {
  if (READ_TOOLS.has(name)) return "read";
  if (WRITE_TOOLS.has(name)) return "write";
  if (EXEC_TOOLS.has(name)) return "exec";
  return "other";
}

export async function run(hookInput, _env) {
  // Only write heartbeats inside builder worktrees.
  let cwd;
  try {
    cwd = process.cwd();
  } catch {
    return 0; // CWD deleted (worktree cleaned up) — nothing to do
  }

  const match = WORKTREE_RE.exec(cwd);
  if (!match) return 0; // not in a worktree — skip

  const agentId = match[1];
  const dataDir = await resolveShipyardData();
  if (!dataDir) return 0;

  const toolName = hookInput?.tool_name || "unknown";
  const toolInput = hookInput?.tool_input || {};

  // Extract a meaningful target (file path or command snippet)
  let target = "";
  if (toolInput.file_path) {
    target = sanitizeForLog(toolInput.file_path, 120);
  } else if (toolInput.command) {
    target = sanitizeForLog(toolInput.command, 120);
  } else if (toolInput.pattern) {
    target = sanitizeForLog(toolInput.pattern, 80);
  }

  const heartbeat = JSON.stringify({
    agent_id: agentId,
    tool: toolName,
    mode: classifyTool(toolName),
    target,
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
  });

  try {
    const agentsDir = join(dataDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    atomicWrite(join(agentsDir, `${agentId}.heartbeat`), heartbeat + "\n");
  } catch {
    // Swallow — diagnostics must never break tool calls.
  }

  return 0;
}
