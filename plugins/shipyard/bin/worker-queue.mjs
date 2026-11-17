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
import { atomicWrite, EVENTS_LOG_NAME, logEvent, withLockfile } from "./_hook_lib.mjs";
import { readExecutionIsolation, normalizeIsolationToken, readDispatchOrder } from "./config-read.mjs";

const QUEUE_BASENAME = ".worker-queue.json";
const DEFAULT_TTL_SECONDS = 30 * 60;
// A builder emits task_loop_iteration every cycle; one inside this window means "working, not dead".
const LIVENESS_WINDOW_MS = 15 * 60 * 1000; // one definition of "alive", shared with presumed-dead.mjs DEFAULT_RECENT_MINUTES

function usage() {
  return [
    "shipyard-data queue enqueue --pipeline <ship-execute|ship-review> --stage <stage> --input <json> [--require-isolation <worktree|none>]",
    "shipyard-data queue claim --pipeline <ship-execute|ship-review> --stage <stage> --worker <id> [--task <id>] [--ttl-seconds <n>]",
    "shipyard-data queue complete <task-id> --pipeline <p> --stage <stage> --worker <id> --result <path>",
    "shipyard-data queue fail <task-id> --pipeline <p> --stage <stage> --worker <id> --reason <text>",
    "shipyard-data queue list [--pipeline <p>] [--stage <stage>]",
    "shipyard-data queue requeue-stale [--pipeline <p>] [--stage <stage>]",
    "shipyard-data queue retry-stale <task-id> --pipeline <p> --stage <stage> --reason <text>",
    "shipyard-data queue park-stale <task-id> --pipeline <p> --stage <stage> --reason <text>",
    "shipyard-data queue reconcile <task-id> --pipeline <p> --stage <stage>",
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
  // The id names the step a builder claims. A model wrote `task_id` instead of
  // `id` once (sprint-006, 2026-11-13): three builders claimed `work-1..3`,
  // could not tell which step they held, and were retired. Accept the obvious
  // spellings, and for the execute pipeline refuse an item that names nothing
  // rather than inventing a placeholder a builder cannot act on.
  const rawId = item.id ?? item.task_id ?? item.step_id ?? item.step ?? item.task;
  if (pipeline === "ship-execute" && (rawId === undefined || rawId === null || String(rawId).trim() === "")) {
    throw Object.assign(
      new Error(`shipyard-data queue enqueue: item ${idx + 1} has no id — every ship-execute item needs "id": "<P###|T###>" (task_id / step_id are accepted too)`),
      { exitCode: 2 },
    );
  }
  const id = sanitizeId(rawId, `work-${idx + 1}`);
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
    // Carried for dispatch ordering (see sortForDispatch). Not a gate input.
    effort: item.effort ? String(item.effort).toUpperCase() : null,
    // The wave base this task's branch is cut from. Informational only — the
    // reuse guards derive everything from the queue's completion records.
    base_sha: /^[0-9a-fA-F]{7,40}$/.test(String(item.base_sha ?? "")) ? String(item.base_sha) : null,
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

/**
 * Longest-effort-first ordering, tie-broken by id so the result is stable and
 * reproducible. `claim` hands out the first pending task in array order, so
 * enqueue order IS dispatch order — which makes this the CLI-enforced version
 * of "start the long pole first" rather than a prose request to the model.
 *
 * Why it matters: before 4.18 three builders ran at a time, so a 6-task wave ran in
 * batches. An XL enqueued last means the wave's tail is that XL running alone
 * after everything else drained; enqueued first it overlaps with the short work.
 *
 * Unknown/absent effort sorts LAST (rank 0) rather than throwing — a task file
 * with a malformed `effort:` must not break dispatch. Merge order at the wave
 * boundary is unaffected; that stays task-id order.
 */
const EFFORT_RANK = { XL: 4, L: 3, M: 2, S: 1 };

export function sortForDispatch(tasks) {
  return [...tasks].sort((a, b) => {
    const ra = EFFORT_RANK[a.effort] ?? 0;
    const rb = EFFORT_RANK[b.effort] ?? 0;
    if (ra !== rb) return rb - ra;
    return String(a.id).localeCompare(String(b.id));
  });
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
  let additions = tasksFromInput(parsed, { pipeline, stage });
  // Dispatch ordering is CLI-owned for the same reason isolation is: a prose
  // instruction to "enqueue the long pole first" is not enforcement.
  // ship-review's read-only scanners gain nothing from effort ordering, so this
  // is scoped to the execute pipeline.
  if (pipeline === "ship-execute" && readDispatchOrder(dataDir) === "critical_path") {
    additions = sortForDispatch(additions);
  }
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

  // --task <id>: a worker named after its step claims that step and no other,
  // so the name is a usable address (SendMessage, the agent ledger) — without
  // it a worker called w2-T427 once claimed T425.
  const explicit = flag(args, "--task");
  let claimed = null;
  withQueue(dataDir, (queue) => {
    const pending = queue.tasks.filter((t) => t.pipeline === pipeline && t.stage === stage && t.status === "pending");
    // A worker named after a step claims that step, with or without --task:
    // `builder-T427` (or `w2-T427`) takes T427 when it is pending. This needs
    // no cooperation from the prompt, so a name can never drift from its
    // claim. A worker with any other name takes the next item, as before.
    const named = explicit == null
      ? queue.tasks.find((t) => t.pipeline === pipeline && t.stage === stage && (worker === t.id || worker.endsWith(`-${t.id}`)))
      : null;
    const wanted = explicit ?? named?.id ?? null;
    // A named worker whose step is no longer pending gets nothing — never a different step.
    const task = pending.find((t) => wanted == null || t.id === wanted);
    if (!task) return;
    const now = Date.now();
    task.status = "claimed";
    task.claimed_by = worker;
    task.claimed_at = new Date(now).toISOString();
    task.ttl_seconds = ttl;
    task.deadline_at = new Date(now + ttl * 1000).toISOString();
    task.attempt = Number(task.attempt ?? 0) + 1;
    claimed = { ...task };
  });

  if (claimed) {
    // Record it against THIS worktree so the next claim from here is correctly
    // seen as reuse regardless of queue mutations or worker naming.
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

  // capture_file is optional (4.9.2): the artifact itself carries output_tail,
  // and the CLI-written return (`task-return`) never set the field, so every
  // builder return failed this check unless the builder hand-edited its file.
  // When given, it must still be a real absolute path.
  const required = ["probe_exit_code", "output_tail"];
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
  const hasCapture = artifact.capture_file !== undefined && artifact.capture_file !== null && artifact.capture_file !== "";
  if (hasCapture && (typeof artifact.capture_file !== "string" || !isAbsolute(artifact.capture_file) || !existsSync(artifact.capture_file))) {
    throw Object.assign(new Error("shipyard-data queue complete: result artifact capture_file must be an existing absolute path"), { exitCode: 3 });
  }
  return { status };
}

/**
 * Close the queue item a builder's return belongs to (4.9.2). Called by
 * `task-return`, so a builder records its result with ONE command. Before
 * this a builder needed a second one (`queue complete`), which a worktree
 * sandbox refused in a real sprint: three finished builders were left with
 * claimed items and the unattended sprint stopped to ask its owner.
 * No-op (never throws) when the step has no claimed ship-execute item.
 * @returns {{ settled: boolean, reason?: string, task?: object }}
 */
export function settleFromReturn(dataDir, taskId, artifactPath) {
  let updated = null, reason = "";
  try {
    withQueue(dataDir, (queue) => {
      const mine = queue.tasks.filter((t) => t.pipeline === "ship-execute" && t.id === taskId && t.status === "claimed");
      if (mine.length !== 1) { reason = mine.length ? "ambiguous" : "no_claimed_item"; return; }
      const task = mine[0];
      const artifact = validateArtifact(dataDir, task, artifactPath);
      task.status = "complete";
      task.completed_at = nowIso();
      task.result = artifactPath;
      task.artifact_status = artifact.status;
      updated = { ...task };
    });
  } catch (err) { return { settled: false, reason: String(err?.message ?? err).split("\n")[0] }; }
  if (!updated) return { settled: false, reason };
  try {
    logEvent(dataDir, "worker_queue_completed", { pipeline: updated.pipeline, stage: updated.stage, task: updated.id, worker: updated.claimed_by, result: artifactPath, artifact_status: updated.artifact_status, claim_attempt: updated.attempt, kind: updated.kind, via: "task-return" });
  } catch { /* best-effort */ }
  return { settled: true, task: updated };
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
  let already = false;
  withQueue(dataDir, (queue) => {
    const task = findTask(queue, selector, "complete");
    // `task-return` already closed it with this same artifact (4.9.2): a
    // builder following older instructions repeats the step harmlessly.
    if (task.status === "complete" && task.result && resolve(task.result) === resolve(result)) { already = true; updated = { ...task }; return; }
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

  if (already) { process.stdout.write(JSON.stringify({ completed: true, already: true, task: updated }) + "\n"); return; }
  logEvent(dataDir, "worker_queue_completed", {
    pipeline: updated.pipeline,
    stage: updated.stage,
    task: updated.id,
    worker,
    result,
    artifact_status: updated.artifact_status,
    claim_attempt: updated.attempt,
    kind: updated.kind,
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
    claim_attempt: updated.attempt,
    kind: updated.kind,
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

/**
 * Resolve a `completed_unacked` claim (completion event since the claim, but
 * `queue complete` never landed). Valid .subagent-returns/<task>.json ->
 * status complete (the wrapper then runs the normal recovery gate on it);
 * missing/invalid -> failed with reason completed_unacked_artifact_missing.
 * Only a claimed item classified completed_unacked is accepted, so a live or
 * genuinely dead claim can never be force-completed through here.
 */
function reconcile(dataDir, args) {
  const selector = resolveTaskSelector(args, "reconcile");
  let updated;
  let detail = null;
  withQueue(dataDir, (queue) => {
    const task = findTask(queue, selector, "reconcile");
    // A reconcile that failed only because the artifact was unreadable or
    // incomplete may be run again once the artifact is good (4.9.2): the work
    // was done, and a second look must be able to say so.
    const retry = task.status === "failed" && task.reason === "completed_unacked_artifact_missing";
    if (task.status !== "claimed" && !retry) {
      throw Object.assign(new Error(`shipyard-data queue reconcile: task ${taskKey(task)} is ${task.status}, not claimed`), { exitCode: 3 });
    }
    if (!retry && !isTaskCompletedUnacked(dataDir, task)) {
      throw Object.assign(new Error(`shipyard-data queue reconcile: task ${taskKey(task)} is not completed_unacked (no completion event since its claim)`), { exitCode: 3 });
    }
    const artifactPath = expectedArtifactPath(dataDir, task)
      ?? join(dataDir, "sprints", "current", ".subagent-returns", `${task.id}.json`);
    let artifact = null;
    if (!existsSync(artifactPath)) {
      detail = `missing: ${artifactPath}`;
    } else {
      try {
        artifact = validateArtifact(dataDir, task, artifactPath);
      } catch (err) {
        detail = String(err.message).split("\n")[0];
      }
    }
    if (artifact) {
      task.status = "complete";
      task.completed_at = nowIso();
      task.result = artifactPath;
      task.artifact_status = artifact.status;
      task.reconciled = true;
      delete task.failed_at; delete task.reason; delete task.reason_detail;
    } else {
      task.status = "failed";
      task.failed_at = nowIso();
      task.reason = "completed_unacked_artifact_missing";
      task.reason_detail = detail;
    }
    updated = { ...task };
  });
  if (updated.status === "complete") {
    logEvent(dataDir, "worker_queue_completed", {
      pipeline: updated.pipeline, stage: updated.stage, task: updated.id,
      worker: updated.claimed_by, result: updated.result,
      artifact_status: updated.artifact_status, claim_attempt: updated.attempt,
      kind: updated.kind, reconciled: true,
    });
  } else {
    // worker_queue_failed, not stale_parked: the item IS failed, and activeTime()/
    // `report time` close a claim only on completed|failed (4.3.0 code review).
    logEvent(dataDir, "worker_queue_failed", {
      pipeline: updated.pipeline, stage: updated.stage, task: updated.id,
      worker: updated.claimed_by, claim_attempt: updated.attempt, kind: updated.kind,
      reason: updated.reason, detail, reconciled: true,
    });
  }
  process.stdout.write(JSON.stringify({ reconciled: true, outcome: updated.status, task: updated }) + "\n");
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

/**
 * Read-only liveness check for a claimed queue item. True when the event log
 * shows, since the item was claimed (ts >= claimed_at floored to the second,
 * because event ts has second precision), a task_loop_iteration newer than
 * LIVENESS_WINDOW_MS. Completion events are NOT liveness (see
 * isTaskCompletedUnacked). Events from earlier attempts never count.
 * Never mutates the queue; unreadable log means "no evidence" (not live).
 */
export function isTaskLive(dataDir, task, now = Date.now(), windowMs = LIVENESS_WINDOW_MS) {
  let raw;
  try {
    raw = readFileSync(join(dataDir, EVENTS_LOG_NAME), "utf8");
  } catch {
    return false;
  }
  return isTaskLiveInEvents(parseEventLines(raw, task?.id), task, now, windowMs);
}

function parseEventLines(raw, id) {
  const out = [];
  if (!id) return out;
  for (const line of raw.split("\n")) {
    if (!line.includes(id)) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  return out;
}

/**
 * Pure form of the liveness predicate over an in-memory event array. Shared by
 * isTaskLive and bin/presumed-dead.mjs so there is one definition of "alive".
 */
export function isTaskLiveInEvents(events, task, now = Date.now(), windowMs = LIVENESS_WINDOW_MS) {
  const claimedMs = Date.parse(task?.claimed_at ?? "");
  if (!Number.isFinite(claimedMs)) return false;
  const floor = Math.floor(claimedMs / 1000) * 1000;
  for (const ev of events ?? []) {
    if (!ev || ev.task !== task.id) continue;
    const ts = Date.parse(ev.ts);
    if (!Number.isFinite(ts) || ts < floor) continue;
    if ((ev.type === "task_loop_iteration" || ev.type === "build_gate_waiting") && now - ts <= windowMs) return true;
  }
  return false;
}

/**
 * True when the log shows a completion signal (subagent_completed /
 * task_return_recorded) since the claim. On an item still `claimed` this means
 * the builder finished but `queue complete` never landed (worker died or the
 * CLI refused): not alive, needs reconciliation against the
 * .subagent-returns/<task>.json gate. Shared with bin/presumed-dead.mjs.
 */
export function isTaskCompletedUnackedInEvents(events, task) {
  const claimedMs = Date.parse(task?.claimed_at ?? "");
  if (!Number.isFinite(claimedMs)) return false;
  const floor = Math.floor(claimedMs / 1000) * 1000;
  for (const ev of events ?? []) {
    if (!ev || ev.task !== task.id) continue;
    const ts = Date.parse(ev.ts);
    if (!Number.isFinite(ts) || ts < floor) continue;
    if (ev.type === "subagent_completed" || ev.type === "task_return_recorded") return true;
  }
  return false;
}

/** Read-only dataDir form of isTaskCompletedUnackedInEvents. */
export function isTaskCompletedUnacked(dataDir, task) {
  let raw;
  try {
    raw = readFileSync(join(dataDir, EVENTS_LOG_NAME), "utf8");
  } catch {
    return false;
  }
  return isTaskCompletedUnackedInEvents(parseEventLines(raw, task?.id), task);
}

/** Read-only snapshot of the queue (no lock, no write) for detectors. */
export function readQueueSnapshot(dataDir) {
  return readQueue(dataDir);
}

const MAX_DEADLINE_MS = 120 * 60_000;
/** A worker that keeps asking the build gate for a place is alive; this is how long a claim may live on waiting alone. */
const MAX_WAITING_MS = 8 * 60 * 60_000;

/**
 * Heartbeat renewal: the newest task_loop_iteration since claim pushes the
 * deadline to progress_ts + ttl, capped at claimed_at + min(3 x ttl, 120 min).
 * Only ever moves the deadline later. Returns the (possibly new) deadline ms.
 * `events` (optional) is the task's pre-parsed event list; omitted, the log is read.
 */
export function extendedDeadlineMs(dataDir, task, events) {
  const current = Date.parse(task?.deadline_at ?? "");
  const claimedMs = Date.parse(task?.claimed_at ?? "");
  if (!Number.isFinite(current) || !Number.isFinite(claimedMs)) return current;
  let ttlMs = Number(task.ttl_seconds) * 1000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) ttlMs = current - claimedMs; // legacy item
  if (!(ttlMs > 0)) return current;
  const floor = Math.floor(claimedMs / 1000) * 1000;
  if (events === undefined) {
    let raw;
    try { raw = readFileSync(join(dataDir, EVENTS_LOG_NAME), "utf8"); } catch { return current; }
    events = parseEventLines(raw, task.id);
  }
  let latest = -Infinity;
  let waiting = -Infinity;
  for (const ev of events) {
    if (!ev || ev.task !== task.id) continue;
    const ts = Date.parse(ev.ts);
    if (!Number.isFinite(ts) || ts < floor) continue;
    if (ev.type === "task_loop_iteration") { if (ts > latest) latest = ts; }
    // Waiting at the build gate is not work, and it is not a hang either: the
    // worker asked a moment ago. Time in line does not use up the claim.
    else if (ev.type === "build_gate_waiting" && ts > waiting) waiting = ts;
  }
  const cap = claimedMs + Math.min(3 * ttlMs, MAX_DEADLINE_MS);
  let next = current;
  if (Number.isFinite(latest)) next = Math.max(next, Math.min(latest + ttlMs, cap));
  if (Number.isFinite(waiting)) next = Math.max(next, Math.min(waiting + ttlMs, claimedMs + MAX_WAITING_MS));
  return next;
}

function requeueStale(dataDir, args) {
  const pipelineRaw = flag(args, "--pipeline");
  const pipeline = pipelineRaw ? normalizePipeline(pipelineRaw) : null;
  const stage = flag(args, "--stage");
  const now = Date.now();
  const stale = [];
  const live = [];
  const completedUnacked = [];
  withQueue(dataDir, (queue) => {
    // Read the event log exactly once per pass, INSIDE the queue lock: events
    // appended while this process waited for the lock (heartbeats, completions)
    // must be visible, or a live builder is re-pended / a finished claim goes
    // stale. Reused for the heartbeat extension, completed-unacked and liveness.
    let rawLog = "";
    try { rawLog = readFileSync(join(dataDir, EVENTS_LOG_NAME), "utf8"); } catch { /* no evidence */ }
    for (const task of queue.tasks) {
      if (pipeline && task.pipeline !== pipeline) continue;
      if (stage && task.stage !== stage) continue;
      if (task.status !== "claimed" || !task.deadline_at) continue;
      const events = parseEventLines(rawLog, task.id);
      const extended = extendedDeadlineMs(dataDir, task, events);
      if (Number.isFinite(extended) && extended > Date.parse(task.deadline_at)) {
        task.deadline_at = new Date(extended).toISOString();
      }
      if (Date.parse(task.deadline_at) > now) continue;
      if (isTaskCompletedUnackedInEvents(events, task)) {
        completedUnacked.push({ id: task.id });
        continue;
      }
      if (isTaskLiveInEvents(events, task, now)) {
        live.push({ id: task.id });
        continue;
      }
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
    live: live.length,
    completed_unacked: completedUnacked.length,
  });
  process.stdout.write(JSON.stringify({ stale, live, completed_unacked: completedUnacked }) + "\n");
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
    if (sub === "reconcile") return reconcile(dataDir, args.slice(1));
    throw Object.assign(new Error(`shipyard-data queue: unknown subcommand "${sub ?? ""}"\n${usage()}`), { exitCode: 2 });
  } catch (err) {
    if (err.exitCode) {
      process.stderr.write(err.message + "\n");
      process.exit(err.exitCode);
    }
    throw err;
  }
}
