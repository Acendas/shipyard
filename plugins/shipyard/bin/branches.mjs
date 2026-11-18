/**
 * `shipyard-data branches status|sweep [--label <name>] [--dry-run] [--json]` (v4.9)
 *
 * Leave the repository as it was found. Shipyard creates two kinds of
 * branches while a sprint runs: `shipyard/wt-*` (one per isolated builder)
 * and `shipyard/keep-*` (an anchor that keeps a returned or salvaged commit
 * reachable across the boundary rebase). Both matter only until the sprint is
 * reviewed. Nothing removed them afterwards: a real project had 569 after six
 * sprints (414 anchors, 155 worktree branches), which buried the owner's own
 * branches in `git branch` and made the wave-integration check crawl.
 *
 * `sweep` runs when a sprint is archived (and from `reconcile --fix`):
 *   - a branch whose tip is already contained in the current branch is deleted;
 *   - any other one is MOVED to `refs/shipyard/archive/<label>/<name>`: out of
 *     `git branch` and out of the default push, but still a ref, so its commits
 *     are never garbage-collected and `git log refs/shipyard/archive/...` shows them.
 * A branch checked out in a worktree is never touched; nothing outside the two
 * `shipyard/` prefixes is ever read or written. One `git update-ref --stdin`
 * transaction: all of it happens or none of it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { logEvent } from "./_hook_lib.mjs";
import { parseFrontmatter } from "./terminal-gate.mjs";
import { QUICK_RUN_RE, quickRunFor } from "./shipyard-resolver.mjs";

const NAME_RE = /^shipyard\/(keep-|wt-)[A-Za-z0-9._-]+$/;
const PATTERNS = ["refs/heads/shipyard/keep-*", "refs/heads/shipyard/wt-*"];

function git(args, cwd, input) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60000, input }).trim(); } catch { return null; }
}

/**
 * The repository a data dir belongs to: its `.project-root` breadcrumb, and
 * nothing else. No fallback to the current directory — `--data-dir <A>` typed
 * inside repository B must never list or sweep B's branches.
 */
export function repoFor(dataDir) {
  try {
    const root = readFileSync(join(dataDir, ".project-root"), "utf8").trim();
    if (root && existsSync(join(root, ".git"))) return root;
  } catch { /* no breadcrumb */ }
  return null;
}

/**
 * Whose builder branches these are (after 4.0.6). A quick run and the regular
 * project build in ONE repository, so both make `shipyard/wt-*` and
 * `shipyard/keep-*` branches there. Each side must see only its own: the
 * other side's unmerged builder would fail this side's wave check, and a
 * sweep would take away a branch that is still being built. A quick run's
 * branches carry `branch.<name>.shipyard-owner = <run>`; a branch with no
 * owner is the regular project's.
 */
export function ownerOf(dataDir) {
  const name = basename(String(dataDir ?? ""));
  return QUICK_RUN_RE.test(name) && basename(dirname(String(dataDir))) === "quick" ? name : null;
}
/** The owner for a caller that only knows the repository: the quick run bound to its current branch, or null. */
export function ownerFor(root) { return quickRunFor(root)?.run ?? null; }
/** Map of branch name to its owner, for every branch that has one. */
export function branchOwners(root) {
  const out = new Map();
  const raw = git(["config", "--get-regexp", "^branch\\..*\\.shipyard-owner$"], root);
  for (const line of (raw ?? "").split("\n")) {
    const m = /^branch\.(.+)\.shipyard-owner (.+)$/.exec(line.trim());
    if (m) out.set(m[1], m[2]);
  }
  return out;
}
/** Mark `branch` as built for `owner` (a quick run). No owner: nothing to write. */
export function stampOwner(root, branch, owner) {
  if (owner) git(["config", `branch.${branch}.shipyard-owner`, owner], root);
}
/** Keep only the names that belong to `owner` (null = the regular project). */
export function ownedNames(root, names, owner = ownerFor(root)) {
  const owners = branchOwners(root);
  return names.filter((n) => (owners.get(n) ?? null) === owner);
}

/** Shipyard's own branches in `root`: [{ name, sha, kind, checked_out, contained }]. */
export function listShipyardBranches(root, owner = ownerFor(root)) {
  if (!root) return [];
  const raw = git(["for-each-ref", "--format=%(refname:short) %(objectname)", ...PATTERNS], root);
  if (!raw) return [];
  const contained = new Set((git(["for-each-ref", "--merged", "HEAD", "--format=%(refname:short)", ...PATTERNS], root) ?? "").split("\n").filter(Boolean));
  const checkedOut = new Set((git(["worktree", "list", "--porcelain"], root) ?? "").split("\n").filter((l) => l.startsWith("branch refs/heads/")).map((l) => l.slice("branch refs/heads/".length)));
  const owners = branchOwners(root);
  return raw.split("\n").filter(Boolean).map((line) => {
    const [name, sha] = line.split(" ");
    return { name, sha, kind: name.startsWith("shipyard/keep-") ? "keep" : "wt", checked_out: checkedOut.has(name), contained: contained.has(name) };
  }).filter((b) => NAME_RE.test(b.name) && /^[0-9a-f]{40,64}$/.test(b.sha) && (owners.get(b.name) ?? null) === owner);
}

/** Registered worktrees on a `shipyard/wt-*` branch: [{ path, branch, dirty }]. */
export function listShipyardWorktrees(root, owner = ownerFor(root)) {
  if (!root) return [];
  const owners = branchOwners(root);
  const raw = git(["worktree", "list", "--porcelain"], root);
  if (!raw) return [];
  const out = [];
  let cur = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) { cur = { path: line.slice(9), branch: null }; }
    else if (line.startsWith("branch refs/heads/") && cur) { cur.branch = line.slice("branch refs/heads/".length); if (/^shipyard\/wt-[A-Za-z0-9._-]+$/.test(cur.branch)) out.push(cur); }
  }
  return out.filter((w) => (owners.get(w.branch) ?? null) === owner).map((w) => { const st = git(["status", "--porcelain"], w.path); return { ...w, dirty: st === null ? true : st.length > 0 }; });
}

/**
 * Remove finished builders' worktrees (4.9.2). Only a CLEAN worktree is
 * removed, with plain `git worktree remove` (never --force): its commits stay
 * on its branch, which the branch sweep then deletes (merged) or archives.
 * A worktree with uncommitted changes is left and named, never discarded.
 */
export function sweepWorktrees(root, { dryRun = false, owner = ownerFor(root) } = {}) {
  const all = listShipyardWorktrees(root, owner);
  const removed = [], kept = [];
  for (const w of all) {
    if (w.dirty) { kept.push({ path: w.path, why: "has uncommitted changes" }); continue; }
    if (dryRun) { removed.push(w.path); continue; }
    if (git(["worktree", "remove", w.path], root) === null) kept.push({ path: w.path, why: "git refused to remove it" });
    else removed.push(w.path);
  }
  if (!dryRun && removed.length) git(["worktree", "prune"], root);
  return { removed, kept };
}

/** A sprint is running: its branches are live, so nothing may be swept. */
export function sprintInFlight(dataDir) {
  try {
    const cur = readFileSync(join(dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    const fm = parseFrontmatter(cur);
    return String(fm.status ?? "").trim() !== "complete" && String(fm.terminal ?? "").trim() !== "true";
  } catch { return false; }
}

/**
 * Sweep. Returns { deleted, archived, skipped, label, refs_prefix } (counts) or { error }.
 */
export function sweepBranches(root, { label = "swept", dryRun = false, owner = ownerFor(root) } = {}) {
  const safeLabel = String(label).replace(/[^A-Za-z0-9._-]/g, "-") || "swept";
  const all = listShipyardBranches(root, owner);
  const todo = all.filter((b) => !b.checked_out);
  const lines = [];
  for (const b of todo) {
    if (!b.contained) lines.push(`update refs/shipyard/archive/${safeLabel}/${b.name.slice("shipyard/".length)} ${b.sha}`);
    lines.push(`delete refs/heads/${b.name} ${b.sha}`);
  }
  const result = { label: safeLabel, refs_prefix: `refs/shipyard/archive/${safeLabel}/`, deleted: todo.filter((b) => b.contained).length, archived: todo.filter((b) => !b.contained).length, skipped: all.length - todo.length, dry_run: dryRun };
  if (dryRun || !lines.length) return result;
  if (git(["update-ref", "--stdin"], root, lines.join("\n") + "\n") === null) return { error: "git update-ref refused the sweep; no branch was changed" };
  if (owner) for (const b of todo) git(["config", "--remove-section", `branch.${b.name}`], root); // update-ref leaves the branch's config section behind
  return result;
}

function usage(msg) {
  process.stderr.write(`shipyard-data branches: ${msg}\n  Usage: branches status [--json]\n         branches sweep [--label <name>] [--dry-run] [--force] [--json]   (finished builder worktrees first, then branches)\n`);
  process.exit(2);
}

export function main(dataDir, args = []) {
  const sub = args[0];
  const json = args.includes("--json");
  const root = repoFor(dataDir);
  const owner = ownerOf(dataDir);
  if (!root) { process.stderr.write("shipyard-data branches: this data dir records no project repository (.project-root is missing or is not a git checkout) — nothing to list or sweep\n"); process.exit(3); }
  if (sub === "status") {
    const all = listShipyardBranches(root, owner);
    const archived = (git(["for-each-ref", "--format=%(refname)", "refs/shipyard/archive/"], root) ?? "").split("\n").filter(Boolean).length;
    const wts = listShipyardWorktrees(root, owner);
    const out = { worktrees: wts.length, worktrees_dirty: wts.filter((w) => w.dirty).length, visible: all.length, anchors: all.filter((b) => b.kind === "keep").length, worktree_branches: all.filter((b) => b.kind === "wt").length, checked_out: all.filter((b) => b.checked_out).length, archived, sprint_in_flight: sprintInFlight(dataDir) };
    if (json) process.stdout.write(JSON.stringify(out) + "\n");
    else process.stdout.write(`Shipyard worktrees in ${root}: ${out.worktrees}${out.worktrees_dirty ? ` (${out.worktrees_dirty} with uncommitted changes)` : ""}\nShipyard branches: ${out.visible} visible (${out.anchors} anchors, ${out.worktree_branches} worktree branches, ${out.checked_out} checked out); ${out.archived} kept out of sight under refs/shipyard/archive/${out.visible && !out.sprint_in_flight ? "\nrun: shipyard-data branches sweep" : ""}\n`);
    return;
  }
  if (sub === "sweep") {
    const li = args.indexOf("--label");
    const label = li !== -1 ? args[li + 1] : `swept-${new Date().toISOString().slice(0, 10)}`;
    if (li !== -1 && (!label || label.startsWith("--"))) usage("--label needs a value");
    if (sprintInFlight(dataDir) && !args.includes("--force")) {
      process.stderr.write("shipyard-data branches: a sprint is running — its builder branches and anchors are live. Sweep after the sprint is archived (archive-sprint does it), or pass --force.\n");
      process.exit(3);
    }
    const wt = sweepWorktrees(root, { dryRun: args.includes("--dry-run"), owner });
    const r = sweepBranches(root, { label, dryRun: args.includes("--dry-run"), owner });
    if (r.error) { process.stderr.write(`shipyard-data branches: ${r.error}\n`); process.exit(1); }
    r.worktrees_removed = wt.removed.length; r.worktrees_kept = wt.kept;
    if (!json && (wt.removed.length || wt.kept.length)) process.stdout.write(`${r.dry_run ? "would remove" : "removed"} ${wt.removed.length} finished builder worktree(s)${wt.kept.length ? `; left ${wt.kept.length}: ${wt.kept.map((k) => `${k.path} (${k.why})`).join(", ")}` : ""}\n`);
    if (!r.dry_run && (r.deleted || r.archived || wt.removed.length)) { try { logEvent(dataDir, "branches_swept", { label: r.label, deleted: r.deleted, archived: r.archived, skipped: r.skipped, worktrees_removed: wt.removed.length, worktrees_kept: wt.kept.length }); } catch { /* best-effort */ } }
    if (json) process.stdout.write(JSON.stringify(r) + "\n");
    else process.stdout.write(`${r.dry_run ? "would sweep" : "swept"} ${r.deleted + r.archived} Shipyard branch(es): ${r.deleted} already merged (deleted), ${r.archived} kept under ${r.refs_prefix} (out of \`git branch\`, never garbage-collected)${r.skipped ? `; ${r.skipped} checked out in a worktree, left alone` : ""}\n`);
    return;
  }
  usage(`unknown subcommand "${sub ?? ""}"`);
}
