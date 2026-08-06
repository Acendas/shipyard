#!/usr/bin/env node
/**
 * Durable worker queue for flat Shipyard orchestration.
 *
 * The main /ship-execute or /ship-review command enqueues bounded work and
 * spawns leaf workers. Workers atomically claim one item, write an artifact,
 * and complete/fail the item through this CLI. The queue is intentionally
 * file-backed so completion does not depend on Claude task notifications.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { atomicWrite, logEvent, withLockfile } from "./_hook_lib.mjs";
import { readExecutionIsolation, normalizeIsolationToken } from "./config-read.mjs";

const QUEUE_BASENAME = ".worker-queue.json";
const DEFAULT_TTL_SECONDS = 30 * 60;

function usage() {
  return [
    "shipyard-data queue enqueue --pipeline <ship-execute|ship-review> --stage <stage> --input <json> [--require-isolation <worktree|none>]",
    "shipyard-data queue claim --pipeline <ship-execute|ship-review> --stage <stage> --worker <id> [--ttl-seconds <n>]",
    "shipyard-data queue complete <task-id> --pipeline <p> --stage <stage> --worker <id> --result <path>",
    "shipyard-data queue fail <task-id> --pipeline <p> --stage <stage> --worker <id> --reason <text>",
    "shipyard-data queue list [--pipeline <p>] [--stage <stage>]",
    "shipyard-data queue requeue-stale [--pipeline <p>] [--stage <stage>]",
    "shipyard-data queue retry-stale <task-id> --pipeline <p> --stage <stage> --reason <text>",
    "shipyard-data queue park-stale <task-id> --pipeline <p> --stage <stage> --reason <text>",
  ].join("\n");
}

function queueDir(dataDir) {
  const current = join(dataDir, "sprints", "current");
  return existsSync(current) ? current : dataDir;
}

function queuePath(dataDir) {
  return join(queueDir(dataDir), QUEUE_BASENAME);
}

function lockPath(dataDir) {
  return queuePath(dataDir) + ".lock";
}

function readQueue(dataDir) {
  const path = queuePath(dataDir);
  if (!existsSync(path)) return { version: 1, tasks: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed.tasks)) return { version: 1, tasks: [] };
    return { version: 1, tasks: parsed.tasks };
  } catch {
    throw Object.assign(new Error(`shipyard-data queue: cannot parse ${path}`), { exitCode: 3 });
  }
}

function writeQueue(dataDir, queue) {
  const path = queuePath(dataDir);
  mkdirSync(queueDir(dataDir), { recursive: true });
  atomicWrite(path, `${JSON.stringify({ version: 1, tasks: queue.tasks }, null, 2)}\n`);
}

function flag(args, name, { required = false } = {}) {
  const idx = args.indexOf(name);
  if (idx === -1) {
    if (required) throw Object.assign(new Error(`shipyard-data queue: ${name} is required\n${usage()}`), { exitCode: 2 });
    return null;
  }
  const value = args[idx + 1];
  if (!value || value.startsWith("--")) {
    throw Object.assign(new Error(`shipyard-data queue: ${name} requires a value`), { exitCode: 2 });
  }
  return value;
}

function positional(args) {
  return args.filter((arg, idx) => {
    if (arg.startsWith("--")) return false;
    const prev = args[idx - 1];
    return !prev?.startsWith("--");
  });
}

function normalizePipeline(raw) {
  const p = String(raw ?? "").trim();
  if (p === "execute") return "ship-execute";
  if (p === "review") return "ship-review";
  if (p === "ship-execute" || p === "ship-review") return p;
  throw Object.assign(new Error(`shipyard-data queue: invalid --pipeline ${raw}`), { exitCode: 2 });
}

function sanitizeId(raw, fallback) {
  return String(raw ?? fallback)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value).split(",").map((v) => v.trim()).filter(Boolean);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeStatus(raw) {
  const status = String(raw ?? "").trim().toUpperCase();
  if (status === "COMPLETE" || status === "BLOCKED") return status;
  throw Object.assign(new Error(`shipyard-data queue complete: artifact status must be COMPLETE or BLOCKED, got ${raw}`), { exitCode: 3 });
}

function taskKey(task) {
  return `${task.pipeline}:${task.stage}:${task.id}`;
}

function withQueue(dataDir, fn) {
  return withLockfile(lockPath(dataDir), () => {
    const queue = readQueue(dataDir);
    const result = fn(queue);
    writeQueue(dataDir, queue);
    return result;
  }, { ttlMs: 60_000, maxRetries: 600 });
}

function tasksFromInput(parsed, { pipeline, stage }) {
  if (Array.isArray(parsed)) return parsed.map((item, idx) => taskFromItem(item, { pipeline, stage, idx }));
  if (Array.isArray(parsed.tasks)) return parsed.tasks.map((item, idx) => taskFromItem(item, { pipeline, stage, idx }));

  if (Array.isArray(parsed.batches)) {
    const waveByBatch = new Map();
    for (const wave of parsed.waves ?? []) {
      const waveNum = Number(wave.wave ?? wave.index ?? wave.iteration ?? 1);
      for (const id of wave.batch_ids ?? []) {
        waveByBatch.set(String(id), waveNum);
        waveByBatch.set(sanitizeId(id, String(id)), waveNum);
      }
    }
    return parsed.batches.map((batch, idx) => {
      const batchId = sanitizeId(batch.id, `batch-${idx + 1}`);
      const wave = waveByBatch.get(batchId);
      const concreteStage = wave && /^review_fix_wave(?:_\d+)?$/.test(stage)
        ? `review_fix_wave_${wave}`
        : stage;
      return taskFromItem({
        ...batch,
        id: batchId,
        kind: batch.kind ?? "review_fix",
        expected_artifact: batch.expected_artifact ?? `review/${batchId}-result.json`,
      }, { pipeline, stage: concreteStage, idx });
    });
  }

  throw Object.assign(new Error("shipyard-data queue enqueue: input must be an array, { tasks: [...] }, or review plan { batches: [...] }"), { exitCode: 2 });
}

function taskFromItem(item, { pipeline, stage, idx = 0 }) {
  const id = sanitizeId(item.id, `work-${idx + 1}`);
  return {
    id,
    pipeline: normalizePipeline(item.pipeline ?? pipeline),
    stage: String(item.stage ?? stage),
    kind: String(item.kind ?? "work"),
    status: "pending",
    files: asList(item.files),
    expected_artifact: item.expected_artifact ? String(item.expected_artifact) : null,
    required_validation: asList(item.required_validation ?? item.required_probes),
    payload: item.payload ?? null,
    source: item.source ? String(item.source) : null,
    idempotent: item.idempotent !== false,
    attempt: Number.isInteger(item.attempt) ? item.attempt : 0,
    claimed_by: null,
    claimed_at: null,
    deadline_at: null,
    completed_at: null,
    failed_at: null,
    result: null,
    artifact_status: null,
    reason: null,
  };
}

function enqueue(dataDir, args) {
  const pipeline = normalizePipeline(flag(args, "--pipeline", { required: true }));
  const stage = flag(args, "--stage", { required: true });
  const input = flag(args, "--input", { required: true });

  // Structural guard against parallel-in-place corruption (isolation review
  // F1), scoped to ship-execute — the WRITE path. The queue is the
  // parallel-dispatch mechanism; enqueuing builders when isolation is off
  // would spawn concurrent writers on one shared checkout that clobber each
  // other, and no downstream gate catches it (verify-wave-integrated passes
  // vacuously with zero shipyard/wt-* branches). ship-review workers are
  // read-only scanners/analysts — parallel is always safe there regardless of
  // isolation — so this guard MUST NOT apply to them.
  //
  // Precedence mirrors resolve-isolation: an explicit --require-isolation (the
  // caller's resolved per-invocation decision, incl. the --isolation false
  // flag that never touches config) wins; otherwise fall back to config's
  // execution.isolation. This makes "sequential-only" a CLI invariant, not a
  // prose request. --require-isolation is validated for every pipeline so a
  // typo still fails loud even on ship-review.
  const requireRaw = flag(args, "--require-isolation");
  let effectiveIsolation = null;
  if (requireRaw != null) {
    effectiveIsolation = normalizeIsolationToken(requireRaw);
    if (effectiveIsolation === null) {
      throw Object.assign(
        new Error(`shipyard-data queue enqueue: invalid --require-isolation "${requireRaw}" — expected true|false|worktree|none`),
        { exitCode: 2 },
      );
    }
  } else if (pipeline === "ship-execute") {
    effectiveIsolation = readExecutionIsolation(dataDir);
  }
  if (pipeline === "ship-execute" && effectiveIsolation === "none") {
    throw Object.assign(
      new Error(
        "shipyard-data queue enqueue: isolation resolves to none (sequential-only) — refusing to enqueue parallel builders. " +
          "Dispatch this wave sequentially in-place (solo shape) instead of via the worker queue.",
      ),
      { exitCode: 2 },
    );
  }

  const parsed = JSON.parse(readFileSync(input, "utf8"));
  const additions = tasksFromInput(parsed, { pipeline, stage });
  let enqueued = 0;

  withQueue(dataDir, (queue) => {
    for (const task of additions) {
      const existingIdx = queue.tasks.findIndex((t) => t.pipeline === task.pipeline && t.stage === task.stage && t.id === task.id);
      if (existingIdx !== -1) {
        const existing = queue.tasks[existingIdx];
        if (["pending", "claimed"].includes(existing.status)) continue;
        queue.tasks[existingIdx] = {
          ...task,
          attempt: Number(existing.attempt ?? 0),
          previous_status: existing.status,
          previous_result: existing.result ?? null,
        };
        enqueued += 1;
        continue;
      }
      queue.tasks.push(task);
      enqueued += 1;
    }
  });

  logEvent(dataDir, "worker_queue_enqueued", { pipeline, stage, count: enqueued });
  process.stdout.write(JSON.stringify({ enqueued, total_input: additions.length }) + "\n");
}

function claim(dataDir, args) {
  const pipeline = normalizePipeline(flag(args, "--pipeline", { required: true }));
  const stage = flag(args, "--stage", { required: true });
  const worker = flag(args, "--worker", { required: true });
  const ttl = Number(flag(args, "--ttl-seconds") ?? DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw Object.assign(new Error("shipyard-data queue claim: --ttl-seconds must be a positive number"), { exitCode: 2 });
  }

  let claimed = null;
  withQueue(dataDir, (queue) => {
    const task = queue.tasks.find((t) => t.pipeline === pipeline && t.stage === stage && t.status === "pending");
    if (!task) return;
    const now = Date.now();
    task.status = "claimed";
    task.claimed_by = worker;
    task.claimed_at = new Date(now).toISOString();
    task.deadline_at = new Date(now + ttl * 1000).toISOString();
    task.attempt = Number(task.attempt ?? 0) + 1;
    claimed = { ...task };
  });

  if (claimed) {
    logEvent(dataDir, "worker_queue_claimed", {
      pipeline,
      stage,
      task: claimed.id,
      worker,
      attempt: claimed.attempt,
      deadline_at: claimed.deadline_at,
    });
    process.stdout.write(JSON.stringify({ claimed: true, task: claimed }) + "\n");
  } else {
    process.stdout.write(JSON.stringify({ claimed: false, pipeline, stage }) + "\n");
  }
}

function resolveTaskSelector(args, command) {
  const [id] = positional(args);
  const pipelineRaw = flag(args, "--pipeline");
  const stage = flag(args, "--stage");
  if (!id) throw Object.assign(new Error(`shipyard-data queue ${command}: task id is required\n${usage()}`), { exitCode: 2 });
  return {
    id,
    pipeline: pipelineRaw ? normalizePipeline(pipelineRaw) : null,
    stage,
  };
}

function findTask(queue, selector, command) {
  const matches = queue.tasks.filter((task) => {
    if (task.id !== selector.id) return false;
    if (selector.pipeline && task.pipeline !== selector.pipeline) return false;
    if (selector.stage && task.stage !== selector.stage) return false;
    return true;
  });
  if (matches.length === 0) {
    const suffix = selector.pipeline || selector.stage ? ` (${selector.pipeline ?? "any pipeline"} ${selector.stage ?? "any stage"})` : "";
    throw Object.assign(new Error(`shipyard-data queue ${command}: unknown task ${selector.id}${suffix}`), { exitCode: 4 });
  }
  if (matches.length > 1) {
    throw Object.assign(new Error(`shipyard-data queue ${command}: task id ${selector.id} is ambiguous; pass --pipeline and --stage`), { exitCode: 2 });
  }
  return matches[0];
}

function expectedArtifactPath(dataDir, task) {
  if (!task.expected_artifact) return null;
  return isAbsolute(task.expected_artifact)
    ? resolve(task.expected_artifact)
    : resolve(queueDir(dataDir), task.expected_artifact);
}

function validateArtifact(dataDir, task, result) {
  const expected = expectedArtifactPath(dataDir, task);
  if (expected && resolve(result) !== expected) {
    throw Object.assign(new Error(`shipyard-data queue complete: result artifact must match expected_artifact for ${taskKey(task)}: ${expected}`), { exitCode: 3 });
  }

  let artifact;
  try {
    artifact = JSON.parse(readFileSync(result, "utf8"));
  } catch {
    throw Object.assign(new Error(`shipyard-data queue complete: result artifact is not parseable JSON: ${result}`), { exitCode: 3 });
  }
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    throw Object.assign(new Error(`shipyard-data queue complete: result artifact must be a JSON object: ${result}`), { exitCode: 3 });
  }

  const artifactId = artifact.task ?? artifact.task_id ?? artifact.batch_id;
  if (String(artifactId ?? "") !== task.id) {
    throw Object.assign(new Error(`shipyard-data queue complete: result artifact id ${artifactId ?? "(missing)"} does not match ${task.id}`), { exitCode: 3 });
  }
  const status = normalizeStatus(artifact.status);

  const required = ["probe_exit_code", "output_tail", "capture_file"];
  if (task.pipeline === "ship-execute") required.push("escalation_code");
  if (status === "COMPLETE") required.push("commit_sha");
  const missing = required.filter((field) => {
    if (field === "escalation_code") return artifact[field] === undefined;
    return artifact[field] === undefined || artifact[field] === null || artifact[field] === "";
  });
  if (missing.length) {
    throw Object.assign(new Error(`shipyard-data queue complete: result artifact missing required field(s): ${missing.join(", ")}`), { exitCode: 3 });
  }
  if (!Number.isInteger(Number(artifact.probe_exit_code))) {
    throw Object.assign(new Error("shipyard-data queue complete: result artifact probe_exit_code must be an integer"), { exitCode: 3 });
  }
  if (typeof artifact.output_tail !== "string" || artifact.output_tail.trim() === "") {
    throw Object.assign(new Error("shipyard-data queue complete: result artifact output_tail must be a non-empty string"), { exitCode: 3 });
  }
  if (typeof artifact.capture_file !== "string" || !isAbsolute(artifact.capture_file) || !existsSync(artifact.capture_file)) {
    throw Object.assign(new Error("shipyard-data queue complete: result artifact capture_file must be an existing absolute path"), { exitCode: 3 });
  }
  return { status };
}

function complete(dataDir, args) {
  const selector = resolveTaskSelector(args, "complete");
  const worker = flag(args, "--worker", { required: true });
  const result = flag(args, "--result", { required: true });
  if (!isAbsolute(result)) {
    throw Object.assign(new Error(`shipyard-data queue complete: --result must be an absolute path: ${result}`), { exitCode: 2 });
  }
  if (!existsSync(result)) {
    throw Object.assign(new Error(`shipyard-data queue complete: result artifact does not exist: ${result}`), { exitCode: 3 });
  }

  let updated;
  withQueue(dataDir, (queue) => {
    const task = findTask(queue, selector, "complete");
    if (task.status !== "claimed") {
      throw Object.assign(new Error(`shipyard-data queue complete: task ${taskKey(task)} is ${task.status}, not claimed`), { exitCode: 3 });
    }
    if (task.claimed_by !== worker) {
      throw Object.assign(new Error(`shipyard-data queue complete: task ${taskKey(task)} is claimed by ${task.claimed_by}, not ${worker}`), { exitCode: 3 });
    }
    const artifact = validateArtifact(dataDir, task, result);
    task.status = "complete";
    task.completed_at = nowIso();
    task.result = result;
    task.artifact_status = artifact.status;
    updated = { ...task };
  });

  logEvent(dataDir, "worker_queue_completed", {
    pipeline: updated.pipeline,
    stage: updated.stage,
    task: updated.id,
    worker,
    result,
    artifact_status: updated.artifact_status,
  });
  process.stdout.write(JSON.stringify({ completed: true, task: updated }) + "\n");
}

function fail(dataDir, args) {
  const selector = resolveTaskSelector(args, "fail");
  const worker = flag(args, "--worker", { required: true });
  const reason = flag(args, "--reason", { required: true });

  let updated;
  withQueue(dataDir, (queue) => {
    const task = findTask(queue, selector, "fail");
    if (task.status !== "claimed") {
      throw Object.assign(new Error(`shipyard-data queue fail: task ${taskKey(task)} is ${task.status}, not claimed`), { exitCode: 3 });
    }
    if (task.claimed_by !== worker) {
      throw Object.assign(new Error(`shipyard-data queue fail: task ${taskKey(task)} is claimed by ${task.claimed_by}, not ${worker}`), { exitCode: 3 });
    }
    task.status = "failed";
    task.failed_at = nowIso();
    task.reason = reason;
    updated = { ...task };
  });

  logEvent(dataDir, "worker_queue_failed", {
    pipeline: updated.pipeline,
    stage: updated.stage,
    task: updated.id,
    worker,
    reason,
  });
  process.stdout.write(JSON.stringify({ failed: true, task: updated }) + "\n");
}

function retryStale(dataDir, args) {
  const selector = resolveTaskSelector(args, "retry-stale");
  const reason = flag(args, "--reason", { required: true });
  let updated;
  withQueue(dataDir, (queue) => {
    const task = findTask(queue, selector, "retry-stale");
    if (task.status !== "stale") {
      throw Object.assign(new Error(`shipyard-data queue retry-stale: task ${taskKey(task)} is ${task.status}, not stale`), { exitCode: 3 });
    }
    task.status = "pending";
    task.claimed_by = null;
    task.claimed_at = null;
    task.deadline_at = null;
    task.reason = reason;
    updated = { ...task };
  });
  logEvent(dataDir, "worker_queue_stale_retried", {
    pipeline: updated.pipeline,
    stage: updated.stage,
    task: updated.id,
    reason,
  });
  process.stdout.write(JSON.stringify({ retried: true, task: updated }) + "\n");
}

function parkStale(dataDir, args) {
  const selector = resolveTaskSelector(args, "park-stale");
  const reason = flag(args, "--reason", { required: true });
  let updated;
  withQueue(dataDir, (queue) => {
    const task = findTask(queue, selector, "park-stale");
    if (task.status !== "stale") {
      throw Object.assign(new Error(`shipyard-data queue park-stale: task ${taskKey(task)} is ${task.status}, not stale`), { exitCode: 3 });
    }
    task.status = "failed";
    task.failed_at = nowIso();
    task.reason = reason;
    updated = { ...task };
  });
  logEvent(dataDir, "worker_queue_stale_parked", {
    pipeline: updated.pipeline,
    stage: updated.stage,
    task: updated.id,
    reason,
  });
  process.stdout.write(JSON.stringify({ parked: true, task: updated }) + "\n");
}

function list(dataDir, args) {
  const pipeline = flag(args, "--pipeline");
  const stage = flag(args, "--stage");
  const queue = readQueue(dataDir);
  const tasks = queue.tasks.filter((task) => {
    if (pipeline && task.pipeline !== normalizePipeline(pipeline)) return false;
    if (stage && task.stage !== stage) return false;
    return true;
  });
  process.stdout.write(JSON.stringify({ tasks }, null, 2) + "\n");
}

function requeueStale(dataDir, args) {
  const pipelineRaw = flag(args, "--pipeline");
  const pipeline = pipelineRaw ? normalizePipeline(pipelineRaw) : null;
  const stage = flag(args, "--stage");
  const now = Date.now();
  const stale = [];

  withQueue(dataDir, (queue) => {
    for (const task of queue.tasks) {
      if (pipeline && task.pipeline !== pipeline) continue;
      if (stage && task.stage !== stage) continue;
      if (task.status !== "claimed" || !task.deadline_at) continue;
      if (Date.parse(task.deadline_at) > now) continue;
      if (task.idempotent !== true) {
        task.status = "stale";
        stale.push({ id: task.id, requeued: false });
        continue;
      }
      task.status = "pending";
      task.claimed_by = null;
      task.claimed_at = null;
      task.deadline_at = null;
      stale.push({ id: task.id, requeued: true });
    }
  });

  logEvent(dataDir, "worker_queue_stale_requeued", {
    pipeline: pipeline ?? "all",
    stage: stage ?? "all",
    count: stale.length,
  });
  process.stdout.write(JSON.stringify({ stale }) + "\n");
}

export function queueCmd(dataDir, args) {
  const sub = args[0];
  try {
    if (sub === "enqueue") return enqueue(dataDir, args.slice(1));
    if (sub === "claim") return claim(dataDir, args.slice(1));
    if (sub === "complete") return complete(dataDir, args.slice(1));
    if (sub === "fail") return fail(dataDir, args.slice(1));
    if (sub === "list") return list(dataDir, args.slice(1));
    if (sub === "requeue-stale") return requeueStale(dataDir, args.slice(1));
    if (sub === "retry-stale") return retryStale(dataDir, args.slice(1));
    if (sub === "park-stale") return parkStale(dataDir, args.slice(1));
    throw Object.assign(new Error(`shipyard-data queue: unknown subcommand "${sub ?? ""}"\n${usage()}`), { exitCode: 2 });
  } catch (err) {
    if (err.exitCode) {
      process.stderr.write(err.message + "\n");
      process.exit(err.exitCode);
    }
    throw err;
  }
}
