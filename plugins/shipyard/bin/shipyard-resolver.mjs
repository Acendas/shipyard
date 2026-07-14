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
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const IS_WINDOWS = process.platform === "win32";

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
 * Resolve the "project root" — the path whose hash selects the data dir.
 *
 * Worktree semantics have two distinct cases we must tell apart:
 *
 *   A. BUILDER worktree — spawned by shipyard itself under
 *      `<parentRepo>/.claude/worktrees/<feature-id>/` during `/ship-execute`.
 *      Builder subagents in these worktrees MUST share state with the
 *      orchestrator on the main checkout; otherwise wave-boundary bookkeeping
 *      diverges. → hash the parent repo path.
 *
 *   B. USER worktree — a human-created worktree (e.g.
 *      `/work/afm-app/trunk3.worktrees/dev`) hosting an independent Claude
 *      session on a different branch. These are unrelated projects from
 *      Shipyard's POV and MUST get isolated state; otherwise two humans
 *      running parallel sessions on separate branches clobber each other's
 *      sprints/backlog/config (locking only prevents torn writes, not
 *      logical overwrite). → hash the worktree's own toplevel path.
 *
 * We distinguish the two by path shape: a worktree is treated as a builder
 * worktree iff its realpath'd toplevel is contained in
 * `<parentRepo>/.claude/worktrees/`. Everything else is a user worktree.
 *
 * Non-worktree repos hash `git rev-parse --show-toplevel`, and the fallback
 * is cwd (or resolved CLAUDE_PROJECT_DIR). All returned paths are realpath'd
 * so symlinked checkouts hash consistently.
 */
export function getProjectRoot() {
  return resolveProjectRoot().root;
}

/**
 * Internal worker behind {@link getProjectRoot}. Returns both the resolved
 * root AND whether it is backed by a real git repo (`gitBacked`).
 *
 * `gitBacked` is the signal getDataDir needs to avoid silently forking
 * project state (issue #4, defect 1): when neither the cwd nor
 * CLAUDE_PROJECT_DIR is inside a git repo, `root` is just "wherever the
 * process happened to be" (e.g. a skill orchestrator that cd'd into the
 * plugin data dir). Hashing that and minting `<pluginData>/projects/<hash>`
 * creates a phantom, config-less project dir that shadows the real one.
 * getDataDir refuses loudly instead when `gitBacked` is false.
 */
function resolveProjectRoot() {
  // CLAUDE_PROJECT_DIR (set by Claude Code) is used as the *starting cwd* for
  // git commands, not as the answer. Returning it directly would bypass the
  // worktree detection below: Claude Code sets this to the session cwd, which
  // for a builder subagent is the worktree path. Always run worktree
  // detection. Relative CLAUDE_PROJECT_DIR is normalized to absolute so the
  // answer doesn't depend on the resolver's own cwd.
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
      // We're inside a worktree. Resolve BOTH the parent repo root and
      // this worktree's own toplevel, then decide which to return based
      // on the builder-vs-user classification documented above.
      const parentRootRaw = dirname(absCommonDir);
      let parentRoot = parentRootRaw;
      if (existsSync(parentRootRaw)) {
        try {
          parentRoot = realpathSync(parentRootRaw);
        } catch {
          /* keep raw */
        }
      }

      const toplevelRaw = runGit(["rev-parse", "--show-toplevel"], startCwd);
      let worktreeTop;
      if (toplevelRaw && existsSync(toplevelRaw)) {
        try {
          worktreeTop = realpathSync(toplevelRaw);
        } catch {
          worktreeTop = toplevelRaw;
        }
      }

      // Builder worktrees live at `<parentRoot>/.claude/worktrees/<feature>`.
      // Containment check uses realpath'd paths + a trailing separator so
      // `/p/.claude/worktrees-other/x` doesn't match `/p/.claude/worktrees/`.
      // If we couldn't resolve worktreeTop for some reason, fall back to the
      // old behavior (return parent) — safer than misclassifying.
      if (!worktreeTop) {
        return { root: parentRoot, gitBacked: true };
      }
      const builderPrefix =
        join(parentRoot, ".claude", "worktrees") + sep;
      const isBuilderWorktree = (worktreeTop + sep).startsWith(builderPrefix);
      return {
        root: isBuilderWorktree ? parentRoot : worktreeTop,
        gitBacked: true,
      };
    }

    // Normal repo (not a worktree) — use show-toplevel
    const toplevel = runGit(["rev-parse", "--show-toplevel"], startCwd);
    if (toplevel && existsSync(toplevel)) {
      try {
        return { root: realpathSync(toplevel), gitBacked: true };
      } catch {
        return { root: toplevel, gitBacked: true };
      }
    }
  }

  // Last resort: startCwd (resolved CLAUDE_PROJECT_DIR) if we had one,
  // otherwise process.cwd(). NOT git-backed — flagged so getDataDir can
  // refuse rather than mint a phantom project dir from a bare cwd.
  const fallback = startCwd ?? process.cwd();
  try {
    return { root: realpathSync(fallback), gitBacked: false };
  } catch {
    return { root: fallback, gitBacked: false };
  }
}

/**
 * Deterministic per-project hash. 12-char sha256 prefix of the parent repo
 * path. Trailing newline matters: the format `sha256(path + '\n')[:12]` is
 * pinned and must not change — it determines where existing customer data
 * lives. Worktree checkouts rebind to the parent repo's hash by design.
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
 *   1. CLAUDE_PLUGIN_DATA env var (Claude Code's official surface).
 *   2. Tmpdir breadcrumb written by the SessionStart hook (bridges skill
 *      `!` backtick subprocesses where the env var isn't exported). Probed
 *      across all `breadcrumbCandidates()` because the hook and the skill
 *      subprocess can disagree on TMPDIR.
 *   3. `<projectRoot>/.shipyard` symlink (created by ship-init via
 *      `shipyard-data link-data-dir`), validated against the project hash.
 *      Env/TMPDIR-independent — the last resort before failing.
 *
 * If neither produces a usable path, fail loud: exit non-zero with a message
 * naming the env var. Never silently fall back to a phantom path.
 *
 * `silent: true` (used by in-process callers and structured-output CLIs)
 * throws a ShipyardResolverError instead of exiting, so the caller can
 * decide how to surface the failure — important for hook-runner.mjs which
 * imports this module in-process and must not kill the parent on failure.
 */
export class ShipyardResolverError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShipyardResolverError";
  }
}

/**
 * Candidate breadcrumb paths for a project hash, most-specific first.
 *
 * SINGLE SOURCE OF TRUTH for breadcrumb locations — both the writer
 * (plugin-data-breadcrumb SessionStart hook) and the reader (getDataDir
 * below) call this so they can never drift.
 *
 * Why a *list* and not a single `tmpdir()` path: Claude Code does not give
 * the SessionStart hook process and the skill `!` backtick subprocess the
 * same TMPDIR. Observed on macOS (2026-05-28): the hook ran with the default
 * user tmpdir (`/var/folders/.../T`) while the skill subprocess had
 * `TMPDIR=/tmp/claude-501`. `os.tmpdir()` honors TMPDIR, so the hook wrote
 * the breadcrumb where the skill never looked, and every `shipyard-context`
 * backtick failed with "cannot resolve plugin data directory" even though a
 * valid breadcrumb existed. POSIX `/tmp` is the shared meeting ground: it is
 * TMPDIR-independent, so writing AND reading there closes the gap regardless
 * of how Claude Code sets TMPDIR per subprocess.
 *
 * Order matters: `tmpdir()` first (private/uid-scoped, preferred), then bare
 * `/tmp` (world-writable fallback — see readBreadcrumb's owner check). On
 * Windows there is no `/tmp` and no observed TMPDIR split, so the list is
 * just `tmpdir()`.
 */
export function breadcrumbCandidates(projectHash) {
  const name = `shipyard-${projectHash}.plugindata`;
  const dirs = [tmpdir()];
  if (!IS_WINDOWS) dirs.push("/tmp");
  const seen = new Set();
  const paths = [];
  for (const dir of dirs) {
    const p = join(dir, name);
    if (!seen.has(p)) {
      seen.add(p);
      paths.push(p);
    }
  }
  return paths;
}

/**
 * Read a breadcrumb path safely and return the CLAUDE_PLUGIN_DATA value it
 * points at, or null. Because one candidate is world-writable `/tmp`, an
 * attacker could pre-plant a file to redirect Shipyard's data dir. Defenses:
 *  - reject anything that isn't a plain regular file (no symlink following);
 *  - on POSIX, reject files not owned by the current euid;
 *  - require the referenced path to actually exist before trusting it.
 */
function readBreadcrumb(path) {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    if (!IS_WINDOWS && typeof process.geteuid === "function") {
      if (st.uid !== process.geteuid()) return null;
    }
    const value = readFileSync(path, "utf8").trim();
    if (value && existsSync(value)) return value;
  } catch {
    // Missing, unreadable, or raced away — caller falls through.
  }
  return null;
}

/**
 * Resolve the data dir from the `<projectRoot>/.shipyard` symlink, or null.
 *
 * This is the env/TMPDIR-independent fallback: `.shipyard` is created (and
 * repointed) by `shipyard-data link-data-dir`, which `/ship-init` runs, so an
 * established project carries an in-tree pointer straight at its data dir.
 * Locating it needs only the git-based project root — it does NOT depend on
 * CLAUDE_PLUGIN_DATA or the breadcrumb, which is exactly why it survives the
 * TMPDIR-split failure that strands the breadcrumb (see breadcrumbCandidates).
 *
 * The "never resolve through .shipyard" rule (DECISIONS / dev notes) is about
 * not scattering symlink reads across skills/hooks/CLIs — the resolver staying
 * the single source of truth. Reading it *here*, inside the resolver, honors
 * that. Drift is the real hazard: a symlink is a cached absolute path that can
 * go stale or (for a copied worktree) point at the wrong project. We defuse it
 * by validating the target's shape against the freshly-computed hash: it must
 * be `<something>/projects/<projectHash>`. A mismatch is rejected, so a stale
 * or misclassified link can never silently redirect writes — it just falls
 * through to the fail-loud path. Last resort by ordering: only consulted when
 * both the env var and the breadcrumb are absent.
 */
function readDataDirLink(projectRoot, projectHash) {
  const linkPath = join(projectRoot, ".shipyard");
  try {
    // realpathSync follows the symlink/junction and throws if it dangles.
    const target = realpathSync(linkPath);
    // Validate the target belongs to THIS project: <pluginData>/projects/<hash>.
    // Structural check, not an isSymbolicLink() gate — a real dir a user left
    // at .shipyard realpaths to itself (basename ".shipyard") and fails here,
    // which keeps the check cross-platform (Windows junctions included).
    if (basename(target) !== projectHash) return null;
    if (basename(dirname(target)) !== "projects") return null;
    return target;
  } catch {
    // Missing, dangling, or unreadable — caller falls through.
    return null;
  }
}

/**
 * Create or repoint `<projectRoot>/.shipyard` -> dataDir, idempotently.
 *
 * The single symlink-writer, shared by two callers:
 *   - `shipyard-data link-data-dir` (the explicit CLI) — layers --force /
 *     refuse-on-real-entry semantics on top, for an operator who ran it.
 *   - the `plugin-data-breadcrumb` SessionStart hook — calls it best-effort so
 *     every session of an initialized project re-establishes the
 *     env/TMPDIR-independent fallback that `readDataDirLink` consumes, instead
 *     of relying on a one-time `/ship-init`. Closes the chicken-and-egg gap
 *     where the link only existed after init.
 *
 * Keeping one writer here (next to the reader) avoids the drifting-copies
 * anti-pattern. Best-effort and non-throwing for the expected cases; never
 * calls process.exit and never writes stdout, so a hook can call it safely.
 * Returns `{ status, linkPath }`:
 *   - 'ok'        — a correct symlink already existed; NOT recreated (inode
 *                   preserved, so idempotent callers don't churn the link)
 *   - 'created'   — no entry; symlink created
 *   - 'repointed' — symlink existed with a stale target; unlinked + recreated
 *   - 'blocked'   — a real (non-symlink) file/dir occupies the path; left
 *                   untouched (the CLI decides whether --force should clobber)
 * Throws only on unexpected fs errors; callers that must not fail wrap it.
 */
export function ensureDataDirLink(projectRoot, dataDir) {
  const linkPath = join(projectRoot, ".shipyard");
  const target = resolve(dataDir);
  const type = IS_WINDOWS ? "junction" : "dir";

  let existing = null;
  try {
    existing = lstatSync(linkPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  if (existing) {
    if (!existing.isSymbolicLink()) return { status: "blocked", linkPath };
    let current = "";
    try {
      current = readlinkSync(linkPath);
    } catch {
      /* unreadable link — treat as stale, recreate below */
    }
    // Compare resolved absolute paths so a relative-target symlink still
    // matches when it points at the right place.
    const currentAbs = current ? resolve(projectRoot, current) : "";
    if (currentAbs === target) return { status: "ok", linkPath };
    unlinkSync(linkPath);
    symlinkSync(target, linkPath, type);
    return { status: "repointed", linkPath };
  }

  symlinkSync(target, linkPath, type);
  return { status: "created", linkPath };
}

/**
 * Cheap "is this path inside a git work tree" check, used only when a caller
 * hands getDataDir a precomputed `projectRoot` (so we can still tell whether
 * it is git-backed without re-running full root resolution). Never throws.
 */
function isInsideGitRepo(root) {
  return runGit(["rev-parse", "--is-inside-work-tree"], root) === "true";
}

export function getDataDir(opts = {}) {
  let projectRoot;
  let gitBacked;
  if (opts.projectRoot) {
    projectRoot = opts.projectRoot;
    // A caller may assert gitBacked explicitly (resolver CLI does, to avoid a
    // redundant git call); otherwise probe the supplied root directly.
    gitBacked = opts.gitBacked ?? isInsideGitRepo(projectRoot);
  } else {
    ({ root: projectRoot, gitBacked } = resolveProjectRoot());
  }
  const projectHash = getProjectHash(projectRoot);

  // Guard (issue #4, defect 1): if the root is not backed by a git repo, its
  // hash is meaningless — it is just wherever the process happened to run.
  // With CLAUDE_PLUGIN_DATA set, the env-var path below would happily return
  // `<pluginData>/projects/<hash-of-cwd>`, silently minting a phantom,
  // config-less project dir that shadows the real one and swallows counters
  // and events (the exact failure reported from a skill orchestrator that
  // cd'd into the plugin data dir). The breadcrumb and `.shipyard` fallbacks
  // are keyed on this same bogus hash, so they cannot recover the real
  // project either. Refuse loudly instead of forking state.
  if (!gitBacked) {
    const cwdInDataDir =
      projectRoot.includes(`${sep}plugins${sep}data${sep}`) ||
      projectRoot.includes(`${sep}.claude-work${sep}plugins${sep}`);
    let message =
      `shipyard-resolver: refusing to resolve a data dir outside a git repo.\n` +
      `  Resolved project root is not inside a git repository:\n` +
      `    ${projectRoot}\n` +
      `  Shipyard keys project state on the git repo path, so running a\n` +
      `  bookkeeping command from a non-repo cwd would mint a NEW, empty\n` +
      `  project dir (projects/${projectHash}) instead of using the real one.\n`;
    if (cwdInDataDir) {
      message +=
        `  Likely cause: cwd is inside the plugin data directory.\n` +
        `  Don't cd into the data dir before running shipyard-data.\n`;
    }
    message +=
      `  Run shipyard-data from the project root, or set CLAUDE_PROJECT_DIR\n` +
      `  to the project's git checkout.\n`;
    if (opts.silent) {
      throw new ShipyardResolverError(message);
    }
    process.stderr.write(message);
    process.exit(1);
  }

  // 1. Explicit env var wins. Claude Code exports CLAUDE_PLUGIN_DATA to the
  //    plugin's hooks, MCP/LSP subprocesses, and skill bodies. This is the
  //    official surface and the only path we trust by default.
  let pluginData = process.env.CLAUDE_PLUGIN_DATA;

  // 2. Read breadcrumb written by SessionStart hook.
  //    Claude Code exports CLAUDE_PLUGIN_DATA to hook subprocesses but NOT
  //    consistently to skill `!` backtick subprocesses (varies by version).
  //    The plugin-data-breadcrumb SessionStart hook writes the value to
  //    shipyard-<hash>.plugindata in each candidate tmp dir so that
  //    backtick-spawned resolver calls can find it even when the hook and the
  //    skill subprocess disagree on TMPDIR. Per-project (keyed by project
  //    hash); survives skill invocations within a session; mode 0600.
  const candidates = breadcrumbCandidates(projectHash);
  if (!pluginData) {
    for (const candidate of candidates) {
      const value = readBreadcrumb(candidate);
      if (value) {
        pluginData = value;
        break;
      }
    }
  }

  // 3. `<projectRoot>/.shipyard` symlink fallback. Env/TMPDIR-independent —
  //    needs only the git-based project root, so it survives the case where a
  //    valid breadcrumb was stranded in a tmp dir the reader can't see. The
  //    target is already the full data dir (`…/projects/<hash>`), validated by
  //    readDataDirLink against the freshly-computed hash, so return it as-is.
  if (!pluginData) {
    const viaLink = readDataDirLink(projectRoot, projectHash);
    if (viaLink) return viaLink;
  }

  // 4. Fail loud if nothing resolved.
  if (!pluginData) {
    const cwdInDataDir =
      projectRoot.includes(`${sep}plugins${sep}data${sep}`) ||
      projectRoot.includes(`${sep}.claude-work${sep}plugins${sep}`);
    let message =
      `shipyard-resolver: cannot resolve plugin data directory.\n` +
      `  CLAUDE_PLUGIN_DATA env var is not set.\n` +
      `  No breadcrumb at: ${candidates.join(", ")}.\n` +
      `  No valid <projectRoot>/.shipyard symlink at ${join(projectRoot, ".shipyard")}.\n`;
    if (cwdInDataDir) {
      message +=
        `  Likely cause: cwd is inside the plugin data directory, not a git repo.\n` +
        `  Don't cd into the data dir before running shipyard-data — run it from the project root.\n`;
    }
    message +=
      `Set CLAUDE_PLUGIN_DATA or upgrade Claude Code to a version that sets it automatically.\n`;
    if (opts.silent) {
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
  const { root, gitBacked } = resolveProjectRoot();
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
      // Pass gitBacked through so the non-git guard fires without a second
      // git probe.
      process.stdout.write(getDataDir({ projectRoot: root, gitBacked }) + "\n");
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
