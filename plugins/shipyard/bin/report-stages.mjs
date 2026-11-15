/**
 * `shipyard-data report stages` — F012: stage shares and the v4.1 decision.
 *
 * Shows each stage class as a share of ACTIVE time, per finished sprint and
 * as a median, then applies the (provisional) decision rule for E003:
 * median boundary-class share >= 25% recommends building overlap review.
 *
 * Attribution (AC-1, AC-3, AC-13):
 *   - A sprint owns the time range [min(started_at, first event tagged with
 *     its id), max(completed_at, last tagged event)]; ranges never overlap
 *     (each is cut at the next sprint's start). Time outside every range is
 *     "between sprints".
 *   - Inside a range the timeline is cut at every pipeline_tick_completed
 *     and pipeline_terminal; the segment after a tick belongs to the class of
 *     that tick's next_stage (STAGE_SHARE_CLASS). Time before the first tick
 *     and time after a pipeline_terminal (no stage running) is "other".
 *   - Active time inside a segment is the shared activeTime() (never
 *     redefined here). Builder claims that straddle a cut are clipped to the
 *     segment with synthetic claim/complete markers at the cut, so the sum of
 *     segment active time equals activeTime() over the whole log.
 *   - Time a segment is active ONLY because a builder claim covers it (no
 *     event within the gap threshold) attributes to "waiting" (AC-3).
 *   - Silent = span - active per segment; reported as a share of wall-clock,
 *     broken down by the class it fell in plus "between sprints", and never
 *     mixed into active shares (AC-13).
 *
 * Read-only except `--write-doc <path>` (AC-12).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { readEvents, activeTime, DEFAULT_GAP_MS } from "./event-report.mjs";
import { normalizeStage, knownStages, PIPELINES } from "./pipeline-stages.mjs";
import { parseFrontmatter } from "./terminal-gate.mjs";

export const CLASSES = Object.freeze(["boundary", "waiting", "dispatch", "redispatch", "review", "other"]);
export const BETWEEN = "between_sprints";
export const MIN_SPRINTS = 3;
export const BOUNDARY_BAR = 0.25;
const TICK = "pipeline_tick_completed";
const TERMINAL = "pipeline_terminal";
const CLAIM_TYPES = new Set(["worker_queue_claimed", "worker_queue_completed", "worker_queue_failed"]);

export const FORMULA =
  "class share = active time in segments of that class / active time in all of the sprint's segments " +
  "(segments cut at pipeline_tick_completed, class per STAGE_SHARE_CLASS of next_stage; active time per activeTime(); " +
  "builder-claim-only time attributes to waiting; silent = span - active, reported against wall-clock, never in shares)";

/**
 * Stage-share classes (AC-2). Keyed by pipeline, then normalized stage key.
 * Every stage in pipeline-stages.mjs must appear exactly once;
 * missingStageClasses() and the fixture test enforce it.
 * Every ship-review stage is "review" (AC-2), so that side is derived.
 */
export const STAGE_SHARE_CLASS = Object.freeze({
  "ship-execute": Object.freeze({
    // setup and terminal stages carry no pipelining signal
    preflight: "other",
    salvage: "other",
    load: "other",
    readiness: "other",
    terminal_handoff_to_review: "other",
    terminal_hotfix: "other",
    terminal_single_task: "other",
    // dispatch: builders being started or recovered
    wave_dispatch: "dispatch",
    wave_recovery: "dispatch",
    hotfix: "dispatch",
    single_task: "dispatch",
    // waiting on builders
    wave_waiting: "waiting",
    // redispatch: fix iterations after a verify/build/test finding
    wave_redispatch_iter: "redispatch",
    wave_build_fix_iter: "redispatch",
    wave_tests_fix_iter: "redispatch",
    sprint_tests_fix_iter: "redispatch",
    // boundary-class: merge, build, test, verify, gate, refactor
    wave_boundary: "boundary",
    wave_build: "boundary",
    wave_refactor: "boundary",
    wave_tests: "boundary",
    wave_verify: "boundary",
    wave_gate: "boundary",
    sprint_code_review: "review",
    sprint_refactor: "boundary",
    sprint_full_build: "boundary",
    sprint_full_tests: "boundary",
    sprint_demo_probes: "boundary",
    sprint_complete_gate: "boundary",
  }),
  "ship-review": Object.freeze(Object.fromEntries(knownStages("ship-review").map((k) => [k, "review"]))),
});

/** Class for a concrete stage name, or null when the stage is unknown. */
export function stageShareClass(pipeline, stage) {
  const n = normalizeStage(pipeline, stage);
  if (!n) return null;
  const cls = STAGE_SHARE_CLASS[pipeline]?.[n.key];
  return cls && CLASSES.includes(cls) ? cls : null;
}

/** `pipeline:key` entries of pipeline-stages.mjs with no (valid) class. */
export function missingStageClasses(map = STAGE_SHARE_CLASS) {
  const out = [];
  for (const p of PIPELINES) {
    for (const k of knownStages(p)) {
      const cls = map[p]?.[k];
      if (!cls || !CLASSES.includes(cls)) out.push(`${p}:${k}`);
    }
  }
  return out;
}

export function median(values) {
  const v = values.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

const tsOf = (e) => Date.parse(e.ts);
const parseTs = (s) => (typeof s === "string" && Number.isFinite(Date.parse(s)) ? Date.parse(s) : null);
const zeroByClass = () => Object.fromEntries(CLASSES.map((c) => [c, 0]));

/** Closed builder claims as [openIdx, closeIdx] with the same pairing as activeTime(). */
function closedClaims(evs) {
  const open = new Map();
  const pairs = [];
  evs.forEach((e, i) => {
    const k = `${e.task}|${e.worker}`;
    if (e.type === "worker_queue_claimed") open.set(k, i);
    else if ((e.type === "worker_queue_completed" || e.type === "worker_queue_failed") && open.has(k)) {
      pairs.push({ openIdx: open.get(k), closeIdx: i, task: e.task, worker: e.worker });
      open.delete(k);
    }
  });
  return pairs;
}

/** Segment events plus claims clipped to the segment at the cut events. */
function segmentEvents(evs, pairs, i, j) {
  const seg = evs.slice(i, j + 1);
  for (const p of pairs) {
    if (p.openIdx < i && p.closeIdx > i) {
      seg.push({ ts: evs[i].ts, type: "worker_queue_claimed", task: p.task, worker: p.worker });
    }
    if (p.openIdx < j && p.closeIdx > j) {
      seg.push({ ts: evs[j].ts, type: "worker_queue_completed", task: p.task, worker: p.worker });
    }
  }
  return seg;
}

/**
 * @param events raw events (any order; invalid ts skipped)
 * @param corrupt corrupt-line count from readEvents
 * @param opts.sprints [{id, startedAt?: ISO|ms, completedAt?: ISO|ms}] the sprints in scope
 * @param opts.gapMs silent threshold (default DEFAULT_GAP_MS)
 */
export function computeStagesReport(events, corrupt = 0, opts = {}) {
  const gapMs = opts.gapMs ?? DEFAULT_GAP_MS;
  const evs = events.filter((e) => Number.isFinite(tsOf(e))).sort((a, b) => tsOf(a) - tsOf(b));
  const n = evs.length;
  const T = evs.map(tsOf);
  const wallMs = n >= 2 ? T[n - 1] - T[0] : 0;

  // Sprint ranges: [min(started_at, first tagged), max(completed_at, last tagged)], non-overlapping.
  const ranges = [];
  for (const s of opts.sprints || []) {
    const tagged = [];
    evs.forEach((e, i) => { if (e.sprint === s.id) tagged.push(i); });
    const sa = typeof s.startedAt === "number" ? s.startedAt : parseTs(s.startedAt);
    const ca = typeof s.completedAt === "number" ? s.completedAt : parseTs(s.completedAt);
    const starts = [sa, tagged.length ? T[tagged[0]] : null].filter((x) => x != null);
    const ends = [ca, tagged.length ? T[tagged[tagged.length - 1]] : null].filter((x) => x != null);
    if (!starts.length || !ends.length) { ranges.push({ id: s.id, noData: true, startedAt: sa, completedAt: ca }); continue; }
    ranges.push({ id: s.id, startedAt: sa, completedAt: ca, start: Math.min(...starts), end: Math.max(...ends) });
  }
  const live = ranges.filter((r) => !r.noData).sort((a, b) => a.start - b.start);
  for (let k = 0; k < live.length; k++) {
    if (k + 1 < live.length) live[k].end = Math.min(live[k].end, live[k + 1].start);
    const r = live[k];
    r.startIdx = T.findIndex((t) => t >= r.start);
    let endIdx = -1;
    for (let i = n - 1; i >= 0; i--) if (T[i] <= r.end) { endIdx = i; break; }
    r.endIdx = endIdx;
    if (r.startIdx < 0 || endIdx < 0 || r.startIdx > endIdx) r.noData = true;
  }
  for (let k = 0; k + 1 < live.length; k++) {
    const a = live[k], b = live[k + 1];
    if (!a.noData && !b.noData && a.endIdx > b.startIdx) a.endIdx = b.startIdx;
  }
  const inScope = live.filter((r) => !r.noData);

  // Ticks, terminals and cuts.
  const tickIdx = [];
  const markIdx = [];
  evs.forEach((e, i) => {
    if (e.type === TICK) { tickIdx.push(i); markIdx.push(i); }
    else if (e.type === TERMINAL) markIdx.push(i);
  });
  const cuts = new Set();
  if (n >= 2) { cuts.add(0); cuts.add(n - 1); }
  for (const r of inScope) {
    cuts.add(r.startIdx); cuts.add(r.endIdx);
    for (const i of markIdx) if (i >= r.startIdx && i <= r.endIdx) cuts.add(i);
  }
  const cutList = [...cuts].sort((a, b) => a - b);
  const pairs = closedClaims(evs);

  const bySprint = new Map(inScope.map((r) => [r.id, {
    ms: zeroByClass(), silentByClass: zeroByClass(), activeMs: 0, silentMs: 0, spanMs: 0,
    ticks: { total: 0, execute: 0, review: 0, unclassified: 0 },
  }]));
  const silentByClass = { ...zeroByClass(), [BETWEEN]: 0 };
  let totalActive = 0;
  let totalSilent = 0;
  let betweenActiveMs = 0;
  const coverage = { ticksTotal: 0, ticksClassified: 0, corrupt, unknownStages: new Map() };

  for (const r of inScope) {
    const acc = bySprint.get(r.id);
    for (const i of tickIdx) {
      if (i < r.startIdx || i > r.endIdx) continue;
      const e = evs[i];
      acc.ticks.total++;
      coverage.ticksTotal++;
      if (e.pipeline === "ship-execute") acc.ticks.execute++;
      else if (e.pipeline === "ship-review") acc.ticks.review++;
      if (stageShareClass(e.pipeline, e.next_stage)) coverage.ticksClassified++;
      else {
        acc.ticks.unclassified++;
        const key = `${e.pipeline}:${e.next_stage}`;
        coverage.unknownStages.set(key, (coverage.unknownStages.get(key) || 0) + 1);
      }
    }
  }

  for (let k = 0; k + 1 < cutList.length; k++) {
    const i = cutList[k], j = cutList[k + 1];
    const spanMs = T[j] - T[i];
    const seg = segmentEvents(evs, pairs, i, j);
    const full = activeTime(seg, { gapMs }).activeMs;
    const noClaims = activeTime(seg.map((e) => (CLAIM_TYPES.has(e.type) ? { ...e, type: "_claim_marker" } : e)), { gapMs }).activeMs;
    const silent = Math.max(0, spanMs - full);
    totalActive += full;
    totalSilent += silent;
    const r = inScope.find((x) => x.startIdx <= i && j <= x.endIdx);
    if (!r) { silentByClass[BETWEEN] += silent; betweenActiveMs += full; continue; }
    let cls = "other";
    for (let t = markIdx.length - 1; t >= 0; t--) {
      const ti = markIdx[t];
      if (ti > i) continue;
      if (ti < r.startIdx) break;
      if (evs[ti].type === TICK) cls = stageShareClass(evs[ti].pipeline, evs[ti].next_stage) || "other";
      break;
    }
    const acc = bySprint.get(r.id);
    acc.ms.waiting += full - noClaims;
    acc.ms[cls] += noClaims;
    acc.activeMs += full;
    acc.silentByClass[cls] += silent;
    acc.silentMs += silent;
    acc.spanMs += spanMs;
    silentByClass[cls] += silent;
  }

  const sprints = ranges
    .slice()
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.id.localeCompare(b.id))
    .map((r) => {
      if (r.noData || !bySprint.has(r.id)) {
        return { id: r.id, noData: true, measurable: false, startedAt: r.startedAt, completedAt: r.completedAt };
      }
      const acc = bySprint.get(r.id);
      const shares = Object.fromEntries(CLASSES.map((c) => [c, acc.activeMs > 0 ? acc.ms[c] / acc.activeMs : null]));
      return {
        id: r.id, noData: false, startedAt: r.startedAt, completedAt: r.completedAt,
        rangeStart: T[r.startIdx], rangeEnd: T[r.endIdx],
        ms: acc.ms, activeMs: acc.activeMs, spanMs: acc.spanMs, silentMs: acc.silentMs,
        silentByClass: acc.silentByClass, silentShare: acc.spanMs > 0 ? acc.silentMs / acc.spanMs : null,
        shares, ticks: acc.ticks, measurable: acc.ticks.execute > 0,
      };
    });

  const measurable = sprints.filter((s) => s.measurable);
  const medians = Object.fromEntries(CLASSES.map((c) => [c, median(measurable.map((s) => s.shares[c]))]));
  const silentShare = wallMs > 0 ? totalSilent / wallMs : null;

  let decision;
  if (measurable.length < MIN_SPRINTS) {
    decision = { outcome: "undecided", found: measurable.length, finished: sprints.length, needed: MIN_SPRINTS, bar: BOUNDARY_BAR, medianBoundary: medians.boundary };
  } else if (medians.boundary >= BOUNDARY_BAR) {
    decision = { outcome: "overlap", found: measurable.length, finished: sprints.length, needed: MIN_SPRINTS, bar: BOUNDARY_BAR, medianBoundary: medians.boundary };
  } else {
    decision = { outcome: "no_overlap", found: measurable.length, finished: sprints.length, needed: MIN_SPRINTS, bar: BOUNDARY_BAR, medianBoundary: medians.boundary };
  }

  return {
    gapMs, sprints, medians, decision,
    totals: { wallMs, activeMs: totalActive, silentMs: totalSilent, silentShare, silentByClass, betweenActiveMs,
      checkActiveMs: n >= 2 ? activeTime(evs, { gapMs }).activeMs : 0 },
    coverage: { ...coverage, unknownStages: Object.fromEntries(coverage.unknownStages), eventCount: n,
      firstTs: n ? evs[0].ts : null, lastTs: n ? evs[n - 1].ts : null },
  };
}

const pct = (x) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
const hrs = (ms) => `${(ms / 3600000).toFixed(1)}h`;
const pad = (s, w) => String(s).padEnd(w);

export const DECISION_TEXT = Object.freeze({
  overlap: "recommend building overlap review (E003 waves 5.2 and 5.3; F032 / 5.5 follows the same outcome)",
  no_overlap: "recommend only per-feature review (5.1, F028) and the code-review integration (5.4, F031); overlap (5.2, 5.3, 5.5 / F032) not recommended",
  undecided: "undecided",
});

export function decisionLine(d) {
  if (d.outcome === "undecided") {
    return `Decision: undecided — ${d.found} finished sprint${d.found === 1 ? "" : "s"} with pipeline data found` +
      (d.finished !== d.found ? ` (${d.finished} finished in total)` : "") + `, ${d.needed} needed.`;
  }
  return `Decision: median boundary share ${pct(d.medianBoundary)} is ${d.outcome === "overlap" ? "at or above" : "below"} the provisional ${pct(d.bar)} bar → ${DECISION_TEXT[d.outcome]}.`;
}

export function renderStagesReport(r, scope = null) {
  const L = ["# Stage shares report (F012)", "", `Formula: ${FORMULA}`, ""];
  if (scope) L.push(`Scope: ${scope}`);
  L.push(`Gap threshold: ${Math.round(r.gapMs / 60000)} min (silent = no event of any kind for longer; builder claims between ticks count as active)`, "");
  L.push("Per sprint (share of active time):");
  L.push("  " + pad("sprint", 12) + pad("active", 8) + CLASSES.map((c) => pad(c, 11)).join("") + "silent (of sprint wall-clock)");
  if (r.sprints.length === 0) L.push("  (none)");
  for (const s of r.sprints) {
    if (s.noData) { L.push(`  ${pad(s.id, 12)}(no events)`); continue; }
    const row = "  " + pad(s.id, 12) + pad(hrs(s.activeMs), 8) + CLASSES.map((c) => pad(pct(s.shares[c]), 11)).join("") +
      `${pct(s.silentShare)} of ${hrs(s.spanMs)}`;
    L.push(row + (s.measurable ? "" : "   [no ship-execute ticks; excluded from median and decision]"));
  }
  const m = r.sprints.filter((s) => s.measurable).length;
  L.push("  " + pad(`median (${m})`, 12) + pad("", 8) + CLASSES.map((c) => pad(pct(r.medians[c]), 11)).join(""), "");
  const t = r.totals;
  L.push(`Silent time (share of wall-clock, never in active shares): ${pct(t.silentShare)} of ${hrs(t.wallMs)} (active ${hrs(t.activeMs)}, silent ${hrs(t.silentMs)})`);
  L.push("  by class it fell in: " + [...CLASSES, BETWEEN].map((c) => `${c === BETWEEN ? "between sprints" : c}=${hrs(t.silentByClass[c])}`).join("  "));
  for (const s of r.sprints) {
    if (s.noData) continue;
    const parts = CLASSES.filter((c) => s.silentByClass[c] > 0).map((c) => `${c}=${hrs(s.silentByClass[c])}`);
    L.push(`  ${s.id}: ${parts.length ? parts.join("  ") : "none"}`);
  }
  L.push("", "Findings (AC-9):");
  L.push(`  redispatch share of active time: median ${pct(r.medians.redispatch)}` +
    (m ? ` (${r.sprints.filter((s) => s.measurable).map((s) => `${s.id} ${pct(s.shares.redispatch)}`).join(", ")})` : ""));
  L.push(`  silent share of wall-clock: ${pct(t.silentShare)} (between sprints ${hrs(t.silentByClass[BETWEEN])}; active time between sprints ${hrs(t.betweenActiveMs)} is in no sprint's shares)`);
  L.push("", `Decision rule (bar ${pct(BOUNDARY_BAR)} is PROVISIONAL until the user confirms or resets it): with at least ${MIN_SPRINTS} finished sprints, ` +
    `median boundary share of active time >= ${pct(BOUNDARY_BAR)} → build overlap review (E003 waves 5.2, 5.3; F032 / 5.5 follows); below → only 5.1 (F028) and 5.4 (F031).`);
  L.push(decisionLine(r.decision));
  const c = r.coverage;
  L.push("", `Data coverage: ${c.eventCount} events from ${c.firstTs ?? "n/a"} to ${c.lastTs ?? "n/a"}; ` +
    `${c.ticksClassified}/${c.ticksTotal} pipeline ticks in scope map to a stage class; ` +
    `${c.corrupt} corrupt log line${c.corrupt === 1 ? "" : "s"} skipped; ` +
    `attribution check ${t.activeMs === t.checkActiveMs ? "ok" : `MISMATCH (segments ${hrs(t.activeMs)} vs whole log ${hrs(t.checkActiveMs)})`}`);
  const unknown = Object.entries(c.unknownStages);
  if (unknown.length) L.push("  unclassified ticks: " + unknown.map(([k, v]) => `${k} x${v}`).join(", "));
  const missing = missingStageClasses();
  if (missing.length) L.push("  WARNING: stages in pipeline-stages.mjs with no share class: " + missing.join(", "));
  return L.join("\n") + "\n";
}

/** Markdown decision record (AC-7). Hand-finished after generation. */
export function renderDecisionDoc(r, { date, project = "(project)", scope = "finished sprints" } = {}) {
  const d = date || new Date().toISOString().slice(0, 10);
  const L = [
    "---", "type: reference", "status: active", "scope: shipyard", `updated: ${d}`, "references:",
    "  - docs/references/shipyard/event-schema.md",
    "  - shipyard/plugins/shipyard/bin/report-stages.mjs",
    "---", "",
    "# v4.1 pipelining decision (F012)", "",
    `Generated ${d} by \`shipyard-data report stages\` over ${scope} of ${project}.`, "",
    "## Decision", "", decisionLine(r.decision), "",
    `The ${pct(BOUNDARY_BAR)} bar is provisional. This is a recommendation: the user confirms it, and E003 is updated through \`/ship-discuss\`. No epic or feature file is edited automatically.`, "",
    "## Shares of active time", "",
    "| Sprint | Active | " + CLASSES.join(" | ") + " | Silent (of sprint wall-clock) | In median |", "|---|---:|" + CLASSES.map(() => "---:").join("|") + "|---:|---|",
  ];
  for (const s of r.sprints) {
    if (s.noData) { L.push(`| ${s.id} | no events | ${CLASSES.map(() => "").join(" | ")} | | no |`); continue; }
    L.push(`| ${s.id} | ${hrs(s.activeMs)} | ${CLASSES.map((c) => pct(s.shares[c])).join(" | ")} | ${pct(s.silentShare)} of ${hrs(s.spanMs)} | ${s.measurable ? "yes" : "no (no ship-execute ticks)"} |`);
  }
  L.push(`| median | | ${CLASSES.map((c) => pct(r.medians[c])).join(" | ")} | | |`, "");
  const t = r.totals;
  L.push("## Silent time", "",
    `${pct(t.silentShare)} of ${hrs(t.wallMs)} wall-clock (active ${hrs(t.activeMs)}, silent ${hrs(t.silentMs)}), never counted in the shares above. By the class it fell in:`, "",
    "| Class | Silent |", "|---|---:|");
  for (const c of [...CLASSES, BETWEEN]) L.push(`| ${c === BETWEEN ? "between sprints" : c} | ${hrs(t.silentByClass[c])} |`);
  const cv = r.coverage;
  L.push("", "## Data coverage", "",
    `- ${cv.eventCount} events from ${cv.firstTs} to ${cv.lastTs}; ${cv.ticksClassified}/${cv.ticksTotal} pipeline ticks in scope map to a stage class; ${cv.corrupt} corrupt lines skipped.`,
    `- Gap threshold ${Math.round(r.gapMs / 60000)} min. Attribution check: ${t.activeMs === t.checkActiveMs ? "segment sum equals whole-log active time" : "MISMATCH"}.`,
    `- Findings (AC-9): redispatch share median ${pct(r.medians.redispatch)}; silent share ${pct(t.silentShare)}. See IDEA-001 and IDEA-002.`, "");
  return L.join("\n");
}

function readSprintFile(path) {
  try {
    const fm = parseFrontmatter(readFileSync(path, "utf8"));
    const id = (fm.id || "").trim();
    return id ? { id, status: (fm.status || "").trim(), startedAt: fm.started_at || null, completedAt: fm.completed_at || null } : null;
  } catch {
    return null;
  }
}

/** Archived sprints (SPRINT.md under sprints/<id>, never sprints/current) with status completed, in id order. */
export function finishedSprints(dataDir) {
  const dir = join(dataDir, "sprints");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "current")
    .map((d) => d.name)
    .sort()
    .map((d) => readSprintFile(join(dir, d, "SPRINT.md")))
    .filter((s) => s && s.status === "completed");
}

/** One sprint by id: archived dir first, then sprints/current when its id matches, else tagged events only. */
export function sprintById(dataDir, id) {
  const archived = readSprintFile(join(dataDir, "sprints", id, "SPRINT.md"));
  if (archived) return archived;
  const current = readSprintFile(join(dataDir, "sprints", "current", "SPRINT.md"));
  if (current && current.id === id) return current;
  return { id, status: "unknown", startedAt: null, completedAt: null };
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : null;
}

/** `report stages [--all | --sprint <id>] [--gap <minutes>] [--write-doc <path>]` */
export function reportMain(dataDir, args = []) {
  const gapArg = argValue(args, "--gap");
  let gapMs = DEFAULT_GAP_MS;
  if (gapArg != null) {
    const g = Number(gapArg);
    if (!Number.isFinite(g) || g <= 0) throw new Error(`--gap expects a positive number of minutes, got "${gapArg}"`);
    gapMs = g * 60000;
  }
  const sprintId = argValue(args, "--sprint");
  const sprints = sprintId ? [sprintById(dataDir, sprintId)] : finishedSprints(dataDir);
  const scope = sprintId ? `sprint ${sprintId}` : `finished sprints (archived SPRINT.md with status completed): ${sprints.map((s) => s.id).join(", ") || "none"}`;
  const { events, corrupt } = readEvents(dataDir);
  const r = computeStagesReport(events, corrupt, { sprints, gapMs });
  process.stdout.write(renderStagesReport(r, scope));
  const docPath = argValue(args, "--write-doc");
  if (docPath) {
    mkdirSync(dirname(docPath), { recursive: true });
    writeFileSync(docPath, renderDecisionDoc(r, { scope, project: dataDir }), "utf8");
    process.stdout.write(`\nDecision doc written: ${docPath}\n`);
  }
  return r;
}
