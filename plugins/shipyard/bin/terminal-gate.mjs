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
 * `terminal: true` + `stage: terminal` / `terminal_approved`), the gate scans
 * the event log for the required signals. Missing signals → deny the write.
 *
 * Why this is the only place to plug. Skill bodies can be skipped by an
 * over-eager model. The auto-approve hook is the only mechanism every
 * cursor write must pass through. Moving the gate here makes inline-execute
 * bypass structurally impossible without asking the model to do anything
 * different from what the skill body already documents.
 *
 * Escalation / abort cursors are NOT gated. `status: escalated` and
 * `status: paused` carry their own meaning. Review terminal cursors are gated
 * so the user-approval step cannot be skipped before any terminal outcome.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateFreshness, FULL_SUITE_KEY } from "./verify-ledger.mjs";

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
 * their task IDs. Tolerates both templating variants:
 *   1. `Tasks: [T001, T002]` or `Tasks: T001, T002` on a single line
 *   2. Bullet lists: `- T015` entries following the heading
 *
 * Wave numbers extracted from the heading; task IDs from either the first
 * `Tasks:` line or from consecutive bullet lines within the wave block.
 * A wave block ends at the next `###` heading or `##` heading.
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
    for (let j = i + 1; j < lines.length; j++) {
      if (/^##/.test(lines[j])) break;
      const taskLine = lines[j].match(/Tasks:\s*\[?([^\]]+)\]?/i);
      if (taskLine) {
        tasks = taskLine[1]
          .split(",")
          .map((s) => s.trim().replace(/[\[\]]/g, ""))
          // Require trailing digits so placeholder tokens (TBD, TODO) in a
          // half-authored wave don't become phantom task IDs the terminal
          // gate then demands completion evidence for. Real IDs: T001,
          // T-P001 (patch), T-HOT1 — letters ≤3 then digits.
          .filter((s) => /^T-?[A-Za-z]{0,3}\d+$/.test(s));
        break;
      }
      const bulletMatch = lines[j].match(/^\s*[-*]\s+(T-?[A-Za-z]{0,3}\d+)\b/);
      if (bulletMatch) {
        tasks.push(bulletMatch[1]);
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
 *
 * Normalizes each entry so `ev.type` is always the event-type discriminator,
 * regardless of whether the emitter used `"type"` or `"event"` as the key.
 * This matters because skill bodies sometimes emit events via raw bash
 * (producing `{"event":"..."}`) instead of `shipyard-data events emit`
 * (which produces `{"type":"..."}`). The gate must accept both.
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
      const ev = JSON.parse(lines[i]);
      if (!ev.type && ev.event) {
        ev.type = ev.event;
      }
      events.push(ev);
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

  // Per-task evidence — for every task in every wave, either a
  // task_dispatch_returned status=complete, OR documented parking
  // evidence (task_blocked event / task_dispatch_returned status=blocked).
  // Parked (needs-attention) tasks are a designed outcome — the skill
  // deliberately advances past persistent failures and hands them to
  // /ship-review — so demanding `complete` for them made a sprint with
  // any parked task structurally unable to terminate (found in the
  // 2026-07 Fable review). Parking still requires its own event trail;
  // a task with NO evidence at all still blocks the terminal.
  const tasksCompleted = new Set();
  const tasksParked = new Set();
  for (const ev of events) {
    if (ev.type === "task_blocked") {
      const id = ev.task_id || ev.task;
      if (id) tasksParked.add(id);
      continue;
    }
    if (ev.type !== "task_dispatch_returned") continue;
    if (ev.pipeline !== "ship-execute") continue;
    const id = ev.task_id || ev.task;
    if (!id) continue;
    if (ev.status === "complete") tasksCompleted.add(id);
    else if (ev.status === "blocked") tasksParked.add(id);
  }
  for (const t of allTaskIds) {
    if (tasksCompleted.has(t)) continue;
    if (tasksParked.has(t)) continue;
    reasons.push(
      `Missing evidence for task ${t} — need task_dispatch_returned status=complete, or (for a parked task) a task_blocked event`,
    );
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
 * For all review terminal stages we require evidence that the user-approval
 * step actually ran (the demo_user tick). For `terminal_changes` /
 * `terminal_issues` we also require at least one patch_task_created /
 * bug_created event — these are the escalation terminals the skill actually
 * writes, and the gate enforces them.
 *
 * The `terminal_approved` branch (approve-verdict enforcement) is a
 * DEFENSIVE path: the current /ship-review approved-success flow archives
 * the sprint and emits `pipeline_terminal outcome=approved` rather than
 * writing a gated `terminal_approved` cursor, so this branch is not reached
 * by the normal flow. It is kept so that IF a future flow writes a
 * `terminal_approved` cursor, the approve-verdict check still fires. Per-
 * feature approve-verdicts are enforced upstream today (verify/<F>-verdict.md).
 *
 * `terminal_approved` also requires a fresh full-suite verification proof
 * from the ledger (bin/verify-ledger.mjs, P1) — closes correctness hole
 * 5.1, where release approval previously required no test evidence
 * whatsoever.
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

    // Correctness hole 5.1: release approval previously required NO test
    // evidence at all — a perfect verdict trail could still ship on a
    // commit nobody had actually run the full suite against. Require a
    // fresh (untampered-with-since, clean-tree) full-suite proof from the
    // verification-evidence ledger (P1). "Fresh" is evaluated the same way
    // Stage 1a's own reuse decision is — same predicate, same fail-safe
    // direction (any unevaluable condition => stale => deny).
    const freshness = evaluateFreshness(dataDir, { key: FULL_SUITE_KEY });
    if (!freshness.fresh) {
      reasons.push(
        `Missing fresh full-suite verification proof (ledger key="${FULL_SUITE_KEY}") — ${freshness.reason}. ` +
          `Run the full suite once after all mutating stages and record it: ` +
          `shipyard-data verify record --key ${FULL_SUITE_KEY} --command "<full-suite-command>" --exit 0 --capture <captured-output-path>.`,
      );
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
    // All review terminals get gated, but with different evidence.
    if (
      stage === "terminal" ||
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
 * Stale-cycle guard. Structural backstop against any driver re-entering
 * `/ship-execute` (or `/ship-review`) AFTER the sprint has already completed
 * and (possibly) been archived.
 *
 * The model-side no-op terminal sweep is supposed to catch this and exit,
 * but a misreading leaked wakeup can instead treat the absent cursor as a
 * "fresh start" and try to write a NON-terminal cursor (`terminal: false`,
 * claiming active work) into a `current/` that has no live sprint. That
 * write is the phantom-start signature, and — unlike the model sweep — the
 * PreToolUse hook fires on it unconditionally, so this guard cannot be
 * skipped.
 *
 * Rule (pipeline-aware; false-positive-free because a legit fresh sprint
 * always has `current/SPRINT.md` present before the first cursor write, and
 * execute never runs once SPRINT.md is `status: completed`):
 *
 *   - `terminal: true` cursor          → always allowed (terminal / no-op writes are fine).
 *   - ship-execute non-terminal cursor → DENY if no `current/SPRINT.md`, OR
 *     SPRINT.md `status: completed` (execute has no work left on a done sprint).
 *   - ship-review non-terminal cursor  → DENY only if no `current/SPRINT.md`
 *     (review legitimately runs ON a `status: completed` sprint, so only the
 *     archived/absent case is a leak).
 *
 * Returns `{ allowed: false, kind: "stale_cycle", reasons: [...] }` on deny;
 * `{ allowed: true, reasons: [] }` otherwise. Fail-open on unparseable
 * content / unknown pipeline, consistent with the hook's permissive design.
 */
export function evaluateLoopLeakGuard({ dataDir, proposedContent, cursorBasename }) {
  const fm = parseFrontmatter(proposedContent);
  // Terminal and no-op cursor writes are never phantom starts.
  if (frontmatterBool(fm.terminal)) {
    return { allowed: true, reasons: [] };
  }
  const pipeline =
    (fm.pipeline || "").trim() ||
    (cursorBasename === "REVIEW-CURSOR.md"
      ? "ship-review"
      : cursorBasename === "EXECUTE-CURSOR.md"
        ? "ship-execute"
        : "");
  if (pipeline !== "ship-execute" && pipeline !== "ship-review") {
    return { allowed: true, reasons: [] };
  }

  // Sprint-bypass modes (`--hotfix`, `--task`) legitimately run without a
  // normal sprint pipeline — `--hotfix` branches from main and may have no
  // (or a completed) SPRINT.md. Their stages are never produced by a no-arg
  // goal re-entry that fresh-starts at `preflight`, so exempt them.
  const stage = (fm.stage || "").trim();
  if (/^(hotfix|single_task|terminal_hotfix|terminal_single_task)\b/.test(stage)) {
    return { allowed: true, reasons: [] };
  }

  const sprintContent = readSprintMd(dataDir);
  const present = sprintContent !== null;
  const status = present
    ? (parseFrontmatter(sprintContent).status || "").trim().toLowerCase()
    : null;
  const archived = !present;
  const completed = present && status === "completed";

  const stale =
    pipeline === "ship-execute" ? archived || completed : archived;
  if (!stale) {
    return { allowed: true, reasons: [] };
  }

  const where = archived
    ? "there is no active sprint in sprints/current/ (already archived)"
    : "the sprint in sprints/current/ is already status: completed";
  return {
    allowed: false,
    kind: "stale_cycle",
    reasons: [
      `stale-cycle guard: ${where}, but this is a non-terminal ${pipeline} cursor write claiming active work after the cycle already completed`,
      `There is no sprint to run ${pipeline} against. Emit the no-op terminal event and stop /goal instead of starting phantom work.`,
    ],
  };
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
