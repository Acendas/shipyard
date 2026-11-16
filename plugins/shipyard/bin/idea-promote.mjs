/**
 * `shipyard-data idea promote <IDEA-NNN> [--title "..."] [--size S|M|L|XL]`
 *
 * A refined idea becomes an epic, in one call: the id is allocated, the epic
 * is written, what the idea carried goes with it (its tracker links and their
 * sync block, its fix version, its text), stories and tasks that came in under
 * the idea's ticket move under the epic, and the idea is marked promoted with
 * a pointer to it.
 *
 * Why: the owner's model. An idea (some call it an intent: the same thing) is
 * refined into an epic; the epic is broken down into spikes and stories.
 * Before this only "idea → story" existed, by hand, and an idea had no links
 * to carry.
 *
 * There is no other target (the owner's rule: a refined idea is an epic). A
 * small idea gives a small epic with one story; the stories and spikes are
 * written when the epic is broken down.
 *
 * What it does not do: break the item down or estimate it. A promoted epic is
 * coarse on purpose; `/ship-discuss <E###>` splits it when it nears the top.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { TASK_KINDS } from "./vocab.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "shipyard-data.mjs");
const fail = (code, msg) => { throw Object.assign(new Error(msg), { exitCode: code }); };
const q = (s) => JSON.stringify(String(s ?? ""));
const unq = (v) => String(v ?? "").replace(/\s+#.*$/, "").trim().replace(/^["'](.*)["']$/, "$1");
const scalar = (block, key) => { const m = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m")); return m ? unq(m[1]) : ""; };
const array = (block, key) => { const m = block.match(new RegExp(`^${key}:[ \\t]*\\[([^\\]]*)\\]`, "m")); return m ? m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : []; };
const section = (body, heading) => { // the text under one "## heading", up to the next heading or the end
  const lines = String(body).split("\n");
  const from = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (from === -1) return "";
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((l) => /^## /.test(l));
  return (to === -1 ? rest : rest.slice(0, to)).join("\n").trim();
};
const slug = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "item";
function nextId(dataDir, kind) {
  const r = spawnSync(process.execPath, [CLI, "next-id", kind, "--data-dir", dataDir], { encoding: "utf8" });
  const n = (r.stdout || "").trim();
  if (r.status !== 0 || !/^\d+$/.test(n)) fail(1, `could not allocate an id (next-id ${kind}): ${(r.stderr || "").trim().split("\n")[0]}`);
  return n;
}

export function ideaPromote(dataDir, args) {
  const usage = 'usage: idea promote <IDEA-NNN> [--title "..."] [--size S|M|L|XL]   (a refined idea becomes an epic; its stories and spikes are written when the epic is broken down: /ship-discuss <E###>)';
  const id = args[0];
  const o = {};
  for (let i = 1; i < args.length; i++) { const a = args[i]; if (!a.startsWith("--")) fail(2, usage); const v = args[++i]; if (v === undefined) fail(2, `${a} needs a value\n  ${usage}`); o[a.slice(2)] = v; }
  if (o.to !== undefined && o.to !== "epic") fail(2, `an idea becomes an epic, never a ${o.to} directly: promote it, then break the epic down (/ship-discuss <E###>)\n  ${usage}`);
  if (o.kind !== undefined || o.epic !== undefined) fail(2, usage);
  o.to = "epic";
  if (!id || !/^IDEA-\d+$/.test(id)) fail(2, usage);
  if (o.kind && !TASK_KINDS.includes(o.kind)) fail(2, `--kind is one of ${TASK_KINDS.join(", ")}`);
  if (o.size && !["S", "M", "L", "XL"].includes(o.size)) fail(2, "--size is S, M, L or XL (a rough size, not points)");
  const dir = join(dataDir, "spec", "ideas");
  let name = null;
  try { name = readdirSync(dir).find((n) => n.endsWith(".md") && (n.startsWith(`${id}-`) || n === `${id}.md`)); } catch { /* no ideas */ }
  if (!name) fail(3, `${id} not found under spec/ideas/`);
  const text = readFileSync(join(dir, name), "utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) fail(3, `${id} has no frontmatter block`);
  const block = m[1], body = text.slice(m[0].length);
  const status = scalar(block, "status");
  if (["promoted", "graduated", "rejected", "landed"].includes(status)) fail(3, `${id} is ${status}${scalar(block, "promoted_to") ? ` (→ ${scalar(block, "promoted_to")})` : ""}: nothing to promote`);
  if (o.epic && !existsSync(join(dataDir, "spec", "epics")) ) fail(3, `--epic ${o.epic}: no epics in this project`);
  if (o.epic) { let ok = false; try { ok = readdirSync(join(dataDir, "spec", "epics")).some((n) => n.startsWith(`${o.epic}-`) || n === `${o.epic}.md`); } catch { ok = false; } if (!ok) fail(3, `--epic ${o.epic} does not exist under spec/epics/`); }

  const title = String(o.title ?? scalar(block, "title")).replace(/\s+/g, " ").trim();
  const refs = array(block, "external_refs");
  const fixVersion = scalar(block, "fix_version");
  const idea = section(body, "Idea") || title;
  const why = section(body, "Why It Might Matter");
  const upstream = (body.match(/^## Upstream ticket[\s\S]*$/m) || [""])[0].trim();
  const today = new Date().toISOString().slice(0, 10);
  const upstreamFm = (block.match(/^upstream:\n(?:[ \t]+.*\n?)*/m) || [""])[0].trimEnd();
  const common = [`external_refs: [${refs.map(q).join(", ")}]`, fixVersion ? `fix_version: ${q(fixVersion)}` : null, `promoted_from: ${id}`, `created: ${today}`, `updated: ${today}`, ...(upstreamFm ? ["upstream_changed: false", upstreamFm] : [])];
  let target, path, content;
  if (o.to === "epic") {
    target = `E${nextId(dataDir, "epics")}`;
    path = join(dataDir, "spec", "epics", `${target}-${slug(title)}.md`);
    content = ["---", `id: ${target}`, `title: ${q(title)}`, "type: epic", "status: proposed", `size: ${q(o.size ?? "")}          # S | M | L | XL: a rough size at intake, not points`, ...common.filter(Boolean), "---",
      "<!-- Epic membership is derived from story files (epic: field). Do NOT add a stories: array here. -->", "", `# ${title}`, "", "## Description", "", idea, "", "## Business Value", "", why || "-", "", "## Dependencies", "", "## Integration Acceptance Criteria", "",
      `<!-- Not broken down yet. When it nears the top of the backlog: /ship-discuss ${target} (spikes for what is unknown, then stories). -->`, upstream ? `\n${upstream}` : "", ""].join("\n");
  } else if (o.to === "story") {
    target = `S${nextId(dataDir, "stories")}`;
    path = join(dataDir, "spec", "stories", `${target}-${slug(title)}.md`);
    content = ["---", `id: ${target}`, `title: ${q(title)}`, "type: feature", `epic: ${q(o.epic ?? "")}`, "status: proposed", `# promoted from an idea: not sprint-ready until refined in /ship-discuss ${target}`, "refined: false", "story_points: 0", 'complexity: ""', "token_estimate: 0",
      "rice_reach: 0", "rice_impact: 0", "rice_confidence: 0", "rice_effort: 0", "rice_score: 0", "feasibility: 0", "dependencies: []", "references: []", ...common.filter(Boolean).filter((l) => !/^(created|updated):/.test(l)).filter((l) => !/^(upstream|  |upstream_changed)/.test(l)), "children: []", "steps: []", `created: ${today}`, `updated: ${today}`, ...(upstreamFm ? ["upstream_changed: false", upstreamFm] : []), "---", "",
      `# ${title}`, "", "## User Story", "", `As a [user], I want [capability] so that [benefit]. _(not refined yet: write this in /ship-discuss ${target})_`, "", "## Why This Matters", "", why || "-", "", "## Notes from the idea", "", idea, "", "## Acceptance Criteria", "", "_None yet._", upstream ? `\n${upstream}` : "", ""].join("\n");
  } else {
    const kind = o.kind ?? "spike";
    target = `T${nextId(dataDir, "tasks")}`;
    path = join(dataDir, "spec", "tasks", `${target}-${slug(title)}.md`);
    const doneWhen = kind === "spike" || kind === "study" ? "Each question below has a written answer, inside the timebox. The output is a decision or a proposal to split, not shipped code.\n\n- Question: \n- Timebox: " : "-";
    content = ["---", `id: ${target}`, `title: ${q(title)}`, "type: task", `kind: ${kind}`, `parent: ${q(o.epic ?? id)}`, "status: open", 'effort: ""', "dependencies: []", ...common.filter(Boolean).filter((l) => !/^(created|updated):/.test(l)).filter((l) => !/^(upstream|  |upstream_changed)/.test(l)), "aliases: []", `created: ${today}`, `updated: ${today}`, ...(upstreamFm ? ["upstream_changed: false", upstreamFm] : []), "---", "",
      `# ${title}`, "", "## What", "", idea, "", "## Done When", "", doneWhen, "", "## Findings", upstream ? `\n${upstream}` : "", ""].join("\n");
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, content);
  // Work that came in under the idea's ticket (its `upstream.parent`) now has an epic to sit under.
  const adopted = [];
  if (o.to === "epic" && refs.length) {
    for (const [sub, field] of [["stories", "epic"], ["tasks", "parent"]]) {
      let names = [];
      try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith(".md")) continue;
        const p = join(dataDir, "spec", sub, n);
        const t = readFileSync(p, "utf8");
        const mm = t.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (!mm) continue;
        const parentKey = unq((mm[1].match(/^  parent:[ \t]*(.*)$/m) || [])[1]);
        if (!parentKey || !refs.includes(parentKey) || scalar(mm[1], field)) continue;
        const cid = scalar(mm[1], "id");
        if (sub === "stories") {
          const rr = spawnSync(process.execPath, [CLI, "story", "set", cid, `epic=${target}`, "--data-dir", dataDir], { encoding: "utf8" });
          if (rr.status === 0) adopted.push(cid);
        } else {
          const re = /^parent:.*$/m;
          atomicWrite(p, t.replace(mm[1], re.test(mm[1]) ? mm[1].replace(re, `parent: ${q(target)}`) : `${mm[1]}\nparent: ${q(target)}`));
          adopted.push(cid);
        }
      }
    }
  }
  // The idea's own record: through the lifecycle verb, so the transition is checked and logged once.
  const r = spawnSync(process.execPath, [CLI, "idea", "set-status", id, "promoted", "--to", target, "--data-dir", dataDir], { encoding: "utf8" });
  if (r.status !== 0) fail(1, `${target} was written (${path}) but ${id} could not be marked promoted: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`);
  try { logEvent(dataDir, "idea_promoted", { idea: id, to: target, kind: o.to === "task" ? o.kind ?? "spike" : o.to, fix_version: fixVersion, external_refs: refs.join(",") }); } catch { /* best-effort */ }
  process.stdout.write(`${id} promoted to ${target}: ${path}\n` + (refs.length ? `  carried: ${refs.join(", ")}${fixVersion ? `, fix version ${fixVersion}` : ""}\n` : fixVersion ? `  carried: fix version ${fixVersion}\n` : "") +
    (adopted.length ? `  now under ${target}: ${adopted.join(", ")} (they came in under the same ticket)\n` : "") +
    (o.to === "epic" ? `Break it down when it nears the top: /ship-discuss ${target}\n` : o.to === "story" ? `Refine it: /ship-discuss ${target}\n` : `Run it: /ship-execute --task ${target}\n`));
}
