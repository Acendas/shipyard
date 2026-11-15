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
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve as pathResolve, sep } from "node:path";
import { atomicWrite, logEvent, withLockfile } from "./_hook_lib.mjs";
import { getProjectRoot } from "./shipyard-resolver.mjs";
import { parseFrontmatterList } from "./frontmatter-list.mjs";

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

/**
 * `verify_ignore:` in config.md (4.0): paths, relative to the project's
 * folder, that cannot change a build or a test result (a changelog, a design
 * document). A commit that touches only these keeps a proof fresh. Empty by
 * default: every tracked file counts. Globs: `**`, `*`, a folder name.
 */
export function readVerifyIgnore(dataDir) {
  try {
    const m = readFileSync(join(dataDir, "config.md"), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
    return m ? parseFrontmatterList(m[1], "verify_ignore").items.map((s) => s.replace(/\\/g, "/").replace(/^\.\//, "")).filter(Boolean).sort() : [];
  } catch { return []; }
}
function ignoreRe(glob) {
  let g = glob;
  if (!/[*?]/.test(g) && !/\.[a-z0-9]+$/i.test(g)) g = g.replace(/\/$/, "") + "/**";
  const re = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0000").replace(/\*\*/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?").replace(/\u0001/g, ".*");
  try { return new RegExp(`^${re}$`); } catch { return null; }
}

/**
 * The identity of the code a proof is for (4.0): the project's own folder,
 * not the whole repository, minus the paths the project said cannot matter.
 * Before this a commit in a sibling project of the same repository, or a
 * one-line changelog commit, made every proof stale and the suite ran again.
 * Null (unevaluable) on any git failure.
 */
export function codeId(cwd, scope = "", ignore = []) {
  if (!cwd) return null;
  const sc = String(scope || "").replace(/\\/g, "/").replace(/\/$/, "");
  const run = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 20000, maxBuffer: 256 * 1024 * 1024 });
  try {
    if (!ignore.length) return run(["rev-parse", sc ? `HEAD:${sc}` : "HEAD^{tree}"]).trim();
    const res = ignore.map(ignoreRe).filter(Boolean);
    const kept = [];
    for (const line of run(["ls-tree", "-r", "-z", "HEAD", ...(sc ? ["--", sc] : [])]).split("\0")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      const path = line.slice(tab + 1);
      const rel = sc && path.startsWith(sc + "/") ? path.slice(sc.length + 1) : path;
      if (!res.some((re) => re.test(rel))) kept.push(line);
    }
    return "files:" + sha256(kept.join("\n"));
  } catch { return null; }
}

/** The ledger key a command's own proof lives under: any run of this exact command on this exact code. */
export function commandKey(command) {
  return `command:${sha256(String(command)).slice(0, 24)}`;
}

/**
 * Is the command being typed in the checkout the ledger is about? A builder
 * in its own worktree runs the same command on different code; its green run
 * must never be recorded as proof for the main checkout, and a proof from the
 * main checkout says nothing about the worktree.
 */
export function inLedgerCheckout(dataDir, cwd = process.cwd()) {
  const root = resolveProjectRootForVerify(dataDir);
  if (!root) return false;
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }).trim();
    return realpathSync(top) === realpathSync(root);
  } catch { return false; }
}

/**
 * The folder the project lives in, relative to the repository root ("" = the
 * whole repository). In a monorepo the project is one sub-folder and its
 * siblings are other projects, often untracked: a real project could never
 * record a proof because 29 unrelated folders made `git status` non-empty, so
 * every sprint review re-ran the full suite. The session's project directory
 * (CLAUDE_PROJECT_DIR, else the directory the command was typed in) names
 * the folder when it sits inside the repository root.
 */
export function projectScope(projectRoot, projectDir = null) {
  let root;
  try { root = realpathSync(projectRoot); } catch { return ""; }
  for (const cand of [projectDir, process.env.CLAUDE_PROJECT_DIR, process.cwd()]) {
    if (!cand) continue;
    let real;
    try { real = realpathSync(cand); } catch { continue; }
    if (real === root) return "";
    if (real.startsWith(root + sep)) return relative(root, real);
  }
  return "";
}

/**
 * `git status --porcelain` is empty, for the whole repository or for `scope`
 * (a path relative to the root). Returns null (unevaluable) on failure —
 * never true/false by assumption.
 */
function gitPorcelainClean(cwd, scope = "") {
  if (!cwd) return null;
  try {
    // TRACKED files only (4.13.1). Untracked files are handled by a
    // fingerprint (below): a proof holds for the committed tree plus exactly
    // the untracked files that were there, so a scratch folder a tool left in
    // the project no longer makes every proof impossible.
    const base = ["status", "--porcelain", "--untracked-files=no"];
    const out = execFileSync("git", scope ? [...base, "--", scope] : base, {
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

export const MAX_UNTRACKED_FILES = 5000;

/**
 * A fingerprint of the untracked (and not ignored) files under `scope`: every
 * path with its size and modification time. Two trees with the same HEAD and
 * the same fingerprint built and tested the same inputs. Returns
 * `{ hash, count }`, `{ tooMany: true, count }` past the cap, or null when
 * git cannot list them (unevaluable — never assumed clean).
 */
export function untrackedFingerprint(cwd, scope = "") {
  if (!cwd) return null;
  let out;
  try {
    out = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", ...(scope ? ["--", scope] : [])], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 20000, maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
  const files = out.split("\0").filter(Boolean).sort();
  if (files.length > MAX_UNTRACKED_FILES) return { tooMany: true, count: files.length };
  const lines = files.map((f) => { try { const st = statSync(join(cwd, f)); return `${f}\t${st.size}\t${Math.floor(st.mtimeMs)}`; } catch { return `${f}\t?`; } });
  return { hash: sha256(lines.join("\n")), count: files.length };
}
const NO_UNTRACKED = sha256("");

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
  const first = evaluateKey(dataDir, opts);
  // 4.0: no fresh proof under that name, but the caller named the command:
  // a proof of the same command on the same code counts, whoever recorded it.
  if (!first.fresh && opts.command !== undefined && opts.key && !String(opts.key).startsWith("command:")) {
    const byCommand = evaluateKey(dataDir, { ...opts, key: commandKey(opts.command) });
    if (byCommand.fresh) return { ...byCommand, via: "command" };
  }
  return first;
}

function evaluateKey(dataDir, opts = {}) {
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

  // An entry written since 4.0 (`idKind: 2`) names the project's folder minus
  // the ignored paths; an older one names the whole repository's tree.
  const ignoreNow = readVerifyIgnore(dataDir);
  if (entry.idKind === 2 && JSON.stringify(entry.ignore ?? []) !== JSON.stringify(ignoreNow)) {
    return { fresh: false, reason: "the verify_ignore list changed since the proof was recorded" };
  }
  const treeId = entry.idKind === 2 ? codeId(projectRoot, typeof entry.scope === "string" ? entry.scope : "", entry.ignore ?? []) : gitTreeId(projectRoot);
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

  // the same folder the proof was recorded for (older entries: the whole repository)
  const clean = gitPorcelainClean(projectRoot, typeof entry.scope === "string" ? entry.scope : "");
  if (clean === null) {
    return { fresh: false, reason: "git status --porcelain failed — unevaluable" };
  }
  if (!clean) {
    return { fresh: false, reason: `working tree is dirty right now${entry.scope ? ` (under ${entry.scope}/)` : ""}` };
  }
  // Untracked files: the same set, sizes and times as when the proof was
  // recorded (an entry from before 4.13.1 recorded with none).
  const fp = untrackedFingerprint(projectRoot, typeof entry.scope === "string" ? entry.scope : "");
  if (fp === null) return { fresh: false, reason: "untracked files could not be listed — unevaluable" };
  if (fp.tooMany || fp.hash !== (entry.untracked ?? NO_UNTRACKED)) {
    return { fresh: false, reason: `untracked files changed since the proof was recorded${entry.scope ? ` (under ${entry.scope}/)` : ""}` };
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
export function recordVerification(dataDir, { key, command, exitCode, capturePath, projectDir = null } = {}) {
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
  const scope = projectScope(projectRoot, projectDir);
  const ignore = readVerifyIgnore(dataDir);
  const treeId = codeId(projectRoot, scope, ignore);
  if (treeId === null) {
    return { ok: false, code: 3, message: "verify record: git rev-parse HEAD^{tree} failed — refusing to record" };
  }
  const clean = gitPorcelainClean(projectRoot, scope);
  if (clean === null) {
    return { ok: false, code: 3, message: "verify record: git status --porcelain failed — refusing to record" };
  }
  if (!clean) {
    return {
      ok: false,
      code: 3,
      message:
        `verify record: a tracked file is changed${scope ? ` under ${scope}/` : ""} — refusing to record ` +
        "(a dirty-tree recording could later be falsely reused as proof of a clean pass)",
    };
  }
  const fp = untrackedFingerprint(projectRoot, scope);
  if (fp === null) return { ok: false, code: 3, message: "verify record: untracked files could not be listed — refusing to record" };
  if (fp.tooMany) {
    return { ok: false, code: 3, message: `verify record: ${fp.count} untracked files${scope ? ` under ${scope}/` : ""} (more than ${MAX_UNTRACKED_FILES}) — too many to fingerprint; add the generated ones to .gitignore` };
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
    idKind: 2,
    ignore,
    exitCode: parsedExit,
    porcelainClean: true,
    scope,
    untracked: fp.hash,
    untrackedCount: fp.count,
    command: String(command).slice(0, 2000), // shown by `verify list` (4.13.4); the hash stays the comparison
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
    // The same proof under the command's own key (4.0): whoever asks later
    // "did this exact command pass on this exact code?" finds it, whatever
    // name the first caller recorded it under.
    if (parsedExit === 0 && !String(key).startsWith("command:")) base[commandKey(command)] = { ...entry, key: commandKey(command) };
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
 * Called by `shipyard-logcap run` after a command exits 0 (4.0): the run is
 * recorded as proof of that command on this code, with no skill having to
 * remember to. Quietly does nothing when it cannot be a proof: typed in
 * another checkout (a builder's worktree), tracked files changed, no sprint
 * folder. Returns true when recorded.
 */
export function recordByCommand(dataDir, { command, capturePath } = {}) {
  try {
    if (!dataDir || !command || !capturePath || !inLedgerCheckout(dataDir)) return false;
    if (!existsSync(join(dataDir, "sprints", "current"))) return false;
    const ok = recordVerification(dataDir, { key: commandKey(command), command, exitCode: 0, capturePath }).ok === true;
    // Each part of a plain `a && b && c` chain passed too (4.0): a step that
    // ran `make && make -k -j8 test && make ui-check` green has proven the
    // test tier on this code, and the next stage asks for exactly that part.
    if (ok) for (const part of chainParts(command)) recordVerification(dataDir, { key: commandKey(part), command: part, exitCode: 0, capturePath });
    return ok;
  } catch { return false; }
}

/**
 * The parts of a plain `&&` chain, or [] when the command is anything else.
 * Plain means: optionally `sh -c` / `bash -c` / `zsh -c` in front, then
 * commands joined only by `&&`. A pipe, `;`, `||`, a redirect, a subshell or
 * a `cd` makes a part depend on more than itself, so nothing is split.
 */
export function chainParts(command) {
  const script = String(command).replace(/^\s*(?:ba|z)?sh\s+-c\s+/, "").trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
  if (!script.includes("&&") || /[;|<>`]|\$\(|(^|&&\s*)cd\s/.test(script.replace(/&&/g, " "))) return [];
  const parts = script.split("&&").map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? [...new Set(parts)] : [];
}

/**
 * Called by `shipyard-logcap run --reuse` before it starts the command: is
 * there a fresh proof of this exact command on this exact code? Returns the
 * entry, or null (run it). Logs `verification_reused` on a hit.
 */
export function reuseByCommand(dataDir, command) {
  try {
    if (!dataDir || !command || !inLedgerCheckout(dataDir)) return null;
    const r = evaluateKey(dataDir, { key: commandKey(command), command });
    if (!r.fresh) return null;
    try { logEvent(dataDir, "verification_reused", { key: commandKey(command), tree: String(r.entry.treeId).slice(0, 12), via: "logcap" }); } catch { /* best-effort */ }
    return r.entry;
  } catch { return null; }
}

/**
 * Every recorded proof with its state right now (4.13.4). Read-only: no
 * event, no reuse. The review asked "is the full suite proven for this tree?"
 * under a key it made up, got "no recorded verification", and re-ran a
 * five-minute suite that execute had recorded twelve minutes earlier.
 */
export function listVerifications(dataDir) {
  const { ledger, parseError } = readLedgerSafe(dataDir);
  if (parseError) return [];
  // a named proof is also stored under its command's key; show that twin only when it stands alone
  const named = new Set(Object.keys(ledger).filter((k) => !k.startsWith("command:")).map((k) => `${ledger[k]?.commandHash}@${ledger[k]?.recordedAt}`));
  return Object.keys(ledger).filter((k) => ledger[k] && typeof ledger[k] === "object" && !(k.startsWith("command:") && named.has(`${ledger[k].commandHash}@${ledger[k].recordedAt}`))).map((key) => {
    const e = ledger[key];
    const r = evaluateFreshness(dataDir, { key });
    return { key, fresh: r.fresh === true, reason: r.fresh ? "" : r.reason, command: String(e.command ?? ""), recorded_at: String(e.recordedAt ?? ""), capture: String(e.capturePath ?? "") };
  });
}

/**
 * CLI dispatch, called from shipyard-data.mjs's main() as `case "verify":`.
 *
 *   shipyard-data verify list [--json]
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

  if (sub === "list") {
    const rows = listVerifications(dataDir);
    if (rest.includes("--json")) { process.stdout.write(JSON.stringify(rows) + "\n"); return; }
    if (!rows.length) { process.stdout.write("verify: no proof is recorded for this sprint\n"); return; }
    for (const r of rows) {
      process.stdout.write(`${r.fresh ? "FRESH" : "STALE"}  ${r.key}  recorded ${r.recorded_at}${r.fresh ? "" : `  — ${r.reason}`}\n`);
      process.stdout.write(`       command: ${r.command || "(not stored: recorded before 4.13.4)"}\n`);
      if (r.fresh && r.command) process.stdout.write(`       reuse:   shipyard-data verify check --key ${r.key} --command ${JSON.stringify(r.command)}\n`);
    }
    process.stdout.write(`\nThe sprint's full suite is key ${FULL_SUITE_KEY}. A FRESH proof is reused, never re-run; a STALE one is re-run and recorded under the same key.\n`);
    return;
  }

  process.stderr.write(
    `shipyard-data verify: unknown subcommand "${sub ?? ""}". Expected: list [--json] | ` +
      `record --key <k> --command <literal> --exit <n> --capture <path> | ` +
      `check --key <k> --command <literal> [--ttl-hours <n>]\n`,
  );
  process.exit(2);
}
