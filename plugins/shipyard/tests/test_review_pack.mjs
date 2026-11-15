/** 4.6: code review recorded inside execute (story-review --code), the sprint_code_review stage, and the review facts pack. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewPack, renderReviewPack, renderReviewDocument, checkReviewDocument, REVIEW_SECTIONS } from "../bin/review-pack.mjs";
import { validateTransition } from "../bin/pipeline-stages.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function fixture(extraConfig = "") {
  const base = mkdtempSync(join(tmpdir(), "rpack-"));
  const d = join(base, "projects", "abc123abc123");
  for (const sub of ["templates", "spec/stories", "spec/steps", "spec/ideas", "sprints/current", "memory"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "config.md"), `---\nconfig_version: 5\n${extraConfig}---\n`);
  writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-006\nstatus: in-progress\ngoal: \"Ship the HUD\"\ncapacity: 24\nexecution_mode: task\nstories: [S001, S002]\n---\n\n## Waves\n\n### Wave 1\n- P001\n- P002\n");
  const story = (id, status, pts) => writeFileSync(join(d, "spec/stories", `${id}-x.md`), `---\nid: ${id}\ntitle: "Story ${id}"\ntype: feature\nstatus: ${status}\nstory_points: ${pts}\nsteps: []\n---\n\n@AC-1\n@AC-2\n`);
  story("S001", "done", 5); story("S002", "in-progress", 3);
  const step = (id, s, st, extra = "") => writeFileSync(join(d, "spec/steps", `${id}-x.md`), `---\nid: "${id}"\ntitle: "Step ${id}"\ntype: step\nkind: feature\nstory: ${s}\nstatus: ${st}\n${extra}---\n`);
  step("P001", "S001", "done"); step("P002", "S002", "needs-attention", 'attention_reason: "persistent_failure"\n'); step("P003", "S001", "done");
  writeFileSync(join(d, "spec/ideas", "IDEA-020-later.md"), "---\nid: IDEA-020\ntitle: \"Found, not done\"\nstatus: captured\ncreated: 2026-11-13\n---\n");
  const ev = (o, t) => JSON.stringify({ ts: `2026-11-13T10:${String(t).padStart(2, "0")}:00Z`, ...o });
  writeFileSync(join(d, ".shipyard-events.jsonl"), [
    ev({ type: "pipeline_tick_started", pipeline: "ship-execute", sprint: "sprint-006", stage: "wave_1_dispatch" }, 0),
    ev({ type: "worker_queue_claimed", pipeline: "ship-execute", stage: "wave_1_dispatch", worker: "builder-P001", task: "P001" }, 1),
    ev({ type: "dispatch_attempt", pipeline: "ship-execute", sprint: "sprint-006", subject: "P001", mode: "warm" }, 5),
    ev({ type: "patch_step_created", sprint: "sprint-006", step: "P003", feature: "S001", source: "story-review" }, 8),
    ev({ type: "execute_decision", stage: "wave_1_boundary", subject: "S001", source: "rule", decision: "2 findings → patch step P003", rationale: "touches AC-2" }, 9),
    ev({ type: "story_reviewed", story: "S001", sprint: "sprint-006", verdict: "changes", spec: "PASS", gaps: 1, code: "FINDINGS", code_findings: 2 }, 10),
    ev({ type: "story_review_dispositioned", story: "S001", sprint: "sprint-006", via: "patch_steps", ids: "P003" }, 11),
    ev({ type: "acceptance_probe_completed", feature: "S002", probe_type: "demo", exit_code: 0, verdict: "PENDING_HUMAN" }, 12),
    ev({ type: "pipeline_tick_completed", pipeline: "ship-execute", sprint: "sprint-006", stage: "wave_1_gate" }, 20),
  ].join("\n") + "\n");
  return { base, d };
}
const cli = (d, ...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8" });

test("story-review record needs the code-review result while execution.code_review is on; off restores the old record", () => {
  const { base, d } = fixture();
  try {
    let r = cli(d, "story-review", "record", "S001", "--verdict", "approve", "--spec", "PASS", "--gaps", "0");
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /no code-review result/);
    r = cli(d, "story-review", "record", "S001", "--verdict", "approve", "--code", "FINDINGS");
    assert.equal(r.status, 2, "findings cannot be approved");
    r = cli(d, "story-review", "record", "S001", "--verdict", "approve", "--spec", "PASS", "--gaps", "0", "--code", "CLEAN");
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(base, { recursive: true, force: true }); }
  const off = fixture("execution:\n  code_review: false\n");
  try {
    assert.equal(cli(off.d, "story-review", "record", "S001", "--verdict", "approve").status, 0);
  } finally { rmSync(off.base, { recursive: true, force: true }); }
});

test("sprint_code_review is a legal execute stage between the last wave gate and the refactor/full build, and self-loops for fixes", () => {
  const ok = (a, b) => assert.equal(validateTransition("ship-execute", a, b).ok, true, `${a} → ${b}`);
  ok("wave_3_gate", "sprint_code_review");
  ok("sprint_code_review", "sprint_code_review");
  ok("sprint_code_review", "sprint_refactor");
  ok("sprint_code_review", "sprint_full_build");
  ok("wave_3_gate", "sprint_refactor"); // single-story sprints skip it
  assert.equal(validateTransition("ship-execute", "sprint_full_tests", "sprint_code_review").ok, false);
});

test("review-pack: outcome, evidence, quality, decisions, effort and not-done come from the log and the spec files", () => {
  const { base, d } = fixture();
  try {
    const p = buildReviewPack(d);
    assert.equal(p.sprint.id, "sprint-006");
    assert.deepEqual([p.outcome.stories_planned, p.outcome.stories_delivered, p.outcome.points_planned, p.outcome.points_delivered], [2, 1, 8, 5]);
    // built and reviewed counts a settled story that is not accepted yet (4.13.2)
    assert.deepEqual([p.outcome.stories_ready, p.outcome.points_ready], [1, 5]);
    {
      // at review time a settled story is still in-progress: built and reviewed 1, accepted 0
      const f = join(d, "spec/stories", readdirSync(join(d, "spec/stories")).find((n) => n.startsWith("S001")));
      const before = readFileSync(f, "utf8");
      writeFileSync(f, before.replace(/^status: done$/m, "status: in-progress"));
      const q = buildReviewPack(d);
      assert.deepEqual([q.outcome.stories_ready, q.outcome.points_ready, q.outcome.stories_delivered], [1, 5, 0]);
      writeFileSync(f, before);
    }
    assert.match(renderReviewPack(p), /\| Measure \| Planned \| Built and reviewed \| Accepted \(done\) \|/);
    assert.deepEqual([p.outcome.steps_planned, p.outcome.steps_added, p.outcome.steps_parked, p.outcome.steps_done, p.outcome.steps_total], [2, 1, 1, 2, 3]);
    const s1 = p.stories.find((s) => s.id === "S001");
    assert.deepEqual(s1.review, { verdict: "changes", spec: "PASS", gaps: 1, code: "FINDINGS", code_findings: 2, design: "", design_findings: 0, disposition: "patch_steps" });
    assert.equal(s1.scenarios, 2);
    assert.equal(p.quality.code_findings, 2);
    assert.equal(p.quality.patch_steps, 1);
    assert.deepEqual(p.quality.dispositions, { patch_steps: 1 });
    assert.equal(p.decisions.length, 1);
    assert.deepEqual(p.decisions_by_source, { rule: 1 });
    assert.equal(p.effort.builder_dispatches, 1);
    assert.equal(p.effort.warm_fixes, 1);
    assert.equal(p.effort.waves[0].minutes, 20);
    assert.deepEqual(p.not_done.stories.map((s) => s.id), ["S002"]);
    assert.equal(p.not_done.parked_steps[0].reason, "persistent_failure");
    assert.deepEqual(p.not_done.ideas_captured.map((i) => i.id), ["IDEA-020"]);
    assert.deepEqual(p.not_done.pending_human_probes, ["S002"]);
    const md = renderReviewPack(p);
    for (const h of ["## Outcome", "## Stories and their evidence", "## Quality work done during the sprint", "## Decisions made without asking", "## Effort", "## Not done, and found but not done"]) assert.ok(md.includes(h), h);
    assert.match(md, /FINDINGS \(2\)/);
    const r = cli(d, "review-pack", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).outcome.points_delivered, 5);
    assert.equal(cli(d, "review-pack", "--sprint", "sprint-999").status, 3);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the sprint review is one CLI-written document: twelve sections, facts in place, FILL markers for the rest, and it cannot be shown until they are filled", () => {
  const { base, d } = fixture();
  try {
    const doc = renderReviewDocument(buildReviewPack(d));
    for (let n = 1; n <= 12; n++) assert.match(doc, new RegExp(`^## ${n}\\. ${REVIEW_SECTIONS[n - 1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    assert.match(doc, /\| Points per hour \| /);
    assert.match(doc, /\| Steps finished by model \| /);
    assert.match(doc, /\| S001 \| rule \| 2 findings → patch step P003 \| touches AC-2 \|/, "every decision is in the table, not a count");
    assert.match(doc, /IDEA-020 Found, not done — not triaged/);
    assert.match(doc, /Step P002 parked: persistent_failure/);
    const open = checkReviewDocument(doc);
    assert.ok(open.length >= 6, open.join("; "));
    assert.ok(open.some((x) => /section 10 \(What went well, what did not\) still has a FILL marker/.test(x)));
    // the CLI: write, refuse to show, fill, show
    let r = cli(d, "review-pack", "--write");
    assert.equal(r.status, 0, r.stderr);
    const path = join(d, "sprints/current/REVIEW-PACK.md");
    assert.equal(readFileSync(path, "utf8"), doc);
    r = cli(d, "review-pack", "check");
    assert.equal(r.status, 3); assert.match(r.stderr, /not ready to show \(\d+\)/); assert.match(r.stderr, /section 12 \(Next\)/);
    writeFileSync(path, doc.replace(/<!-- FILL: [^>]*? -->/g, "Written by the reviewer."));
    r = cli(d, "review-pack", "check");
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /all 12 sections are written/);
    assert.equal(cli(d, "review-pack", "--write").status, 3, "a finished review is not overwritten by accident");
    assert.equal(cli(d, "review-pack", "--write", "--force").status, 0);
    // a section deleted by hand is caught too
    writeFileSync(path, readFileSync(path, "utf8").replace(/<!-- FILL: [^>]*? -->/g, "x").replace(/^## 11\. .*$/m, ""));
    r = cli(d, "review-pack", "check");
    assert.equal(r.status, 3); assert.match(r.stderr, /section 11 \(What to improve: proposed actions\) is missing/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a human look is recorded only with that person's answer, and can be taken back; the pack follows the later of the two", () => {
  const { base, d } = fixture();
  try {
    writeFileSync(join(d, "spec/stories/S002-x.md"), "---\nid: S002\ntitle: \"Story S002\"\ntype: feature\nstatus: in-progress\nstory_points: 3\nsteps: []\nuser_flow_probe:\n  kind: assisted\n  steps: \"look at the HUD on the device\"\n---\n");
    let r = cli(d, "story", "record-proof", "S002", "verdict=pass", "confirmed-by=owner", "commit=abc1234");
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /Accepting the sprint, or silence, is not a confirmation/);
    r = cli(d, "story", "record-proof", "S002", "verdict=pass", "confirmed-by=owner", "commit=abc1234", "answer=yes, the HUD reads fine on the .76 panel");
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(d, ".shipyard-events.jsonl"), "utf8"), /"user_flow_probe_confirmed"[^\n]*"answer":"yes, the HUD reads fine on the \.76 panel"/);
    // the pack reads the sprint's own window: an event of the sprint after the look closes it
    const tick = () => cli(d, "events", "emit", "pipeline_tick_started", "pipeline=ship-review", "sprint=sprint-006", "stage=demo_user");
    const user = () => { tick(); return buildReviewPack(d).stories.find((s) => s.id === "S002").user_flow; };
    assert.match(user(), /confirmed by a person/);
    r = cli(d, "story", "retract-proof", "S002", "reason=recorded from a sprint acceptance; nobody looked at the device");
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(user(), /confirmed by a person/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("a sprint built in place counts its builder runs, and a sprint drafted ahead starts its clock when work starts (4.17.2)", () => {
  const { base, d } = fixture();
  try {
    const ev = (o, hh, mm) => JSON.stringify({ ts: `2026-11-13T${hh}:${String(mm).padStart(2, "0")}:00Z`, ...o });
    writeFileSync(join(d, ".shipyard-events.jsonl"), [
      ev({ type: "next_sprint_queued", sprint: "sprint-006", behind: "sprint-005" }, "09", 0),
      ev({ type: "pipeline_tick_completed", pipeline: "ship-review", sprint: "sprint-005", stage: "demo_user" }, "09", 10),
      ev({ type: "patch_step_created", sprint: "sprint-005", step: "P900", source: "story-review" }, "09", 11),
      ev({ type: "next_sprint_promoted", sprint: "sprint-006" }, "09", 20),
      ev({ type: "pipeline_tick_started", pipeline: "ship-execute", sprint: "sprint-006", stage: "wave_1_dispatch" }, "10", 0),
      ev({ type: "agent_spawned", agent: "builder-P001", step: "P001", wave: "1" }, "10", 1),
      ev({ type: "agent_spawned", agent: "builder-P001", purpose: "Build step P001", via: "hook" }, "10", 1),
      ev({ type: "agent_spawned", agent: "spec-review-S001", step: "", wave: "1" }, "10", 6),
      ev({ type: "task_return_recorded", task: "P001", status: "complete" }, "10", 5),
      ev({ type: "agent_spawned", agent: "builder-P002", step: "P002", wave: "1" }, "10", 7),
      ev({ type: "task_return_recorded", task: "P002", status: "complete" }, "10", 12),
      ev({ type: "story_reviewed", story: "S002", sprint: "sprint-006", verdict: "approve", spec: "PASS", gaps: 0, code: "CLEAN" }, "10", 15),
      ev({ type: "pipeline_tick_completed", pipeline: "ship-execute", sprint: "sprint-006", stage: "wave_1_gate" }, "10", 20),
    ].join("\n") + "\n");
    assert.match(renderReviewDocument(buildReviewPack(d)), /stays `in-progress` until you accept the sprint/, "said as a fact, so the reviewer does not report it as a tooling bug");
    const j = JSON.parse(cli(d, "review-pack", "--json").stdout);
    assert.equal(j.effort.builder_dispatches, 2, "two builders were spawned for a step; the reviewer and the hook's echo are not builder runs");
    assert.equal(j.effort.span_minutes, 20, "the clock runs 10:00 to 10:20, not from 09:00 when the sprint was queued behind sprint-005");
    assert.equal(j.outcome.steps_added ?? j.quality.patch_steps, 0, "the previous sprint's fix step is not counted in this one");
    assert.match(cli(d, "patch-budget").stdout, /0 used/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the review lists the sprint's planned quality gates and will not be shown until each has a result (4.0)", () => {
  const { base, d } = fixture();
  try {
    writeFileSync(join(d, "sprints/current/QUALITY-GATE.md"), "---\nsprint: sprint-006\n---\n\n## Standing Gates\n\nNone configured.\n\n## Sprint-Specific Gates\n\n| # | Gate | Source | verification_type | Command |\n|---|---|---|---|---|\n| 1 | Full suite green | all | probe | `make test` |\n| 2 | Owner looks at the HUD on the device | S001 | manual | human-only |\n");
    const pack = buildReviewPack(d);
    assert.deepEqual(pack.quality_gates.map((g) => [g.n, g.type, g.section]), [["1", "probe", "Sprint-Specific Gates"], ["2", "manual", "Sprint-Specific Gates"]]);
    const doc = renderReviewDocument(pack);
    assert.match(doc, /Quality gates planned for this sprint:/);
    assert.match(doc, /\| 1 \| Full suite green \| a command \| `make test` \|/);
    assert.match(doc, /\| 2 \| Owner looks at the HUD on the device \| a person \|/);
    const partly = doc.replace(/<!-- FILL: before and after[^>]*? -->/, "Before and after written.");
    assert.ok(checkReviewDocument(partly).some((x) => /section 3 .*for each quality gate above/.test(x)), "the gates' results are a marker the reviewer must fill");
    // a sprint with no gate file says nothing about gates
    rmSync(join(d, "sprints/current/QUALITY-GATE.md"));
    assert.doesNotMatch(renderReviewDocument(buildReviewPack(d)), /Quality gates planned/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the review shows how long build and test runs took, and says when no affected-tests command is set (4.0)", () => {
  const { base, d } = fixture();
  try {
    const ev = (o, mm) => JSON.stringify({ ts: `2026-11-13T10:${String(mm).padStart(2, "0")}:00Z`, ...o });
    writeFileSync(join(d, ".shipyard-events.jsonl"), [
      ev({ type: "pipeline_tick_started", pipeline: "ship-execute", sprint: "sprint-006", stage: "wave_1_dispatch" }, 0),
      ev({ type: "agent_spawned", agent: "builder-P001", step: "P001", wave: "1" }, 1),
      ev({ type: "task_return_recorded", task: "P001", status: "complete" }, 9),
      ev({ type: "command_run", name: "wave1-build-run-1", exit: 0, seconds: 30, command: "make" }, 10),
      ev({ type: "command_run", name: "wave1-tests-run-1", exit: 2, seconds: 420, command: "make -k test" }, 17),
      ev({ type: "command_run", name: "wave1-tests-run-2", exit: 0, seconds: 510, command: "make -k test" }, 26),
      ev({ type: "pipeline_tick_completed", pipeline: "ship-execute", sprint: "sprint-006", stage: "wave_1_gate" }, 30),
    ].join("\n") + "\n");
    const j = JSON.parse(cli(d, "review-pack", "--json").stdout);
    assert.deepEqual({ count: j.effort.command_runs.count, minutes: j.effort.command_runs.minutes, failed: j.effort.command_runs.failed }, { count: 3, minutes: 16, failed: 1 });
    assert.equal(j.effort.command_runs.wall_minutes, 16, "the three runs did not overlap, so clock time equals the sum");
    assert.equal(j.effort.command_runs.longest[0].name, "wave1-tests-run-2");
    const doc = renderReviewDocument(buildReviewPack(d));
    assert.match(doc, /Build and test runs \| 3 runs, a run was going for 16 min \(\d+% of active time\), 1 red; longest: wave1-tests-run-2 8\.5 min/);
    assert.match(doc, /No affected-tests command is set \(`test_commands\.scoped`\), so every wave ran the whole suite/);
    // with a scoped command the hint is gone
    writeFileSync(join(d, "config.md"), "---\nconfig_version: 5\ntest_commands:\n  scoped: \"make test-changed\"\n---\n");
    assert.doesNotMatch(renderReviewDocument(buildReviewPack(d)), /No affected-tests command/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("build and test time is clock time: runs that overlap are not counted twice (4.0)", () => {
  const { base, d } = fixture();
  try {
    const ev = (o, mm, ss = 0) => JSON.stringify({ ts: `2026-11-13T10:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}Z`, ...o });
    writeFileSync(join(d, ".shipyard-events.jsonl"), [
      ev({ type: "pipeline_tick_started", pipeline: "ship-execute", sprint: "sprint-006", stage: "wave_1_dispatch" }, 0),
      ev({ type: "agent_spawned", agent: "builder-P001", step: "P001", wave: "1" }, 1),
      ev({ type: "command_run", name: "P001-probe", exit: 0, seconds: 300, command: "make a" }, 10),
      ev({ type: "command_run", name: "P002-probe", exit: 0, seconds: 300, command: "make b" }, 10),
      ev({ type: "task_return_recorded", task: "P001", status: "complete" }, 11),
      ev({ type: "pipeline_tick_completed", pipeline: "ship-execute", sprint: "sprint-006", stage: "wave_1_gate" }, 20),
    ].join("\n") + "\n");
    const j = JSON.parse(cli(d, "review-pack", "--json").stdout);
    assert.equal(j.effort.command_runs.minutes, 10);
    assert.equal(j.effort.command_runs.wall_minutes, 5);
    assert.match(renderReviewDocument(buildReviewPack(d)), /2 runs, a run was going for 5 min \(\d+% of active time\); 10 run-minutes in all, because builders run side by side/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
