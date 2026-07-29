/**
 * readiness-check — deterministic start-of-sprint readiness predicate for
 * /ship-execute's `readiness` stage, plus a path classifier for the
 * wave-boundary "unexpected files" check.
 *
 * WHY THIS IS A CLI AND NOT SKILL PROSE
 *
 * /ship-execute's shell runs on Sonnet under an explicit zero-thinking
 * doctrine (ship-execute/SKILL.md Operating Principles): it executes a
 * checklist and escalates every judgment call. But its readiness stage used
 * to hand that shell four raw conditions and ask it to decide whether each
 * warranted interrupting the user — which is judgment, and which produced
 * an interrupt on nearly every sprint start, including cases with exactly
 * one sensible answer (a leftover `shipyard/wt-*` checkout offered a single
 * option: switch).
 *
 * The fix follows the same absorption pattern as cursor-cli and
 * verify-wave-integrated: compute the decision deterministically here and
 * hand the shell a verdict it can act on without reasoning. `must_ask` is
 * the whole interface — false means proceed and inform, true means the
 * combination is genuinely ambiguous and `ask_reasons` says why.
 *
 * WHAT IS DELIBERATELY *NOT* DERIVED HERE
 *
 * A failing baseline test suite stays a user question. The tempting
 * derivation — "do the failing tests overlap the paths this sprint touches?"
 * — is not computable: task files carry no `paths:` field (see
 * project-files/templates/task.md), and inventing one would mean a
 * plan-time guess at which files a task will touch. Whether a red baseline
 * is tolerable is a judgment about the user's own repo, which is exactly
 * what AskUserQuestion is for. Baseline state is reported here as a
 * pass-through input, never adjudicated.
 *
 * Exit codes: 0 always (this is a predicate, not a gate). Callers branch on
 * the JSON, so a non-zero exit would be indistinguishable from a git failure.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Run git, returning trimmed stdout, or null when the command fails. */
function git(projectRoot, args) {
  try {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/** Generated-but-tracked files whose churn is routine, not a source change. */
const GENERATED_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "gradle.lockfile",
  "uv.lock",
]);

const JUNK_BASENAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

const BUILD_DIR_RE = /(^|\/)(dist|build|out|target|node_modules|\.next|\.nuxt|__pycache__|\.gradle)(\/|$)/;

/**
 * Bucket paths into ignored / generated / source. `artifact_only` is true
 * when nothing in the list is a source file — the signal that a caller can
 * clean or commit without asking.
 */
export function classifyPaths(projectRoot, paths) {
  const ignored = [];
  const generated = [];
  const source = [];
  for (const p of paths) {
    const base = p.split("/").pop();
    if (git(projectRoot, ["check-ignore", "-q", "--", p]) !== null) {
      ignored.push(p);
    } else if (JUNK_BASENAMES.has(base) || BUILD_DIR_RE.test(p)) {
      ignored.push(p);
    } else if (GENERATED_BASENAMES.has(base)) {
      generated.push(p);
    } else {
      source.push(p);
    }
  }
  return { ignored, generated, source, artifact_only: source.length === 0 };
}

/** Parse `git status --porcelain` into tracked/untracked path lists. */
function readDirty(projectRoot) {
  const out = git(projectRoot, ["status", "--porcelain"]);
  const tracked = [];
  const untracked = [];
  if (!out) return { tracked, untracked, paths: [], clean: true };
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    // Porcelain v1 renames render as `R  old -> new`; the new path is what matters.
    const raw = line.slice(3);
    const path = raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
    const clean = path.replace(/^"|"$/g, "");
    (code === "??" ? untracked : tracked).push(clean);
  }
  return { tracked, untracked, paths: [...tracked, ...untracked], clean: false };
}

/** Read SPRINT.md's `branch:` frontmatter value, or null. */
function sprintBranch(dataDir) {
  const p = join(dataDir, "sprints", "current", "SPRINT.md");
  if (!existsSync(p)) return null;
  const m = readFileSync(p, "utf8").match(/^branch:\s*(.+)$/m);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "") || null;
}

/**
 * The readiness verdict.
 *
 * The decision table, and why each row lands where it does:
 *
 *   tree clean + branch matches          -> proceed (nothing to decide)
 *   on shipyard/wt-* + switch is safe    -> proceed, switch  (only one sane
 *                                           answer; a wt-* branch is never a
 *                                           valid base for a new sprint)
 *   branch mismatch + tree clean + target
 *     exists                             -> proceed, switch  (SPRINT.md IS the
 *                                           record of the sprint's branch, and
 *                                           switching a clean tree is a
 *                                           two-way door)
 *   tree dirty + branch matches          -> proceed, wip commit (uncommitted
 *                                           work is invisible to worktree
 *                                           agents no matter what it contains;
 *                                           `git reset --soft HEAD~1` undoes it)
 *   tree dirty + branch mismatch         -> ASK (committing lands the wip on
 *                                           the wrong branch, so the two safe
 *                                           actions conflict — genuinely
 *                                           ambiguous)
 *   target branch missing                -> ASK (nothing to switch to)
 *   baseline failing                     -> ASK (never derived; see header)
 */
export function readinessCheck(projectRoot, dataDir, opts = {}) {
  const currentBranch = git(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
  const targetBranch = opts.targetBranch ?? sprintBranch(dataDir);
  const dirty = readDirty(projectRoot);
  const onWtBranch = /^shipyard\/wt-/.test(currentBranch);
  const branchMatches = targetBranch != null && currentBranch === targetBranch;
  const targetExists =
    targetBranch != null &&
    git(projectRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${targetBranch}`]) !== null;
  const needsSwitch = targetBranch != null && !branchMatches;

  const dirtyClass = dirty.clean ? null : classifyPaths(projectRoot, dirty.paths);

  const actions = [];
  const askReasons = [];

  if (needsSwitch) {
    if (!targetExists) {
      askReasons.push({
        code: "target_branch_missing",
        detail: `SPRINT.md names branch "${targetBranch}" but no such local branch exists.`,
      });
    } else if (!dirty.clean) {
      askReasons.push({
        code: "dirty_and_branch_mismatch",
        detail:
          `Working tree has ${dirty.paths.length} uncommitted path(s) and HEAD is "${currentBranch}", ` +
          `not SPRINT.md's "${targetBranch}". Committing would land the work on the wrong branch; ` +
          `switching would carry it across. Both safe actions conflict.`,
      });
    } else {
      actions.push({
        code: "switch_branch",
        detail: `Switch ${currentBranch} -> ${targetBranch}` + (onWtBranch ? " (leftover worktree branch)" : ""),
        command: `git checkout ${targetBranch}`,
      });
    }
  }

  if (!dirty.clean && !askReasons.some((r) => r.code === "dirty_and_branch_mismatch")) {
    actions.push({
      code: "commit_dirty",
      detail:
        `Commit ${dirty.paths.length} uncommitted path(s) as 'wip: pre-sprint' — worktree agents ` +
        `start from the last commit, so uncommitted work would not reach them. Undo: git reset --soft HEAD~1`,
      command: "git add -A && git commit -m 'wip: pre-sprint'",
    });
  }

  if (opts.baselineFailing) {
    askReasons.push({
      code: "baseline_failing",
      detail:
        "Baseline tests are failing. Whether a red baseline is tolerable is a judgment about this repo " +
        "(known-flaky vs real regression) and is never derived — see readiness-check.mjs header.",
    });
  }

  return {
    current_branch: currentBranch,
    target_branch: targetBranch,
    on_wt_branch: onWtBranch,
    branch_matches: branchMatches,
    target_branch_exists: targetExists,
    tree_clean: dirty.clean,
    dirty: dirty.clean
      ? null
      : {
          tracked: dirty.tracked.length,
          untracked: dirty.untracked.length,
          paths: dirty.paths,
          artifact_only: dirtyClass.artifact_only,
        },
    actions,
    must_ask: askReasons.length > 0,
    ask_reasons: askReasons,
  };
}

/**
 * `shipyard-data readiness-check [--target-branch <b>] [--baseline-failing]`
 * `shipyard-data readiness-check --classify <path> [<path> ...]`
 *
 * Always prints one JSON line and exits 0.
 */
export function readinessCheckCmd(projectRoot, dataDir, argv) {
  const classifyIdx = argv.indexOf("--classify");
  if (classifyIdx !== -1) {
    const paths = argv.slice(classifyIdx + 1).filter((a) => !a.startsWith("--"));
    process.stdout.write(JSON.stringify(classifyPaths(projectRoot, paths)) + "\n");
    return;
  }
  const tbIdx = argv.indexOf("--target-branch");
  const result = readinessCheck(projectRoot, dataDir, {
    targetBranch: tbIdx !== -1 ? argv[tbIdx + 1] : undefined,
    baselineFailing: argv.includes("--baseline-failing"),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
}
