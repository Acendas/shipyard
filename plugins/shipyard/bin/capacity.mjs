/**
 * `shipyard-data capacity [--points <P>] [--hours <H> | --until <time>] [--json]` (F011)
 *
 * Read-only. One source of truth for the numbers `/ship-sprint` Step 1 and Step 2
 * state, so the planner never estimates AND fits without the calibration check:
 *
 *   - capacity: rolling mean of the last 3 finished sprints' delivered points
 *     (velocity.recent, written by archive-sprint for COMPLETED sprints only, so a
 *     cancelled sprint never counts as finished).
 *   - fit (needs --points P and >= 3 finished sprints): the EMPIRICAL share of
 *     finished sprints whose delivered points were >= P, always shown with n and
 *     min..max. Below 3 sprints there is no percentage, only the honest range.
 *   - calibration: printed whenever a fit is printed (and always as its own line).
 *   - budget: --hours/--until converts to points ONLY through a measured rate
 *     (throughput.recent, written by archive-sprint from the event log), or the
 *     user's `execution.assumed_points_per_hour`, which is labeled as not measured
 *     and never ships with a default. No rate at all -> explain and fall back to
 *     points; nothing is converted from a guess.
 *
 * Exit 2 on a usage error (bad hours, past --until, both a points budget and a
 * time flag). Never writes.
 */
import { loadMetricsState, sortSprintRecords } from "./metrics-state.mjs";
import { readAssumedPointsPerHour } from "./config-read.mjs";

export const MIN_SPRINTS_FOR_FIT = 3;
export const VELOCITY_WINDOW = 3;
export const RATE_WINDOW = 3;

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Finished = completed sprints with a recorded velocity. Cancelled sprints never get one. */
export function finishedSprints(state) {
  return sortSprintRecords(state.velocity.recent).filter((r) => Number.isFinite(Number(r.points)));
}

/**
 * Pure computation. `points` = planned total to rate; `hours` = time budget to
 * convert; `assumedRate` = execution.assumed_points_per_hour (null when unset).
 */
export function computeCapacity(state, { points = null, hours = null, assumedRate = null } = {}) {
  const sprints = finishedSprints(state);
  const pts = sprints.map((r) => Number(r.points));
  const n = pts.length;
  const window = pts.slice(-VELOCITY_WINDOW);
  const capacity = window.length ? Math.round(mean(window)) : null;
  const min = n ? Math.min(...pts) : null;
  const max = n ? Math.max(...pts) : null;
  const avg = n ? round1(mean(pts)) : null;

  let fit = null;
  if (points != null && n >= MIN_SPRINTS_FOR_FIT) {
    const atLeast = pts.filter((p) => p >= points).length;
    fit = { points, percent: Math.round((100 * atLeast) / n), atLeast, n, min, max };
  }

  const rates = sortSprintRecords(state.throughput.recent)
    .map((r) => Number(r.points_per_hour))
    .filter((x) => Number.isFinite(x) && x > 0);
  const measured = rates.length ? { rate: round2(mean(rates.slice(-RATE_WINDOW))), sprints: Math.min(RATE_WINDOW, rates.length) } : null;

  let budget = null;
  if (hours != null) {
    if (measured) budget = { hours, rate: measured.rate, source: "measured", sprints: measured.sprints, points: Math.floor(measured.rate * hours) };
    else if (assumedRate != null) budget = { hours, rate: assumedRate, source: "assumed", sprints: 0, points: Math.floor(assumedRate * hours) };
    else budget = { hours, source: "none" };
  }

  return { n, window: window.length, capacity, min, max, avg, fit, measured, budget };
}

export function renderCapacity(r) {
  const L = [];
  if (r.capacity == null) {
    L.push("Capacity: no finished sprints yet (velocity is recorded by archive-sprint when a completed sprint is archived).");
  } else {
    L.push(`Capacity ~${r.capacity} pts (rolling velocity, last ${r.window} finished sprint${r.window === 1 ? "" : "s"}) — say 'change' to adjust.`);
  }
  if (r.fit) {
    L.push(
      `Fit: ${r.fit.points} pts fits at ${r.fit.percent}% — ${r.fit.atLeast} of the last ${r.fit.n} finished sprints delivered at least ${r.fit.points} pts (range ${r.fit.min} to ${r.fit.max}).`,
    );
  } else if (r.n > 0 && r.n < MIN_SPRINTS_FOR_FIT) {
    L.push(`Fit: ${r.n} finished sprint${r.n === 1 ? "" : "s"}: ${r.min} to ${r.max} pts — no fit percentage until ${MIN_SPRINTS_FOR_FIT} finished sprints exist.`);
  }
  // Calibration always accompanies a stated capacity or fit (AC-8).
  if (r.n > 0) {
    L.push(
      `Calibration: n=${r.n} finished sprint${r.n === 1 ? "" : "s"} (completed, not cancelled), min ${r.min}, max ${r.max}, average ${r.avg} pts; ` +
        (r.measured ? `measured rate ${r.measured.rate} pts/hr over ${r.measured.sprints} sprint${r.measured.sprints === 1 ? "" : "s"}.` : "no measured points-per-hour rate yet."),
    );
  }
  if (r.budget) {
    const h = round1(r.budget.hours);
    if (r.budget.source === "measured") {
      L.push(`Budget: ${h} h x ${r.budget.rate} pts/hr = ${r.budget.points} pts (from measured rate, ${r.budget.sprints} sprint${r.budget.sprints === 1 ? "" : "s"} behind it).`);
    } else if (r.budget.source === "assumed") {
      L.push(`Budget: ${h} h x ${r.budget.rate} pts/hr = ${r.budget.points} pts (your assumed rate, not measured — execution.assumed_points_per_hour; a measured rate overrides it once one exists).`);
    } else {
      L.push(
        `Budget: a time budget of ${h} h was requested but there is no points-per-hour rate yet — nothing is converted from a guess. ` +
          `Planning by points instead (the default). A rate is measured at archive time from the event log; to use your own observed figure set execution.assumed_points_per_hour.`,
      );
    }
  } else {
    L.push("Budget: points (default).");
  }
  L.push(`capacity_points=${r.capacity ?? ""}`);
  L.push(`finished_sprints=${r.n}`);
  L.push(`fit_percent=${r.fit ? r.fit.percent : ""}`);
  L.push(`rate_source=${r.budget ? r.budget.source : ""}`);
  L.push(`budget_points=${r.budget && r.budget.source !== "none" ? r.budget.points : ""}`);
  return L.join("\n") + "\n";
}

function usage(msg) {
  process.stderr.write(
    `shipyard-data capacity: ${msg}\n` +
      "  Usage: shipyard-data capacity [--points <P>] [--hours <H> | --until <ISO-8601 time | HH:MM>] [--json] [--data-dir <path>]\n",
  );
  process.exit(2);
}

/** Parse `--until`: ISO-8601 (Date.parse) or HH:MM (today, local). Returns hours from `now`. */
export function hoursUntil(raw, now = new Date()) {
  let t = null;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    t = d.getTime();
  } else {
    t = Date.parse(String(raw));
  }
  if (!Number.isFinite(t)) return { error: `--until "${raw}" is not an ISO-8601 time or HH:MM` };
  const hours = (t - now.getTime()) / 3600000;
  if (hours <= 0) return { error: `--until "${raw}" is in the past` };
  return { hours };
}

export function parseCapacityArgs(args, now = new Date()) {
  let points = null;
  let hours = null;
  let until = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--points" || a === "--hours" || a === "--until") {
      const v = args[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      if (a === "--points") {
        if (!/^\d+$/.test(v) || Number(v) <= 0) return { error: `--points must be a positive whole number, got "${v}"` };
        points = Number(v);
      } else if (a === "--hours") {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return { error: `--hours must be a positive number, got "${v}"` };
        hours = n;
      } else until = v;
    } else return { error: `unknown argument "${a}"` };
  }
  if (hours != null && until != null) return { error: "--hours and --until are exclusive; pick one" };
  if (until != null) {
    const u = hoursUntil(until, now);
    if (u.error) return { error: u.error };
    hours = u.hours;
  }
  // AC-15: a points budget and a time budget are two answers to one question.
  if (points != null && hours != null) return { error: "--points (a points budget to rate) and a time flag are exclusive; pick one budget" };
  return { points, hours, json };
}

export function capacityMain(dataDir, args = []) {
  const parsed = parseCapacityArgs(args);
  if (parsed.error) usage(parsed.error);
  const assumed = readAssumedPointsPerHour(dataDir);
  const state = loadMetricsState(dataDir);
  const r = computeCapacity(state, { points: parsed.points, hours: parsed.hours, assumedRate: assumed.valid ? assumed.value : null });
  if (parsed.hours != null && r.budget?.source === "none") {
    process.stderr.write("shipyard-data capacity: no measured points-per-hour rate yet — time budget not converted; planning by points.\n");
  }
  if (parsed.json) process.stdout.write(JSON.stringify(r) + "\n");
  else {
    process.stdout.write(renderCapacity(r));
    // after 4.0.6: a quick run builds one whole item; it is not a timebox, so there is nothing to fit
    if (/[\\/]quick[\\/]quick-\d{3,}[\\/]?$/.test(String(dataDir))) process.stdout.write("Quick run: capacity is not a limit here. Every approved story of the item goes into the plan.\n");
  }
}
