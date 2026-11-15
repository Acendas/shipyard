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

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { eventMatches, WAVE_UNIT_ID_RE, WAVE_UNIT_ID_SRC } from "./vocab.mjs";
import { readStoryReview } from "./config-read.mjs";
import { join } from "node:path";
import { evaluateFreshness, FULL_SUITE_KEY } from "./verify-ledger.mjs";
import { parseFrontmatterList, splitItems } from "./frontmatter-list.mjs";
import { readMaxParkedRatio, readTriageSprintFindings } from "./config-read.mjs";
import { sprintFindings } from "./sprint-findings.mjs";

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
  const m = content.replace(/^\uFEFF/, "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
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
        // Shared helper strips surrounding quotes: Tasks: ["T001", "T002"].
        tasks = splitItems(taskLine[1].replace(/[\[\]]/g, ""))
          // Require trailing digits so placeholder tokens (TBD, TODO) in a
          // half-authored wave don't become phantom task IDs the terminal
          // gate then demands completion evidence for. Real IDs: P001 (v4
          // step), T001 (pre-v4 builder task), T-P001 (patch), T-HOT1 —
          // letters ≤3 then digits.
          .filter((s) => WAVE_UNIT_ID_RE.test(s));
        break;
      }
      const bulletMatch = lines[j].match(new RegExp(`^\\s*[-*]\\s+(${WAVE_UNIT_ID_SRC})\\b`));
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
 * F028: is a story's per-story review settled? `approve` settles; `changes`
 * settles only once a later story_review_dispositioned records where the
 * findings went. Shared by the execute terminal gate, `story-review check`
 * and the sprint-complete invariant so the three never disagree.
 */
export function storySettled(events, storyId, sprintId = null) {
  let verdict = null;
  let settled = false;
  for (const e of events) {
    if (sprintId && e.sprint && e.sprint !== sprintId) continue;
    const sid = e.story || e.feature;
    if (sid !== storyId) continue;
    if (eventMatches(e, "story_reviewed")) {
      verdict = String(e.verdict || "");
      settled = verdict === "approve";
    } else if (eventMatches(e, "story_review_dispositioned") && verdict === "changes") {
      settled = true;
    }
  }
  return { verdict, settled };
}

/** The SPRINT.md list that names the sprint's stories (`stories:` canonical, `features:` read), as parseFrontmatterList returns it. */
export function sprintStoryList(sprintContent) {
  const stories = parseFrontmatterList(sprintContent, "stories");
  return stories.raw !== undefined && stories.raw !== "" ? stories : parseFrontmatterList(sprintContent, "features");
}

/** Story ids a SPRINT.md names — S### (new) or legacy F###/B### aliases, letter-suffixed child ids kept, de-duplicated. Every reader uses this one rule. */
export function sprintStoryIds(sprintContent) {
  return [...new Set(sprintStoryList(sprintContent).items.flatMap((i) => i.match(/\b(?:[SF]\d+[a-z]?|B-?\d+)\b/g) || []))];
}

/** Id of the sprint in sprints/current/SPRINT.md, or null. One definition for the reports, risk and gates. */
export function currentSprintId(dataDir) {
  try {
    const p = join(dataDir, "sprints", "current", "SPRINT.md");
    if (!existsSync(p)) return null;
    return String(parseFrontmatter(readFileSync(p, "utf8")).id ?? "").trim() || null;
  } catch {
    return null;
  }
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

  // Completion-ratio gate (deferral guard). Parking satisfies a task's slot
  // above — a deliberate deadlock fix (2026-07 Fable review) — but with NO
  // ceiling that allowance lets a sprint park its way to green. Cap the parked
  // fraction; above the cap, refuse the terminal UNLESS a `terminal_parked_accepted`
  // event records that the user consciously accepted the parked set. That event
  // is the escape hatch the deadlock fix needs (a sprint CAN still terminate
  // with heavy parking) while removing the SILENT path (it now takes an explicit,
  // logged human acknowledgement, surfaced by the skill via AskUserQuestion).
  if (allTaskIds.length > 0) {
    // A step the plan gave to the person at the end (`needs_person: after`) waits for the
    // review by design: it is not a step the sprint failed to finish.
    const parkedInSprint = allTaskIds.filter((t) => tasksParked.has(t) && !tasksCompleted.has(t) && waitsForPerson(dataDir, t) !== "after");
    const ratio = parkedInSprint.length / allTaskIds.length;
    const maxRatio = readMaxParkedRatio(dataDir);
    const accepted = events.some((ev) => ev.type === "terminal_parked_accepted");
    if (ratio > maxRatio && !accepted) {
      const pct = (n) => `${Math.round(n * 100)}%`;
      reasons.push(
        `Parked ratio ${pct(ratio)} exceeds max ${pct(maxRatio)} — ${parkedInSprint.length} of ${allTaskIds.length} tasks parked ` +
          `(${parkedInSprint.join(", ")}). Complete more tasks, or record explicit user acceptance with ` +
          `\`shipyard-data events emit terminal_parked_accepted\` (only after confirming with the user — this is the deliberate escape hatch, not a rubber stamp).`,
      );
    }
  }

  // F028: per-story review settled for every story the sprint names
  // (execution.story_review, default on). A story reviewed when its last step
  // merged needs no sprint-end repeat; one never reviewed blocks the terminal.
  if (readStoryReview(dataDir)) {
    const sprintId = String(parseFrontmatter(sprintContent).id || "").trim() || null;
    for (const story of sprintStoryIds(sprintContent)) {
      const { verdict, settled } = storySettled(events, story, sprintId);
      if (settled) continue;
      reasons.push(
        verdict === "changes"
          ? `Story ${story} review verdict is 'changes' with no disposition — route the findings (patch steps, bug story, needs-attention or accepted) and run \`shipyard-data story-review disposition ${story} --via <how>\``
          : `Missing per-story review for ${story} — run spec review + gap analysis for the story and record it with \`shipyard-data story-review record ${story} --verdict approve|changes\` (or set execution.story_review: false to review only at sprint end)`,
      );
    }
  }

  // Findings captured during the sprint are decided (4.7.2): triaged, and a
  // defect above low severity has a fix step that returned (or was parked,
  // which the ratio guard above and the review both show).
  if (readTriageSprintFindings(dataDir)) {
    const open = sprintFindings({
      dataDir, events,
      sprintId: String(parseFrontmatter(sprintContent).id || "").trim() || null,
      sprintStoryIds: sprintStoryIds(sprintContent),
      stepStatus: (id) => (tasksCompleted.has(id) ? "complete" : tasksParked.has(id) ? "parked" : null),
    }).filter((f) => f.state !== "settled");
    for (const f of open) reasons.push(f.detail);
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
      // v4: `stories:` is the canonical SPRINT.md key; `features:` is read as its alias.
      // Same rule as every other sprint reader (block form included) — the
      // review terminal used to refuse a block list the execute terminal,
      // story-review and archive-sprint all accepted, so a review could never end.
      const parsed = sprintStoryList(sprintContent);
      const featureIds = sprintStoryIds(sprintContent);
      if (featureIds.length === 0) {
        reasons.push(
          `SPRINT.md features parsed to zero feature ids (raw value: ${JSON.stringify(parsed.raw)}) — cannot validate terminal_approved; use: features: [F001, F002]`,
        );
      }
      for (const fid of featureIds) {
        const verdictPath = join(dataDir, "verify", `${fid}-verdict.md`);
        if (!existsSync(verdictPath)) {
          reasons.push(`Missing verdict file for feature ${fid}: ${verdictPath}`);
          continue;
        }
        let verdictContent;
        try {
          verdictContent = readFileSync(verdictPath, "utf8");
        } catch {
          reasons.push(`Cannot read verdict file for feature ${fid}: ${verdictPath}`);
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
    // At least one patch step or bug story was created DURING THIS REVIEW: only
    // events after the latest ship-review preflight tick count, and a story that
    // merely got imported from a tracker (story_imported) never does.
    let reviewStart = -1;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === "pipeline_tick_completed" && ev.pipeline === "ship-review" && (ev.stage === "preflight" || ev.next_stage === "preflight")) reviewStart = i;
    }
    const patchOrBugCreated = events.slice(reviewStart + 1).some(
      (ev) =>
        eventMatches(ev, "patch_step_created", "story_created") && ev.source !== "tracker", // legacy: patch_task_created / bug_created
    );
    if (!patchOrBugCreated) {
      reasons.push(
        `Terminal stage ${terminalStage} requires at least one patch_step_created or story_created event (legacy names patch_task_created / bug_created also count) in this review window`,
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
 * `--task` / `--hotfix` terminal (terminal_single_task / terminal_hotfix).
 *
 * These modes run without a sprint, so the sprint evidence (wave gates, per-
 * step returns, story review, sprint_complete_passed) can never exist for
 * them — before this gate existed every land-now run ended in a refusal, a
 * stale `single_task` cursor and a `--force` on the next sprint start. Their
 * evidence is the task itself: since the tick that entered the mode's stage,
 * a task or step was set `done` (or a dispatch returned complete) and nothing
 * was left needs-attention/blocked.
 */
export function evaluateTaskModeTerminal({ dataDir, terminalStage }) {
  const entryStage = terminalStage === "terminal_hotfix" ? "hotfix" : "single_task";
  const events = readEvents(dataDir);
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (eventMatches(e, "pipeline_tick_started") && e.pipeline === "ship-execute" && e.stage === entryStage) { start = i; break; }
    if (eventMatches(e, "pipeline_tick_completed") && e.pipeline === "ship-execute" && e.next_stage === entryStage) { start = i; break; }
  }
  const window = start === -1 ? events : events.slice(start);
  let done = 0;
  let parked = 0;
  for (const e of window) {
    const to = String(e.to || "");
    if ((eventMatches(e, "task_status_set") || eventMatches(e, "step_status_set")) && to === "done") done++;
    if ((eventMatches(e, "task_status_set") || eventMatches(e, "step_status_set")) && /^(needs-attention|blocked)$/.test(to)) parked++;
    if (eventMatches(e, "task_dispatch_returned") && String(e.status || "") === "complete") done++;
  }
  const reasons = [];
  if (done === 0) {
    reasons.push(
      `Missing evidence for the ${entryStage} run — need a task/step set to done (shipyard-data task|step set-status <id> done, or accept-return) or a task_dispatch_returned status=complete since the tick that entered ${entryStage}`,
    );
  }
  if (parked > 0 && done === 0) {
    reasons.push(`The ${entryStage} run parked its task (needs-attention/blocked) — a parked task is never a success terminal; use cursor escalate execute reason=task_needs_attention`);
  }
  return { allowed: reasons.length === 0, reasons };
}

/** Names of agents this pipeline cycle spawned and has not stopped. Pure over `events`. */
/**
 * `needs_person` of a step ("before" | "after" | null), read from its file.
 * Kept here (not imported from person-steps.mjs, which imports this module).
 */
function waitsForPerson(dataDir, id) {
  for (const sub of ["steps", "tasks"]) {
    let names = [];
    try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
    const n = names.find((x) => x.endsWith(".md") && (x.startsWith(`${id}-`) || x === `${id}.md`));
    if (!n) continue;
    try {
      const v = String(parseFrontmatter(readFileSync(join(dataDir, "spec", sub, n), "utf8")).needs_person ?? "").replace(/["']/g, "").trim().toLowerCase();
      return v === "before" || v === "after" ? v : null;
    } catch { return null; }
  }
  return null;
}

export function liveAgents(events) {
  let start = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (eventMatches(events[i], "pipeline_terminal")) { start = i + 1; break; }
  }
  const state = new Map(); // name -> { live, step, since }
  for (const e of events.slice(start)) {
    if (eventMatches(e, "agent_spawned") && e.agent) {
      const w = Number(e.wave);
      // A hook-recorded spawn carries no step or wave; keep what a claim or an
      // explicit `agents spawned` already said about the same name.
      const prev = state.get(String(e.agent));
      state.set(String(e.agent), { live: true, step: e.step || prev?.step || null, since: e.ts ?? null, source: "spawned", wave: Number.isInteger(w) && w > 0 ? w : prev?.wave ?? null, via: e.via === "hook" ? "hook" : "cli", session: e.session || prev?.session || null });
    } else if (eventMatches(e, "worker_queue_claimed") && e.worker) {
      const m = String(e.stage ?? "").match(/^wave_(\d+)_/);
      state.set(String(e.worker), { ...(state.get(String(e.worker)) ?? {}), live: true, step: e.task ?? null, since: e.ts ?? null, source: "queue", wave: m ? Number(m[1]) : null, via: "cli" });
    } else if (eventMatches(e, "agent_stopped") && e.agent) {
      const cur = state.get(String(e.agent));
      state.set(String(e.agent), { ...(cur ?? {}), live: false });
    }
  }
  return [...state.entries()].filter(([, v]) => v.live).map(([name, v]) => ({ name, step: v.step, since: v.since, source: v.source, wave: v.wave ?? null, via: v.via ?? "cli", session: v.session ?? null }));
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
  const verdict = evaluateTerminalEvidence({ dataDir, classification });
  // No pipeline ends with agents still running (v4.5): finished builders and
  // reviewers used to linger until the owner asked what they were. Every agent
  // the cycle spawned (queue claims are ground truth) needs an agent_stopped.
  // An agent another session's command recorded by hook (a discussion that
  // crashed, say) is that session's to account for, not this pipeline's.
  const cursorSession = String(parseFrontmatter(proposedContent ?? "").session_id ?? "").trim();
  const live = liveAgents(readEvents(dataDir)).filter((a) => a.via !== "hook" || !a.session || !cursorSession || a.session === cursorSession);
  if (live.length) {
    verdict.allowed = false;
    verdict.reasons = [
      ...verdict.reasons,
      `${live.length} agent(s) are still live: ${live.map((a) => `${a.name}${a.step ? ` (${a.step})` : ""}`).join(", ")} — TaskStop each one, then record it: shipyard-data agents stopped <name> ... (or --all once every one is stopped)`,
    ];
  }
  return verdict;
}

function evaluateTerminalEvidence({ dataDir, classification }) {
  if (classification.pipeline === "ship-execute") {
    if (/^terminal_(single_task|hotfix)$/.test(classification.stage)) {
      return evaluateTaskModeTerminal({ dataDir, terminalStage: classification.stage });
    }
    return evaluateExecuteTerminal({ dataDir });
  }
  return evaluateReviewTerminal({
    dataDir,
    terminalStage: classification.stage,
  });
}
