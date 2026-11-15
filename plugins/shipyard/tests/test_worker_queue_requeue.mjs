/**
 * T038 — requeueStale must be liveness-aware.
 *
 * A claimed item past its TTL whose builder is demonstrably alive (recent
 * task_loop_iteration) or already finished (subagent_completed /
 * task_return_recorded) must NOT be re-pended: re-pending hands a second
 * builder the same task while the first is still working. Dead items are
 * still recovered; non-idempotent dead items are reported stale only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isTaskLive } from "../bin/worker-queue.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, "bin", "shipyard-data.mjs");
const STAGE = "wave_1_dispatch";

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "worker-queue-requeue-"));
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(data, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  delete env.SHIPYARD_DATA;
  const run = (args) => {
    const r = spawnSync("node", [CLI, ...args], { cwd: repo, env, encoding: "utf8" });
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const init = run(["init"]);
  const dataDir = init.stdout.trim();
  if (init.code !== 0 || !isAbsolute(dataDir)) throw new Error(`fixture setup failed: ${init.stderr}`);
  return { root, dataDir, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function queueFile(p) {
  const cur = join(p.dataDir, "sprints", "current");
  return join(existsSync(cur) ? cur : p.dataDir, ".worker-queue.json");
}

/** Enqueue + claim tasks, then age every claim so it is `ageMin` old and past TTL. */
function claimAged(p, tasks, ageMin = 40) {
  const input = join(p.root, "tasks.json");
  writeFileSync(input, JSON.stringify(tasks));
  assert.equal(p.run(["queue", "enqueue", "--pipeline", "ship-execute", "--stage", STAGE, "--input", input]).code, 0);
  for (const _ of tasks) {
    assert.equal(JSON.parse(p.run(["queue", "claim", "--pipeline", "ship-execute", "--stage", STAGE, "--worker", "w"]).stdout).claimed, true);
  }
  const path = queueFile(p);
  const q = JSON.parse(readFileSync(path, "utf8"));
  const claimedAt = Date.now() - ageMin * 60_000;
  for (const t of q.tasks) {
    t.claimed_at = new Date(claimedAt).toISOString();
    t.deadline_at = new Date(claimedAt + 30 * 60_000).toISOString();
  }
  writeFileSync(path, JSON.stringify(q));
  return claimedAt;
}

function emit(p, type, task, agoMs = 0, extra = {}) {
  const ts = new Date(Date.now() - agoMs).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  appendFileSync(join(p.dataDir, ".shipyard-events.jsonl"), JSON.stringify({ ts, type, task, ...extra }) + "\n");
}

const requeue = (p) => JSON.parse(p.run(["queue", "requeue-stale", "--pipeline", "execute", "--stage", STAGE]).stdout);
const statusOf = (p, id) => JSON.parse(readFileSync(queueFile(p), "utf8")).tasks.find((t) => t.id === id).status;

test("past-TTL claim with a recent task_loop_iteration stays claimed (repro)", () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }]);
    emit(p, "task_loop_iteration", "T001", 60_000, { iteration: 3 });
    const out = requeue(p);
    assert.equal(statusOf(p, "T001"), "claimed");
    assert.deepEqual(out.stale, []);
  } finally { p.cleanup(); }
});

test("past-TTL claim with subagent_completed or task_return_recorded is not re-pended", () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }, { id: "T002" }]);
    emit(p, "subagent_completed", "T001", 20 * 60_000);
    emit(p, "task_return_recorded", "T002", 20 * 60_000);
    requeue(p);
    assert.equal(statusOf(p, "T001"), "claimed");
    assert.equal(statusOf(p, "T002"), "claimed");
  } finally { p.cleanup(); }
});

test("completed_unacked: completion events without queue complete are their own bucket, not live", () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }, { id: "T002" }, { id: "T003" }]);
    emit(p, "subagent_completed", "T001", 20 * 60_000);
    emit(p, "task_return_recorded", "T002", 20 * 60_000);
    emit(p, "task_loop_iteration", "T003", 30_000);
    const out = requeue(p);
    assert.deepEqual(out.completed_unacked, [{ id: "T001" }, { id: "T002" }]);
    assert.deepEqual(out.live, []); // T003's heartbeat extended its deadline: not even past due
    assert.equal(statusOf(p, "T003"), "claimed");
    assert.deepEqual(out.stale, []);
    assert.equal(statusOf(p, "T001"), "claimed");
  } finally { p.cleanup(); }
});

test("completed_unacked: isTaskLive is false for a completion-only item", () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }]);
    const task = JSON.parse(readFileSync(queueFile(p), "utf8")).tasks[0];
    emit(p, "subagent_completed", "T001", 1000);
    assert.equal(isTaskLive(p.dataDir, task), false);
  } finally { p.cleanup(); }
});

test("dead idempotent claim (no events) is still re-pended", () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }]);
    const out = requeue(p);
    assert.deepEqual(out.stale, [{ id: "T001", requeued: true }]);
    assert.equal(statusOf(p, "T001"), "pending");
  } finally { p.cleanup(); }
});

test("events from a previous attempt (ts < claimed_at) do not count as liveness", () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }], 40);
    emit(p, "task_loop_iteration", "T001", 50 * 60_000); // before the 40-min-old claim
    emit(p, "subagent_completed", "T001", 55 * 60_000);
    requeue(p);
    assert.equal(statusOf(p, "T001"), "pending");
  } finally { p.cleanup(); }
});

test("old (non-recent) iteration after claim does not keep a claim alive", () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }], 40);
    emit(p, "task_loop_iteration", "T001", 35 * 60_000); // after claim, but 35 min stale
    requeue(p);
    assert.equal(statusOf(p, "T001"), "pending");
  } finally { p.cleanup(); }
});

test("idempotent:false dead item is reported stale, never re-pended; live one is untouched", () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001", idempotent: false }, { id: "T002", idempotent: false }]);
    emit(p, "task_loop_iteration", "T002", 30_000);
    const out = requeue(p);
    assert.deepEqual(out.stale, [{ id: "T001", requeued: false }]);
    assert.equal(statusOf(p, "T001"), "stale");
    assert.equal(statusOf(p, "T002"), "claimed");
  } finally { p.cleanup(); }
});

test("isTaskLive is exported as a read-only predicate", () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }]);
    const task = JSON.parse(readFileSync(queueFile(p), "utf8")).tasks[0];
    assert.equal(isTaskLive(p.dataDir, task), false);
    emit(p, "task_loop_iteration", "T001", 1000);
    assert.equal(isTaskLive(p.dataDir, task), true);
  } finally { p.cleanup(); }
});

// ---- T039 heartbeat: ttl_seconds stored on claim; progress extends the deadline ----

function claimWithTtl(p, ttl, claimedAgoMs) {
  const input = join(p.root, "hb.json");
  writeFileSync(input, JSON.stringify([{ id: "T001" }]));
  assert.equal(p.run(["queue", "enqueue", "--pipeline", "ship-execute", "--stage", STAGE, "--input", input]).code, 0);
  const c = JSON.parse(p.run(["queue", "claim", "--pipeline", "ship-execute", "--stage", STAGE, "--worker", "w", "--ttl-seconds", String(ttl)]).stdout);
  assert.equal(c.task.ttl_seconds, ttl);
  const path = queueFile(p);
  const q = JSON.parse(readFileSync(path, "utf8"));
  const claimedAt = Date.now() - claimedAgoMs;
  q.tasks[0].claimed_at = new Date(claimedAt).toISOString();
  q.tasks[0].deadline_at = new Date(claimedAt + ttl * 1000).toISOString();
  writeFileSync(path, JSON.stringify(q));
  return claimedAt;
}
const deadlineOf = (p) => Date.parse(JSON.parse(readFileSync(queueFile(p), "utf8")).tasks[0].deadline_at);

test("heartbeat extends deadline to last progress + ttl", () => {
  const p = makeProject();
  try {
    const claimedAt = claimWithTtl(p, 600, 8 * 60_000);
    emit(p, "task_loop_iteration", "T001", 60_000, { iteration: 1 });
    requeue(p);
    const d = deadlineOf(p);
    assert.ok(d > claimedAt + 600_000, "deadline extended past original");
    assert.ok(Math.abs(d - (Date.now() - 60_000 + 600_000)) < 3_000, "~ progress ts + ttl");
  } finally { p.cleanup(); }
});

test("heartbeat cap: deadline never exceeds claimed_at + 3x ttl", () => {
  const p = makeProject();
  try {
    const claimedAt = claimWithTtl(p, 600, 25 * 60_000);
    emit(p, "task_loop_iteration", "T001", 1_000, { iteration: 9 });
    requeue(p);
    assert.equal(deadlineOf(p), claimedAt + 1800_000);
  } finally { p.cleanup(); }
});

test("heartbeat cap: absolute ceiling is 120 minutes", () => {
  const p = makeProject();
  try {
    const claimedAt = claimWithTtl(p, 3600, 100 * 60_000);
    emit(p, "task_loop_iteration", "T001", 1_000, { iteration: 9 });
    requeue(p);
    assert.equal(deadlineOf(p), claimedAt + 120 * 60_000);
  } finally { p.cleanup(); }
});

test("heartbeat never shortens: earlier computed deadline is ignored", () => {
  const p = makeProject();
  try {
    const claimedAt = claimWithTtl(p, 600, 8 * 60_000);
    const path = queueFile(p);
    const q = JSON.parse(readFileSync(path, "utf8"));
    q.tasks[0].deadline_at = new Date(claimedAt + 25 * 60_000).toISOString(); // previously extended
    writeFileSync(path, JSON.stringify(q));
    const before = deadlineOf(p);
    emit(p, "task_loop_iteration", "T001", 60_000, { iteration: 1 }); // progress+ttl is earlier than deadline
    requeue(p);
    assert.equal(deadlineOf(p), before);
  } finally { p.cleanup(); }
});

test("heartbeat ignores progress from a previous attempt", () => {
  const p = makeProject();
  try {
    claimWithTtl(p, 600, 5 * 60_000);
    const before = deadlineOf(p);
    emit(p, "task_loop_iteration", "T001", 30 * 60_000, { iteration: 1 });
    requeue(p);
    assert.equal(deadlineOf(p), before);
  } finally { p.cleanup(); }
});

function writeReturn(p, id, over = {}) {
  const dir = join(p.dataDir, "sprints", "current", ".subagent-returns");
  mkdirSync(dir, { recursive: true });
  const cap = join(p.root, `${id}.cap.txt`);
  writeFileSync(cap, "ok\n");
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify({
    task: id, status: "COMPLETE", commit_sha: "abc", probe_exit_code: 0,
    output_tail: "ok", capture_file: cap, escalation_code: "", ...over,
  }));
  return file;
}

test("completed_unacked: reconcile completes the item when the return artifact is valid", () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }]);
    emit(p, "subagent_completed", "T001", 20 * 60_000);
    assert.deepEqual(requeue(p).completed_unacked, [{ id: "T001" }]);
    // park-stale still refuses a claimed item
    assert.equal(p.run(["queue", "park-stale", "T001", "--pipeline", "ship-execute", "--stage", STAGE, "--reason", "x"]).code, 3);
    const file = writeReturn(p, "T001");
    const r = p.run(["queue", "reconcile", "T001", "--pipeline", "ship-execute", "--stage", STAGE]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).outcome, "complete");
    assert.equal(statusOf(p, "T001"), "complete");
    const t = JSON.parse(readFileSync(queueFile(p), "utf8")).tasks[0];
    assert.equal(t.result, file);
    assert.deepEqual(requeue(p).completed_unacked, []);
  } finally { p.cleanup(); }
});

test("completed_unacked: reconcile parks with completed_unacked_artifact_missing when no artifact", () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }]);
    emit(p, "subagent_completed", "T001", 20 * 60_000);
    const r = p.run(["queue", "reconcile", "T001", "--pipeline", "ship-execute", "--stage", STAGE]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statusOf(p, "T001"), "failed");
    const t = JSON.parse(readFileSync(queueFile(p), "utf8")).tasks[0];
    assert.equal(t.reason, "completed_unacked_artifact_missing");
    assert.deepEqual(requeue(p).completed_unacked, []);
  } finally { p.cleanup(); }
});

test("completed_unacked: reconcile refuses a claim with no completion event", () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }]);
    writeReturn(p, "T001");
    const r = p.run(["queue", "reconcile", "T001", "--pipeline", "ship-execute", "--stage", STAGE]);
    assert.equal(r.code, 3);
    assert.equal(statusOf(p, "T001"), "claimed");
  } finally { p.cleanup(); }
});

// ---- T097: F015 AC-1/AC-5 slow builder, legacy claim fallback ----

test("F015 AC-1/AC-5: a builder past 31 minutes with a heartbeat keeps its single claim; no second claimant, so one wt-* branch", () => {
  // AC-1 AC-5
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }], 31);
    emit(p, "task_loop_iteration", "T001", 60_000, { iteration: 4 });
    const out = requeue(p);
    assert.deepEqual(out.stale, [], "live builder not re-pended");
    assert.equal(statusOf(p, "T001"), "claimed");
    // The old behavior re-pended here, letting a second worker claim and create a second wt-* branch.
    const second = JSON.parse(p.run(["queue", "claim", "--pipeline", "ship-execute", "--stage", STAGE, "--worker", "w2"]).stdout);
    assert.equal(second.claimed, false, "no second builder can claim the task");
    const t = JSON.parse(readFileSync(queueFile(p), "utf8")).tasks[0];
    assert.equal(t.claimed_by, "w");
    assert.equal(t.attempt, 1, "still the first attempt");
    // Control: the same 31-minute-old claim WITHOUT a heartbeat is recovered.
    const q = makeProject();
    try {
      claimAged(q, [{ id: "T001" }], 31);
      assert.equal(requeue(q).stale[0].requeued, true);
    } finally { q.cleanup(); }
  } finally { p.cleanup(); }
});

test("legacy claim without ttl_seconds derives ttl from deadline-claimed_at for heartbeat renewal", () => {
  const p = makeProject();
  try {
    const claimedAt = claimWithTtl(p, 600, 8 * 60_000);
    const path = queueFile(p);
    const q = JSON.parse(readFileSync(path, "utf8"));
    delete q.tasks[0].ttl_seconds;
    writeFileSync(path, JSON.stringify(q));
    emit(p, "task_loop_iteration", "T001", 60_000, { iteration: 1 });
    requeue(p);
    const d = deadlineOf(p);
    assert.ok(d > claimedAt + 600_000, "legacy item deadline still extended");
    assert.ok(Math.abs(d - (Date.now() - 60_000 + 600_000)) < 3_000, "~ progress ts + derived ttl");
  } finally { p.cleanup(); }
});

test("requeue-stale reads the event log inside the queue lock (heartbeat appended while waiting is seen)", async () => {
  const p = makeProject();
  try {
    claimAged(p, [{ id: "T001" }]);
    const lock = queueFile(p) + ".lock";
    writeFileSync(lock, "held-by-test");
    const child = spawn("node", [CLI, "queue", "requeue-stale", "--pipeline", "execute", "--stage", STAGE, "--data-dir", p.dataDir], {
      cwd: join(p.root, "repo"),
      env: { ...process.env, CLAUDE_PLUGIN_DATA: p.dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const done = new Promise((res) => child.on("close", res));
    await new Promise((r) => setTimeout(r, 700)); // child is now blocked on the lock
    emit(p, "task_loop_iteration", "T001", 0, { iteration: 1 });
    rmSync(lock, { force: true });
    await done;
    assert.equal(statusOf(p, "T001"), "claimed");
    assert.deepEqual(JSON.parse(out).stale, []);
  } finally { p.cleanup(); }
});
