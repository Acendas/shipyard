/** v4.19 (owner): the plan is scored for parallel work, and a plan that is later or riskier than it has to be cannot become a sprint. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planScore, touchesOverlap, renderScore, planGateProblems } from "../bin/plan-score.mjs";
import { readMaxTasksPerWave, readMaxTasksPerWaveMerged } from "../bin/config-read.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
const BODY = "\n## Paths\n| Ending | Covered by |\n|---|---|\n| works | @AC-1 |\n\n## Acceptance Criteria\n```gherkin\n@AC-1 @e2e\nScenario: works\n  Given a\n  When b\n  Then c\n```\n";

function fixture(execution = "") {
  const base = mkdtempSync(join(tmpdir(), "planscore-"));
  const d = join(base, "projects", "abc123abc123");
  for (const sub of ["spec/steps", "spec/stories", "sprints/current", "sprints/next"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "config.md"), `---\nconfig_version: 5\nexecution:\n${execution}  overlap_waves: true\n---\n`);
  const step = (id, { deps = [], touches = null, story = "S001", effort = "S", kind = "feature" } = {}) =>
    writeFileSync(join(d, "spec/steps", `${id}-x.md`), `---\nid: "${id}"\ntype: step\nkind: ${kind}\nstory: ${story}\nstatus: approved\neffort: ${effort}\ndependencies: [${deps.join(", ")}]\n${touches ? `touches: [${touches.map((t) => JSON.stringify(t)).join(", ")}]\n` : ""}---\n`);
  const sprint = (waves, { mode = "task", stories = ["S001"], file = "sprints/current/SPRINT.md" } = {}) =>
    writeFileSync(join(d, file), `---\nid: sprint-007\nstatus: planned\nexecution_mode: ${mode}\nstories: [${stories.join(", ")}]\n---\n\n## Waves\n\n${waves.map((w, i) => `### Wave ${i + 1}\n${w.map((s) => `- ${s}`).join("\n")}\n`).join("\n")}`);
  const story = (id, status) => writeFileSync(join(d, "spec/stories", `${id}-x.md`), `---\nid: ${id}\ntitle: "Story ${id}"\ntype: feature\nstatus: ${status}\nstory_points: 2\n---\n${BODY}`);
  return { base, d, step, sprint, story };
}
const run = (d, ...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8" });

test("the score: steps, waves, the widest wave and the longest chain of steps that must wait for each other", () => {
  const f = fixture();
  try {
    f.step("P001", { touches: ["src/a.c"] }); f.step("P002", { touches: ["src/b.c"] }); f.step("P003", { touches: ["src/c.c"], effort: "M" });
    f.step("P004", { deps: ["P001"], touches: ["src/d.c"] }); f.step("P005", { deps: ["P004", "P003"], touches: ["src/e.c"] });
    f.sprint([["P001", "P002", "P003"], ["P004"], ["P005"]]);
    const s = planScore(f.d);
    assert.deepEqual([s.steps, s.wave_count, s.widest, s.depth, s.extra_waves], [5, 3, 3, 3, 0]);
    assert.deepEqual(s.chain, ["P001", "P004", "P005"]);
    assert.deepEqual(s.problems, []);
    assert.equal(s.recommended_mode, "task");
    const out = renderScore(s);
    assert.match(out, /^plan score: 5 steps in 3 waves · widest wave 3 · longest chain 3 \(P001 → P004 → P005\)/);
    assert.match(out, /wave  1 ███ 3/);
    assert.match(out, /3 waves are the fewest these dependencies allow/);
    const r = run(f.d, "sprint", "plan-score", "--check");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(run(f.d, "sprint", "plan-score", "--json").stdout).max_agents, 100);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("a step that sits later than its dependencies require is a problem, and so is one that waits for its own wave", () => {
  const f = fixture();
  try {
    f.step("P001", { touches: ["src/a.c"] }); f.step("P002", { touches: ["src/b.c"] }); f.step("P003", { deps: ["P001"], touches: ["src/c.c"] });
    f.sprint([["P001"], ["P002"], ["P003"]]); // P002 waits for nothing; P003 only for wave 1
    let s = planScore(f.d);
    assert.deepEqual(s.late.map((l) => [l.id, l.wave, l.earliest]), [["P002", 2, 1], ["P003", 3, 2]]);
    assert.equal(s.extra_waves, 1);
    assert.match(s.problems.join("\n"), /late: P002 is in wave 2 but it waits for nothing in this sprint: move it to wave 1, or add the step it really waits for/);
    assert.match(renderScore(s), /3 waves, but the dependencies need only 2: 1 wave could go/);
    const r = run(f.d, "sprint", "plan-score", "--check");
    assert.equal(r.status, 3); assert.match(r.stdout, /2 problems:/);
    // stating the real dependency makes the plan honest: the chain grows instead
    f.step("P002", { deps: ["P001"], touches: ["src/b.c"] }); f.step("P003", { deps: ["P002"], touches: ["src/c.c"] });
    s = planScore(f.d);
    assert.deepEqual([s.problems, s.depth, s.chain], [[], 3, ["P001", "P002", "P003"]]);
    f.step("P003", { deps: ["P002", "P001"], touches: ["src/c.c"] }); f.sprint([["P001", "P002", "P003"]]);
    assert.match(planScore(f.d).problems.join("\n"), /order: P002 \(wave 1\) depends on P001, which is in wave 1/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("two steps of one wave may not touch the same file; naming the part each changes, or making one wait, clears it", () => {
  const f = fixture();
  try {
    assert.equal(touchesOverlap("src/app.c", "src/app.c"), true);
    assert.equal(touchesOverlap("src/app.c#render queue", "src/app.c#input"), false);
    assert.equal(touchesOverlap("src/app.c#Render Queue", "src/app.c#render queue"), true);
    assert.equal(touchesOverlap("src/app.c", "src/app.c#input"), true, "a whole file overlaps any part of it");
    assert.equal(touchesOverlap("src/ui", "src/ui/hud.c"), true, "a folder overlaps a file inside it");
    assert.equal(touchesOverlap("src/a.c", "src/b.c"), false);
    f.step("P001", { touches: ["src/app.c", "tests/a.c"] }); f.step("P002", { touches: ["docs/x.md", "src/app.c"] }); f.step("P003");
    f.sprint([["P001", "P002", "P003"]]);
    let s = planScore(f.d);
    assert.deepEqual(s.overlaps, [{ wave: 1, a: "P001", b: "P002", path: "src/app.c" }]);
    assert.deepEqual(s.undeclared, ["P003"]);
    assert.match(s.problems.join("\n"), /overlap: P001 and P002 are both in wave 1 and both touch src\/app\.c/);
    assert.match(s.problems.join("\n"), /undeclared: P003 share a wave with other steps but name no `touches:`/);
    f.step("P001", { touches: ["src/app.c#render queue", "tests/a.c"] }); f.step("P002", { touches: ["docs/x.md", "src/app.c#input"] }); f.step("P003", { touches: ["src/c.c"] });
    assert.deepEqual(planScore(f.d).problems, []);
    // a step alone in its wave needs no list: nothing can collide with it
    f.step("P009"); f.sprint([["P009"]]);
    assert.deepEqual(planScore(f.d).problems, []);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("solo is for a plan with one step per wave: a wide wave with solo mode is a problem unless the project builds in place by choice", () => {
  const f = fixture();
  try {
    f.step("P001", { touches: ["a"] }); f.step("P002", { touches: ["b"] }); f.step("P003", { touches: ["c"] });
    f.sprint([["P001", "P002", "P003"]], { mode: "solo" });
    const s = planScore(f.d);
    assert.equal(s.recommended_mode, "task");
    assert.match(s.problems.join("\n"), /solo: execution_mode is solo, which builds one step at a time, but a wave has 3 steps that can run together/);
    f.sprint([["P001"]], { mode: "solo" });
    assert.deepEqual([planScore(f.d).problems, planScore(f.d).recommended_mode], [[], "solo"]);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
  const g = fixture("  isolation: none\n");
  try {
    g.step("P001", { touches: ["a"] }); g.step("P002", { touches: ["b"] });
    g.sprint([["P001", "P002"]], { mode: "solo" });
    assert.deepEqual(planScore(g.d).problems, [], "building in place is the owner's setting");
  } finally { rmSync(g.base, { recursive: true, force: true }); }
});

test("the gate: a story cannot enter a sprint whose plan has a problem; the owner can turn the gate off", () => {
  const f = fixture();
  try {
    f.story("S001", "approved"); f.story("S002", "approved");
    f.step("P001", { touches: ["src/a.c"] }); f.step("P002", { touches: ["src/a.c"] });
    f.sprint([["P001", "P002"]]);
    let r = run(f.d, "story", "set-status", "S001", "in-progress");
    assert.equal(r.status, 3, r.stdout);
    assert.match(r.stderr, /S001 cannot enter the sprint yet/); assert.match(r.stderr, /overlap: P001 and P002/); assert.match(r.stderr, /Fix the plan .* never the check/);
    // a story that is not in this sprint is not held by its plan
    assert.equal(run(f.d, "story", "set-status", "S002", "in-progress").status, 0);
    f.step("P002", { touches: ["src/b.c"] });
    r = run(f.d, "story", "set-status", "S001", "in-progress");
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
  const g = fixture("  parallel_plan: false\n");
  try {
    g.story("S001", "approved"); g.step("P001", { touches: ["src/a.c"] }); g.step("P002", { touches: ["src/a.c"] }); g.sprint([["P001", "P002"]]);
    assert.deepEqual(planGateProblems(g.d), []);
    assert.equal(run(g.d, "story", "set-status", "S001", "in-progress").status, 0);
    assert.equal(run(g.d, "sprint", "plan-score", "--check").status, 3, "the score still names the problem");
  } finally { rmSync(g.base, { recursive: true, force: true }); }
});

test("a wave is as wide as the agent limit: the old template caps of 6 and 12 are ignored, a chosen number is kept", () => {
  const cases = [["", 100, 100], ["  max_tasks_per_wave: 6\n  max_tasks_per_wave_merged: 12\n", 100, 100], ["  max_tasks_per_wave: 4\n", 4, 100], ["  max_agents: 20\n", 20, 20], ["  max_agents: 20\n  max_tasks_per_wave: 30\n  max_tasks_per_wave_merged: 8\n", 30, 30]];
  for (const [cfg, plain, merged] of cases) {
    const f = fixture(cfg);
    try { assert.deepEqual([readMaxTasksPerWave(f.d), readMaxTasksPerWaveMerged(f.d)], [plain, merged], JSON.stringify(cfg)); } finally { rmSync(f.base, { recursive: true, force: true }); }
  }
  const f = fixture("  max_agents: 2\n");
  try {
    for (const id of ["P001", "P002", "P003"]) f.step(id, { touches: [id] });
    f.sprint([["P001", "P002", "P003"]]);
    assert.match(planScore(f.d).problems.join("\n"), /too wide: wave 1 has 3 steps and at most 2 agents may be alive at once/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("the plan is read from the draft before the sprint exists, and from sprints/next for a sprint drafted ahead", () => {
  const f = fixture();
  try {
    f.step("P001", { touches: ["a"] }); f.step("P002", { touches: ["a"] });
    f.sprint([["P001", "P002"]], { file: "sprints/current/SPRINT-DRAFT.md" });
    assert.match(planScore(f.d).plan, /SPRINT-DRAFT\.md$/);
    assert.equal(planScore(f.d).overlaps.length, 1);
    f.sprint([["P001"], ["P002"]], { file: "sprints/next/SPRINT-DRAFT.md" });
    assert.deepEqual(planScore(f.d, { next: true }).late.map((l) => l.id), ["P002"]);
    assert.equal(run(f.d, "sprint", "plan-score", "--next", "--check").status, 3);
    assert.equal(run(f.d, "sprint", "plan-score", "--bogus").status, 2);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
