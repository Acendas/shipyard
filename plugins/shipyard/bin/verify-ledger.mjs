/**
 * verify-ledger — content-addressed verification-evidence ledger backing
 * `shipyard-data verify record|check`.
 *
 * Problem (Shipyard perf plan P1, issues 1.1/1.2/5.1/5.2): a single feature
 * iteration re-runs the full test suite 9-20 times because execute, review's
 * Stage 1a, quality-gate checks, and the release gate each independently
 * re-verify the same commit. This module is the shared evidence store that
 * lets a caller ask "has this exact command already passed against this
 * exact tree, recently, with nothing dirty in between?" instead of
 * re-running it.
 *
 * State: `<SHIPYARD_DATA>/sprints/current/.verification-ledger.json` — a
 * flat `{ [key]: entry }` map. CLI-owned (see CLI_OWNED_BASENAMES in
 * bin/hooks/auto-approve-data.mjs) — the model must not hand-author it.
 * Deliberately NOT the event log: the event log's 5000-line rotation makes
 * it unsafe as a lookup surface for "is THIS specific proof still there,"
 * though `verify record`/`verify check` still emit audit events
 * (`verification_recorded` / `verification_reused`) alongside the ledger
 * write, mirroring every other CLI-owned state file in this codebase.
 *
 * Freshness keys on content, not commit sha (D3) — wave rebases rewrite
 * SHAs but preserve the tree when nothing actually changed:
 *
 *   1. `git rev-parse HEAD^{tree}` equal at record and check time.
 *   2. sha256(resolved command) equal (only checked when the caller
 *      supplies a `command` to compare against — see evaluateFreshness).
 *   3. recorded exit code === 0.
 *   4. `git status --porcelain` empty at BOTH record time (enforced by
 *      refusing to record otherwise) AND check time.
 *   5. within TTL (default 24h; 0 disables reuse — always stale).
 *   6. the capture file still exists and its size + sha256 match what was
 *      recorded.
 *
 * Fail-safe direction is absolute: ANY condition that cannot be evaluated
 * (git failure, unparseable ledger, missing field, missing capture file,
 * unresolvable project root) resolves to `fresh: false`. There is no flag
 * anywhere in this module or its CLI surface that forces a "fresh" verdict
 * — `record`'s only override-shaped option is refusing to write (a would-be
 * skip is never a supported path), and `check` has no force flag at all.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { atomicWrite, logEvent, withLockfile } from "./_hook_lib.mjs";
import { getProjectRoot } from "./shipyard-resolver.mjs";

export const LEDGER_BASENAME = ".verification-ledger.json";

// Canonical ledger key for the sprint-level full-suite proof consumed by
// terminal-gate.mjs's evaluateReviewTerminal (release-approval gate).
// `ship-execute` / `ship-review` skill wiring records under this exact key
// after a clean full-suite run: `shipyard-data verify record --key
// sprint_full_tests --command "<full-suite-cmd>" --exit 0 --capture <path>`.
export const FULL_SUITE_KEY = "sprint_full_tests";

const DEFAULT_TTL_HOURS = 24;

function ledgerPath(dataDir) {
  return join(dataDir, "sprints", "current", LEDGER_BASENAME);
}

/**
 * Resolve the project root git operations should run against. Prefers the
 * `.project-root` breadcrumb `shipyard-data init` writes into the data dir
 * (env/cwd-independent — works the same whether this runs from the hook
 * chain, a skill `!` subprocess, or a builder worktree) and falls back to
 * the resolver's cwd-based `getProjectRoot()`. Returns null, never throws,
 * when neither resolves — callers treat null as an unevaluable condition.
 */
function resolveProjectRootForVerify(dataDir) {
  const marker = join(dataDir, ".project-root");
  if (existsSync(marker)) {
    try {
      const p = readFileSync(marker, "utf8").trim();
      if (p) return p;
    } catch {
      /* fall through to resolver */
    }
  }
  try {
    return getProjectRoot();
  } catch {
    return null;
  }
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function sha256File(path) {
  try {
    const buf = readFileSync(path);
    return { size: buf.length, hash: sha256(buf) };
  } catch {
    return null;
  }
}

/** `git rev-parse HEAD^{tree}` — null (unevaluable) on any failure. */
function gitTreeId(cwd) {
  if (!cwd) return null;
  try {
    return execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    }).trim();
  } catch {
    return null;
  }
}

/** `git status --porcelain` is empty. Returns null (unevaluable) on failure — never true/false by assumption. */
function gitPorcelainClean(cwd) {
  if (!cwd) return null;
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
    });
    return out.trim() === "";
  } catch {
    return null;
  }
}

function readLedgerSafe(dataDir) {
  const p = ledgerPath(dataDir);
  if (!existsSync(p)) return { ledger: {}, parseError: false };
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return { ledger: null, parseError: true };
  }
  try {
    const obj = JSON.parse(raw);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return { ledger: null, parseError: true };
    }
    return { ledger: obj, parseError: false };
  } catch {
    return { ledger: null, parseError: true };
  }
}

/**
 * Evaluate whether the recorded entry for `key` is still fresh. Pure
 * read-only computation — never writes, never exits the process.
 *
 * `command`, when supplied, is sha256-hashed and compared against the
 * hash recorded at `record` time (predicate 2 above) — this is what
 * `verify check` uses to decide whether a specific command may be
 * skipped. Callers that only want to know "does ANY fresh proof exist for
 * this key" (e.g. the release-approval terminal gate, which has no single
 * command string to compare against) omit `command` and every other
 * predicate still applies.
 *
 * Returns `{ fresh: true, entry }` or `{ fresh: false, reason }`.
 */
export function evaluateFreshness(dataDir, opts = {}) {
  const { key, command, ttlHours = DEFAULT_TTL_HOURS } = opts;
  if (!key) return { fresh: false, reason: "no key given" };

  const { ledger, parseError } = readLedgerSafe(dataDir);
  if (parseError) {
    return { fresh: false, reason: "ledger file exists but is not parseable JSON" };
  }
  const entry = ledger[key];
  if (!entry || typeof entry !== "object") {
    return { fresh: false, reason: `no recorded verification for key=${key}` };
  }
  if (!entry.treeId || !entry.commandHash || entry.exitCode === undefined || !entry.recordedAt) {
    return { fresh: false, reason: `ledger entry for key=${key} is missing required fields` };
  }

  const projectRoot = resolveProjectRootForVerify(dataDir);
  if (!projectRoot) {
    return { fresh: false, reason: "cannot resolve project root — unevaluable" };
  }

  const treeId = gitTreeId(projectRoot);
  if (treeId === null) {
    return { fresh: false, reason: "git rev-parse HEAD^{tree} failed — unevaluable" };
  }
  if (treeId !== entry.treeId) {
    return {
      fresh: false,
      reason: `working tree changed since recording (recorded ${entry.treeId.slice(0, 12)}, now ${treeId.slice(0, 12)})`,
    };
  }

  if (command !== undefined) {
    if (sha256(command) !== entry.commandHash) {
      return { fresh: false, reason: "command changed since recording" };
    }
  }

  if (entry.exitCode !== 0) {
    return { fresh: false, reason: `recorded exit code was ${entry.exitCode}, not 0` };
  }

  const clean = gitPorcelainClean(projectRoot);
  if (clean === null) {
    return { fresh: false, reason: "git status --porcelain failed — unevaluable" };
  }
  if (!clean) {
    return { fresh: false, reason: "working tree is dirty right now" };
  }
  if (entry.porcelainClean !== true) {
    // Belt-and-braces: record() below refuses to write a dirty-at-record
    // entry at all, so this should never trigger against an entry this
    // module wrote — guards against a hand-authored or corrupted ledger.
    return { fresh: false, reason: "recorded entry was not clean-tree-verified at record time" };
  }

  if (ttlHours === 0) {
    return { fresh: false, reason: "TTL disabled (0) — always stale" };
  }
  const recordedAtMs = Date.parse(entry.recordedAt);
  if (!Number.isFinite(recordedAtMs)) {
    return { fresh: false, reason: "recorded timestamp is unparseable" };
  }
  const ttlMs = ttlHours * 3600000;
  const ageMs = Date.now() - recordedAtMs;
  if (ageMs > ttlMs) {
    return {
      fresh: false,
      reason: `TTL expired (recorded ${Math.round(ageMs / 60000)}m ago, limit ${Math.round(ttlMs / 60000)}m)`,
    };
  }

  if (!entry.capturePath) {
    return { fresh: false, reason: "no capture path recorded" };
  }
  const captureInfo = sha256File(entry.capturePath);
  if (!captureInfo) {
    return { fresh: false, reason: `capture file missing or unreadable: ${entry.capturePath}` };
  }
  if (captureInfo.size !== entry.captureSize || captureInfo.hash !== entry.captureHash) {
    return { fresh: false, reason: "capture file content changed since recording" };
  }

  return { fresh: true, reason: null, entry };
}

/**
 * Record a verification result. The CLI computes tree-id and porcelain
 * state itself — callers cannot pass either in, so the model cannot
 * fabricate a clean-tree claim.
 *
 * Refuses (never writes anything) unless the working tree is clean AT
 * RECORD TIME: a dirty-tree recording would let a later, unrelated
 * clean-tree check falsely reuse it as proof nothing changed (D3's "dirty
 * tree at record => never recorded" rule).
 */
export function recordVerification(dataDir, { key, command, exitCode, capturePath } = {}) {
  if (!key || command === undefined || exitCode === undefined || !capturePath) {
    return {
      ok: false,
      code: 2,
      message: "usage: verify record --key <k> --command <literal> --exit <n> --capture <path>",
    };
  }
  const parsedExit = parseInt(exitCode, 10);
  if (!Number.isInteger(parsedExit)) {
    return { ok: false, code: 2, message: `verify record: --exit must be an integer (got ${exitCode})` };
  }

  const projectRoot = resolveProjectRootForVerify(dataDir);
  if (!projectRoot) {
    return { ok: false, code: 3, message: "verify record: cannot resolve project root — refusing to record" };
  }
  const treeId = gitTreeId(projectRoot);
  if (treeId === null) {
    return { ok: false, code: 3, message: "verify record: git rev-parse HEAD^{tree} failed — refusing to record" };
  }
  const clean = gitPorcelainClean(projectRoot);
  if (clean === null) {
    return { ok: false, code: 3, message: "verify record: git status --porcelain failed — refusing to record" };
  }
  if (!clean) {
    return {
      ok: false,
      code: 3,
      message:
        "verify record: working tree is dirty — refusing to record " +
        "(a dirty-tree recording could later be falsely reused as proof of a clean pass)",
    };
  }
  const capturePathAbs = pathResolve(capturePath);
  const captureInfo = sha256File(capturePathAbs);
  if (!captureInfo) {
    return { ok: false, code: 3, message: `verify record: capture file missing or unreadable: ${capturePathAbs}` };
  }

  const entry = {
    key,
    commandHash: sha256(command),
    treeId,
    exitCode: parsedExit,
    porcelainClean: true,
    capturePath: capturePathAbs,
    captureSize: captureInfo.size,
    captureHash: captureInfo.hash,
    recordedAt: new Date().toISOString(),
  };

  const lPath = ledgerPath(dataDir);
  withLockfile(lPath + ".lock", () => {
    const { ledger, parseError } = readLedgerSafe(dataDir);
    const base = parseError || !ledger ? {} : ledger;
    base[key] = entry;
    atomicWrite(lPath, JSON.stringify(base, null, 2) + "\n");
  });

  try {
    logEvent(dataDir, "verification_recorded", { key, exit: parsedExit, tree: treeId.slice(0, 12) });
  } catch {
    /* best-effort */
  }

  return { ok: true, code: 0, message: `recorded key=${key} exit=${parsedExit} tree=${treeId.slice(0, 12)}` };
}

/**
 * `verify check` — is there fresh, reusable evidence for this exact
 * command? Exit 0 (fresh) means the caller may skip re-running it and an
 * audit event (`verification_reused`) is emitted; exit 3 (stale) means run
 * it. No flag on this path forces a fresh verdict — only
 * evaluateFreshness's predicate decides, and every unevaluable branch
 * resolves to stale.
 */
export function checkVerification(dataDir, { key, command, ttlHours } = {}) {
  if (!key || command === undefined) {
    return { ok: false, code: 2, message: "usage: verify check --key <k> --command <literal> [--ttl-hours <n>]" };
  }
  const result = evaluateFreshness(dataDir, { key, command, ttlHours });
  if (!result.fresh) {
    return { ok: false, code: 3, message: `STALE — ${result.reason}` };
  }
  try {
    logEvent(dataDir, "verification_reused", { key, tree: result.entry.treeId.slice(0, 12) });
  } catch {
    /* best-effort */
  }
  return { ok: true, code: 0, message: `FRESH — key=${key} recorded ${result.entry.recordedAt}` };
}

/**
 * CLI dispatch, called from shipyard-data.mjs's main() as `case "verify":`.
 *
 *   shipyard-data verify record --key <k> --command <literal> --exit <n> --capture <path>
 *   shipyard-data verify check --key <k> --command <literal> [--ttl-hours <n>]
 */
export function verifyCmd(dataDir, args) {
  const sub = args[0];
  const rest = args.slice(1);
  const getFlag = (name) => {
    const idx = rest.indexOf(name);
    return idx !== -1 ? rest[idx + 1] : undefined;
  };

  if (sub === "record") {
    const result = recordVerification(dataDir, {
      key: getFlag("--key"),
      command: getFlag("--command"),
      exitCode: getFlag("--exit"),
      capturePath: getFlag("--capture"),
    });
    process.stderr.write(result.message + "\n");
    process.exit(result.code);
  }

  if (sub === "check") {
    const ttlRaw = getFlag("--ttl-hours");
    const ttlHours = ttlRaw !== undefined ? parseFloat(ttlRaw) : undefined;
    const result = checkVerification(dataDir, {
      key: getFlag("--key"),
      command: getFlag("--command"),
      ttlHours,
    });
    process.stderr.write(result.message + "\n");
    process.exit(result.code);
  }

  process.stderr.write(
    `shipyard-data verify: unknown subcommand "${sub ?? ""}". Expected: ` +
      `record --key <k> --command <literal> --exit <n> --capture <path> | ` +
      `check --key <k> --command <literal> [--ttl-hours <n>]\n`,
  );
  process.exit(2);
}
