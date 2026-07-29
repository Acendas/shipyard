/**
 * worktree-warm — best-effort pre-population of a freshly created builder
 * worktree with gitignored, regenerable BUILD ARTIFACT directories from the
 * parent checkout (Shipyard perf plan P4, fixes 2.1/2.2/2.3).
 *
 * Problem: `git worktree add` copies only tracked files. Every builder
 * subagent therefore starts a cold build — no `.gradle`/`build`/`target`
 * caches, no compiled output — even though the parent checkout already has
 * all of that on disk. Measured on the customer workspace: ~3.6 GB of
 * gitignored build state, absent from all 410 builder worktrees.
 *
 * The classification rule (load-bearing, not the path list):
 *
 *   Artifact/cache dir   — regenerable output, no absolute paths baked in,
 *                          no relative symlinks resolving outside the dir.
 *                          Deleting it costs time, never correctness.
 *                          SAFE to warm via clone/copy.
 *   Dependency-resolution — encodes WHERE THE SOURCE TREE IS, via relative
 *   dir                    symlinks (npm/pnpm workspaces) or absolute paths
 *                          baked in at install time (Python editable
 *                          installs). UNSAFE — refused by name, in code,
 *                          unconditionally (config cannot override this).
 *
 * Both halves are probe-established (see the performance-plan doc under
 * `.claude/plans/`), not assumed: a probe found a symlinked `node_modules`
 * resolves to the PARENT's source (a test edit in the worktree was
 * invisible to a test run that printed `RESULT: PARENT`) and a `.venv`
 * with a `pip install -e .` editable install stays pointed at the parent
 * even under a full copy, because `__editable__*.pth` bakes in an absolute
 * path copying cannot fix. A false-green here silently ships unverified
 * code, so the refusal list is enforced structurally, not left to config
 * hygiene.
 *
 * Modes: `clone` (copy-on-write where the platform supports it — macOS
 * `cp -c`, Linux `cp --reflink=auto`; falls back to a full copy wherever
 * CoW isn't available, including Windows, where a true ReFS block-clone
 * needs a Win32 `DeviceIoControl(FSCTL_DUPLICATE_EXTENTS_TO_FILE)` call
 * unreachable from plain Node without a native addon) and `copy` (a full
 * copy, always). There is deliberately NO `link` mode — a shared/symlinked
 * artifact dir reintroduces exactly the false-green risk the refusal list
 * exists to prevent, just one directory class removed from the ones that
 * are refused outright.
 *
 * Gates (ALL must hold per path, independently): `worktree_warm.enabled`
 * in config.md ∧ the path exists under the source root ∧ the path is
 * gitignored (`git check-ignore`) — a tracked dir is NEVER warmed, because
 * `git worktree add` already gives the worktree its own correct copy of
 * tracked content and overwriting it here would be a correctness bug, not
 * an optimization. Default is `enabled: false`, so this whole module is
 * inert (a config read that returns immediately) until a project opts in.
 *
 * Failure is loud but NEVER blocking: every per-path failure is logged
 * (`worktree_warm_failed path= reason=`) and the loop moves on; the
 * function never throws in a way that should stop worktree creation, and
 * writes nothing to stdout (the WorktreeCreate hook has a hard stdout
 * contract — see bin/hooks/worktree-branch.mjs — all warm diagnostics here
 * go to stderr).
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative as pathRelative } from "node:path";
import { logEvent } from "./_hook_lib.mjs";
import { getDataDir } from "./shipyard-resolver.mjs";

// Enforced by name, in code — never overridable via config. A single path
// SEGMENT matching one of these anywhere in a configured relative path
// refuses the whole entry (catches both a bare `node_modules` and a
// nested `packages/foo/node_modules`).
export const REFUSED_BASENAMES = Object.freeze(
  new Set(["node_modules", ".venv", "venv", "env", ".tox"]),
);
// Refused as an exact relative-path match (the segment-basename rule alone
// would refuse innocuous directories literally named "bundle").
export const REFUSED_RELATIVE_PATHS = Object.freeze(new Set(["vendor/bundle"]));

const REFUSAL_RATIONALE =
  "probe-confirmed false-green risk: a shared/symlinked dependency-resolution dir makes a " +
  "worktree's tests silently exercise the PARENT repo's source, or (Python editable installs) " +
  "keeps an absolute path pointed at the parent that copying cannot fix";

function warn(msg) {
  process.stderr.write(`worktree-warm: ${msg}\n`);
}

function normalizeRelPath(p) {
  return String(p).replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
}

/** True iff `relPath` (or any path segment within it) matches the refusal list. */
export function isRefused(relPath) {
  const norm = normalizeRelPath(relPath);
  if (!norm) return false;
  if (REFUSED_RELATIVE_PATHS.has(norm)) return true;
  return norm.split("/").some((seg) => REFUSED_BASENAMES.has(seg));
}

/**
 * Read the `worktree_warm:` block from config.md. Lightweight, hand-rolled
 * nested-block parser (mirrors the `models:` block scan in
 * shipyard-data.mjs's configSetModel) — config.md's frontmatter is not
 * flat, so the flat parseFrontmatter helper in terminal-gate.mjs doesn't
 * apply here.
 *
 * Any read/parse failure, or the block being entirely absent (projects
 * initialized before this key existed), returns the safe default:
 * disabled, no paths. This is what makes the feature inert-by-default
 * without needing every existing project re-initialized.
 */
export function readWorktreeWarmConfig(dataDir) {
  const disabled = { enabled: false, paths: [], mode: "clone" };
  const configPath = join(dataDir, "config.md");
  if (!existsSync(configPath)) return disabled;
  let content;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    return disabled;
  }
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return disabled;
  const lines = fmMatch[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^worktree_warm:\s*$/.test(l));
  if (start === -1) return disabled;

  let enabled = false;
  let paths = [];
  let mode = "clone";
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break; // left the block (next top-level key)
    const enabledMatch = lines[i].match(/^\s+enabled:\s*(\S+)/);
    if (enabledMatch) {
      enabled = enabledMatch[1].toLowerCase() === "true";
      continue;
    }
    const modeMatch = lines[i].match(/^\s+mode:\s*["']?(\w+)["']?/);
    if (modeMatch && (modeMatch[1] === "clone" || modeMatch[1] === "copy")) {
      mode = modeMatch[1];
      continue;
    }
    const pathsMatch = lines[i].match(/^\s+paths:\s*\[([^\]]*)\]/);
    if (pathsMatch) {
      paths = pathsMatch[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
      continue;
    }
  }
  return { enabled, paths, mode };
}

function isGitIgnored(relPath, cwd) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", relPath], { cwd, stdio: "ignore", timeout: 10000 });
    return true; // exit 0 = ignored
  } catch {
    // exit 1 = tracked/not-ignored, exit >1 = error (e.g. not a repo) —
    // either way, the safe default is "not ignored", which refuses the warm.
    return false;
  }
}

/** Recursive, best-effort directory-size walker for the reported byte count. Never throws. */
function duSync(p) {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink() || st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let entries = [];
  try {
    entries = readdirSync(p);
  } catch {
    return 0;
  }
  let total = 0;
  for (const e of entries) total += duSync(join(p, e));
  return total;
}

/**
 * Copy `src` -> `dest` (dest's parent is created if missing). Returns the
 * mode actually used ("clone" or "copy") — a requested "clone" silently
 * degrades to "copy" wherever CoW isn't available, which is expected and
 * not an error.
 */
function performCopy(src, dest, requestedMode) {
  mkdirSync(dirname(dest), { recursive: true });

  if (requestedMode === "clone") {
    if (process.platform === "darwin") {
      try {
        execFileSync("cp", ["-R", "-c", src, dest], { stdio: "ignore", timeout: 300000 });
        return "clone";
      } catch {
        /* fall through to plain copy below */
      }
    } else if (process.platform === "linux") {
      try {
        // --reflink=auto transparently degrades to a full copy on
        // filesystems without CoW support — no separate fallback needed.
        execFileSync("cp", ["-R", "--reflink=auto", src, dest], { stdio: "ignore", timeout: 300000 });
        return "clone";
      } catch {
        /* fall through to plain copy below */
      }
    }
    // Windows (and any other platform): no dependency-free CoW primitive
    // is reachable from Node — degrade to a full copy below. Still
    // correct (never a symlink), just not copy-on-write.
  }

  cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
  return "copy";
}

/**
 * Core mechanism: warm the given list of paths (relative to `sourceRoot`)
 * into `worktreePath`. Pure — takes the path list and mode directly rather
 * than reading config, so it's independently testable from config parsing.
 *
 * Never throws. Every failure for a given path is caught, logged (stderr +
 * best-effort event), and treated as a non-fatal skip so worktree creation
 * is never put at risk by this optimization.
 */
export function warmWorktree({ sourceRoot, worktreePath, paths, mode = "clone", dataDir } = {}) {
  const warmed = [];
  const modesUsed = new Set();
  let totalBytes = 0;

  if (!sourceRoot || !worktreePath || !Array.isArray(paths) || paths.length === 0) {
    return { warmed, bytes: 0, modes: [] };
  }

  for (const rawRelPath of paths) {
    const relPath = normalizeRelPath(rawRelPath);
    if (!relPath) continue;

    try {
      if (isRefused(relPath)) {
        warn(`refusing to warm "${relPath}" — matches the dependency-resolution refusal list (${REFUSAL_RATIONALE})`);
        if (dataDir) {
          try {
            logEvent(dataDir, "worktree_warm_failed", { path: relPath, reason: "refused_dependency_resolution_dir" });
          } catch { /* best-effort */ }
        }
        continue;
      }

      const srcPath = join(sourceRoot, relPath);
      if (!existsSync(srcPath)) {
        // Loud no-op — most projects won't have every configured path
        // (e.g. a fresh checkout with no build/ yet). Not a failure.
        warn(`source missing, skipping: ${relPath}`);
        continue;
      }

      // Defense in depth: the configured path must resolve inside
      // sourceRoot (rejects a hostile ../../etc entry) and the
      // destination must resolve inside worktreePath.
      const relCheck = pathRelative(sourceRoot, srcPath);
      if (!relCheck || relCheck.startsWith("..") || isAbsolute(relCheck)) {
        warn(`refusing "${relPath}" — escapes source root`);
        continue;
      }

      if (!isGitIgnored(relPath, sourceRoot)) {
        warn(`refusing to warm "${relPath}" — not gitignored (never warm a tracked dir)`);
        if (dataDir) {
          try {
            logEvent(dataDir, "worktree_warm_failed", { path: relPath, reason: "not_gitignored" });
          } catch { /* best-effort */ }
        }
        continue;
      }

      const destPath = join(worktreePath, relPath);
      const destRelCheck = pathRelative(worktreePath, destPath);
      if (!destRelCheck || destRelCheck.startsWith("..") || isAbsolute(destRelCheck)) {
        warn(`refusing "${relPath}" — destination escapes worktree`);
        continue;
      }

      const usedMode = performCopy(srcPath, destPath, mode);
      const bytes = duSync(destPath);
      totalBytes += bytes;
      modesUsed.add(usedMode);
      warmed.push(relPath);
      warn(`warmed "${relPath}" (${usedMode}, ${bytes} bytes)`);
    } catch (err) {
      warn(`failed to warm "${relPath}": ${err?.message ?? err}`);
      if (dataDir) {
        try {
          logEvent(dataDir, "worktree_warm_failed", { path: relPath, reason: String(err?.message ?? err).slice(0, 200) });
        } catch { /* best-effort */ }
      }
    }
  }

  if (warmed.length > 0 && dataDir) {
    try {
      logEvent(dataDir, "worktree_warmed", {
        mode: [...modesUsed].join(","),
        paths: warmed.join(","),
        bytes: totalBytes,
      });
    } catch { /* best-effort */ }
  }

  return { warmed, bytes: totalBytes, modes: [...modesUsed] };
}

/**
 * Glue: resolve config for `sourceRoot`'s Shipyard project and, if
 * enabled, warm the configured paths into `worktreePath`. This is what the
 * WorktreeCreate hook calls. Never throws — any failure to even resolve
 * config degrades to a silent no-op (the hook must never fail worktree
 * creation over this).
 */
export function warmWorktreeFromConfig({ sourceRoot, worktreePath }) {
  let dataDir;
  try {
    dataDir = getDataDir({ projectRoot: sourceRoot, silent: true });
  } catch {
    return { warmed: [], bytes: 0, modes: [], skipped: "no_data_dir" };
  }
  if (!dataDir) return { warmed: [], bytes: 0, modes: [], skipped: "no_data_dir" };

  let cfg;
  try {
    cfg = readWorktreeWarmConfig(dataDir);
  } catch {
    return { warmed: [], bytes: 0, modes: [], skipped: "config_read_failed" };
  }
  if (!cfg.enabled || !cfg.paths || cfg.paths.length === 0) {
    return { warmed: [], bytes: 0, modes: [], skipped: "disabled" };
  }

  return warmWorktree({ sourceRoot, worktreePath, paths: cfg.paths, mode: cfg.mode, dataDir });
}
