/** v4.21: a step's probe must fail on today's code, or say why a pass is right. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readStepProbe, probeProblems, RECORD_BASENAME } from "../bin/probes-at-base.mjs";
import { planGateProblems } from "../bin/plan-score.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
const BODY = "\n## Paths\n| Ending | Covered by |\n|---|---|\n| works | @AC-1 |\n\n## Acceptance Criteria\n```gherkin\n@AC-1 @e2e\nScenario: works\n  Given a\n  When b\n  Then c\n```\n";

function fixture(execution = "") {
  const base = mkdtempSync(join(tmpdir(), "probes-"));
  const repo = join(base, "repo");
  const d = join(base, "projects", "abc123abc123");
  for (const sub of ["spec/steps", "spec/stories", "sprints/current"]) mkdirSync(join(d, sub), { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "done.txt"), "already here\n");
  writeFileSync(join(d, ".project-root"), repo + "\n");
  writeFileSync(join(d, "config.md"), `---\nconfig_version: 5\nexecution:\n${execution}  overlap_waves: true\n---\n`);
  const step = (id, probe, extra = "") => writeFileSync(join(d, "spec/steps", `${id}-x.md`), `---\nid: "${id}"\ntype: step\nkind: feature\nstory: S001\nstatus: approved\neffort: S\ndependencies: []\ntouches: [${id}.c]\n${extra}acceptance_probe: |\n  ${probe}\n---\n`);
  const sprint = (ids) => writeFileSync(join(d, "sprints/current/SPRINT.md"), `---\nid: sprint-007\nstatus: planned\nexecution_mode: task\nstories: [S001]\n---\n\n## Waves\n\n### Wave 1\n${ids.map((s) => `- ${s}`).join("\n")}\n`);
  writeFileSync(join(d, "spec/stories", "S001-x.md"), `---\nid: S001\ntitle: "Story"\ntype: feature\nstatus: approved\nstory_points: 2\n---\n${BODY}`);
  return { base, d, repo, step, sprint };
}
const run = (f, ...args) => spawnSync("node", [CLI, ...args, "--data-dir", f.d], { encoding: "utf8", cwd: f.repo, env: { ...process.env, CLAUDE_PROJECT_DIR: f.repo } });

test("readStepProbe: a block, a quoted line, a bare line, none", () => {
  assert.equal(readStepProbe("---\nid: P1\nacceptance_probe: |\n  cd x && make t\n  ./t\nstatus: a\n---\n"), "cd x && make t\n./t");
  assert.equal(readStepProbe("---\nacceptance_probe: 'node -e ''x'''\n---\n"), "node -e 'x'");
  assert.equal(readStepProbe('---\nacceptance_probe: "test -f a.txt"\n---\n'), "test -f a.txt");
  assert.equal(readStepProbe("---\nacceptance_probe: test -f a.txt   # must exist\n---\n"), "test -f a.txt");
  assert.equal(readStepProbe("---\nid: x\n# acceptance_probe: |\n#   nope\n---\n"), null);
});

test("a probe that already passes is refused; one that fails first is fine; a stated reason allows a pass", () => {
  const f = fixture();
  try {
    f.step("P001", "test -f new-feature.txt"); f.step("P002", "test -f done.txt"); f.step("P003", "test -f done.txt", 'probe_passes_at_base: "pure refactor; the existing check must stay green"\n');
    f.sprint(["P001", "P002", "P003"]);
    // before any run: the gate names what has not been run
    assert.match(planGateProblems(f.d).join("\n"), /probe: P001, P002, P003 have probes that have not been run on the code as it is today/);
    let r = run(f, "sprint", "probes-at-base");
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stdout, /probes on today's code: 1 of 3 fail first, 2 already pass/);
    assert.match(r.stdout, /✗ P002 already passes: it would prove nothing/);
    assert.match(r.stdout, /• P003 passes by intent: pure refactor/);
    const rec = JSON.parse(readFileSync(join(f.d, "sprints/current", RECORD_BASENAME), "utf8"));
    assert.deepEqual(Object.fromEntries(Object.entries(rec.steps).map(([k, v]) => [k, v.exit])), { P001: 1, P002: 0, P003: 0 });
    assert.deepEqual(probeProblems(f.d).length, 1);
    assert.match(probeProblems(f.d)[0], /probe: P002's probe already passes on the code as it is today/);
    // the story cannot enter the sprint
    r = run(f, "story", "set-status", "S001", "in-progress");
    assert.equal(r.status, 3); assert.match(r.stderr, /P002's probe already passes/);
    // the planner rewrites the probe: a changed probe must be run again, then the plan is clean
    f.step("P002", "test -f other-new.txt");
    assert.match(probeProblems(f.d).join("\n"), /P002 has a probe that has not been run/);
    r = run(f, "sprint", "probes-at-base", "--json");
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.steps.map((s) => [s.id, s.exit, s.reused]), [["P001", 1, true], ["P002", 1, false], ["P003", 0, true]], "unchanged probes are not run again");
    assert.deepEqual(probeProblems(f.d), []);
    assert.equal(run(f, "story", "set-status", "S001", "in-progress").status, 0);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("a probe that hangs is cut off and counts as not passing; the owner can turn the rule off", () => {
  const f = fixture();
  try {
    f.step("P001", "sleep 30"); f.sprint(["P001"]);
    const r = run(f, "sprint", "probes-at-base", "--timeout", "5", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).steps.map((s) => [s.id, s.timed_out]), [["P001", true]]);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
  const g = fixture("  probe_must_fail_first: false\n");
  try {
    g.step("P001", "test -f done.txt"); g.sprint(["P001"]);
    assert.deepEqual(planGateProblems(g.d), []);
    assert.equal(run(g, "sprint", "probes-at-base").status, 3, "the command still reports it");
    assert.equal(run(g, "sprint", "probes-at-base", "--bogus").status, 2);
  } finally { rmSync(g.base, { recursive: true, force: true }); }
});

test("a step with no probe, or a step that is not a feature, is not this check's business", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.d, "spec/steps", "P001-x.md"), `---\nid: "P001"\ntype: step\nkind: operational\nstory: S001\nstatus: approved\nverify_command: "make test"\nacceptance_probe: |\n  true\n---\n`);
    writeFileSync(join(f.d, "spec/steps", "P002-x.md"), `---\nid: "P002"\ntype: step\nkind: feature\nstory: S001\nstatus: approved\ntouches: [a.c]\n---\n`);
    f.sprint(["P001", "P002"]);
    assert.deepEqual(probeProblems(f.d), []);
    assert.ok(!existsSync(join(f.d, "sprints/current", RECORD_BASENAME)));
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
