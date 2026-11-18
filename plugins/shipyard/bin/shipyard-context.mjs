#!/usr/bin/env node
/**
 * shipyard-context — read Shipyard data files for skill context blocks.
 *
 * Cross-platform Node implementation. Skills invoke this in `!`backtick```
 * blocks to load context snippets without using shell command substitution
 * (which Claude Code blocks in skill backtick commands and which is bash-only
 * anyway).
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

import { planInfo, readonlyStories } from "./sprint-ahead.mjs";
import { listRuns, quickInfo, stageOf } from "./quick.mjs";
import { homeOf } from "./shipyard-resolver.mjs";
import { existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, closeSync, readSync } from "node:fs";
import { eventTypeAliases } from "./vocab.mjs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { breadcrumbCandidates, getDataDir, getProjectHash, getProjectRoot, ShipyardResolverError } from "./shipyard-resolver.mjs";
import { evaluateExecuteTerminal, evaluateReviewTerminal, parseFrontmatter } from "./terminal-gate.mjs";
import { acquireLock, checkLock, resolveSessionIdentity } from "./skill-lock.mjs";
import { readEvents, activeTime } from "./event-report.mjs";
import { readCursor } from "./cursor-cli.mjs";
import { ensureInitializedDataDir, renderOnboardingLines } from "./init-data.mjs";
import { readQueue as readDiscussQueue, summarize as summarizeDiscussQueue } from "./discuss-queue.mjs";
import { waitingTopics as waitingDiscussTopics } from "./discuss-questions.mjs";
import { contextLine as sourcesContextLine } from "./sources.mjs";
import { contextLine as designSystemContextLine } from "./design-system.mjs";

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

function listDir(dirpath, limit) {
  try {
    return readdirSync(dirpath).slice(0, limit);
  } catch {
    return null;
  }
}

function countDir(dirpath) {
  // Records only: `.id-seq` and other dotfiles live beside them and used to
  // make "Ideas: 3" with two idea files.
  try {
    return readdirSync(dirpath).filter((n) => !n.startsWith(".")).length;
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
// raw file reads with argv-embedded fallback strings.
// Adding an entry is the correct way to introduce a new pre-exec source.
// Fallback strings live here so they never travel through argv; change them
// here and every skill picks up the new text.

const VIEW_REGISTRY = {
  config: {
    path: ["config.md"],
    lines: 140,
    fallback: "Project configuration missing — run shipyard-data onboarding bootstrap",
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
  // "sprint-handoff" retired in v2.9.0 — HANDOFF.md no longer exists; pause
  // state lives in the pipeline cursor (status: paused + body note).
  metrics: {
    path: ["memory", "metrics.md"],
    lines: 20,
    fallback: "No metrics captured yet",
  },
  "data-version": {
    // Internal Shipyard data-dir version marker. Keep the NO_VERSION sentinel
    // stable; older setup flows used its absence as "fresh install".
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
  stories: {
    kind: "dir",
    path: ["spec", "stories"],
    limit: 30,
    fallback: "No stories yet",
  },
  // legacy (pre-v4) story directory; read-only alias of `stories`
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
};

const COUNT_REGISTRY = {
  stories: ["spec", "stories"],
  steps: ["spec", "steps"],
  bugs: ["spec", "bugs"],
  features: ["spec", "features"],
  epics: ["spec", "epics"],
  ideas: ["spec", "ideas"],
  tasks: ["spec", "tasks"],
};

// Skill slug and reference-name allowlists. Tight on purpose — these are
// used to build filesystem paths from skill body content, which is otherwise
// a prompt-injection vector. See CLAUDE.md "Hooks are attack surface".
const SKILL_SLUG_RE = /^ship-[a-z0-9][a-z0-9-]{0,63}$/;
const REF_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function renderViewSection(dataDir, out, name, linesOverride = null) {
  const entry = VIEW_REGISTRY[name];
  if (!entry) throw new Error(`internal: unknown view section ${name}`);
  const lines = linesOverride ?? entry.lines;
  out(`--- ${name} ---`);
  const target = safeJoin(dataDir, join(...entry.path));
  if (target === null) {
    out(entry.fallback);
    return;
  }
  const result = readHead(target, lines);
  out(result ?? entry.fallback);
}

function readViewText(dataDir, name, linesOverride = null) {
  const entry = VIEW_REGISTRY[name];
  if (!entry) throw new Error(`internal: unknown view ${name}`);
  const lines = linesOverride ?? entry.lines;
  const target = safeJoin(dataDir, join(...entry.path));
  if (target === null) return entry.fallback;
  return readHead(target, lines) ?? entry.fallback;
}

function renderListSection(dataDir, out, name, limitOverride = null) {
  const entry = LIST_REGISTRY[name];
  if (!entry) throw new Error(`internal: unknown list section ${name}`);
  out(`--- ${name} ---`);
  if (entry.kind === "dir") {
    const limit = limitOverride ?? entry.limit;
    const target = safeJoin(dataDir, join(...entry.path));
    if (target === null) {
      out(entry.fallback);
      return;
    }
    const entries = listDir(target, limit);
    out(entries && entries.length ? entries.join("\n") : entry.fallback);
    return;
  }
  if (entry.kind === "glob") {
    const limit = limitOverride ?? entry.limit;
    const entries = globMatch(dataDir, entry.pattern).slice(0, limit);
    out(entries.length ? entries.join("\n") : entry.fallback);
    return;
  }
  if (entry.kind === "glob-sort") {
    const entries = globMatch(dataDir, entry.pattern).sort();
    out(entries.length ? entries.join("\n") : entry.fallback);
    return;
  }
  throw new Error(`internal: unknown list kind ${entry.kind}`);
}

function versionText() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginRoot) return "Shipyard (version unknown)";
  const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    const v = parsed && typeof parsed.version === "string" ? parsed.version : null;
    return v ? `Shipyard v${v}` : "Shipyard (version unknown)";
  } catch {
    return "Shipyard (version unknown)";
  }
}

function activeDebugCount(dataDir) {
  const debugDir = join(dataDir, "debug");
  let count = 0;
  try {
    for (const entry of readdirSync(debugDir)) {
      if (entry.endsWith(".md") && entry !== "resolved") count++;
    }
  } catch {
    // Missing debug dir means zero active sessions.
  }
  return count;
}

function cursorAlias(raw) {
  if (raw === "execute" || raw === "ship-execute") return "ship-execute";
  if (raw === "review" || raw === "ship-review") return "ship-review";
  return null;
}

function renderCursorState(dataDir, out, rawPipeline, prefix = "SHIPYARD_CURSOR") {
  const pipeline = cursorAlias(rawPipeline);
  if (!pipeline) {
    out(`${prefix}_ERROR=unknown-pipeline`);
    return;
  }
  const cursor = readCursor(dataDir, pipeline);
  const file = pipeline === "ship-execute" ? "EXECUTE-CURSOR.md" : "REVIEW-CURSOR.md";
  out(`${prefix}_PIPELINE=${pipeline}`);
  out(`${prefix}_FILE=${file}`);
  if (!cursor) {
    out(`${prefix}_PRESENT=false`);
    return;
  }
  out(`${prefix}_PRESENT=true`);
  out(`${prefix}_PATH=${cursor.path}`);
  out(`${prefix}_STAGE=${cursor.fm.stage ?? ""}`);
  out(`${prefix}_STATUS=${cursor.fm.status ?? ""}`);
  out(`${prefix}_TERMINAL=${cursor.fm.terminal === true ? "true" : "false"}`);
  if (cursor.fm.sprint !== undefined) out(`${prefix}_SPRINT=${cursor.fm.sprint}`);
  if (cursor.fm.wave_number !== undefined) out(`${prefix}_WAVE_NUMBER=${cursor.fm.wave_number}`);
  if (cursor.fm.iteration !== undefined) out(`${prefix}_ITERATION=${cursor.fm.iteration}`);
  if (cursor.fm.stuck_counter !== undefined) out(`${prefix}_STUCK_COUNTER=${cursor.fm.stuck_counter}`);
  if (cursor.pending.length) out(`${prefix}_PENDING_SUBAGENTS=${JSON.stringify(cursor.pending)}`);
  if (cursor.body) {
    out(`${prefix}_NOTE:`);
    for (const line of cursor.body.split("\n")) out(line);
  }
}

function renderDraftState(dataDir, out, kind) {
  const entry = kind === "research"
    ? { prefix: "SHIPYARD_RESEARCH_DRAFT", path: join("spec", ".research-draft.md") }
    : kind === "sprint"
      ? { prefix: "SHIPYARD_SPRINT_DRAFT", path: join("sprints", (() => { try { return planInfo(dataDir).mode === "draft-ahead" ? "next" : "current"; } catch { return "current"; } })(), "SPRINT-DRAFT.md") }
      : null;
  if (!entry) {
    out("SHIPYARD_DRAFT_ERROR=unknown-kind");
    return;
  }
  const target = safeJoin(dataDir, entry.path);
  out(`${entry.prefix}_PATH=${target ?? ""}`);
  if (!target || !existsSync(target)) {
    out(`${entry.prefix}_PRESENT=false`);
    return;
  }
  const raw = readHead(target, 80);
  const fm = raw ? parseFrontmatter(raw) : {};
  out(`${entry.prefix}_PRESENT=true`);
  if (fm.topic !== undefined) out(`${entry.prefix}_TOPIC=${fm.topic}`);
  if (fm.status !== undefined) out(`${entry.prefix}_STATUS=${fm.status}`);
  if (fm.obsolete !== undefined) out(`${entry.prefix}_OBSOLETE=${fm.obsolete === true ? "true" : "false"}`);
}

function renderProjectClaudeSection(out, lines = 50) {
  out("--- project-claude-md ---");
  let projectRoot;
  try {
    projectRoot = getProjectRoot();
  } catch {
    out("No CLAUDE.md");
    return;
  }
  const claudeMd = join(projectRoot, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    out("No CLAUDE.md");
    return;
  }
  const result = readHead(claudeMd, lines);
  out(result ?? "No CLAUDE.md");
}

// Canonical startup rules: the single home of the render-before-ask and paths
// rules. Printed by every command, so every word costs every startup (F016
// AC-2): only enforced / damage-preventing rules stay, one sentence each
// (F016 AC-4 as decided 2026-11-11). Printed once at top-level skill startup
// only; mid-skill calls (cursor-state, draft-state) pass canonical=false so the
// text is not re-loaded. No shell-specific tokens.
const CANONICAL_STARTUP_RULES = [
  "SHIPYARD_STARTUP_RULES:",
  "Render before asking. Before every AskUserQuestion, in this order: (1) write, as your message, a summary of 40 words or fewer: what this is about and what you recommend; (2) under it, show it: a table of the options and what each means, or a small diagram or a real example in a code block (`shipyard-data backlog board` and `discuss-questions next` hand you their text to write as it is); (3) end that message with the line `Question follows.` and end your turn there, calling no tool after it: Shipyard gives the turn straight back to you; (4) call the tool with that one question. A hook reads the chat and refuses a question with no summary and no picture above it. Anything else (a tool result, a file, the card itself) does not count as rendered: the person sees only the messages you write. One question per card; options show as a compact card, so the card holds only that short question and short choices (a hook refuses more).",
  "Recovery: if the user can't see what you reference, render it in full before asking again.",
  "Talking to the user: work quietly (no step-by-step account, no line per helper that finishes); a progress update is one line: a few words plus a small visual such as [████░░] 4/6. When you explain or ask, start with a summary readable in 15 seconds (40 words or fewer), then show it with a picture, a table or a real example before more words. Plain everyday words; the reader may not be an expert.",
  "Paths: use the literal absolute SHIPYARD_DATA prefix, also in Agent prompts; no `~`, `$HOME`, or shell variables in file_path; never hardcode paths or look in other worktrees; never cd into the data directory; never use echo, printf, or shell redirects to write state files (use Write; to stash an idea: `shipyard-data idea capture --title \"...\"`).",
  "Acceptance criteria in the chat: one plain line each (its id and what a person would see, in a few everyday words; `shipyard-data story acs <id>` lists them). Never paste Given/When/Then text when explaining or asking for approval; the full scenarios are in the story file, and one is shown in full only when the person asks for it.",
  "Searching: where a step names the Grep or Glob tool and this session has none, search with `grep` and `find` through the shell straight away (read-only, allowed); do not call a tool that is not there.",
];

// A quick run (after 4.0.6). Inside one, every command is told it is a stage of the run and what to do when it
// ends; at home, runs that are open or waiting to be merged are named in one line.
function renderQuickLines(dataDir, out) {
  try {
    const q = quickInfo(dataDir);
    if (q && q.state === "active") {
      out(`SHIPYARD_QUICK_RUN=${q.run} branch=${q.branch} stage=${stageOf(dataDir)?.stage ?? "?"}`);
      out(`QUICK RUN: this command is one stage of a quick run on one item (${JSON.stringify(String(q.item).slice(0, 160))}). The records here are the run's own; the regular project's backlog, sprint and numbers are not part of it and are not shown. Do everything this command does, with every check it has: nothing is lighter because the run is quick. When discussing: the item is here to be built, so it is refined into stories (or filed as one small task when the router says land-now); saving it as an idea only, and the hotfix lane, do not apply. When planning: every approved story of the run is in the plan, capacity is not a limit, and the approval card is the person's go-ahead for the build. When this command ends, do not name a next command and do not stop: run \`shipyard-data quick next\` and do what it says.`);
      return;
    }
    const open = listRuns(homeOf(dataDir)).filter((r) => ["active", "finished"].includes(r.state));
    if (open.length) out(`SHIPYARD_QUICK_RUNS=${open.map((r) => `${r.run} (${r.state === "active" ? "open" : "built, not merged yet"}, branch ${r.branch})`).join("; ")}`);
  } catch { /* a quick run never stops a command from starting */ }
}

function renderSkillStartup(dataDir, out, { canonical = true } = {}) {
  out(`SHIPYARD_DATA=${dataDir}`);
  const status = renderOnboardingLines(dataDir, out);
  if (canonical && !status.required) {
    for (const line of CANONICAL_STARTUP_RULES) out(line);
  }
  renderQuickLines(dataDir, out);
  return status.required;
}

// One-line report summary for the status dashboard (F010 AC-15). Scope: the
// current sprint's events plus events with no `sprint` field (explicitly
// counted as "unscoped", never guessed). Prints NOTHING when there are no events.
function renderReportSummary(dataDir, out) {
  let sprint = null;
  try {
    const m = /^id:\s*"?([^"\r\n]+?)"?\s*$/m.exec(readFileSync(join(dataDir, "sprints", "current", "SPRINT.md"), "utf8"));
    sprint = m ? m[1].trim() : null;
  } catch {}
  let evs;
  try {
    evs = readEvents(dataDir).events;
  } catch {
    return;
  }
  const has = (e) => typeof e.sprint === "string" && e.sprint.trim();
  const scoped = sprint ? evs.filter((e) => !has(e) || e.sprint.trim() === sprint) : evs;
  if (scoped.length === 0) return;
  const unscoped = scoped.filter((e) => !has(e)).length;
  const { activeMs, silentMs } = activeTime(scoped);
  const m = (ms) => (ms / 60000).toFixed(1);
  out(
    `Report: ${sprint ?? "all sprints"} | ${scoped.length} events (${unscoped} unscoped) | ` +
      `active ${m(activeMs)}m | silent ${m(silentMs)}m | details: shipyard-data report time`,
  );
}

function main() {
  // Asking for help never runs the command (4.13.6).
  const wantsHelp = (() => { const a = process.argv.slice(3); const cut = a.indexOf("--"); return (cut === -1 ? a : a.slice(0, cut)).some((x) => x === "--help" || x === "-h"); })();
  const cmd = wantsHelp ? "help" : (process.argv[2] ?? "help");
  const args = wantsHelp ? [] : process.argv.slice(3);

  // `diagnose` must run even when the data dir CANNOT be resolved — that's
  // precisely the failure a user runs diagnose to investigate (e.g. a
  // breadcrumb stranded by a TMPDIR split). For diagnose we tolerate the
  // resolution error and report it; every other command fails fast.
  let sd = null;
  let resolveError = null;
  try {
    sd = getDataDir({ silent: true });
  } catch (e) {
    if (!(e instanceof ShipyardResolverError)) throw e;
    resolveError = e.message;
    if (cmd !== "diagnose") {
      process.stderr.write(e.message);
      process.exit(1);
    }
  }
  if (!sd && cmd !== "diagnose") {
    process.stderr.write("ERROR: Could not resolve Shipyard data directory\n");
    process.exit(1);
  }
  if (cmd !== "diagnose") {
    sd = ensureInitializedDataDir({ dataDir: sd });
  }

  const out = (s) => process.stdout.write(s + "\n");
  const die = (msg) => { process.stderr.write(msg + "\n"); process.exit(1); };

  switch (cmd) {
    case "path": {
      out(`SHIPYARD_DATA=${sd}`);
      break;
    }
    case "sprint-planning": {
      if (renderSkillStartup(sd, out)) break;
      const { sessionId, unverified } = resolveSessionIdentity([]);
      const lock = acquireLock(sd, "planning", {
        skill: "ship-sprint",
        sessionId,
        unverified,
      });

      if (!lock.ok) {
        out("SHIPYARD_LOCK_ACQUIRED=false");
        out("SHIPYARD_LOCK_BLOCKED:");
        for (const line of (lock.message || "Planning lock blocked").trimEnd().split("\n")) {
          out(line);
        }
        break;
      }

      out("SHIPYARD_LOCK_ACQUIRED=true");
      out(`SHIPYARD_LOCK_DEPTH=${lock.json.depth ?? 1}`);
      if (lock.message) {
        out("SHIPYARD_LOCK_NOTICE:");
        for (const line of lock.message.trimEnd().split("\n")) out(line);
      }
      // 4.17: a sprint can be planned while another one runs. The CLI says
      // where this planner writes: sprints/next/ when a sprint owns current/.
      if (lock.json.running_beside?.length) out(`SHIPYARD_RUNNING_BESIDE=${lock.json.running_beside.join(",")}`);
      try {
        const pi = planInfo(sd);
        out(`SHIPYARD_SPRINT_PLAN_MODE=${pi.mode}`);
        out(`SHIPYARD_SPRINT_PLAN_DIR=${pi.dir}`);
        out(`SHIPYARD_SPRINT_PLAN_ID=${pi.id}`);
        if (pi.active) out(`SHIPYARD_ACTIVE_SPRINT=${pi.active.id} (${pi.active.status})`);
        if (pi.next) out(`SHIPYARD_NEXT_SPRINT_DRAFT=${pi.next.id} (${pi.next.status}; stories ${pi.next.stories.join(", ") || "none"})`);
        if (pi.promotable) out(`SHIPYARD_NEXT_SPRINT_READY=${pi.next.id}`);
      } catch { /* plan info is advisory */ }
      renderViewSection(sd, out, "config");
      renderViewSection(sd, out, "backlog");
      renderViewSection(sd, out, "sprint");
      renderViewSection(sd, out, "metrics");
      renderViewSection(sd, out, "codebase", 30);
      break;
    }
    case "sprint-execution": {
      if (renderSkillStartup(sd, out)) break;
      const sprintText = readViewText(sd, "sprint", 80);
      const sprintFm = parseFrontmatter(sprintText);
      const sprintId = sprintFm.id || null;
      const { sessionId, unverified } = resolveSessionIdentity([]);
      const lock = acquireLock(sd, "execution", {
        skill: "ship-execute",
        sprint: sprintId,
        sessionId,
        unverified,
      });

      out(`SHIPYARD_SPRINT_ID=${sprintId ?? "(unknown)"}`);
      if (!lock.ok) {
        out("SHIPYARD_LOCK_ACQUIRED=false");
        out("SHIPYARD_LOCK_BLOCKED:");
        for (const line of (lock.message || "Execution lock blocked").trimEnd().split("\n")) {
          out(line);
        }
        break;
      }

      out("SHIPYARD_LOCK_ACQUIRED=true");
      out(`SHIPYARD_LOCK_DEPTH=${lock.json.depth ?? 1}`);
      if (lock.json.cross_lock_allowed) out(`SHIPYARD_LOCK_CROSS_ALLOWED=${lock.json.cross_lock_allowed}`);
      if (lock.json.running_beside?.length) out(`SHIPYARD_RUNNING_BESIDE=${lock.json.running_beside.join(",")}`);
      if (lock.message) {
        out("SHIPYARD_LOCK_NOTICE:");
        for (const line of lock.message.trimEnd().split("\n")) out(line);
      }
      renderViewSection(sd, out, "config");
      renderCursorState(sd, out, "execute");
      out("--- sprint ---");
      out(sprintText);
      renderViewSection(sd, out, "sprint-progress");
      renderViewSection(sd, out, "codebase");
      break;
    }
    case "debug-session": {
      if (renderSkillStartup(sd, out)) break;
      renderListSection(sd, out, "debug-sessions");
      renderViewSection(sd, out, "config", 5);
      break;
    }
    case "help-context": {
      if (renderSkillStartup(sd, out)) break;
      renderViewSection(sd, out, "config");
      renderViewSection(sd, out, "codebase", 30);
      renderListSection(sd, out, "stories", 20);
      renderListSection(sd, out, "features", 20);
      renderViewSection(sd, out, "sprint");
      renderViewSection(sd, out, "sprint-progress", 20);
      renderViewSection(sd, out, "backlog", 30);
      out("--- version ---");
      out(versionText());
      break;
    }
    case "review-context": {
      if (renderSkillStartup(sd, out)) break;
      renderViewSection(sd, out, "config");
      renderCursorState(sd, out, "review");
      renderViewSection(sd, out, "sprint", 80);
      renderViewSection(sd, out, "sprint-progress");
      renderViewSection(sd, out, "metrics", 50);
      break;
    }
    case "backlog-context": {
      if (renderSkillStartup(sd, out)) break;
      renderViewSection(sd, out, "backlog");
      renderViewSection(sd, out, "config");
      renderViewSection(sd, out, "metrics");
      break;
    }
    case "spec-context": {
      const c = (...p) => countDir(join(sd, ...p));
      if (renderSkillStartup(sd, out)) break;
      out(
        `Stories: ${c("spec", "stories")} | Steps: ${c("spec", "steps")} | Epics: ${c("spec", "epics")} | Features: ${c("spec", "features")} | ` +
          `Tasks: ${c("spec", "tasks")} | Bugs: ${c("spec", "bugs")} | ` +
          `Ideas: ${c("spec", "ideas")} | References: ${c("spec", "references")}`,
      );
      break;
    }
    case "init-context": {
      if (renderSkillStartup(sd, out)) break;
      renderViewSection(sd, out, "data-version");
      renderViewSection(sd, out, "config");
      renderProjectClaudeSection(out);
      break;
    }
    case "status-dashboard": {
      const c = (...p) => countDir(join(sd, ...p));
      if (renderSkillStartup(sd, out)) break;
      renderViewSection(sd, out, "config");
      renderCursorState(sd, out, "execute", "SHIPYARD_EXECUTE_CURSOR");
      renderCursorState(sd, out, "review", "SHIPYARD_REVIEW_CURSOR");
      renderViewSection(sd, out, "sprint");
      renderViewSection(sd, out, "sprint-progress");
      renderViewSection(sd, out, "backlog");
      renderViewSection(sd, out, "metrics", 50);
      out(`Debug sessions: ${activeDebugCount(sd)} active`);
      out(
        `Stories: ${c("spec", "stories")} | Features: ${c("spec", "features")} | Epics: ${c("spec", "epics")} | ` +
          `Bugs: ${c("spec", "bugs")} | Ideas: ${c("spec", "ideas")}`,
      );
      renderReportSummary(sd, out);
      break;
    }
    case "cursor-state": {
      if (renderSkillStartup(sd, out, { canonical: false })) break;
      renderCursorState(sd, out, process.argv[3] ?? "");
      break;
    }
    case "draft-state": {
      if (renderSkillStartup(sd, out, { canonical: false })) break;
      renderDraftState(sd, out, process.argv[3] ?? "");
      break;
    }
    case "discuss-context": {
      if (renderSkillStartup(sd, out)) break;
      // v4 (F026): a CLI-owned discuss queue survives a dead session; /ship-discuss
      // resumes CHAINED mode at the recorded position when ACTIVE is true.
      {
        const q = readDiscussQueue(sd);
        const qs = q ? summarizeDiscussQueue(q) : null;
        out(`SHIPYARD_DISCUSS_QUEUE_ACTIVE=${qs?.active ? "true" : "false"}`);
        // v4.18: questions raised by research and not yet answered survive a
        // compacted or restarted session; the new one asks them before anything else.
        const dq = waitingDiscussTopics(sd);
        if (dq.waiting.length) out(`SHIPYARD_DISCUSS_QUESTIONS_WAITING=${dq.waiting.map((x) => `${x.topic}:${x.ids.join(",")}`).join(" ")}`);
        if (qs?.active) {
          out(`SHIPYARD_DISCUSS_QUEUE_POSITION=${qs.done}/${qs.total}`);
          out(`SHIPYARD_DISCUSS_QUEUE_CURRENT=${qs.current}`);
        }
      }
      const { sessionId, unverified } = resolveSessionIdentity([]);
      const lock = acquireLock(sd, "discuss", {
        skill: "ship-discuss",
        sessionId,
        unverified,
      });

      if (!lock.ok) {
        out("SHIPYARD_LOCK_ACQUIRED=false");
        out("SHIPYARD_LOCK_BLOCKED:");
        for (const line of (lock.message || "Discuss lock blocked").trimEnd().split("\n")) out(line);
        break;
      }

      out("SHIPYARD_LOCK_ACQUIRED=true");
      out(`SHIPYARD_LOCK_DEPTH=${lock.json.depth ?? 1}`);
      if (lock.json.cross_lock_allowed) out(`SHIPYARD_LOCK_CROSS_ALLOWED=${lock.json.cross_lock_allowed}`);
      // 4.17: other commands never block a discussion. It is told what runs
      // beside it and which stories belong to a sprint (running, or approved
      // and waiting), so it leaves them alone.
      if (lock.json.running_beside?.length) out(`SHIPYARD_RUNNING_BESIDE=${lock.json.running_beside.join(",")}`);
      {
        let ro = [];
        try { ro = readonlyStories(sd); } catch { ro = []; }
        if (ro.length) out(`SHIPYARD_READONLY_STORIES=${ro.join(",")}`);
      }
      if (lock.message) {
        out("SHIPYARD_LOCK_NOTICE:");
        for (const line of lock.message.trimEnd().split("\n")) out(line);
      }
      // After 4.0.3: where this project's knowledge lives, besides the code, is the owner's list. A discussion
      // looks there when it could matter and nowhere else, whatever connectors the session happens to have.
      try { out(`SHIPYARD_SOURCES=${sourcesContextLine(sd)}`); } catch { /* best-effort */ }
      // 4.0.7: a screen belongs to the project's design system; a discussion reads it before designing one.
      try { out(`SHIPYARD_DESIGN_SYSTEM=${designSystemContextLine(sd)}`); } catch { /* best-effort */ }
      renderViewSection(sd, out, "config");
      renderViewSection(sd, out, "codebase");
      renderListSection(sd, out, "epics");
      renderListSection(sd, out, "stories");
      renderListSection(sd, out, "features");
      if ((lock.json.running_beside ?? []).some((x) => x === "ship-execute" || x === "ship-review")) {
        renderViewSection(sd, out, "sprint", 80);
      }
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
        `Stories: ${c("spec", "stories")} | Steps: ${c("spec", "steps")} | Epics: ${c("spec", "epics")} | Features: ${c("spec", "features")} | ` +
          `Tasks: ${c("spec", "tasks")} | Bugs: ${c("spec", "bugs")} | ` +
          `Ideas: ${c("spec", "ideas")} | References: ${c("spec", "references")}`,
      );
      break;
    }
    case "status-counts": {
      const c = (...p) => countDir(join(sd, ...p));
      out(
        `Stories: ${c("spec", "stories")} | Features: ${c("spec", "features")} | Epics: ${c("spec", "epics")} | ` +
          `Bugs: ${c("spec", "bugs")} | Ideas: ${c("spec", "ideas")}`,
      );
      break;
    }
    case "diagnose": {
      // Dump resolver state for self-serve bug reports.
      // Grep-friendly key=value lines plus the breadcrumb log tail.
      const projectRoot = getProjectRoot();
      const projectHash = getProjectHash(projectRoot);
      out(`SHIPYARD_DATA=${sd ?? "(UNRESOLVED)"}`);
      if (resolveError) {
        // The resolution failed — surface why, since this is exactly the
        // case diagnose exists for. Indent the multi-line message so it
        // stays one grep-able block.
        out(`RESOLVE_ERROR:`);
        for (const line of resolveError.trimEnd().split("\n")) out(`  ${line}`);
      }
      out(`PROJECT_ROOT=${projectRoot}`);
      out(`PROJECT_HASH=${projectHash}`);
      out(`CLAUDE_PLUGIN_DATA=${process.env.CLAUDE_PLUGIN_DATA ?? "(unset)"}`);
      out(`CLAUDE_PLUGIN_ROOT=${process.env.CLAUDE_PLUGIN_ROOT ?? "(unset)"}`);
      out(`CLAUDE_PROJECT_DIR=${process.env.CLAUDE_PROJECT_DIR ?? "(unset)"}`);
      out(`TMPDIR=${process.env.TMPDIR ?? "(unset)"}`);

      // Data-dir discovery state — which of the resolver's fallbacks would
      // fire. This is what makes a TMPDIR-split or a stranded/misplaced
      // breadcrumb legible at a glance (the 2026-05-28 /ship-discuss failure).
      // Each breadcrumb candidate: present (and where it points) or missing.
      for (const cand of breadcrumbCandidates(projectHash)) {
        let state = "(missing)";
        try {
          const value = readFileSync(cand, "utf8").trim();
          state = existsSync(value) ? `-> ${value}` : `-> ${value} (TARGET MISSING)`;
        } catch { /* missing/unreadable — keep (missing) */ }
        out(`BREADCRUMB[${cand}]=${state}`);
      }
      // `.shipyard` symlink fallback: present + target + whether it validates
      // against this project's hash (what readDataDirLink requires).
      const linkPath = join(projectRoot, ".shipyard");
      try {
        const st = lstatSync(linkPath);
        if (st.isSymbolicLink()) {
          const raw = (() => { try { return readlinkSync(linkPath); } catch { return "(unreadable)"; } })();
          let valid = "no";
          try {
            const real = realpathSync(linkPath);
            valid = real.endsWith(`${join("projects", projectHash)}`) ? "yes" : `no (-> ${real})`;
          } catch { valid = "no (dangling)"; }
          out(`SHIPYARD_LINK=${linkPath} -> ${raw} (valid-for-hash: ${valid})`);
        } else {
          out(`SHIPYARD_LINK=${linkPath} (exists but NOT a symlink — blocked)`);
        }
      } catch {
        out(`SHIPYARD_LINK=(absent)`);
      }

      // The remaining sections read files under the data dir, so they only
      // apply when resolution succeeded. When it didn't, the discovery state
      // above is the actionable part of the report.
      if (!sd) {
        out("AUTO_APPROVE_LOG=(skipped — data dir unresolved)");
        out("SHIPYARD_EVENTS_LOG=(skipped — data dir unresolved)");
        break;
      }

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

      // Structured event log tail. This is the cross-cutting timeline
      // (compactions, session blocks, TDD violations, builder returns)
      // that the auto-approve log doesn't cover. Bug reports paste this
      // and we get the full picture of what happened.
      const eventsPath = join(sd, ".shipyard-events.jsonl");
      if (existsSync(eventsPath)) {
        out(`SHIPYARD_EVENTS_LOG=${eventsPath}`);
        try {
          const all = readFileSync(eventsPath, "utf8").trimEnd().split("\n").filter(Boolean);
          const tail = all.slice(-50);
          out(`SHIPYARD_EVENTS_TAIL_${tail.length}_LINES:`);
          for (const line of tail) out(line);
        } catch {
          out("SHIPYARD_EVENTS_TAIL=(read failed)");
        }
      } else {
        out("SHIPYARD_EVENTS_LOG=(does not exist — no events recorded yet)");
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
      out(`Debug sessions: ${activeDebugCount(sd)} active`);
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
      out(versionText());
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
    case "check-commit-exists": {
      // Verify a commit sha exists in the current repo. Used by
      // verifying-wave-completion (invariant 2) and evaluating-sprint-complete
      // (invariant 1) to confirm subagent-returned shas are real before
      // trusting the structured return contract.
      //
      // Exit 0 = sha exists. Exit 1 = sha missing or invalid. Output is the
      // resolved sha on success (so callers can confirm the abbreviated form
      // they passed resolved to the same object), or the literal "missing" on
      // failure.
      const sha = args[0];
      if (!sha || !/^[a-f0-9]{4,64}$/.test(sha)) {
        die("Usage: shipyard-context check-commit-exists <sha>");
      }
      const proc = spawnSync("git", ["cat-file", "-e", sha], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      if (proc.status === 0) {
        const resolve = spawnSync("git", ["rev-parse", "--verify", sha], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        });
        out(resolve.status === 0 ? resolve.stdout.trim() : sha);
        process.exit(0);
      }
      out("missing");
      process.exit(1);
    }
    case "scan-events": {
      // Read the structured event log tail, filtered to specific event types.
      // Used by verifying-wave-completion (invariants 1, 4, 5) and
      // evaluating-sprint-complete (invariants 1, 5) to inspect the log
      // without re-implementing JSONL parsing in skill prose.
      //
      // Usage: scan-events --tail N <type1> [type2 ...]
      // Output: matching JSONL lines (one per match), or nothing if no matches.
      let tail = 200;
      const types = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--tail") {
          const n = parseInt(args[++i], 10);
          if (!Number.isFinite(n) || n <= 0 || n > 100000) {
            die("scan-events: --tail must be a positive integer ≤ 100000");
          }
          tail = n;
        } else {
          types.push(a);
        }
      }
      if (types.length === 0) {
        die("Usage: shipyard-context scan-events [--tail N] <type1> [type2 ...]");
      }
      const eventsPath = join(sd, ".shipyard-events.jsonl");
      if (!existsSync(eventsPath)) {
        // No events yet — print nothing, exit 0. Consumer treats empty as "no markers".
        process.exit(0);
      }
      let content;
      try {
        content = readFileSync(eventsPath, "utf8");
      } catch {
        process.exit(0);
      }
      const lines = content.split("\n").filter((l) => l.length > 0);
      const start = Math.max(0, lines.length - tail);
      // v4: a reader naming either spelling of a renamed event sees both
      // (patch_task_created ~ patch_step_created, feature_* ~ story_*, ...).
      const typeSet = new Set(types.flatMap((t) => eventTypeAliases(t)));
      for (let i = start; i < lines.length; i++) {
        try {
          const ev = JSON.parse(lines[i]);
          const evType = ev.type || ev.event;
          if (typeSet.has(evType)) {
            out(lines[i]);
          }
        } catch {
          // Malformed line — skip silently. Event log is append-only; a
          // partial write at the tail is recoverable on next emit.
          continue;
        }
      }
      break;
    }
    case "check-dirty-worktrees": {
      // List worktrees with uncommitted state, scoped to `shipyard/wt-*`.
      // Used by verifying-wave-completion (invariant 6) and
      // evaluating-sprint-complete (invariant 6).
      //
      // Output: one absolute worktree path per line, empty if all clean.
      // Exit 0 always — the output IS the result. Callers decide whether
      // empty output means PASS or whether non-empty means RECOVERABLE.
      const wtList = spawnSync("git", ["worktree", "list", "--porcelain"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      if (wtList.status !== 0) {
        // Not in a git repo or no worktrees — output nothing, exit 0.
        process.exit(0);
      }
      const worktrees = [];
      let current = null;
      for (const line of wtList.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          if (current) worktrees.push(current);
          current = line.slice("worktree ".length).trim();
        }
      }
      if (current) worktrees.push(current);
      for (const wt of worktrees) {
        // Only inspect shipyard worktrees; ignore the parent repo and any
        // unrelated user worktrees.
        const base = wt.split(/[\\/]/).pop() || "";
        if (!base.startsWith("wt-")) continue;
        const status = spawnSync("git", ["-C", wt, "status", "--porcelain"], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        });
        if (status.status === 0 && status.stdout.trim().length > 0) {
          out(wt);
        }
      }
      break;
    }
    case "check-dirty-tree": {
      // Report uncommitted state in the MAIN working tree (the project root
      // checkout), not the shipyard/wt-* worktrees. This is the in-place
      // (isolation: none) counterpart to check-dirty-worktrees: when builders
      // run sequentially in-place, a failed builder leaves the shared working
      // tree dirty and the next task inherits it — and check-dirty-worktrees
      // (scoped to wt-*) never sees it. Used by the per-task in-place gate and
      // the wave/sprint completeness invariants when isolation is off.
      //
      // Output: the `git status --porcelain` lines (empty if clean). Exit 0
      // always — the output IS the result; the caller decides PASS/RECOVER.
      let projectRoot;
      try {
        projectRoot = getProjectRoot();
      } catch (err) {
        if (err instanceof ShipyardResolverError) process.exit(0);
        throw err;
      }
      const status = spawnSync("git", ["-C", projectRoot, "status", "--porcelain"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      if (status.status === 0 && status.stdout.trim().length > 0) {
        process.stdout.write(status.stdout.trim() + "\n");
      }
      process.exit(0);
    }
    case "terminal-gate": {
      // Diagnostic: inspect what the terminal-cursor gate would say about
      // the current data dir. Users run this when they hit a deny from the
      // auto-approve hook and want a readable list of what's still missing.
      //
      // Usage: shipyard-context terminal-gate <pipeline> [terminal_stage]
      //   pipeline: ship-execute | ship-review
      //   terminal_stage (review only): terminal_approved | terminal_changes | terminal_issues
      //                                  defaults to terminal_approved
      const pipeline = args[0];
      if (!pipeline) {
        die("Usage: shipyard-context terminal-gate <ship-execute|ship-review> [terminal_stage]");
      }
      let verdict;
      if (pipeline === "ship-execute") {
        verdict = evaluateExecuteTerminal({ dataDir: sd });
      } else if (pipeline === "ship-review") {
        const stage = args[1] || "terminal_approved";
        verdict = evaluateReviewTerminal({ dataDir: sd, terminalStage: stage });
      } else {
        die(`terminal-gate: unknown pipeline "${pipeline}". Expected: ship-execute | ship-review`);
      }
      if (verdict.allowed) {
        out("ALLOW — terminal cursor write would succeed.");
        process.exit(0);
      }
      out("DENY — terminal cursor write would be refused. Missing evidence:");
      for (const reason of verdict.reasons) {
        out(`  - ${reason}`);
      }
      process.exit(1);
    }
    default:
      die(
        "Usage: shipyard-context {path|spec-counts|status-counts|debug-count|" +
          "view|list|count-of|reference|version|project-claude-md|diagnose|" +
          "check-commit-exists|scan-events|check-dirty-worktrees|check-dirty-tree|terminal-gate}",
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
