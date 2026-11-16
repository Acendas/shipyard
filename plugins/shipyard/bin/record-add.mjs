/**
 * `shipyard-data story add …` and `shipyard-data task add …` (after 4.0.1)
 *
 * One call writes a coarse story under an epic, or a spike (or another kind of
 * task): the id is allocated, the file has every field a reader expects, the
 * event is logged.
 *
 * Why: breaking an epic down is "write the stories and the spikes". There was
 * no verb for it, so on a real project a discussion looked for one
 * (`story add`, `task` with nothing after it), found none, and wrote 55 story
 * files by hand. Each lacked `refined: false` and half the fields the health
 * check asks for (400 findings), and each carried its epic's ticket as if it
 * were its own. Same lesson as `idea capture`: what a session has to do many
 * times is one CLI call, or it is done by hand and differently each time.
 *
 * A story made here is coarse on purpose (`refined: false`, no points, no
 * criteria): it is refined in `/ship-discuss <id>` when it nears the top of
 * the backlog, and cannot be approved before that. It has no ticket; its
 * epic's ticket is not its ticket. Its fix version is its epic's.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { TASK_KINDS, isStoryId } from "./vocab.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "shipyard-data.mjs");
const q = (s) => JSON.stringify(String(s ?? ""));
const one = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const slug = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "") || "item";
const today = () => new Date().toISOString().slice(0, 10);
function fail(code, msg) { throw Object.assign(new Error(msg), { exitCode: code }); }

function nextId(dataDir, kind) {
  const r = spawnSync(process.execPath, [CLI, "next-id", kind, "--data-dir", dataDir], { encoding: "utf8" });
  const n = (r.stdout || "").trim();
  if (r.status !== 0 || !/^\d+$/.test(n)) fail(1, `could not allocate an id (next-id ${kind}): ${(r.stderr || "").trim().split("\n")[0]}`);
  return n;
}
function has(dataDir, sub, id) {
  try { return readdirSync(join(dataDir, "spec", sub)).some((n) => n.endsWith(".md") && (n.startsWith(`${id}-`) || n === `${id}.md`)); } catch { return false; }
}
/** `--name value` pairs; names in `many` repeat; names in `flags` take no value. */
function parse(args, usage, { many = [], flags = [] } = {}) {
  const o = Object.fromEntries(many.map((m) => [m, []]));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) fail(2, `unexpected argument "${a}"\n  ${usage}`);
    const k = a.slice(2);
    if (flags.includes(k)) { o[k] = true; continue; }
    const v = args[++i];
    if (v === undefined) fail(2, `${a} needs a value\n  ${usage}`);
    if (many.includes(k)) o[k].push(v); else o[k] = v;
  }
  return o;
}
const afterIds = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
function checkAfter(dataDir, ids) {
  for (const d of ids) {
    const ok = isStoryId(d) ? ["stories", "features", "bugs"].some((s) => has(dataDir, s, d)) : /^T\d+$/.test(d) ? has(dataDir, "tasks", d) : false;
    if (!ok) fail(3, `--after ${d}: no such story or task`);
  }
}

export function storyAdd(dataDir, args) {
  const usage = 'usage: story add --title "..." [--epic E###] [--type feature|bug] [--ui] [--as "<who>" --want "<what>" --so "<why>"] [--note "..."] [--after <id,id>]   (a coarse story: refined later in /ship-discuss <id>)';
  const o = parse(args, usage, { flags: ["ui"] });
  const unknown = Object.keys(o).filter((k) => !["title", "epic", "type", "ui", "as", "want", "so", "note", "after"].includes(k));
  if (unknown.length) fail(2, `unknown flag --${unknown[0]}\n  ${usage}`);
  const title = one(o.title);
  if (!title) fail(2, usage);
  const type = o.type ?? "feature";
  if (!["feature", "bug"].includes(type)) fail(2, `--type is feature or bug\n  ${usage}`);
  const epic = one(o.epic);
  if (epic && !/^E\d+$/.test(epic)) fail(2, `--epic takes an epic id (E###), got "${epic}"`);
  if (epic && !has(dataDir, "epics", epic)) fail(3, `--epic ${epic} does not exist under spec/epics/`);
  const after = afterIds(o.after);
  checkAfter(dataDir, after);
  const id = `S${nextId(dataDir, "stories")}`;
  const path = join(dataDir, "spec", "stories", `${id}-${slug(title)}.md`);
  const story = o.as || o.want || o.so
    ? `As ${one(o.as) || "[who]"}, I want ${one(o.want) || "[what]"}, so that ${one(o.so) || "[why]"}.`
    : `As a [user], I want [capability] so that [benefit]. _(not refined yet: write this in /ship-discuss ${id})_`;
  const day = today();
  const content = [
    "---", `id: ${id}`, `title: ${q(title)}`, `type: ${type}`, `epic: ${q(epic)}`, "status: proposed",
    `# coarse: not sprint-ready until refined in /ship-discuss ${id}`, "refined: false", "story_points: 0", `ui: ${o.ui ? "true" : "false"}`,
    "dependencies: []", "references: []", "external_refs: []", "children: []", "steps: []",
    ...(type === "bug" ? ["severity: medium"] : []), `created: ${day}`, `updated: ${day}`, "---", "",
    `# ${title}`, "", "## User Story", "", story, "",
    ...(one(o.note) ? ["## Notes", "", String(o.note).trim(), ""] : []),
    "## Acceptance Criteria", "", "_None yet: refine before approval (`refined: false` blocks `story set-status approved`)._", "",
    "## Decision Log", "", "| Date | Decision | Options | Chosen | Reasoning |", "|------|----------|---------|--------|-----------|",
    `| ${day} | Written as a coarse story${epic ? ` when ${epic} was broken down` : ""} | - | - | story add |`, "",
  ].join("\n");
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, content);
  try { logEvent(dataDir, "story_added", { story: id, epic, type, refined: false }); } catch { /* best-effort */ }
  const notLinked = [];
  for (const d of after) {
    const r = spawnSync(process.execPath, [CLI, "story", "add-dep", id, d, "--data-dir", dataDir], { encoding: "utf8" });
    if (r.status !== 0) notLinked.push(`${d} (${(r.stderr || "").trim().split("\n")[0]})`);
  }
  process.stdout.write(`${id} added${epic ? ` under ${epic}` : ""}${after.length - notLinked.length ? `, waits for ${after.filter((d) => !notLinked.some((n) => n.startsWith(`${d} `))).join(", ")}` : ""}: ${path}\n` +
    (notLinked.length ? `not linked: ${notLinked.join("; ")}\n` : "") + `Refine it when it nears the top: /ship-discuss ${id}\n`);
}

export function taskAdd(dataDir, args) {
  const usage = `usage: task add --title "..." --kind ${TASK_KINDS.join("|")} [--parent <E###|S###>] [--what "..."] [--question "..."]... [--timebox "..."] [--after <id,id>]`;
  const o = parse(args, usage, { many: ["question"] });
  const unknown = Object.keys(o).filter((k) => !["title", "kind", "parent", "what", "question", "timebox", "after"].includes(k));
  if (unknown.length) fail(2, `unknown flag --${unknown[0]}\n  ${usage}`);
  const title = one(o.title);
  if (!title) fail(2, usage);
  const kind = o.kind ?? "";
  if (!TASK_KINDS.includes(kind)) fail(2, `--kind is one of ${TASK_KINDS.join(", ")}\n  ${usage}`);
  const parent = one(o.parent);
  if (parent) {
    const ok = /^E\d+$/.test(parent) ? has(dataDir, "epics", parent) : isStoryId(parent) ? ["stories", "features", "bugs"].some((s) => has(dataDir, s, parent)) : false;
    if (!ok) fail(3, `--parent ${parent}: no such epic or story`);
  }
  const after = afterIds(o.after);
  checkAfter(dataDir, after);
  const id = `T${nextId(dataDir, "tasks")}`;
  const path = join(dataDir, "spec", "tasks", `${id}-${slug(title)}.md`);
  const asks = kind === "spike" || kind === "study" || kind === "debug";
  const doneWhen = asks
    ? ["Each question below has a written answer, inside the timebox. The output is a decision or a proposal to split, not shipped code.", "",
        ...(o.question.length ? o.question.map((x) => `- Question: ${one(x)}`) : ["- Question: "]), `- Timebox: ${one(o.timebox)}`].join("\n")
    : "-";
  const day = today();
  const content = [
    "---", `id: ${id}`, `title: ${q(title)}`, "type: task", `kind: ${kind}`, `parent: ${q(parent)}`, "status: open", 'effort: ""',
    `dependencies: [${after.join(", ")}]`, "external_refs: []", "aliases: []", `created: ${day}`, `updated: ${day}`, "---", "",
    `# ${title}`, "", "## What", "", String(o.what ?? "").trim() || title, "", "## Done When", "", doneWhen, "", "## Findings", "",
  ].join("\n");
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, content);
  try { logEvent(dataDir, "task_added", { task: id, kind, parent }); } catch { /* best-effort */ }
  process.stdout.write(`${id} added (${kind})${parent ? ` under ${parent}` : ""}: ${path}\n${existsSync(path) && asks ? "A story that needs its answer waits for it: shipyard-data story add-dep <S###> " + id + "\n" : ""}`);
}
