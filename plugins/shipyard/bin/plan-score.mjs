/**
 * `shipyard-data sprint plan-score [--draft|--next] [--check] [--json]` (v4.19)
 *
 * How parallel is this sprint plan, and is anything in it later than it has
 * to be? The owner's question (2026-11-14): "when we plan, do we break the
 * work into small units that maximize parallel work?" The honest answer was
 * "partly": steps were small, but nothing measured the plan, a step could sit
 * in a late wave for no stated reason, a sprint of three independent stories
 * was built one step at a time, and two steps of one wave could edit the same
 * file. Every one of those is derivable from the plan, so the CLI derives it.
 *
 * Reads the wave list (SPRINT.md, or the draft) and each step's frontmatter:
 *   dependencies: [P001]                  the steps this one must wait for
 *   touches: [src/a.c, "src/app.c#hud"]   the files it changes; `#part` names
 *                                         the part when two steps share a file
 *
 * Problems (exit 3 with --check; the planner fixes the plan, never the check):
 *   late          a step sits in a later wave than its dependencies require
 *   order         a step depends on a step in the same or a later wave
 *   overlap       two steps of one wave touch the same file (same part)
 *   undeclared    a step that shares a wave with others names no `touches`
 *   solo          `execution_mode: solo` while a wave has 2+ steps
 *   too wide      a wave has more steps than `execution.max_agents`
 *   person        a step that needs a person sits in the middle of the sprint:
 *                 `needs_person: before` outside the first wave, or a step
 *                 that waits for a `needs_person: after` step
 *
 * The gate: a story cannot enter a sprint (approved → in-progress) and a
 * drafted sprint cannot be queued while the plan has a problem.
 * `execution.parallel_plan: false` turns the gate off (the score still prints).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, parseWaves } from "./terminal-gate.mjs";
import { parseFrontmatterList } from "./frontmatter-list.mjs";
import { readMaxAgents, readParallelPlan, readExecutionIsolation, readProbeMustFailFirst } from "./config-read.mjs";
import { globToRe } from "./risk.mjs";
import { personPlan, personLine } from "./person-steps.mjs";
import { tutorialNote } from "./tutorial.mjs";

const WEIGHT = { S: 1, M: 2, L: 4, XL: 8 };
const readIf = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };

/** Which plan file to read: the running sprint, its draft, or the sprint drafted ahead. */
export function planFile(dataDir, { next = false, draft = false } = {}) {
  if (next) return join(dataDir, "sprints", "next", "SPRINT-DRAFT.md");
  const sprint = join(dataDir, "sprints", "current", "SPRINT.md");
  const d = join(dataDir, "sprints", "current", "SPRINT-DRAFT.md");
  if (draft) return d;
  // Before the sprint is created the plan lives in the draft; once SPRINT.md has waves it is the plan.
  const text = readIf(sprint);
  return text && parseWaves(text).length ? sprint : existsSync(d) && !text ? d : sprint;
}

function stepRecords(dataDir, ids) {
  const out = new Map();
  for (const sub of ["steps", "tasks"]) {
    let names = [];
    try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
    for (const n of names) {
      const id = (n.match(/^([A-Z]+-?[A-Z0-9]*\d+)(?=-|\.md$)/) || [])[1];
      if (!id || !ids.has(id) || out.has(id) || !n.endsWith(".md")) continue;
      const text = readIf(join(dataDir, "spec", sub, n));
      const m = text && text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) continue;
      const fm = parseFrontmatter(text);
      out.set(id, {
        id,
        story: String(fm.story || fm.feature || "").trim(),
        kind: String(fm.kind || "feature").trim(),
        effort: String(fm.effort || "").replace(/["']/g, "").trim().toUpperCase(),
        dependencies: parseFrontmatterList(m[1], "dependencies").items,
        touches: parseFrontmatterList(m[1], "touches").items.map((t) => t.replace(/\\/g, "/").replace(/^\.\//, "")),
        needs_person: ["before", "after"].includes(String(fm.needs_person ?? "").replace(/["']/g, "").trim().toLowerCase()) ? String(fm.needs_person).replace(/["']/g, "").trim().toLowerCase() : null,
        declared: /^touches:/m.test(m[1]),
      });
    }
  }
  return out;
}

/** Each step of the plan with its declared files and its wave: Map id -> { touches, declared, wave }. */
export function planTouches(dataDir, opts = {}) {
  const text = readIf(planFile(dataDir, opts));
  if (!text) return new Map();
  const waveOf = new Map();
  for (const w of parseWaves(text)) for (const id of w.tasks) if (!waveOf.has(id)) waveOf.set(id, w.wave);
  const recs = stepRecords(dataDir, new Set(waveOf.keys()));
  return new Map([...recs].map(([id, r]) => [id, { touches: r.touches, declared: r.declared, wave: waveOf.get(id) }]));
}

/** Do two `touches` entries name the same thing? `file#part` narrows a file to one part of it. */
export function touchesOverlap(a, b) {
  const [fa, pa] = String(a).split("#"), [fb, pb] = String(b).split("#");
  const same = fa === fb || Boolean(globToRe(fa)?.test(fb)) || Boolean(globToRe(fb)?.test(fa));
  if (!same) return false;
  return !pa || !pb || pa.trim().toLowerCase() === pb.trim().toLowerCase();
}

/** The score and its problems. Pure over the files it reads. */
export function planScore(dataDir, opts = {}) {
  const path = planFile(dataDir, opts);
  const text = readIf(path);
  if (!text) return { error: `no sprint plan at ${path}` };
  const fm = parseFrontmatter(text);
  const waves = parseWaves(text).map((w) => ({ wave: w.wave, steps: [...w.tasks] }));
  if (!waves.length) return { error: `${path} has no \`### Wave N\` list yet` };
  const waveOf = new Map();
  for (const w of waves) for (const id of w.steps) if (!waveOf.has(id)) waveOf.set(id, w.wave);
  const recs = stepRecords(dataDir, new Set(waveOf.keys()));
  const cap = readMaxAgents(dataDir);
  const problems = [];
  const missing = [...waveOf.keys()].filter((id) => !recs.has(id));

  // earliest wave each step could be in, from its dependencies inside this sprint
  const deps = (id) => (recs.get(id)?.dependencies ?? []).filter((d) => waveOf.has(d) && d !== id);
  const earliest = new Map(), via = new Map(), state = new Map();
  const visit = (id) => {
    if (earliest.has(id)) return earliest.get(id);
    if (state.get(id) === "open") { problems.push(`order: ${id} is part of a dependency loop`); return 1; }
    state.set(id, "open");
    let e = 1;
    for (const d of deps(id)) { const de = visit(d) + 1; if (de > e) { e = de; via.set(id, d); } }
    state.set(id, "done"); earliest.set(id, e);
    return e;
  };
  for (const id of waveOf.keys()) visit(id);

  const order = [...new Set(waves.map((w) => w.wave))].sort((a, b) => a - b);
  const rank = new Map(order.map((n, i) => [n, i + 1])); // wave numbers may have gaps; rank is 1..n
  const late = [], orderBad = [];
  for (const [id, w] of waveOf) {
    const r = rank.get(w), e = earliest.get(id);
    for (const d of deps(id)) if (rank.get(waveOf.get(d)) >= r) orderBad.push({ id, dep: d, wave: w });
    if (r > e && recs.get(id)?.needs_person !== "after") late.push({ id, wave: w, earliest: order[e - 1] ?? order[order.length - 1] });
  }
  for (const o of orderBad) problems.push(`order: ${o.id} (wave ${o.wave}) depends on ${o.dep}, which is in wave ${waveOf.get(o.dep)}: a step waits for an earlier wave, never its own or a later one`);
  for (const l of late) {
    const held = deps(l.id);
    problems.push(`late: ${l.id} is in wave ${l.wave} but ${held.length ? `the steps it waits for (${held.join(", ")}) finish by wave ${order[earliest.get(l.id) - 2]}` : "it waits for nothing in this sprint"}: move it to wave ${l.earliest}, or add the step it really waits for to its \`dependencies:\``);
  }

  // steps of one wave must not change the same file
  const overlaps = [], undeclared = [];
  for (const w of waves) {
    const here = w.steps.map((id) => recs.get(id)).filter(Boolean);
    if (here.length > cap) problems.push(`too wide: wave ${w.wave} has ${here.length} steps and at most ${cap} agents may be alive at once (execution.max_agents): split it`);
    if (here.length < 2) continue;
    for (const s of here) if (s.kind === "feature" && !s.touches.length && !s.needs_person) undeclared.push(s.id);
    for (let i = 0; i < here.length; i++) for (let k = i + 1; k < here.length; k++) {
      for (const a of here[i].touches) { const b = here[k].touches.find((x) => touchesOverlap(a, x)); if (b) { overlaps.push({ wave: w.wave, a: here[i].id, b: here[k].id, path: a === b ? a : `${a} / ${b}` }); break; } }
    }
  }
  for (const o of overlaps) problems.push(`overlap: ${o.a} and ${o.b} are both in wave ${o.wave} and both touch ${o.path}: cut the steps so each has its own file, name the part each changes (\`file#part\`), or make one wait for the other (\`dependencies:\`)`);
  if (undeclared.length) problems.push(`undeclared: ${undeclared.join(", ")} share a wave with other steps but name no \`touches:\` (the files each one changes), so nothing can tell whether they collide`);
  if (missing.length) problems.push(`order: no step file for ${missing.join(", ")}`);

  // A person is needed at the start or at the end, never in the middle (4.0).
  const person = personPlan(dataDir, path);
  for (const s of person?.invalid ?? []) problems.push(`person: ${s.id} has needs_person "${s.invalid}"; write before (its result changes what is built) or after (it only confirms what was built)`);
  for (const s of [...(person?.before ?? []), ...(person?.after ?? [])]) if (!s.task) problems.push(`person: ${s.id} needs a person but has no \`person_task:\` (one line: what the person does)`);
  for (const s of person?.before ?? []) if (rank.get(s.wave) !== 1) problems.push(`person: ${s.id} needs a person before the build but is in wave ${s.wave}: put it in wave 1, where the person is still there, so nobody is called back in the middle of the sprint. If it only confirms what was built, mark it \`needs_person: after\``);
  for (const [id] of waveOf) for (const dp of deps(id)) if (recs.get(dp)?.needs_person === "after") problems.push(`person: ${id} waits for ${dp}, which a person does at the end of the sprint: a check at the end cannot hold up building. Mark ${dp} \`needs_person: before\` (wave 1), or remove the dependency`);

  const widest = Math.max(...waves.map((w) => w.steps.length));
  const mode = String(fm.execution_mode ?? "").trim();
  const recommended = widest >= 2 ? "task" : "solo";
  let isolation = "worktree";
  try { isolation = readExecutionIsolation(dataDir); } catch { /* default */ }
  if (mode === "solo" && widest >= 2 && isolation !== "none") problems.push(`solo: execution_mode is solo, which builds one step at a time, but a wave has ${widest} steps that can run together: \`shipyard-data sprint set execution_mode task\` (solo is for a plan with one step per wave, or a project set to \`execution.isolation: none\`)`);

  // the longest chain of steps that must run one after another (heaviest by size when lengths tie)
  const depth = Math.max(...[...earliest.values()]);
  const weightTo = new Map();
  const weigh = (id) => { if (weightTo.has(id)) return weightTo.get(id); const w = (WEIGHT[recs.get(id)?.effort] ?? 2) + Math.max(0, ...deps(id).map(weigh)); weightTo.set(id, w); return w; };
  let tail = null;
  for (const id of waveOf.keys()) if (earliest.get(id) === depth && (tail === null || weigh(id) > weigh(tail))) tail = id;
  const chain = [];
  for (let id = tail; id; id = via.get(id)) chain.unshift(id);

  const steps = waveOf.size;
  return {
    plan: path, sprint: String(fm.id ?? "").trim(), execution_mode: mode || null, recommended_mode: recommended,
    steps, waves: waves.map((w) => ({ wave: w.wave, steps: w.steps, width: w.steps.length })), wave_count: waves.length, widest,
    depth, chain, extra_waves: Math.max(0, waves.length - depth), max_agents: cap,
    late, overlaps, undeclared, problems,
    person: person ? { before: person.before.map((s) => ({ id: s.id, task: s.task, minutes: s.minutes })), after: person.after.map((s) => ({ id: s.id, task: s.task, where: s.where })), story_checks: person.story_checks, line: personLine(person) } : null,
  };
}

/** Problems that stop a plan from becoming a sprint, or [] (also [] when the owner turned the gate off, or no plan exists). */
export function planGateProblems(dataDir, opts = {}) {
  let on = true;
  try { on = readParallelPlan(dataDir); } catch { on = true; }
  const s = on ? planScore(dataDir, opts) : { problems: [] };
  const out = s.error ? [] : [...s.problems];
  // 4.21: a probe that already passes proves nothing (set by sprint probes-at-base)
  let probes = true;
  try { probes = readProbeMustFailFirst(dataDir); } catch { probes = true; }
  if (probes && probeProblemsFn) { try { out.push(...probeProblemsFn(dataDir, opts)); } catch { /* unreadable record: nothing to add */ } }
  return out;
}
// probes-at-base.mjs imports planFile from this module; it registers its checker here to avoid an import cycle.
let probeProblemsFn = null;
export function registerProbeProblems(fn) { probeProblemsFn = fn; }

export function renderScore(s) {
  const L = [`plan score: ${s.steps} step${s.steps === 1 ? "" : "s"} in ${s.wave_count} wave${s.wave_count === 1 ? "" : "s"} · widest wave ${s.widest} · longest chain ${s.depth}${s.chain.length > 1 ? ` (${s.chain.join(" → ")})` : ""}`];
  for (const w of s.waves) L.push(`  wave ${String(w.wave).padStart(2)} ${"█".repeat(Math.min(w.width, 40))} ${w.width}`);
  L.push(s.extra_waves ? `  ${s.wave_count} waves, but the dependencies need only ${s.depth}: ${s.extra_waves} wave${s.extra_waves === 1 ? "" : "s"} could go.` : `  ${s.wave_count} wave${s.wave_count === 1 ? " is" : "s are"} the fewest these dependencies allow. To go faster, shorten the chain: is every link a real wait?`);
  if (s.person) L.push(`  ${s.person.line}`);
  if (s.problems.length) { L.push("", `${s.problems.length} problem${s.problems.length === 1 ? "" : "s"}:`); for (const p of s.problems) L.push(`  - ${p}`); }
  return L.join("\n") + "\n";
}

export function main(dataDir, args = []) {
  const known = ["--draft", "--next", "--check", "--json"];
  const bad = args.find((a) => !known.includes(a));
  if (bad) { process.stderr.write(`shipyard-data sprint plan-score: unknown argument "${bad}"\n  Usage: sprint plan-score [--draft|--next] [--check] [--json]\n`); process.exit(2); }
  const s = planScore(dataDir, { next: args.includes("--next"), draft: args.includes("--draft") });
  if (s.error) { process.stderr.write(`shipyard-data sprint plan-score: ${s.error}\n`); process.exit(3); }
  process.stdout.write(args.includes("--json") ? JSON.stringify(s) + "\n" : renderScore(s));
  if (args.includes("--check") && s.problems.length) { tutorialNote(dataDir, "refusal:plan-score"); process.exit(3); }
}
