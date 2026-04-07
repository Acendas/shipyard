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
 *   shipyard-context spec-counts                       → epics/features/tasks/bugs/ideas/refs
 *   shipyard-context status-counts                     → features/epics/bugs/ideas
 *   shipyard-context debug-count                       → active debug sessions
 *
 *   --- Registry-scoped named subcommands (the only context primitives) ---
 *   shipyard-context view <name> [lines]               → head of registered data file
 *   shipyard-context list <name> [limit]               → list/glob registered location
 *   shipyard-context count-of <name>                   → count for registered location
 *   shipyard-context reference <skill> <name> [lines]  → head of plugin reference file
 *   shipyard-context version                           → "Shipyard v<x.y.z>"
 *   shipyard-context diagnose                          → resolver state dump for bug reports
 *   shipyard-context project-claude-md [lines]         → head of <project>/CLAUDE.md
 *   shipyard-context legacy-check                      → LEGACY_SHIPYARD_DETECTED | NO_LEGACY
 *
 *   Generic primitives (`head`, `cat`, `ls`, `ls-glob`, `ls-sort`, `count`) were
 *   removed in the platform-independence refactor. Skill bodies use Claude's
 *   native Read/Grep/Glob with the literal SHIPYARD_DATA prefix surfaced by
 *   the `path` subcommand. Registry-scoped forms stay because they are invoked
 *   from pre-exec lines with hardcoded names, never constructed from model
 *   output, so the `.cmd` wrapper space-arg mangling doesn't apply.
 *
 * SECURITY: All <relpath>/<reldir>/<pattern> args are validated:
 *  - Absolute paths rejected
 *  - `..` segments rejected before resolution
 *  - Final path must contain (via realpath) within SHIPYARD_DATA
 *  - Symlink escape blocked by realpath() containment check
 *
 * The `reference` subcommand validates <skill> and <name> against strict
 * allowlists and realpath-contains the result within <CLAUDE_PLUGIN_ROOT>/skills/
 * so a malicious skill body cannot escape the plugin tree.
 */

import { existsSync, openSync, readdirSync, readFileSync, realpathSync, statSync, closeSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
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

// readCat() removed in Phase 2 platform-independence refactor: the only
// caller was the `cat` subcommand, which is gone. Skill bodies use Read.

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

// ── Named-location registries ──────────────────────────────────────────────
//
// These map short, single-token names to a (path, default-lines, fallback)
// tuple so skills can write `!`shipyard-context view config`` instead of
// `!`shipyard-context head config.md 50 "No project initialized — ..."``.
// Adding an entry is the correct way to introduce a new pre-exec source.
// Fallback strings live here so they never travel through argv; change them
// here and every skill picks up the new text.

const VIEW_REGISTRY = {
  config: {
    path: ["config.md"],
    lines: 50,
    fallback: "No project initialized — run /ship-init",
  },
  codebase: {
    path: ["codebase-context.md"],
    lines: 50,
    fallback: "No codebase context captured yet",
  },
  backlog: {
    path: ["backlog", "BACKLOG.md"],
    lines: 50,
    fallback: "No backlog yet",
  },
  sprint: {
    path: ["sprints", "current", "SPRINT.md"],
    lines: 30,
    fallback: "No active sprint",
  },
  "sprint-progress": {
    path: ["sprints", "current", "PROGRESS.md"],
    lines: 50,
    fallback: "No sprint progress yet",
  },
  "sprint-handoff": {
    path: ["sprints", "current", "HANDOFF.md"],
    lines: 10,
    fallback: "No sprint handoff",
  },
  metrics: {
    path: ["memory", "metrics.md"],
    lines: 20,
    fallback: "No metrics captured yet",
  },
  "data-version": {
    // Internal Shipyard data-dir version marker — used by /ship-init to detect
    // a pre-existing data dir. Keep the NO_VERSION sentinel stable; ship-init
    // treats its absence as "fresh install".
    path: ["version.md"],
    lines: 5,
    fallback: "NO_VERSION",
  },
};

const LIST_REGISTRY = {
  epics: {
    kind: "dir",
    path: ["spec", "epics"],
    limit: 20,
    fallback: "No epics yet",
  },
  features: {
    kind: "dir",
    path: ["spec", "features"],
    limit: 30,
    fallback: "No features yet",
  },
  ideas: {
    kind: "dir",
    path: ["spec", "ideas"],
    limit: 20,
    fallback: "No ideas yet",
  },
  "debug-sessions": {
    kind: "glob",
    pattern: "debug/*.md",
    limit: 5,
    fallback: "No active debug sessions",
  },
  "quick-tasks": {
    kind: "glob-sort",
    pattern: "spec/tasks/Q-*.md",
    fallback: "No quick tasks yet",
  },
};

const COUNT_REGISTRY = {
  bugs: ["spec", "bugs"],
  features: ["spec", "features"],
  epics: ["spec", "epics"],
};

// Skill slug and reference-name allowlists. Tight on purpose — these are
// used to build filesystem paths from skill body content, which is otherwise
// a prompt-injection vector. See CLAUDE.md "Hooks are attack surface".
const SKILL_SLUG_RE = /^ship-[a-z0-9][a-z0-9-]{0,63}$/;
const REF_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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
    // Removed in platform-independence refactor (Phase 2):
    // `head`, `cat`, `ls`, `ls-glob`, `ls-sort`, `count` were generic
    // primitives only useful for ad-hoc bash improvisation in skill bodies.
    // Skill bodies now use Claude's native Read/Grep/Glob with the literal
    // SHIPYARD_DATA prefix from `!`shipyard-context path``. The registry-
    // scoped `view`, `list`, `count-of`, `spec-counts`, `status-counts`,
    // and `debug-count` cases below stay because they are invoked from
    // pre-exec lines with hardcoded names, not constructed from model
    // output.
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

      // Logcap breadcrumb tail — recent shipyard-logcap activity for this
      // project. Lives in tmp, not plugin data, so users debugging capture
      // issues can see which captures ran and how they exited without
      // having to know where tmp is on their platform.
      const logcapRoot = join(tmpdir(), "shipyard", projectHash);
      const logcapLog = join(logcapRoot, ".logcap.log");
      if (existsSync(logcapLog)) {
        out(`LOGCAP_ROOT=${logcapRoot}`);
        out(`LOGCAP_LOG=${logcapLog}`);
        try {
          const all = readFileSync(logcapLog, "utf8").trimEnd().split("\n").filter(Boolean);
          const tail = all.slice(-20);
          out(`LOGCAP_LOG_TAIL_${tail.length}_LINES:`);
          for (const line of tail) out(line);
        } catch {
          out("LOGCAP_LOG_TAIL=(read failed)");
        }
        // Also list the sessions that currently hold captures, so a user
        // with "where did my capture go?" can see the answer immediately.
        try {
          const sessions = readdirSync(logcapRoot, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort();
          out(`LOGCAP_SESSIONS=${sessions.length > 0 ? sessions.join(",") : "(none)"}`);
        } catch {
          // If the root doesn't exist or isn't readable, leave it out.
        }
      } else {
        out(`LOGCAP_ROOT=${logcapRoot}`);
        out("LOGCAP_LOG=(no captures recorded for this project)");
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
    case "view": {
      // Windows-safe: registered name → known relpath + baked fallback.
      // Optional [lines] override stays single-token.
      const name = args[0] ?? "";
      const entry = VIEW_REGISTRY[name];
      if (!entry) {
        die(
          `unknown view name: ${name || "(missing)"}. ` +
            `Known: ${Object.keys(VIEW_REGISTRY).join(", ")}`,
        );
      }
      const lines = args[1] ? parseInt(args[1], 10) : entry.lines;
      const target = safeJoin(sd, join(...entry.path));
      if (target === null) { out(entry.fallback); return; }
      const result = readHead(target, lines);
      out(result ?? entry.fallback);
      break;
    }
    case "list": {
      const name = args[0] ?? "";
      const entry = LIST_REGISTRY[name];
      if (!entry) {
        die(
          `unknown list name: ${name || "(missing)"}. ` +
            `Known: ${Object.keys(LIST_REGISTRY).join(", ")}`,
        );
      }
      if (entry.kind === "dir") {
        const limit = args[1] ? parseInt(args[1], 10) : entry.limit;
        const target = safeJoin(sd, join(...entry.path));
        if (target === null) { out(entry.fallback); return; }
        const entries = listDir(target, limit);
        out(entries && entries.length ? entries.join("\n") : entry.fallback);
      } else if (entry.kind === "glob") {
        const limit = args[1] ? parseInt(args[1], 10) : entry.limit;
        const entries = globMatch(sd, entry.pattern).slice(0, limit);
        out(entries.length ? entries.join("\n") : entry.fallback);
      } else if (entry.kind === "glob-sort") {
        const entries = globMatch(sd, entry.pattern).sort();
        out(entries.length ? entries.join("\n") : entry.fallback);
      } else {
        die(`internal: unknown list kind ${entry.kind}`);
      }
      break;
    }
    case "count-of": {
      const name = args[0] ?? "";
      const parts = COUNT_REGISTRY[name];
      if (!parts) {
        die(
          `unknown count-of name: ${name || "(missing)"}. ` +
            `Known: ${Object.keys(COUNT_REGISTRY).join(", ")}`,
        );
      }
      const target = safeJoin(sd, join(...parts));
      if (target === null) { out("0"); return; }
      out(String(countDir(target)));
      break;
    }
    case "reference": {
      // Read a reference file from CLAUDE_PLUGIN_ROOT/skills/<skill>/references/<name>.md.
      // Validated with strict allowlists + realpath containment so malicious
      // skill bodies cannot escape the plugin tree via this codepath.
      const skill = args[0] ?? "";
      const name = args[1] ?? "";
      const lines = args[2] ? parseInt(args[2], 10) : 80;
      const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
      if (!pluginRoot) { out("(CLAUDE_PLUGIN_ROOT unset — reference unavailable)"); return; }
      if (!SKILL_SLUG_RE.test(skill)) { out("(invalid skill slug)"); return; }
      if (!REF_NAME_RE.test(name)) { out("(invalid reference name)"); return; }
      const refBase = join(pluginRoot, "skills", skill, "references");
      const filename = name.endsWith(".md") ? name : `${name}.md`;
      const target = safeJoin(refBase, filename);
      if (target === null) { out("(reference not found)"); return; }
      const result = readHead(target, lines);
      out(result ?? "(reference not found)");
      break;
    }
    case "version": {
      const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
      if (!pluginRoot) { out("Shipyard (version unknown)"); return; }
      const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
      try {
        const raw = readFileSync(manifestPath, "utf8");
        const parsed = JSON.parse(raw);
        const v = parsed && typeof parsed.version === "string" ? parsed.version : null;
        out(v ? `Shipyard v${v}` : "Shipyard (version unknown)");
      } catch {
        out("Shipyard (version unknown)");
      }
      break;
    }
    case "project-claude-md": {
      const lines = args[0] ? parseInt(args[0], 10) : 50;
      let projectRoot;
      try {
        projectRoot = getProjectRoot();
      } catch {
        out("No CLAUDE.md");
        return;
      }
      const claudeMd = join(projectRoot, "CLAUDE.md");
      if (!existsSync(claudeMd)) { out("No CLAUDE.md"); return; }
      const result = readHead(claudeMd, lines);
      out(result ?? "No CLAUDE.md");
      break;
    }
    case "legacy-check": {
      // Replaces the bash `[ -f .shipyard/config.md ] && echo LEGACY... || echo NO_LEGACY`
      // one-liner in ship-init. Keeps the exact sentinel tokens — ship-init branches on them.
      let projectRoot;
      try {
        projectRoot = getProjectRoot();
      } catch {
        out("NO_LEGACY");
        return;
      }
      const legacyConfig = join(projectRoot, ".shipyard", "config.md");
      out(existsSync(legacyConfig) ? "LEGACY_SHIPYARD_DETECTED" : "NO_LEGACY");
      break;
    }
    default:
      die(
        "Usage: shipyard-context {path|head|cat|ls|ls-glob|ls-sort|count|spec-counts|" +
          "status-counts|debug-count|view|list|count-of|reference|version|" +
          "project-claude-md|legacy-check|diagnose}",
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
