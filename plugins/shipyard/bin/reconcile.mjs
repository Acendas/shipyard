/**
 * `shipyard-data reconcile [--fix] [--json]` (v4.6) — state that drifted when
 * a cycle ended.
 *
 * Why: state files were left stale after /ship-execute or /ship-review ended
 * (a story still `in-progress` with no sprint holding it, epics still
 * `proposed` after their stories shipped, a cursor left in `sprints/current/`
 * with no sprint, backlog rows for finished work), and the NEXT sprint then
 * ran into errors. Each of these is derivable, so the CLI derives it: the
 * check is read-only; `--fix` applies the repairs through the same typed
 * verbs a skill would use (never hand edits) and logs `state_reconciled`.
 *
 * Runs at the end of `archive-sprint`, at `/ship-sprint` Step 0 and from
 * `/ship-status`; `doctor` lists what it finds as `state-drift`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { logEvent } from "./_hook_lib.mjs";
import { parseFrontmatter, sprintStoryIds } from "./terminal-gate.mjs";
import { parseFrontmatterList } from "./frontmatter-list.mjs";
import { listShipyardBranches, listShipyardWorktrees, ownerOf, repoFor, sprintInFlight } from "./branches.mjs";
import { readSweepBranches } from "./config-read.mjs";
import { landable } from "./quick.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "shipyard-data.mjs");
const FINISHED = new Set(["done", "deployed", "released"]);
const CLOSED = new Set(["done", "deployed", "released", "rejected", "deferred"]);

function readIf(p) { try { return readFileSync(p, "utf8"); } catch { return null; } }
function records(dataDir, dirs) {
  const out = [];
  for (const sub of dirs) {
    const dir = join(dataDir, "spec", sub);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".md")) continue;
      const text = readIf(join(dir, n));
      if (!text) continue;
      const fm = parseFrontmatter(text);
      const id = String(fm.id ?? "").replace(/^"|"$/g, "").trim();
      if (id) out.push({ id, fm, text, path: join(dir, n), dir: sub });
    }
  }
  return out;
}
function lockFree(dataDir, basename) {
  const text = readIf(join(dataDir, basename));
  if (!text) return true;
  try { const o = JSON.parse(text); return !o || o.cleared || o.skill == null; } catch { return true; }
}

/** Derive drift. Pure: reads files only. */
export function findDrift(dataDir) {
  const findings = [];
  const currentDir = join(dataDir, "sprints", "current");
  const sprintText = readIf(join(currentDir, "SPRINT.md"));
  const inSprint = new Set(sprintText ? sprintStoryIds(sprintText) : []);
  const stories = records(dataDir, ["stories", "features", "bugs"]);
  const byId = new Map(stories.map((s) => [s.id, s]));

  // 1. a story still in-progress that no sprint holds
  for (const s of stories) {
    if (String(s.fm.status ?? "").trim() !== "in-progress" || inSprint.has(s.id)) continue;
    findings.push({ kind: "orphan-in-progress", id: s.id, detail: `${s.id} is in-progress but no current sprint holds it`, fix: [["story", "set-status", s.id, "approved", "--force"], ["backlog", "add", s.id]], hint: "carried back to the backlog as approved, ready to pull into the next sprint" });
  }

  // 2. epic status behind its stories
  for (const e of records(dataDir, ["epics"])) {
    const mine = stories.filter((s) => String(s.fm.epic ?? "").replace(/^"|"$/g, "").trim() === e.id && !["rejected", "deferred"].includes(String(s.fm.status ?? "").trim()));
    if (!mine.length) continue;
    const st = String(e.fm.status ?? "").trim();
    const allDone = mine.every((s) => FINISHED.has(String(s.fm.status ?? "").trim()));
    const anyStarted = mine.some((s) => ["in-progress", ...FINISHED].includes(String(s.fm.status ?? "").trim()));
    const want = allDone ? "done" : anyStarted ? "in-progress" : null;
    // 4.0.1: a `done` epic with a story still to build is not done. New stories
    // were added to five finished epics on a real project and each still read "done".
    if (want && st !== want) {
      findings.push({ kind: "epic-status-behind", id: e.id, detail: `${e.id} is "${st || "unset"}" but its stories say "${want}" (${mine.filter((s) => FINISHED.has(String(s.fm.status ?? "").trim())).length}/${mine.length} finished)`, fix: [["epic", "set-status", e.id, want, "--force"]], hint: `epic status follows its stories` });
    }
  }

  // 3. a cursor left behind with no sprint and nobody running it
  for (const [base, lock] of [["EXECUTE-CURSOR.md", ".active-execution.json"], ["REVIEW-CURSOR.md", ".active-execution.json"]]) {
    const p = join(currentDir, base);
    const text = readIf(p);
    if (!text || sprintText) continue;
    const fm = parseFrontmatter(text);
    if (String(fm.terminal ?? "").trim() === "true") continue;
    if (!lockFree(dataDir, lock)) continue;
    findings.push({ kind: "stale-cursor", id: base, detail: `${base} (stage ${String(fm.stage ?? "?")}) sits in sprints/current/ with no sprint and no running session`, move: p, hint: "moved aside so the next sprint starts clean" });
  }

  // 4. backlog rows for finished or missing work
  const backlog = readIf(join(dataDir, "backlog", "BACKLOG.md"));
  if (backlog) {
    const ids = [...backlog.matchAll(/^\|\s*\d+\s*\|\s*([A-Z][A-Za-z0-9-]*)\s*\|/gm)].map((m) => m[1]);
    for (const id of ids) {
      const s = byId.get(id);
      if (!s) findings.push({ kind: "backlog-missing-story", id, detail: `BACKLOG.md lists ${id} but no such story file exists`, fix: [["backlog", "remove", id]], hint: "row removed" });
      else if (CLOSED.has(String(s.fm.status ?? "").trim())) findings.push({ kind: "backlog-closed-story", id, detail: `BACKLOG.md lists ${id}, which is ${String(s.fm.status).trim()}`, fix: [["backlog", "remove", id]], hint: "row removed" });
    }
  }

  // 5. a completed sprint still in current/ (report only: archiving is the review's step)
  if (sprintText && String(parseFrontmatter(sprintText).status ?? "").trim() === "completed") {
    const rc = readIf(join(currentDir, "REVIEW-CURSOR.md"));
    if (rc && /^stage:\s*terminal\b/m.test(rc)) findings.push({ kind: "reviewed-sprint-not-archived", id: String(parseFrontmatter(sprintText).id ?? ""), detail: "the sprint in sprints/current/ is completed and reviewed but not archived", hint: `run: shipyard-data archive-sprint ${String(parseFrontmatter(sprintText).id ?? "<id>")}` });
  }
  // 6. Shipyard branches left behind by finished sprints (4.9). Only when no
  // sprint is running: a live sprint's builder branches and anchors are in use.
  try {
    // Only between sprints (nothing in sprints/current/): a sprint that is
    // planned, running, or finished but not yet reviewed still owns its
    // branches, and `archive-sprint` sweeps them when the review ends. Seen
    // live: doctor called a just-finished sprint's 26 anchors "leftover" at
    // the start of its own review.
    if (readSweepBranches(dataDir) && !sprintInFlight(dataDir) && !sprintText) {
      const wts = listShipyardWorktrees(repoFor(dataDir), ownerOf(dataDir));
      const clean = wts.filter((w) => !w.dirty), dirty = wts.filter((w) => w.dirty);
      if (clean.length) findings.push({ kind: "stale-worktrees", id: `${clean.length}`, detail: `${clean.length} finished builder worktree(s) are still on disk with no sprint running`, fix: [["branches", "sweep", "--label", `reconciled-${new Date().toISOString().slice(0, 10)}`]], hint: "removed; their commits stay on their branches, which are swept" });
      for (const w of dirty) findings.push({ kind: "worktree-with-uncommitted-work", id: w.path, detail: `${w.path} (${w.branch}) has uncommitted changes and no sprint is running`, hint: "look at it, then commit or discard it yourself; Shipyard does not delete uncommitted work" });
      const left = clean.length ? [] : listShipyardBranches(repoFor(dataDir), ownerOf(dataDir)).filter((b) => !b.checked_out);
      if (left.length) findings.push({ kind: "stale-shipyard-branches", id: `${left.length}`, detail: `${left.length} Shipyard branch(es) from finished sprints are still listed by \`git branch\` (${left.filter((b) => b.kind === "keep").length} anchors, ${left.filter((b) => b.kind === "wt").length} worktree branches)`, fix: [["branches", "sweep", "--label", `reconciled-${new Date().toISOString().slice(0, 10)}`]], hint: "merged ones deleted, the rest kept out of sight under refs/shipyard/archive/" });
    }
  } catch { /* no git here: nothing to report */ }
  // 7. a finished quick run whose branch has been merged: its records belong in the project now (after 4.0.6)
  try { for (const r of landable(dataDir)) findings.push({ kind: "quick-run-merged", id: r.run, detail: `${r.run} (branch ${r.branch}) is built and merged; its records are not in the project yet`, fix: [["quick", "land", r.run]], hint: "records brought into the project" }); } catch { /* no git here */ }
  return findings;
}

/** Apply the repairs. Returns [{finding, ok, error?}]. */
export function applyFixes(dataDir, findings) {
  const results = [];
  for (const f of findings) {
    let ok = true, error = "";
    if (f.fix) {
      for (const argv of f.fix) {
        const r = spawnSync("node", [CLI, ...argv, "--data-dir", dataDir], { encoding: "utf8" });
        if (r.status !== 0) { ok = false; error = (r.stderr || r.stdout || "").trim().split("\n")[0]; break; }
      }
    } else if (f.move) {
      try {
        const dest = join(dataDir, "sprints", "stale-cursors");
        mkdirSync(dest, { recursive: true });
        renameSync(f.move, join(dest, `${new Date().toISOString().replace(/[:.]/g, "-")}-${f.id}`));
      } catch (e) { ok = false; error = e.message; }
    } else { ok = null; } // report-only
    if (ok) { try { logEvent(dataDir, "state_reconciled", { kind: f.kind, id: f.id }); } catch { /* best-effort */ } }
    results.push({ finding: f, ok, error });
  }
  return results;
}

export function main(dataDir, args = []) {
  const fix = args.includes("--fix");
  const json = args.includes("--json");
  const unknown = args.filter((a) => !["--fix", "--json"].includes(a));
  if (unknown.length) { process.stderr.write(`shipyard-data reconcile: unknown argument "${unknown[0]}"\n  Usage: reconcile [--fix] [--json]\n`); process.exit(2); }
  const findings = findDrift(dataDir);
  const results = fix ? applyFixes(dataDir, findings) : null;
  if (json) { process.stdout.write(JSON.stringify({ findings: findings.map(({ fix: _f, move: _m, ...rest }) => rest), fixed: results ? results.filter((r) => r.ok).length : 0, failed: results ? results.filter((r) => r.ok === false).map((r) => ({ id: r.finding.id, kind: r.finding.kind, error: r.error })) : [] }) + "\n"); }
  else if (!findings.length) process.stdout.write("reconcile: state is consistent\n");
  else {
    for (const f of findings) {
      const r = results?.find((x) => x.finding === f);
      const mark = !results ? "•" : r.ok === true ? "✓ fixed" : r.ok === false ? `✗ ${r.error}` : "• (report only)";
      process.stdout.write(`${mark} [${f.kind}] ${f.detail}${results && r.ok ? ` — ${f.hint}` : !results && (f.fix || f.move) ? "" : f.hint ? ` — ${f.hint}` : ""}\n`);
    }
    if (!fix && findings.some((f) => f.fix || f.move)) process.stdout.write(`\n${findings.filter((f) => f.fix || f.move).length} repairable — run: shipyard-data reconcile --fix\n`);
  }
  if (!fix && findings.some((f) => f.fix || f.move)) process.exit(3);
  if (fix && results.some((r) => r.ok === false)) process.exit(1);
}
