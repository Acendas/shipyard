/** T024 / F004: resolve-model --subject escalation ladder from dispatch_attempt events. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function mk({ sprint = "sprint-003", events = [], light = "haiku" } = {}) {
  const d = mkdtempSync(join(tmpdir(), "ladder-"));
  writeFileSync(
    join(d, "config.md"),
    `---\nmodels:\n  think: opus\n  build: sonnet\n  light: ${light}\n---\n\n# Config\n`,
  );
  mkdirSync(join(d, "sprints", "current"), { recursive: true });
  writeFileSync(join(d, "sprints", "current", "SPRINT.md"), `---\nid: ${sprint}\n---\n\n# S\n`);
  writeFileSync(join(d, ".shipyard-events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  return d;
}
const att = (subject, sprint = "sprint-003", extra = {}) => ({
  ts: "2026-11-11T10:00:00+00:00", type: "dispatch_attempt", subject, sprint, ...extra,
});
const run = (d, role, subject) =>
  spawnSync("node", [CLI, "resolve-model", role, "--subject", subject, "--data-dir", d], { encoding: "utf8" });
const done = (d) => rmSync(d, { recursive: true, force: true });

test("0 attempts -> base tier, exit 0", () => {
  const d = mk();
  try {
    const r = run(d, "build", "T001");
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "model=sonnet effort=medium tier=build attempt=0 ladder=ok");
  } finally { done(d); }
});

test("AC-4 one attempt -> one tier up (light->build, build->think)", () => {
  const d = mk({ events: [att("T001")] });
  try {
    const b = run(d, "build", "T001");
    assert.equal(b.status, 0);
    assert.equal(b.stdout.trim(), "model=opus effort=medium tier=think attempt=1 ladder=ok");
    const c = run(d, "coordinator", "T001");
    assert.equal(c.status, 0);
    assert.equal(c.stdout.trim(), "model=sonnet effort=low tier=build attempt=1 ladder=ok");
  } finally { done(d); }
});

test("AC-6 exhausted: two attempts, or one attempt already at think -> exit 3", () => {
  const d = mk({ events: [att("T001"), att("T001"), att("T002")] });
  try {
    const a = run(d, "build", "T001");
    assert.equal(a.status, 3);
    assert.match(a.stdout, /ladder=exhausted/);
    assert.match(a.stdout, /attempt=2/);
    const t = run(d, "think", "T002");
    assert.equal(t.status, 3);
    assert.match(t.stdout, /tier=think attempt=1 ladder=exhausted/);
    const t0 = run(d, "think", "T009");
    assert.equal(t0.status, 0);
    assert.match(t0.stdout, /^model=opus .*tier=think attempt=0 ladder=ok/);
  } finally { done(d); }
});

test("AC-7 attempt comes from the event log (fresh process, same answer)", () => {
  const d = mk({ events: [att("T001")] });
  try {
    assert.equal(run(d, "build", "T001").stdout, run(d, "build", "T001").stdout);
    assert.match(run(d, "build", "T001").stdout, /attempt=1/);
  } finally { done(d); }
});

test("AC-8 no cross-sprint leakage: 2 attempts in sprint 3, 0 in sprint 4", () => {
  const events = [att("T001", "sprint-003"), att("T001", "sprint-003")];
  const d3 = mk({ sprint: "sprint-003", events });
  const d4 = mk({ sprint: "sprint-004", events });
  try {
    assert.equal(run(d3, "build", "T001").status, 3);
    const r = run(d4, "build", "T001");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /tier=build attempt=0 ladder=ok/);
  } finally { done(d3); done(d4); }
});

test("AC-9 independent of escalation.max_consults_per_sprint and consult events", () => {
  const d = mk({ events: [{ ts: "2026-11-11T10:00:00+00:00", type: "consult", subject: "T001", sprint: "sprint-003" }] });
  writeFileSync(join(d, "config.md"), `---\nmodels:\n  think: opus\n  build: sonnet\nescalation:\n  max_consults_per_sprint: 0\n---\n`);
  try {
    const r = run(d, "build", "T001");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /attempt=0 ladder=ok/);
  } finally { done(d); }
});

test("AC-11 queue re-claims do not count (queue attempt field ignored)", () => {
  const d = mk({ events: [
    { ts: "2026-11-11T10:00:00+00:00", type: "queue_claim", subject: "T001", task: "T001", sprint: "sprint-003", attempt: 3 },
    { ts: "2026-11-11T10:00:00+00:00", type: "queue_requeue_stale", task: "T001", sprint: "sprint-003", attempt: 2 },
  ] });
  try { assert.match(run(d, "build", "T001").stdout, /attempt=0 ladder=ok/); }
  finally { done(d); }
});

test("AC-12 pure: no writes to events log or elsewhere", () => {
  const d = mk({ events: [att("T001")] });
  const before = readFileSync(join(d, ".shipyard-events.jsonl"), "utf8");
  try {
    run(d, "build", "T001"); run(d, "build", "T001");
    assert.equal(readFileSync(join(d, ".shipyard-events.jsonl"), "utf8"), before);
  } finally { done(d); }
});

test("missing log, events without sprint field, malformed lines -> not counted", () => {
  const d = mk({ events: [{ type: "dispatch_attempt", subject: "T001" }] });
  try {
    writeFileSync(join(d, ".shipyard-events.jsonl"), `not json\n{"type":"dispatch_attempt","subject":"T001"}\n`);
    assert.match(run(d, "build", "T001").stdout, /attempt=0/);
    rmSync(join(d, ".shipyard-events.jsonl"));
    assert.match(run(d, "build", "T001").stdout, /attempt=0/);
  } finally { done(d); }
});

test("without --subject output is unchanged", () => {
  const d = mk({ events: [att("T001")] });
  try {
    const r = spawnSync("node", [CLI, "resolve-model", "build", "--data-dir", d], { encoding: "utf8" });
    assert.equal(r.stdout.trim(), "model=sonnet effort=medium");
  } finally { done(d); }
});

for (const [label, xform] of [
  ["crlf", (t) => t.replace(/\n/g, "\r\n")],
  ["bom", (t) => "﻿" + t],
  ["bom+crlf", (t) => "﻿" + t.replace(/\n/g, "\r\n")],
]) {
  test(`attempts_crlf ${label} SPRINT.md counts same as LF`, () => {
    const d = mk({ events: [att("T001")] });
    try {
      const f = join(d, "sprints", "current", "SPRINT.md");
      writeFileSync(f, xform(readFileSync(f, "utf8")));
      const r = run(d, "build", "T001");
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), "model=opus effort=medium tier=think attempt=1 ladder=ok");
    } finally { done(d); }
  });
}

test("attempts_crlf unreadable sprint id warns on stderr", () => {
  const d = mk({ events: [att("T001")] });
  try {
    writeFileSync(join(d, "sprints", "current", "SPRINT.md"), "no frontmatter\n");
    const r = run(d, "build", "T001");
    assert.match(r.stderr, /warning: cannot read sprint id/);
    assert.match(r.stdout, /attempt=0/);
  } finally { done(d); }
});

test("attempts_crlf usage text lists --subject", () => {
  const r = spawnSync("node", [CLI, "help"], { encoding: "utf8" });
  assert.match(r.stdout, /resolve-model <role>[^\n]*--subject/);
});
