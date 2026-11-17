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
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { TASK_KINDS, isStoryId } from "./vocab.mjs";
import { items as versionItems, setFixVersion } from "./version.mjs";

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
  const usage = 'usage: story add --title "..." [--epic E###] [--type feature|bug] [--ui] [--as "<who>" --want "<what>" --so "<why>"] [--note "..."] [--after <id,id>] [--version <name>]   (a coarse story: refined later in /ship-discuss <id>)';
  const o = parse(args, usage, { flags: ["ui"] });
  const unknown = Object.keys(o).filter((k) => !["title", "epic", "type", "ui", "as", "want", "so", "note", "after", "version"].includes(k));
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
  // Its release (after 4.0.2, live: five stories split out of a story in a release had no release, the sprint offered
  // that release without them, and the owner asked where they had gone). Named with --version; else its
  // epic's (derived, nothing is written); else, with no epic, the one release shared by what it waits for.
  let version = one(o.version), versionWhy = "";
  if (!version && !epic && after.length) {
    const all = versionItems(dataDir);
    const theirs = [...new Set(after.map((d) => all.find((x) => x.id === d)?.version).filter(Boolean))];
    if (theirs.length === 1) { version = theirs[0]; versionWhy = ` (the release of ${after.join(", ")}, which it waits for)`; }
  }
  const id = `S${nextId(dataDir, "stories")}`;
  const path = join(dataDir, "spec", "stories", `${id}-${slug(title)}.md`);
  const who = one(o.as);
  const story = o.as || o.want || o.so
    ? `As ${who ? (/^(an?|the|every|any|each)\s/i.test(who) ? who : `${/^[aeiou]/i.test(who) ? "an" : "a"} ${who}`) : "[who]"}, I want ${one(o.want) || "[what]"}, so that ${one(o.so) || "[why]"}.`
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
  let versionLine = "";
  if (version) {
    try { setFixVersion(dataDir, version, [id]); versionLine = `release: ${version}${versionWhy}\n`; }
    catch (e) { versionLine = `not placed in ${version}: ${e.message}\n`; }
  }
  process.stdout.write(`${id} added${epic ? ` under ${epic}` : ""}${after.length - notLinked.length ? `, waits for ${after.filter((d) => !notLinked.some((n) => n.startsWith(`${d} `))).join(", ")}` : ""}: ${path}\n` +
    (notLinked.length ? `not linked: ${notLinked.join("; ")}\n` : "") + versionLine + `Refine it when it nears the top: /ship-discuss ${id}\n`);
}

/**
 * `shipyard-data story refine <S###> --body <file.md> [--points <n>] [--rice <reach>,<impact>,<confidence %>,<effort>]
 *      [--probe auto|assisted|manual --probe-command "<cmd>" --probe-steps <file>]`
 *
 * The other half of `story add` and `tracker pull` (after 4.0.2). A coarse story says `refined: false` and the
 * approval gate refuses it "until refined", but nothing said how it becomes refined: on a real project two
 * sessions each wrote a script that rewrote the story file (the body, `refined: true`, the points, the probe
 * block), one of them twice, and a third filled in fields by hand. One call does it: the body is replaced by the
 * drafted text (the title line, the ticket's own text and the decision log are kept), the story is marked
 * refined, its numbers are set, its criteria get their ids, and the checks an approval runs are run and printed.
 * It approves nothing: that is the person's answer.
 */
export function storyRefine(dataDir, args) {
  const usage = 'usage: story refine <S###> --body <file.md> [--points <n>] [--rice <reach>,<impact>,<confidence %>,<effort>] [--probe auto|assisted|manual --probe-command "<cmd>" [--probe-steps <file>]]';
  const id = args[0];
  if (!id || id.startsWith("--")) fail(2, usage);
  const o = parse(args.slice(1), usage);
  const unknown = Object.keys(o).filter((k) => !["body", "points", "rice", "probe", "probe-command", "probe-steps"].includes(k));
  if (unknown.length) fail(2, `unknown flag --${unknown[0]}\n  ${usage}`);
  if (!isStoryId(id)) fail(2, `"${id}" is not a story id\n  ${usage}`);
  let path = "";
  for (const sub of ["stories", "features", "bugs"]) {
    try { const n = readdirSync(join(dataDir, "spec", sub)).find((f) => f.endsWith(".md") && (f.startsWith(`${id}-`) || f === `${id}.md`)); if (n) { path = join(dataDir, "spec", sub, n); break; } } catch { /* no such folder */ }
  }
  if (!path) fail(3, `${id}: no such story`);
  if (!o.body) fail(2, `--body <file.md> is the refined text (user story, why, paths, acceptance criteria)\n  ${usage}`);
  let body = "";
  try { body = readFileSync(String(o.body), "utf8"); } catch { fail(3, `--body ${o.body}: cannot be read`); }
  body = body.replace(/^\uFEFF/, "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").replace(/^\s*#\s+[^\n]*\n/, "").trim();
  if (body.length < 40) fail(3, `--body ${o.body}: nothing to refine with (the file is empty or only a title)`);
  const probe = o.probe === undefined ? null : String(o.probe);
  if (probe !== null && !["auto", "assisted", "manual"].includes(probe)) fail(2, `--probe is auto, assisted or manual\n  ${usage}`);
  const probeCommand = String(o["probe-command"] ?? "").trim();
  let probeSteps = "";
  if (o["probe-steps"]) { try { probeSteps = readFileSync(String(o["probe-steps"]), "utf8").trim(); } catch { fail(3, `--probe-steps ${o["probe-steps"]}: cannot be read`); } }
  if (probe === "auto" && !probeCommand) fail(2, '--probe auto needs --probe-command "<the command whose exit code is the proof>"');
  if ((probe === "assisted" || probe === "manual") && !probeSteps) fail(2, `--probe ${probe} needs --probe-steps <file> (what a person does and what they should see, one numbered line each)`);
  if (probe === null && (probeCommand || probeSteps)) fail(2, "--probe-command and --probe-steps go with --probe auto|assisted|manual");
  let rice = null;
  if (o.rice !== undefined) {
    rice = String(o.rice).split(",").map((x) => x.trim());
    if (rice.length !== 4 || rice.some((x) => !/^\d+(\.\d+)?$/.test(x))) fail(2, `--rice takes four numbers: reach,impact,confidence %,effort (for example 6,1,70,0.5)\n  ${usage}`);
  }
  if (o.points !== undefined && !/^\d+$/.test(String(o.points))) fail(2, `--points takes a whole number\n  ${usage}`);

  const text = readFileSync(path, "utf8");
  const m = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)([\s\S]*)$/);
  if (!m) fail(3, `${id}: the file has no frontmatter block`);
  let block = m[2];
  const rest = m[4];
  const title = (rest.match(/^#\s+(.+)$/m) || [])[1] ?? (block.match(/^title:\s*"?(.*?)"?\s*$/m) || [])[1] ?? id;
  const section = (name) => { const i = rest.search(new RegExp(`^## ${name}\\b`, "m")); return i === -1 ? "" : rest.slice(i); };
  // the ticket's own text is data that came with the story: it stays, after the refined text
  const upstream = /^## Upstream ticket\b/m.test(body) ? "" : section("Upstream ticket").trim();
  let log = "";
  if (!/^## Decision Log\b/m.test(body)) {
    const old = section("Decision Log");
    const end = old.slice(3).search(/^## /m);
    log = (end === -1 ? old : old.slice(0, end + 3)).trim() || "## Decision Log\n\n| Date | Decision | Options | Chosen | Reasoning |\n|------|----------|---------|--------|-----------|";
    log += `\n| ${today()} | Refined: user story, paths and acceptance criteria written | - | - | story refine |`;
  }
  // frontmatter: refined, and the probe block when one is given
  block = block.split(/\r?\n/).filter((l) => !/^#\s*coarse:/.test(l)).join("\n");
  block = /^refined:.*$/m.test(block) ? block.replace(/^refined:.*$/m, "refined: true") : block.replace(/^(status:.*)$/m, "$1\nrefined: true");
  if (probe !== null) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => /^(user_flow_probe|demo_probe):/.test(l));
    if (at !== -1) { let end = at + 1; while (end < lines.length && (/^[ \t]+/.test(lines[end]) || !lines[end].trim())) end++; lines.splice(at, end - at); }
    const ind = (t) => t.split(/\r?\n/).map((l) => `    ${l}`.trimEnd()).join("\n");
    const pb = ["user_flow_probe:", `  kind: ${probe}`, ...(probeCommand ? ["  command: |", ind(probeCommand)] : []), ...(probeSteps ? ["  steps: |", ind(probeSteps)] : [])];
    const before = lines.findIndex((l) => /^created:/.test(l));
    lines.splice(before === -1 ? lines.length : before, 0, ...pb);
    block = lines.join("\n");
  }
  const out = `${m[1]}${block}${m[3]}\n# ${title}\n\n${body}\n${log ? `\n${log}\n` : ""}${upstream ? `\n${upstream}\n` : ""}`;
  atomicWrite(path, out);
  const call = (...a) => spawnSync(process.execPath, [CLI, ...a, "--data-dir", dataDir], { encoding: "utf8" });
  const last = (r) => ((r.stdout || "") + (r.stderr || "")).trim().split("\n").filter(Boolean).pop() ?? "";
  const sets = [...(o.points !== undefined ? [`story_points=${o.points}`] : []), ...(rice ? [`rice_reach=${rice[0]}`, `rice_impact=${rice[1]}`, `rice_confidence=${rice[2]}`, `rice_effort=${rice[3]}`] : []), `updated=${today()}`];
  const set = call("story", "set", id, ...sets);
  call("story", "assign-ac-ids", id);
  const scenarios = call("story", "check-scenarios", id);
  const probes = call("story", "check-probes", id);
  try { logEvent(dataDir, "story_refined", { story: id, points: o.points ?? "", probe: probe ?? "" }); } catch { /* best-effort */ }
  const ready = set.status === 0 && scenarios.status === 0 && probes.status === 0;
  process.stdout.write([
    `${id} refined: ${path}`,
    ...(set.status === 0 ? [] : [`  numbers not set: ${last(set)}`]),
    `  scenarios: ${scenarios.status === 0 ? "start from the behaviour" : last(scenarios)}`,
    `  proof: ${probes.status === 0 ? last(probes) : last(probes)}`,
    ready
      ? `NEXT: show the person its criteria (shipyard-data story acs ${id}), one plain line each, and ask for approval; then  shipyard-data story set-status ${id} approved`
      : `NEXT: fix what is listed above in ${o.body}, then run this again. It is not ready to be approved yet.`,
    "",
  ].join("\n"));
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
