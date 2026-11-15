/**
 * `shipyard-data sprint probes-at-base [--draft|--next] [--only P001,P002] [--timeout <s>] [--json]` (v4.21)
 *
 * A step's acceptance probe proves the step only if it FAILS on the code as
 * it is today. The rule was one line in a planning checklist ("fails today
 * against the unimplemented state"); in a real sprint four of five probes
 * passed before any work was done, so "the probe passes" proved nothing. A
 * project filed that as an idea for itself; it belongs here, for every project.
 *
 * This runs each feature step's probe once on the working tree, in the
 * project's folder, and records what happened in
 * `<plan folder>/.probes-at-base.json`:
 *   { head, steps: { P001: { hash, exit, timed_out, ms, at } } }
 * A probe that exits 0 is a problem unless the step says why that is right
 * (`probe_passes_at_base: "<reason>"` — a pure refactor guarded by an existing
 * test, a document check that already holds).
 *
 * The plan gate (bin/plan-score.mjs) then refuses a sprint whose step has a
 * probe with no record, a changed probe, or an unexplained pass.
 * `execution.probe_must_fail_first: false` turns it off.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { parseFrontmatter, parseWaves } from "./terminal-gate.mjs";
import { getProjectRoot } from "./shipyard-resolver.mjs";
import { planFile, registerProbeProblems } from "./plan-score.mjs";

export const RECORD_BASENAME = ".probes-at-base.json";
const readIf = (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } };
export const probeHash = (cmd) => createHash("sha256").update(String(cmd).trim()).digest("hex").slice(0, 16);

/** A step's `acceptance_probe` from its frontmatter: a block scalar (`|`), or one quoted or bare line. One linear pass. */
export function readStepProbe(text) {
  const m = String(text ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^acceptance_probe:/.test(l));
  if (at === -1) return null;
  const rest = lines[at].slice("acceptance_probe:".length).trim();
  if (/^[|>][+-]?$/.test(rest)) {
    const body = [];
    for (let i = at + 1; i < lines.length; i++) {
      if (lines[i].trim() === "") { body.push(""); continue; }
      if (!/^\s/.test(lines[i])) break;
      body.push(lines[i]);
    }
    const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
    const cmd = body.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n").trim();
    return cmd || null;
  }
  const q = rest[0];
  if ((q === "'" || q === '"') && rest.endsWith(q) && rest.length >= 2) return (q === "'" ? rest.slice(1, -1).replace(/''/g, "'") : rest.slice(1, -1).replace(/\\"/g, '"')).trim() || null;
  return rest.replace(/\s+#.*$/, "").trim() || null;
}

/** The feature steps of the plan that carry a probe. */
export function planProbes(dataDir, opts = {}) {
  const path = planFile(dataDir, opts);
  const text = readIf(path);
  if (!text) return { path, steps: [] };
  const ids = new Set(parseWaves(text).flatMap((w) => w.tasks));
  const steps = [];
  for (const sub of ["steps", "tasks"]) {
    let names = [];
    try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
    for (const n of names) {
      const id = (n.match(/^([A-Z]+-?[A-Z0-9]*\d+)(?=-|\.md$)/) || [])[1];
      if (!id || !ids.has(id) || steps.some((s) => s.id === id) || !n.endsWith(".md")) continue;
      const body = readIf(join(dataDir, "spec", sub, n));
      if (!body) continue;
      const fm = parseFrontmatter(body);
      if (String(fm.kind || "feature").trim() !== "feature") continue;
      const probe = readStepProbe(body);
      if (!probe) continue;
      steps.push({ id, probe, hash: probeHash(probe), allowed_pass: String(fm.probe_passes_at_base ?? "").replace(/^["']|["']$/g, "").trim() });
    }
  }
  return { path, steps: steps.sort((a, b) => a.id.localeCompare(b.id)) };
}
export function readRecord(dataDir, opts = {}) {
  try { const r = JSON.parse(readFileSync(join(dirname(planFile(dataDir, opts)), RECORD_BASENAME), "utf8")); return r && r.steps ? r : { steps: {} }; } catch { return { steps: {} }; }
}

/** Problems for the plan gate: a probe never run on today's code, changed since, or passing with no reason. */
export function probeProblems(dataDir, opts = {}) {
  const { steps } = planProbes(dataDir, opts);
  if (!steps.length) return [];
  const rec = readRecord(dataDir, opts).steps;
  const notRun = [], out = [];
  for (const s of steps) {
    const r = rec[s.id];
    if (!r || r.hash !== s.hash) { notRun.push(s.id); continue; }
    if (r.exit === 0 && !r.timed_out && !s.allowed_pass) out.push(`probe: ${s.id}'s probe already passes on the code as it is today, so passing it later proves nothing: rewrite it to check what the step adds (it must fail now), or say why a pass is right with \`probe_passes_at_base: "<reason>"\` in the step`);
  }
  if (notRun.length) out.unshift(`probe: ${notRun.join(", ")} ${notRun.length === 1 ? "has a probe that has" : "have probes that have"} not been run on the code as it is today: \`shipyard-data sprint probes-at-base${opts.next ? " --next" : ""}\``);
  return out;
}

registerProbeProblems(probeProblems);

export function main(dataDir, args = []) {
  const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };
  const known = new Set(["--draft", "--next", "--json", "--only", "--timeout"]);
  const bad = args.find((a, i) => a.startsWith("--") ? !known.has(a) : !["--only", "--timeout"].includes(args[i - 1]));
  if (bad) { process.stderr.write(`shipyard-data sprint probes-at-base: unknown argument "${bad}"\n  Usage: sprint probes-at-base [--draft|--next] [--only P001,P002] [--timeout <s>] [--json]\n`); process.exit(2); }
  const opts = { next: args.includes("--next"), draft: args.includes("--draft") };
  const timeout = Math.max(5, Math.min(900, Number(flag("--timeout") ?? 120) || 120));
  const only = flag("--only") ? new Set(String(flag("--only")).split(",").map((s) => s.trim())) : null;
  const { path, steps } = planProbes(dataDir, opts);
  if (!existsSync(path)) { process.stderr.write(`shipyard-data sprint probes-at-base: no sprint plan at ${path}\n`); process.exit(3); }
  const recPath = join(dirname(path), RECORD_BASENAME);
  const record = readRecord(dataDir, opts);
  let cwd = process.cwd();
  try { cwd = getProjectRoot() || cwd; } catch { /* keep cwd */ }
  let head = "";
  try { head = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout ?? "").trim(); } catch { head = ""; }
  const rows = [];
  for (const s of steps) {
    const prev = record.steps[s.id];
    if (only ? !only.has(s.id) : prev && prev.hash === s.hash && prev.head === head) { rows.push({ ...s, ...(prev ?? {}), reused: Boolean(prev) }); continue; }
    const t0 = Date.now();
    const r = spawnSync(s.probe, { cwd, shell: true, encoding: "utf8", timeout: timeout * 1000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
    const timedOut = r.error?.code === "ETIMEDOUT" || r.signal === "SIGTERM";
    const entry = { hash: s.hash, exit: timedOut ? null : (r.status ?? 1), timed_out: timedOut, ms: Date.now() - t0, head, at: new Date().toISOString() };
    record.steps[s.id] = entry;
    atomicWrite(recPath, JSON.stringify({ head, steps: record.steps }, null, 2) + "\n"); // after each probe: a long run that is cut off keeps what it learned
    rows.push({ ...s, ...entry, reused: false });
    if (!args.includes("--json")) process.stderr.write(`  ${s.id}: ${timedOut ? `timed out after ${timeout}s` : entry.exit === 0 ? "PASSES already" : `fails (exit ${entry.exit})`} · ${Math.round(entry.ms / 1000)}s\n`);
  }
  const passing = rows.filter((x) => x.exit === 0 && !x.timed_out);
  const unexplained = passing.filter((x) => !x.allowed_pass);
  try { logEvent(dataDir, "probes_at_base_checked", { steps: rows.length, fail_first: rows.length - passing.length, pass_already: passing.length, unexplained: unexplained.length }); } catch { /* best-effort */ }
  if (args.includes("--json")) process.stdout.write(JSON.stringify({ plan: path, head, steps: rows.map(({ probe: _p, ...x }) => x), unexplained: unexplained.map((x) => x.id) }) + "\n");
  else {
    process.stdout.write(`probes on today's code: ${rows.length - passing.length} of ${rows.length} fail first${passing.length ? `, ${passing.length} already pass` : ""}${rows.some((x) => x.reused) ? " (unchanged ones were not run again)" : ""}\n`);
    for (const x of unexplained) process.stdout.write(`  ✗ ${x.id} already passes: it would prove nothing. Rewrite it to check what the step adds, or set probe_passes_at_base: "<reason>".\n`);
    for (const x of passing.filter((p) => p.allowed_pass)) process.stdout.write(`  • ${x.id} passes by intent: ${x.allowed_pass}\n`);
  }
  if (unexplained.length) process.exit(3);
}
