/** E004: rules-first routing — closed table, MAX combination, fallback up on missing kind/effort, unscored risk = medium, logged. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { routeRules, KIND_TIER, SIZE_EFFORT } from "../bin/route.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "route-"));
  const d = join(base, "projects", "abc123abc123");
  for (const sub of ["templates", "spec/steps", "spec/tasks", "spec/stories", "sprints/current"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "config.md"), "---\nmodels:\n  think: opus\n  build: sonnet\n  light: haiku\n---\n");
  writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\nstories: [S001]\n---\n");
  writeFileSync(join(d, "spec/steps/P001-x.md"), "---\nid: \"P001\"\ntype: step\nkind: feature\nstory: S001\nstatus: approved\neffort: S\n---\n");
  writeFileSync(join(d, "spec/steps/P002-y.md"), "---\nid: \"P002\"\ntype: step\nkind: operational\nstory: S001\nstatus: approved\neffort: M\n---\n");
  writeFileSync(join(d, "spec/tasks/T001-spike.md"), "---\nid: T001\ntype: task\nkind: spike\nstatus: open\neffort: M\n---\n");
  writeFileSync(join(d, "spec/stories/S001-s.md"), "---\nid: S001\ntitle: s\ntype: feature\nstatus: approved\nstory_points: 8\n---\n");
  return { base, d };
}
const run = (d, ...args) => spawnSync("node", [CLI, "route", ...args, "--data-dir", d], { encoding: "utf8" });
const events = (d) => readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("routeRules: size picks the tier for sized kinds (S light, M build, L think), MAX for risk/role/pin, fallback up, unscored risk = medium", () => {
  assert.deepEqual(KIND_TIER.feature, "build");
  assert.deepEqual(SIZE_EFFORT.S, "low");
  // straightforward → light, needs reasoning → build, hard → think
  let r = routeRules({ kind: "feature", effort: "S", risk: "low" });
  assert.equal(r.tier, "light"); assert.equal(r.effort, "low"); assert.equal(r.fallback_up, false);
  r = routeRules({ kind: "feature", effort: "S", risk: null });
  assert.equal(r.tier, "light", "unscored risk does not climb a tier"); assert.equal(r.effort, "medium");
  assert.equal(routeRules({ kind: "bug", effort: "M", risk: "low" }).tier, "build");
  r = routeRules({ kind: "feature", effort: "L", risk: "low" });
  assert.equal(r.tier, "think"); assert.equal(r.effort, "high");
  assert.equal(routeRules({ kind: "fixer", effort: "XL", risk: "low" }).tier, "think");
  assert.equal(routeRules({ kind: "debug", effort: "S", risk: "low" }).tier, "build", "finding a cause is reasoning whatever its size");
  // risk only raises
  r = routeRules({ kind: "feature", effort: "S", risk: "high" });
  assert.equal(r.tier, "build", "high risk raises one tier"); assert.equal(r.effort, "high");
  r = routeRules({ kind: "feature", effort: "S", risk: "critical" });
  assert.equal(r.tier, "think"); assert.equal(r.effort, "high");
  r = routeRules({ kind: "operational", effort: "M", risk: "low" });
  assert.equal(r.tier, "light"); assert.equal(r.effort, "medium");
  assert.equal(routeRules({ kind: "operational", effort: "M", risk: "high" }).tier, "build");
  // missing inputs fall back UP
  r = routeRules({ kind: "banana", effort: "S", risk: "low" });
  assert.equal(r.tier, "think", "unknown kind: one tier up from build"); assert.equal(r.fallback_up, true);
  r = routeRules({ kind: "operational", effort: null, risk: "low" });
  assert.equal(r.tier, "build", "unknown effort: one tier up"); assert.equal(r.fallback_up, true);
  assert.equal(routeRules({ kind: "feature", effort: null, risk: "low" }).tier, "think", "an unsized feature is not assumed easy");
  // role floors and the planner's pin only raise
  assert.equal(routeRules({ kind: "operational", effort: "S", risk: "low", role: "think" }).tier, "think", "a role floor only raises");
  assert.equal(routeRules({ kind: "spike", effort: "M", risk: "low", role: "coordinator" }).tier, "think", "a lower role floor never lowers");
  assert.equal(routeRules({ kind: "feature", effort: "S", risk: "low", role: "build" }).tier, "light", "a builder may run on the light tier");
  assert.equal(routeRules({ kind: "feature", effort: "S", risk: "low", role: "operational_fix" }).tier, "build", "diagnosing a failure is never light");
  assert.equal(routeRules({ kind: "feature", effort: "S", risk: "low", pin: "build" }).tier, "build", "a small step that needs judgment is pinned up");
  assert.equal(routeRules({ kind: "feature", effort: "L", risk: "low", pin: "light" }).tier, "think", "a pin never lowers");
  // no light model of its own: nothing changes for a project that never set one
  r = routeRules({ kind: "feature", effort: "S", risk: "low", lightDistinct: false });
  assert.equal(r.tier, "build"); assert.match(r.reasons.join(" | "), /models\.light is not a model of its own/);
  // the size table is the project's to change
  assert.equal(routeRules({ kind: "feature", effort: "L", risk: "low", sizeTiers: { S: "light", M: "build", L: "build", XL: "think" } }).tier, "build");
});

test("CLI: reads kind/effort from the record, risk from the latest risk_scored event, resolves the model and logs route_decided", () => {
  const { base, d } = fixture();
  try {
    let r = run(d, "--step", "P001", "--json");
    assert.equal(r.status, 0, r.stderr);
    let j = JSON.parse(r.stdout);
    assert.equal(j.tier, "light"); assert.equal(j.model, "haiku"); assert.equal(j.effort, "medium");
    assert.equal(j.inputs.kind, "feature"); assert.equal(j.inputs.effort, "S"); assert.equal(j.inputs.risk, null);

    writeFileSync(join(d, ".shipyard-events.jsonl"), JSON.stringify({ ts: "2026-11-13T00:00:00Z", type: "risk_scored", sprint: "sprint-001", story: "S001", step: "", level: "high" }) + "\n");
    r = run(d, "--step", "P001", "--json");
    j = JSON.parse(r.stdout);
    assert.equal(j.inputs.risk, "high", "the story's risk applies to its steps");
    assert.equal(j.tier, "build", "a small step with high risk leaves the light tier"); assert.equal(j.model, "sonnet"); assert.equal(j.effort, "high");

    r = run(d, "--step", "P002", "--risk", "low", "--json");
    j = JSON.parse(r.stdout);
    assert.equal(j.tier, "light"); assert.equal(j.model, "haiku");

    r = run(d, "--task", "T001", "--risk", "low", "--json");
    j = JSON.parse(r.stdout);
    assert.equal(j.tier, "think", "a spike is judgment work");

    r = run(d, "--story", "S001", "--risk", "medium", "--json");
    j = JSON.parse(r.stdout);
    assert.equal(j.inputs.effort, "L", "8 points → L");
    assert.equal(j.effort, "high");

    r = run(d, "--role", "think", "--kind", "feature", "--effort", "S", "--risk", "low");
    assert.match(r.stdout, /^tier=think model=opus effort=low/);

    r = run(d, "--step", "P999", "--json");
    j = JSON.parse(r.stdout);
    assert.equal(j.fallback_up, true, "a missing record falls back up");
    assert.equal(j.inputs.source.record, "missing");

    // resolve-model consults route: default agent_effort yields the routed effort; a customized value is a floor
    const rm = (...a) => spawnSync("node", [CLI, "resolve-model", "build", "--subject", "P001", ...a, "--data-dir", d], { encoding: "utf8" });
    writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\nstories: [S001]\n---\n");
    appendFileSync(join(d, ".shipyard-events.jsonl"), JSON.stringify({ ts: "2026-11-13T00:00:01Z", type: "risk_scored", sprint: "sprint-001", story: "S001", step: "", level: "low" }) + "\n");
    let m = rm();
    assert.match(m.stdout, /model=haiku effort=low tier=light attempt=0 ladder=ok routed=light:low/, m.stdout + m.stderr);
    // the failure ladder climbs one rung per failed dispatch: light → build → think, then stops
    writeFileSync(join(d, "spec/steps/P005-l.md"), "---\nid: \"P005\"\ntype: step\nkind: feature\nstory: S001\nstatus: approved\neffort: S\n---\n");
    const rm5 = () => spawnSync("node", [CLI, "resolve-model", "build", "--subject", "P005", "--data-dir", d], { encoding: "utf8" });
    const attempt = () => appendFileSync(join(d, ".shipyard-events.jsonl"), JSON.stringify({ ts: new Date().toISOString(), type: "dispatch_attempt", pipeline: "ship-execute", sprint: "sprint-001", subject: "P005" }) + "\n");
    assert.match(rm5().stdout, /model=haiku effort=low tier=light attempt=0 ladder=ok/);
    attempt(); m = rm5();
    assert.match(m.stdout, /model=sonnet effort=low tier=build attempt=1 ladder=ok/, m.stdout);
    attempt(); m = rm5();
    assert.match(m.stdout, /model=opus effort=low tier=think attempt=2 ladder=ok/, m.stdout);
    attempt(); m = rm5();
    assert.equal(m.status, 3, "after think there is nowhere to go"); assert.match(m.stdout, /ladder=exhausted/);
    // a step pinned up by the planner starts there
    writeFileSync(join(d, "spec/steps/P003-z.md"), "---\nid: \"P003\"\ntype: step\nkind: feature\nstory: S001\nstatus: approved\neffort: S\ntier: build\n---\n");
    let pinned = spawnSync("node", [CLI, "resolve-model", "build", "--subject", "P003", "--data-dir", d], { encoding: "utf8" });
    assert.match(pinned.stdout, /model=sonnet effort=low tier=build attempt=0 ladder=ok routed=build:low/, pinned.stdout);
    // without a light model of its own nothing moves: the pre-4.10 behaviour
    writeFileSync(join(d, "config.md"), "---\nmodels:\n  think: opus\n  build: sonnet\n  light: \"\"\n---\n");
    writeFileSync(join(d, "spec/steps/P004-q.md"), "---\nid: \"P004\"\ntype: step\nkind: feature\nstory: S001\nstatus: approved\neffort: S\n---\n");
    pinned = spawnSync("node", [CLI, "resolve-model", "build", "--subject", "P004", "--data-dir", d], { encoding: "utf8" });
    assert.match(pinned.stdout, /model=sonnet effort=low tier=build attempt=0 ladder=ok routed=build:low/, pinned.stdout);
    writeFileSync(join(d, "config.md"), "---\nmodels:\n  think: opus\n  build: sonnet\n  light: haiku\n---\n");
    writeFileSync(join(d, "config.md"), "---\nmodels:\n  think: opus\n  build: sonnet\n  light: haiku\nagent_effort:\n  build: high\n---\n");
    m = rm();
    assert.match(m.stdout, /effort=high/, "a customized agent_effort.build is never lowered by routing");
    writeFileSync(join(d, "config.md"), "---\nmodels:\n  think: opus\n  build: sonnet\n  light: haiku\nagent_effort:\n  build: high\nrouting:\n  rules: false\n---\n");
    m = rm();
    assert.match(m.stdout, /effort=high tier=build attempt=0 ladder=ok$/m, "routing.rules false = static");
    writeFileSync(join(d, "config.md"), "---\nmodels:\n  think: opus\n  build: sonnet\n  light: haiku\n---\n");

    r = run(d);
    assert.equal(r.status, 2);
    r = run(d, "--effort", "huge", "--role", "build");
    assert.equal(r.status, 2);

    const decided = events(d).filter((e) => e.type === "route_decided");
    assert.ok(decided.length >= 6);
    assert.equal(decided[0].subject, "P001");
    assert.ok(/kind=feature/.test(decided[0].reasons));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
