/**
 * Steps and checks that need a person (v4.0, the owner's rule 2026-11-14).
 *
 * "I'd like to be involved either early on or late. Frequently during
 * execution is annoying." So a person is needed in two windows only:
 *
 *   before   work whose RESULT changes what gets built: a spike, a device
 *            test, a decision, access. It runs first, with the person there.
 *   after    work that only CONFIRMS what was built: a look, a manual test.
 *            It is collected for one sitting at the sprint review.
 *
 * A step says so in its frontmatter:
 *   needs_person: before | after
 *   person_task: "<what the person does, one line>"
 *   person_minutes: 10            (optional)
 *   person_where: "phone"         (optional: groups the end-of-sprint sitting)
 *
 * The plan check (plan-score.mjs) keeps `before` steps in the first wave and
 * refuses a step that waits for an `after` step. `shipyard-data sprint
 * needs-you` is the one phrase for the progress line: whether the person is
 * needed now, and what waits for them at the review.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { parseFrontmatter, parseWaves, sprintStoryIds } from "./terminal-gate.mjs";

const readIf = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
const clean = (v) => String(v ?? "").replace(/^["']|["']$/g, "").trim();
const DONE = new Set(["done"]);

/** Person fields of one step file's text. */
export function personFields(text) {
  const fm = parseFrontmatter(String(text ?? ""));
  const needs = clean(fm.needs_person).toLowerCase();
  return {
    needs: needs === "before" || needs === "after" ? needs : null,
    invalid: needs && needs !== "before" && needs !== "after" ? needs : null,
    task: clean(fm.person_task), minutes: Number(clean(fm.person_minutes)) || 0, where: clean(fm.person_where),
    status: clean(fm.status),
    // 4.0: the person's check has its own record. A step can be built and
    // reviewed (status done) while its end-of-sprint look is still open.
    person_done: clean(fm.person_done), person_failed: clean(fm.person_failed),
  };
}
// Archived steps too (4.0): a check the person left open at the review is
// still theirs after the sprint is archived, and must stay recordable.
const STEP_DIRS = ["steps", "tasks", join("archive", "steps"), join("archive", "tasks")];
function stepPath(dataDir, id) {
  for (const sub of STEP_DIRS) {
    let names = [];
    try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
    const n = names.find((x) => x.endsWith(".md") && (x.startsWith(`${id}-`) || x === `${id}.md`));
    if (n) return join(dataDir, "spec", sub, n);
  }
  return null;
}
function stepFile(dataDir, id) {
  const p = stepPath(dataDir, id);
  return p ? readIf(p) : null;
}

/**
 * Record the person's answer to a step's own check (4.0). Only from their
 * words: `--answer` is required, the same rule as a story's device look.
 * Writes `person_done:` (or `person_failed:`) and `person_answer:` into the
 * step and logs `person_check_recorded`. The step's build status is not touched.
 */
export function recordPersonCheck(dataDir, id, { answer = "", failed = false } = {}) {
  const path = stepPath(dataDir, id);
  if (!path) return { ok: false, code: 3, message: `no step ${id}` };
  const text = readIf(path) ?? "";
  const f = personFields(text);
  if (!f.needs) return { ok: false, code: 3, message: `${id} has no needs_person: there is no check of the person's to record` };
  if (!String(answer).trim()) return { ok: false, code: 2, message: "the person's own words are required: --answer \"<what they said>\" (a check is recorded only from their answer; \"not yet\" records nothing)" };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { ok: false, code: 3, message: `${id} has no frontmatter` };
  const day = new Date().toISOString().slice(0, 10);
  let block = m[1].split(/\r?\n/).filter((l) => !/^(person_done|person_failed|person_answer):/.test(l)).join("\n");
  block += `\n${failed ? "person_failed" : "person_done"}: ${day}\nperson_answer: ${JSON.stringify(String(answer).trim().slice(0, 300))}`;
  atomicWrite(path, text.replace(m[0], `---\n${block}\n---`));
  try { logEvent(dataDir, "person_check_recorded", { step: id, verdict: failed ? "failed" : "done", answer: String(answer).trim().slice(0, 160) }); } catch { /* best-effort */ }
  return { ok: true, code: 0, message: `${id}: the person's check is recorded as ${failed ? "failed" : "done"}` };
}
/** needs_person of one step by id, or null. (The terminal gate asks this.) */
export function stepNeedsPerson(dataDir, id) {
  const t = stepFile(dataDir, id);
  return t ? personFields(t).needs : null;
}
/** Kind of a story's user-flow check: auto | assisted | manual | "" (none). */
function flowKind(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""));
  if (!m) return "";
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^(user_flow_probe|demo_probe):/.test(l));
  if (at === -1) return "";
  for (let i = at + 1; i < lines.length; i++) {
    if (lines[i].trim() && !/^\s/.test(lines[i])) break;
    const k = /^\s+kind:\s*(\S+)/.exec(lines[i]);
    if (k) return clean(k[1]).toLowerCase();
  }
  return "auto";
}
function storyText(dataDir, id) {
  for (const sub of ["stories", "features", "bugs"]) {
    let names = [];
    try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
    const n = names.find((x) => x.endsWith(".md") && x.startsWith(`${id}-`));
    if (n) return readIf(join(dataDir, "spec", sub, n));
  }
  return null;
}

/** Everything the sprint plan needs from a person. `planPath` is SPRINT.md or a draft. */
export function personPlan(dataDir, planPath) {
  const text = readIf(planPath);
  if (!text) return null;
  const waves = parseWaves(text);
  const first = waves.length ? Math.min(...waves.map((w) => w.wave)) : null;
  const steps = [];
  for (const w of waves) for (const id of w.tasks) {
    const t = stepFile(dataDir, id);
    if (!t) continue;
    const f = personFields(t);
    if (f.needs || f.invalid) steps.push({ id, wave: w.wave, ...f });
  }
  const checks = [];
  for (const sid of sprintStoryIds(text)) {
    const k = flowKind(storyText(dataDir, sid));
    if (k === "assisted" || k === "manual") checks.push({ story: sid, kind: k });
  }
  return { first_wave: first, before: steps.filter((s) => s.needs === "before"), after: steps.filter((s) => s.needs === "after"), invalid: steps.filter((s) => s.invalid), story_checks: checks };
}

/** One line for the plan summary: what the sprint needs from the person, and when. */
export function personLine(p) {
  if (!p) return "";
  const end = p.after.length + p.story_checks.length;
  const mins = p.before.reduce((n, s) => n + s.minutes, 0);
  const start = p.before.length ? `${p.before.length} thing${p.before.length === 1 ? "" : "s"} at the start${mins ? ` (about ${mins} min)` : ""}: ${p.before.map((s) => `${s.id} ${s.task || "(no person_task written)"}`).join("; ")}` : "nothing at the start";
  return `you: ${start} · ${end ? `${end} check${end === 1 ? "" : "s"} at the end` : "nothing at the end"}`;
}

/** The phrase for the progress line while a sprint runs. */
/**
 * Checks of the person's that were left open when their sprint was archived:
 * [{ id, task, where }]. Seen live: the owner looked at the device an hour
 * after the review, and the step that held the check had been archived, so
 * the answer had nowhere to go and nothing listed the check any more.
 */
export function earlierOpenChecks(dataDir) {
  const out = [];
  for (const sub of [join("archive", "steps"), join("archive", "tasks")]) {
    let names = [];
    try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
    for (const n of names.sort()) {
      if (!n.endsWith(".md")) continue;
      const text = readIf(join(dataDir, "spec", sub, n));
      if (!text || !/^needs_person:/m.test(text)) continue;
      const f = personFields(text);
      if (f.needs && !f.person_done && !f.person_failed) out.push({ id: (n.match(/^([A-Z]+-?[A-Z0-9]*\d+)/) ?? [])[1] ?? n, task: f.task, where: f.where });
    }
  }
  return out;
}

export function needsYou(dataDir) {
  const planPath = join(dataDir, "sprints", "current", "SPRINT.md");
  const p = personPlan(dataDir, planPath);
  const earlier = earlierOpenChecks(dataDir);
  if (!p) return { now: false, phrase: `you: no sprint is running${earlier.length ? ` · ${earlier.length} check${earlier.length === 1 ? "" : "s"} still open from earlier sprints` : ""}`, waiting: [], at_review: 0, earlier };
  const cursor = readIf(join(dataDir, "sprints", "current", "EXECUTE-CURSOR.md"));
  const cfm = cursor ? parseFrontmatter(cursor) : {};
  const paused = ["paused", "escalated"].includes(clean(cfm.status));
  const open = p.before.filter((s) => !DONE.has(s.status));
  // Open until the person has answered, whatever the step's build status is.
  // Seen live: two steps were built (status done) and the list said nothing
  // waited for the owner, at the start of the very review that had to ask.
  const afterOpen = p.after.filter((s) => !s.person_done && !s.person_failed);
  const atReview = afterOpen.length + p.story_checks.length;
  const tail = atReview ? ` (${atReview} check${atReview === 1 ? "" : "s"})` : "";
  if (paused) return { now: true, phrase: `you: needed now · the sprint is paused${clean(cfm.note) ? `: ${clean(cfm.note).slice(0, 80)}` : ""}`, waiting: open, at_review: atReview, earlier };
  if (open.length) return { now: true, phrase: `you: needed now · ${open.map((s) => `${s.id} ${s.task}`.trim()).join("; ").slice(0, 140)}`, waiting: open, at_review: atReview, earlier };
  return { now: false, phrase: `you: not needed until the review${tail}`, waiting: [], at_review: atReview, after: afterOpen, story_checks: p.story_checks, earlier };
}

export function main(dataDir, args = []) {
  if (args[0] === "person-check") {
    const flag = (n) => { const i = args.indexOf(n); return i === -1 ? "" : String(args[i + 1] ?? ""); };
    const id = args[1] && !args[1].startsWith("--") ? args[1] : "";
    if (!id) { process.stderr.write("usage: sprint person-check <step id> --answer \"<their words>\" [--failed]\n"); process.exit(2); }
    const r = recordPersonCheck(dataDir, id, { answer: flag("--answer"), failed: args.includes("--failed") });
    (r.ok ? process.stdout : process.stderr).write(`shipyard-data sprint person-check: ${r.message}\n`);
    process.exit(r.code);
  }
  const bad = args.find((a) => !["--json", "--draft", "--next"].includes(a));
  if (bad) { process.stderr.write(`shipyard-data sprint needs-you: unknown argument "${bad}"\n  Usage: sprint needs-you [--draft|--next] [--json]\n`); process.exit(2); }
  if (args.includes("--draft") || args.includes("--next")) {
    const path = args.includes("--next") ? join(dataDir, "sprints", "next", "SPRINT-DRAFT.md") : join(dataDir, "sprints", "current", "SPRINT-DRAFT.md");
    const p = personPlan(dataDir, path);
    if (!p) { process.stderr.write(`shipyard-data sprint needs-you: no sprint plan at ${path}\n`); process.exit(3); }
    process.stdout.write(args.includes("--json") ? JSON.stringify(p) + "\n" : personLine(p) + "\n");
    return;
  }
  const r = needsYou(dataDir);
  if (args.includes("--json")) { process.stdout.write(JSON.stringify(r) + "\n"); return; }
  process.stdout.write(r.phrase + "\n");
  for (const c of r.earlier ?? []) process.stdout.write(`  still yours from an earlier sprint: ${c.id} ${c.task}${c.where ? ` (${c.where})` : ""} — when done: shipyard-data sprint person-check ${c.id} --answer "<your words>"\n`);
  if (!r.now && r.at_review) {
    const byWhere = new Map();
    for (const s of r.after ?? []) { const k = s.where || "anywhere"; byWhere.set(k, [...(byWhere.get(k) ?? []), `${s.id} ${s.task}`.trim()]); }
    for (const [k, v] of byWhere) process.stdout.write(`  at the review, ${k}: ${v.join("; ")}\n`);
    if ((r.story_checks ?? []).length) process.stdout.write(`  at the review, story checks: ${r.story_checks.map((c) => c.story).join(", ")}\n`);
  }
}
