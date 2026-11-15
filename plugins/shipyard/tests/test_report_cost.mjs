/** `report cost` (F010 AC-8, AC-10). Run: node --test tests/test_report_cost.mjs */
import { test } from "node:test";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { computeCostReport, renderCostReport, loadTaskKinds } from "../bin/report-cost.mjs";

const MIN = 60000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const ev = (m, type, x = {}) => ({ ts: new Date(T0 + m * MIN).toISOString(), type, sprint: "s1", ...x });
const base = [
  ev(0, "worker_queue_claimed", { task: "T1", attempt: 1, kind: "work" }),
  ev(5, "worker_queue_completed", { task: "T1", claim_attempt: 1 }),
  ev(5, "task_dispatch_returned", { task: "T1", status: "complete", model: "opus", attempt: 1, tokens: "1200" }),
  ev(6, "worker_queue_claimed", { task: "T2", attempt: 1, kind: "work" }),
  ev(10, "worker_queue_completed", { task: "T2", claim_attempt: 1 }),
  ev(10, "task_dispatch_returned", { task: "T2", status: "complete", model: "sonnet", attempt: 2 }),
  ev(11, "task_dispatch_returned", { task: "T3", status: "complete" }),
];

test("groups_by_tier_and_kind", () => { // AC-8
  const r = computeCostReport(base);
  const keys = r.groups.map((g) => `${g.tier}/${g.kind}`);
  assert.deepEqual(keys, ["opus/work", "sonnet/work", "unknown/unknown"]);
  assert.equal(r.groups[0].tokens, 1200);
  assert.equal(r.groups[1].tokens, null);
});

test("no_tokens_shows_attempts_duration_labelled", () => { // AC-8
  const out = renderCostReport(computeCostReport(base));
  assert.match(out, /tier=sonnet\s+kind=work\s+tasks=1\s+tokens=not recorded \(proxy: attempts=2, duration=4\.0m\)/);
  assert.match(out, /tier=opus\s+kind=work\s+tasks=1\s+tokens=1200/);
  assert.doesNotMatch(out, /tokens=0\b/);
});

test("coverage_line", () => { // AC-10
  const out = renderCostReport(computeCostReport(base, 2));
  assert.match(out, /Data coverage: 2\/3 accepted tasks have tier; 2\/3 have kind; 1\/3 have tokens; 2 corrupt log lines skipped/);
});

test("zero_tokens_are_absent", () => { // AC-8
  const r = computeCostReport([ev(0, "task_dispatch_returned", { task: "T9", status: "complete", model: "m", tokens: 0 })]);
  assert.equal(r.tasks[0].tokens, null);
});

test("mixed_group_partial_tokens_labelled_with_proxy", () => { // AC-8
  const mk = (id, m, x = {}) => [
    ev(m, "worker_queue_claimed", { task: id, attempt: 1, kind: "work" }),
    ev(m + 2, "worker_queue_completed", { task: id, claim_attempt: 1 }),
    ev(m + 2, "task_dispatch_returned", { task: id, status: "complete", model: "opus", attempt: 1, ...x }),
  ];
  const events = [...mk("A", 0, { tokens: "1200" }), ...mk("B", 10), ...mk("C", 20, { attempt: 3 })];
  const r = computeCostReport(events);
  assert.equal(r.groups.length, 1);
  assert.equal(r.groups[0].tokens, 1200);
  const out = renderCostReport(r);
  assert.match(out, /tokens=1200 \(1\/3 tasks have tokens\)/);
  assert.match(out, /tokenless tasks, not recorded \(proxy: attempts=4, duration=4\.0m\)/);
  // all-token groups keep their original shape
  assert.match(renderCostReport(computeCostReport(base)), /tier=opus\s+kind=work\s+tasks=1\s+tokens=1200\n/);
});

test("kind_comes_from_task_file_frontmatter", () => { // AC-10
  const dd = mkdtempSync(join(tmpdir(), "cost-kind-"));
  mkdirSync(join(dd, "spec", "tasks"), { recursive: true });
  mkdirSync(join(dd, "spec", "archive", "tasks"), { recursive: true });
  writeFileSync(join(dd, "spec", "tasks", "T1-a.md"), "---\nid: T1\nkind: feature\n---\nbody\n");
  writeFileSync(join(dd, "spec", "archive", "tasks", "T2-b.md"), "---\nid: T2\nkind: research\n---\nbody\n");
  assert.equal(loadTaskKinds(dd).get("T1"), "feature");
  const r = computeCostReport(base, 0, { dataDir: dd });
  assert.deepEqual(r.groups.map((g) => `${g.tier}/${g.kind}`), ["opus/feature", "sonnet/research", "unknown/unknown"]);
  assert.match(renderCostReport(r), /kind source: task file frontmatter/);
  // no task file -> falls back to event kind
  assert.deepEqual(computeCostReport(base, 0, { dataDir: join(dd, "none") }).groups.map((g) => g.kind), ["work", "work", "unknown"]);
});
