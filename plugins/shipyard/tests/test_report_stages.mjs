/** `report stages` (F012). Run: node --test tests/test_report_stages.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CLASSES, BETWEEN, MIN_SPRINTS, BOUNDARY_BAR, STAGE_SHARE_CLASS, stageShareClass, missingStageClasses, median,
  computeStagesReport, renderStagesReport, renderDecisionDoc, finishedSprints, sprintById, reportMain, FORMULA,
} from "../bin/report-stages.mjs";
import { activeTime } from "../bin/event-report.mjs";
import { PIPELINES, knownStages } from "../bin/pipeline-stages.mjs";

const MIN = 60000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (m) => new Date(T0 + m * MIN).toISOString();
const ev = (m, type, x = {}) => ({ ts: iso(m), type, ...x });
const tick = (m, sprint, next, pipeline = "ship-execute") =>
  ev(m, "pipeline_tick_completed", { pipeline, sprint, stage: "x", outcome: "advanced", next_stage: next });

/**
 * Fixture with known timings (minutes). Three sprints.
 *
 * s1 [0,100]: dispatch 0-10 | waiting 10-60 (claim 5-55 covers the 45-min silence) |
 *             boundary 60-70 | build 70-80 | redispatch 80-90 | gate 90-100 | tick->terminal at 100
 *   active 100: boundary 30, waiting 50, dispatch 10, redispatch 10. silent 0.
 * between [100,200]: 100 min silent.
 * s2 [200,320]: dispatch 200-210 | tests 210-260 (silent 50) | gate 260-270 | pipeline_terminal 270 | event 320 (silent 50, "other")
 *   active 20: dispatch 10, boundary 10. silent 100 (boundary 50, other 50).
 * between [320,400]: 80 min silent.
 * s3 [400,460]: dispatch 400-410 (claim opens 401) | build 410-460 (claim closes 450: 40 min claim-only -> waiting, 10 min build)
 *   active 60: dispatch 10, waiting 40, boundary 10. silent 0.
 */
function fixture() {
  const events = [
    tick(0, "s1", "wave_1_dispatch"),
    ev(5, "worker_queue_claimed", { sprint: "s1", task: "t1", worker: "w1" }),
    tick(10, "s1", "wave_1_waiting"),
    ev(55, "worker_queue_completed", { sprint: "s1", task: "t1", worker: "w1" }),
    tick(60, "s1", "wave_1_boundary"),
    ev(65, "task_commit_anchored", { task: "t1" }), // untagged, inside the range
    tick(70, "s1", "wave_1_build"),
    tick(80, "s1", "wave_1_redispatch_iter_1"),
    tick(90, "s1", "wave_1_gate"),
    tick(100, "s1", "terminal_handoff_to_review"),
    tick(200, "s2", "wave_1_dispatch"),
    tick(210, "s2", "wave_1_tests"),
    tick(260, "s2", "wave_1_gate"),
    ev(270, "pipeline_terminal", { sprint: "s2" }),
    ev(320, "sprint_tasks_archived", { sprint: "s2" }),
    tick(400, "s3", "wave_1_dispatch"),
    ev(401, "worker_queue_claimed", { sprint: "s3", task: "t2", worker: "w2" }),
    tick(410, "s3", "wave_1_build"),
    ev(450, "worker_queue_completed", { sprint: "s3", task: "t2", worker: "w2" }),
    tick(460, "s3", "terminal_handoff_to_review"),
  ];
  const sprints = [
    { id: "s1", startedAt: iso(0), completedAt: iso(100) },
    { id: "s2", startedAt: iso(200), completedAt: iso(320) },
    { id: "s3", startedAt: iso(400), completedAt: iso(460) },
  ];
  return { events, sprints };
}

/** Two-segment sprint: dispatch for d minutes then build for b minutes, an event every 5 min so nothing is silent. boundary share = b/(b+d). */
function simpleSprint(id, start, d, b) {
  const events = [tick(start, id, "wave_1_dispatch"), tick(start + d, id, "wave_1_build"), tick(start + d + b, id, "terminal_handoff_to_review")];
  for (let m = start + 5; m < start + d + b; m += 5) if (m !== start + d) events.push(ev(m, "task_status_set", { sprint: id }));
  return { events, sprint: { id, startedAt: iso(start), completedAt: iso(start + d + b) } };
}

test("every_stage_maps_to_exactly_one_class", () => { // AC-2, AC-11
  assert.deepEqual(missingStageClasses(), []);
  for (const p of PIPELINES) {
    for (const k of knownStages(p)) assert.ok(CLASSES.includes(STAGE_SHARE_CLASS[p][k]), `${p}:${k}`);
    for (const k of Object.keys(STAGE_SHARE_CLASS[p])) assert.ok(knownStages(p).includes(k), `${p}:${k} is not a pipeline stage`);
  }
  assert.equal(stageShareClass("ship-execute", "wave_3_tests_fix_iter_2"), "redispatch");
  assert.equal(stageShareClass("ship-execute", "wave_1_build_fix_iter_1"), "redispatch");
  assert.equal(stageShareClass("ship-execute", "sprint_tests_fix_iter_1"), "redispatch");
  assert.equal(stageShareClass("ship-execute", "wave_2_waiting"), "waiting");
  assert.equal(stageShareClass("ship-execute", "wave_2_recovery"), "dispatch");
  for (const s of ["sprint_demo_probes", "sprint_complete_gate", "sprint_full_build", "sprint_full_tests", "wave_4_boundary", "wave_4_refactor"]) {
    assert.equal(stageShareClass("ship-execute", s), "boundary", s);
  }
  for (const s of ["preflight", "review_scan", "code_review_iter_3", "retro_step_2", "terminal"]) assert.equal(stageShareClass("ship-review", s), "review", s);
  assert.equal(stageShareClass("ship-execute", "preflight"), "other");
  assert.equal(stageShareClass("ship-execute", "not_a_stage"), null);
  assert.equal(stageShareClass("no-such-pipeline", "preflight"), null);
});

test("unmapped_stage_fails", () => { // AC-2, AC-11
  const { wave_gate, ...rest } = STAGE_SHARE_CLASS["ship-execute"];
  const broken = { "ship-execute": { ...rest, wave_build: "bogus" }, "ship-review": STAGE_SHARE_CLASS["ship-review"] };
  assert.deepEqual(missingStageClasses(broken).sort(), ["ship-execute:wave_build", "ship-execute:wave_gate"]);
});

test("fixture_shares_exact", () => { // AC-1, AC-3, AC-11, AC-13
  const { events, sprints } = fixture();
  const r = computeStagesReport(events, 0, { sprints });
  const [s1, s2, s3] = r.sprints;
  assert.equal(s1.id, "s1");
  assert.deepEqual(s1.ms, { boundary: 30 * MIN, waiting: 50 * MIN, dispatch: 10 * MIN, redispatch: 10 * MIN, review: 0, other: 0 });
  assert.equal(s1.activeMs, 100 * MIN);
  assert.equal(s1.shares.boundary, 0.3);
  assert.equal(s1.shares.waiting, 0.5);
  assert.equal(s1.silentMs, 0);
  assert.deepEqual(s2.ms, { boundary: 10 * MIN, waiting: 0, dispatch: 10 * MIN, redispatch: 0, review: 0, other: 0 });
  assert.equal(s2.shares.boundary, 0.5);
  assert.equal(s2.silentMs, 100 * MIN);
  assert.equal(s2.silentByClass.boundary, 50 * MIN);
  assert.equal(s2.silentByClass.other, 50 * MIN); // after pipeline_terminal
  assert.equal(s2.spanMs, 120 * MIN);
  assert.equal(s2.silentShare, 100 / 120);
  assert.deepEqual(s3.ms, { boundary: 10 * MIN, waiting: 40 * MIN, dispatch: 10 * MIN, redispatch: 0, review: 0, other: 0 }); // AC-3
  assert.equal(s3.activeMs, 60 * MIN);
  assert.equal(r.medians.boundary, 0.3);
  assert.equal(r.medians.waiting, 0.5);
  assert.equal(r.totals.wallMs, 460 * MIN);
  assert.equal(r.totals.activeMs, 180 * MIN);
  assert.equal(r.totals.silentMs, 280 * MIN);
  assert.equal(r.totals.silentByClass[BETWEEN], 180 * MIN);
  assert.equal(r.totals.silentByClass.boundary, 50 * MIN);
  assert.equal(r.totals.silentByClass.other, 50 * MIN);
  assert.equal(r.totals.silentShare, 280 / 460);
  assert.equal(r.coverage.ticksTotal, 13);
  assert.equal(r.coverage.ticksClassified, 13);
});

test("segment_sum_equals_shared_activeTime", () => { // AC-3: activeTime is not redefined
  const { events, sprints } = fixture();
  const r = computeStagesReport(events, 0, { sprints });
  const whole = activeTime(events);
  assert.equal(r.totals.activeMs + 0, whole.activeMs);
  assert.equal(r.totals.checkActiveMs, whole.activeMs);
  assert.equal(r.totals.silentMs, whole.silentMs);
  // gap override flows through to activeTime
  const r2 = computeStagesReport(events, 0, { sprints, gapMs: 60 * MIN });
  assert.equal(r2.totals.activeMs, activeTime(events, { gapMs: 60 * MIN }).activeMs);
  assert.equal(r2.sprints[1].silentMs, 0);
});

test("silent_time_never_in_active_shares", () => { // AC-13
  const { events, sprints } = fixture();
  const r = computeStagesReport(events, 0, { sprints });
  for (const s of r.sprints) {
    const sum = CLASSES.reduce((a, c) => a + s.ms[c], 0);
    assert.equal(sum, s.activeMs);
    assert.equal(s.activeMs + s.silentMs, s.spanMs);
  }
  const out = renderStagesReport(r);
  assert.match(out, /Silent time \(share of wall-clock, never in active shares\): 61% of 7\.7h/);
  assert.match(out, /between sprints=3\.0h/);
});

test("fewer_than_three_sprints_is_undecided", () => { // AC-5
  const { events, sprints } = fixture();
  const r = computeStagesReport(events, 0, { sprints: sprints.slice(0, 2) });
  assert.equal(r.decision.outcome, "undecided");
  assert.equal(r.decision.found, 2);
  assert.equal(r.decision.needed, MIN_SPRINTS);
  const out = renderStagesReport(r);
  assert.match(out, /Decision: undecided — 2 finished sprints with pipeline data found, 3 needed\./);
});

test("sprint_without_execute_ticks_is_excluded", () => { // AC-5
  const { events, sprints } = fixture();
  const extra = [tick(600, "s4", "preflight", "ship-review"), tick(610, "s4", "review_scan", "ship-review"), tick(620, "s4", "terminal", "ship-review")];
  const r = computeStagesReport([...events, ...extra], 0, { sprints: [...sprints, { id: "s4", startedAt: iso(600), completedAt: iso(620) }] });
  const s4 = r.sprints.find((s) => s.id === "s4");
  assert.equal(s4.measurable, false);
  assert.equal(s4.shares.review, 1);
  assert.equal(r.decision.found, 3);
  assert.equal(r.decision.finished, 4);
  assert.equal(r.medians.boundary, 0.3); // s4 not in the median
  assert.match(renderStagesReport(r), /s4 .*\[no ship-execute ticks; excluded from median and decision\]/);
  const none = computeStagesReport(events, 0, { sprints: [...sprints, { id: "s9", startedAt: iso(900), completedAt: iso(950) }] });
  assert.ok(none.sprints.find((s) => s.id === "s9").noData);
});

test("rule_at_or_above_bar_recommends_overlap", () => { // AC-6
  const a = simpleSprint("a", 0, 70, 30), b = simpleSprint("b", 200, 75, 25), c = simpleSprint("c", 400, 50, 50);
  const r = computeStagesReport([...a.events, ...b.events, ...c.events], 0, { sprints: [a.sprint, b.sprint, c.sprint] });
  assert.equal(r.medians.boundary, 0.3);
  assert.equal(r.decision.outcome, "overlap");
  const out = renderStagesReport(r);
  assert.match(out, /PROVISIONAL/);
  assert.match(out, /Decision: median boundary share 30% is at or above the provisional 25% bar → recommend building overlap review \(E003 waves 5\.2 and 5\.3; F032 \/ 5\.5 follows the same outcome\)\./);
  const exact = simpleSprint("b2", 200, 75, 25);
  const r2 = computeStagesReport([...a.events, ...exact.events, ...simpleSprint("c2", 400, 90, 10).events], 0, { sprints: [a.sprint, exact.sprint, { id: "c2", startedAt: iso(400), completedAt: iso(500) }] });
  assert.equal(r2.medians.boundary, BOUNDARY_BAR);
  assert.equal(r2.decision.outcome, "overlap");
});

test("rule_below_bar_recommends_no_overlap", () => { // AC-6
  const a = simpleSprint("a", 0, 90, 10), b = simpleSprint("b", 200, 80, 20), c = simpleSprint("c", 400, 50, 50);
  const r = computeStagesReport([...a.events, ...b.events, ...c.events], 0, { sprints: [a.sprint, b.sprint, c.sprint] });
  assert.equal(r.medians.boundary, 0.2);
  assert.equal(r.decision.outcome, "no_overlap");
  assert.match(renderStagesReport(r), /below the provisional 25% bar → recommend only per-feature review \(5\.1, F028\) and the code-review integration \(5\.4, F031\)/);
});

test("findings_and_formula_printed", () => { // AC-1, AC-9
  const { events, sprints } = fixture();
  const out = renderStagesReport(computeStagesReport(events, 3, { sprints }), "test scope");
  assert.ok(out.includes(`Formula: ${FORMULA}`));
  assert.match(out, /Scope: test scope/);
  assert.match(out, /redispatch share of active time: median 0% \(s1 10%, s2 0%, s3 0%\)/);
  assert.match(out, /silent share of wall-clock: 61%/);
  assert.match(out, /median \(3\)/);
  assert.match(out, /13\/13 pipeline ticks in scope map to a stage class; 3 corrupt log lines skipped; attribution check ok/);
  assert.doesNotMatch(out.replace(/^.*Formula.*$/m, ""), /\bidle\b/i);
});

test("unknown_stage_counts_in_coverage", () => {
  const { events, sprints } = fixture();
  const r = computeStagesReport([...events, tick(95, "s1", "wave_1_mystery")], 0, { sprints });
  assert.equal(r.coverage.ticksClassified, 13);
  assert.equal(r.coverage.ticksTotal, 14);
  assert.deepEqual(r.coverage.unknownStages, { "ship-execute:wave_1_mystery": 1 });
  assert.match(renderStagesReport(r), /unclassified ticks: ship-execute:wave_1_mystery x1/);
});

test("median_helper", () => {
  assert.equal(median([]), null);
  assert.equal(median([0.3, null, 0.1]), 0.2);
  assert.equal(median([0.5, 0.1, 0.3]), 0.3);
});

function tempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "report-stages-"));
  const { events, sprints } = fixture();
  writeFileSync(join(dir, ".shipyard-events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n");
  mkdirSync(join(dir, "events-archive"));
  writeFileSync(join(dir, "events-archive", "events-2025-12-31.jsonl"), JSON.stringify(ev(-30, "skill_lock_acquired")) + "\n");
  for (const s of sprints) {
    mkdirSync(join(dir, "sprints", s.id), { recursive: true });
    writeFileSync(join(dir, "sprints", s.id, "SPRINT.md"), `---\nid: ${s.id}\nstatus: completed\nstarted_at: ${s.startedAt}\ncompleted_at: ${s.completedAt}\n---\n# ${s.id}\n`);
  }
  mkdirSync(join(dir, "sprints", "sprint-x"));
  writeFileSync(join(dir, "sprints", "sprint-x", "SPRINT.md"), `---\nid: sprint-x\nstatus: cancelled\n---\n`);
  mkdirSync(join(dir, "sprints", "current"));
  writeFileSync(join(dir, "sprints", "current", "SPRINT.md"), `---\nid: s5\nstatus: active\nstarted_at: ${iso(500)}\n---\n`);
  return dir;
}

function snapshot(dir) {
  const out = [];
  (function walk(d) {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      const st = statSync(p);
      out.push(`${p}|${st.isDirectory() ? "dir" : st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  })(dir);
  return out.join("\n");
}

function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { return { result: fn(), out: chunks.join("") }; } finally { process.stdout.write = orig; }
}

test("finished_sprints_and_sprint_by_id", () => {
  const dir = tempDataDir();
  assert.deepEqual(finishedSprints(dir).map((s) => s.id), ["s1", "s2", "s3"]);
  assert.equal(sprintById(dir, "s5").startedAt, iso(500));
  assert.equal(sprintById(dir, "s2").completedAt, iso(320));
  assert.deepEqual(sprintById(dir, "nope"), { id: "nope", status: "unknown", startedAt: null, completedAt: null });
});

test("report_main_reads_archives_and_live_log_and_writes_nothing", () => { // AC-4, AC-12
  const dir = tempDataDir();
  const before = snapshot(dir);
  const { result, out } = capture(() => reportMain(dir, ["--all"]));
  assert.equal(snapshot(dir), before);
  assert.equal(result.coverage.eventCount, 21); // 20 live + 1 archived
  assert.equal(result.coverage.corrupt, 1);
  assert.equal(result.decision.outcome, "overlap");
  assert.match(out, /Scope: finished sprints \(archived SPRINT\.md with status completed\): s1, s2, s3/);
  assert.doesNotMatch(out, /Decision doc written/);
  const one = capture(() => reportMain(dir, ["--sprint", "s2", "--gap", "60"]));
  assert.equal(snapshot(dir), before);
  assert.equal(one.result.sprints.length, 1);
  assert.equal(one.result.sprints[0].silentMs, 0);
  assert.equal(one.result.decision.outcome, "undecided");
  assert.match(one.out, /Gap threshold: 60 min/);
  assert.throws(() => capture(() => reportMain(dir, ["--gap", "zero"])), /--gap expects a positive number/);
});

test("write_doc_only_when_asked", () => { // AC-7, AC-8, AC-12
  const dir = tempDataDir();
  const docPath = join(mkdtempSync(join(tmpdir(), "report-stages-doc-")), "nested", "v41-pipelining-decision.md");
  const before = snapshot(dir);
  const { out } = capture(() => reportMain(dir, ["--all", "--write-doc", docPath]));
  assert.equal(snapshot(dir), before);
  assert.ok(existsSync(docPath));
  assert.match(out, /Decision doc written: /);
  const doc = readFileSync(docPath, "utf8");
  assert.match(doc, /^---\ntype: reference\nstatus: active\nscope: shipyard\nupdated: \d{4}-\d{2}-\d{2}\n/);
  assert.match(doc, /## Decision/);
  assert.match(doc, /the user confirms it, and E003 is updated through `\/ship-discuss`\. No epic or feature file is edited automatically\./);
  assert.match(doc, /IDEA-001 and IDEA-002/);
  assert.match(doc, /\| s1 \| 1\.7h \| 30% \| 50% \| 10% \| 10% \| 0% \| 0% \|/);
  const direct = renderDecisionDoc(computeStagesReport(fixture().events, 0, { sprints: fixture().sprints.slice(0, 1) }), { date: "2026-02-02" });
  assert.match(direct, /updated: 2026-02-02/);
  assert.match(direct, /Decision: undecided — 1 finished sprint with pipeline data found, 3 needed\./);
});
