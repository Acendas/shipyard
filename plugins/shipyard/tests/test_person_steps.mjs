/** v4.0 (owner): a person is needed at the start or at the end of a sprint, never in the middle; the progress line says when. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planScore, renderScore } from "../bin/plan-score.mjs";
import { needsYou, personFields } from "../bin/person-steps.mjs";
import { evaluateExecuteTerminal } from "../bin/terminal-gate.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "person-"));
  const d = join(base, "projects", "abc123abc123");
  for (const sub of ["spec/steps", "spec/stories", "sprints/current"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "config.md"), "---\nconfig_version: 5\nexecution:\n  overlap_waves: true\n---\n");
  const step = (id, { deps = [], touches = [id + ".c"], person = "", status = "approved", kind = "feature" } = {}) =>
    writeFileSync(join(d, "spec/steps", `${id}-x.md`), `---\nid: "${id}"\ntype: step\nkind: ${kind}\nstory: S001\nstatus: ${status}\neffort: S\ndependencies: [${deps.join(", ")}]\ntouches: [${touches.join(", ")}]\n${person}---\n`);
  const sprint = (waves) => writeFileSync(join(d, "sprints/current/SPRINT.md"), `---\nid: sprint-007\nstatus: in-progress\nexecution_mode: task\nstories: [S001]\n---\n\n## Waves\n\n${waves.map((w, i) => `### Wave ${i + 1}\n${w.map((s) => `- ${s}`).join("\n")}\n`).join("\n")}`);
  const story = (probe) => writeFileSync(join(d, "spec/stories", "S001-x.md"), `---\nid: S001\ntitle: "Story"\ntype: feature\nstatus: in-progress\nstory_points: 2\n${probe}---\n`);
  return { base, d, step, sprint, story };
}
const BEFORE = 'needs_person: before\nperson_task: "run the speed test on both devices"\nperson_minutes: 10\n';
const AFTER = 'needs_person: after\nperson_task: "look at the border on a client device"\nperson_where: "phone"\n';
const run = (d, ...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8" });

test("a step that needs a person before the build belongs in the first wave; the plan says what it needs from the person", () => {
  const f = fixture();
  try {
    f.story('user_flow_probe:\n  kind: assisted\n  command: "make look"\n');
    f.step("P001", { person: BEFORE, touches: [] }); f.step("P002"); f.step("P003", { deps: ["P001"] }); f.step("P004", { deps: ["P003"], person: AFTER, touches: [] });
    f.sprint([["P001", "P002"], ["P003"], ["P004"]]);
    const s = planScore(f.d);
    assert.deepEqual(s.problems, []);
    assert.equal(s.person.line, "you: 1 thing at the start (about 10 min): P001 run the speed test on both devices · 2 checks at the end");
    assert.match(renderScore(s), /\n  you: 1 thing at the start \(about 10 min\)/);
    assert.match(run(f.d, "sprint", "plan-score").stdout, /you: 1 thing at the start/);
    // the same step in the middle of the sprint is refused
    f.step("P001", { person: BEFORE, touches: [], deps: ["P002"] }); f.sprint([["P002"], ["P001"], ["P003"], ["P004"]]);
    assert.match(planScore(f.d).problems.join("\n"), /person: P001 needs a person before the build but is in wave 2: put it in wave 1/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("nothing may wait for a check the person does at the end; such a check is never 'late'; the task line is required", () => {
  const f = fixture();
  try {
    f.story("");
    f.step("P001"); f.step("P002", { person: AFTER, touches: [] }); f.step("P003", { deps: ["P002"] });
    f.sprint([["P001", "P002"], ["P003"]]);
    assert.match(planScore(f.d).problems.join("\n"), /person: P003 waits for P002, which a person does at the end of the sprint: a check at the end cannot hold up building/);
    // listed in the last wave with nothing to wait for: fine, and not "late"
    f.step("P003", { deps: ["P001"] }); f.sprint([["P001"], ["P003"], ["P002"]]);
    assert.deepEqual(planScore(f.d).problems, []);
    f.step("P002", { person: "needs_person: after\n", touches: [] });
    assert.match(planScore(f.d).problems.join("\n"), /person: P002 needs a person but has no `person_task:`/);
    f.step("P002", { person: 'needs_person: sometimes\nperson_task: "x"\n', touches: [] });
    assert.match(planScore(f.d).problems.join("\n"), /person: P002 has needs_person "sometimes"; write before/);
    assert.deepEqual(personFields("---\nneeds_person: After\nperson_task: 'look'\n---\n").needs, "after");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("needs-you: needed now while a start item is open or the sprint is paused; otherwise not until the review, with the count", () => {
  const f = fixture();
  try {
    f.story('user_flow_probe:\n  kind: manual\n');
    f.step("P001", { person: BEFORE, touches: [] }); f.step("P002"); f.step("P003", { person: AFTER, touches: [] });
    f.sprint([["P001", "P002"], ["P003"]]);
    let r = needsYou(f.d);
    assert.deepEqual([r.now, r.phrase], [true, "you: needed now · P001 run the speed test on both devices"]);
    f.step("P001", { person: BEFORE, touches: [], status: "done" });
    r = needsYou(f.d);
    assert.deepEqual([r.now, r.phrase, r.at_review], [false, "you: not needed until the review (2 checks)", 2]);
    const out = run(f.d, "sprint", "needs-you").stdout;
    assert.match(out, /^you: not needed until the review \(2 checks\)\n  at the review, phone: P003 look at the border on a client device\n  at the review, story checks: S001/);
    writeFileSync(join(f.d, "sprints/current/EXECUTE-CURSOR.md"), '---\npipeline: ship-execute\nstage: wave_2_build\nstatus: paused\nnote: "awaiting user: the device is off"\n---\n');
    assert.match(needsYou(f.d).phrase, /^you: needed now · the sprint is paused: awaiting user: the device is off/);
    assert.equal(run(f.d, "sprint", "needs-you", "--bogus").status, 2);
    assert.equal(JSON.parse(run(f.d, "sprint", "needs-you", "--json").stdout).now, true);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("a step waiting for the person at the review does not count as a parked step at the end of the build", () => {
  const f = fixture();
  try {
    f.story("");
    f.step("P001", { status: "done" }); f.step("P002", { status: "blocked" });
    f.sprint([["P001"], ["P002"]]);
    const ev = (o, t) => JSON.stringify({ ts: `2026-11-14T10:${String(t).padStart(2, "0")}:00Z`, ...o });
    writeFileSync(join(f.d, ".shipyard-events.jsonl"), [
      ev({ type: "task_dispatch_returned", pipeline: "ship-execute", sprint: "sprint-007", task: "P001", status: "complete" }, 1),
      ev({ type: "task_blocked", task: "P002", reason: "waiting_for_person" }, 2),
    ].join("\n") + "\n");
    const parkedReason = () => evaluateExecuteTerminal({ dataDir: f.d }).reasons.filter((x) => /Parked ratio/.test(x));
    assert.equal(parkedReason().length, 1, "an ordinary blocked step: 1 of 2 parked is over the limit");
    f.step("P002", { status: "blocked", person: AFTER, touches: [] });
    assert.deepEqual(parkedReason(), [], "the plan gave it to the person at the end: not a failure to finish");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("a built step still waits for the person's own check until their answer is recorded (4.0, seen live)", () => {
  const f = fixture();
  try {
    f.story("");
    f.step("P001", { status: "done" }); f.step("P002", { status: "done", person: AFTER });
    f.sprint([["P001", "P002"]]);
    let r = run(f.d, "sprint", "needs-you");
    assert.match(r.stdout, /you: not needed until the review \(1 check\)/);
    assert.match(r.stdout, /at the review, phone: P002 look at the border on a client device/);
    r = run(f.d, "sprint", "person-check", "P002");
    assert.equal(r.status, 2, "no answer, nothing recorded");
    assert.match(r.stderr, /the person's own words are required/);
    assert.equal(run(f.d, "sprint", "person-check", "P001", "--answer", "yes").status, 3, "P001 has no check of the person's");
    r = run(f.d, "sprint", "person-check", "P002", "--answer", "yes, the border shows on the client");
    assert.equal(r.status, 0, r.stderr);
    const text = readFileSync(join(f.d, "spec/steps", "P002-x.md"), "utf8");
    assert.match(text, /^person_done: \d{4}-\d\d-\d\d$/m);
    assert.match(text, /^person_answer: "yes, the border shows on the client"$/m);
    assert.match(text, /^status: done$/m, "the build status is not touched");
    assert.equal(run(f.d, "sprint", "needs-you").stdout.trim(), "you: not needed until the review");
    assert.match(readFileSync(join(f.d, ".shipyard-events.jsonl"), "utf8"), /"type":"person_check_recorded"[^\n]*"step":"P002"[^\n]*"verdict":"done"/);
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});

test("a check left open at the review survives the archive: still listed, still recordable (4.0, seen live)", () => {
  const f = fixture();
  try {
    f.story("");
    f.step("P001", { status: "done", person: AFTER });
    f.sprint([["P001"]]);
    // the sprint is archived: its step moves to spec/archive/tasks and the sprint folder is emptied
    mkdirSync(join(f.d, "spec/archive/tasks"), { recursive: true });
    renameSync(join(f.d, "spec/steps", "P001-x.md"), join(f.d, "spec/archive/tasks", "P001-x.md"));
    rmSync(join(f.d, "sprints/current/SPRINT.md"));
    let r = run(f.d, "sprint", "needs-you");
    assert.match(r.stdout, /you: no sprint is running · 1 check still open from earlier sprints/);
    assert.match(r.stdout, /still yours from an earlier sprint: P001 look at the border on a client device \(phone\)/);
    r = run(f.d, "sprint", "person-check", "P001", "--answer", "the build is good");
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(f.d, "spec/archive/tasks", "P001-x.md"), "utf8"), /^person_answer: "the build is good"$/m);
    assert.equal(run(f.d, "sprint", "needs-you").stdout.trim(), "you: no sprint is running");
  } finally { rmSync(f.base, { recursive: true, force: true }); }
});
