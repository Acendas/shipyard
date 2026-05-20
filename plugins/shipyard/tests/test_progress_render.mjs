/**
 * Tests for bin/progress-render.mjs — deterministic PROGRESS.md derivation
 * from the structured event log.
 *
 * Run via:
 *   node --test plugins/shipyard/tests/test_progress_render.mjs
 *
 * PROGRESS.md is a rendered artifact after v2.6.0 — skills emit events
 * and the PostToolUse hook regenerates the file. These tests pin the
 * render contract: same events → same bytes; current_wave derived from
 * wave_check_passed events; blockers from task_dispatch_returned with
 * status=blocked; patch tasks from patch_task_created events; session
 * log captures the high-signal events chronologically.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderProgress, writeProgress } from "../bin/progress-render.mjs";

function withTempDataDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "progress-render-test-"));
  try {
    mkdirSync(join(dir, "sprints", "current"), { recursive: true });
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSprint(dataDir) {
  writeFileSync(
    join(dataDir, "sprints", "current", "SPRINT.md"),
    `---\nid: sprint-001\nstatus: in-progress\nfeatures: [F001]\n---\n\n## Waves\n\n### Wave 1\nTasks: [T001]\n`,
  );
}

function writeEvents(dataDir, events) {
  const lines = events
    .map((e, i) => JSON.stringify({ ts: `2026-05-19T00:${String(i).padStart(2, "0")}:00+00:00`, ...e }))
    .join("\n") + "\n";
  writeFileSync(join(dataDir, ".shipyard-events.jsonl"), lines);
}

test("renderProgress returns null when SPRINT.md is missing", () => {
  withTempDataDir((dataDir) => {
    assert.equal(renderProgress(dataDir), null);
  });
});

test("renderProgress current_wave is 1 when no wave events yet", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir);
    const md = renderProgress(dataDir);
    assert.match(md, /^current_wave: 1$/m);
  });
});

test("renderProgress current_wave advances past the last passed wave", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir);
    writeEvents(dataDir, [
      { type: "wave_check_passed", wave: 1 },
      { type: "wave_check_passed", wave: 2 },
    ]);
    const md = renderProgress(dataDir);
    assert.match(md, /^current_wave: 3$/m);
  });
});

test("renderProgress current_wave becomes 'complete' on terminal success", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir);
    writeEvents(dataDir, [
      { type: "wave_check_passed", wave: 1 },
      { type: "pipeline_terminal", pipeline: "ship-execute", outcome: "success", reason: "sprint_complete" },
    ]);
    const md = renderProgress(dataDir);
    assert.match(md, /^current_wave: complete$/m);
  });
});

test("renderProgress lists blocked tasks in Blockers table", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir);
    writeEvents(dataDir, [
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "blocked", task: "T002", escalation_code: "verify_failed" },
    ]);
    const md = renderProgress(dataDir);
    assert.match(md, /## Blockers/);
    assert.match(md, /\| T002 \| verify_failed \|/);
  });
});

test("renderProgress does not list tasks whose later return is complete", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir);
    writeEvents(dataDir, [
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "blocked", task: "T001", escalation_code: "transient" },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task: "T001", commit_sha: "abc1" },
    ]);
    const md = renderProgress(dataDir);
    // T001 should NOT appear as a blocker (latest return was complete)
    const blockerSection = md.split("## Blockers")[1].split("## ")[0];
    assert.ok(!blockerSection.includes("T001"));
  });
});

test("renderProgress lists patch tasks in Patch Tasks table", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir);
    writeEvents(dataDir, [
      { type: "patch_task_created", task_id: "T-P001", feature: "F002", source: "review-gap" },
      { type: "patch_task_created", task_id: "T-P002", feature: "F002", source: "execute-deviation" },
    ]);
    const md = renderProgress(dataDir);
    assert.match(md, /\| T-P001 \| F002 \| review-gap \|/);
    assert.match(md, /\| T-P002 \| F002 \| execute-deviation \|/);
  });
});

test("renderProgress session log captures wave and task events chronologically", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir);
    writeEvents(dataDir, [
      { type: "wave_check_passed", wave: 1, iterations_run: 1 },
      { type: "task_dispatch_returned", pipeline: "ship-execute", status: "complete", task: "T001", commit_sha: "abc1234567" },
      { type: "sprint_complete_passed", sprint_id: "sprint-001" },
    ]);
    const md = renderProgress(dataDir);
    const log = md.split("## Session Log")[1];
    assert.match(log, /wave 1 gate passed/);
    assert.match(log, /T001 returned complete \(abc1234567\)/);
    assert.match(log, /sprint-complete predicate: all invariants green/);
  });
});

test("renderProgress is deterministic — same input produces identical bytes", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir);
    writeEvents(dataDir, [
      { type: "wave_check_passed", wave: 1 },
      { type: "patch_task_created", task_id: "T-P001", feature: "F001", source: "review-gap" },
    ]);
    const md1 = renderProgress(dataDir);
    const md2 = renderProgress(dataDir);
    assert.equal(md1, md2);
  });
});

test("writeProgress writes to sprints/current/PROGRESS.md atomically", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir);
    writeEvents(dataDir, [
      { type: "wave_check_passed", wave: 1 },
    ]);
    const wrote = writeProgress(dataDir);
    assert.equal(wrote, true);
    const path = join(dataDir, "sprints", "current", "PROGRESS.md");
    assert.ok(existsSync(path));
    const content = readFileSync(path, "utf8");
    assert.match(content, /current_wave: 2/);
  });
});

test("writeProgress returns false when SPRINT.md is missing (no-op)", () => {
  withTempDataDir((dataDir) => {
    const wrote = writeProgress(dataDir);
    assert.equal(wrote, false);
    assert.ok(!existsSync(join(dataDir, "sprints", "current", "PROGRESS.md")));
  });
});

test("renderProgress performance budget (<50ms on bounded event log)", () => {
  withTempDataDir((dataDir) => {
    writeSprint(dataDir);
    // Synthesize 4000 events — about the rotation cap
    const events = [];
    for (let i = 0; i < 4000; i++) {
      events.push({
        type: i % 5 === 0 ? "task_dispatch_returned" : "pipeline_tick_completed",
        pipeline: "ship-execute",
        stage: `wave_${(i % 10) + 1}_dispatch`,
        next_stage: `wave_${(i % 10) + 1}_boundary`,
        task: `T${String(i).padStart(3, "0")}`,
        status: "complete",
        commit_sha: `c${i.toString(16)}`,
      });
    }
    writeEvents(dataDir, events);
    const t0 = process.hrtime.bigint();
    renderProgress(dataDir);
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    assert.ok(ms < 50, `render took ${ms.toFixed(1)}ms; budget is <50ms`);
  });
});
