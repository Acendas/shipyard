/**
 * WorktreeCreate hook: create worktrees from the user's current branch.
 *
 * Node port of project-files/scripts/worktree-branch.py.
 *
 * Replaces Claude Code's default worktree creation to handle:
 *  1. Default branches from origin/HEAD — use the user's current branch
 *  2. Nested worktrees: if project is already a worktree, create from parent
 *  3. Parallel creation race condition — serialized via lockfile
 *
 * STDOUT CONTRACT: outputs ONLY the worktree path to stdout. Diagnostics
 * go to stderr. Claude Code reads stdout as the worktree path; any extra
 * output corrupts it (Claude Code bug #40262).
 *
 * SECURITY: worktree name validated against WORKTREE_NAME_RE from
 * _hook_lib.mjs. Defense-in-depth path containment via path.relative
 * after realpath.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative as pathRelative, resolve as pathResolve } from "node:path";
import { withLockfile, WORKTREE_NAME_RE } from "../_hook_lib.mjs";
import { warmWorktreeFromConfig } from "../worktree-warm.mjs";

function runGit(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    }).trim();
  } catch {
    return null;
  }
}

function findRepoRoot() {
  const gitDir = runGit(["rev-parse", "--absolute-git-dir"]);
  const commonDir = runGit(["rev-parse", "--git-common-dir"]);

  if (!gitDir || !commonDir) {
    const toplevel = runGit(["rev-parse", "--show-toplevel"]);
    if (toplevel && safeIsDir(toplevel)) return toplevel;
    process.stderr.write("shipyard worktree hook: cannot determine repo root\n");
    process.exit(1);
  }

  const absGitDir = pathResolve(gitDir);
  const absCommonDir = pathResolve(commonDir);

  if (absCommonDir !== absGitDir) {
    const parentRoot = dirname(absCommonDir);
    if (safeIsDir(parentRoot)) return parentRoot;
    process.stderr.write(`shipyard worktree hook: parent repo root not found at ${parentRoot}\n`);
    process.exit(1);
  }

  const toplevel = runGit(["rev-parse", "--show-toplevel"]);
  if (toplevel && safeIsDir(toplevel)) return toplevel;

  process.stderr.write("shipyard worktree hook: cannot determine repo root\n");
  process.exit(1);
}

function safeIsDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * Delete a stale `shipyard/wt-<name>` branch before recreating the worktree —
 * but NEVER force-delete one that carries commits not already contained in the
 * new base (`baseSha`). Such commits are the Claude Code #51596 case: an
 * agentId-prefix collision hands us a previously-used worktree name whose
 * branch still holds a prior agent's un-integrated work. An unconditional
 * `git branch -D` there silently orphans that work (a real data-loss vector
 * observed as dangling task commits). Anchor it under a `shipyard/keep-*` ref
 * first so creation can still proceed without losing anything.
 */
function safeDeleteStaleBranch(branchName, baseSha, repoRoot) {
  const exists = runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`], repoRoot);
  if (!exists) return; // nothing to delete

  // Is the stale branch fully contained in the new base? Then it has no
  // un-integrated work and is safe to drop. merge-base --is-ancestor exits 1
  // (→ execFileSync throws) when it is NOT an ancestor.
  let containedInBase = false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", branchName, baseSha], {
      cwd: repoRoot, stdio: "pipe", timeout: 5000,
    });
    containedInBase = true;
  } catch {
    containedInBase = false;
  }

  if (!containedInBase) {
    const shortSha = runGit(["rev-parse", "--short", branchName], repoRoot) || "unknown";
    const keepRef = `shipyard/keep-${name_slug(branchName)}-${shortSha}`;
    runGit(["branch", "-f", keepRef, branchName], repoRoot);
    process.stderr.write(
      `shipyard worktree hook: WARNING — stale branch ${branchName} has commits not in the ` +
        `new base; preserved as ${keepRef} before recreating (possible worktree-name ` +
        `collision, Claude Code #51596).\n`,
    );
  }
  runGit(["branch", "-D", branchName], repoRoot);
}

function name_slug(branchName) {
  return branchName.replace(/^shipyard\/wt-/, "").replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function run(hookInput, _env) {
  const name = hookInput?.name || "";
  if (!name) {
    process.stderr.write("shipyard worktree hook: no worktree name provided\n");
    return 1;
  }

  if (!WORKTREE_NAME_RE.test(name) || name.endsWith(".lock")) {
    process.stderr.write(
      `shipyard worktree hook: invalid worktree name. ` +
        `Must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ and not end in .lock\n`,
    );
    return 1;
  }

  const currentSha = runGit(["rev-parse", "HEAD"]);
  if (!currentSha) {
    process.stderr.write("shipyard worktree hook: could not determine HEAD\n");
    return 1;
  }

  const currentBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (currentBranch && currentBranch.startsWith("shipyard/wt-")) {
    process.stderr.write(
      `shipyard worktree hook: WARNING — creating worktree while on ` +
        `worktree branch ${currentBranch}. Using HEAD as base.\n`,
    );
  }

  const repoRoot = findRepoRoot();
  const worktreesDir = realpathSync(
    (() => {
      const wd = join(repoRoot, ".claude", "worktrees");
      mkdirSync(wd, { recursive: true });
      return wd;
    })(),
  );
  const worktreePath = pathResolve(join(worktreesDir, name));

  // Defense in depth: containment check via path.relative.
  let rel;
  try { rel = pathRelative(worktreesDir, worktreePath); } catch { rel = null; }
  if (rel === null || rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    process.stderr.write("shipyard worktree hook: worktree path escapes worktrees dir\n");
    return 1;
  }

  const lockPath = join(worktreesDir, ".worktree-create.lock");
  let exitCode = 0;
  let resultPath = null;
  try {
    withLockfile(lockPath, () => {
      // Clean up stale worktree at this path if it exists
      if (existsSync(worktreePath)) {
        runGit(["worktree", "remove", "--force", worktreePath], repoRoot);
      }

      const branchName = `shipyard/wt-${name}`;
      // Delete stale branch if it exists — but preserve any un-integrated
      // commits under a keep-ref first (see safeDeleteStaleBranch / #51596).
      safeDeleteStaleBranch(branchName, currentSha, repoRoot);

      const result = runGit(
        ["worktree", "add", "-b", branchName, worktreePath, currentSha],
        repoRoot,
      );
      if (result === null) {
        process.stderr.write(`shipyard worktree hook: git worktree add failed for ${name}\n`);
        exitCode = 1;
        return;
      }
      resultPath = worktreePath;
    }, { ttlMs: 30000, retryMs: 500, maxRetries: 60 });
  } catch (err) {
    process.stderr.write(`shipyard worktree hook: lock failure: ${err.message}\n`);
    return 1;
  }

  if (exitCode !== 0) return exitCode;

  // P4: best-effort artifact-dir warm (opt-in via worktree_warm.enabled,
  // default off). Deliberately runs HERE — after the lockfile block above
  // has already closed — never inside it: that lock's ttlMs is 30000, and
  // a multi-GB copy running inside it would have the lock stolen mid-copy
  // by a concurrent worktree spawner. See bin/worktree-warm.mjs for the
  // classification rule and refusal list. Never allowed to affect the
  // stdout contract or the hook's exit code — wrapped defensively even
  // though warmWorktreeFromConfig already swallows its own errors.
  try {
    warmWorktreeFromConfig({ sourceRoot: repoRoot, worktreePath: resultPath });
  } catch (err) {
    process.stderr.write(`shipyard worktree hook: worktree warm failed (non-blocking): ${err?.message ?? err}\n`);
  }

  // STDOUT CONTRACT: Only the path, nothing else (bug #40262). No newline.
  process.stdout.write(resultPath);
  return 0;
}
