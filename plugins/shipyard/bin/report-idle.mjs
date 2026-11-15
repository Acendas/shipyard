/**
 * `shipyard-data report idle` (alias `boundary-share`) — F010 AC-9, AC-10.
 *
 * Shows the share of ACTIVE time spent in boundary-class stages (merge, build,
 * test, verify, gates). Boundary work is real work, not idle time; "silent"
 * time (no events) is reported separately by the shared activeTime function.
 *
 * Attribution: the timeline is cut at each pipeline_tick_completed; the
 * segment after a tick belongs to the class of that tick's next_stage, and its
 * active time is activeTime() over the events inside the segment. Active time
 * is never redefined here.
 */
import { join } from "node:path";
import { readEvents, activeTime, stageClass } from "./event-report.mjs";
import { currentSprintId } from "./terminal-gate.mjs";

const UNKNOWN = "unknown";
const sprintOf = (e) => (typeof e.sprint === "string" && e.sprint.trim() ? e.sprint.trim() : UNKNOWN);
const tsOf = (e) => Date.parse(e.ts);
const min = (ms) => (ms / 60000).toFixed(1);
const CLASSES = ["dispatch", "boundary", "setup", "other"];

export const FORMULA =
  "boundary share = active time in boundary-class stages / active time in all stages " +
  "(active time per activeTime(); stage class per STAGE_CLASS_MAP; wave_recovery counts as dispatch)";

/** @returns {{sprints:Array, coverage:object}} */
export function computeBoundaryShare(events, corrupt = 0, opts = {}) {
  const evs = events
    .filter((e) => Number.isFinite(tsOf(e)))
    .filter((e) => !opts.sprint || sprintOf(e) === opts.sprint || sprintOf(e) === UNKNOWN)
    .sort((a, b) => tsOf(a) - tsOf(b));
  const by = new Map();
  for (const e of evs) {
    const s = sprintOf(e);
    if (!by.has(s)) by.set(s, []);
    by.get(s).push(e);
  }
  let ticksTotal = 0;
  let ticksClassified = 0;
  const sprints = [];
  for (const [sprint, list] of [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const cuts = list.filter((e) => e.type === "pipeline_tick_completed");
    const ms = Object.fromEntries(CLASSES.map((c) => [c, 0]));
    for (let i = 0; i < cuts.length; i++) {
      ticksTotal++;
      const cls = stageClass(cuts[i].pipeline, cuts[i].next_stage);
      if (cls !== "other") ticksClassified++;
      const lo = tsOf(cuts[i]);
      const hi = i + 1 < cuts.length ? tsOf(cuts[i + 1]) : Infinity;
      const seg = list.filter((e) => tsOf(e) >= lo && tsOf(e) <= hi);
      ms[cls] += activeTime(seg).activeMs;
    }
    const classifiedMs = CLASSES.reduce((s, c) => s + ms[c], 0);
    sprints.push({
      sprint,
      ms,
      classifiedMs,
      activeMs: activeTime(list).activeMs,
      share: classifiedMs > 0 ? ms.boundary / classifiedMs : null,
    });
  }
  return { sprints, coverage: { ticksTotal, ticksClassified, corrupt } };
}

export function renderBoundaryShare(r, scope = null) {
  const L = ["# Boundary share report", "", `Formula: ${FORMULA}`, ""];
  if (scope) L.push(`Scope: ${scope}`, "");
  if (r.sprints.length === 0) L.push("  (none)");
  for (const s of r.sprints) {
    const pct = s.share == null ? "n/a (no active time)" : `${Math.round(s.share * 100)}%`;
    L.push(
      `  ${s.sprint === UNKNOWN ? "[sprint unknown]" : s.sprint}: boundary share ${pct}  ` +
        CLASSES.map((c) => `${c}=${min(s.ms[c])}m`).join("  ") + `  total active=${min(s.activeMs)}m`,
    );
  }
  const c = r.coverage;
  L.push(
    "",
    `Data coverage: ${c.ticksClassified}/${c.ticksTotal} pipeline ticks map to a known stage class; ` +
      `${c.corrupt} corrupt log line${c.corrupt === 1 ? "" : "s"} skipped`,
  );
  return L.join("\n") + "\n";
}


/** `report idle|boundary-share [--sprint <id> | --all]` */
export function reportMain(dataDir, args = []) {
  const { events, corrupt } = readEvents(dataDir);
  const si = args.indexOf("--sprint");
  let sprint = null;
  if (si >= 0 && args[si + 1]) sprint = args[si + 1];
  else if (!args.includes("--all")) sprint = currentSprintId(dataDir);
  const scope = sprint ? `sprint ${sprint} (plus events with no sprint field)` : "all sprints";
  process.stdout.write(renderBoundaryShare(computeBoundaryShare(events, corrupt, { sprint }), scope));
}
