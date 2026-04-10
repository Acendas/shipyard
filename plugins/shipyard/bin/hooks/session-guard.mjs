/**
 * PreToolUse hook: prevent source-code writes during non-implementation sessions.
 *
 * Node port of project-files/scripts/session-guard.py.
 *
 * When a discussion or planning skill is active (`.active-session.json`
 * exists in the Shipyard data dir AND its `skill` field is not null),
 * this hook blocks Write/Edit/MultiEdit/NotebookEdit calls that target
 * source code outside the plugin data dir and a small allowlist of config
 * directories.
 *
 * D7 — soft-delete sentinel: a session is treated as INACTIVE if either
 *   (a) the file does not exist, OR
 *   (b) the file's `skill` field is null/missing, OR
 *   (c) the file has a `cleared` field set.
 * This matches the new soft-delete pattern used by ship-discuss Phase 6:
 * skills overwrite the file with `{"skill": null, "cleared": "<iso>"}`
 * instead of physically deleting it.
 *
 * STDOUT CONTRACT: blocks via exit code 2. Violation messages go to
 * stderr. stdout unused.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, isAbsolute, relative as pathRelative, resolve as pathResolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  dataDirContains,
  logBreadcrumb,
  logEvent,
  resolveShipyardData,
} from "../_hook_lib.mjs";

const NON_IMPL_SKILLS = new Set(["ship-discuss", "ship-sprint"]);
const GUARDED_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

const RELATIVE_ALLOWED_PREFIXES = [
  ".claude/",
  ".claude" + sep,
  ".planning/",
  ".planning" + sep,
  "templates/",
  "templates" + sep,
];

const ALLOWED_EXTENSIONS = [
  ".md", ".json", ".yaml", ".yml", ".toml", ".lock",
  ".css", ".scss", ".html", ".svg", ".png", ".jpg",
  ".gif", ".ico", ".woff", ".woff2", ".eot", ".ttf",
];

const LOG_NAME = ".session-guard.log";

function expandTilde(p) {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return pathResolve(homedir(), p.slice(2));
  return p;
}

/**
 * Symlink-aware realpath that mirrors Python's os.path.realpath: resolve
 * symlinks in any existing prefix of the path, then append the unresolved
 * tail. Critical for symlink-escape defense (TOCTOU class).
 */
function tryRealpath(p) {
  if (!p) return null;
  const expanded = expandTilde(p);
  try {
    return realpathSync(expanded);
  } catch {
    const segments = [];
    let current = pathResolve(expanded);
    while (true) {
      try {
        const realParent = realpathSync(current);
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
    try { return pathResolve(expanded); } catch { return null; }
  }
}

function logLine(dataDir, decision, skill, toolName, filePath) {
  logBreadcrumb(
    dataDir,
    LOG_NAME,
    decision,
    [skill || "-", toolName || "-", filePath || "-", dataDir || "-"],
  );
}

/**
 * Returns the active session's skill name, or null if no active session.
 *
 * D7 sentinel handling: skill === null OR cleared field set → inactive.
 */
function loadActiveSession(dataDir) {
  if (!dataDir) return null;
  const sessionFile = join(dataDir, ".active-session.json");
  if (!existsSync(sessionFile)) return null;
  let raw;
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch {
    return null;
  }
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!session || typeof session !== "object") return null;
  if (session.cleared) return null; // soft-delete sentinel
  if (!session.skill || session.skill === null) return null;
  return { skill: session.skill, topic: session.topic || "unknown" };
}

export async function run(hookInput, env) {
  const toolName = hookInput?.tool_name || "";
  const toolInput = hookInput?.tool_input;
  if (!toolInput || typeof toolInput !== "object") return 0;

  const rawFilePath = toolInput.file_path || "";

  let shipyardData = await resolveShipyardData();
  if (shipyardData) {
    const real = tryRealpath(shipyardData);
    if (real) shipyardData = real;
  }

  if (!GUARDED_TOOLS.has(toolName)) return 0;

  if (!rawFilePath) {
    logLine(shipyardData, "skip", "", toolName, "");
    return 0;
  }

  const projectDir = (env && env.CLAUDE_PROJECT_DIR) || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const absFilePath = tryRealpath(rawFilePath);
  if (!absFilePath) {
    logLine(shipyardData, "skip", "", toolName, rawFilePath);
    return 0;
  }

  // Extension check first (cheap)
  const lower = absFilePath.toLowerCase();
  for (const ext of ALLOWED_EXTENSIONS) {
    if (lower.endsWith(ext)) {
      logLine(shipyardData, "allow-ext", "", toolName, absFilePath);
      return 0;
    }
  }

  // Absolute-path containment in SHIPYARD_DATA
  if (dataDirContains(absFilePath, shipyardData)) {
    logLine(shipyardData, "allow-in-data", "", toolName, absFilePath);
    return 0;
  }

  // Project-relative prefix check
  let relPath;
  try {
    relPath = pathRelative(projectDir, absFilePath).replace(/\\/g, "/");
  } catch {
    logLine(shipyardData, "skip", "", toolName, absFilePath);
    return 0;
  }

  if (relPath.startsWith("..") || isAbsolute(relPath)) {
    logLine(shipyardData, "skip", "", toolName, absFilePath);
    return 0;
  }

  for (const prefix of RELATIVE_ALLOWED_PREFIXES) {
    if (relPath.startsWith(prefix)) {
      logLine(shipyardData, "allow-prefix", "", toolName, absFilePath);
      return 0;
    }
  }

  // Active session check
  const session = loadActiveSession(shipyardData);
  if (!session) {
    logLine(shipyardData, "allow-no-session", "", toolName, absFilePath);
    return 0;
  }

  if (!NON_IMPL_SKILLS.has(session.skill)) {
    logLine(shipyardData, "allow-impl-skill", session.skill, toolName, absFilePath);
    return 0;
  }

  // Active non-implementation session + source-code write → block
  logLine(shipyardData, "block", session.skill, toolName, absFilePath);
  // Structured event for cross-cutting timeline. Only block events are
  // logged — allow events would dwarf the log at zero diagnostic value.
  logEvent(shipyardData, "session_guard_blocked", {
    skill: session.skill,
    topic: session.topic,
    tool: toolName,
    file: absFilePath,
  });
  process.stderr.write(
    `⚠️  SESSION GUARD: You are in a /${session.skill} session (topic: ${session.topic}).\n` +
    `Do not implement features during discussion/planning.\n` +
    `\n` +
    `Resume the discussion instead:\n` +
    `  - Use AskUserQuestion to re-align with the user\n` +
    `\n` +
    `To start implementing:\n` +
    `  Finish the discussion first, or /clear then /ship-execute\n` +
    `\n` +
    `To clear this guard: overwrite .active-session.json in the SHIPYARD_DATA dir ` +
    `with {"skill": null, "cleared": "<iso>"} (soft-delete sentinel).\n`,
  );
  return 2;
}
