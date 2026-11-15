/**
 * `shipyard-data migrate [--dry-run] [--reverse] [--data-dir <path>]` (F022 AC-5;
 * terminology-v4 I-3, I-4, I-5).
 *
 * Moves a 3.x project's data to the v4 layout. Legacy STORY records (F### in
 * spec/features/, B### in spec/bugs/) stay where they are — readers resolve
 * them in place (I-2) — so the migration touches only the records whose old
 * meaning was retired:
 *
 *   spec/tasks/T###  builder units  -> spec/steps/P###-<slug>.md  (type: step,
 *                                      story: <feature>, aliases: [T###])
 *   spec/tasks/Q-NNN quick tasks    -> spec/tasks/T###-<slug>.md  (type: task,
 *                                      kind: chore, aliases: [Q-NNN])
 *   spec/bugs/B-HOT-NNN hotfix bugs -> spec/stories/S###-<slug>.md (type: bug,
 *                                      lane: hotfix, aliases: [B-HOT-NNN])
 *
 * and then rewrites the references that would otherwise dangle: each live
 * story's `tasks:` array becomes `steps:` with the new ids, and the current
 * SPRINT.md wave lists name the new step ids. Archived sprints and the event
 * log are history and are never rewritten (D-3).
 *
 * Safety:
 *   --dry-run prints the plan and writes nothing.
 *   A journal (`spec/.migration-v4.json`) holds every original byte, so
 *   --reverse restores the pre-migration tree exactly and removes the journal.
 *   Running migrate again after it applied is a no-op (exit 0, "already applied").
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { parseFrontmatter } from "./terminal-gate.mjs";
import { isBuilderRecord, HOTFIX_ID_RE, QUICK_ID_RE, TASK_ID_RE, STEP_ID_RE, STORY_ID_RE } from "./vocab.mjs";

export const JOURNAL_REL = join("spec", ".migration-v4.json");

const pad = (n) => String(n).padStart(3, "0");

function listMd(dir) {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

function slugOf(name, id) {
  const rest = name.replace(/\.md$/, "").slice(id.length).replace(/^-/, "");
  return rest || "migrated";
}

function maxId(dirs, re) {
  let max = 0;
  for (const d of dirs) {
    for (const n of listMd(d)) {
      const m = n.match(/^([A-Z]+-?\d+)/);
      if (!m || !re.test(m[1])) continue;
      const num = Number(m[1].replace(/\D/g, ""));
      if (num > max) max = num;
    }
  }
  return max;
}

function readSeq(path) {
  try {
    const n = parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/** Replace or insert a top-level frontmatter scalar line. */
function setFm(text, key, value) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return text;
  const block = m[1];
  const re = new RegExp(`^${key}:.*$`, "m");
  const next = re.test(block) ? block.replace(re, `${key}: ${value}`) : `${block}\n${key}: ${value}`;
  return text.replace(m[1], next);
}

function insertAfterKey(text, afterKey, line) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return text;
  const block = m[1];
  if (new RegExp(`^${line.split(":")[0]}:`, "m").test(block)) return text;
  const re = new RegExp(`^(${afterKey}:.*)$`, "m");
  const next = re.test(block) ? block.replace(re, `$1\n${line}`) : `${block}\n${line}`;
  return text.replace(m[1], next);
}

/**
 * Compute the plan. Pure: reads the tree, writes nothing.
 * @returns {{moves:Array, edits:Array, seq:object, nothing:boolean}}
 */
export function planMigration(dataDir) {
  const spec = join(dataDir, "spec");
  const tasksDir = join(spec, "tasks");
  const bugsDir = join(spec, "bugs");
  const moves = [];
  const aliasToNew = new Map();

  // builder units -> steps
  let nextP = Math.max(maxId([join(spec, "steps"), join(spec, "archive", "steps")], STEP_ID_RE), readSeq(join(spec, "steps", ".id-seq")));
  for (const name of listMd(tasksDir)) {
    const id = (name.match(/^(T\d+)/) || [])[1];
    if (!id || !TASK_ID_RE.test(id)) continue;
    const src = join(tasksDir, name);
    const text = readFileSync(src, "utf8");
    const fm = parseFrontmatter(text);
    if (!isBuilderRecord(fm)) continue; // a v4 task (kind spike|...) stays
    nextP += 1;
    const newId = `P${pad(nextP)}`;
    let out = setFm(text, "id", `"${newId}"`);
    out = setFm(out, "type", "step");
    out = insertAfterKey(out, "id", `aliases: ["${id}"]`);
    const story = String(fm.story || fm.feature || "").trim();
    if (story && !/^story:/m.test(out)) out = insertAfterKey(out, "feature", `story: ${story}`);
    moves.push({ kind: "step", from: src, to: join(spec, "steps", `${newId}-${slugOf(name, id)}.md`), oldId: id, newId, before: text, after: out });
    aliasToNew.set(id, newId);
  }

  // quick tasks -> tasks
  let nextT = Math.max(maxId([tasksDir, join(spec, "archive", "tasks")], TASK_ID_RE), readSeq(join(tasksDir, ".id-seq")));
  for (const name of listMd(tasksDir)) {
    const id = (name.match(/^(Q-\d+)/) || [])[1];
    if (!id || !QUICK_ID_RE.test(id)) continue;
    const src = join(tasksDir, name);
    const text = readFileSync(src, "utf8");
    const fm = parseFrontmatter(text);
    nextT += 1;
    const newId = `T${pad(nextT)}`;
    let out = setFm(text, "id", `"${newId}"`);
    out = setFm(out, "type", "task");
    out = insertAfterKey(out, "type", "kind: chore");
    out = insertAfterKey(out, "id", `aliases: ["${id}"]`);
    const st = String(fm.status || "").trim();
    out = setFm(out, "status", st === "done" || st === "complete" ? "done" : st === "in-progress" ? "in-progress" : "open");
    moves.push({ kind: "task", from: src, to: join(tasksDir, `${newId}-${slugOf(name, id)}.md`), oldId: id, newId, before: text, after: out });
    aliasToNew.set(id, newId);
  }

  // hotfix bugs -> stories (type bug, lane hotfix)
  let nextS = Math.max(maxId([join(spec, "stories"), join(spec, "archive", "stories")], STORY_ID_RE), readSeq(join(spec, "stories", ".id-seq")));
  for (const name of listMd(bugsDir)) {
    const id = (name.match(/^(B-HOT-\d+)/) || [])[1];
    if (!id || !HOTFIX_ID_RE.test(id)) continue;
    const src = join(bugsDir, name);
    const text = readFileSync(src, "utf8");
    const fm = parseFrontmatter(text);
    nextS += 1;
    const newId = `S${pad(nextS)}`;
    let out = setFm(text, "id", newId);
    out = setFm(out, "type", "bug");
    out = insertAfterKey(out, "type", "lane: hotfix");
    out = insertAfterKey(out, "id", `aliases: ["${id}"]`);
    const st = String(fm.status || "").trim();
    out = setFm(out, "status", st === "open" ? "proposed" : st === "fixed" ? "done" : st || "proposed");
    moves.push({ kind: "story", from: src, to: join(spec, "stories", `${newId}-${slugOf(name, id)}.md`), oldId: id, newId, before: text, after: out });
    aliasToNew.set(id, newId);
  }

  // reference rewrites: live stories' tasks: -> steps:, current SPRINT.md wave lists
  const edits = [];
  if (aliasToNew.size > 0) {
    for (const dir of [join(spec, "features"), join(spec, "stories"), join(spec, "bugs")]) {
      for (const name of listMd(dir)) {
        const path = join(dir, name);
        const text = readFileSync(path, "utf8");
        const m = text.match(/^(tasks|steps):\s*\[([^\]\n]*)\]\s*(#.*)?$/m);
        if (!m) continue;
        const ids = m[2].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        const mapped = ids.map((i) => aliasToNew.get(i) ?? i);
        if (m[1] === "steps" && mapped.every((v, i) => v === ids[i])) continue;
        const after = text.replace(m[0], `steps: [${mapped.join(", ")}]${m[3] ? ` ${m[3]}` : ""}`);
        edits.push({ path, before: text, after });
      }
    }
    const sprint = join(dataDir, "sprints", "current", "SPRINT.md");
    if (existsSync(sprint)) {
      const text = readFileSync(sprint, "utf8");
      const after = text.replace(/\b(T\d{3,}|Q-\d+)\b/g, (tok) => aliasToNew.get(tok) ?? tok);
      if (after !== text) edits.push({ path: sprint, before: text, after });
    }
  }

  const seq = {
    steps: { path: join(spec, "steps", ".id-seq"), before: existsSync(join(spec, "steps", ".id-seq")) ? readFileSync(join(spec, "steps", ".id-seq"), "utf8") : null, after: String(nextP) },
    tasks: { path: join(tasksDir, ".id-seq"), before: existsSync(join(tasksDir, ".id-seq")) ? readFileSync(join(tasksDir, ".id-seq"), "utf8") : null, after: String(nextT) },
    stories: { path: join(spec, "stories", ".id-seq"), before: existsSync(join(spec, "stories", ".id-seq")) ? readFileSync(join(spec, "stories", ".id-seq"), "utf8") : null, after: String(nextS) },
  };
  return { moves, edits, seq, nothing: moves.length === 0 && edits.length === 0 };
}

export function renderPlan(plan) {
  const L = [];
  for (const m of plan.moves) L.push(`move ${m.oldId} -> ${m.newId}  ${m.from} -> ${m.to}`);
  for (const e of plan.edits) L.push(`edit ${e.path} (${/SPRINT\.md$/.test(e.path) ? "wave step ids" : "tasks: -> steps:"})`);
  if (plan.nothing) L.push("nothing to migrate");
  return L.join("\n") + "\n";
}

export function applyMigration(dataDir, plan) {
  const journal = { version: 1, applied_at: new Date().toISOString(), moves: [], edits: [], seq: {} };
  for (const m of plan.moves) {
    mkdirSync(join(m.to, ".."), { recursive: true });
    if (existsSync(m.to)) throw new Error(`migrate: destination exists: ${m.to}`);
    atomicWrite(m.to, m.after);
    rmSync(m.from);
    journal.moves.push({ from: m.from, to: m.to, oldId: m.oldId, newId: m.newId, before: m.before });
  }
  for (const e of plan.edits) {
    atomicWrite(e.path, e.after);
    journal.edits.push({ path: e.path, before: e.before });
  }
  for (const [k, v] of Object.entries(plan.seq)) {
    if (plan.moves.some((m) => m.kind === (k === "steps" ? "step" : k === "tasks" ? "task" : "story"))) {
      mkdirSync(join(v.path, ".."), { recursive: true });
      atomicWrite(v.path, v.after);
      journal.seq[k] = { path: v.path, before: v.before };
    }
  }
  atomicWrite(join(dataDir, JOURNAL_REL), JSON.stringify(journal, null, 2) + "\n");
  return journal;
}

export function reverseMigration(dataDir) {
  const jp = join(dataDir, JOURNAL_REL);
  if (!existsSync(jp)) return { reversed: false, reason: "no journal" };
  const journal = JSON.parse(readFileSync(jp, "utf8"));
  for (const e of journal.edits ?? []) atomicWrite(e.path, e.before);
  for (const m of [...(journal.moves ?? [])].reverse()) {
    mkdirSync(join(m.from, ".."), { recursive: true });
    atomicWrite(m.from, m.before);
    rmSync(m.to, { force: true });
  }
  for (const v of Object.values(journal.seq ?? {})) {
    if (v.before === null || v.before === undefined) rmSync(v.path, { force: true });
    else atomicWrite(v.path, v.before);
  }
  rmSync(jp, { force: true });
  return { reversed: true, moves: (journal.moves ?? []).length, edits: (journal.edits ?? []).length };
}

export function migrateMain(dataDir, args = []) {
  const dry = args.includes("--dry-run");
  const reverse = args.includes("--reverse");
  const unknown = args.find((a) => !["--dry-run", "--reverse", "--force"].includes(a));
  if (unknown) {
    process.stderr.write(`shipyard-data migrate: unknown argument "${unknown}". Usage: migrate [--dry-run] [--reverse] [--data-dir <path>]\n`);
    process.exit(2);
  }
  if (reverse) {
    if (dry) {
      const jp = join(dataDir, JOURNAL_REL);
      process.stdout.write(existsSync(jp) ? `would reverse the migration recorded in ${jp}\n` : "nothing to reverse (no journal)\n");
      return;
    }
    const r = reverseMigration(dataDir);
    if (!r.reversed) {
      process.stdout.write("nothing to reverse (no journal)\n");
      return;
    }
    try { logEvent(dataDir, "migration_v4_reversed", { moves: r.moves, edits: r.edits }); } catch { /* best-effort */ }
    process.stdout.write(`reversed: ${r.moves} record(s) moved back, ${r.edits} file(s) restored\n`);
    return;
  }
  const jp = join(dataDir, JOURNAL_REL);
  const plan = planMigration(dataDir);
  if (plan.nothing) {
    process.stdout.write(existsSync(jp) ? "already applied — nothing left to migrate\n" : "nothing to migrate\n");
    return;
  }
  process.stdout.write(renderPlan(plan));
  if (dry) {
    process.stdout.write("dry run — nothing written\n");
    return;
  }
  // Never mid-sprint (4.6). The move renumbers builder records (T### → P###) and
  // rewrites the wave lists, while the event log — never rewritten — keeps the
  // old ids: a sprint in flight would lose the evidence its gates read. Finish
  // and archive the sprint, then migrate. (Seen on a copy of a real project:
  // the waves became P022… while every dispatch and return event said T421….)
  if (!args.includes("--force")) {
    const sprintText = (() => { try { return readFileSync(join(dataDir, "sprints", "current", "SPRINT.md"), "utf8"); } catch { return null; } })();
    const st = sprintText ? String(parseFrontmatter(sprintText).status ?? "").trim().toLowerCase() : "";
    if (sprintText && !["completed", "cancelled", ""].includes(st)) {
      process.stderr.write(`shipyard-data migrate: a sprint is in flight (sprints/current/SPRINT.md status: ${st}) — finish and archive it first (/ship-execute, /ship-review), then migrate. Old and new ids are both read meanwhile, so nothing is blocked. --force overrides (the sprint's event evidence will no longer match its renumbered steps).\n`);
      process.exit(3);
    }
  }
  if (existsSync(jp)) {
    // A second batch after a partial 3.x->4 life (new legacy files appeared). Keep
    // the first journal reversible by refusing to overwrite it.
    process.stderr.write(`shipyard-data migrate: a journal already exists at ${jp} — run \`migrate --reverse\` first, or remove it to accept that the earlier batch can no longer be reversed.\n`);
    process.exit(3);
  }
  const journal = applyMigration(dataDir, plan);
  try { logEvent(dataDir, "migration_v4_applied", { moves: journal.moves.length, edits: journal.edits.length }); } catch { /* best-effort */ }
  process.stdout.write(`applied: ${journal.moves.length} record(s) moved, ${journal.edits.length} file(s) rewritten; journal ${jp}\n`);
}
