/**
 * Terminal-cursor gate — refuse "claim of success" cursor writes that
 * lack the supporting evidence trail in the event log.
 *
 * Background. The v2.5.0 architecture documented the pipeline-cursor
 * protocol in prose (`/ship-execute` advances the cursor stage-by-stage,
 * emits `pipeline_tick_completed` / `task_dispatch_returned` /
 * `sprint_complete_passed` events, and only then writes the terminal
 * cursor) but there was no structural enforcement. A model running execute
 * inline could write 14 commits, never touch the cursor or event log
 * between the initial and terminal write, and successfully flip SPRINT.md
 * to `status: completed`. The confedit/sprint-001 incident on 2026-05-19
 * surfaced this.
 *
 * This module is the structural enforcement point. The auto-approve
 * PreToolUse hook calls `evaluateTerminalGate` for every Write/Edit
 * targeting `sprints/current/EXECUTE-CURSOR.md` or
 * `sprints/current/REVIEW-CURSOR.md`. When the proposed content claims
 * success (execute: `terminal: true` + `status: complete`; review:
 * `terminal: true` + `stage: terminal_approved`), the gate scans the event
 * log for the required signals. Missing signals → deny the write.
 *
 * Why this is the only place to plug. Skill bodies can be skipped by an
 * over-eager model. The auto-approve hook is the only mechanism every
 * cursor write must pass through. Moving the gate here makes inline-execute
 * bypass structurally impossible without asking the model to do anything
 * different from what the skill body already documents.
 *
 * Escalation / abort cursors are NOT gated. `status: escalated`,
 * `status: paused`, `stage: terminal_changes`, `stage: terminal_issues`
 * all carry their own meaning — they don't claim success and shouldn't
 * trigger evidence-requirement denials. Only the affirmative-success path
 * is gated.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Parse a YAML-ish frontmatter block from markdown content.
 *
 * Intentionally lightweight — we only need flat key/value pairs from the
 * leading `---\n...\n---\n` block. No nested structures, no anchors, no
 * multi-line strings. The cursor schema is flat by design.
 *
 * Returns an empty object if no frontmatter is found (e.g., body-only
 * edits that don't touch frontmatter). The gate then sees no `terminal`
 * field and skips evaluation, which is the safe default.
 */
export function parseFrontmatter(content) {
  if (!content || typeof content !== "string") return {};
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    // Strip inline comments (everything after #) — but only when the # is
    // preceded by whitespace, so `branch: "#main"` stays intact. Same rule
    // YAML uses.
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) continue;
    const k = line.slice(0, colonIdx).trim();
    let v = line.slice(colonIdx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[k] = v;
  }
  return fm;
}

function frontmatterBool(value) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return value.toLowerCase() === "true";
}

/**
 * Parse the `## Waves` section of SPRINT.md to extract wave numbers and
 * their task IDs. Tolerates the common templating variants — Markdown
 * `### Wave N` followed by `Tasks: [T001, T002]` or
 * `Tasks: T001, T002`. Wave numbers extracted from the heading; task IDs
 * from the first `Tasks:` line within five lines after each heading.
 */
export function parseWaves(sprintContent) {
  if (!sprintContent) return [];
  const lines = sprintContent.split(/\r?\n/);
  const waves = [];
  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^###\s+Wave\s+(\d+)/i);
    if (!headingMatch) continue;
    const waveNum = parseInt(headingMatch[1], 10);
    let tasks = [];
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const taskLine = lines[j].match(/Tasks:\s*\[?([^\]]+)\]?/i);
      if (taskLine) {
        tasks = taskLine[1]
          .split(",")
          .map((s) => s.trim().replace(/[\[\]]/g, ""))
          .filter((s) => /^T-?[A-Za-z0-9]+/.test(s));
        break;
      }
    }
    waves.push({ wave: waveNum, tasks });
  }
  return waves;
}

function readSprintMd(dataDir) {
  const sprintPath = join(dataDir, "sprints", "current", "SPRINT.md");
  if (!existsSync(sprintPath)) return null;
  try {
    return readFileSync(sprintPath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Read the structured event log, tail-bounded to keep startup cost low.
 * The events file is JSONL — one event per line. Malformed lines are
 * silently skipped (the log is append-only with bounded rotation, so the
 * tail can have a partial write that becomes whole on the next emit).
 */
export function readEvents(dataDir, tail = 5000) {
  const eventsPath = join(dataDir, ".shipyard-events.jsonl");
  if (!existsSync(eventsPath)) return [];
  let content;
  try {
    content = readFileSync(eventsPath, "utf8");
  } catch {
    return [];
  }
  const lines = content.split("\n").filter((l) => l.length > 0);
  const start = Math.max(0, lines.length - tail);
  const events = [];
  for (let i = start; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]));
    } catch {
      // skip malformed tail
    }
  }
  return events;
}

/**
 * Execute-pipeline gate.
 *
 * Fires only when the proposed cursor has `terminal: true` + the
 * affirmative-success markers (`status: complete` is the convention).
 * Escalation or paused cursors carry different meaning and are not gated.
 *
 * Required evidence in the event log:
 *
 *   1. `pipeline_tick_completed pipeline=ship-execute stage=wave_<N>_gate`
 *      for every wave N declared in SPRINT.md.
 *   2. `task_dispatch_returned pipeline=ship-execute status=complete`
 *      keyed by task_id (or task) for every task across all waves.
 *   3. `sprint_complete_passed` — the structural signal that
 *      evaluating-sprint-complete returned STATUS: COMPLETE.
 *
 * Missing items become deny reasons. Empty reasons list → allow.
 */
export function evaluateExecuteTerminal({ dataDir }) {
  const reasons = [];
  const sprintContent = readSprintMd(dataDir);
  if (!sprintContent) {
    reasons.push(
      "SPRINT.md not found at sprints/current/SPRINT.md — cannot validate terminal write without sprint context",
    );
    return { allowed: false, reasons };
  }
  const waves = parseWaves(sprintContent);
  if (waves.length === 0) {
    reasons.push(
      "SPRINT.md has no `### Wave N` headings — terminal write requires a populated wave structure",
    );
    return { allowed: false, reasons };
  }
  const allTaskIds = waves.flatMap((w) => w.tasks);

  const events = readEvents(dataDir);

  // Wave-gate evidence — for each declared wave, find at least one
  // pipeline_tick_completed event for wave_<N>_gate.
  const wavesGated = new Set();
  for (const ev of events) {
    if (ev.type !== "pipeline_tick_completed") continue;
    if (ev.pipeline !== "ship-execute") continue;
    if (typeof ev.stage !== "string") continue;
    const m = ev.stage.match(/^wave_(\d+)_gate$/);
    if (m) wavesGated.add(parseInt(m[1], 10));
  }
  for (const w of waves) {
    if (!wavesGated.has(w.wave)) {
      reasons.push(
        `Missing pipeline_tick_completed event for stage=wave_${w.wave}_gate — wave ${w.wave} never advanced through its completion gate`,
      );
    }
  }

  // Per-task evidence — for every task in every wave, at least one
  // task_dispatch_returned with status=complete.
  const tasksCompleted = new Set();
  for (const ev of events) {
    if (ev.type !== "task_dispatch_returned") continue;
    if (ev.pipeline !== "ship-execute") continue;
    if (ev.status !== "complete") continue;
    const id = ev.task_id || ev.task;
    if (id) tasksCompleted.add(id);
  }
  for (const t of allTaskIds) {
    if (!tasksCompleted.has(t)) {
      reasons.push(
        `Missing task_dispatch_returned status=complete for task ${t}`,
      );
    }
  }

  // Sprint-complete predicate evidence.
  const sprintCompletePassed = events.some(
    (ev) => ev.type === "sprint_complete_passed",
  );
  if (!sprintCompletePassed) {
    reasons.push(
      "Missing sprint_complete_passed event — evaluating-sprint-complete predicate never reported STATUS: COMPLETE",
    );
  }

  return { allowed: reasons.length === 0, reasons };
}

/**
 * Review-pipeline gate.
 *
 * Fires only for the affirmative-success path (`terminal_approved`). For
 * `terminal_changes` / `terminal_issues` we still require evidence that
 * the user-approval step actually ran (proving the model didn't skip
 * straight to terminal), but we don't require approve-verdicts — they're
 * by definition NOT approved.
 */
export function evaluateReviewTerminal({ dataDir, terminalStage }) {
  const reasons = [];
  const events = readEvents(dataDir);

  // All terminal paths require evidence that the demo_user (Stage 5)
  // tick fired — otherwise the model skipped the user-approval step.
  const demoUserReached = events.some(
    (ev) =>
      ev.type === "pipeline_tick_completed" &&
      ev.pipeline === "ship-review" &&
      ev.stage === "demo_user",
  );
  if (!demoUserReached) {
    reasons.push(
      "Missing pipeline_tick_completed event for stage=demo_user — review never reached the user-approval step",
    );
  }

  if (terminalStage === "terminal_approved") {
    // Every feature in SPRINT.md must have a verdict file recommending approve.
    const sprintContent = readSprintMd(dataDir);
    if (!sprintContent) {
      reasons.push(
        "SPRINT.md not found — cannot validate terminal_approved without feature list",
      );
    } else {
      const sprintFm = parseFrontmatter(sprintContent);
      const featuresRaw = sprintFm.features || "";
      const featureIds = featuresRaw
        .replace(/[\[\]]/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const fid of featureIds) {
        const verdictPath = join(dataDir, "verify", `${fid}-verdict.md`);
        if (!existsSync(verdictPath)) {
          reasons.push(`Missing verdict file: verify/${fid}-verdict.md`);
          continue;
        }
        let verdictContent;
        try {
          verdictContent = readFileSync(verdictPath, "utf8");
        } catch {
          reasons.push(`Cannot read verdict file: verify/${fid}-verdict.md`);
          continue;
        }
        const verdictFm = parseFrontmatter(verdictContent);
        if (verdictFm.recommendation !== "approve") {
          reasons.push(
            `Feature ${fid} verdict recommendation is "${verdictFm.recommendation || "(missing)"}", not "approve"`,
          );
        }
      }
    }
  } else if (
    terminalStage === "terminal_changes" ||
    terminalStage === "terminal_issues"
  ) {
    // At least one patch task or bug entry was created during this review.
    const patchOrBugCreated = events.some(
      (ev) =>
        ev.type === "patch_task_created" || ev.type === "bug_created",
    );
    if (!patchOrBugCreated) {
      reasons.push(
        `Terminal stage ${terminalStage} requires at least one patch_task_created or bug_created event in this review window`,
      );
    }
  }

  return { allowed: reasons.length === 0, reasons };
}

/**
 * Decide whether the cursor in `proposedContent` represents a gated
 * affirmative-success terminal write.
 *
 * Returns `{ shouldEvaluate: bool, pipeline, stage }`. Only the gate
 * caller's intermediate variable.
 */
function classify(proposedContent) {
  const fm = parseFrontmatter(proposedContent);
  if (!frontmatterBool(fm.terminal)) {
    return { shouldEvaluate: false };
  }
  const pipeline = (fm.pipeline || "").trim();
  const stage = (fm.stage || "").trim();
  const status = (fm.status || "").trim();

  if (pipeline === "ship-execute") {
    // Only the sprint-complete handoff is an affirmative-success terminal.
    // status: complete is the canonical success marker;
    // status: escalated/paused are explicit non-success and bypass the gate.
    if (status === "complete" || stage === "terminal_handoff_to_review") {
      return { shouldEvaluate: true, pipeline, stage };
    }
    return { shouldEvaluate: false };
  }
  if (pipeline === "ship-review") {
    // All three review terminals get gated, but with different evidence.
    if (
      stage === "terminal_approved" ||
      stage === "terminal_changes" ||
      stage === "terminal_issues"
    ) {
      return { shouldEvaluate: true, pipeline, stage };
    }
    return { shouldEvaluate: false };
  }
  return { shouldEvaluate: false };
}

/**
 * Top-level gate entry point. Called from the auto-approve PreToolUse
 * hook for every Write/Edit targeting a cursor file.
 *
 * Returns `{ allowed: bool, reasons: string[] }`. `allowed=true` with
 * empty reasons means either the cursor is not a gated terminal or the
 * evidence is complete. `allowed=false` carries the list of missing
 * signals — the hook surfaces these as the deny reason so the model can
 * read what's missing and either fix the gap or escalate.
 */
export function evaluateTerminalGate({ dataDir, proposedContent }) {
  const classification = classify(proposedContent);
  if (!classification.shouldEvaluate) {
    return { allowed: true, reasons: [] };
  }
  if (classification.pipeline === "ship-execute") {
    return evaluateExecuteTerminal({ dataDir });
  }
  return evaluateReviewTerminal({
    dataDir,
    terminalStage: classification.stage,
  });
}
