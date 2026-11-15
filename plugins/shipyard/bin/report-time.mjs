/**
 * `shipyard-data report time` (F010 AC-6, AC-7, AC-10, AC-19, AC-20).
 *
 * Durations come only from existing events; no start event is ever inferred.
 *   - claim/completion are paired by (task, attempt) only.
 *   - accepted attempt = the one that ended in worker_queue_completed.
 *   - rework = sum over ALL attempts (completed and failed) of the task.
 *   - redispatch minutes are grouped by the `trigger` on the tick event that
 *     entered wave_redispatch_iter; absent -> "trigger unknown" (never guessed).
 */
import { join } from "node:path";
import { readEvents, DEFAULT_GAP_MS } from "./event-report.mjs";
import { currentSprintId } from "./terminal-gate.mjs";
import { normalizeStage } from "./pipeline-stages.mjs";

const min = (ms) => (ms / 60000).toFixed(1);
const tsOf = (e) => Date.parse(e.ts);

const UNKNOWN = "unknown";
const sprintOf = (e) => (typeof e.sprint === "string" && e.sprint.trim() ? e.sprint.trim() : UNKNOWN);
const sep = "\u0000";

/**
 * Scoped by sprint: tasks, waves and review runs are keyed by (sprint, id).
 * Events with no `sprint` field fall into an explicit "unknown" bucket.
 * opts.sprint: keep only that sprint (plus the unknown bucket); omitted = all.
 * @returns {{tasks:Array, waves:Array, reviews:Array, review:object|null, redispatch:object, coverage:object}}
 */
export function computeTimeReport(events, corrupt = 0, opts = {}) {
  const evs = events
    .filter((e) => Number.isFinite(tsOf(e)))
    .filter((e) => !opts.sprint || sprintOf(e) === opts.sprint || sprintOf(e) === UNKNOWN)
    .sort((a, b) => tsOf(a) - tsOf(b));

  // --- tasks: pair (task, attempt); results keyed by (claim sprint, task) ---
  const claims = new Map(); // task -> Map(attempt -> {t, stage, pipeline, sprint})
  const attempts = new Map(); // sprint\0task -> [{attempt, ms, outcome}]
  let claimCount = 0;
  let pairedCount = 0;
  let endedWithAttempt = 0;
  let endedTotal = 0;
  for (const e of evs) {
    if (e.type === "worker_queue_claimed") {
      claimCount++;
      if (!claims.has(e.task)) claims.set(e.task, new Map());
      claims.get(e.task).set(Number(e.attempt ?? 0), { t: tsOf(e), stage: e.stage, pipeline: e.pipeline, sprint: sprintOf(e) });
    } else if (e.type === "worker_queue_completed" || e.type === "worker_queue_failed") {
      endedTotal++;
      const byAttempt = claims.get(e.task);
      if (!byAttempt) continue;
      let key = e.claim_attempt != null ? Number(e.claim_attempt) : null;
      if (key != null) endedWithAttempt++;
      else key = [...byAttempt.keys()].pop(); // legacy event: latest open claim
      const c = byAttempt.get(key);
      if (!c) continue;
      byAttempt.delete(key);
      pairedCount++;
      const ak = c.sprint + sep + e.task;
      if (!attempts.has(ak)) attempts.set(ak, []);
      attempts.get(ak).push({
        attempt: key,
        ms: tsOf(e) - c.t,
        outcome: e.type === "worker_queue_completed" ? "accepted" : "failed",
        stage: c.stage,
        pipeline: c.pipeline,
      });
    }
  }
  const tasks = [];
  for (const [ak, list] of attempts) {
    const [sprint, task] = ak.split(sep);
    const acc = list.filter((a) => a.outcome === "accepted").pop();
    if (!acc) continue;
    const n = normalizeStage(acc.pipeline, acc.stage);
    tasks.push({
      sprint,
      task,
      wave: n?.wave ?? null,
      attempt: acc.attempt,
      durationMs: acc.ms,
      reworkMs: list.reduce((s, a) => s + a.ms, 0),
      attempts: list.length,
    });
  }
  tasks.sort((a, b) => String(a.task).localeCompare(String(b.task)) || a.sprint.localeCompare(b.sprint));

  // --- waves and review: from pipeline_tick_completed, per sprint ---
  const ticks = evs.filter((e) => e.type === "pipeline_tick_completed");
  const waveSpan = new Map(); // sprint\0wave -> span
  const seenWaves = new Set(); // every (sprint, wave) seen in any ship-execute tick
  const touch = (sp, w, t, which) => {
    const k = sp + sep + w;
    seenWaves.add(k);
    const s = waveSpan.get(k) ?? { sprint: sp, wave: Number(w), start: null, end: null };
    if (which === "start") s.start = s.start == null ? t : Math.min(s.start, t);
    else if (which === "end") s.end = s.end == null ? t : Math.max(s.end, t);
    waveSpan.set(k, s);
  };
  for (const e of ticks) {
    if (e.pipeline !== "ship-execute") continue;
    const sp = sprintOf(e);
    const to = normalizeStage(e.pipeline, e.next_stage);
    const from = normalizeStage(e.pipeline, e.stage);
    const fromWave = from?.wave;
    const toWave = to?.wave;
    if (toWave != null && toWave !== fromWave) touch(sp, toWave, tsOf(e), "start");
    else if (toWave != null) touch(sp, toWave, tsOf(e), "seen");
    if (fromWave != null) touch(sp, fromWave, tsOf(e), "end");
  }
  const waves = [...waveSpan.values()]
    .filter((s) => s.start != null && s.end != null && s.end >= s.start)
    .map((s) => ({ sprint: s.sprint, wave: s.wave, durationMs: s.end - s.start }))
    .sort((a, b) => a.sprint.localeCompare(b.sprint) || a.wave - b.wave);

  // review wall-clock per run: per sprint, split where the gap exceeds the active-time gap
  const reviews = [];
  const rvBySprint = new Map();
  for (const e of evs) {
    if (e.pipeline === "ship-review" && e.type.startsWith("pipeline_tick_")) {
      const sp = sprintOf(e);
      if (!rvBySprint.has(sp)) rvBySprint.set(sp, []);
      rvBySprint.get(sp).push(tsOf(e));
    }
  }
  for (const [sp, ts] of [...rvBySprint.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let start = ts[0];
    let prev = ts[0];
    const close = () => { if (prev > start) reviews.push({ sprint: sp, durationMs: prev - start }); };
    for (const t of ts.slice(1)) {
      if (t - prev > DEFAULT_GAP_MS) { close(); start = t; }
      prev = t;
    }
    close();
  }
  const review = reviews.length ? { durationMs: reviews.reduce((s, r) => s + r.durationMs, 0) } : null;

  // --- redispatch by trigger ---
  const byTrigger = new Map();
  const redispatchWaves = new Set();
  let redispatchCount = 0;
  let withTrigger = 0;
  for (let i = 0; i < ticks.length; i++) {
    const e = ticks[i];
    const to = normalizeStage(e.pipeline, e.next_stage);
    if (to?.key !== "wave_redispatch_iter") continue;
    redispatchCount++;
    const sp = sprintOf(e);
    const trigger = e.trigger ? String(e.trigger) : "trigger unknown";
    if (e.trigger) withTrigger++;
    if (to.wave != null) {
      const k = sp + sep + to.wave;
      redispatchWaves.add(k);
      seenWaves.add(k); // a redispatched wave is a wave seen, even with no entering tick
    }
    // time in the stage = until the next tick of the same sprint that leaves that stage name
    const exit = ticks.slice(i + 1).find((x) => x.pipeline === e.pipeline && x.stage === e.next_stage && sprintOf(x) === sp);
    const ms = exit ? tsOf(exit) - tsOf(e) : 0;
    const r = byTrigger.get(trigger) ?? { ms: 0, count: 0 };
    r.ms += ms;
    r.count++;
    byTrigger.set(trigger, r);
  }
  const redispatch = {
    byTrigger: [...byTrigger.entries()].map(([trigger, v]) => ({ trigger, ...v })).sort((a, b) => a.trigger.localeCompare(b.trigger)),
    // numerator and denominator come from one set: redispatchWaves is a subset of seenWaves by construction
    fixPassWaves: redispatchWaves.size,
    totalWaves: seenWaves.size,
  };

  const coverage = { claims: claimCount, paired: pairedCount, endedTotal, endedWithAttempt, redispatchCount, withTrigger, corrupt };
  return { tasks, waves, reviews, review, redispatch, coverage };
}

export function renderTimeReport(r, scope = null) {
  const L = ["# Time report", ""];
  if (scope) L.push(`Scope: ${scope}`, "");
  L.push("Per accepted task (duration = accepted attempt, completed minus claimed; rework = sum over all attempts)");
  if (r.tasks.length === 0) L.push("  (none)");
  for (const t of r.tasks) {
    L.push(`  ${t.task}${t.sprint === UNKNOWN ? " [sprint unknown]" : ` [${t.sprint}]`}  wave=${t.wave ?? "?"}  duration=${min(t.durationMs)}m  rework=${min(t.reworkMs)}m  attempts=${t.attempts}`);
  }
  L.push("", "Per wave (entering the wave to leaving its last stage)");
  if (r.waves.length === 0) L.push("  (none)");
  for (const w of r.waves) L.push(`  wave ${w.wave} [${w.sprint}]: ${min(w.durationMs)}m`);
  L.push("", "Review wall-clock (first to last ship-review tick, per run)");
  if (r.reviews.length === 0) L.push("  (none)");
  for (const v of r.reviews) L.push(`  ${min(v.durationMs)}m [${v.sprint}]`);
  L.push("", "Redispatch minutes by trigger");
  if (r.redispatch.byTrigger.length === 0) L.push("  (none)");
  for (const t of r.redispatch.byTrigger) L.push(`  ${t.trigger}: ${min(t.ms)}m (${t.count} iteration${t.count === 1 ? "" : "s"})`);
  const { fixPassWaves: f, totalWaves: n } = r.redispatch;
  L.push(`  fix-pass share: ${f}/${n} waves${n ? ` (${Math.round((100 * f) / n)}%)` : ""}`);
  const c = r.coverage;
  L.push(
    "",
    `Data coverage: ${c.paired}/${c.claims} dispatches paired claim to completion; ` +
      `${c.endedWithAttempt}/${c.endedTotal} completions carry claim_attempt; ` +
      `${c.withTrigger}/${c.redispatchCount} redispatch iterations carry a trigger; ` +
      `${c.corrupt} corrupt log line${c.corrupt === 1 ? "" : "s"} skipped`,
  );
  return L.join("\n") + "\n";
}


/** `report time [--sprint <id> | --all]`; default = current sprint, else all. */
export function reportMain(dataDir, args = []) {
  const { events, corrupt } = readEvents(dataDir);
  const si = args.indexOf("--sprint");
  let sprint = null;
  if (si >= 0 && args[si + 1]) sprint = args[si + 1];
  else if (!args.includes("--all")) sprint = currentSprintId(dataDir);
  const scope = sprint ? `sprint ${sprint} (plus events with no sprint field)` : "all sprints";
  process.stdout.write(renderTimeReport(computeTimeReport(events, corrupt, { sprint }), scope));
}
