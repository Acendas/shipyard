/**
 * PreToolUse hook: auto-approve Edit/Write to Shipyard data files.
 *
 * Node port of project-files/scripts/auto-approve-data.py. Behavior must
 * stay byte-for-byte equivalent — this is the most security-critical hook
 * in the chain.
 *
 * Works around two Claude Code permission bugs (#39973, #41763) where
 * Edit/Write to plugin data dirs trigger permission prompts on every wave
 * boundary. The only reliable workaround is a PreToolUse hook returning
 * `permissionDecision: "allow"` — fires before the permission evaluator
 * and short-circuits the prompt.
 *
 * STDOUT CONTRACT: outputs JSON to stdout ONLY when approving. When not
 * approving, returns 0 silently. Never returns 2 (block) — this hook is
 * permissive, never blocking.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import {
  dataDirContains,
  logBreadcrumb,
  resolveShipyardData,
} from "../_hook_lib.mjs";

const LOG_NAME = ".auto-approve.log";

// Mirror the matcher in hooks.json. CLAUDE.md's "mirror the tool allowlist"
// rule exists because these drifted for months in the past — the MultiEdit
// gap is the cautionary tale. Test in test_auto_approve_data.mjs asserts
// these match the hooks.json matcher string.
const GUARDED_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

function expandTilde(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return pathResolve(homedir(), p.slice(2));
  return p;
}

/**
 * Equivalent of Python's os.path.realpath: resolve symlinks in any
 * existing prefix of the path, then append the unresolved tail. Critical
 * for symlink-escape defense — if a Write targets `<sd>/evil/pwned.txt`
 * where `<sd>/evil` is a symlink pointing outside `<sd>`, we MUST resolve
 * the symlink even though `pwned.txt` doesn't exist yet.
 *
 * Algorithm:
 *  1. Try realpathSync on the full path. If it succeeds, return.
 *  2. On ENOENT, walk up to the deepest existing ancestor, realpath that,
 *     then re-append the unresolved suffix.
 *  3. If even the root doesn't resolve, fall back to pathResolve (no
 *     symlink resolution, but at least an absolute path).
 */
function tryRealpath(p) {
  if (!p) return null;
  const expanded = expandTilde(p);
  try {
    return realpathSync(expanded);
  } catch {
    // walk up looking for an existing ancestor
    const segments = [];
    let current = pathResolve(expanded);
    while (true) {
      try {
        const realParent = realpathSync(current);
        // Re-append the segments we walked past, in original order
        return segments.length === 0
          ? realParent
          : pathResolve(realParent, ...segments.reverse());
      } catch {
        const parent = dirname(current);
        if (parent === current) break;
        segments.push(basename(current));
        current = parent;
      }
    }
    try {
      return pathResolve(expanded);
    } catch {
      return null;
    }
  }
}

export async function run(hookInput, _env) {
  const toolName = hookInput?.tool_name || "";
  if (!GUARDED_TOOLS.has(toolName)) return 0;

  const toolInput = hookInput?.tool_input;
  if (!toolInput || typeof toolInput !== "object") return 0;

  const filePathRaw = toolInput.file_path || "";
  if (!filePathRaw) return 0;

  // Reject `..` segments before resolution (defense in depth — symlink
  // escapes are still caught by realpath() containment, but a pre-check
  // also rejects path-traversal payloads that don't even involve symlinks).
  const normalizedSlashes = filePathRaw.replace(/\\/g, "/");
  if (normalizedSlashes.split("/").includes("..")) return 0;

  const filePath = tryRealpath(filePathRaw);
  if (!filePath) return 0;

  let shipyardData = await resolveShipyardData();
  if (!shipyardData) return 0;

  shipyardData = tryRealpath(shipyardData);
  if (!shipyardData) return 0;

  if (dataDirContains(filePath, shipyardData)) {
    logBreadcrumb(shipyardData, LOG_NAME, "allow", [toolName, filePath, shipyardData]);
    const response = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Shipyard data file — auto-approved",
      },
    };
    process.stdout.write(JSON.stringify(response));
    return 0;
  }

  // Outside the data dir → let default permission evaluation proceed.
  logBreadcrumb(shipyardData, LOG_NAME, "pass", [toolName, filePath, shipyardData]);
  return 0;
}
