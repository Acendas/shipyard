#!/usr/bin/env node
/**
 * shipyard-context — read Shipyard data files for skill context blocks.
 *
 * Cross-platform Node implementation. Replaces the legacy extensionless
 * Python script. Skills invoke this in `!`backtick``` blocks to load context
 * snippets without using shell command substitution (which Claude Code blocks
 * in skill backtick commands and which is bash-only anyway).
 *
 * Usage:
 *   shipyard-context path                              → SHIPYARD_DATA=/full/path
 *   shipyard-context head <relpath> [lines] [fallback] → head of data file
 *   shipyard-context cat <relpath> [fallback]          → full data file
 *   shipyard-context ls <reldir> [limit] [fallback]    → list directory
 *   shipyard-context ls-glob <pattern> [limit] [fallback] → list glob match
 *   shipyard-context ls-sort <pattern> [fallback]      → sorted glob match
 *   shipyard-context count <reldir>                    → file count
 *   shipyard-context spec-counts                       → epics/features/tasks/bugs/ideas/refs
 *   shipyard-context status-counts                     → features/epics/bugs/ideas
 *   shipyard-context debug-count                       → active debug sessions
 *
 * SECURITY: All <relpath>/<reldir>/<pattern> args are validated:
 *  - Absolute paths rejected
 *  - `..` segments rejected before resolution
 *  - Final path must contain (via realpath) within SHIPYARD_DATA
 *  - Symlink escape blocked by realpath() containment check
 */

import { existsSync, openSync, readdirSync, readFileSync, realpathSync, statSync, closeSync, readSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { getDataDir, getProjectHash, getProjectRoot, ShipyardResolverError } from "./shipyard-resolver.mjs";

/**
 * Validate a user-supplied relative path and join it to base. Returns the
 * resolved absolute path, or null if the path is unsafe.
 */
function safeJoin(base, relpath) {
  if (!relpath) return null;
  if (isAbsolute(relpath)) return null;
  const parts = relpath.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) return null;
  const joined = join(base, relpath);
  // realpath only works on existing paths; for not-yet-created files, fall
  // back to the unresolved join after a containment check on the parent.
  let resolved;
  try {
    resolved = realpathSync(joined);
  } catch {
    resolved = joined;
  }
  let baseReal;
  try {
    baseReal = realpathSync(base);
  } catch {
    baseReal = base;
  }
  const rel = relative(baseReal, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved;
}

/**
 * Read the first N lines of a file. Returns null on any error.
 * Streams via small buffered reads so we don't load gigantic files.
 */
function readHead(filepath, lines) {
  let fd;
  try {
    fd = openSync(filepath, "r");
    let result = "";
    let lineCount = 0;
    const buf = Buffer.alloc(4096);
    while (lineCount < lines) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      const chunk = buf.subarray(0, n).toString("utf8");
      for (const ch of chunk) {
        result += ch;
        if (ch === "\n") {
          lineCount++;
          if (lineCount >= lines) break;
        }
      }
    }
    return result;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function readCat(filepath) {
  try {
    return readFileSync(filepath, "utf8");
  } catch {
    return null;
  }
}

function listDir(dirpath, limit) {
  try {
    return readdirSync(dirpath).slice(0, limit);
  } catch {
    return null;
  }
}

function countDir(dirpath) {
  try {
    return readdirSync(dirpath).length;
  } catch {
    return 0;
  }
}

/**
 * Minimal glob: supports `*` (no slash) and `?` only. We deliberately do not
 * pull in a glob library — these patterns come from skill bodies, not user
 * input, and the patterns in use are simple (`spec/features/*.md` etc.).
 */
function globMatch(base, pattern) {
  // Reject traversal/absolute up front
  const parts = pattern.replace(/\\/g, "/").split("/");
  if (parts.includes("..") || isAbsolute(pattern)) return [];

  const matches = [];
  function walk(rel, remaining) {
    if (remaining.length === 0) return;
    const [head, ...tail] = remaining;
    const dirAbs = join(base, rel);
    let entries;
    try {
      entries = readdirSync(dirAbs);
    } catch {
      return;
    }
    const re = new RegExp(
      "^" +
        head
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]") +
        "$",
    );
    for (const entry of entries) {
      if (!re.test(entry)) continue;
      const childRel = rel ? join(rel, entry) : entry;
      if (tail.length === 0) {
        matches.push(entry);
      } else {
        const childAbs = join(base, childRel);
        try {
          if (statSync(childAbs).isDirectory()) {
            walk(childRel, tail);
          }
        } catch {
          /* skip */
        }
      }
    }
  }
  walk("", parts);
  return matches;
}

function main() {
  const sd = getDataDir({ silent: true });
  if (!sd) {
    process.stderr.write("ERROR: Could not resolve Shipyard data directory\n");
    process.exit(1);
  }

  const cmd = process.argv[2] ?? "help";
  const args = process.argv.slice(3);

  const out = (s) => process.stdout.write(s + "\n");
  const die = (msg) => { process.stderr.write(msg + "\n"); process.exit(1); };

  switch (cmd) {
    case "path": {
      out(`SHIPYARD_DATA=${sd}`);
      break;
    }
    case "head": {
      const relpath = args[0] ?? "";
      const lines = args[1] ? parseInt(args[1], 10) : 50;
      const fallback = args[2] ?? "NO_DATA";
      if (!relpath) die("missing relative path");
      const target = safeJoin(sd, relpath);
      if (target === null) { out(fallback); return; }
      const result = readHead(target, lines);
      out(result ?? fallback);
      break;
    }
    case "cat": {
      const relpath = args[0] ?? "";
      const fallback = args[1] ?? "NO_DATA";
      if (!relpath) die("missing relative path");
      const target = safeJoin(sd, relpath);
      if (target === null) { out(fallback); return; }
      const result = readCat(target);
      out(result ?? fallback);
      break;
    }
    case "ls": {
      const reldir = args[0] ?? "";
      const limit = args[1] ? parseInt(args[1], 10) : 20;
      const fallback = args[2] ?? "empty";
      if (!reldir) die("missing relative dir");
      const target = safeJoin(sd, reldir);
      if (target === null) { out(fallback); return; }
      const entries = listDir(target, limit);
      out(entries && entries.length ? entries.join("\n") : fallback);
      break;
    }
    case "ls-glob": {
      const pattern = args[0] ?? "";
      const limit = args[1] ? parseInt(args[1], 10) : 20;
      const fallback = args[2] ?? "empty";
      if (!pattern) die("missing glob pattern");
      const entries = globMatch(sd, pattern).slice(0, limit);
      out(entries.length ? entries.join("\n") : fallback);
      break;
    }
    case "ls-sort": {
      const pattern = args[0] ?? "";
      const fallback = args[1] ?? "empty";
      if (!pattern) die("missing glob pattern");
      const entries = globMatch(sd, pattern).sort();
      out(entries.length ? entries.join("\n") : fallback);
      break;
    }
    case "count": {
      const reldir = args[0] ?? "";
      if (!reldir) die("missing relative dir");
      const target = safeJoin(sd, reldir);
      if (target === null) { out("0"); return; }
      out(String(countDir(target)));
      break;
    }
    case "spec-counts": {
      const c = (...p) => countDir(join(sd, ...p));
      out(
        `Epics: ${c("spec", "epics")} | Features: ${c("spec", "features")} | ` +
          `Tasks: ${c("spec", "tasks")} | Bugs: ${c("spec", "bugs")} | ` +
          `Ideas: ${c("spec", "ideas")} | References: ${c("spec", "references")}`,
      );
      break;
    }
    case "status-counts": {
      const c = (...p) => countDir(join(sd, ...p));
      out(
        `Features: ${c("spec", "features")} | Epics: ${c("spec", "epics")} | ` +
          `Bugs: ${c("spec", "bugs")} | Ideas: ${c("spec", "ideas")}`,
      );
      break;
    }
    case "diagnose": {
      // F15: dump resolver state for self-serve bug reports.
      // Format is grep-friendly key=value lines plus the breadcrumb log tail.
      const projectRoot = getProjectRoot();
      const projectHash = getProjectHash(projectRoot);
      out(`SHIPYARD_DATA=${sd}`);
      out(`PROJECT_ROOT=${projectRoot}`);
      out(`PROJECT_HASH=${projectHash}`);
      out(`CLAUDE_PLUGIN_DATA=${process.env.CLAUDE_PLUGIN_DATA ?? "(unset)"}`);
      out(`CLAUDE_PLUGIN_ROOT=${process.env.CLAUDE_PLUGIN_ROOT ?? "(unset)"}`);
      out(`CLAUDE_PROJECT_DIR=${process.env.CLAUDE_PROJECT_DIR ?? "(unset)"}`);

      const logPath = join(sd, ".auto-approve.log");
      if (existsSync(logPath)) {
        out(`AUTO_APPROVE_LOG=${logPath}`);
        // Tail last 20 lines
        try {
          const all = readFileSync(logPath, "utf8").trimEnd().split("\n");
          out(`AUTO_APPROVE_LOG_TAIL_${Math.min(20, all.length)}_LINES:`);
          for (const line of all.slice(-20)) out(line);
        } catch {
          out("AUTO_APPROVE_LOG_TAIL=(read failed)");
        }
      } else {
        out("AUTO_APPROVE_LOG=(does not exist)");
      }
      break;
    }
    case "debug-count": {
      const debugDir = join(sd, "debug");
      let count = 0;
      try {
        for (const entry of readdirSync(debugDir)) {
          if (entry.endsWith(".md") && entry !== "resolved") count++;
        }
      } catch { /* ignore */ }
      out(`Debug sessions: ${count} active`);
      break;
    }
    default:
      die(
        "Usage: shipyard-context {path|head|cat|ls|ls-glob|ls-sort|count|spec-counts|status-counts|debug-count}",
      );
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ShipyardResolverError) {
    process.stderr.write(err.message);
    process.exit(1);
  }
  throw err;
}
