/**
 * `shipyard-data story probe-command <ID> [--json]` (v4.14) — what to run for
 * a story's automatic user-flow probe.
 *
 * A probe proves the story's own behaviour. Stories kept ending theirs with
 * the project's full test command (`… && make -k -j8 test`), so the sprint-end
 * probe stage ran the whole suite once per story: seven stories, seven
 * five-minute runs, on a tree whose suite had been proven minutes earlier.
 *
 * When the probe ENDS with a configured test command (`test_commands.<tier>`)
 * joined by `&&`, and the ledger holds a fresh proof of that exact command
 * for this tree, the trailing part is left out of what is run. `A && B` with
 * B already proven exit 0 on the same tree is A. Only the trailing part is
 * ever dropped (a later part could depend on what the suite builds), and
 * never the whole probe.
 *   run        what to execute
 *   record_as  the probe's own command, for `verify record --key demo_probe.<ID>`
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readBlockScalar } from "./config-read.mjs";
import { evaluateFreshness } from "./verify-ledger.mjs";

const TIERS = ["unit", "integration", "e2e"];
const unquote = (s) => s.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");

/** Lines indented deeper than `indent`, dedented by their own least indent. */
function blockAfter(lines, from, indent) {
  const out = [];
  for (let i = from; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === "") { out.push(""); continue; }
    if (l.length - l.trimStart().length <= indent) break;
    out.push(l);
  }
  const least = Math.min(...out.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return out.map((l) => (l.trim() ? l.slice(Number.isFinite(least) ? least : 0) : "")).join("\n").trim();
}

/** `{ kind, command }` from a story file's frontmatter, or null when it has no command to run. */
export function readProbeCommand(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text ?? ""));
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^(user_flow_probe|demo_probe):/.test(l));
  if (at === -1) return null;
  const inline = lines[at].replace(/^[a-z_]+:\s*/, "").trim();
  if (inline === "skip-with-reason") return null;
  if (/^[|>][+-]?$/.test(inline)) { const c = blockAfter(lines, at + 1, 0); return c ? { kind: "auto", command: c } : null; }
  if (inline) return { kind: "auto", command: unquote(inline) };
  let kind = "", command = "";
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() && !/^\s/.test(l)) break;
    const k = /^(\s+)kind:\s*(\S+)/.exec(l); if (k) kind = k[2];
    const c = /^(\s+)command:\s*(.*)$/.exec(l);
    if (c) command = /^[|>][+-]?$/.test(c[2].trim()) ? blockAfter(lines, i + 1, c[1].length) : unquote(c[2].trim());
  }
  return command ? { kind: kind || "auto", command } : null;
}

/** Decide what to run. Pure given the config and the ledger. */
export function probeRun(dataDir, command) {
  let run = String(command).trim();
  const reused = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const tier of TIERS) {
      const c = String(readBlockScalar(dataDir, "test_commands", tier) ?? "").trim();
      if (!c || !run.endsWith(c)) continue;
      const head = run.slice(0, -c.length).trimEnd();
      if (!head.endsWith("&&")) continue;
      const rest = head.slice(0, -2).trimEnd();
      if (!rest) continue; // never the whole probe
      const r = evaluateFreshness(dataDir, { key: `test_commands.${tier}`, command: c });
      if (!r.fresh) continue;
      reused.push({ tier, key: `test_commands.${tier}`, command: c, recorded_at: String(r.entry.recordedAt ?? "") });
      run = rest; changed = true;
    }
  }
  return { run, reused };
}

/** The trailing configured test command of a probe, proof or no proof (for the authoring note). */
export function trailingSuite(dataDir, command) {
  const run = String(command ?? "").trim();
  for (const tier of TIERS) {
    const c = String(readBlockScalar(dataDir, "test_commands", tier) ?? "").trim();
    if (c && run.endsWith(c) && run.slice(0, -c.length).trimEnd().endsWith("&&")) return { tier, command: c };
  }
  return null;
}

function storyFile(dataDir, id) {
  for (const sub of ["stories", "features", "bugs"]) {
    let names = [];
    try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
    const n = names.find((x) => x === `${id}.md` || x.startsWith(`${id}-`));
    if (n) return join(dataDir, "spec", sub, n);
  }
  return null;
}

export function main(dataDir, args = []) {
  const json = args.includes("--json");
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) { process.stderr.write("usage: story probe-command <ID> [--json]\n"); process.exit(2); }
  const f = storyFile(dataDir, id);
  if (!f) { process.stderr.write(`story probe-command: no story file for ${id}\n`); process.exit(3); }
  const probe = readProbeCommand(readFileSync(f, "utf8"));
  if (!probe) { process.stderr.write(`story probe-command: ${id} has no probe command to run (manual steps or skip-with-reason)\n`); process.exit(3); }
  const { run, reused } = probeRun(dataDir, probe.command);
  const note = reused.length
    ? `left out: ${reused.map((r) => `\`${r.command}\` (proven for this tree, ${r.key}, recorded ${r.recorded_at})`).join("; ")}`
    : "";
  if (json) { process.stdout.write(JSON.stringify({ id, kind: probe.kind, run, record_as: probe.command, suite_reused: reused, note }) + "\n"); return; }
  process.stdout.write(run + "\n");
  if (note) process.stderr.write(`story probe-command: ${note}\n`);
}
