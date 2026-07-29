/**
 * Tests for bin/terminal-gate.mjs — the "claim of success" cursor gate.
 *
 * Run via:
 *   node --test plugins/shipyard/tests/test_terminal_gate.mjs
 *
 * The gate's job is to refuse terminal-cursor writes that claim sprint
 * success (execute: terminal + status complete; review: terminal +
 * stage terminal_approved/changes/issues) without the supporting event-log
 * evidence. Escalation/paused cursors bypass the gate (different meaning).
 *
 * Each test sets up an isolated $SHIPYARD_DATA tree with a SPRINT.md, an
 * optional events log, optional verdicts, then evaluates the gate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateExecuteTerminal,
  evaluateReviewTerminal,
  evaluateTerminalGate,
  evaluateLoopLeakGuard,
  parseFrontmatter,
  parseWaves,
} from "../bin/terminal-gate.mjs";
import { FULL_SUITE_KEY, recordVerification } from "../bin/verify-ledger.mjs";

function withTempDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "terminal-gate-test-"));
  try {
    mkdirSync(join(dir, "sprints", "current"), { recursive: true });
    mkdirSync(join(dir, "verify"), { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSprint(dataDir, opts) {
  const features = opts.features ?? ["F001", "F002"];
  const waves = opts.waves ?? [
    { wave: 1, tasks: ["T001", "T002"] },
    { wave: 2, tasks: ["T003"] },
  ];
  const fmFeatures = `[${features.join(", ")}]`;
  const waveBlock = waves
    .map((w) => `### Wave ${w.wave}\nTasks: [${w.tasks.join(", ")}]\n`)
    .join("\n");
  const content = `---
id: sprint-001
status: in-progress
goal: "test goal"
capacity: 20
features: ${fmFeatures}
branch: main
created: 2026-05-19
started_at: 2026-05-19T00:00:00Z
---

# Sprint 001

## Waves

${waveBlock}

## Critical Path
T001 → T003
`;
  writeFileSync(join(dataDir, "sprints", "current", "SPRINT.md"), content);
}

function writeEvents(dataDir, events) {
  const lines = events.map((e) => JSON.stringify({ ts: new Date().toISOString(), ...e })).join("\n") + "\n";
  writeFileSync(join(dataDir, ".shipyard-events.jsonl"), lines);
}

function writeVerdict(dataDir, featureId, recommendation) {
  const content = `---
feature: ${featureId}
recommendation: ${recommendation}
---

Body.
`;
  writeFileSync(join(dataDir, "verify", `${featureId}-verdict.md`), content);
}

/**
 * Build a fresh, ledger-recorded full-suite proof for `evaluateReviewTerminal`'s
 * new P1 requirement. Sets up a real git repo (the ledger's freshness
 * predicate genuinely shells to git) as the data dir's project root, then
 * calls recordVerification the same way `shipyard-data verify record` would.
 */
function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function makeFreshFullSuiteProof(dataDir) {
  const repo = join(dataDir, "_test-repo");
  mkdirSync(repo, { recursive: true });
  git(["init", "-q"], repo);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "config", "commit.gpgsign", "false"], repo);
  writeFileSync(join(repo, "a.txt"), "content\n");
  git(["add", "-A"], repo);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], repo);
  writeFileSync(join(dataDir, ".project-root"), repo + "\n");

  // Deliberately OUTSIDE the repo — a capture file living inside the repo
  // would itself be untracked-and-dirty and defeat the clean-tree check.
  const capturePath = join(dataDir, "capture.log");
  writeFileSync(capturePath, "all green\n");
  const result = recordVerification(dataDir, {
    key: FULL_SUITE_KEY,
    command: "full test suite",
    exitCode: 0,
    capturePath,
  });
  assert.equal(result.ok, true, `test setup: expected recordVerification to succeed: ${result.message}`);
}

// --- Frontmatter parser -------------------------------------------------

test("parseFrontmatter extracts flat key/value pairs", () => {
  const fm = parseFrontmatter(`---
id: sprint-007
terminal: true
stage: terminal_handoff_to_review
status: complete
---

body`);
  assert.equal(fm.id, "sprint-007");
  assert.equal(fm.terminal, "true");
  assert.equal(fm.stage, "terminal_handoff_to_review");
  assert.equal(fm.status, "complete");
});

test("parseFrontmatter handles quoted values + inline comments", () => {
  const fm = parseFrontmatter(`---
goal: "stand up the slice"
created: 2026-05-19  # date the sprint was approved
---
`);
  assert.equal(fm.goal, "stand up the slice");
  assert.equal(fm.created, "2026-05-19");
});

test("parseFrontmatter returns empty when no frontmatter block", () => {
  assert.deepEqual(parseFrontmatter("# just a heading\n"), {});
  assert.deepEqual(parseFrontmatter(""), {});
  assert.deepEqual(parseFrontmatter(null), {});
});

// --- Wave parser --------------------------------------------------------

test("parseWaves extracts wave numbers and task IDs", () => {
  const waves = parseWaves(`# Sprint

## Waves

### Wave 1
Tasks: [T001, T002, T003]

### Wave 2
Tasks: [T004, T005]

### Wave 3
Tasks: [T006]

## Critical Path
T001 → T004
`);
  assert.deepEqual(waves, [
    { wave: 1, tasks: ["T001", "T002", "T003"] },
    { wave: 2, tasks: ["T004", "T005"] },
    { wave: 3, tasks: ["T006"] },
  ]);
});

test("parseWaves handles unbracketed task lists", () => {
  const waves = parseWaves(`### Wave 1
Tasks: T001, T002

### Wave 2
Tasks: T003
`);
  assert.deepEqual(waves, [
    { wave: 1, tasks: ["T001", "T002"] },
    { wave: 2, tasks: ["T003"] },
  ]);
});

test("parseWaves handles bullet-point task lists", () => {
  const waves = parseWaves(`## Waves

### Wave 1 (Foundation — parallel)
- T015
- T020

### Wave 2 (Core Behavior — parallel)
- T016
- T021

### Wave 3 (Integration — parallel)
- T017
- T018

## Critical Path
T015 → T016
`);
  assert.deepEqual(waves, [
    { wave: 1, tasks: ["T015", "T020"] },
    { wave: 2, tasks: ["T016", "T021"] },
    { wave: 3, tasks: ["T017", "T018"] },
  ]);
});

// --- Execute terminal gate ----------------------------------------------

test("execute terminal: allows when all evidence present", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, {});
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_1_gate" },
      { type: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_2_gate" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T001", commit_sha: "abc1" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T002", commit_sha: "abc2" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T003", commit_sha: "abc3" },
      { type: "sprint_complete_passed", sprint_id: "sprint-001" },
    ]);
    const v = evaluateExecuteTerminal({ dataDir });
    assert.equal(v.allowed, true, `expected allow; got reasons: ${v.reasons.join("; ")}`);
    assert.deepEqual(v.reasons, []);
  });
});

test("execute terminal: denies when SPRINT.md missing", () => {
  withTempDataDir((dataDir) => {
    const v = evaluateExecuteTerminal({ dataDir });
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.some((r) => r.includes("SPRINT.md not found")));
  });
});

test("execute terminal: denies when no events log", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, {});
    const v = evaluateExecuteTerminal({ dataDir });
    assert.equal(v.allowed, false);
    // Every wave gate, every task, and sprint_complete_passed are all missing
    assert.ok(v.reasons.some((r) => r.includes("wave_1_gate")));
    assert.ok(v.reasons.some((r) => r.includes("wave_2_gate")));
    assert.ok(v.reasons.some((r) => r.includes("T001")));
    assert.ok(v.reasons.some((r) => r.includes("T003")));
    assert.ok(v.reasons.some((r) => r.includes("sprint_complete_passed")));
  });
});

test("execute terminal: denies when one wave gate event missing", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, {});
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_1_gate" },
      // wave_2_gate missing
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T001" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T002" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T003" },
      { type: "sprint_complete_passed" },
    ]);
    const v = evaluateExecuteTerminal({ dataDir });
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.some((r) => r.includes("wave_2_gate")));
    assert.equal(v.reasons.filter((r) => r.includes("wave_1_gate")).length, 0);
  });
});

test("execute terminal: denies when a task lacks task_dispatch_returned", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, {});
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_1_gate" },
      { type: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_2_gate" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T001" },
      // T002 missing
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T003" },
      { type: "sprint_complete_passed" },
    ]);
    const v = evaluateExecuteTerminal({ dataDir });
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.some((r) => r.includes("T002")));
  });
});

test("execute terminal: status=blocked counts as PARKED evidence (v3.1.0), not completion", () => {
  // Pre-v3.1 the gate demanded status=complete for every task, which made
  // a sprint with any parked (needs-attention) task structurally unable to
  // terminate — the park flow is a designed outcome handed to /ship-review.
  // Parking evidence (task_dispatch_returned status=blocked, or a
  // task_blocked event) now satisfies the per-task requirement.
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, {});
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_1_gate" },
      { type: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_2_gate" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T001" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "blocked", task_id: "T002" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T003" },
      { type: "sprint_complete_passed" },
    ]);
    const v = evaluateExecuteTerminal({ dataDir });
    assert.equal(v.allowed, true, "a parked task with a blocked event must not brick the terminal");
  });
});

test("execute terminal: a task with NO evidence at all still blocks the terminal", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, {});
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_1_gate" },
      { type: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_2_gate" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T001" },
      // T002: nothing. T003: complete.
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T003" },
      { type: "sprint_complete_passed" },
    ]);
    const v = evaluateExecuteTerminal({ dataDir });
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.some((r) => r.includes("T002")));
  });
});

test("execute terminal: task_blocked event alone is valid parking evidence", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, {});
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_1_gate" },
      { type: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_2_gate" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T001" },
      { type: "task_blocked", task: "T002", reason: "persistent_failure" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T003" },
      { type: "sprint_complete_passed" },
    ]);
    const v = evaluateExecuteTerminal({ dataDir });
    assert.equal(v.allowed, true);
  });
});

// --- Review terminal gate -----------------------------------------------

test("review terminal_approved: allows when every feature verdict approves AND a fresh full-suite proof exists", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, { features: ["F001", "F002"] });
    writeVerdict(dataDir, "F001", "approve");
    writeVerdict(dataDir, "F002", "approve");
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-review", stage: "demo_user" },
    ]);
    makeFreshFullSuiteProof(dataDir);
    const v = evaluateReviewTerminal({ dataDir, terminalStage: "terminal_approved" });
    assert.equal(v.allowed, true, `expected allow; got: ${v.reasons.join("; ")}`);
  });
});

// --- P1: release approval requires a fresh full-suite verification proof (fixes 5.1) ---

test("review terminal_approved: denies release without a fresh full-suite verification proof", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, { features: ["F001"] });
    writeVerdict(dataDir, "F001", "approve");
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-review", stage: "demo_user" },
    ]);
    // No verify-ledger entry recorded at all.
    const v = evaluateReviewTerminal({ dataDir, terminalStage: "terminal_approved" });
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.some((r) => r.includes(FULL_SUITE_KEY)), `expected a full-suite reason; got: ${v.reasons.join("; ")}`);
  });
});

test("review terminal_approved: denies release when the recorded full-suite proof is stale (tree changed)", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, { features: ["F001"] });
    writeVerdict(dataDir, "F001", "approve");
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-review", stage: "demo_user" },
    ]);
    makeFreshFullSuiteProof(dataDir);

    // A fixer commits after the proof was recorded — the tree moves on.
    const repo = join(dataDir, "_test-repo");
    writeFileSync(join(repo, "b.txt"), "fix\n");
    git(["add", "-A"], repo);
    git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fix"], repo);

    const v = evaluateReviewTerminal({ dataDir, terminalStage: "terminal_approved" });
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.some((r) => r.includes(FULL_SUITE_KEY)));
  });
});

test("review terminal_approved: allows release once a fresh full-suite verification proof is recorded", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, { features: ["F001"] });
    writeVerdict(dataDir, "F001", "approve");
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-review", stage: "demo_user" },
    ]);
    makeFreshFullSuiteProof(dataDir);
    const v = evaluateReviewTerminal({ dataDir, terminalStage: "terminal_approved" });
    assert.equal(v.allowed, true, `expected allow; got: ${v.reasons.join("; ")}`);
  });
});

test("review terminal_approved: denies when a feature verdict is missing", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, { features: ["F001", "F002"] });
    writeVerdict(dataDir, "F001", "approve");
    // F002 verdict missing
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-review", stage: "demo_user" },
    ]);
    const v = evaluateReviewTerminal({ dataDir, terminalStage: "terminal_approved" });
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.some((r) => r.includes("F002")));
  });
});

test("review terminal_approved: denies when a verdict recommends changes", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, { features: ["F001"] });
    writeVerdict(dataDir, "F001", "changes");
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-review", stage: "demo_user" },
    ]);
    const v = evaluateReviewTerminal({ dataDir, terminalStage: "terminal_approved" });
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.some((r) => r.includes("F001") && r.includes("changes")));
  });
});

test("review terminal_changes: allows when a patch task event exists", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, { features: ["F001"] });
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-review", stage: "demo_user" },
      { type: "patch_task_created", task_id: "T-P001" },
    ]);
    const v = evaluateReviewTerminal({ dataDir, terminalStage: "terminal_changes" });
    assert.equal(v.allowed, true);
  });
});

test("review terminal_changes: denies when no patch or bug events recorded", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, { features: ["F001"] });
    writeEvents(dataDir, [
      { type: "pipeline_tick_completed", pipeline: "ship-review", stage: "demo_user" },
    ]);
    const v = evaluateReviewTerminal({ dataDir, terminalStage: "terminal_changes" });
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.some((r) => r.includes("patch_task_created or bug_created")));
  });
});

test("review terminal: denies when demo_user tick missing for all stages", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, { features: ["F001"] });
    writeVerdict(dataDir, "F001", "approve");
    // No events at all
    const v = evaluateReviewTerminal({ dataDir, terminalStage: "terminal_approved" });
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.some((r) => r.includes("demo_user")));
  });
});

// --- Top-level gate routing --------------------------------------------

test("evaluateTerminalGate: non-terminal write skips evaluation", () => {
  withTempDataDir((dataDir) => {
    const v = evaluateTerminalGate({
      dataDir,
      proposedContent: `---
pipeline: ship-execute
stage: wave_1_dispatch
terminal: false
status: in_progress
---

body`,
    });
    assert.equal(v.allowed, true);
    assert.deepEqual(v.reasons, []);
  });
});

test("evaluateTerminalGate: escalation cursor bypasses execute gate", () => {
  withTempDataDir((dataDir) => {
    // No SPRINT.md, no events — bare data dir. If this were a success
    // claim it would deny; escalation should sail through.
    const v = evaluateTerminalGate({
      dataDir,
      proposedContent: `---
pipeline: ship-execute
stage: wave_2_redispatch_iter_1
terminal: true
status: escalated
---

body`,
    });
    assert.equal(v.allowed, true);
  });
});

test("evaluateTerminalGate: success terminal evaluates execute gate", () => {
  withTempDataDir((dataDir) => {
    // No SPRINT.md → gate denies for missing sprint context
    const v = evaluateTerminalGate({
      dataDir,
      proposedContent: `---
pipeline: ship-execute
stage: terminal_handoff_to_review
terminal: true
status: complete
---

Body.
`,
    });
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.some((r) => r.includes("SPRINT.md")));
  });
});

test("evaluateTerminalGate: terminal_changes routes to review gate", () => {
  withTempDataDir((dataDir) => {
    const v = evaluateTerminalGate({
      dataDir,
      proposedContent: `---
pipeline: ship-review
stage: terminal_changes
terminal: true
status: escalated
---

body`,
    });
    assert.equal(v.allowed, false);
    assert.ok(v.reasons.some((r) => r.includes("demo_user")));
  });
});

test("execute terminal: allows when events use 'event' key instead of 'type'", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir, {});
    // Simulate events emitted via raw bash (using "event" key, no "type")
    const events = [
      { event: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_1_gate" },
      { event: "pipeline_tick_completed", pipeline: "ship-execute", stage: "wave_2_gate" },
      { event: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T001" },
      { event: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T002" },
      { event: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task_id: "T003" },
      { event: "sprint_complete_passed" },
    ];
    const lines = events.map((e) => JSON.stringify({ ts: new Date().toISOString(), ...e })).join("\n") + "\n";
    writeFileSync(join(dataDir, ".shipyard-events.jsonl"), lines);
    const v = evaluateExecuteTerminal({ dataDir });
    assert.equal(v.allowed, true, `expected allow with 'event' key; got reasons: ${v.reasons.join("; ")}`);
  });
});

test("evaluateTerminalGate: unknown pipeline allows", () => {
  withTempDataDir((dataDir) => {
    const v = evaluateTerminalGate({
      dataDir,
      proposedContent: `---
pipeline: ship-something-else
terminal: true
status: complete
---

body`,
    });
    assert.equal(v.allowed, true);
  });
});

// --- Loop-leak guard (v2.8.2) ------------------------------------------
//
// A leaked /loop wakeup fires /ship-execute (or /ship-review) after the
// sprint already completed/archived and tries to write a NON-terminal
// cursor (phantom start). The guard denies that write structurally.

function writeSprintWithStatus(dataDir, status) {
  const content = `---
id: sprint-001
status: ${status}
features: [F001]
started_at: 2026-05-19T00:00:00Z
---

## Waves

### Wave 1
Tasks: [T001]
`;
  writeFileSync(join(dataDir, "sprints", "current", "SPRINT.md"), content);
}

const EXECUTE_ACTIVE_CURSOR = `---
pipeline: ship-execute
stage: wave_1_dispatch
terminal: false
status: in_progress
---

body`;

const REVIEW_ACTIVE_CURSOR = `---
pipeline: ship-review
stage: code_review_iter_1
terminal: false
status: in_progress
---

body`;

test("loop-leak guard: execute non-terminal write with no SPRINT.md (archived) is denied", () => {
  withTempDataDir((dataDir) => {
    const v = evaluateLoopLeakGuard({
      dataDir,
      proposedContent: EXECUTE_ACTIVE_CURSOR,
      cursorBasename: "EXECUTE-CURSOR.md",
    });
    assert.equal(v.allowed, false);
    assert.equal(v.kind, "loop_leak");
    assert.ok(v.reasons.some((r) => r.includes("archived")));
  });
});

test("loop-leak guard: execute non-terminal write with SPRINT.md status completed is denied", () => {
  withTempDataDir((dataDir) => {
    writeSprintWithStatus(dataDir, "completed");
    const v = evaluateLoopLeakGuard({
      dataDir,
      proposedContent: EXECUTE_ACTIVE_CURSOR,
      cursorBasename: "EXECUTE-CURSOR.md",
    });
    assert.equal(v.allowed, false);
    assert.equal(v.kind, "loop_leak");
    assert.ok(v.reasons.some((r) => r.includes("status: completed")));
  });
});

test("loop-leak guard: execute non-terminal write with an active sprint is allowed", () => {
  withTempDataDir((dataDir) => {
    writeSprintWithStatus(dataDir, "in-progress");
    const v = evaluateLoopLeakGuard({
      dataDir,
      proposedContent: EXECUTE_ACTIVE_CURSOR,
      cursorBasename: "EXECUTE-CURSOR.md",
    });
    assert.equal(v.allowed, true);
    assert.deepEqual(v.reasons, []);
  });
});

test("loop-leak guard: terminal cursor write bypasses the guard even with no SPRINT.md", () => {
  withTempDataDir((dataDir) => {
    const v = evaluateLoopLeakGuard({
      dataDir,
      proposedContent: `---
pipeline: ship-execute
stage: terminal_handoff_to_review
terminal: true
status: complete
---

body`,
      cursorBasename: "EXECUTE-CURSOR.md",
    });
    assert.equal(v.allowed, true);
  });
});

test("loop-leak guard: review non-terminal write with no SPRINT.md (archived) is denied", () => {
  withTempDataDir((dataDir) => {
    const v = evaluateLoopLeakGuard({
      dataDir,
      proposedContent: REVIEW_ACTIVE_CURSOR,
      cursorBasename: "REVIEW-CURSOR.md",
    });
    assert.equal(v.allowed, false);
    assert.equal(v.kind, "loop_leak");
  });
});

test("loop-leak guard: review non-terminal write on a status: completed sprint is allowed", () => {
  // Review legitimately runs ON a completed-but-not-yet-archived sprint —
  // only the archived/absent case is a review leak.
  withTempDataDir((dataDir) => {
    writeSprintWithStatus(dataDir, "completed");
    const v = evaluateLoopLeakGuard({
      dataDir,
      proposedContent: REVIEW_ACTIVE_CURSOR,
      cursorBasename: "REVIEW-CURSOR.md",
    });
    assert.equal(v.allowed, true);
    assert.deepEqual(v.reasons, []);
  });
});

test("loop-leak guard: pipeline inferred from basename when frontmatter omits it", () => {
  withTempDataDir((dataDir) => {
    const v = evaluateLoopLeakGuard({
      dataDir,
      proposedContent: `---
stage: wave_1_dispatch
terminal: false
status: in_progress
---

body`,
      cursorBasename: "EXECUTE-CURSOR.md",
    });
    assert.equal(v.allowed, false);
    assert.equal(v.kind, "loop_leak");
  });
});

test("loop-leak guard: hotfix-mode non-terminal write with no SPRINT.md is allowed (sprint-bypass)", () => {
  withTempDataDir((dataDir) => {
    const v = evaluateLoopLeakGuard({
      dataDir,
      proposedContent: `---
pipeline: ship-execute
stage: hotfix
terminal: false
status: in_progress
---

body`,
      cursorBasename: "EXECUTE-CURSOR.md",
    });
    assert.equal(v.allowed, true);
    assert.deepEqual(v.reasons, []);
  });
});

test("loop-leak guard: unknown pipeline fails open (allowed)", () => {
  withTempDataDir((dataDir) => {
    const v = evaluateLoopLeakGuard({
      dataDir,
      proposedContent: `---
pipeline: ship-something-else
terminal: false
---

body`,
      cursorBasename: "OTHER.md",
    });
    assert.equal(v.allowed, true);
  });
});
