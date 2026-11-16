/**
 * `shipyard-data backlog board [--json]` (4.0.1): the whole board as text.
 *
 * Why: `/ship-backlog` told the model to read every story, epic and idea file
 * and compose the board by hand before its first question. Most of the time
 * the owner got a one-line summary and a question card, and no list: the
 * board is dozens of file reads, and nothing made it appear. The board is
 * derivable, so the CLI derives it; the skill prints this output as it is,
 * and the card hook refuses a `/ship-backlog` question until it is in the chat.
 *
 * Sections: in the sprint, backlog (rank order, grouped by epic), proposed,
 * ideas waiting for a decision. Item numbers run across sections so a person
 * can answer with a number. The first and last lines are fixed text the hook
 * looks for (BOARD_HEADER, BOARD_FOOTER).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, parseWaves, sprintStoryIds } from "./terminal-gate.mjs";
import { parseFrontmatterList } from "./frontmatter-list.mjs";
import { readMaxUndispositionedIdeas } from "./config-read.mjs";
import { isPlacedIdea } from "./idea-backlog.mjs";
import { listVersions, versionView } from "./version.mjs";

export const BOARD_HEADER = "BOARD ·";
export const BOARD_FOOTER = "end of board";
const readIf = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const clean = (v) => String(v ?? "").replace(/^["']|["']$/g, "").trim();
const num = (v) => { const n = Number(clean(v)); return Number.isFinite(n) ? n : null; };
const DONE = new Set(["done", "deployed", "released"]);
const IDEA_OPEN = new Set(["captured", "assessing", "proposed"]);

function records(dataDir, dirs) {
  const out = [];
  for (const sub of dirs) {
    let names = [];
    try { names = readdirSync(join(dataDir, "spec", sub)).sort(); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".md")) continue;
      const text = readIf(join(dataDir, "spec", sub, n));
      const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!m) continue;
      const fm = parseFrontmatter(text);
      const id = clean(fm.id);
      if (id) out.push({ id, fm, block: m[1] });
    }
  }
  return out;
}

/** The board as data. Pure over the files it reads. */
export function buildBoard(dataDir, { today = new Date() } = {}) {
  const config = readIf(join(dataDir, "config.md"));
  const project = clean((config.match(/^project_name:\s*(.*)$/m) ?? [])[1]) || "project";
  const strip = (t) => clean(t).replace(new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:\\-–—]\\s*`, "i"), "");
  const stories = records(dataDir, ["stories", "features", "bugs"]);
  // A prefix most titles share ("Shop: ...", the product's name) says nothing on a board of one product: drop it.
  const counts = new Map();
  for (const s of stories) { const m = clean(s.fm.title).match(/^([A-Za-z][\w ]{1,24}):\s/); if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1); }
  const [common, share] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const dropCommon = (t) => (common && share >= stories.length * 0.6 && t.startsWith(`${common}: `) ? t.slice(common.length + 2) : t);
  const byId = new Map(stories.map((s) => [s.id, s]));
  const epics = new Map(records(dataDir, ["epics"]).map((e) => [e.id, strip(e.fm.title)]));
  const stepStatus = new Map(records(dataDir, ["steps", "tasks"]).map((s) => [s.id, clean(s.fm.status)]));
  const item = (s) => {
    const r = num(s.fm.rice_score) ?? (() => {
      const [a, b, c, d] = ["rice_reach", "rice_impact", "rice_confidence", "rice_effort"].map((k) => num(s.fm[k]));
      return a !== null && b !== null && c !== null && d ? Math.round(((a * b * c) / d) * 10) / 10 : null;
    })();
    const deps = parseFrontmatterList(s.block, "dependencies").items.filter((d) => { const o = byId.get(d); return o ? !DONE.has(clean(o.fm.status)) : stepStatus.has(d) ? stepStatus.get(d) !== "done" : false; });
    const steps = [...parseFrontmatterList(s.block, "steps").items, ...parseFrontmatterList(s.block, "tasks").items];
    const updated = Date.parse(clean(s.fm.updated));
    return {
      id: s.id, title: dropCommon(strip(s.fm.title)), status: clean(s.fm.status), epic: clean(s.fm.epic), points: num(s.fm.story_points),
      rice: r && r > 0 ? r : null, waits_for: deps, kind: clean(s.fm.type) === "bug" ? "bug" : "",
      steps: steps.length, steps_done: steps.filter((p) => stepStatus.get(p) === "done").length,
      age_days: Number.isFinite(updated) ? Math.floor((today.getTime() - updated) / 86400000) : null,
    };
  };
  // the sprint
  const sprintText = readIf(join(dataDir, "sprints", "current", "SPRINT.md"));
  const sfm = sprintText ? parseFrontmatter(sprintText) : {};
  const sprintIds = sprintText ? sprintStoryIds(sprintText) : [];
  const sprint = sprintText ? {
    id: clean(sfm.id), goal: clean(sfm.goal), status: clean(sfm.status), waves: parseWaves(sprintText).length,
    items: sprintIds.map((id) => byId.get(id)).filter(Boolean).map(item),
  } : null;
  // the backlog, in the file's rank order
  const backlogText = readIf(join(dataDir, "backlog", "BACKLOG.md"));
  const ranked = [...backlogText.matchAll(/^\|\s*\d+\s*\|\s*([A-Za-z][A-Za-z0-9-]*)\s*\|/gm)].map((m) => m[1]);
  const inSprint = new Set(sprintIds);
  const backlog = ranked.map((id) => byId.get(id)).filter((s) => s && !inSprint.has(s.id) && !DONE.has(clean(s.fm.status))).map(item);
  const listed = new Set([...ranked, ...sprintIds]);
  // approved but not in the backlog file (it should be: say so rather than hide it)
  const unranked = stories.filter((s) => clean(s.fm.status) === "approved" && !listed.has(s.id)).map(item);
  const proposed = stories.filter((s) => ["proposed", "open"].includes(clean(s.fm.status)) && !listed.has(s.id)).map(item);
  const ideas = records(dataDir, ["ideas"]).filter((i) => IDEA_OPEN.has(clean(i.fm.status) || "captured"))
    .map((i) => ({ id: i.id, title: dropCommon(strip(i.fm.title)), source: clean(i.fm.source), created: clean(i.fm.created || i.fm.captured), placed: isPlacedIdea(i.block) }))
    .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  const metrics = readIf(join(dataDir, "memory", "metrics.md"));
  const velocity = num((metrics.match(/^Velocity average:\s*([\d.]+)/m) ?? [])[1]);
  let ideaCap = 12;
  try { ideaCap = readMaxUndispositionedIdeas(dataDir); } catch { /* default */ }
  // whose order the backlog is in, and each placement's reason (`backlog move --why`)
  let order = { ordered_by: "score", why: {} };
  try { const o = JSON.parse(readIf(join(dataDir, "backlog", "order.json")) || "{}"); if (o.ordered_by === "owner") order = { ordered_by: "owner", why: o.why ?? {} }; } catch { /* no order file */ }
  for (const i of backlog) i.why = order.why[i.id]?.text ?? "";
  return { project, sprint, backlog, unranked, proposed, ideas, velocity, idea_cap: ideaCap, owner_order: order.ordered_by === "owner" };
}

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** The board as the text a person reads. */
export function renderBoard(b) {
  const L = [`${BOARD_HEADER} ${b.project}`, ""];
  let n = 0;
  const line = (i, extra = []) => {
    n += 1;
    const facts = [i.points !== null ? `${i.points} pts` : "no points", ...extra, i.rice !== null ? `RICE ${i.rice}` : null, i.kind || null,
      i.waits_for.length ? `waits for ${i.waits_for.join(", ")}` : null, i.age_days !== null && i.age_days >= 60 ? `${i.age_days} days old` : null].filter(Boolean);
    return `  [${String(n).padStart(2)}] ${i.id.padEnd(5)} ${cut(i.title, 62).padEnd(62)} ${facts.join(" · ")}`;
  };
  const grouped = (items) => {
    const order = [];
    const groups = new Map();
    for (const i of items) { const k = i.epic || ""; if (!groups.has(k)) { groups.set(k, []); order.push(k); } groups.get(k).push(i); }
    const out = [];
    for (const k of order) {
      const pts = groups.get(k).reduce((s, i) => s + (i.points ?? 0), 0);
      out.push(` ${k ? `${k} ${cut(b.epics?.get?.(k) ?? "", 60)}`.trim() : "(no epic)"} · ${groups.get(k).length} · ${pts} pts`);
      for (const i of groups.get(k)) out.push(line(i));
    }
    return out;
  };
  // Releases first: what ships when is the question a backlog answers (4.0.1, fix versions).
  if (b.versions?.length) {
    L.push(`RELEASES · ${b.versions.length} planned · the release an item is expected to ship in (its fix version)`);
    for (const v of b.versions) {
      const filled = v.items ? Math.round((v.items_done / v.items) * 10) : 0;
      L.push(`  ${v.name.padEnd(10)} ${(v.target_date || "no date").padEnd(10)} [${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${v.items_done}/${v.items} items · ${v.points_done}/${v.points} pts${v.not_refined ? ` · ${v.not_refined} not broken down yet` : ""}${v.open_checks ? ` · ${v.open_checks} release check(s) open` : ""}${v.title ? ` · ${cut(v.title, 40)}` : ""}`);
    }
    L.push("  details: shipyard-data version show <name>", "");
  }
  if (b.sprint) {
    const pts = b.sprint.items.reduce((s, i) => s + (i.points ?? 0), 0);
    L.push(`IN THE SPRINT · ${b.sprint.id}${b.sprint.goal ? ` · ${cut(b.sprint.goal, 70)}` : ""} · ${b.sprint.items.length} stories · ${pts} pts`);
    for (const i of b.sprint.items) L.push(line(i, [i.steps ? `${i.steps_done}/${i.steps} steps done` : null].filter(Boolean)));
    L.push("");
  }
  const bpts = b.backlog.reduce((s, i) => s + (i.points ?? 0), 0);
  if (b.owner_order) {
    // One list, in the owner's order, the top first: what a sprint pulls next. No grouping: an epic is a tag here.
    L.push(`BACKLOG · ${b.backlog.length} stories · ${bpts} pts · one list in your order, the top is next`);
    if (!b.backlog.length) L.push("  (empty)");
    for (const i of b.backlog) { L.push(line(i, [i.epic || null].filter(Boolean))); if (i.why) L.push(`         why here: ${cut(i.why, 110)}`); }
  } else {
    L.push(`BACKLOG · ${b.backlog.length} stories · ${bpts} pts · ready to pull, in rank order inside each epic`);
    if (!b.backlog.length) L.push("  (empty)");
    L.push(...grouped(b.backlog));
    if (b.backlog.length > 1) L.push('  sorted by score. Put what a delay costs most first: shipyard-data backlog move <id> --top --why "<who is hurt by a week\'s wait, how much>"');
  }
  if (b.velocity) L.push(`  recent pace: about ${Math.round(b.velocity)} pts a sprint, so this is about ${Math.max(1, Math.round(bpts / b.velocity))} sprint(s) of work`);
  const unscored = b.backlog.filter((i) => i.rice === null).map((i) => i.id);
  if (unscored.length) L.push(`  not scored yet (no RICE): ${unscored.join(", ")}`);
  if (b.unranked.length) { L.push("", `APPROVED BUT NOT ON THE BACKLOG LIST · ${b.unranked.length} · add with: shipyard-data backlog add <ids>`); for (const i of b.unranked) L.push(line(i)); }
  if (b.proposed.length) { L.push("", `PROPOSED · ${b.proposed.length} · approve to add to the backlog`); L.push(...grouped(b.proposed)); }
  if (b.ideas.length) {
    const loose = b.ideas.filter((i) => !i.placed).length;
    L.push("", b.ideas.length === loose
      ? `IDEAS · ${b.ideas.length} waiting for a decision (a new sprint waits once there are more than ${b.idea_cap}) · refine with /ship-discuss IDEA-NNN`
      : `IDEAS · ${b.ideas.length} · ${b.ideas.length - loose} have a place (a release or a ticket) and stay coarse until they are next · ${loose} waiting for a decision (a new sprint waits once there are more than ${b.idea_cap}) · refine with /ship-discuss IDEA-NNN`);
    const shown = b.ideas.length > 10 ? [...b.ideas.slice(0, 5), null, ...b.ideas.slice(-5)] : b.ideas;
    for (const i of shown) {
      if (!i) { L.push(`       (${b.ideas.length - 10} more)`); continue; }
      n += 1;
      L.push(`  [${String(n).padStart(2)}] ${i.id.padEnd(8)} ${cut(i.title, 70)}${i.source ? `  (${cut(i.source, 28)})` : ""}`);
    }
  }
  L.push("", `— ${BOARD_FOOTER} · ${n} numbered item(s) —`);
  return L.join("\n");
}

export function main(dataDir, args = []) {
  const b = buildBoard(dataDir);
  b.epics = new Map(records(dataDir, ["epics"]).map((e) => [e.id, clean(e.fm.title)]));
  try {
    b.versions = listVersions(dataDir).filter((v) => v.status !== "released").map((v) => { const w = versionView(dataDir, v.name); return { name: v.name, title: v.title, target_date: v.target_date, items_done: w.done.length, items: w.done.length + w.open.length, points_done: w.points.done, points: w.points.total, not_refined: w.not_refined.length, open_checks: v.checks.filter((c) => !c.done).length }; });
  } catch { b.versions = []; }
  if (args.includes("--json")) { const { epics: _e, ...rest } = b; process.stdout.write(JSON.stringify(rest) + "\n"); return; }
  process.stdout.write(renderBoard(b) + `\n\nNEXT (this line is not part of the board): write the board above as your message, as it is, inside a code block, with one line under it saying what you recommend. The person cannot see this tool result, and cannot see your reasoning. End the message with the line "Question follows." and end your turn there; you get the turn straight back, and then you ask the one question.\n`);
}
