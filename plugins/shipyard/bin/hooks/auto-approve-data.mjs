/**
 * PreToolUse hook: auto-approve Edit/Write to Shipyard data files +
 * gate "claim of success" terminal-cursor writes.
 *
 * Original mandate. Works around Claude Code permission bugs (#39973,
 * #41763) where Edit/Write to plugin data dirs trigger permission prompts
 * at wave boundaries. A PreToolUse hook returning
 * `permissionDecision: "allow"` runs before the permission evaluator and
 * short-circuits the prompt.
 *
 * Terminal-cursor gate (v2.6.0). Layered on top: for Write/Edit targeting
 * `sprints/current/EXECUTE-CURSOR.md` or `sprints/current/REVIEW-CURSOR.md`
 * with proposed content claiming success (execute: terminal + status complete;
 * review: terminal + stage terminal_approved/terminal_changes/terminal_issues),
 * the hook calls into `terminal-gate.mjs` to verify the supporting event-log
 * evidence. Missing evidence → emit `permissionDecision: "deny"` with the
 * specific gaps in the reason field. This is the structural enforcement
 * point that prevents the inline-execute bypass surfaced by the confedit
 * sprint-001 incident on 2026-05-19. The "never blocking" rule below is
 * relaxed for this one explicit case — it was about preventing accidental
 * blocks; the terminal-gate deny is intentional.
 *
 * STDOUT CONTRACT: outputs JSON to stdout when approving OR denying. When
 * the file is outside the data dir and not a cursor path, returns 0
 * silently and lets the default permission evaluator decide.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import {
  dataDirContains,
  logBreadcrumb,
  resolveShipyardData,
} from "../_hook_lib.mjs";
import { evaluateTerminalGate } from "../terminal-gate.mjs";

const LOG_NAME = ".auto-approve.log";

// Cursor-file basenames that get terminal-gate evaluation. Anything else
// in the data dir falls through to the existing auto-approve path.
const CURSOR_BASENAMES = new Set([
  "EXECUTE-CURSOR.md",
  "REVIEW-CURSOR.md",
]);

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
    // Terminal-cursor gate. Runs only for the two cursor basenames; every
    // other data-dir write skips straight to the auto-approve branch
    // below. The gate's job is to refuse "claim of success" terminal
    // writes that lack the supporting event-log evidence — this is the
    // structural enforcement that prevents the inline-execute bypass
    // surfaced by the v2.5.0 confedit incident.
    const base = basename(filePath);
    if (CURSOR_BASENAMES.has(base)) {
      const proposedContent = computeProposedContent(toolName, toolInput, filePath);
      if (proposedContent !== null) {
        const verdict = evaluateTerminalGate({
          dataDir: shipyardData,
          proposedContent,
        });
        if (!verdict.allowed) {
          logBreadcrumb(shipyardData, LOG_NAME, "deny", [
            toolName,
            filePath,
            "terminal_gate",
            ...verdict.reasons,
          ]);
          const reason =
            "Terminal-cursor gate refused this write — the claim of success is missing required event-log evidence:\n" +
            verdict.reasons.map((r) => `  - ${r}`).join("\n") +
            "\n\nFix the gap (re-run the relevant skill stage so the events are emitted) and retry, or write a non-terminal cursor first to preserve in-progress state.";
          const response = {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          };
          process.stdout.write(JSON.stringify(response));
          return 0;
        }
      }
    }

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

/**
 * Compute the post-tool content of a cursor file for gate evaluation.
 *
 * For Write the proposed content is the tool input's `content` directly.
 * For Edit / MultiEdit we read the existing file (the cursor lives in
 * the data dir so the hook has read access) and apply the substitutions
 * in order, the same way Claude Code's tool runner would. NotebookEdit
 * doesn't apply to cursor files; if it ever does, fall back to null and
 * let the auto-approve branch take over.
 *
 * Returns null if we can't compute the proposed content (the gate then
 * skips, which is the fail-open default consistent with the rest of the
 * hook's permissive design — only explicit detection of a non-evidenced
 * success claim should result in a deny).
 */
function computeProposedContent(toolName, toolInput, filePath) {
  if (toolName === "Write") {
    return typeof toolInput.content === "string" ? toolInput.content : null;
  }
  let current = "";
  if (existsSync(filePath)) {
    try {
      current = readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  }
  if (toolName === "Edit") {
    const oldStr = toolInput.old_string;
    const newStr = toolInput.new_string;
    if (typeof oldStr !== "string" || typeof newStr !== "string") return null;
    const replaceAll = !!toolInput.replace_all;
    if (replaceAll) {
      // No regex — escape the old string and run a global replace.
      return current.split(oldStr).join(newStr);
    }
    const idx = current.indexOf(oldStr);
    if (idx < 0) return current; // edit doesn't match — leave content as-is
    return current.slice(0, idx) + newStr + current.slice(idx + oldStr.length);
  }
  if (toolName === "MultiEdit") {
    const edits = toolInput.edits;
    if (!Array.isArray(edits)) return null;
    let proposed = current;
    for (const edit of edits) {
      const oldStr = edit?.old_string;
      const newStr = edit?.new_string;
      if (typeof oldStr !== "string" || typeof newStr !== "string") return null;
      const replaceAll = !!edit?.replace_all;
      if (replaceAll) {
        proposed = proposed.split(oldStr).join(newStr);
      } else {
        const idx = proposed.indexOf(oldStr);
        if (idx < 0) continue;
        proposed = proposed.slice(0, idx) + newStr + proposed.slice(idx + oldStr.length);
      }
    }
    return proposed;
  }
  return null;
}
