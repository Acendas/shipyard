/**
 * `shipyard-data version <add|list|show|set|clear|check|release>` — fix versions.
 *
 * A fix version is the release an item is expected to ship in. It is a
 * forecast: the sprint is where work happens, the fix version is where it
 * ships. Epics, stories (bugs included), tasks and ideas carry `fix_version`;
 * a story or task with none takes its epic's.
 *
 * Why (the owner, on a real project): a discussion about "the v4.2.0 release"
 * made an epic to stand for the release, because Shipyard had no other place
 * for it. An epic is a capability (a coarse backlog item), never a release:
 * one release holds parts of several capabilities and one capability can ship
 * across releases.
 *
 *   add <name> [--title "..."] [--date YYYY-MM-DD] [--check "..."]...
 *   list [--json]
 *   show <name> [--json]            every item in it, what is done, the release checks
 *   set <name> <id> [<id>...] [--reason "..."]   moving an item from another version needs the reason
 *   clear <id> [<id>...] --reason "..."
 *   rename <name> <new name>        every item in it follows
 *   check <name> <n|text> --answer "<the person's words>"   tick a release check
 *   release <name>                  refused while an item is unfinished or a check is open
 *
 * The record is `<data>/releases/versions/<name>.md`. Its "Release checks"
 * list is the work a finished item does not cover (a look on the device, a
 * configuration push, sign-off): kept visible beside the items, not hidden
 * inside "done".
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, logEvent, withLockfile } from "./_hook_lib.mjs";

export const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const FINISHED = new Set(["done", "deployed", "released", "landed"]);
const GONE = new Set(["rejected", "deferred", "dropped", "promoted"]);
const KINDS = [
  { kind: "epic", dirs: ["epics"], re: /^E\d+/ },
  { kind: "story", dirs: ["stories", "features", "bugs"], re: /^(S\d+|F\d+|B-?[A-Z0-9-]*\d+)/ },
  { kind: "task", dirs: ["tasks"], re: /^T\d+/ },
  { kind: "idea", dirs: ["ideas"], re: /^IDEA-\d+/ },
];

export function versionsDir(dataDir) { return join(dataDir, "releases", "versions"); }
const versionPath = (dataDir, name) => join(versionsDir(dataDir), `${name}.md`);
const today = () => new Date().toISOString().slice(0, 10);
const unq = (v) => String(v ?? "").replace(/\s+#.*$/, "").trim().replace(/^["'](.*)["']$/, "$1");
function parseFm(text) {
  const m = String(text).match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  return m ? { open: m[1], block: m[2], close: m[3], rest: text.slice(m[0].length) } : null;
}
const scalar = (block, key) => { const m = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m")); return m ? unq(m[1]) : ""; };
function setScalar(block, key, value) {
  const line = `${key}: ${value}`;
  const re = new RegExp(`^${key}:.*$`, "m");
  if (re.test(block)) return block.replace(re, line);
  // beside the status line when there is one, so the field is easy to find
  return /^status:.*$/m.test(block) ? block.replace(/^status:.*$/m, (s) => `${s}\n${line}`) : `${block}\n${line}`;
}

/** Every epic, story, task and idea: { id, kind, path, title, status, epic, points, own } (own = its own fix_version). */
export function items(dataDir) {
  const out = [];
  for (const k of KINDS) for (const sub of k.dirs) {
    let names = [];
    try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".md") || n.startsWith(".")) continue;
      const path = join(dataDir, "spec", sub, n);
      let fm = null;
      try { fm = parseFm(readFileSync(path, "utf8")); } catch { continue; }
      if (!fm) continue;
      const id = scalar(fm.block, "id");
      if (!id || !k.re.test(id)) continue;
      out.push({ id, kind: k.kind, path, title: scalar(fm.block, "title"), status: scalar(fm.block, "status"), epic: scalar(fm.block, "epic") || (k.kind === "task" && /^E\d+$/.test(scalar(fm.block, "parent")) ? scalar(fm.block, "parent") : ""), points: Number(scalar(fm.block, "story_points")) || 0, own: scalar(fm.block, "fix_version") });
    }
  }
  const epicVersion = new Map(out.filter((i) => i.kind === "epic").map((e) => [e.id, e.own]));
  for (const i of out) { i.version = i.own || (i.kind !== "epic" && i.epic ? epicVersion.get(i.epic) ?? "" : ""); i.inherited = !i.own && Boolean(i.version); }
  return out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export function readVersion(dataDir, name) {
  let text;
  try { text = readFileSync(versionPath(dataDir, name), "utf8"); } catch { return null; }
  const fm = parseFm(text);
  if (!fm) return null;
  const checks = [...fm.rest.matchAll(/^- \[( |x|X)\] (.+)$/gm)].map((m, i) => ({ n: i + 1, done: m[1] !== " ", text: m[2].trim() }));
  return { name, title: scalar(fm.block, "title"), target_date: scalar(fm.block, "target_date"), status: scalar(fm.block, "status") || "planned", released_at: scalar(fm.block, "released_at"), checks, fm, text };
}
export function listVersions(dataDir) {
  let names = [];
  try { names = readdirSync(versionsDir(dataDir)); } catch { return []; }
  return names.filter((n) => n.endsWith(".md")).map((n) => readVersion(dataDir, n.slice(0, -3))).filter(Boolean)
    .sort((a, b) => (a.target_date || "9999").localeCompare(b.target_date || "9999") || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** Create the version when it does not exist yet. Returns true when it was created. */
export function ensureVersion(dataDir, name, { title = "", date = "", checks = [] } = {}) {
  if (!VERSION_RE.test(name)) throw Object.assign(new Error(`"${name}" is not a version name (letters, digits, dots, dashes; 40 at most), for example v4.2.0`), { exitCode: 2 });
  if (date && !/^\d{4}-\d\d-\d\d$/.test(date)) throw Object.assign(new Error(`--date ${date}: use YYYY-MM-DD`), { exitCode: 2 });
  if (existsSync(versionPath(dataDir, name))) return false;
  mkdirSync(versionsDir(dataDir), { recursive: true });
  const body = [
    "---", `name: ${JSON.stringify(name)}`, `title: ${JSON.stringify(title)}`, `target_date: ${JSON.stringify(date)}`, "status: planned", 'released_at: ""', `created: ${today()}`, "---", "",
    `# ${name}${title ? ` — ${title}` : ""}`, "", "## Goal", "", "-", "",
    "## Release checks", "", "<!-- Work a finished item does not cover: a look on the device, a configuration push, sign-off, release notes. One line each. Tick with: shipyard-data version check <name> <n> --answer \"...\" -->",
    ...checks.map((c) => `- [ ] ${String(c).replace(/\s+/g, " ").trim()}`), "",
  ].join("\n");
  atomicWrite(versionPath(dataDir, name), body);
  try { logEvent(dataDir, "version_added", { version: name, target_date: date }); } catch { /* best-effort */ }
  return true;
}

/** Put items in a version (or take them out with name = ""). Returns [{id, from, to}]. */
export function setFixVersion(dataDir, name, ids, { reason = "" } = {}) {
  if (name) {
    const v = readVersion(dataDir, name);
    if (!v) throw Object.assign(new Error(`no version "${name}". Versions: ${listVersions(dataDir).map((x) => x.name).join(", ") || "(none)"}. Add it: shipyard-data version add ${name} [--date YYYY-MM-DD]`), { exitCode: 3 });
    if (v.status === "released") throw Object.assign(new Error(`${name} is released (${v.released_at}): put the item in the next version`), { exitCode: 3 });
  }
  const all = items(dataDir);
  const changed = [];
  mkdirSync(join(dataDir, ".locks"), { recursive: true });
  withLockfile(join(dataDir, ".locks", "fix-version.lock"), () => {
    const plan = [];
    for (const id of ids) {
      const it = all.find((x) => x.id === id);
      if (!it) throw Object.assign(new Error(`${id} is not an epic, story, task or idea in this project`), { exitCode: 3 });
      if (it.own === name) continue;
      // The forecast is moved openly: a change of version (or taking one away) says why.
      if (it.own && !String(reason).trim()) throw Object.assign(new Error(`${id} is in ${it.own}: moving it ${name ? `to ${name}` : "out"} needs --reason "<why the forecast changed>"`), { exitCode: 3 });
      plan.push(it);
    }
    for (const it of plan) {
      const fm = parseFm(readFileSync(it.path, "utf8"));
      atomicWrite(it.path, `${fm.open}${setScalar(fm.block, "fix_version", JSON.stringify(name))}${fm.close}${fm.rest}`);
      changed.push({ id: it.id, from: it.own, to: name });
      try { logEvent(dataDir, "fix_version_set", { id: it.id, from: it.own, to: name, reason: String(reason).trim().slice(0, 300) }); } catch { /* best-effort */ }
    }
  }, { ttlMs: 10000, retryMs: 50, maxRetries: 200 });
  return changed;
}

/** What a version holds: { version, rows, open, done, points, unknown }. */
export function versionView(dataDir, name) {
  const v = readVersion(dataDir, name);
  if (!v) return null;
  const live = items(dataDir).filter((i) => i.version === name && !GONE.has(i.status)); // a promoted idea lives on as what it became
  const rows = live;
  const work = live.filter((r) => r.kind !== "epic" && r.kind !== "idea"); // what ships: stories and tasks
  const done = work.filter((r) => FINISHED.has(r.status));
  return {
    version: { name: v.name, title: v.title, target_date: v.target_date, status: v.status, released_at: v.released_at, checks: v.checks },
    rows, open: work.filter((r) => !FINISHED.has(r.status)), done,
    not_refined: live.filter((r) => r.kind === "idea" || (r.kind === "epic" && !live.some((x) => x.kind !== "epic" && x.epic === r.id))),
    points: { done: done.reduce((n, r) => n + r.points, 0), total: work.reduce((n, r) => n + r.points, 0) },
  };
}

function usage(msg) {
  process.stderr.write(
    `shipyard-data version: ${msg}\n` +
      '  Usage: version add <name> [--title "..."] [--date YYYY-MM-DD] [--check "..."]... | version list [--json] | version show <name> [--json]\n' +
      '         version set <name> <id> [<id>...] [--reason "..."] | version clear <id> [<id>...] --reason "..."\n' +
      '         version check <name> <n> --answer "<the person\'s words>" | version release <name> | version rename <name> <new name>\n',
  );
  process.exit(2);
}
function parse(args) {
  const o = { _: [], check: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") { o.json = true; continue; }
    if (a.startsWith("--")) { const v = args[++i]; if (v === undefined) usage(`${a} needs a value`); if (a === "--check") o.check.push(v); else o[a.slice(2)] = v; }
    else o._.push(a);
  }
  return o;
}
const bar = (done, total) => { const n = total ? Math.round((done / total) * 10) : 0; return `[${"█".repeat(n)}${"░".repeat(10 - n)}]`; };

export function main(dataDir, args = []) {
  const sub = args[0];
  const o = parse(args.slice(1));
  try {
    if (sub === "add") {
      const name = o._[0];
      if (!name) usage("add needs a name, for example v4.2.0");
      const made = ensureVersion(dataDir, name, { title: o.title ?? "", date: o.date ?? "", checks: o.check });
      process.stdout.write(made ? `version ${name} added${o.date ? `, expected ${o.date}` : ""}. Put items in it: shipyard-data version set ${name} <id> [<id>...]\n` : `version ${name} already exists\n`);
      return;
    }
    if (sub === "list") {
      const vs = listVersions(dataDir).map((v) => { const w = versionView(dataDir, v.name); return { name: v.name, title: v.title, status: v.status, target_date: v.target_date, items_done: w.done.length, items: w.done.length + w.open.length, points_done: w.points.done, points: w.points.total, not_refined: w.not_refined.length, open_checks: v.checks.filter((c) => !c.done).length }; });
      const known = new Set(vs.map((v) => v.name));
      const unknown = items(dataDir).filter((i) => i.own && !known.has(i.own)).map((i) => ({ id: i.id, fix_version: i.own }));
      const none = items(dataDir).filter((i) => !i.version && i.kind !== "idea" && !GONE.has(i.status) && !FINISHED.has(i.status)).length;
      if (o.json) { process.stdout.write(JSON.stringify({ versions: vs, unknown, without_version: none }) + "\n"); return; }
      if (!vs.length) process.stdout.write("no fix version yet. Add one: shipyard-data version add <name> [--date YYYY-MM-DD]\n");
      for (const v of vs) process.stdout.write(`${v.name.padEnd(12)} ${v.status.padEnd(8)} ${(v.target_date || "no date").padEnd(10)} ${bar(v.items_done, v.items)} ${v.items_done}/${v.items} items, ${v.points_done}/${v.points} pts${v.not_refined ? `, ${v.not_refined} not broken down yet` : ""}${v.open_checks ? `, ${v.open_checks} release check(s) open` : ""}${v.title ? `  ${v.title}` : ""}\n`);
      if (none) process.stdout.write(`${none} open item(s) have no fix version (not forecast for a release yet).\n`);
      for (const u of unknown) process.stdout.write(`! ${u.id} names version "${u.fix_version}", which does not exist: shipyard-data version add ${u.fix_version}\n`);
      return;
    }
    if (sub === "show") {
      const name = o._[0];
      if (!name) usage("show needs a version name");
      const w = versionView(dataDir, name);
      if (!w) { process.stderr.write(`shipyard-data version: no version "${name}"\n`); process.exit(3); }
      if (o.json) { process.stdout.write(JSON.stringify({ ...w, rows: w.rows.map(({ path: _p, ...r }) => r), open: w.open.map((r) => r.id), done: w.done.map((r) => r.id), not_refined: w.not_refined.map((r) => r.id) }) + "\n"); return; }
      const v = w.version, L = [];
      L.push(`VERSION ${v.name}${v.title ? ` — ${v.title}` : ""} · ${v.status}${v.released_at ? ` ${v.released_at}` : ""}${v.target_date ? ` · expected ${v.target_date}` : ""}`);
      L.push(`${bar(w.done.length, w.done.length + w.open.length)} ${w.done.length}/${w.done.length + w.open.length} items done · ${w.points.done}/${w.points.total} points`);
      for (const [label, kind] of [["Capabilities (epics)", "epic"], ["Stories", "story"], ["Tasks", "task"], ["Ideas not broken down yet", "idea"]]) {
        const rows = w.rows.filter((r) => r.kind === kind);
        if (!rows.length) continue;
        L.push("", `${label}:`);
        for (const r of rows) L.push(`  ${r.id.padEnd(9)} ${String(r.status || "?").padEnd(12)} ${r.kind === "story" ? `${String(r.points).padStart(2)} pts  ` : ""}${r.title}${r.inherited ? `  (from ${r.epic})` : ""}`);
      }
      if (!w.rows.length) L.push("", "Nothing is in this version yet.");
      L.push("", "Release checks:");
      if (!v.checks.length) L.push("  (none listed; add what a finished item does not cover to the version file)");
      for (const c of v.checks) L.push(`  ${c.n}. [${c.done ? "x" : " "}] ${c.text}`);
      process.stdout.write(L.join("\n") + "\n");
      return;
    }
    if (sub === "set" || sub === "clear") {
      const name = sub === "set" ? o._[0] : "";
      const ids = sub === "set" ? o._.slice(1) : o._;
      if (sub === "set" && !name) usage("set needs a version name and at least one id");
      if (!ids.length) usage(`${sub} needs at least one id`);
      if (sub === "clear" && !String(o.reason ?? "").trim()) usage('clear needs --reason "<why>"');
      const changed = setFixVersion(dataDir, name, ids, { reason: o.reason ?? "" });
      if (!changed.length) { process.stdout.write("nothing to change\n"); return; }
      for (const c of changed) process.stdout.write(`${c.id}: fix version ${c.from ? `${c.from} → ` : ""}${c.to || "(none)"}\n`);
      return;
    }
    if (sub === "rename") {
      // The name is often not known when the release is first talked about ("the offline release" → v4.2.0).
      const [from, to] = o._;
      if (!from || !to) usage("rename needs the current name and the new one");
      if (!VERSION_RE.test(to)) usage(`"${to}" is not a version name`);
      const v = readVersion(dataDir, from);
      if (!v) { process.stderr.write(`shipyard-data version: no version "${from}"\n`); process.exit(3); }
      if (existsSync(versionPath(dataDir, to))) { process.stderr.write(`shipyard-data version: ${to} already exists\n`); process.exit(3); }
      const moved = items(dataDir).filter((i) => i.own === from);
      mkdirSync(join(dataDir, ".locks"), { recursive: true });
      withLockfile(join(dataDir, ".locks", "fix-version.lock"), () => {
        atomicWrite(versionPath(dataDir, to), `${v.fm.open}${setScalar(v.fm.block, "name", JSON.stringify(to))}${v.fm.close}${v.fm.rest.replace(new RegExp(`^# ${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"), `# ${to}`)}`);
        for (const it of moved) { const fm = parseFm(readFileSync(it.path, "utf8")); atomicWrite(it.path, `${fm.open}${setScalar(fm.block, "fix_version", JSON.stringify(to))}${fm.close}${fm.rest}`); }
        rmSync(versionPath(dataDir, from));
      }, { ttlMs: 10000, retryMs: 50, maxRetries: 200 });
      try { logEvent(dataDir, "version_renamed", { from, to, items: moved.length }); } catch { /* best-effort */ }
      process.stdout.write(`version ${from} is now ${to}; ${moved.length} item(s) follow it\n`);
      return;
    }
    if (sub === "check") {
      const [name, which] = o._;
      if (!name || !which || !String(o.answer ?? "").trim()) usage('check needs a version, a check number and --answer "<the person\'s words>"');
      const v = readVersion(dataDir, name);
      if (!v) { process.stderr.write(`shipyard-data version: no version "${name}"\n`); process.exit(3); }
      const c = v.checks.find((x) => String(x.n) === String(which));
      if (!c) { process.stderr.write(`shipyard-data version: ${name} has checks 1 to ${v.checks.length}\n`); process.exit(3); }
      let n = 0;
      const rest = v.fm.rest.replace(/^- \[( |x|X)\] (.+)$/gm, (line, _m, text) => (++n === c.n ? `- [x] ${text.replace(/\s+— confirmed .*$/, "")} — confirmed ${today()}: ${String(o.answer).replace(/\s+/g, " ").trim().slice(0, 200)}` : line));
      atomicWrite(versionPath(dataDir, name), `${v.fm.open}${v.fm.block}${v.fm.close}${rest}`);
      try { logEvent(dataDir, "version_check_confirmed", { version: name, check: c.n }); } catch { /* best-effort */ }
      process.stdout.write(`${name}: check ${c.n} confirmed\n`);
      return;
    }
    if (sub === "release") {
      const name = o._[0];
      if (!name) usage("release needs a version name");
      const w = versionView(dataDir, name);
      if (!w) { process.stderr.write(`shipyard-data version: no version "${name}"\n`); process.exit(3); }
      if (w.version.status === "released") { process.stdout.write(`${name} is already released (${w.version.released_at})\n`); return; }
      const why = [];
      if (w.open.length) why.push(`${w.open.length} item(s) are not finished (${w.open.map((r) => `${r.id} ${r.status}`).join(", ")}): finish them, or move them openly to the next version (shipyard-data version set <next> <id> --reason "...")`);
      if (w.not_refined.length) why.push(`${w.not_refined.length} item(s) were never broken down (${w.not_refined.map((r) => r.id).join(", ")}): move them to the next version or take them out`);
      const openChecks = w.version.checks.filter((c) => !c.done);
      if (openChecks.length) why.push(`${openChecks.length} release check(s) are open (${openChecks.map((c) => `${c.n}. ${c.text}`).join("; ")}): shipyard-data version check ${name} <n> --answer "..."`);
      if (why.length) { process.stderr.write(`shipyard-data version: ${name} cannot be released yet:\n  - ${why.join("\n  - ")}\n`); process.exit(3); }
      const v = readVersion(dataDir, name);
      atomicWrite(versionPath(dataDir, name), `${v.fm.open}${setScalar(setScalar(v.fm.block, "status", "released"), "released_at", JSON.stringify(today()))}${v.fm.close}${v.fm.rest}`);
      try { logEvent(dataDir, "version_released", { version: name, items: w.done.length, points: w.points.done }); } catch { /* best-effort */ }
      process.stdout.write(`${name} released: ${w.done.length} item(s), ${w.points.done} points\n${w.done.map((r) => `  ${r.id}  ${r.title}`).join("\n")}\n`);
      return;
    }
    usage(`unknown subcommand "${sub ?? ""}"`);
  } catch (e) {
    if (typeof e?.exitCode === "number") { process.stderr.write(`shipyard-data version: ${e.message}\n`); process.exit(e.exitCode); }
    throw e;
  }
}
