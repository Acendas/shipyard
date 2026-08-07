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
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const IS_WINDOWS = process.platform === "win32";

function pathPartsForInstallPath(sourcePath) {
  const sepChar = sourcePath.includes("\\") ? "\\" : "/";
  return { sepChar, parts: sourcePath.split(/[\\/]+/) };
}

function joinInstallParts(parts, endInclusive, sepChar) {
  if (parts[0] === "") return sepChar + parts.slice(1, endInclusive + 1).join(sepChar);
  return parts.slice(0, endInclusive + 1).join(sepChar);
}

function joinInstallPath(base, sepChar, ...parts) {
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sepChar);
}

/**
 * Derive the current plugin install identity from a resolver file path.
 *
 * Real marketplace installs live under:
 *   <configRoot>/plugins/cache/<marketplace>/<plugin>/<version>/bin/shipyard-resolver.mjs
 *
 * Dev/linked installs do not have the `plugins/cache` segment pair and return
 * null, preserving the existing breadcrumb/link fallback behavior.
 */
export function deriveInstallInfoFromResolverPath(sourcePath) {
  const { sepChar, parts } = pathPartsForInstallPath(sourcePath);
  let cacheIdx = -1;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "plugins" && parts[i + 1] === "cache") cacheIdx = i;
  }
  if (cacheIdx < 0) return null;
  const marketplace = parts[cacheIdx + 2];
  const plugin = parts[cacheIdx + 3];
  if (!marketplace || !plugin) return null;
  return {
    configPluginsDir: joinInstallParts(parts, cacheIdx, sepChar),
    marketplace,
    plugin,
    sepChar,
  };
}

function resolverPathFromUrl(sourceUrl) {
  try {
    return realpathSync(fileURLToPath(sourceUrl));
  } catch {
    try {
      return fileURLToPath(sourceUrl);
    } catch {
      return "";
    }
  }
}

export function deriveDataRootFromResolverPath(sourcePath, opts = {}) {
  const info = deriveInstallInfoFromResolverPath(sourcePath);
  if (!info) return null;
  const candidate = joinInstallPath(
    info.configPluginsDir,
    info.sepChar,
    "data",
    `${info.plugin}-${info.marketplace}`,
  );
  if (opts.requireExists === false || existsSync(candidate)) return candidate;
  return null;
}

export function deriveDataRootFromSelf(sourceUrl = import.meta.url) {
  const sourcePath = resolverPathFromUrl(sourceUrl);
  if (!sourcePath) return null;
  return deriveDataRootFromResolverPath(sourcePath);
}

/**
 * The `<plugin>-<marketplace>` directory segment this install owns under the
 * shared `<configRoot>/plugins/data/` root, or null for a dev/linked install
 * (no `plugins/cache/<marketplace>/<plugin>/` in the resolver's own path, so
 * there is no defined segment to speak of).
 */
export function installDataSegmentFromSelf(sourceUrl = import.meta.url) {
  const sourcePath = resolverPathFromUrl(sourceUrl);
  if (!sourcePath) return null;
  const info = deriveInstallInfoFromResolverPath(sourcePath);
  return info ? `${info.plugin}-${info.marketplace}` : null;
}

/**
 * Normalize a plugin-data root to the PLUGIN-SCOPED level.
 *
 * The bug this fixes: `plugins/data/` is a root SHARED by every installed
 * plugin, and each plugin owns exactly one `<plugin>-<marketplace>/`
 * subdirectory inside it (that is the layout `deriveDataRootFromResolverPath`
 * above produces, and the layout every working install on disk has). But
 * `getDataDir` used to append `projects/<hash>` to whatever
 * CLAUDE_PLUGIN_DATA happened to contain. Hand-exporting the SHARED root
 * (`CLAUDE_PLUGIN_DATA=~/.claude-work/plugins/data`) therefore minted
 * `plugins/data/projects/<hash>` — a sibling of the real
 * `plugins/data/shipyard-acendas/projects/<hash>`, one level too shallow.
 * Every lookup landed in a fresh, empty, config-less project dir: a
 * long-existing feature read back as MISSING-FILE, and `doctor` grew
 * phantom-project warnings. Observed 2026-08-06.
 *
 * DISCRIMINATOR RULE (deterministic, in this order):
 *   0. No known segment (dev/linked install) → return unchanged. We cannot
 *      invent a segment name we were never installed under, and guessing
 *      would break every dev/test fixture that points CLAUDE_PLUGIN_DATA at
 *      a bare scratch dir.
 *   1. `basename(pluginData) === <segment>` → ALREADY scoped, return
 *      unchanged. This is the backward-compatibility case: a correct setup
 *      (Claude Code's own export, and what the SessionStart breadcrumb
 *      records) is never rewritten.
 *   2. `<pluginData>/<segment>` exists on disk → we were handed the parent
 *      of our own scoped dir. Strongest possible evidence, so it outranks
 *      the shape check below; it also covers non-standard roots.
 *   3. `basename === "data"` and its parent is named `plugins` → the shared
 *      `<configRoot>/plugins/data` root, before our scoped dir has ever been
 *      created. Append. Deliberately narrow: an arbitrary custom directory
 *      that merely happens to be handed to us is left alone, so this can
 *      only ever redirect a path that literally has the shared-root shape.
 *   4. Anything else → unchanged.
 *
 * Note what is NOT used as a discriminator: "does `<pluginData>/projects`
 * exist". That test is worthless here precisely BECAUSE of the bug — the
 * shared root grows a phantom `projects/` the first time the shallow path is
 * used, so it would report "already scoped" exactly in the broken case.
 */
export function scopePluginDataRoot(pluginData, opts = {}) {
  if (!pluginData) return pluginData;
  const segment = Object.prototype.hasOwnProperty.call(opts, "segment")
    ? opts.segment
    : installDataSegmentFromSelf();
  if (!segment) return pluginData; // rule 0
  const trimmed = pluginData.replace(/[\\/]+$/, "") || pluginData;
  if (basename(trimmed) === segment) return pluginData; // rule 1
  const scoped = join(trimmed, segment);
  if (existsSync(scoped)) return scoped; // rule 2
  if (basename(trimmed) === "data" && basename(dirname(trimmed)) === "plugins") {
    return scoped; // rule 3
  }
  return pluginData; // rule 4
}

export function configTagForPluginsDir(configPluginsDir) {
  if (!configPluginsDir) return null;
  return createHash("sha256")
    .update(configPluginsDir + "\n", "utf8")
    .digest("hex")
    .slice(0, 12);
}

export function configPluginsDirFromPluginData(pluginData) {
  if (!pluginData) return null;
  const { sepChar, parts } = pathPartsForInstallPath(resolve(pluginData));
  let pluginsIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i] === "plugins") {
      pluginsIdx = i;
      break;
    }
  }
  if (pluginsIdx < 0) return null;
  return joinInstallParts(parts, pluginsIdx, sepChar);
}

function configPluginsDirFromSelf(sourceUrl = import.meta.url) {
  const sourcePath = resolverPathFromUrl(sourceUrl);
  if (!sourcePath) return null;
  return deriveInstallInfoFromResolverPath(sourcePath)?.configPluginsDir ?? null;
}

function currentBreadcrumbTag(opts = {}) {
  if (opts.legacy) return null;
  if (Object.prototype.hasOwnProperty.call(opts, "configTag")) return opts.configTag || null;
  if (opts.configPluginsDir) return configTagForPluginsDir(opts.configPluginsDir);
  const selfDir = configPluginsDirFromSelf();
  if (selfDir) return configTagForPluginsDir(selfDir);
  const envDir = configPluginsDirFromPluginData(process.env.CLAUDE_PLUGIN_DATA);
  if (envDir) return configTagForPluginsDir(envDir);
  return null;
}

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
 * Read the origin-marker file the WorktreeCreate hook (`worktree-branch.mjs`)
 * best-effort stamps into a freshly-created worktree's git ADMIN dir (not its
 * working tree — never a committable file). Filename is fixed:
 * `shipyard-origin-root`, sibling to the worktree's own `HEAD`/`commondir`
 * files under `.git/worktrees/<name>/` (or, for a nested worktree, whatever
 * `git rev-parse --absolute-git-dir` reports for it).
 *
 * Why this exists: the builder-worktree classification below assumes the
 * orchestrator session lives on the PARENT repo, so hashing `parentRoot`
 * reunites a builder subagent's writes with the orchestrator's. That
 * assumption breaks when the orchestrator itself is running inside a USER
 * worktree (e.g. `trunk3.worktrees/dev2`) and spawns builder worktrees under
 * the *parent* repo's `.claude/worktrees/` — those builders would otherwise
 * hash to the parent repo, a different data dir than the orchestrator's own
 * (the user worktree). The hook runs in the orchestrator's own process
 * context at worktree-creation time and therefore already knows the right
 * answer; stamping it lets a builder recover it later without needing any
 * shared env var or IPC.
 *
 * Accepted only when EVERY check holds — any failure falls through to the
 * caller's existing `parentRoot` behavior, so a missing/corrupt/malicious
 * marker can never make things worse than today:
 *   - the marker file exists and is a plain file (no symlink-following);
 *   - its content is exactly one non-empty line (trailing newline stripped);
 *   - the line has no control characters and is under 4096 bytes;
 *   - the line is an absolute path;
 *   - that path exists on disk;
 *   - realpath'd, it is itself inside a git work tree (`gitBacked`).
 *
 * This is hook-adjacent attack surface (see "Security: hooks are attack
 * surface" in the workspace dev notes) even though the admin dir is not
 * normally attacker-writable — applying the same discipline as the tmpdir
 * breadcrumb reader (readBreadcrumb) costs nothing and keeps the invariant
 * uniform across every file-based trust boundary in this module.
 */
export function readWorktreeOriginRoot(absGitDir) {
  if (!absGitDir) return null;
  const markerPath = join(absGitDir, "shipyard-origin-root");
  let raw;
  try {
    const st = lstatSync(markerPath);
    if (!st.isFile()) return null;
    raw = readFileSync(markerPath, "utf8");
  } catch {
    return null; // missing, unreadable, or raced away
  }

  // Exactly one non-empty line. Reject anything else outright rather than
  // trying to salvage a "mostly fine" multi-line value — the offset math a
  // partial parse would need is exactly the kind of complexity that hides
  // bugs in a security-sensitive reader.
  const lines = raw.split("\n").filter((l) => l.length > 0);
  if (lines.length !== 1) return null;
  const value = lines[0];

  if (value.length === 0 || value.length >= 4096) return null;
  // eslint-disable-next-line no-control-regex -- deliberately scanning for control chars
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  if (!isAbsolute(value)) return null;
  if (!existsSync(value)) return null;

  let real;
  try {
    real = realpathSync(value);
  } catch {
    return null;
  }
  if (!isInsideGitRepo(real)) return null;
  return real;
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

      if (isBuilderWorktree) {
        // Before defaulting to parentRoot, check for an origin marker the
        // WorktreeCreate hook stamped at creation time (see
        // readWorktreeOriginRoot above). It knows the orchestrator's true
        // project root even when that orchestrator itself sits in a USER
        // worktree rather than the parent repo — a case parentRoot alone
        // gets wrong. absGitDir here is this same worktree's own admin dir,
        // exactly where the hook would have written the marker.
        const marker = readWorktreeOriginRoot(absGitDir);
        if (marker) {
          return { root: marker, gitBacked: true };
        }
      }

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
 *   2. Install-scoped data root derived from this resolver's own cache path.
 *   3. Tmpdir breadcrumb written by the SessionStart hook (bridges skill
 *      `!` backtick subprocesses where the env var isn't exported). Probed
 *      across all `breadcrumbCandidates()` because the hook and the skill
 *      subprocess can disagree on TMPDIR.
 *   4. `<projectRoot>/.shipyard` symlink (created by the CLI via
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
export function breadcrumbName(projectHash, opts = {}) {
  const tag = currentBreadcrumbTag(opts);
  return tag
    ? `shipyard-${projectHash}-${tag}.plugindata`
    : `shipyard-${projectHash}.plugindata`;
}

export function legacyBreadcrumbName(projectHash) {
  return `shipyard-${projectHash}.plugindata`;
}

export function breadcrumbCandidates(projectHash, opts = {}) {
  const name = breadcrumbName(projectHash, opts);
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
 * repointed) by `shipyard-data link-data-dir`, so an
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
    const thisInstall = configPluginsDirFromSelf();
    const targetInstall = configPluginsDirFromPluginData(dirname(dirname(target)));
    if (thisInstall && targetInstall && thisInstall !== targetInstall) return null;
    return target;
  } catch {
    // Missing, dangling, or unreadable — caller falls through.
    return null;
  }
}

/**
 * Was this data dir created by `shipyard-data init` (vs. minted as a side
 * effect of a bookkeeping command)? `init` writes `.project-root` and copies
 * `templates/`; onboarding additionally writes `config.md`. A dir with none
 * of these is not a real project — the diagnostic-log writers in `_hook_lib`
 * mkdir the data dir recursively, so one appears for any repo whose files get
 * edited while Shipyard is installed.
 *
 * Single copy on purpose: `shipyard-data.mjs` imports this rather than keeping
 * its own, because duplicated resolver helpers have drifted here before.
 */
export function dirLooksInitialized(dir) {
  return (
    existsSync(join(dir, ".project-root")) ||
    existsSync(join(dir, "config.md")) ||
    existsSync(join(dir, "templates"))
  );
}

/**
 * Create or repoint `<projectRoot>/.shipyard` -> dataDir, idempotently.
 *
 * (See dirLooksInitialized below for the init-marker predicate this uses.)
 *
 * The single symlink-writer, shared by two callers:
 *   - `shipyard-data link-data-dir` (the explicit CLI) — layers --force /
 *     refuse-on-real-entry semantics on top, for an operator who ran it.
 *   - the `plugin-data-breadcrumb` SessionStart hook — calls it best-effort so
 *     every session of an initialized project re-establishes the
 *     env/TMPDIR-independent fallback that `readDataDirLink` consumes, instead
 *     of relying on one-time setup. Closes the chicken-and-egg gap
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
 *   - 'uninitialized' — the data dir exists but was never `init`ed; no link
 *                   written (see dirLooksInitialized)
 * Throws only on unexpected fs errors; callers that must not fail wrap it.
 */
export function ensureDataDirLink(projectRoot, dataDir) {
  const linkPath = join(projectRoot, ".shipyard");
  const target = resolve(dataDir);
  const type = IS_WINDOWS ? "junction" : "dir";

  // A data dir's mere existence does NOT mean the project was initialized:
  // the diagnostic-log writers in _hook_lib mkdir it recursively, so simply
  // EDITING a file in any git repo with Shipyard installed mints one. Gating
  // the link on existsSync(dataDir) therefore planted a stray `.shipyard`
  // symlink in repos that never completed onboarding (observed
  // 2026-07-28). Require a real init marker instead.
  if (!dirLooksInitialized(dataDir)) return { status: "uninitialized", linkPath };

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

  // 2. If env is absent, derive the plugin data root from this resolver's own
  //    installed cache path. This is install-scoped, unlike the historical
  //    breadcrumb and .shipyard fallbacks, and prevents personal/work installs
  //    from racing over the same project hash.
  if (!pluginData) pluginData = deriveDataRootFromSelf();

  // 3. Read breadcrumb written by SessionStart hook.
  //    Claude Code exports CLAUDE_PLUGIN_DATA to hook subprocesses but NOT
  //    consistently to skill `!` backtick subprocesses (varies by version).
  //    The plugin-data-breadcrumb SessionStart hook writes the value to
  //    an install-tagged shipyard-<hash>-<tag>.plugindata in each candidate tmp dir so that
  //    backtick-spawned resolver calls can find it even when the hook and the
  //    skill subprocess disagree on TMPDIR. Per-project (keyed by project
  //    hash) and per-install (keyed by config-root tag); survives skill
  //    invocations within a session; mode 0600.
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

  // 4. `<projectRoot>/.shipyard` symlink fallback. Env/TMPDIR-independent —
  //    needs only the git-based project root, so it survives the case where a
  //    valid breadcrumb was stranded in a tmp dir the reader can't see. The
  //    target is already the full data dir (`…/projects/<hash>`), validated by
  //    readDataDirLink against the freshly-computed hash, so return it as-is.
  if (!pluginData) {
    const viaLink = readDataDirLink(projectRoot, projectHash);
    if (viaLink) return viaLink;
  }

  // 5. Fail loud if nothing resolved.
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

  // 6. Normalize to the plugin-scoped level before appending projects/<hash>.
  //    Applied HERE (once, at the single join site) rather than at each of the
  //    four discovery steps, so env / self-derived / breadcrumb / link can
  //    never disagree about which level they produced. Steps 2 and 4 already
  //    yield scoped paths and are returned unchanged by rule 1 / the early
  //    return; only a hand-exported shared root is rewritten. See
  //    scopePluginDataRoot for the discriminator and the incident behind it.
  return join(scopePluginDataRoot(pluginData), "projects", projectHash);
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
