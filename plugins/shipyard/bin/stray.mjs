/**
 * `shipyard-data stray list|set-aside` (v4.13) — changes in the working tree
 * that no step committed.
 *
 * A "read-only" reviewer has a shell. In a real sprint one ran
 * `python3 tools/gen_research_index.py --help`; the script ignores `--help`
 * and regenerated a tracked file, dropping 55 hand-written lines from the
 * owner's working copy. The reviewer was (rightly) refused a `git checkout`,
 * the orchestrator would not run it for a refused agent, and an unattended
 * sprint was left telling its owner "still needs you".
 *
 * Shipyard does not discard what it cannot prove is its own, and it does not
 * leave the tree dirty for someone else either: `set-aside` moves the stray
 * changes of TRACKED files in the project's folder into a git stash. The
 * tree is clean again, nothing is lost, and the sprint review names the stash.
 *   stray list [--json]                      what would be set aside
 *   stray set-aside --reason "<who or what>" stash them; prints how to get them back
 * Untracked files are only listed: Shipyard never removes a file it did not create.
 */
import { execFileSync } from "node:child_process";
import { logEvent } from "./_hook_lib.mjs";
import { repoFor } from "./branches.mjs";
import { projectScope } from "./verify-ledger.mjs";
import { LOCK_FILES, resolveSessionIdentity, runningBeside } from "./skill-lock.mjs";

/** Shipyard commands running in OTHER sessions on this project: their work in progress may be among the changed files. */
export function othersWorkingHere(dataDir) {
  try {
    const { sessionId, unverified } = resolveSessionIdentity([]);
    const seen = new Map();
    for (const kind of Object.keys(LOCK_FILES)) for (const b of runningBeside(dataDir, kind, sessionId, unverified)) if (b.state === "held") seen.set(b.kind, b.skill);
    return [...seen.values()];
  } catch { return []; }
}

function git(args, cwd) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000 }).replace(/\s+$/, ""); } catch { return null; }
}

/** { root, scope, tracked: [paths], untracked: [paths] } — paths relative to the repository root. */
export function strayChanges(dataDir, projectDir = null) {
  const root = repoFor(dataDir);
  if (!root) return null;
  const scope = projectScope(root, projectDir);
  const spec = scope ? ["--", scope] : [];
  const lines = (git(["status", "--porcelain", ...spec], root) ?? "").split("\n").filter(Boolean);
  const tracked = [], untracked = [];
  for (const l of lines) {
    const path = l.slice(3).replace(/^"|"$/g, "");
    if (l.startsWith("??")) untracked.push(path); else tracked.push(path.includes(" -> ") ? path.split(" -> ").pop() : path);
  }
  return { root, scope, tracked, untracked };
}

function usage(msg) {
  process.stderr.write(`shipyard-data stray: ${msg}\n  Usage: stray list [--json]\n         stray set-aside --reason "<who or what changed the files>" [--json]\n`);
  process.exit(2);
}

export function main(dataDir, args = []) {
  const sub = args[0];
  const json = args.includes("--json");
  const s = strayChanges(dataDir);
  if (!s) { process.stderr.write("shipyard-data stray: this data dir records no project repository\n"); process.exit(3); }
  if (sub === "list") {
    if (json) { process.stdout.write(JSON.stringify({ scope: s.scope, tracked: s.tracked, untracked: s.untracked }) + "\n"); }
    else if (!s.tracked.length && !s.untracked.length) process.stdout.write("stray: the working tree has no uncommitted changes\n");
    else {
      for (const p of s.tracked) process.stdout.write(`changed    ${p}\n`);
      for (const p of s.untracked) process.stdout.write(`untracked  ${p}   (listed only: never removed)\n`);
      if (s.tracked.length) process.stdout.write(`\n${s.tracked.length} tracked file(s) changed with no commit — if no step owns them: shipyard-data stray set-aside --reason "<who or what changed them>"\n`);
    }
    if (s.tracked.length) process.exitCode = 3;
    return;
  }
  if (sub === "set-aside") {
    const i = args.indexOf("--reason");
    const reason = i !== -1 ? String(args[i + 1] ?? "").replace(/\s+/g, " ").trim() : "";
    if (reason.length < 3 || reason.startsWith("--")) usage('set-aside needs --reason "<who or what changed the files>"');
    if (!s.tracked.length) { process.stdout.write(json ? JSON.stringify({ set_aside: 0 }) + "\n" : "stray: no tracked file is changed — nothing to set aside\n"); return; }
    // 4.17: commands now run side by side. A changed file may be another
    // command's work in progress (an in-place builder, a merge, a fix pass);
    // setting it aside would pull the floor from under it.
    const others = othersWorkingHere(dataDir);
    if (others.length && !args.includes("--force")) {
      process.stderr.write(`shipyard-data stray set-aside: ${others.join(" and ")} is running on this project in another session, so ${s.tracked.length === 1 ? "this file" : "these files"} may be its work in progress: ${s.tracked.join(", ")}.\n  Nothing was set aside. Wait for it to finish, or pass --force if you are certain the change is not its.\n`);
      process.exit(3);
    }
    const message = `shipyard stray: ${reason}`.slice(0, 200);
    if (git(["stash", "push", "-m", message, "--", ...s.tracked], s.root) === null) { process.stderr.write("shipyard-data stray: git stash refused — nothing was changed\n"); process.exit(1); }
    const sha = git(["rev-parse", "stash@{0}"], s.root) ?? "";
    try { logEvent(dataDir, "stray_changes_set_aside", { files: s.tracked.join(","), count: s.tracked.length, stash: sha, reason }); } catch { /* best-effort */ }
    const back = `git stash apply ${sha.slice(0, 12)}`;
    if (json) process.stdout.write(JSON.stringify({ set_aside: s.tracked.length, files: s.tracked, stash: sha, restore: back }) + "\n");
    else process.stdout.write(`set aside ${s.tracked.length} changed file(s): ${s.tracked.join(", ")}\n  kept in git stash ${sha.slice(0, 12)} ("${message}") — nothing is lost\n  to bring them back: ${back}    to drop them: git stash drop (find it with git stash list)\n`);
    return;
  }
  usage(`unknown subcommand "${sub ?? ""}"`);
}
