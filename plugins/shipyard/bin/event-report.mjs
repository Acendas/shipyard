/**
 * event-report — pure reader and shared definitions for event reports (F010).
 *
 *   readEvents(dataDir)  archives (date order) then the live log; corrupt
 *                        lines are skipped and counted (AC-13).
 *   activeTime(events)   THE one active/silent-time function (AC-21); F011 and
 *                        F012 import it rather than defining their own.
 *   stageClass / STAGE_CLASS_MAP  the stage-class map F010 owns (AC-9).
 *
 * No printing here; the report dispatcher consumes these.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { EVENTS_LOG_NAME, EVENTS_ARCHIVE_DIR } from "./_hook_lib.mjs";
import { normalizeStage } from "./pipeline-stages.mjs";

export const DEFAULT_GAP_MS = 30 * 60 * 1000;

const ARCHIVE_FILE_RE = /^events-\d{4}-\d{2}-\d{2}\.jsonl$/;

function parseFile(path, out) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let obj = null;
    try { obj = JSON.parse(line); } catch { /* corrupt */ }
    if (obj && typeof obj === "object" && !Array.isArray(obj) && typeof obj.type === "string" && Number.isFinite(Date.parse(obj.ts))) {
      out.events.push(obj);
    } else {
      out.corrupt++;
    }
  }
}

/** Read all archives in date order, then the live log. Marker files are ignored. */
// AC-13
export function readEvents(dataDir) {
  const out = { events: [], corrupt: 0 };
  const dir = join(dataDir, EVENTS_ARCHIVE_DIR);
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter((f) => ARCHIVE_FILE_RE.test(f)).sort();
    for (const f of files) parseFile(join(dir, f), out);
  }
  parseFile(join(dataDir, EVENTS_LOG_NAME), out);
  return out;
}

/**
 * Active vs silent time over a chronologically ordered event list.
 * Active = union of (a) gaps between consecutive events <= gapMs and
 * (b) closed worker_queue_claimed -> worker_queue_completed/failed intervals
 * (builder work between pipeline ticks). Silent = span - active, i.e. time
 * with no event for longer than gapMs and not inside a claim. Unclosed claims
 * add nothing (no evidence the worker was alive).
 * Relation to retro active_minutes: documented in the schema doc (T089).
 * @returns {{activeMs:number, silentMs:number, spanMs:number}}
 */
// AC-21
export function activeTime(events, { gapMs = DEFAULT_GAP_MS } = {}) {
  const ts = [];
  const open = new Map();
  const iv = [];
  for (const e of events) {
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t)) continue;
    ts.push({ t, e });
  }
  ts.sort((a, b) => a.t - b.t);
  if (ts.length < 2) return { activeMs: 0, silentMs: 0, spanMs: 0 };
  for (let i = 1; i < ts.length; i++) {
    if (ts[i].t - ts[i - 1].t <= gapMs) iv.push([ts[i - 1].t, ts[i].t]);
  }
  for (const { t, e } of ts) {
    const k = `${e.task}|${e.worker}`;
    if (e.type === "worker_queue_claimed") open.set(k, t);
    else if ((e.type === "worker_queue_completed" || e.type === "worker_queue_failed") && open.has(k)) {
      iv.push([open.get(k), t]);
      open.delete(k);
    }
    // A sprint built in place has no queue: its builder's span runs from the
    // `builder-<step>` spawn to that step's recorded return.
    const step = e.type === "agent_spawned" && typeof e.step === "string" && e.step.trim() ? `step:${e.step.trim()}` : e.type === "task_return_recorded" && e.task ? `step:${e.task}` : null;
    if (step && e.type === "agent_spawned") { if (!open.has(step)) open.set(step, t); }
    else if (step && open.has(step)) { iv.push([open.get(step), t]); open.delete(step); }
  }
  iv.sort((a, b) => a[0] - b[0]);
  let active = 0;
  let curS = null;
  let curE = null;
  for (const [s, e] of iv) {
    if (curE === null || s > curE) {
      if (curE !== null) active += curE - curS;
      curS = s; curE = e;
    } else if (e > curE) curE = e;
  }
  if (curE !== null) active += curE - curS;
  const spanMs = ts[ts.length - 1].t - ts[0].t;
  return { activeMs: active, silentMs: spanMs - active, spanMs };
}

/** Normalized stage key -> class (dispatch | boundary | setup). Unknown -> "other". */
// AC-9
export const STAGE_CLASS_MAP = Object.freeze({
  // dispatch: builders running or being recovered/redispatched
  wave_dispatch: "dispatch",
  wave_waiting: "dispatch",
  wave_recovery: "dispatch",
  wave_redispatch_iter: "dispatch",
  hotfix: "dispatch",
  single_task: "dispatch",
  // boundary: merge, build, test, verify and gate work between dispatches
  wave_boundary: "boundary",
  wave_build_fix_iter: "boundary",
  wave_build: "boundary",
  wave_refactor: "boundary",
  wave_tests_fix_iter: "boundary",
  wave_tests: "boundary",
  wave_verify: "boundary",
  wave_gate: "boundary",
  sprint_code_review: "review",
  sprint_refactor: "boundary",
  sprint_full_build: "boundary",
  sprint_tests_fix_iter: "boundary",
  sprint_full_tests: "boundary",
  sprint_demo_probes: "boundary",
  sprint_complete_gate: "boundary",
  // setup
  preflight: "setup",
  salvage: "setup",
  load: "setup",
  readiness: "setup",
});

export function stageClass(pipeline, stage) {
  const n = normalizeStage(pipeline, stage);
  return (n && STAGE_CLASS_MAP[n.key]) || "other";
}
