#!/usr/bin/env node
/**
 * progress-render — derive sprints/current/PROGRESS.md from the event log.
 *
 * PROGRESS.md is a rendered artifact. The event log is the only source of
 * truth. Eliminates the dual-authority confusion where /ship-execute
 * treated PROGRESS.md as "confirmatory" and /ship-review treated it as a
 * drift mirror — they disagreed, and the model freelanced its own schema
 * at creation time. After v2.6.0, no skill Writes or Edits PROGRESS.md;
 * the PostToolUse render-progress hook regenerates it whenever a cursor
 * write lands, and ship-sprint's init-sprint CLI lays down the initial
 * template-canonical copy.
 *
 * The render is deterministic: same event log + SPRINT.md frontmatter
 * always produces the same PROGRESS.md byte-for-byte. The hook fires on
 * every cursor write, so the file stays current without skill effort.
 *
 * Sections (matching project-files/templates/PROGRESS.md):
 *   - Frontmatter `current_wave:` — latest wave_check_passed event's wave
 *     (or "complete" when pipeline_terminal is present).
 *   - `## Blockers` — tasks whose latest task_dispatch_returned has status=blocked.
 *   - `## Deviations` — empty placeholder (event source TBD; future extension).
 *   - `## Patch Tasks (added during sprint)` — patch_task_created events.
 *   - `## Session Log` — chronological summary of significant events.
 *
 * Run via the wrapper at `bin/shipyard-data`-style invocation:
 *
 *     node bin/progress-render.mjs
 *
 * Reads $SHIPYARD_DATA via the resolver. Writes
 * `$SHIPYARD_DATA/sprints/current/PROGRESS.md` atomically. Fails silently
 * if the data dir or SPRINT.md is missing — the hook calls this on every
 * cursor write and we don't want diagnostics noise on the no-op path.
 *
 * Performance budget: <50ms on a normal sprint (events file <1MB, scan
 * is O(N) over the JSONL). Tested in tests/test_progress_render.mjs.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { getDataDir, ShipyardResolverError } from "./shipyard-resolver.mjs";

function readSprintFrontmatter(dataDir) {
  const path = join(dataDir, "sprints", "current", "SPRINT.md");
  if (!existsSync(path)) return null;
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const k = line.slice(0, colon).trim();
    let v = line.slice(colon + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[k] = v;
  }
  return fm;
}

function readEvents(dataDir) {
  const path = join(dataDir, ".shipyard-events.jsonl");
  if (!existsSync(path)) return [];
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip malformed tail
    }
  }
  return events;
}

function deriveCurrentWave(events) {
  // Terminal event with success outcome → complete
  const terminal = events.find((e) => e.type === "pipeline_terminal" && e.pipeline === "ship-execute");
  if (terminal && (terminal.outcome === "success" || terminal.reason === "sprint_complete")) {
    return "complete";
  }
  // Otherwise: max wave that's passed its gate, +1 if there are no failures
  let maxPassed = 0;
  for (const ev of events) {
    if (ev.type === "wave_check_passed" && typeof ev.wave === "number") {
      if (ev.wave > maxPassed) maxPassed = ev.wave;
    }
  }
  return maxPassed === 0 ? 1 : maxPassed + 1;
}

function collectBlockers(events) {
  // Latest task_dispatch_returned per task — if status=blocked, it's a blocker.
  // Track {task, status, escalation_code, ts}.
  const latest = new Map();
  for (const ev of events) {
    if (ev.type !== "task_dispatch_returned") continue;
    const taskId = ev.task || ev.task_id;
    if (!taskId) continue;
    const existing = latest.get(taskId);
    if (!existing || (ev.ts && existing.ts && ev.ts > existing.ts)) {
      latest.set(taskId, {
        task: taskId,
        status: ev.status,
        reason: ev.escalation_code || "(no reason recorded)",
        ts: ev.ts || "",
      });
    }
  }
  const blockers = [];
  for (const entry of latest.values()) {
    if (entry.status === "blocked") {
      blockers.push(entry);
    }
  }
  return blockers.sort((a, b) => a.task.localeCompare(b.task));
}

function collectPatchTasks(events) {
  const patches = [];
  for (const ev of events) {
    if (ev.type !== "patch_task_created") continue;
    patches.push({
      task: ev.task_id || ev.task || "(unknown)",
      feature: ev.feature || "",
      source: ev.source || "",
      ts: ev.ts || "",
    });
  }
  return patches.sort((a, b) => a.task.localeCompare(b.task));
}

function summarizeSessionLog(events) {
  // Chronological one-liners for high-signal events only. Keep it short —
  // PROGRESS.md is for humans glancing at sprint state, not the full event
  // dump (that's what `shipyard-context diagnose` is for).
  const interesting = new Set([
    "pipeline_tick_completed",
    "wave_check_passed",
    "wave_check_escalated",
    "sprint_complete_passed",
    "sprint_complete_failed",
    "pipeline_terminal",
    "task_dispatch_returned",
  ]);
  const lines = [];
  for (const ev of events) {
    if (!interesting.has(ev.type)) continue;
    const ts = (ev.ts || "").slice(0, 19); // strip subsecond + tz
    if (ev.type === "pipeline_tick_completed") {
      lines.push(`- ${ts} \`${ev.pipeline || "?"}\` advanced to **${ev.next_stage || ev.stage || "?"}**`);
    } else if (ev.type === "wave_check_passed") {
      lines.push(`- ${ts} wave ${ev.wave || "?"} gate passed`);
    } else if (ev.type === "wave_check_escalated") {
      lines.push(`- ${ts} wave ${ev.wave || "?"} ESCALATED — ${ev.reason || ""}`);
    } else if (ev.type === "sprint_complete_passed") {
      lines.push(`- ${ts} sprint-complete predicate: all invariants green`);
    } else if (ev.type === "sprint_complete_failed") {
      lines.push(`- ${ts} sprint-complete predicate FAILED — invariants ${(ev.invariants_failed || []).join(",")}`);
    } else if (ev.type === "pipeline_terminal") {
      lines.push(`- ${ts} **${ev.pipeline || "?"}** terminal — ${ev.outcome || ""}`);
    } else if (ev.type === "task_dispatch_returned" && ev.status === "blocked") {
      lines.push(`- ${ts} task ${ev.task || ev.task_id || "?"} returned BLOCKED`);
    } else if (ev.type === "task_dispatch_returned" && ev.status === "complete") {
      lines.push(`- ${ts} task ${ev.task || ev.task_id || "?"} returned complete (${(ev.commit_sha || "").slice(0, 12)})`);
    }
  }
  return lines;
}

function renderTable(rows, columns) {
  if (rows.length === 0) {
    return `| ${columns.join(" | ")} |\n|${columns.map(() => "------").join("|")}|\n`;
  }
  const header = `| ${columns.join(" | ")} |`;
  const sep = `|${columns.map(() => "------").join("|")}|`;
  const body = rows
    .map((r) => `| ${columns.map((c) => (r[c] ?? "").toString().replace(/\|/g, "\\|")).join(" | ")} |`)
    .join("\n");
  return `${header}\n${sep}\n${body}\n`;
}

export function renderProgress(dataDir) {
  const sprintFm = readSprintFrontmatter(dataDir);
  if (!sprintFm) return null;
  const events = readEvents(dataDir);

  const currentWave = deriveCurrentWave(events);
  const blockerRows = collectBlockers(events).map((b) => ({
    Task: b.task,
    Reason: b.reason,
    Since: (b.ts || "").slice(0, 10),
    Escalation: b.status,
  }));
  const patchRows = collectPatchTasks(events).map((p) => ({
    Task: p.task,
    Patches: p.feature,
    Reason: p.source,
  }));
  const sessionLog = summarizeSessionLog(events);

  // Match the canonical template's exact section layout. Anything beyond
  // template sections lives below "## Session Log".
  const parts = [
    `---`,
    `current_wave: ${currentWave}`,
    `---`,
    ``,
    `# Sprint Progress`,
    ``,
    `<!-- Auto-rendered by bin/progress-render.mjs from .shipyard-events.jsonl. -->`,
    `<!-- Do not edit by hand — changes are overwritten on the next cursor write. -->`,
    ``,
    `## Blockers`,
    renderTable(blockerRows, ["Task", "Reason", "Since", "Escalation"]).trimEnd(),
    ``,
    `## Deviations`,
    renderTable([], ["Task", "Type", "What Changed", "Why"]).trimEnd(),
    ``,
    `## Patch Tasks (added during sprint)`,
    renderTable(patchRows, ["Task", "Patches", "Reason"]).trimEnd(),
    ``,
    `## Session Log`,
    sessionLog.length === 0 ? "_No events yet._" : sessionLog.join("\n"),
    ``,
  ];
  return parts.join("\n");
}

export function writeProgress(dataDir) {
  const rendered = renderProgress(dataDir);
  if (rendered === null) return false; // No SPRINT.md → nothing to render
  const path = join(dataDir, "sprints", "current", "PROGRESS.md");
  const tmpPath = path + ".tmp";
  writeFileSync(tmpPath, rendered, "utf8");
  renameSync(tmpPath, path);
  return true;
}

// CLI entry point. Idempotent — safe to call repeatedly.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  let dataDir;
  try {
    dataDir = getDataDir({ silent: true });
  } catch (err) {
    if (err instanceof ShipyardResolverError) {
      process.stderr.write(err.message);
      process.exit(1);
    }
    throw err;
  }
  const wrote = writeProgress(dataDir);
  if (wrote) {
    process.stdout.write(join(dataDir, "sprints", "current", "PROGRESS.md") + "\n");
  }
}
