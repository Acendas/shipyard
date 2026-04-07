/**
 * PostCompact hook: re-inject sprint context and track compaction pressure.
 *
 * Node port of project-files/scripts/post-compact.py.
 *
 * After compaction, Claude loses conversation history but files persist.
 * This hook outputs a state summary and tracks compaction count in
 * `.compaction-count`. After 2+ compactions during execution, warns about
 * context pressure.
 *
 * STDOUT CONTRACT: PostCompact stdout becomes a conversation message to
 * Claude. State summary and warnings go there intentionally.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, resolveShipyardData } from "../_hook_lib.mjs";

const SAFE_VALUE_RE = /^[A-Za-z0-9._/-]{1,80}$/;

function safeValue(s, fallback = "unknown") {
  if (typeof s !== "string") return fallback;
  if (SAFE_VALUE_RE.test(s)) return s;
  return fallback;
}

function readFrontmatterField(filepath, field) {
  try {
    const content = readFileSync(filepath, "utf8");
    const lines = content.split("\n");
    let inFm = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === "---" && !inFm) {
        inFm = true;
        continue;
      }
      if (line === "---" && inFm) break;
      if (inFm && line.startsWith(`${field}:`)) {
        return line
          .slice(field.length + 1)
          .trim()
          .replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // file missing or unreadable
  }
  return null;
}

function incrementCompactionCount(shipyardData) {
  const countFile = join(shipyardData, ".compaction-count");
  let count = 0;
  try {
    const raw = readFileSync(countFile, "utf8");
    // The Python version stored JSON `{count, last}`. We accept both that
    // shape and a bare integer (the new sentinel form skill bodies write
    // when resetting via "Write 0").
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === "object") count = data.count || 0;
      else if (typeof data === "number") count = data;
    } catch {
      const n = parseInt(raw.trim(), 10);
      if (!Number.isNaN(n)) count = n;
    }
  } catch {
    // file missing → count starts at 0
  }
  count += 1;
  try {
    atomicWrite(
      countFile,
      JSON.stringify({ count, last: new Date().toISOString() }),
    );
  } catch {
    // best effort
  }
  return count;
}

export async function run(_hookInput, _env) {
  const shipyardData =
    (await resolveShipyardData()) || join(process.cwd(), ".shipyard");

  const sprintFile = join(shipyardData, "sprints", "current", "SPRINT.md");
  const progressFile = join(shipyardData, "sprints", "current", "PROGRESS.md");
  const handoffFile = join(shipyardData, "sprints", "current", "HANDOFF.md");
  const execLock = join(shipyardData, ".active-execution.json");

  if (!existsSync(sprintFile)) return 0;

  const status = readFrontmatterField(sprintFile, "status");
  if (status !== "active") return 0;

  const sprintId = safeValue(readFrontmatterField(sprintFile, "id"));
  const branch = safeValue(readFrontmatterField(sprintFile, "branch"));

  let currentWave = null;
  if (existsSync(progressFile)) {
    const rawWave = readFrontmatterField(progressFile, "current_wave");
    currentWave = rawWave ? safeValue(rawWave, null) : null;
  }

  const parts = [`Active sprint: ${sprintId}`, `Branch: ${branch}`];
  if (currentWave) parts.push(`Current wave: ${currentWave}`);
  if (existsSync(handoffFile)) parts.push("HANDOFF.md exists — read it for pause state");

  if (existsSync(execLock)) {
    const count = incrementCompactionCount(shipyardData);
    if (count >= 2) {
      parts.push(
        `⚠ CONTEXT PRESSURE: ${count} compactions this session. ` +
          "Pause soon — type 'pause' to save progress before quota runs out. " +
          "Finish the current task, then pause at the wave boundary.",
      );
    } else {
      parts.push(`Compaction #${count} this session`);
    }
  }

  parts.push("Read SPRINT.md and PROGRESS.md for full state");

  process.stdout.write(`[Shipyard context restored] ${parts.join(" | ")}\n`);
  return 0;
}
