// `story add`, `task add` and what else a real project's first LeSS-shaped discussion ran into (after 4.0.1):
// no verb to write the stories and spikes of an epic (55 story files were written by hand, each missing
// `refined: false` and carrying its epic's ticket), a health check that asked every story for score fields
// (400 findings), a refinement queue that refused epics, `idea capture --description` refused as unknown, and a
// worktree hook that named every worktree in the project as a builder's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { forShipyardBuilder } from "../bin/hooks/worktree-branch.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "radd-"));
  const d = join(base, "projects", "abc123abc123");
  for (const s of ["epics", "stories", "tasks", "ideas"]) mkdirSync(join(d, "spec", s), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "config.md"), "---\nconfig_version: 5\n---\n");
  writeFileSync(join(d, "spec", "epics", "E001-x.md"), '---\nid: E001\ntitle: "Pay by card"\ntype: epic\nstatus: proposed\nticket: "ABC-10"\nexternal_refs: ["ABC-10"]\nfix_version: "v2"\n---\n\n# Pay by card\n');
  const run = (...args) => spawnSync("node", [CLI, ...args, "--data-dir", d], { encoding: "utf8" });
  const read = (sub, id) => readFileSync(join(d, "spec", sub, readdirSync(join(d, "spec", sub)).find((n) => n.startsWith(`${id}-`))), "utf8");
  return { base, d, run, read, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("breaking an epic down is two verbs: a spike, and coarse stories that wait for it", () => {
  const f = fixture();
  try {
    let r = f.run("task", "add", "--title", "Which card reader", "--kind", "spike", "--parent", "E001", "--question", "Does it read chip cards?", "--question", "What does it cost?", "--timebox", "1 day");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^T001 added \(spike\) under E001: .*T001-which-card-reader\.md\nA story that needs its answer waits for it: shipyard-data story add-dep <S###> T001/);
    const task = f.read("tasks", "T001");
    assert.match(task, /^id: T001\ntitle: "Which card reader"\ntype: task\nkind: spike\nparent: "E001"\nstatus: open\neffort: ""\ndependencies: \[\]\nexternal_refs: \[\]\naliases: \[\]/m);
    assert.match(task, /- Question: Does it read chip cards\?\n- Question: What does it cost\?\n- Timebox: 1 day/);

    r = f.run("story", "add", "--title", "A good card is approved", "--epic", "E001", "--ui", "--as", "a shopper", "--want", "to pay by card", "--so", "I need no cash", "--note", "Chip and tap.", "--after", "T001");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^S001 added under E001, waits for T001: .*\nRefine it when it nears the top: \/ship-discuss S001/);
    const story = f.read("stories", "S001");
    assert.match(story, /^id: S001\ntitle: "A good card is approved"\ntype: feature\nepic: "E001"\nstatus: proposed\n# coarse[^\n]*\nrefined: false\nstory_points: 0\nui: true\ndependencies: \[T001\]\nreferences: \[\]\nexternal_refs: \[\]/m);
    assert.match(story, /As a shopper, I want to pay by card, so that I need no cash\.\n\n## Notes\n\nChip and tap\./);
    assert.doesNotMatch(story, /ABC-10/, "the epic's ticket is not the story's");
    f.run("story", "add", "--title", "A refused card says why", "--epic", "E001", "--after", "S001");
    assert.match(f.read("stories", "S002"), /dependencies: \[S001\]/);

    // a coarse story cannot be approved, sits in its epic's release, and is offered a ticket of its own under the epic's
    r = f.run("story", "set-status", "S001", "approved");
    assert.notEqual(r.status, 0);
    f.run("version", "add", "v2");
    assert.match(f.run("version", "show", "v2").stdout, /S001 +proposed +0 pts +A good card is approved +\(from E001\)/);
    const plan = JSON.parse(f.run("tracker", "plan", "--json").stdout).rows;
    assert.deepEqual(plan.filter((x) => x.action === "create").map((x) => `${x.id} under ${x.parent_key}`), ["S001 under ABC-10", "S002 under ABC-10", "T001 under ABC-10"]);

    // the health check is quiet about them
    const doc = f.run("doctor", "--full");
    assert.doesNotMatch(doc.stdout + doc.stderr, /S00[12][^\n]*missing/);

    // refusals name what is wrong
    assert.match(f.run("story", "add", "--title", "x", "--epic", "E009").stderr, /--epic E009 does not exist/);
    assert.match(f.run("story", "add", "--title", "x", "--after", "S099").stderr, /--after S099: no such story or task/);
    assert.equal(f.run("story", "add").status, 2);
    assert.match(f.run("task", "add", "--title", "x", "--kind", "errand").stderr, /--kind is one of spike, unblocker, study, debug, chore/);
    assert.match(f.run("task").stderr, /Expected: add\|set-status\|append-verify +\(a new spike or chore: task add --title/);
    assert.equal(readdirSync(join(f.d, "spec", "stories")).filter((n) => n.endsWith(".md")).length, 2, "a refused call writes nothing");
  } finally { f.cleanup(); }
});

test("a story with none of the score fields is a valid story; a missing status still is not", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.d, "spec", "stories", "S001-x.md"), '---\nid: S001\ntitle: "By hand"\ntype: feature\nepic: E001\nstatus: proposed\nstory_points: 0\ndependencies: []\ncreated: 2026-11-16\n---\n\n# By hand\n');
    writeFileSync(join(f.d, "spec", "stories", "S002-x.md"), '---\nid: S002\ntitle: "No status"\ntype: feature\nepic: E001\nstory_points: 0\ndependencies: []\ncreated: 2026-11-16\n---\n\n# x\n');
    const out = f.run("doctor", "--full"); const text = out.stdout + out.stderr;
    assert.doesNotMatch(text, /S001-x\.md/);
    assert.match(text, /S002-x\.md — missing\/empty field: status/);
    assert.doesNotMatch(text, /rice_|token_estimate|complexity/);
  } finally { f.cleanup(); }
});

test("the refinement queue takes epics; idea capture takes the word a session reaches for", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.d, "spec", "epics", "E002-y.md"), '---\nid: E002\ntitle: "Refunds"\ntype: epic\nstatus: proposed\n---\n');
    let r = f.run("discuss-queue", "start", "--items", "E001,E002");
    assert.equal(r.status, 0, r.stderr);
    assert.match(f.run("discuss-queue", "next").stdout, /item 1 of 2: E001 \(epic, in-discussion\)/);
    r = f.run("idea", "capture", "--title", "Gift cards", "--description", "Sell and redeem gift cards.", "--reason", "Asked for twice.");
    assert.equal(r.status, 0, r.stderr);
    assert.match(f.read("ideas", "IDEA-001"), /## Idea\n\nSell and redeem gift cards\.\n\n## Why It Might Matter\n\nAsked for twice\./);
    assert.match(f.run("idea", "capture", "--title", "x", "--colour", "red").stderr, /unknown flag --colour/);
  } finally { f.cleanup(); }
});

test("only a worktree made while Shipyard is building is named as a builder's", () => {
  const f = fixture();
  try {
    assert.equal(forShipyardBuilder(""), true, "no data folder known: the old name, never a wave with no branches");
    assert.equal(forShipyardBuilder(join(f.base, "nowhere")), true, "not an initialized project folder");
    assert.equal(forShipyardBuilder(f.d), false, "an initialized project where nothing is building");
    writeFileSync(join(f.d, ".active-execution.json"), JSON.stringify({ skill: null, cleared: "2026-11-16T00:00:00Z" }));
    assert.equal(forShipyardBuilder(f.d), false);
    writeFileSync(join(f.d, ".active-execution.json"), JSON.stringify({ skill: "ship-execute", session_id: "s1", cleared: null }));
    assert.equal(forShipyardBuilder(f.d), true);

    // through the hook, in a real repository
    const repo = join(f.base, "repo");
    mkdirSync(repo);
    const git = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
    git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "a\n"); git("add", "-A"); git("commit", "-q", "-m", "init");
    const hook = (name) => spawnSync("node", [join(ROOT, "bin", "hook-runner.mjs"), "worktree-branch"], { cwd: repo, input: JSON.stringify({ name }), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: f.d } });
    let r = hook("builder-P001");
    assert.equal(r.status, 0, r.stderr);
    assert.match(git("branch", "--list").stdout, /shipyard\/wt-builder-P001/);
    writeFileSync(join(f.d, ".active-execution.json"), JSON.stringify({ skill: null, cleared: "2026-11-16T00:00:00Z" }));
    r = hook("my-own");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(r.stdout, "a.txt")), "the path it prints is the worktree");
    assert.match(git("branch", "--list").stdout, /worktree-my-own/);
    assert.doesNotMatch(git("branch", "--list").stdout, /shipyard\/wt-my-own/);
    // asked for again with work in it: handed back untouched
    writeFileSync(join(r.stdout, "wip.txt"), "not committed\n");
    const again = hook("my-own");
    assert.equal(again.stdout, r.stdout);
    assert.ok(existsSync(join(r.stdout, "wip.txt")), "someone else's uncommitted work is never removed");
  } finally { f.cleanup(); }
});
