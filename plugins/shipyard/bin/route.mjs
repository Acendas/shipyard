/**
 * `shipyard-data route` (E004 — v4.2: rules-first model routing)
 *
 *   route (--step P### | --task T### | --story S### | --role <role>) [--kind <k>] [--effort <S|M|L|XL>] [--risk <level>] [--json]
 *     → tier light|build|think, model (from models.<tier>), effort low|medium|high, with every input
 *       and reason listed; logs `route_decided`.
 *
 * Rules first (a closed table below), learned thresholds later. Inputs: the unit's kind and effort
 * (read from its record), the latest `risk_scored` level for it (or --risk), and the role floor
 * from ROLE_TIER. Combination is MAX: a risk level or a role can only raise the tier. A missing
 * kind or effort falls back ONE TIER UP (never down) and says so; an unscored risk counts as
 * medium (see the labeled-set note in docs/references/shipyard/routing-labeled-set.md). `resolve-model --subject` consults this
 * when `routing.rules` is on (default), then applies the retry ladder as before.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { logEvent } from "./_hook_lib.mjs";
import { parseFrontmatter, readEvents } from "./terminal-gate.mjs";
import { ROLE_FLOOR, DEFAULT_SIZE_TIERS, lightIsDistinct, readModelTier, readSizeTiers } from "./config-read.mjs";
import { isBuilderRecord, isStoryId, STEP_ID_RE, TASK_ID_RE } from "./vocab.mjs";
import { LEVELS as RISK_LEVELS } from "./risk.mjs";

export const TIERS = Object.freeze(["light", "build", "think"]);
export const EFFORTS = Object.freeze(["low", "medium", "high"]);
export const SIZES = Object.freeze(["S", "M", "L", "XL"]);
const up = (tier, n = 1) => TIERS[Math.min(TIERS.indexOf(tier) + n, TIERS.length - 1)];
const maxTier = (a, b) => (TIERS.indexOf(b) > TIERS.indexOf(a) ? b : a);
const maxEffort = (a, b) => (EFFORTS.indexOf(b) > EFFORTS.indexOf(a) ? b : a);

/** Kind → base tier. Unknown kinds are not in the table on purpose (they fall back up). */
export const KIND_TIER = Object.freeze({
  feature: "build", bug: "build", debug: "build", unblocker: "build", fixer: "build",
  operational: "light", chore: "light",
  research: "think", study: "think", spike: "think",
});
/**
 * Kinds whose difficulty is their size (v4.10): straightforward work goes to
 * the light tier, work that needs reasoning to build, hard work to think.
 * `debug` is not here: finding a cause is reasoning whatever its size.
 */
export const SIZED_KINDS = Object.freeze(["feature", "bug", "fixer", "unblocker"]);
export const SIZE_EFFORT = Object.freeze({ S: "low", M: "medium", L: "high", XL: "high" });

function readRecord(dataDir, id) {
  const dirs = STEP_ID_RE.test(id) ? ["steps"] : TASK_ID_RE.test(id) ? ["tasks", "steps"] : ["stories", "features", "bugs"];
  for (const sub of dirs) {
    const dir = join(dataDir, "spec", sub);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    const n = names.find((x) => x.startsWith(`${id}-`) || x === `${id}.md`);
    if (!n) continue;
    try { return { fm: parseFrontmatter(readFileSync(join(dir, n), "utf8")), sub }; } catch { return null; }
  }
  return null;
}

function pointsToSize(pts) {
  const p = Number(pts);
  if (!Number.isFinite(p) || p <= 0) return null;
  return p <= 2 ? "S" : p <= 5 ? "M" : p <= 8 ? "L" : "XL";
}

function latestRiskLevel(dataDir, { story, step }) {
  const evs = readEvents(dataDir).filter((e) => e.type === "risk_scored" && ((step && e.step === step) || (story && e.story === story)));
  return evs.length ? evs[evs.length - 1].level : null;
}

/** Pure routing over explicit inputs. */
export function routeRules({ kind = null, effort = null, risk = null, role = null, pin = null, sizeTiers = DEFAULT_SIZE_TIERS, lightDistinct = true }) {
  const reasons = [];
  let fallbackUp = false;
  let tier;
  const sized = kind && SIZED_KINDS.includes(kind) && effort && SIZE_EFFORT[effort];
  if (sized) { tier = sizeTiers[effort] ?? KIND_TIER[kind]; reasons.push(`kind=${kind}, size=${effort} → ${tier}`); }
  else if (kind && KIND_TIER[kind]) { tier = KIND_TIER[kind]; reasons.push(`kind=${kind} → ${tier}`); }
  else { tier = up("build"); fallbackUp = true; reasons.push(`kind=${kind ?? "unknown"} is not in the table → one tier up from build (${tier})`); }
  let eff;
  if (effort && SIZE_EFFORT[effort]) { eff = SIZE_EFFORT[effort]; reasons.push(`effort=${effort} → ${eff}`); }
  else { eff = "medium"; tier = up(tier); fallbackUp = true; reasons.push(`effort=${effort ?? "unknown"} → medium, one tier up (${tier})`); }
  if (risk && RISK_LEVELS.includes(risk)) {
    if (risk === "critical") { tier = "think"; eff = "high"; reasons.push("risk=critical → think, high"); }
    else if (risk === "high") { tier = up(tier); eff = "high"; reasons.push(`risk=high → one tier up (${tier}), high`); }
    else if (risk === "medium") { eff = maxEffort(eff, "medium"); reasons.push("risk=medium → effort at least medium"); }
    else reasons.push("risk=low → no change");
  } else {
    // Unknown risk is NOT a missing input that climbs a tier: on the labeled set
    // (153 past steps, none risk-scored, 2 ever blocked) a strict fallback would
    // have routed every step to think for no measured benefit. Unknown = medium.
    eff = maxEffort(eff, "medium");
    reasons.push(`risk=${risk ?? "unknown"} (no risk_scored event) → treated as medium: effort at least medium; run \`shipyard-data risk score\` to raise it`);
  }
  if (role && ROLE_FLOOR[role]) {
    const floor = ROLE_FLOOR[role];
    if (TIERS.indexOf(floor) > TIERS.indexOf(tier)) reasons.push(`role=${role} floor ${floor} raises ${tier} → ${floor}`);
    tier = maxTier(tier, floor);
  } else if (role) reasons.push(`role=${role} is unknown → ignored`);
  // The planner can pin a step up (`tier: build|think` in its frontmatter): a
  // small step that still needs judgment. A pin never lowers a tier.
  if (pin && TIERS.includes(pin)) {
    if (TIERS.indexOf(pin) > TIERS.indexOf(tier)) reasons.push(`step pins tier ${pin} → raises ${tier} → ${pin}`);
    tier = maxTier(tier, pin);
  }
  // No separate light model configured: light IS build, so say build.
  if (tier === "light" && !lightDistinct) { tier = "build"; reasons.push("models.light is not a model of its own → build (set it with `shipyard-data config set-model light haiku`)"); }
  return { tier, effort: eff, reasons, fallback_up: fallbackUp };
}

/** Resolve inputs for a subject, route, and log. Used by the CLI and by resolve-model. */
export function routeDecision(dataDir, { step = null, task = null, story = null, role = null, kind = null, effort = null, risk = null, log = true } = {}) {
  const id = step ?? task ?? story;
  const inputs = { subject: id ?? null, role, kind, effort, risk, pin: null, source: {} };
  if (id) {
    const rec = readRecord(dataDir, id);
    if (rec) {
      const fm = rec.fm;
      if (!inputs.kind) {
        inputs.kind = String(fm.kind || (rec.sub === "stories" || rec.sub === "features" || rec.sub === "bugs" ? fm.type || "feature" : "")).trim() || null;
        inputs.source.kind = `${rec.sub}/${id}`;
      }
      if (!inputs.effort) {
        const e = String(fm.effort || "").trim().toUpperCase();
        inputs.effort = SIZES.includes(e) ? e : pointsToSize(fm.story_points);
        inputs.source.effort = inputs.effort ? `${rec.sub}/${id}` : null;
      }
      const pin = String(fm.tier || "").trim().toLowerCase();
      if (TIERS.includes(pin)) { inputs.pin = pin; inputs.source.pin = `${rec.sub}/${id}`; }
      if (!story && (STEP_ID_RE.test(id) || (TASK_ID_RE.test(id) && isBuilderRecord(fm)))) story = String(fm.story || fm.feature || "").trim() || null;
    } else inputs.source.record = "missing";
  }
  if (!inputs.risk) {
    inputs.risk = latestRiskLevel(dataDir, { story, step: step ?? (task && TASK_ID_RE.test(task) ? task : null) });
    inputs.source.risk = inputs.risk ? "risk_scored event" : null;
  }
  const r = routeRules({ kind: inputs.kind, effort: inputs.effort, risk: inputs.risk, role, pin: inputs.pin, sizeTiers: readSizeTiers(dataDir), lightDistinct: lightIsDistinct(dataDir) });
  const model = readModelTier(dataDir, r.tier);
  const out = { ...r, model, inputs, story };
  if (log) {
    try { logEvent(dataDir, "route_decided", { subject: id ?? "", role: role ?? "", kind: inputs.kind ?? "", effort: inputs.effort ?? "", risk: inputs.risk ?? "", tier: r.tier, model, agent_effort: r.effort, fallback_up: r.fallback_up, reasons: r.reasons.join(" | ").slice(0, 200) }); } catch { /* best-effort */ }
  }
  return out;
}

function usage(msg) {
  process.stderr.write(
    `shipyard-data route: ${msg}\n` +
      "  Usage: route (--step P### | --task T### | --story S### | --role <role>) [--kind <k>] [--effort <S|M|L|XL>] [--risk <low|medium|high|critical>] [--json]\n",
  );
  process.exit(2);
}

export function main(dataDir, args = []) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") { o.json = true; continue; }
    if (a.startsWith("--")) { const v = args[++i]; if (v === undefined || v.startsWith("--")) usage(`${a} needs a value`); o[a.slice(2)] = v; } else o._.push(a);
  }
  if (!o.step && !o.task && !o.story && !o.role) usage("name a subject (--step, --task, --story) or a --role");
  if (o.step && !STEP_ID_RE.test(o.step) && !TASK_ID_RE.test(o.step)) usage("--step must be P### (legacy T### accepted)");
  if (o.task && !TASK_ID_RE.test(o.task)) usage("--task must be T###");
  if (o.story && !isStoryId(o.story)) usage("--story must be S### (legacy F###/B###, hotfix B-HOT-### accepted)");
  if (o.effort && !SIZES.includes(o.effort.toUpperCase())) usage(`--effort must be one of ${SIZES.join("|")}`);
  if (o.risk && !RISK_LEVELS.includes(o.risk)) usage(`--risk must be one of ${RISK_LEVELS.join("|")}`);
  const r = routeDecision(dataDir, { step: o.step ?? null, task: o.task ?? null, story: o.story ?? null, role: o.role ?? null, kind: o.kind ?? null, effort: o.effort ? o.effort.toUpperCase() : null, risk: o.risk ?? null });
  if (o.json) { process.stdout.write(JSON.stringify(r) + "\n"); return; }
  process.stdout.write(`tier=${r.tier} model=${r.model} effort=${r.effort}${r.fallback_up ? " fallback=up" : ""}\n`);
  for (const line of r.reasons) process.stdout.write(`  ${line}\n`);
}
