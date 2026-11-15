/** F028: per-story review records and the settled rule. Run: node --test tests/test_story_review.mjs */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { storySettled, computeStoryReviewStatus } from "../bin/story-review.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

test("storySettled: approve settles; changes settles only after a disposition; other sprints are ignored", () => {
  const ev = (type, extra) => ({ type, ts: "2026-11-13T00:00:00Z", sprint: "sprint-001", ...extra });
  assert.deepEqual(storySettled([ev("story_reviewed", { story: "S001", verdict: "approve" })], "S001", "sprint-001"), { verdict: "approve", settled: true });
  assert.deepEqual(storySettled([ev("story_reviewed", { story: "S001", verdict: "changes" })], "S001", "sprint-001"), { verdict: "changes", settled: false });
  assert.deepEqual(storySettled([ev("story_reviewed", { story: "S001", verdict: "changes" }), ev("story_review_dispositioned", { story: "S001", via: "patch_steps" })], "S001", "sprint-001"), { verdict: "changes", settled: true });
  assert.deepEqual(storySettled([ev("story_reviewed", { story: "S001", verdict: "approve", sprint: "sprint-000" })], "S001", "sprint-001"), { verdict: null, settled: false });
  assert.deepEqual(storySettled([], "S009"), { verdict: null, settled: false });
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "story-review-"));
  const d = join(base, "projects", "abc123abc123");
  for (const sub of ["spec/stories", "spec/steps", "spec/tasks", "sprints/current", "templates"]) mkdirSync(join(d, sub), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\nstories: [S001, S002]\n---\n\n## Waves\n\n### Wave 1\n- P001\n- P002\n- P003\n");
  const step = (id, story, status) => writeFileSync(join(d, "spec/steps", `${id}-x.md`), `---\nid: "${id}"\ntype: step\nkind: feature\nstory: ${story}\nstatus: ${status}\n---\n`);
  step("P001", "S001", "done"); step("P002", "S001", "done"); step("P003", "S002", "in-progress");
  return { base, d };
}
const run = (d, ...args) => spawnSync("node", [CLI, "story-review", ...args, "--data-dir", d], { encoding: "utf8" });

test("check: a story whose steps are all done is complete and unsettled until recorded; record/disposition settle it; the ledger is CLI-owned JSON", () => {
  const { base, d } = fixture();
  try {
    let r = run(d, "check");
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /S001/);
    assert.doesNotMatch(r.stderr, /S002/, "a story with a step still in progress is not complete");
    assert.match(r.stdout, /S001: steps 2\/2 complete; review none/);
    assert.match(r.stdout, /S002: steps 0\/1; review none/);

    r = run(d, "record", "S001", "--verdict", "changes", "--spec", "FINDINGS", "--gaps", "2", "--code", "FINDINGS", "--code-findings", "1", "--head", "0123456789ab");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /settle it with/);
    assert.equal(run(d, "check").status, 3, "changes is not settled yet");
    assert.equal(run(d, "disposition", "S009", "--via", "accepted").status, 3, "no record yet");
    r = run(d, "disposition", "S001", "--via", "patch_steps", "--ids", "P010");
    assert.equal(r.status, 0, r.stderr);
    r = run(d, "check", "--json");
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.unsettled, []);
    assert.equal(j.stories.find((s) => s.story === "S001").settled, true);

    const ledger = JSON.parse(readFileSync(join(d, "sprints/current/.story-reviews.json"), "utf8"));
    assert.equal(ledger.stories.S001.verdict, "changes");
    assert.equal(ledger.stories.S001.gaps, 2);
    assert.equal(ledger.stories.S001.disposition.via, "patch_steps");
    const events = readFileSync(join(d, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /"story_reviewed".*"story":"S001".*"verdict":"changes"/);
    assert.match(events, /"story_review_dispositioned".*"via":"patch_steps"/);

    assert.equal(run(d, "record", "S002", "--verdict", "maybe").status, 2);
    assert.equal(run(d, "record", "nope", "--verdict", "approve").status, 2);
    assert.equal(run(d, "bogus").status, 2);
    const status = computeStoryReviewStatus(d);
    assert.equal(status.sprint, "sprint-001");
    assert.equal(status.stories.length, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("check: legacy builder records under spec/tasks (feature: key) count as the story's steps", () => {
  const { base, d } = fixture();
  try {
    writeFileSync(join(d, "spec/tasks", "T020-legacy.md"), "---\nid: \"T020\"\ntype: task\nkind: feature\nfeature: S002\nstatus: done\n---\n");
    writeFileSync(join(d, "sprints/current/SPRINT.md"), "---\nid: sprint-001\nstatus: in-progress\nfeatures: [S002]\n---\n\n## Waves\n\n### Wave 1\n- T020\n");
    const r = run(d, "check", "--json");
    const j = JSON.parse(r.stdout);
    assert.deepEqual(j.stories.map((s) => [s.story, s.steps, s.done, s.complete]), [["S002", 1, 1, true]]);
    assert.ok(!existsSync(join(d, "sprints/current/.story-reviews.json")), "check never writes");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
