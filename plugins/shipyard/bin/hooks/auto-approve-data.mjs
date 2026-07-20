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
 * Deterministic-state deny (v2.9.0). Model Write/Edit to the pipeline
 * state files — EXECUTE-CURSOR.md, REVIEW-CURSOR.md, PROGRESS.md,
 * HANDOFF.md — is DENIED outright with a pointer to
 * `shipyard-data cursor advance|pause|escalate|noop`. The CLI is the only
 * writer; it runs the same terminal-evidence gate and loop-leak guard
 * in-process (bin/cursor-cli.mjs), appends the pipeline event, and
 * rewrites the cursor atomically — so the event log and the cursor can no
 * longer disagree, and the v2.6.0 hook-era gates (evaluateTerminalGate /
 * evaluateLoopLeakGuard, still exported by terminal-gate.mjs) execute on
 * every advance instead of only on writes the model happened to route
 * through Write/Edit. This supersedes — and is strictly stronger than —
 * the v2.6.0 terminal-cursor gate and the v2.8.2 loop-leak guard that
 * previously ran here; both incidents (confedit 2026-05-19 inline bypass,
 * afm-app leaked-wakeup phantom start) are blocked at this layer because
 * the model cannot author cursor state at all.
 *
 * STDOUT CONTRACT: outputs JSON to stdout when approving OR denying. When
 * the file is outside the data dir and not a cursor path, returns 0
 * silently and lets the default permission evaluator decide.
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

// Pipeline state files with a single deterministic writer (the
// shipyard-data CLI / the render-progress pipeline). Model writes to these
// under sprints/current/ are denied — see the v2.9.0 header note.
const CLI_OWNED_BASENAMES = new Set([
  "EXECUTE-CURSOR.md",
  "REVIEW-CURSOR.md",
  "PROGRESS.md",
  "HANDOFF.md",
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
    // Deterministic-state deny (v2.9.0). These files have exactly one
    // writer — the shipyard-data CLI (which runs the terminal-evidence
    // gate + loop-leak guard in-process on every advance). A model
    // Write/Edit here is either an outdated skill body or an improvising
    // model routing around the pipeline; both get the same answer.
    const base = basename(filePath);
    if (CLI_OWNED_BASENAMES.has(base)) {
      logBreadcrumb(shipyardData, LOG_NAME, "deny", [
        toolName,
        filePath,
        "cli_owned_state",
      ]);
      const response = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            `${base} is deterministic pipeline state with a single writer — the shipyard-data CLI. ` +
            "Do not Write/Edit it. Use instead:\n" +
            "  - advance a stage:  shipyard-data cursor advance <execute|review> <stage> [k=v ...] [--note \"...\"]\n" +
            "  - pause:            shipyard-data cursor pause <execute|review> --note \"...\"\n" +
            "  - escalate:         shipyard-data cursor escalate <execute|review> reason=<short>\n" +
            "  - already-complete: shipyard-data cursor noop <execute|review>\n" +
            "PROGRESS.md is auto-rendered from the event log; HANDOFF.md is retired (pause state lives in the cursor).",
        },
      };
      process.stdout.write(JSON.stringify(response));
      return 0;
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
