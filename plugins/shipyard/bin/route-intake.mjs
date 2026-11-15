/**
 * `shipyard-data route-intake` (F023 AC-3, AC-4) — the deterministic ceremony
 * ladder behind /ship-discuss's single front door.
 *
 *   route-intake --size <xs|s|m|l|xl> --ambiguity <low|medium|high>
 *                --repro <known|unknown|na> --risk <none|low|medium|high>
 *                --urgency <normal|high|production> [--kind <feature|bug|unknown>] [--json]
 *     → proposes a lane (capture | refine | land-now | hotfix) with reasons and,
 *       for refine, the number of question rounds; logs `intake_routed`.
 *   route-intake --confirm <lane> --proposed <lane> [--json]
 *     → records the user's one-keypress answer; logs `intake_lane_confirmed`
 *       with `overridden: true` when the user picked a different lane.
 *
 * The router (a model) only classifies the five inputs and proposes; the lane
 * comes from this table, every decision is logged with its inputs, and the user
 * confirms or overrides. Thresholds are provisional (F023 technical note) —
 * tune them here, never in prose.
 */
import { logEvent } from "./_hook_lib.mjs";
import { readHaikuRouter } from "./config-read.mjs";
import { consultHaiku } from "./haiku-router.mjs";

export const LANES = Object.freeze(["capture", "refine", "land-now", "hotfix"]);
export const SIZES = Object.freeze(["xs", "s", "m", "l", "xl"]);
export const AMBIGUITY = Object.freeze(["low", "medium", "high"]);
export const REPRO = Object.freeze(["known", "unknown", "na"]);
export const RISK = Object.freeze(["none", "low", "medium", "high"]);
export const URGENCY = Object.freeze(["normal", "high", "production"]);
export const KINDS = Object.freeze(["feature", "bug", "unknown"]);

/** Refine rounds scale with size (question budget: ≤5 rounds total). */
export const REFINE_ROUNDS = Object.freeze({ xs: 2, s: 2, m: 3, l: 4, xl: 5 });

/**
 * Pure ladder. Order matters: urgency first (a production incident is a hotfix
 * however small), then the cheap lanes, then refine as the default.
 */
export function routeIntake({ size, ambiguity, repro, risk, urgency, kind = "unknown" }) {
  const reasons = [];
  if (urgency === "production") {
    reasons.push("urgency=production: a live incident takes the hotfix lane (minimal story, no planning lock, hands off to ship-execute --hotfix and ship-debug)");
    return { lane: "hotfix", reasons, refine_rounds: 0 };
  }
  const tiny = size === "xs" || size === "s";
  const lowRisk = risk === "none" || risk === "low";
  const reproOk = repro === "known" || repro === "na";
  // Floors come before the cheap lanes: a risk floor, an unknown repro or raised
  // urgency always forces refinement, however small or vague the item (found by
  // the F031 code-review probe: the old order made those reasons unreachable).
  if (tiny && ambiguity === "high" && lowRisk && reproOk && urgency === "normal") {
    reasons.push("small and ambiguous: not enough to build or to refine yet — capture it as an idea (zero questions)");
    return { lane: "capture", reasons, refine_rounds: 0 };
  }
  if (tiny && ambiguity === "low" && lowRisk && reproOk && urgency !== "high") {
    reasons.push(`size=${size}, ambiguity=low, risk=${risk}, repro=${repro}: tiny, clear and low-risk — land it now through ship-execute --task with the quick-task guarantees`);
    return { lane: "land-now", reasons, refine_rounds: 0 };
  }
  if (!tiny) reasons.push(`size=${size}: more than a quick change`);
  if (ambiguity !== "low") reasons.push(`ambiguity=${ambiguity}: questions are worth asking`);
  if (!lowRisk) reasons.push(`risk=${risk}: a risk floor forces refinement`);
  if (!reproOk) reasons.push("repro=unknown: a bug without a reproduction gets a debug-spike task during refinement");
  if (urgency === "high") reasons.push("urgency=high: refine quickly, but refine");
  if (kind === "bug") reasons.push("kind=bug: refinement records reproduction, expected vs actual, environment, severity and a failing test first");
  const rounds = REFINE_ROUNDS[size] ?? 3;
  return { lane: "refine", reasons, refine_rounds: rounds };
}

function usage(msg) {
  process.stderr.write(
    `shipyard-data route-intake: ${msg}\n` +
      "  Usage: route-intake --size <xs|s|m|l|xl> --ambiguity <low|medium|high> --repro <known|unknown|na> --risk <none|low|medium|high> --urgency <normal|high|production> [--kind <feature|bug|unknown>] [--haiku \"<request text>\"] [--json]\n" +
      "         route-intake --confirm <lane> --proposed <lane> [--json]\n",
  );
  process.exit(2);
}

function parse(args) {
  const out = { json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") { out.json = true; continue; }
    if (!a.startsWith("--")) usage(`unexpected argument "${a}"`);
    const key = a.slice(2);
    const v = args[++i];
    if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`);
    out[key] = v;
  }
  return out;
}

export function main(dataDir, args = []) {
  const o = parse(args);
  if (o.confirm !== undefined || o.proposed !== undefined) {
    if (!LANES.includes(o.confirm ?? "")) usage(`--confirm must be one of ${LANES.join("|")}`);
    if (!LANES.includes(o.proposed ?? "")) usage(`--proposed must be one of ${LANES.join("|")}`);
    const overridden = o.confirm !== o.proposed;
    try { logEvent(dataDir, "intake_lane_confirmed", { lane: o.confirm, proposed: o.proposed, overridden }); } catch { /* best-effort */ }
    const res = { lane: o.confirm, proposed: o.proposed, overridden };
    process.stdout.write(o.json ? JSON.stringify(res) + "\n" : `lane=${o.confirm}${overridden ? ` (overrode proposed ${o.proposed})` : " (confirmed)"}\n`);
    return;
  }
  const checks = [["size", SIZES], ["ambiguity", AMBIGUITY], ["repro", REPRO], ["risk", RISK], ["urgency", URGENCY]];
  for (const [k, allowed] of checks) {
    if (!allowed.includes(o[k] ?? "")) usage(`--${k} must be one of ${allowed.join("|")} (got "${o[k] ?? ""}")`);
  }
  const kind = o.kind ?? "unknown";
  if (!KINDS.includes(kind)) usage(`--kind must be one of ${KINDS.join("|")}`);
  // v4.2 (E004-S4): opt-in Haiku escalator for the ambiguous middle. It can only RAISE
  // ambiguity/risk/urgency (or flip repro known→unknown); size and the lane table are untouched.
  let haiku = null;
  if (o.haiku !== undefined) {
    if (!readHaikuRouter(dataDir)) usage("--haiku needs `routing.haiku_router: true` in config.md (opt-in: it spends your own quota)");
    const base = { size: o.size, ambiguity: o.ambiguity, repro: o.repro, risk: o.risk, urgency: o.urgency };
    if (o.ambiguity === "medium") {
      haiku = consultHaiku(dataDir, o.haiku, base);
      Object.assign(o, haiku.inputs);
    } else haiku = { consulted: false, raised: [], skipped: `ambiguity=${o.ambiguity} is not the ambiguous middle` };
  }
  const r = routeIntake({ size: o.size, ambiguity: o.ambiguity, repro: o.repro, risk: o.risk, urgency: o.urgency, kind });
  try {
    logEvent(dataDir, "intake_routed", { lane: r.lane, size: o.size, ambiguity: o.ambiguity, repro: o.repro, risk: o.risk, urgency: o.urgency, kind, refine_rounds: r.refine_rounds, haiku_raised: haiku?.raised?.join(",") ?? "" });
  } catch { /* best-effort */ }
  if (o.json) {
    process.stdout.write(JSON.stringify({ ...r, inputs: { size: o.size, ambiguity: o.ambiguity, repro: o.repro, risk: o.risk, urgency: o.urgency, kind }, haiku }) + "\n");
    return;
  }
  process.stdout.write(`lane=${r.lane}\n`);
  if (haiku) process.stdout.write(haiku.consulted ? `haiku: ${haiku.raised.length ? "raised " + haiku.raised.join(", ") : "no change"} (${haiku.latency_ms} ms${haiku.cost_usd != null ? `, $${Number(haiku.cost_usd).toFixed(3)}` : ""})\n` : `haiku: not consulted (${haiku.skipped ?? haiku.error})\n`);
  // "question_budget", not "rounds" (4.0): the lane card repeated the old key
  // to the person as "3 quick question rounds", and questions do not come in
  // rounds. `refine_rounds` stays in --json and in the event for old readers.
  if (r.lane === "refine") process.stdout.write(`question_budget=${r.refine_rounds * 4}\n`);
  for (const reason of r.reasons) process.stdout.write(`- ${reason}\n`);
  process.stdout.write("The router proposes; the user confirms or overrides in one answer (record it with --confirm <lane> --proposed <lane>).\n");
}
