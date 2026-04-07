/**
 * Post-edit hook: detect agent loops and track struggle patterns.
 *
 * Node port of project-files/scripts/loop-detect.py.
 *
 * Tracks how many times the same file is edited in sequence. If a file is
 * edited 5+ times without a commit, warns about potential loop. Also
 * records struggle context so the on-commit hook can capture learnings.
 *
 * STDOUT CONTRACT: PostToolUse hooks send stdout as conversation messages
 * to Claude. Loop warnings are printed to stdout so Claude sees them.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, resolveShipyardData, sanitizeForLog } from "../_hook_lib.mjs";

const LOOP_THRESHOLD = 5;

function loadState(stateFile) {
  if (!existsSync(stateFile)) return { edits: {}, struggles: {} };
  try {
    const raw = readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { edits: {}, struggles: {} };
    if (!parsed.edits) parsed.edits = {};
    if (!parsed.struggles) parsed.struggles = {};
    return parsed;
  } catch (err) {
    process.stderr.write(`⚠️  loop-detect: Corrupt state file, resetting: ${err.message}\n`);
    return { edits: {}, struggles: {} };
  }
}

function saveState(stateFile, state) {
  try {
    atomicWrite(stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    process.stderr.write(`⚠️  loop-detect: Failed to save state: ${err.message}\n`);
  }
}

export async function run(hookInput, _env) {
  const shipyardData = (await resolveShipyardData()) || ".shipyard";
  const stateFile = join(shipyardData, ".loop-state.json");

  let filePath = "";
  try {
    const toolInput = hookInput?.tool_input;
    if (toolInput && typeof toolInput === "object") {
      filePath = toolInput.file_path || "";
    } else if (toolInput !== undefined && toolInput !== null) {
      filePath = String(toolInput);
    }
  } catch (err) {
    process.stderr.write(`⚠️  loop-detect: Could not parse hook input: ${err.message}\n`);
  }

  if (!filePath) return 0;

  const state = loadState(stateFile);
  const edits = state.edits;
  const struggles = state.struggles;

  edits[filePath] = (edits[filePath] || 0) + 1;
  const count = edits[filePath];

  if (count >= LOOP_THRESHOLD && !struggles[filePath]) {
    struggles[filePath] = { edit_count: count, threshold_hit: true };
  }
  if (struggles[filePath]) {
    struggles[filePath].edit_count = count;
  }

  saveState(stateFile, state);

  if (count >= LOOP_THRESHOLD) {
    const safePath = sanitizeForLog(filePath, 500);
    process.stdout.write(`⚠️  LOOP DETECTED: ${safePath} has been edited ${count} times without a commit.\n`);
    process.stdout.write("\n");
    process.stdout.write("This may indicate a test-fail-fix-fail loop.\n");
    process.stdout.write("Consider:\n");
    process.stdout.write("  1. Re-reading the spec to verify your approach\n");
    process.stdout.write("  2. Simplifying the implementation\n");
    process.stdout.write("  3. Asking the user for clarification\n");
    process.stdout.write("  4. Committing current state and starting fresh\n");
    process.stdout.write("\n");
    process.stdout.write("📝 When you resolve this, Shipyard will ask you to capture what you learned\n");
    process.stdout.write("   so this pattern doesn't repeat in future tasks.\n");
  }

  return 0;
}
