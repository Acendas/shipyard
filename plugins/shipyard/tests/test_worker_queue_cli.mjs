/**
 * Tests for `shipyard-data queue`.
 *
 * The queue is the CLI-owned coordination surface for flat proactive workers:
 * workers claim one item atomically, write artifacts, and report completion
 * without relying on Claude notification delivery.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, "bin", "shipyard-data.mjs");

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "worker-queue-test-"));
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(data, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  delete env.SHIPYARD_DATA;
  const run = (args) => {
    const result = spawnSync("node", [CLI, ...args], { cwd: repo, env, encoding: "utf8" });
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const init = run(["init"]);
  const dataDir = init.stdout.trim();
  if (init.code !== 0 || !isAbsolute(dataDir)) {
    throw new Error(`fixture setup failed: ${init.stderr}`);
  }
  return { root, repo, dataDir, dataDirRoot: data, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeQueueArtifact(path, id, fields = {}) {
  const capture = fields.capture_file ?? join(dirname(path), `${id}-capture.log`);
  mkdirSync(dirname(path), { recursive: true });
  if (isAbsolute(capture)) writeFileSync(capture, "probe output\n");
  writeFileSync(path, JSON.stringify({
    task: id,
    status: "COMPLETE",
    commit_sha: "abc1234",
    probe_exit_code: 0,
    output_tail: "probe output",
    capture_file: capture,
    escalation_code: null,
    ...fields,
  }));
  return path;
}

test("queue claim atomically assigns pending work to one worker", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "tasks.json");
    writeFileSync(input, JSON.stringify({
      tasks: [
        { id: "T001", kind: "build", files: ["src/a.ts"], expected_artifact: "returns/T001.json" },
      ],
    }));
    assert.equal(p.run(["queue", "enqueue", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--input", input]).code, 0);

    const first = JSON.parse(p.run(["queue", "claim", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--worker", "w1"]).stdout);
    const second = JSON.parse(p.run(["queue", "claim", "--pipeline", "ship-execute", "--stage", "wave_1_dispatch", "--worker", "w2"]).stdout);

    assert.equal(first.claimed, true);
    assert.equal(first.task.id, "T001");
    assert.equal(first.task.claimed_by, "w1");
    assert.equal(second.claimed, false);
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /worker_queue_claimed/);
  } finally {
    p.cleanup();
  }
});

test("queue complete requires the claiming worker and a valid JSON artifact", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "tasks.json");
    const result = join(p.root, "T001-result.json");
    writeFileSync(input, JSON.stringify([{ id: "T001" }]));
    p.run(["queue", "enqueue", "--pipeline", "review", "--stage", "review_fix_wave_1", "--input", input]);
    p.run(["queue", "claim", "--pipeline", "review", "--stage", "review_fix_wave_1", "--worker", "fixer-1"]);

    const wrongWorker = p.run(["queue", "complete", "T001", "--worker", "fixer-2", "--result", result]);
    assert.equal(wrongWorker.code, 3);

    writeQueueArtifact(result, "T001", { batch_id: "T001" });
    const completed = JSON.parse(p.run([
      "queue", "complete", "T001",
      "--pipeline", "review",
      "--stage", "review_fix_wave_1",
      "--worker", "fixer-1",
      "--result", result,
    ]).stdout);
    assert.equal(completed.completed, true);
    assert.equal(completed.task.status, "complete");
    assert.equal(completed.task.artifact_status, "COMPLETE");
    assert.equal(completed.task.result, result);
  } finally {
    p.cleanup();
  }
});

test("queue complete rejects malformed, mismatched, and misplaced artifacts", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "tasks.json");
    const expectedRel = "returns/T001.json";
    const expected = join(p.dataDir, "sprints", "current", expectedRel);
    const wrongPath = join(p.root, "wrong.json");
    writeFileSync(input, JSON.stringify([{ id: "T001", expected_artifact: expectedRel }]));
    p.run(["queue", "enqueue", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--input", input]);
    p.run(["queue", "claim", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--worker", "w1"]);

    writeQueueArtifact(wrongPath, "T001");
    const wrongResult = p.run([
      "queue", "complete", "T001",
      "--pipeline", "execute",
      "--stage", "wave_1_dispatch",
      "--worker", "w1",
      "--result", wrongPath,
    ]);
    assert.equal(wrongResult.code, 3);
    assert.match(wrongResult.stderr, /expected_artifact/);

    mkdirSync(dirname(expected), { recursive: true });
    writeFileSync(expected, "{not-json");
    const badJson = p.run([
      "queue", "complete", "T001",
      "--pipeline", "execute",
      "--stage", "wave_1_dispatch",
      "--worker", "w1",
      "--result", expected,
    ]);
    assert.equal(badJson.code, 3);
    assert.match(badJson.stderr, /not parseable JSON/);

    writeQueueArtifact(expected, "OTHER");
    const mismatch = p.run([
      "queue", "complete", "T001",
      "--pipeline", "execute",
      "--stage", "wave_1_dispatch",
      "--worker", "w1",
      "--result", expected,
    ]);
    assert.equal(mismatch.code, 3);
    assert.match(mismatch.stderr, /does not match T001/);

    writeQueueArtifact(expected, "T001", { capture_file: "relative.log" });
    const badCapture = p.run([
      "queue", "complete", "T001",
      "--pipeline", "execute",
      "--stage", "wave_1_dispatch",
      "--worker", "w1",
      "--result", expected,
    ]);
    assert.equal(badCapture.code, 3);
    assert.match(badCapture.stderr, /capture_file/);

    writeQueueArtifact(expected, "T001");
    const completed = JSON.parse(p.run([
      "queue", "complete", "T001",
      "--pipeline", "execute",
      "--stage", "wave_1_dispatch",
      "--worker", "w1",
      "--result", expected,
    ]).stdout);
    assert.equal(completed.completed, true);
    assert.equal(completed.task.artifact_status, "COMPLETE");
  } finally {
    p.cleanup();
  }
});

test("queue complete records BLOCKED artifact status separately from returned-artifact status", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "tasks.json");
    const result = join(p.root, "T001-blocked.json");
    writeFileSync(input, JSON.stringify([{ id: "T001" }]));
    p.run(["queue", "enqueue", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--input", input]);
    p.run(["queue", "claim", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--worker", "w1"]);
    writeQueueArtifact(result, "T001", { status: "BLOCKED", commit_sha: "" });

    const completed = JSON.parse(p.run([
      "queue", "complete", "T001",
      "--pipeline", "execute",
      "--stage", "wave_1_dispatch",
      "--worker", "w1",
      "--result", result,
    ]).stdout);
    assert.equal(completed.task.status, "complete");
    assert.equal(completed.task.artifact_status, "BLOCKED");

    const listed = JSON.parse(p.run(["queue", "list", "--pipeline", "execute", "--stage", "wave_1_dispatch"]).stdout);
    assert.equal(listed.tasks[0].artifact_status, "BLOCKED");
  } finally {
    p.cleanup();
  }
});

test("queue requeue-stale returns idempotent expired claims to pending", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "tasks.json");
    writeFileSync(input, JSON.stringify([{ id: "T001", idempotent: true }]));
    p.run(["queue", "enqueue", "--pipeline", "execute", "--stage", "wave_2_dispatch", "--input", input]);
    p.run(["queue", "claim", "--pipeline", "execute", "--stage", "wave_2_dispatch", "--worker", "w1", "--ttl-seconds", "1"]);

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    const stale = JSON.parse(p.run(["queue", "requeue-stale", "--pipeline", "execute", "--stage", "wave_2_dispatch"]).stdout);
    assert.deepEqual(stale.stale, [{ id: "T001", requeued: true }]);

    const claimedAgain = JSON.parse(p.run(["queue", "claim", "--pipeline", "execute", "--stage", "wave_2_dispatch", "--worker", "w2"]).stdout);
    assert.equal(claimedAgain.claimed, true);
    assert.equal(claimedAgain.task.claimed_by, "w2");
    assert.equal(claimedAgain.task.attempt, 2);
  } finally {
    p.cleanup();
  }
});

test("queue enqueue maps review plan batches to review fix wave stages", () => {
  const p = makeProject();
  try {
    const plan = join(p.root, "plan.json");
    writeFileSync(plan, JSON.stringify({
      batches: [
        { id: "review-fix-1", files: ["src/a.ts"], required_probes: ["npm test -- a"] },
        { id: "review-fix-2", files: ["src/b.ts"], required_probes: ["npm test -- b"] },
      ],
      waves: [
        { wave: 1, batch_ids: ["review-fix-1"] },
        { wave: 2, batch_ids: ["review-fix-2"] },
      ],
    }));

    p.run(["queue", "enqueue", "--pipeline", "ship-review", "--stage", "review_fix_wave", "--input", plan]);
    const listed = JSON.parse(p.run(["queue", "list", "--pipeline", "ship-review"]).stdout);
    assert.deepEqual(listed.tasks.map((t) => [t.id, t.stage]), [
      ["review-fix-1", "review_fix_wave_1"],
      ["review-fix-2", "review_fix_wave_2"],
    ]);
    assert.deepEqual(listed.tasks[0].required_validation, ["npm test -- a"]);
  } finally {
    p.cleanup();
  }
});

test("queue enqueue accepts review planner index waves", () => {
  const p = makeProject();
  try {
    const plan = join(p.root, "plan.json");
    writeFileSync(plan, JSON.stringify({
      batches: [
        { id: "review-fix-1", files: ["src/a.ts"] },
        { id: "review-fix-2", files: ["src/a.ts"] },
      ],
      waves: [
        { index: 1, batch_ids: ["review-fix-1"] },
        { index: 2, batch_ids: ["review-fix-2"] },
      ],
    }));

    p.run(["queue", "enqueue", "--pipeline", "ship-review", "--stage", "review_fix_wave", "--input", plan]);
    const listed = JSON.parse(p.run(["queue", "list", "--pipeline", "ship-review"]).stdout);
    assert.deepEqual(listed.tasks.map((t) => [t.id, t.stage]), [
      ["review-fix-1", "review_fix_wave_1"],
      ["review-fix-2", "review_fix_wave_2"],
    ]);
  } finally {
    p.cleanup();
  }
});

test("queue enqueue gives anonymous tasks deterministic ids", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "tasks.json");
    writeFileSync(input, JSON.stringify([
      { files: ["src/a.ts"] },
      { files: ["src/b.ts"] },
    ]));

    // Review workers (read-only scanners) may be anonymous: deterministic placeholder ids.
    p.run(["queue", "enqueue", "--pipeline", "review", "--stage", "review_scan", "--input", input]);
    const listed = JSON.parse(p.run(["queue", "list", "--pipeline", "review", "--stage", "review_scan"]).stdout);
    assert.deepEqual(listed.tasks.map((t) => t.id), ["work-1", "work-2"]);
    // Execute items name the step a builder claims: an id-less item is refused (4.5).
    const refused = p.run(["queue", "enqueue", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--input", input]);
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /has no id/);
  } finally {
    p.cleanup();
  }
});

test("queue enqueue maps sanitized review batch ids to planned waves", () => {
  const p = makeProject();
  try {
    const plan = join(p.root, "plan.json");
    writeFileSync(plan, JSON.stringify({
      batches: [
        { id: "review fix 1", files: ["src/a.ts"] },
      ],
      waves: [
        { index: 3, batch_ids: ["review fix 1"] },
      ],
    }));

    p.run(["queue", "enqueue", "--pipeline", "ship-review", "--stage", "review_fix_wave", "--input", plan]);
    const listed = JSON.parse(p.run(["queue", "list", "--pipeline", "ship-review"]).stdout);
    assert.deepEqual(listed.tasks.map((t) => [t.id, t.stage, t.expected_artifact]), [
      ["review-fix-1", "review_fix_wave_3", "review/review-fix-1-result.json"],
    ]);
  } finally {
    p.cleanup();
  }
});

test("queue fail records a failed terminal worker result", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "tasks.json");
    writeFileSync(input, JSON.stringify([{ id: "T001" }]));
    p.run(["queue", "enqueue", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--input", input]);
    p.run(["queue", "claim", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--worker", "w1"]);

    const failed = JSON.parse(p.run([
      "queue", "fail", "T001",
      "--pipeline", "execute",
      "--stage", "wave_1_dispatch",
      "--worker", "w1",
      "--reason", "blocked on migration choice",
    ]).stdout);
    assert.equal(failed.failed, true);
    assert.equal(failed.task.status, "failed");
    assert.equal(failed.task.reason, "blocked on migration choice");
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /worker_queue_failed/);
  } finally {
    p.cleanup();
  }
});

test("queue fail requires an item claimed by that worker", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "tasks.json");
    writeFileSync(input, JSON.stringify([{ id: "T001" }]));
    p.run(["queue", "enqueue", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--input", input]);

    const pendingFail = p.run([
      "queue", "fail", "T001",
      "--pipeline", "execute",
      "--stage", "wave_1_dispatch",
      "--worker", "w1",
      "--reason", "no claim",
    ]);
    assert.equal(pendingFail.code, 3);
    assert.match(pendingFail.stderr, /not claimed/);

    p.run(["queue", "claim", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--worker", "w1"]);
    const result = join(p.root, "T001-result.json");
    writeQueueArtifact(result, "T001");
    p.run([
      "queue", "complete", "T001",
      "--pipeline", "execute",
      "--stage", "wave_1_dispatch",
      "--worker", "w1",
      "--result", result,
    ]);

    const completeFail = p.run([
      "queue", "fail", "T001",
      "--pipeline", "execute",
      "--stage", "wave_1_dispatch",
      "--worker", "w1",
      "--reason", "too late",
    ]);
    assert.equal(completeFail.code, 3);
    assert.match(completeFail.stderr, /not claimed/);
  } finally {
    p.cleanup();
  }
});

test("queue enqueue replaces terminal entries so fresh review plans are not skipped", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "tasks.json");
    const result = join(p.root, "review-fix-1-result.json");
    writeFileSync(input, JSON.stringify([{ id: "review-fix-1", files: ["src/a.ts"] }]));
    p.run(["queue", "enqueue", "--pipeline", "review", "--stage", "review_fix_wave_1", "--input", input]);
    p.run(["queue", "claim", "--pipeline", "review", "--stage", "review_fix_wave_1", "--worker", "w1"]);
    writeQueueArtifact(result, "review-fix-1", { batch_id: "review-fix-1" });
    p.run([
      "queue", "complete", "review-fix-1",
      "--pipeline", "review",
      "--stage", "review_fix_wave_1",
      "--worker", "w1",
      "--result", result,
    ]);

    writeFileSync(input, JSON.stringify([{ id: "review-fix-1", files: ["src/b.ts"] }]));
    const enqueued = JSON.parse(p.run(["queue", "enqueue", "--pipeline", "review", "--stage", "review_fix_wave_1", "--input", input]).stdout);
    assert.equal(enqueued.enqueued, 1);

    const listed = JSON.parse(p.run(["queue", "list", "--pipeline", "review", "--stage", "review_fix_wave_1"]).stdout);
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].status, "pending");
    assert.deepEqual(listed.tasks[0].files, ["src/b.ts"]);
    assert.equal(listed.tasks[0].previous_status, "complete");
  } finally {
    p.cleanup();
  }
});

test("queue identity is stage-aware and completion requires disambiguation when ids repeat", () => {
  const p = makeProject();
  try {
    const first = join(p.root, "first.json");
    const second = join(p.root, "second.json");
    writeFileSync(first, JSON.stringify([{ id: "T001", files: ["src/a.ts"] }]));
    writeFileSync(second, JSON.stringify([{ id: "T001", files: ["src/b.ts"] }]));
    p.run(["queue", "enqueue", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--input", first]);
    p.run(["queue", "enqueue", "--pipeline", "execute", "--stage", "wave_1_redispatch_iter_1", "--input", second]);

    const listed = JSON.parse(p.run(["queue", "list", "--pipeline", "execute"]).stdout);
    assert.equal(listed.tasks.length, 2);
    assert.deepEqual(listed.tasks.map((t) => t.stage).sort(), ["wave_1_dispatch", "wave_1_redispatch_iter_1"]);

    p.run(["queue", "claim", "--pipeline", "execute", "--stage", "wave_1_redispatch_iter_1", "--worker", "w2"]);
    const result = writeQueueArtifact(join(p.root, "T001-result.json"), "T001");
    const ambiguous = p.run(["queue", "complete", "T001", "--worker", "w2", "--result", result]);
    assert.equal(ambiguous.code, 2);
    assert.match(ambiguous.stderr, /ambiguous/);

    const completed = JSON.parse(p.run([
      "queue", "complete", "T001",
      "--pipeline", "execute",
      "--stage", "wave_1_redispatch_iter_1",
      "--worker", "w2",
      "--result", result,
    ]).stdout);
    assert.equal(completed.task.stage, "wave_1_redispatch_iter_1");
  } finally {
    p.cleanup();
  }
});

test("queue stale non-idempotent items can be retried or parked explicitly", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "tasks.json");
    writeFileSync(input, JSON.stringify([
      { id: "T001", idempotent: false },
      { id: "T002", idempotent: false },
    ]));
    p.run(["queue", "enqueue", "--pipeline", "execute", "--stage", "wave_3_dispatch", "--input", input]);
    p.run(["queue", "claim", "--pipeline", "execute", "--stage", "wave_3_dispatch", "--worker", "w1", "--ttl-seconds", "1"]);
    p.run(["queue", "claim", "--pipeline", "execute", "--stage", "wave_3_dispatch", "--worker", "w2", "--ttl-seconds", "1"]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);

    const stale = JSON.parse(p.run(["queue", "requeue-stale", "--pipeline", "execute", "--stage", "wave_3_dispatch"]).stdout);
    assert.deepEqual(stale.stale, [
      { id: "T001", requeued: false },
      { id: "T002", requeued: false },
    ]);

    const retried = JSON.parse(p.run([
      "queue", "retry-stale", "T001",
      "--pipeline", "execute",
      "--stage", "wave_3_dispatch",
      "--reason", "manual retry approved",
    ]).stdout);
    assert.equal(retried.task.status, "pending");
    assert.equal(retried.task.claimed_by, null);

    const parked = JSON.parse(p.run([
      "queue", "park-stale", "T002",
      "--pipeline", "execute",
      "--stage", "wave_3_dispatch",
      "--reason", "not safe to replay",
    ]).stdout);
    assert.equal(parked.task.status, "failed");
    assert.equal(parked.task.reason, "not safe to replay");
  } finally {
    p.cleanup();
  }
});

test("queue enqueue orders execute work longest-effort-first so the long pole starts first", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "wave.json");
    // Deliberately enqueued shortest-first, XL last — the pathological order
    // that leaves the wave's tail running the XL alone.
    writeFileSync(input, JSON.stringify([
      { id: "T001", effort: "S" },
      { id: "T002", effort: "M" },
      { id: "T003", effort: "XL" },
      { id: "T004", effort: "L" },
    ]));
    p.run(["queue", "enqueue", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--input", input]);

    // claim hands out array order, so claim order proves dispatch order.
    const claimed = [];
    for (let i = 0; i < 4; i++) {
      const out = JSON.parse(p.run([
        "queue", "claim", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--worker", `w${i}`,
      ]).stdout);
      claimed.push(out.task.id);
    }
    assert.deepEqual(claimed, ["T003", "T004", "T002", "T001"]);
  } finally {
    p.cleanup();
  }
});

test("queue enqueue effort ordering is stable and tolerates missing/malformed effort", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "wave.json");
    writeFileSync(input, JSON.stringify([
      { id: "T009" },                    // absent effort → sorts last
      { id: "T002", effort: "bogus" },   // malformed → sorts last, must not throw
      { id: "T007", effort: "L" },
      { id: "T003", effort: "L" },       // same rank as T007 → id tie-break
    ]));
    const res = p.run(["queue", "enqueue", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--input", input]);
    assert.equal(res.code, 0);

    const claimed = [];
    for (let i = 0; i < 4; i++) {
      const out = JSON.parse(p.run([
        "queue", "claim", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--worker", `w${i}`,
      ]).stdout);
      claimed.push(out.task.id);
    }
    assert.deepEqual(claimed, ["T003", "T007", "T002", "T009"]);
  } finally {
    p.cleanup();
  }
});

test("queue enqueue leaves review work in authored order (effort ordering is execute-only)", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "batches.json");
    writeFileSync(input, JSON.stringify([
      { id: "B001", effort: "S" },
      { id: "B002", effort: "XL" },
    ]));
    p.run(["queue", "enqueue", "--pipeline", "review", "--stage", "review_fix_wave_1", "--input", input]);
    const first = JSON.parse(p.run([
      "queue", "claim", "--pipeline", "review", "--stage", "review_fix_wave_1", "--worker", "w1",
    ]).stdout);
    assert.equal(first.task.id, "B001");
  } finally {
    p.cleanup();
  }
});

// AC-6
test("complete_event_carries_claim_attempt_and_kind", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "tasks.json");
    const result = join(p.root, "T001-result.json");
    writeFileSync(input, JSON.stringify([{ id: "T001" }, { id: "T002" }]));
    p.run(["queue", "enqueue", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--input", input]);
    p.run(["queue", "claim", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--worker", "w1"]);
    p.run(["queue", "claim", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--worker", "w2"]);
    writeQueueArtifact(result, "T001");
    p.run(["queue", "complete", "T001", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--worker", "w1", "--result", result]);
    p.run(["queue", "fail", "T002", "--pipeline", "execute", "--stage", "wave_1_dispatch", "--worker", "w2", "--reason", "x"]);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    for (const name of ["worker_queue_completed", "worker_queue_failed"]) {
      const ev = events.find((e) => e.event === name || e.type === name);
      assert.ok(ev, name);
      assert.equal(ev.claim_attempt, 1);
      assert.equal(ev.kind, "work");
    }
  } finally {
    p.cleanup();
  }
});

// AC-6
test("complete_and_failed_events_pair_with_claimed_attempt_2 (claim_attempt)", () => {
  const p = makeProject();
  try {
    const input = join(p.root, "tasks.json");
    const result = join(p.root, "T001-result.json");
    writeFileSync(input, JSON.stringify([{ id: "T001", idempotent: true }, { id: "T002", idempotent: true }]));
    const stage = "wave_1_dispatch";
    const base = ["--pipeline", "execute", "--stage", stage];
    p.run(["queue", "enqueue", ...base, "--input", input]);
    p.run(["queue", "claim", ...base, "--worker", "w1", "--ttl-seconds", "1"]);
    p.run(["queue", "claim", ...base, "--worker", "w2", "--ttl-seconds", "1"]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
    p.run(["queue", "requeue-stale", ...base]);
    p.run(["queue", "claim", ...base, "--worker", "w3"]);
    p.run(["queue", "claim", ...base, "--worker", "w4"]);
    writeQueueArtifact(result, "T001");
    p.run(["queue", "complete", "T001", ...base, "--worker", "w3", "--result", result]);
    p.run(["queue", "fail", "T002", ...base, "--worker", "w4", "--reason", "x"]);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const name = (e) => e.event || e.type;
    for (const [evName, id] of [["worker_queue_completed", "T001"], ["worker_queue_failed", "T002"]]) {
      const ev = events.find((e) => name(e) === evName && e.task === id);
      assert.ok(ev, evName);
      assert.equal(ev.claim_attempt, 2);
      assert.equal(ev.kind, "work");
      const claimed = events.find((e) => name(e) === "worker_queue_claimed" && e.task === id && e.attempt === ev.claim_attempt);
      assert.ok(claimed, `claimed event for ${id} attempt 2`);
      assert.equal(claimed.attempt, ev.claim_attempt);
    }
  } finally {
    p.cleanup();
  }
});
