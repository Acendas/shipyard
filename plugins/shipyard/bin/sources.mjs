/**
 * shipyard-data sources: where this project's knowledge lives, besides the code.
 *
 * The owner's rule (after 4.0.3): "shipyard is forcing jira, confluence google drive search … [one project] has
 * none of that, and another consumer may have totally different sources. some issues/features may require
 * additional supporting data sources … but sometimes its not necessary at all."
 *
 * What went wrong before: the list of sources was fixed (wiki, tracker, shared drive: one organisation's
 * shape), and "connected" was read from the tools the person's Claude install happens to have, guessed by
 * name. A browser tool counted as a wiki and a document tool as a shared drive, so a bug whose cause was in
 * the code could not be approved until three unrelated places had been searched, and the owner's own "this
 * project has no other sources" was refused.
 *
 * Now the sources are the project's, named by its owner, once:
 *
 *   sources list [--json]                 what is named, or that it was never asked
 *   sources suggest                       the one-time question, with what the ticket links suggest
 *   sources add "<name>" --holds "<what it holds>" [--tool <word in its tools' names> | --path <folder> | --url <address>]
 *                        [--always] --answer "<the owner's words>"
 *   sources remove "<name>" --answer "…"
 *   sources always "<name>" on|off --answer "…"
 *   sources none --answer "…"             the repository is everything
 *
 * A source: a name, one line on what it holds (this is how a discussion judges whether it could matter for a
 * piece of work), how it is reached, and whether it is looked at every time (`always`) or only when it could
 * matter. Every write carries the owner's answer, because naming a source and dropping one are both theirs to
 * decide. `<data>/sources.json` has this one writer. A tool the install has but the project did not name is
 * not a source of this project.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, logEvent, withLockfile } from "./_hook_lib.mjs";

export const SOURCES_BASENAME = "sources.json";
const one = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const key = (v) => one(v).toLowerCase();
const shape = (s) => ({ name: one(s.name).slice(0, 60), holds: one(s.holds).slice(0, 200), tool: key(s.tool).slice(0, 60), path: one(s.path).slice(0, 300), url: one(s.url).slice(0, 300), always: s.always === true });

/** { decided, decided_at, sources: [{name, holds, tool, path, url, always}] }. `decided: false` = the owner was never asked. */
export function readSources(dataDir) {
  try {
    const o = JSON.parse(readFileSync(join(dataDir, SOURCES_BASENAME), "utf8"));
    if (!o || typeof o !== "object" || !Array.isArray(o.sources)) return { decided: false, decided_at: "", sources: [] };
    return { decided: true, decided_at: String(o.decided_at ?? ""), sources: o.sources.filter((s) => s && one(s.name)).map(shape) };
  } catch { return { decided: false, decided_at: "", sources: [] }; }
}
/** Does a tool call belong to this source? By a word in the tool's full name (its server or the tool itself). */
export const toolBelongs = (source, fullName) => Boolean(source?.tool) && String(fullName ?? "").toLowerCase().includes(source.tool);
export const findSource = (sources, name) => sources.find((s) => key(s.name) === key(name)) ?? null;
/** How a source is reached, in words. */
export const reachOf = (s) => (s.tool ? `tools named like "${s.tool}"` : s.path ? `the folder ${s.path}` : s.url ? s.url : "the owner tells what it says");

/** One line for the start of a discussion. */
export function contextLine(dataDir) {
  const r = readSources(dataDir);
  if (!r.decided) return "not set (asked once, when a piece of work is first approved: `shipyard-data sources suggest`)";
  if (!r.sources.length) return "none besides the repository (the owner's answer); nothing else is searched";
  return r.sources.map((s) => `${s.name}${s.always ? " [always looked at]" : ""}: ${s.holds || "no description"} (${reachOf(s)})`).join("; ");
}

function write(dataDir, fn) {
  mkdirSync(join(dataDir, ".locks"), { recursive: true });
  let out = null;
  withLockfile(join(dataDir, ".locks", "sources.lock"), () => {
    const cur = readSources(dataDir);
    out = fn(cur.sources.map((s) => ({ ...s })), cur);
    if (out?.error) return;
    atomicWrite(join(dataDir, SOURCES_BASENAME), JSON.stringify({ decided_at: cur.decided && cur.decided_at ? cur.decided_at : new Date().toISOString(), updated_at: new Date().toISOString(), sources: out.sources.map(shape) }, null, 2) + "\n");
  });
  return out;
}

/** What the project's own records suggest: the trackers its tickets came from. [{name, tool, holds, why}] */
async function suggestions(dataDir) {
  const out = [];
  try {
    const { status } = await import("./tracker.mjs");
    const by = new Map();
    for (const r of status(dataDir)) {
      const src = key(r.source) || "tracker";
      const k = by.get(src) ?? { n: 0, prefixes: new Set() };
      k.n += 1;
      const m = String(r.key || r.ticket || "").match(/^([A-Za-z][A-Za-z0-9_]*)-\d+$/);
      if (m) k.prefixes.add(m[1]);
      by.set(src, k);
    }
    for (const [src, k] of by) {
      const p = [...k.prefixes].slice(0, 4).join(", ");
      out.push({ name: src === "tracker" ? "Tracker" : src[0].toUpperCase() + src.slice(1), tool: src === "tracker" ? "" : src, holds: `the tickets this project's work comes from${p ? ` (${p})` : ""}`, why: `${k.n} record${k.n === 1 ? "" : "s"} here ${k.n === 1 ? "is" : "are"} linked to its tickets` });
    }
  } catch { /* no tracker module or no records: nothing suggested */ }
  return out;
}
/** The connector servers the latest discussion's session had tools for (from the `sources_available` event). */
function sessionServers(dataDir) {
  let last = "";
  try {
    for (const line of readFileSync(join(dataDir, ".shipyard-events.jsonl"), "utf8").split("\n")) {
      if (!line.includes('"sources_available"')) continue;
      try { const e = JSON.parse(line); if (e.type === "sources_available" && typeof e.servers === "string") last = e.servers; } catch { /* a cut line */ }
    }
  } catch { /* no log */ }
  return last.split(",").map((x) => x.trim()).filter(Boolean);
}

function parse(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json" || a === "--always") { o[a.slice(2)] = true; continue; }
    if (a === "--help" || a === "-h") { o.help = true; continue; }
    if (a.startsWith("--")) { const v = args[++i]; if (v === undefined) usage(`${a} needs a value`); o[a.slice(2)] = v; } else o._.push(a);
  }
  return o;
}
function usage(msg) {
  process.stderr.write(
    (msg ? `shipyard-data sources: ${msg}\n` : "") +
      "  Usage: sources list [--json] | sources suggest\n" +
      "         sources add \"<name>\" --holds \"<what it holds, one line>\" [--tool <a word in its tools' names> | --path <folder> | --url <address>] [--always] --answer \"<the owner's words>\"\n" +
      "         sources remove \"<name>\" --answer \"...\" | sources always \"<name>\" on|off --answer \"...\" | sources none --answer \"...\"\n" +
      "  Where this project's knowledge lives, besides the code. Named by the owner; a discussion looks there when it could matter.\n",
  );
  process.exit(msg ? 2 : 0);
}
const refuse = (msg) => { process.stderr.write(`shipyard-data sources: ${msg}\n`); process.exit(3); };
const table = (list) => ["| Source | What it holds | How it is reached | Looked at |", "|---|---|---|---|", ...list.map((s) => `| ${s.name} | ${s.holds || "-"} | ${reachOf(s)} | ${s.always ? "every time" : "when it could matter"} |`)];

export async function main(dataDir, args = []) {
  const o = parse(args);
  const sub = o._[0];
  if (o.help || !sub) usage(o.help ? "" : "needs a verb");
  if (!dataDir) refuse("no Shipyard data folder for this project");
  const answer = one(o.answer);
  const needAnswer = () => { if (answer.length < 2) refuse(`${sub} records the owner's decision: add --answer "<their words>". Where a project's knowledge lives is theirs to say; ask them (\`shipyard-data sources suggest\` prints the question)`); };

  if (sub === "list") {
    const r = readSources(dataDir);
    if (o.json) { process.stdout.write(JSON.stringify(r) + "\n"); return; }
    if (!r.decided) { process.stdout.write("SOURCES: not set. The owner has not been asked where this project's knowledge lives, besides the code.\n  It is asked once: shipyard-data sources suggest\n"); return; }
    if (!r.sources.length) { process.stdout.write("SOURCES: none besides the repository (the owner's answer). Nothing else is searched.\n  To name one later: shipyard-data sources add \"<name>\" --holds \"...\" --tool <word> --answer \"<their words>\"\n"); return; }
    process.stdout.write(["SOURCES (where this project's knowledge lives, besides the code)", ...table(r.sources), ""].join("\n"));
    return;
  }

  if (sub === "suggest") {
    const cur = readSources(dataDir);
    const sug = (await suggestions(dataDir)).filter((s) => !findSource(cur.sources, s.name));
    const servers = sessionServers(dataDir);
    const lines = [
      cur.decided ? "This project's sources were set before; this asks again." : "This project has not said where its knowledge lives, besides the code. It is asked once.",
      "",
      'SHOW (write this in the chat as it is, under a summary of 40 words or fewer; then the line "Question follows." ends your turn):',
      "| Suggested | What it would hold | Why |", "|---|---|---|",
      ...(sug.length ? sug.map((s) => `| ${s.name} | ${s.holds} | ${s.why} |`) : ["| nothing | - | no record in this project is linked to a ticket, so the code and its documents look like everything |"]),
      ...(servers.length ? ["", `Other places this session could reach, if they belong to this project: ${servers.slice(0, 12).join(", ")}`] : []),
      "",
      "QUESTION (the card, word for word): Where does this project's knowledge live, besides the code?",
      sug.length
        ? `CHOICES: 1. ${sug.map((s) => s.name).join(" and ").slice(0, 26)} (Recommended) — What this project's tickets point to   2. Only the repository — Nothing else is ever searched   3. I will name them — Say each place and what it holds`
        : "CHOICES: 1. Only the repository (Recommended) — Nothing else is ever searched   2. I will name them — Say each place and what it holds",
      "",
      "Then record their answer, in their words:",
      '  only the repository:   shipyard-data sources none --answer "<their words>"',
      ...sug.map((s) => `  ${s.name}, as suggested:   shipyard-data sources add "${s.name}" --holds "${s.holds}"${s.tool ? ` --tool ${s.tool}` : ""} --answer "<their words>"`),
      '  a place they name:     shipyard-data sources add "<name>" --holds "<what it holds, one line>" --tool <a word in its tools\' names> --answer "<their words>"',
      "                         (--path <folder> or --url <address> for a place with no connector; --always only when they say it must be looked at every time)",
      "Never add a place they did not name. Never ask them to sign in or connect anything for this.",
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  if (sub === "none") {
    needAnswer();
    const r = write(dataDir, () => ({ sources: [] }));
    logEvent(dataDir, "project_sources_set", { action: "none", answer: answer.slice(0, 300) });
    process.stdout.write(`recorded: this project's knowledge is in its repository. Nothing else is searched, and no discussion owes a record of where it looked.${r ? "" : ""}\n`);
    return;
  }

  const name = one(o._[1]);
  if (!["add", "remove", "always"].includes(sub)) usage(`unknown verb "${sub}"`);
  if (!name) usage(`${sub} needs the source's name`);
  needAnswer();

  if (sub === "add") {
    const holds = one(o.holds);
    if (holds.length < 4) refuse('add needs --holds "<what this place holds, one line>": it is how a discussion judges whether the place could matter for a piece of work');
    const reach = [o.tool, o.path, o.url].filter((v) => one(v));
    if (reach.length > 1) refuse("a source is reached one way: --tool, --path or --url");
    if (o.tool !== undefined && key(o.tool).length < 3) refuse("--tool is a word in the names of the tools that read this place (for example a connector's name), three letters or more");
    const r = write(dataDir, (list) => {
      const next = { name, holds, tool: o.tool ?? "", path: o.path ?? "", url: o.url ?? "", always: o.always === true };
      const i = list.findIndex((s) => key(s.name) === key(name));
      if (i === -1) list.push(next); else list[i] = next;
      return { sources: list, replaced: i !== -1 };
    });
    logEvent(dataDir, "project_sources_set", { action: r.replaced ? "replace" : "add", name, always: o.always === true ? "yes" : "no", answer: answer.slice(0, 300) });
    process.stdout.write(`${r.replaced ? "replaced" : "added"} ${name}: ${holds} (${reachOf(shape({ tool: o.tool, path: o.path, url: o.url }))}; looked at ${o.always === true ? "every time" : "when it could matter"})\n`);
    return;
  }
  if (sub === "remove") {
    const r = write(dataDir, (list) => (findSource(list, name) ? { sources: list.filter((s) => key(s.name) !== key(name)) } : { error: "none" }));
    if (r.error) refuse(`no source named "${name}" (shipyard-data sources list)`);
    logEvent(dataDir, "project_sources_set", { action: "remove", name, answer: answer.slice(0, 300) });
    process.stdout.write(`removed ${name}; ${r.sources.length ? `${r.sources.length} source(s) left` : "this project's knowledge is in its repository"}\n`);
    return;
  }
  const on = key(o._[2]);
  if (!["on", "off"].includes(on)) usage('always takes on or off: sources always "<name>" on --answer "..."');
  const r = write(dataDir, (list) => { const s = findSource(list, name); if (!s) return { error: "none" }; s.always = on === "on"; return { sources: list }; });
  if (r.error) refuse(`no source named "${name}" (shipyard-data sources list)`);
  logEvent(dataDir, "project_sources_set", { action: `always_${on}`, name, answer: answer.slice(0, 300) });
  process.stdout.write(`${name} is looked at ${on === "on" ? "in every discussion" : "when it could matter"}\n`);
}
