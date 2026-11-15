/** T041 — read-only presumed-dead detector built on the shared liveness predicate. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectPresumedDead } from "../bin/presumed-dead.mjs";
import { isTaskLiveInEvents } from "../bin/worker-queue.mjs";

const NOW = Date.parse("2026-11-11T20:00:00.000Z");
const min = (n) => new Date(NOW - n * 60_000).toISOString();

const item = (over = {}) => ({
  id: "T001", pipeline: "execute", stage: "wave_1_dispatch", status: "claimed",
  claimed_by: "builder-1", claimed_at: min(90), deadline_at: min(60), attempt: 1, ...over,
});
const q = (...tasks) => ({ version: 1, tasks });
const iter = (ago, task = "T001") => ({ type: "task_loop_iteration", task, ts: min(ago) });

test("presumed_dead: dead builder flagged with claimed_by", () => {
  const r = detectPresumedDead(q(item()), [], NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].task, "T001");
  assert.equal(r[0].claimed_by, "builder-1");
  assert.equal(r[0].attempt, 1);
});

test("presumed_dead: under threshold not flagged; custom threshold honoured", () => {
  assert.equal(detectPresumedDead(q(item({ claimed_at: min(30) })), [], NOW).length, 0);
  assert.equal(detectPresumedDead(q(item({ claimed_at: min(30) })), [], NOW, { presumed_dead_minutes: 20 }).length, 1);
});

test("presumed_dead: live slow builder (iteration within 15 min) not flagged", () => {
  assert.equal(detectPresumedDead(q(item()), [iter(14)], NOW).length, 0);
  // 12 min is inside the ONE shared 15 min liveness window (worker-queue LIVENESS_WINDOW_MS == detector default)
  assert.equal(detectPresumedDead(q(item()), [iter(12)], NOW).length, 0);
  assert.equal(detectPresumedDead(q(item()), [iter(16)], NOW).length, 1);
});

test("presumed_dead: completed_unacked claim is flagged for reconciliation, not alive", () => {
  const r = detectPresumedDead(q(item()), [{ type: "subagent_completed", task: "T001", ts: min(70) }], NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].completed_unacked, true);
});

test("presumed_dead: iteration from an earlier attempt does not keep it alive", () => {
  assert.equal(detectPresumedDead(q(item({ claimed_at: min(90) })), [iter(100)], NOW).length, 1);
});

test("presumed_dead: items missing claimed_at or deadline_at are skipped; non-claimed ignored", () => {
  const r = detectPresumedDead(q(
    item({ id: "A", claimed_at: null }), item({ id: "B", deadline_at: null }),
    item({ id: "C", claimed_at: "garbage" }), item({ id: "D", status: "pending" }),
    item({ id: "E", status: "completed" }),
  ), [], NOW);
  assert.deepEqual(r, []);
});

test("presumed_dead: already-reported (pipeline, stage, task, attempt) is deduped", () => {
  const rep = { type: "subagent_presumed_dead", pipeline: "execute", stage: "wave_1_dispatch", task: "T001", attempt: 1, ts: min(5) };
  assert.equal(detectPresumedDead(q(item()), [rep], NOW).length, 0);
  // a new attempt is a new key
  assert.equal(detectPresumedDead(q(item({ attempt: 2 })), [rep], NOW).length, 1);
  // different stage is a different key
  assert.equal(detectPresumedDead(q(item({ stage: "wave_2_dispatch" })), [rep], NOW).length, 1);
});

test("presumed_dead: inputs are not mutated and results are stable", () => {
  const queue = q(item(), item({ id: "T002", claimed_at: null }));
  const events = [iter(100, "T009")];
  const qs = JSON.stringify(queue), es = JSON.stringify(events);
  const a = detectPresumedDead(queue, events, NOW);
  const b = detectPresumedDead(queue, events, NOW);
  assert.equal(JSON.stringify(queue), qs);
  assert.equal(JSON.stringify(events), es);
  assert.deepEqual(a, b);
});

test("presumed_dead: reuses the shared predicate (no duplicate implementation)", () => {
  const src = readFileSync(new URL("../bin/presumed-dead.mjs", import.meta.url), "utf8");
  assert.match(src, /isTaskLiveInEvents/);
  assert.doesNotMatch(src, /task_loop_iteration/);
  assert.doesNotMatch(src, /requeue|withQueue/);
  assert.equal(typeof isTaskLiveInEvents, "function");
});

test("presumed_dead: isTaskLiveInEvents window is parameterised", () => {
  const t = item();
  assert.equal(isTaskLiveInEvents([iter(16)], t, NOW), false, "outside the shared 15 min window");
  assert.equal(isTaskLiveInEvents([iter(12)], t, NOW), true, "inside the shared 15 min window"); // default 10 min
  assert.equal(isTaskLiveInEvents([iter(12)], t, NOW, 15 * 60_000), true);
});
