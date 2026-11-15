/**
 * Did a builder stay inside the files its step declared? (4.0)
 *
 * The plan is scored for parallel work on each step's `touches:` list: two
 * steps of one wave may not name the same file. Nothing checked that a builder
 * kept to its list, so a collision the plan had ruled out could still happen
 * at the merge. This measures it when the return is accepted.
 *
 * It never refuses. A builder often has a good reason to open one more file,
 * and refusing an accepted, tested commit would price the wrong act. What it
 * does: records `step_outside_touches`, prints one note, and names the case
 * that matters, a file another step of the same wave declared. The sprint
 * review lists the steps, so the next plan can declare better.
 */
import { spawnSync } from "node:child_process";
import { logEvent } from "./_hook_lib.mjs";
import { readEvents } from "./terminal-gate.mjs";
import { globToRe } from "./risk.mjs";
import { planTouches } from "./plan-score.mjs";

const git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

/** Does a `touches` entry (`file`, `dir/`, a glob, or `file#part`) cover this path? */
export function covers(entry, file) {
  const f = String(entry).split("#")[0].trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return Boolean(f) && (f === file || Boolean(globToRe(f)?.test(file)));
}

/**
 * The same changed file as the plan may have written it. `touches:` is written
 * relative to the folder the project lives in, and that folder can sit inside
 * a larger repository (seen live: the project is `game/` inside a
 * repository of several projects, and every declared file was reported as
 * undeclared). So a changed `game/src/a.c` is also tried as `src/a.c`:
 * with the folder the command runs in removed, and with each leading folder
 * removed in turn. Erring toward "covered" is the safe side for a note.
 */
export function spellings(file, prefix = "") {
  const out = [file];
  if (prefix && file.startsWith(prefix)) out.push(file.slice(prefix.length));
  const parts = file.split("/");
  for (let i = 1; i < parts.length - 1; i++) out.push(parts.slice(i).join("/"));
  return [...new Set(out)];
}

/**
 * The files this step's own commits changed.
 *
 * Not "everything between a base and the step's commit": once a wave is
 * merged, the step's commit sits on top of its siblings' work, and a diff
 * from an old base blamed one step for 43 files of four others (seen live).
 * So: the commits reachable from this step's commit and NOT from any other
 * step's commit recorded before it, nor from the sprint's main line as it was
 * before the step (its first parent chain is not needed: the exclusion does
 * it). Falls back to the step's last commit alone when nothing else is known.
 */
function ownFiles(dataDir, stepId, sha, cwd, base) {
  const full = git(["rev-parse", `${sha}^{commit}`], cwd);
  if (!full) return null;
  const others = [];
  for (const e of readEvents(dataDir, 20000)) {
    if (e.type !== "task_commit_anchored" || !/^[0-9a-f]{7,40}$/i.test(String(e.sha ?? ""))) continue;
    const id = String(e.task ?? e.step ?? "");
    if (id === stepId) break; // only commits recorded before this step's
    const o = git(["rev-parse", `${e.sha}^{commit}`], cwd);
    if (o && o !== full) others.push(o);
  }
  const not = [...new Set(others)];
  if (base) not.push(base);
  let commits = [];
  if (not.length) {
    const out = git(["rev-list", "--no-merges", full, "--not", ...not], cwd);
    commits = out === null ? [] : out.split("\n").filter(Boolean);
    // A long list means the exclusion did not find where this step began
    // (an unrelated history): the last commit alone is the honest answer.
    if (commits.length > 40) commits = [full];
  } else {
    const fork = git(["merge-base", full, "HEAD"], cwd);
    const out = fork && fork !== full ? git(["rev-list", "--no-merges", full, "--not", fork], cwd) : null;
    commits = out ? out.split("\n").filter(Boolean) : [full];
  }
  if (!commits.length) commits = [full];
  // Builders name their step in the commit message (the per-step gate greps
  // for it). When some of the commits do, those are the step's own; the rest
  // came along with the history (a rebased sibling, a late call).
  if (commits.length > 1) {
    const named = commits.filter((c) => new RegExp(`\\b${stepId}\\b`).test(git(["show", "-s", "--format=%s%n%b", c], cwd) ?? ""));
    if (named.length) commits = named;
  }
  const files = new Set();
  for (const c of commits) {
    const out = git(["show", "--name-only", "--format=", c], cwd);
    if (out === null) continue;
    for (const f of out.split("\n").map((x) => x.trim()).filter(Boolean)) files.add(f);
  }
  return [...files];
}

/**
 * @returns null when there is nothing to compare (no `touches:` on the step, no git), else
 *   { step, wave, changed, outside: [file], collisions: [{ file, step }] }
 */
export function outsideTouches(dataDir, stepId, sha, { cwd, base } = {}) {
  const plan = planTouches(dataDir);
  const mine = plan.get(stepId);
  if (!mine || !mine.declared || !cwd) return null;
  const changed = ownFiles(dataDir, stepId, sha, cwd, base);
  if (changed === null) return null;
  const prefix = (git(["rev-parse", "--show-prefix"], process.cwd()) ?? "").trim();
  const hit = (touches, f) => spellings(f, prefix).some((s) => touches.some((t) => covers(t, s)));
  const outside = changed.filter((f) => !hit(mine.touches, f));
  const collisions = [];
  for (const f of outside) {
    for (const [id, other] of plan) {
      if (id !== stepId && other.wave === mine.wave && hit(other.touches, f)) collisions.push({ file: f, step: id });
    }
  }
  return { step: stepId, wave: mine.wave, changed: changed.length, outside, collisions };
}

/** Called when a return is accepted: one event, one note. Never throws. */
export function reportOutsideTouches(dataDir, stepId, sha, opts = {}) {
  try {
    const r = outsideTouches(dataDir, stepId, sha, opts);
    if (!r || !r.outside.length) return null;
    logEvent(dataDir, "step_outside_touches", {
      v: 3, // v1 compared repository paths with project-folder paths; v2 blamed a merged step for its siblings' files
      step: stepId,
      ...(opts.sprint ? { sprint: opts.sprint } : {}),
      wave: r.wave,
      count: r.outside.length,
      files: r.outside.slice(0, 5).join(", "),
      ...(r.collisions.length ? { collides: r.collisions.slice(0, 5).map((c) => `${c.file} (${c.step})`).join(", ") } : {}),
    });
    const lines = [`note: ${stepId} changed ${r.outside.length} file(s) its step did not list under \`touches:\` (${r.outside.slice(0, 5).join(", ")}${r.outside.length > 5 ? ", ..." : ""})`];
    for (const c of r.collisions.slice(0, 5)) lines.push(`  ! ${c.file} is declared by ${c.step} in the same wave: expect a conflict when the wave is merged`);
    process.stdout.write(lines.join("\n") + "\n");
    return r;
  } catch { return null; }
}
