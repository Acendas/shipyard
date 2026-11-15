/** 4.9: Shipyard's own branches are swept when a sprint is over — merged ones deleted, the rest hidden but kept. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function project(config = "") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "br-")));
  const repo = join(root, "repo"); const data = join(root, "data");
  mkdirSync(repo, { recursive: true }); mkdirSync(data, { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  g("init", "-q", "-b", "main"); writeFileSync(join(repo, "a.txt"), "a\n"); g("add", "-A"); g("commit", "-q", "-m", "init");
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_CODE_SESSION_ID: "S1" };
  delete env.SHIPYARD_DATA; delete env.CLAUDE_PID;
  const run = (args) => { const r = spawnSync("node", [CLI, ...args], { cwd: repo, env, encoding: "utf8" }); return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" }; };
  assert.equal(run(["onboarding", "bootstrap"]).code, 0);
  const dataDir = run([]).out.trim();
  if (config) { const p = join(dataDir, "config.md"); writeFileSync(p, readFileSync(p, "utf8").replace(/^execution:\n/m, `execution:\n${config}`)); }
  // a commit that exists only on a side branch
  const side = (branch, file) => { g("checkout", "-q", "-b", branch); writeFileSync(join(repo, file), file); g("add", "-A"); g("commit", "-q", "-m", file); const sha = g("rev-parse", "HEAD"); g("checkout", "-q", "main"); return sha; };
  return { root, repo, dataDir, run, g, side, branches: () => g("branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort(), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function seed(p) {
  p.g("branch", "shipyard/keep-T001", "main");                         // already in main
  const k2 = p.side("shipyard/keep-T002", "k2.txt");                    // salvaged, never merged
  const w1 = p.side("shipyard/wt-agent-abc123", "w1.txt");              // an old builder branch
  const mine = p.side("feature/mine", "mine.txt");                      // the owner's own branch
  p.g("branch", "shipyard/release-notes", "main");                      // looks similar, is not ours
  const live = p.side("shipyard/wt-agent-live", "live.txt");
  p.g("worktree", "add", "-q", join(p.root, "wt-live"), "shipyard/wt-agent-live");
  writeFileSync(join(p.root, "wt-live", "half-done.txt"), "not committed\n");        // work nobody committed: never discarded
  return { k2, w1, mine, live };
}

test("branches sweep: merged anchors are deleted, unmerged ones move under refs/shipyard/archive, and nothing else is touched", () => {
  const p = project();
  try {
    const sha = seed(p);
    let r = p.run(["branches", "status", "--json"]);
    assert.deepEqual(JSON.parse(r.out), { worktrees: 1, worktrees_dirty: 1, visible: 4, anchors: 2, worktree_branches: 2, checked_out: 1, archived: 0, sprint_in_flight: false });
    r = p.run(["branches", "sweep", "--label", "sprint-001", "--dry-run", "--json"]);
    assert.deepEqual(JSON.parse(r.out), { label: "sprint-001", refs_prefix: "refs/shipyard/archive/sprint-001/", deleted: 1, archived: 2, skipped: 1, dry_run: true, worktrees_removed: 0, worktrees_kept: [{ path: join(p.root, "wt-live"), why: "has uncommitted changes" }] });
    assert.equal(p.branches().length, 7, "a dry run changes nothing");
    r = p.run(["branches", "sweep", "--label", "sprint-001"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /swept 3 Shipyard branch\(es\): 1 already merged \(deleted\), 2 kept under refs\/shipyard\/archive\/sprint-001\/.*1 checked out in a worktree, left alone/);
    assert.deepEqual(p.branches(), ["feature/mine", "main", "shipyard/release-notes", "shipyard/wt-agent-live"]);
    // the unmerged commits are still reachable by ref, so git never collects them
    assert.equal(p.g("rev-parse", "refs/shipyard/archive/sprint-001/keep-T002"), sha.k2);
    assert.equal(p.g("rev-parse", "refs/shipyard/archive/sprint-001/wt-agent-abc123"), sha.w1);
    assert.equal(p.g("for-each-ref", "--format=%(refname)", "refs/shipyard/archive/").split("\n").length, 2);
    assert.equal(p.g("rev-parse", "feature/mine"), sha.mine);
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"branches_swept"[^\n]*"deleted":1[^\n]*"archived":2/);
    assert.equal(JSON.parse(p.run(["branches", "status", "--json"]).out).archived, 2);
    assert.match(p.run(["branches", "sweep"]).out, /swept 0 Shipyard branch/);
  } finally { p.cleanup(); }
});

test("reconcile reports leftover Shipyard branches and --fix sweeps them; a running sprint is never swept", () => {
  const p = project();
  try {
    seed(p);
    let r = p.run(["reconcile"]);
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.out, /\[worktree-with-uncommitted-work\] .*wt-live \(shipyard\/wt-agent-live\) has uncommitted changes/);
    assert.match(r.out, /\[stale-shipyard-branches\] 3 Shipyard branch\(es\) from finished sprints are still listed by `git branch` \(2 anchors, 1 worktree branches\)/);
    r = p.run(["reconcile", "--fix"]);
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(p.branches(), ["feature/mine", "main", "shipyard/release-notes", "shipyard/wt-agent-live"]);
    assert.doesNotMatch(p.run(["reconcile"]).out, /stale-shipyard-branches|stale-worktrees/);
    // a sprint in flight: its branches are live
    p.g("branch", "shipyard/keep-T009", "main");
    mkdirSync(join(p.dataDir, "sprints", "current"), { recursive: true });
    // a sprint that finished executing but is not reviewed yet still owns its branches
    writeFileSync(join(p.dataDir, "sprints", "current", "SPRINT.md"), "---\nid: sprint-002\nstatus: completed\nstories: []\n---\n");
    assert.doesNotMatch(p.run(["reconcile"]).out, /stale-shipyard-branches/, "archive-sprint sweeps them at the end of the review");
    writeFileSync(join(p.dataDir, "sprints", "current", "SPRINT.md"), "---\nid: sprint-002\nstatus: in-progress\nstories: []\n---\n");
    writeFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "---\npipeline: ship-execute\nstage: wave_1_dispatch\nstatus: in_progress\n---\n");
    assert.doesNotMatch(p.run(["reconcile"]).out, /stale-shipyard-branches/);
    r = p.run(["branches", "sweep"]);
    assert.equal(r.code, 3); assert.match(r.err, /a sprint is running/);
    assert.ok(p.branches().includes("shipyard/keep-T009"));
  } finally { p.cleanup(); }
});

test("execution.sweep_branches: false leaves the branches alone", () => {
  const p = project("  sweep_branches: false\n");
  try {
    seed(p);
    assert.doesNotMatch(p.run(["reconcile"]).out, /stale-shipyard-branches|stale-worktrees|uncommitted/);
    assert.equal(p.branches().length, 7);
  } finally { p.cleanup(); }
});

test("finished builder worktrees are removed with their branches; one with uncommitted work is kept and named", () => {
  const p = project();
  try {
    seed(p);
    // a finished builder: clean worktree, commit never merged
    const done = p.side("shipyard/wt-agent-done", "done.txt");
    p.g("worktree", "add", "-q", join(p.root, "wt-done"), "shipyard/wt-agent-done");
    let r = p.run(["reconcile"]);
    assert.match(r.out, /\[stale-worktrees\] 1 finished builder worktree\(s\) are still on disk/);
    r = p.run(["branches", "sweep", "--label", "sprint-009"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /removed 1 finished builder worktree\(s\); left 1: .*wt-live \(has uncommitted changes\)/);
    const wts = p.g("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9));
    assert.deepEqual(wts.sort(), [p.repo, join(p.root, "wt-live")].sort());
    assert.equal(readFileSync(join(p.root, "wt-live", "half-done.txt"), "utf8"), "not committed\n", "uncommitted work is untouched");
    assert.equal(p.g("rev-parse", "refs/shipyard/archive/sprint-009/wt-agent-done"), done, "the removed worktree's commit is still reachable");
    assert.ok(p.branches().includes("shipyard/wt-agent-live"));
  } finally { p.cleanup(); }
});

test("stray changes are set aside in a stash: the tree is clean again, nothing is lost, untracked files are only listed", () => {
  const p = project();
  try {
    assert.match(p.run(["stray", "list"]).out, /no uncommitted changes/);
    writeFileSync(join(p.repo, "a.txt"), "regenerated by a script nobody meant to run\n");
    writeFileSync(join(p.repo, "notes.txt"), "the owner's untracked notes\n");
    let r = p.run(["stray", "list"]);
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.out, /^changed    a\.txt$/m); assert.match(r.out, /^untracked  notes\.txt   \(listed only: never removed\)$/m);
    assert.equal(p.run(["stray", "set-aside"]).code, 2, "the reason is required");
    r = p.run(["stray", "set-aside", "--reason", "code-review-S012 ran tools/gen.py --help"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /set aside 1 changed file\(s\): a\.txt/); assert.match(r.out, /nothing is lost/); assert.match(r.out, /git stash apply [0-9a-f]{12}/);
    assert.equal(readFileSync(join(p.repo, "a.txt"), "utf8"), "a\n", "the committed text is back");
    assert.equal(readFileSync(join(p.repo, "notes.txt"), "utf8"), "the owner's untracked notes\n");
    assert.match(p.g("stash", "list"), /shipyard stray: code-review-S012 ran tools\/gen\.py --help/);
    p.g("stash", "apply");
    assert.equal(readFileSync(join(p.repo, "a.txt"), "utf8"), "regenerated by a script nobody meant to run\n", "and it can be brought back");
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"stray_changes_set_aside"[^\n]*"files":"a\.txt"/);
  } finally { p.cleanup(); }
});

test("a planning command commits what it wrote: lock release refuses new uncommitted project files, not ones that were already dirty", () => {
  const p = project();
  try {
    writeFileSync(join(p.repo, "b.txt"), "b\n"); p.g("add", "-A"); p.g("commit", "-q", "-m", "b");
    writeFileSync(join(p.repo, "b.txt"), "the owner's own open edit\n"); // dirty before the command
    assert.equal(p.run(["lock", "acquire", "planning", "--skill", "ship-discuss"]).code, 0);
    writeFileSync(join(p.repo, "a.txt"), "a decision record the command wrote\n");
    let r = p.run(["lock", "release", "planning", "--skill", "ship-discuss"]);
    assert.equal(r.code, 3, r.out + r.err);
    assert.match(r.err, /1 project file\(s\) changed during this command and are not committed: a\.txt\./);
    assert.doesNotMatch(r.err, /b\.txt/);
    assert.equal(p.run(["lock", "release", "planning", "--skill", "ship-discuss", "--leave-changes"]).code, 2);
    p.g("add", "--", "a.txt"); p.g("commit", "-q", "-m", "docs: decisions");
    r = p.run(["lock", "release", "planning", "--skill", "ship-discuss"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(join(p.repo, "b.txt"), "utf8"), "the owner's own open edit\n");
    // on purpose
    assert.equal(p.run(["lock", "acquire", "planning", "--skill", "ship-sprint"]).code, 0);
    writeFileSync(join(p.repo, "a.txt"), "left open on purpose\n");
    r = p.run(["lock", "release", "planning", "--skill", "ship-sprint", "--leave-changes", "the owner will review the wording first"]);
    assert.equal(r.code, 0, r.err);
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"lock_released_with_changes"[^\n]*"files":"a\.txt"/);
  } finally { p.cleanup(); }
});
