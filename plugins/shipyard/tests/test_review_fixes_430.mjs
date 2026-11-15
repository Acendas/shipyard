/** Regression pins for the 4.3.0 code-review findings (dispatcher, review-terminal window, wave ids, boundary verdict scope). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseWaves, evaluateReviewTerminal } from "../bin/terminal-gate.mjs";
import { latestIntegrationVerdict } from "../bin/cursor-cli.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

test("dispatcher: `step accept-return` reaches the gate (not the spec-state subcommand list)", () => {
  const r = spawnSync("node", [CLI, "step", "accept-return"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.ok(!/unknown subcommand/.test(r.stderr), r.stderr);
  assert.match(r.stderr, /accept-return/);
  const r2 = spawnSync("node", [CLI, "step", "accept-operational"], { encoding: "utf8" });
  assert.ok(!/unknown subcommand/.test(r2.stderr), r2.stderr);
});

test("parseWaves: P ids are digits only — PR12/Part2/Page1 in a wave note are not step ids; legacy T forms still parse", () => {
  const md = "---\nid: s\n---\n## Waves\n\n### Wave 1\n- P001\n- PR12 must merge before wave 2\n- Part2 of the migration\n- T-P001\n- T-HOT1\n- T002\n";
  assert.deepEqual(parseWaves(md)[0].tasks, ["P001", "T-P001", "T-HOT1", "T002"]);
  const inline = "---\nid: s\n---\n### Wave 1\nTasks: [P003, Page1, T004]\n";
  assert.deepEqual(parseWaves(inline)[0].tasks, ["P003", "T004"]);
});

test("review terminal_changes: only a patch step or bug story created AFTER this review's preflight counts; tracker imports never do", () => {
  const base = mkdtempSync(join(tmpdir(), "rt-"));
  const d = join(base, "projects", "abc123abc123");
  mkdirSync(join(d, "sprints", "current"), { recursive: true });
  const ev = (o) => JSON.stringify({ ts: "2026-11-13T00:00:00Z", ...o });
  const write = (lines) => writeFileSync(join(d, ".shipyard-events.jsonl"), lines.map(ev).join("\n") + "\n");
  const tick = (stage) => ({ type: "pipeline_tick_completed", pipeline: "ship-review", stage, sprint: "sprint-001" });
  try {
    // a bug story created BEFORE the review, and an import after it: no evidence
    write([{ type: "story_created", story: "S001", type_field: "bug" }, tick("preflight"), { type: "story_imported", story: "S002", source: "jira" }, { type: "story_created", story: "S003", source: "tracker" }, tick("demo_user")]);
    let r = evaluateReviewTerminal({ dataDir: d, terminalStage: "terminal_changes" });
    assert.ok(r.reasons.some((x) => /requires at least one patch_step_created or story_created/.test(x)), r.reasons.join(" | "));
    // a bug story created during the review: evidence present
    write([tick("preflight"), { type: "story_created", story: "S004", type_field: "bug" }, tick("demo_user")]);
    r = evaluateReviewTerminal({ dataDir: d, terminalStage: "terminal_changes" });
    assert.ok(!r.reasons.some((x) => /requires at least one patch_step_created/.test(x)), r.reasons.join(" | "));
    // legacy name still counts
    write([tick("preflight"), { type: "patch_task_created", task: "T-P001" }, tick("demo_user")]);
    r = evaluateReviewTerminal({ dataDir: d, terminalStage: "terminal_issues" });
    assert.ok(!r.reasons.some((x) => /requires at least one patch_step_created/.test(x)));
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("latestIntegrationVerdict: no tick into the boundary → null (never the whole tail); other sprints' verdicts are ignored", () => {
  const failed = { type: "wave_integration_failed", sprint: "sprint-002" };
  assert.equal(latestIntegrationVerdict([failed], "wave_1_boundary", "sprint-003"), null, "no window, no verdict");
  const tick = { type: "pipeline_tick_completed", next_stage: "wave_1_boundary", sprint: "sprint-003" };
  assert.equal(latestIntegrationVerdict([tick, failed], "wave_1_boundary", "sprint-003"), null, "a stale failure from sprint-002 does not lock sprint-003");
  assert.equal(latestIntegrationVerdict([tick, { type: "wave_integration_failed", sprint: "sprint-003" }], "wave_1_boundary", "sprint-003"), "wave_integration_failed");
  assert.equal(latestIntegrationVerdict([tick, { type: "wave_integration_failed" }, { type: "wave_integration_verified" }], "wave_1_boundary", "sprint-003"), "wave_integration_verified");
});
