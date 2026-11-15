/**
 * Event-report reader (F010 AC-9, AC-13, AC-21).
 * Run: node --test tests/test_report_cli.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readEvents, activeTime, stageClass, STAGE_CLASS_MAP, DEFAULT_GAP_MS } from "../bin/event-report.mjs";

const MIN = 60000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const ev = (min, type = "x", extra = {}) => JSON.stringify({ ts: new Date(T0 + min * MIN).toISOString(), type, ...extra });

test("archive_order", () => { // AC-13
  const d = mkdtempSync(join(tmpdir(), "evrep-"));
  try {
    mkdirSync(join(d, "events-archive"));
    writeFileSync(join(d, "events-archive", "events-2026-01-02.jsonl"), ev(2, "b") + "\n");
    writeFileSync(join(d, "events-archive", "events-2026-01-01.jsonl"), ev(1, "a") + "\n");
    writeFileSync(join(d, "events-archive", ".archived-head.json"), JSON.stringify({ count: 1, last: "x" }));
    writeFileSync(join(d, ".shipyard-events.jsonl"), ev(3, "c") + "\n");
    const { events, corrupt } = readEvents(d);
    assert.deepEqual(events.map((e) => e.type), ["a", "b", "c"]);
    assert.equal(corrupt, 0);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("corrupt_line_count", () => { // AC-13
  const d = mkdtempSync(join(tmpdir(), "evrep-"));
  try {
    mkdirSync(join(d, "events-archive"));
    writeFileSync(join(d, "events-archive", "events-2026-01-01.jsonl"), ev(1, "a") + "\n{not json\n");
    writeFileSync(join(d, ".shipyard-events.jsonl"), "\n" + ev(2, "b") + "\n[1,2]\n{\"type\":\"nots\"}\n");
    const { events, corrupt } = readEvents(d);
    assert.equal(events.length, 2);
    assert.equal(corrupt, 3);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("missing_log_is_empty", () => {
  const d = mkdtempSync(join(tmpdir(), "evrep-"));
  try { assert.deepEqual(readEvents(d), { events: [], corrupt: 0 }); }
  finally { rmSync(d, { recursive: true, force: true }); }
});

test("active_time_union_open_claims", () => { // AC-21
  assert.equal(DEFAULT_GAP_MS, 30 * MIN);
  const events = [
    JSON.parse(ev(0)),
    JSON.parse(ev(10)),                                   // gap 10: active
    JSON.parse(ev(20, "worker_queue_claimed", { task: "T1", worker: "w" })),
    JSON.parse(ev(100, "worker_queue_completed", { task: "T1", worker: "w" })), // 80 min silent but inside claim
    JSON.parse(ev(200)),                                  // 100 min gap: silent
    JSON.parse(ev(205)),                                  // 5 active
  ];
  const r = activeTime(events);
  assert.equal(r.activeMs, (10 + 10 + 80 + 5) * MIN);
  assert.equal(r.silentMs, 100 * MIN);
  assert.equal(r.spanMs, 205 * MIN);
  // custom gap
  assert.equal(activeTime(events.slice(0, 2), { gapMs: 5 * MIN }).activeMs, 0);
  // empty / single
  assert.deepEqual(activeTime([]), { activeMs: 0, silentMs: 0, spanMs: 0 });
});

test("stage_class_map_wave_recovery", () => { // AC-9
  assert.equal(stageClass("ship-execute", "wave_2_recovery"), "dispatch");
  assert.equal(STAGE_CLASS_MAP.wave_recovery, "dispatch");
  assert.equal(stageClass("ship-execute", "wave_1_dispatch"), "dispatch");
  assert.equal(stageClass("ship-execute", "wave_1_boundary"), "boundary");
  assert.equal(stageClass("ship-execute", "bogus"), "other");
});

// ---- report time (T085) ----
import { spawnSync } from "node:child_process";
import { computeTimeReport, renderTimeReport } from "../bin/report-time.mjs";

const P = (o) => JSON.parse(ev(o.m, o.type, o.x));
const tick = (m, stage, next, x = {}) => P({ m, type: "pipeline_tick_completed", x: { pipeline: "ship-execute", stage, next_stage: next, ...x } });

test("report_time_per_task_wave_review", () => { // AC-6 AC-7
  const events = [
    P({ m: 0, type: "worker_queue_claimed", x: { task: "T1", worker: "w", attempt: 1, pipeline: "ship-execute", stage: "wave_1_dispatch" } }),
    P({ m: 10, type: "worker_queue_failed", x: { task: "T1", worker: "w", claim_attempt: 1 } }),
    P({ m: 12, type: "worker_queue_claimed", x: { task: "T1", worker: "w", attempt: 2, pipeline: "ship-execute", stage: "wave_1_dispatch" } }),
    P({ m: 30, type: "worker_queue_completed", x: { task: "T1", worker: "w", claim_attempt: 2 } }),
    tick(0, "wave_1_dispatch", "wave_1_waiting"),
    tick(40, "wave_1_boundary", "wave_2_dispatch"),
    tick(90, "wave_2_boundary", "sprint_full_build"),
    P({ m: 100, type: "pipeline_tick_started", x: { pipeline: "ship-review", stage: "review_scan" } }),
    P({ m: 125, type: "pipeline_tick_completed", x: { pipeline: "ship-review", stage: "review_scan", next_stage: "review_plan" } }),
  ];
  const r = computeTimeReport(events, 0);
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].durationMs, 18 * MIN);
  assert.equal(r.tasks[0].reworkMs, 28 * MIN);
  assert.equal(r.tasks[0].attempts, 2);
  assert.equal(r.waves.find((w) => w.wave === 2).durationMs, 50 * MIN);
  assert.equal(r.review.durationMs, 25 * MIN);
  const out = renderTimeReport(r);
  assert.match(out, /T1 .*duration=18\.0m .*rework=28\.0m/);
  assert.match(out, /Review wall-clock[\s\S]*25\.0m/);
});

test("report_time_trigger_unknown", () => { // AC-19 AC-20
  const events = [
    tick(0, "wave_1_waiting", "wave_1_redispatch_iter_1", { trigger: "verify_findings" }),
    tick(30, "wave_1_redispatch_iter_1", "wave_1_boundary"),
    tick(40, "wave_1_boundary", "wave_2_dispatch"),
    tick(50, "wave_2_waiting", "wave_2_redispatch_iter_1"),
    tick(65, "wave_2_redispatch_iter_1", "wave_2_boundary"),
  ];
  const r = computeTimeReport(events, 0);
  const by = Object.fromEntries(r.redispatch.byTrigger.map((t) => [t.trigger, t.ms]));
  assert.equal(by.verify_findings, 30 * MIN);
  assert.equal(by["trigger unknown"], 15 * MIN);
  assert.equal(r.redispatch.fixPassWaves, 2);
  assert.match(renderTimeReport(r), /trigger unknown: 15\.0m/);
});

const DAY = 7 * 24 * 60;

test("report_time_multi_sprint_scoped", () => { // AC-7
  const sp = (id, evs) => evs.map((e) => ({ ...e, sprint: id }));
  const sprint = (id, off) => sp(id, [
    tick(off + 0, "wave_1_dispatch", "wave_1_waiting"),
    tick(off + 40, "wave_1_boundary", "wave_2_dispatch"),
    tick(off + 90, "wave_2_boundary", "sprint_full_build"),
    P({ m: off + 100, type: "pipeline_tick_started", x: { pipeline: "ship-review", stage: "review_scan" } }),
    P({ m: off + 125, type: "pipeline_tick_completed", x: { pipeline: "ship-review", stage: "review_scan", next_stage: "review_plan" } }),
    P({ m: off, type: "worker_queue_claimed", x: { task: "T1", attempt: 1, pipeline: "ship-execute", stage: "wave_1_dispatch" } }),
    P({ m: off + 10, type: "worker_queue_completed", x: { task: "T1", claim_attempt: 1 } }),
  ]);
  const events = [...sprint("sprint-001", 0), ...sprint("sprint-002", DAY)];
  const r = computeTimeReport(events, 0);
  const w2 = r.waves.filter((w) => w.wave === 2);
  assert.deepEqual(w2.map((w) => [w.sprint, w.durationMs]), [["sprint-001", 50 * MIN], ["sprint-002", 50 * MIN]]);
  assert.deepEqual(r.reviews.map((v) => [v.sprint, v.durationMs]), [["sprint-001", 25 * MIN], ["sprint-002", 25 * MIN]]);
  assert.equal(r.tasks.length, 2);
  assert.ok(r.tasks.every((t) => t.durationMs === 10 * MIN));
  const only = computeTimeReport(events, 0, { sprint: "sprint-002" });
  assert.equal(only.tasks.length, 1);
  assert.equal(only.waves.every((w) => w.sprint === "sprint-002"), true);
  // events with no sprint are an explicit bucket, not merged into a sprint
  const un = computeTimeReport([tick(0, "wave_1_boundary", "wave_2_dispatch"), tick(10, "wave_2_boundary", "sprint_full_build")], 0);
  assert.equal(un.waves[0].sprint, "unknown");
  assert.match(renderTimeReport(r), /wave 2 \[sprint-002\]: 50\.0m/);
});

test("report_time_fix_pass_share_bounded", () => { // AC-19
  // wave 2 is redispatched but has no entering tick: still a wave seen
  const events = [
    tick(0, "wave_1_dispatch", "wave_1_waiting"),
    tick(30, "wave_1_boundary", "sprint_full_build"),
    tick(40, "wave_2_waiting", "wave_2_redispatch_iter_1", { trigger: "t" }),
    tick(50, "wave_2_redispatch_iter_1", "wave_2_boundary"),
    tick(60, "wave_3_waiting", "wave_3_redispatch_iter_1"),
  ];
  const r = computeTimeReport(events, 0);
  assert.ok(r.redispatch.fixPassWaves <= r.redispatch.totalWaves);
  assert.equal(r.redispatch.totalWaves, 3);
  assert.equal(r.redispatch.fixPassWaves, 2);
});

test("report_time_coverage_line", () => { // AC-10
  const events = [
    P({ m: 0, type: "worker_queue_claimed", x: { task: "T1", worker: "w", attempt: 1, pipeline: "ship-execute", stage: "wave_1_dispatch" } }),
    P({ m: 5, type: "worker_queue_completed", x: { task: "T1", worker: "w" } }),
  ];
  const out = renderTimeReport(computeTimeReport(events, 2));
  assert.match(out, /Data coverage: 1\/1 dispatches paired .*0\/1 completions carry claim_attempt.*0\/0 redispatch.*2 corrupt log lines/);
});

test("report_time_cli_dispatch", () => {
  const d = mkdtempSync(join(tmpdir(), "evrep-"));
  try {
    writeFileSync(join(d, ".shipyard-events.jsonl"), ev(0, "worker_queue_claimed", { task: "T1", attempt: 1 }) + "\n");
    const bin = new URL("../bin/shipyard-data.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const ok = spawnSync(process.execPath, [bin, "report", "time", "--data-dir", d], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Time report/);
    const bad = spawnSync(process.execPath, [bin, "report", "../x", "--data-dir", d], { encoding: "utf8" });
    assert.equal(bad.status, 2);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
