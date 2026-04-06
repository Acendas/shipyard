/**
 * Shared project-hash + data-dir resolver for Shipyard.
 *
 * SINGLE SOURCE OF TRUTH for:
 * - Project root discovery (parent repo, not worktree — see D1 in DECISIONS.md)
 * - Project hash computation (sha256 prefix of parent repo path)
 * - SHIPYARD_DATA path resolution
 *
 * All other binaries (shipyard-data.mjs, shipyard-context.mjs) and any
 * Python hook scripts that need to compute paths must call this module
 * (Python via subprocess `node shipyard-resolver.mjs <command>`).
 *
 * Why a single resolver: previously, three copies of this logic existed
 * across shipyard-data, hook-runner.py, and shipyard-context. They drifted
 * (some used CLAUDE_PROJECT_DIR first, some didn't), causing the auto-approve
 * hook to compute a different SHIPYARD_DATA than the skill that triggered
 * the write — silently breaking the permission workaround.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Run a git command and return stdout, or null on failure.
 * Never throws — git missing or non-repo returns null.
 */
function runGit(args, cwd) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Find the parent repo root, even when called from inside a worktree.
 *
 * `git rev-parse --show-toplevel` returns the WORKTREE path inside a worktree,
 * which is wrong for our purposes — builder subagents in worktrees should
 * share state with the orchestrator on main, so all worktrees of one project
 * must hash to the same value.
 *
 * Strategy:
 * 1. CLAUDE_PROJECT_DIR env var (set by Claude Code in many contexts)
 * 2. git-common-dir != git-dir → we're in a worktree, parent repo is one up
 * 3. git-common-dir == git-dir → normal repo, use show-toplevel
 * 4. fallback to cwd
 *
 * All paths are realpath'd so symlinked checkouts hash consistently.
 */
export function getProjectRoot() {
  // CLAUDE_PROJECT_DIR (set by Claude Code) is used as the *starting cwd* for
  // git commands, not as the answer. Returning it directly would bypass the
  // worktree-detection below: in production, Claude Code sets this to the
  // session cwd, which for a builder subagent is the worktree path — exactly
  // the case the F5 fix exists to handle. Always run worktree detection.
  // Also resolves R9: relative CLAUDE_PROJECT_DIR is normalized to absolute
  // so the answer doesn't depend on the resolver's own cwd.
  const claudeDir = process.env.CLAUDE_PROJECT_DIR;
  let startCwd;
  if (claudeDir) {
    const abs = resolve(claudeDir);
    if (existsSync(abs)) startCwd = abs;
  }

  const gitDir = runGit(["rev-parse", "--absolute-git-dir"], startCwd);
  const commonDir = runGit(["rev-parse", "--git-common-dir"], startCwd);

  if (gitDir && commonDir) {
    // Resolve both before comparing — git may return relative paths
    // (notably --git-common-dir often returns "../.git"). Resolve relative
    // to the cwd we passed to git, not the resolver's own cwd, otherwise
    // a relative CLAUDE_PROJECT_DIR gives the wrong answer.
    const gitCwd = startCwd ?? process.cwd();
    let absGitDir, absCommonDir;
    try {
      absGitDir = realpathSync(resolve(gitCwd, gitDir));
      absCommonDir = realpathSync(resolve(gitCwd, commonDir));
    } catch {
      absGitDir = resolve(gitCwd, gitDir);
      absCommonDir = resolve(gitCwd, commonDir);
    }

    if (absCommonDir !== absGitDir) {
      // We're inside a worktree. The parent repo root is the directory
      // containing the parent .git folder.
      const parentRoot = dirname(absCommonDir);
      if (existsSync(parentRoot)) {
        try {
          return realpathSync(parentRoot);
        } catch {
          return parentRoot;
        }
      }
    }

    // Normal repo (or worktree fallback failed) — use show-toplevel
    const toplevel = runGit(["rev-parse", "--show-toplevel"], startCwd);
    if (toplevel && existsSync(toplevel)) {
      try {
        return realpathSync(toplevel);
      } catch {
        return toplevel;
      }
    }
  }

  // Last resort: startCwd (resolved CLAUDE_PROJECT_DIR) if we had one,
  // otherwise process.cwd().
  const fallback = startCwd ?? process.cwd();
  try {
    return realpathSync(fallback);
  } catch {
    return fallback;
  }
}

/**
 * Deterministic per-project hash. 12-char sha256 prefix of the parent repo
 * path. Trailing newline matches the legacy bash `echo $path | shasum` format
 * so existing data dirs from prior versions remain valid for non-worktree
 * checkouts. (Worktree checkouts will rebind to the parent repo's hash —
 * intentional, see DECISIONS D1.)
 */
export function getProjectHash(projectRoot) {
  return createHash("sha256")
    .update(projectRoot + "\n", "utf8")
    .digest("hex")
    .slice(0, 12);
}

/**
 * Resolve the Shipyard data dir for the current project.
 *
 * Discovery order:
 *   1. CLAUDE_PLUGIN_DATA env var (set by recent Claude Code)
 *   2. Probe relative to CLAUDE_PLUGIN_ROOT (.../data/shipyard sibling of plugins/)
 *   3. Probe legacy ~/.claude/plugins/data/shipyard, BUT only when its
 *      projects/ subdir actually exists — preserves backcompat for
 *      customers who have real data there from older Claude Code.
 *
 * If none of the above produces a usable path, fail loud per DECISIONS F11:
 * exit non-zero with a message naming the env var and recommending an
 * upgrade. Silently picking a phantom path was the previous footgun.
 *
 * `silent: true` (used by in-process callers and structured-output CLIs)
 * throws a ShipyardResolverError instead of exiting, so the caller can
 * decide how to surface the failure — important for hook-runner.mjs which
 * imports this module in-process and must not kill the parent on failure.
 * Skill backtick blocks that get an empty SHIPYARD_DATA can't function
 * anyway, so a hard fail is still the right contract.
 */
export class ShipyardResolverError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShipyardResolverError";
  }
}

export function getDataDir(opts = {}) {
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const projectHash = getProjectHash(projectRoot);

  // 1. Explicit env var wins.
  let pluginData = process.env.CLAUDE_PLUGIN_DATA;

  // 2. Probe relative to CLAUDE_PLUGIN_ROOT (recent Claude Code layout).
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (!pluginData && pluginRoot) {
    const candidate = resolve(pluginRoot, "..", "..", "data", "shipyard");
    // R16: Check the candidate itself, not its parent. Otherwise a sibling
    // <root>/../../data/ created by another plugin would yield a phantom
    // <phantom>/projects/<hash> path. Same class of bug R10 fixed for the
    // legacy probe.
    if (existsSync(candidate)) {
      pluginData = candidate;
    }
  }

  // 3. Legacy probe — only USE if it has a populated projects/ subdir.
  // F10: On Windows with multi-drive setups, the auto-approve hook's
  // commonpath check fails when SHIPYARD_DATA and the project are on
  // different drives. Construct the legacy candidate on the project's
  // drive when applicable, then probe THAT path for existence.
  let legacy = join(homedir(), ".claude", "plugins", "data", "shipyard");
  if (process.platform === "win32") {
    const driveMatch = /^([A-Za-z]:)/.exec(projectRoot);
    const homeDriveMatch = /^([A-Za-z]:)/.exec(homedir());
    if (
      driveMatch &&
      homeDriveMatch &&
      driveMatch[1].toLowerCase() !== homeDriveMatch[1].toLowerCase()
    ) {
      const homeRel = homedir().slice(homeDriveMatch[1].length);
      legacy = driveMatch[1] + homeRel + "\\.claude\\plugins\\data\\shipyard";
    }
  }
  if (!pluginData) {
    const legacyProjects = join(legacy, "projects");
    if (existsSync(legacyProjects)) {
      pluginData = legacy;
    }
  }

  // 4. Fail loud if nothing resolved.
  if (!pluginData) {
    const message =
      `shipyard-resolver: cannot resolve plugin data directory.\n` +
      `  CLAUDE_PLUGIN_DATA env var is not set.\n` +
      `  No plugin-data dir found relative to CLAUDE_PLUGIN_ROOT (=${pluginRoot ?? "(unset)"}).\n` +
      `  No legacy data dir at ${legacy}/projects/.\n` +
      `Set CLAUDE_PLUGIN_DATA or upgrade Claude Code to a version that sets it automatically.\n`;
    if (opts.silent) {
      // In-process callers (hook-runner.mjs, shipyard-data.mjs CLI helpers)
      // catch this and decide how to surface it. Throwing instead of exiting
      // is required because process.exit() in an imported module kills the
      // host process — fatal for hook-runner which must continue dispatching.
      throw new ShipyardResolverError(message);
    }
    process.stderr.write(message);
    process.exit(1);
  }

  return join(pluginData, "projects", projectHash);
}

// CLI entry point — invoked by Python hook scripts via subprocess
// Usage: node shipyard-resolver.mjs <project-root|project-hash|data-dir>
function cli() {
  const command = process.argv[2] ?? "data-dir";
  const root = getProjectRoot();
  switch (command) {
    case "project-root":
      process.stdout.write(root + "\n");
      break;
    case "project-hash":
      process.stdout.write(getProjectHash(root) + "\n");
      break;
    case "data-dir":
      // CLI mode: fail-loud message goes to stderr if discovery fails.
      // In-process callers use { silent: true } to suppress the message.
      process.stdout.write(getDataDir({ projectRoot: root }) + "\n");
      break;
    default:
      process.stderr.write(
        `shipyard-resolver: unknown command "${command}". ` +
          `Expected: project-root | project-hash | data-dir\n`,
      );
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  cli();
}
