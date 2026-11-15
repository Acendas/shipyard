/** `report idle` (F010 AC-9, AC-10). Run: node --test tests/test_report_idle.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeBoundaryShare, renderBoundaryShare, FORMULA } from "../bin/report-idle.mjs";
import { stageClass } from "../bin/event-report.mjs";

const MIN = 60000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const ev = (m, type, x = {}) => ({ ts: new Date(T0 + m * MIN).toISOString(), type, sprint: "s1", ...x });
const tick = (m, next) => ev(m, "pipeline_tick_completed", { pipeline: "ship-execute", stage: "wave_1_dispatch", next_stage: next });
const events = [
  tick(0, "wave_1_dispatch"),
  tick(10, "wave_1_boundary"),
  tick(20, "wave_2_dispatch"),
  tick(30, "wave_2_dispatch"),
];

test("boundary_share_formula_printed", () => { // AC-9
  const out = renderBoundaryShare(computeBoundaryShare(events));
  assert.ok(out.includes(`Formula: ${FORMULA}`));
  assert.match(out, /boundary share 33%/);
});

test("wave_recovery_is_dispatch", () => { // AC-9
  assert.equal(stageClass("ship-execute", "wave_1_recovery"), "dispatch");
  const r = computeBoundaryShare([tick(0, "wave_1_recovery"), tick(10, "wave_1_boundary"), tick(20, "wave_2_dispatch")]);
  assert.equal(r.sprints[0].ms.dispatch, 10 * MIN);
  assert.equal(r.sprints[0].ms.boundary, 10 * MIN);
});

test("wording_not_idle", () => { // AC-9
  const out = renderBoundaryShare(computeBoundaryShare(events));
  assert.doesNotMatch(out.replace(/Boundary share report/, ""), /\bidle\b/i);
  assert.match(out, /boundary share/);
});

test("coverage_line_and_unknown_bucket", () => { // AC-10
  const e = [...events, { ts: new Date(T0 + 40 * MIN).toISOString(), type: "x" }];
  const r = computeBoundaryShare(e, 3);
  assert.ok(r.sprints.some((s) => s.sprint === "unknown"));
  assert.match(renderBoundaryShare(r), /Data coverage: 4\/4 pipeline ticks map to a known stage class; 3 corrupt log lines skipped/);
});
