/**
 * spec-state-cli — deterministic CLI for feature/backlog/idea/task/draft state
 * mutations, dispatched from `shipyard-data feature|backlog|idea|task|draft ...`.
 *
 * Mirrors the cursor-cli.mjs / sprintSet pattern: skill bodies stop
 * hand-Editing feature-file frontmatter and BACKLOG.md ID/last_groomed
 * lines (the class of drift the sprint-frontmatter CLI already closed for
 * SPRINT.md) and instead call one of these typed, atomic, event-logging
 * subcommands.
 *
 * Exit codes: 0 ok, 2 usage, 3 validation refusal (structured reason),
 * 4 not-found (feature/idea/epic id doesn't resolve).
 *
 * Every mutating subcommand emits a structured event via logEvent so the
 * change is visible in `.shipyard-events.jsonl` / `shipyard-context diagnose`.
 *
 * Locking: single-entity mutations take a `feature-<FID>` (or `idea-<ID>`)
 * lock. Cross-file operations (feature set-status side-effecting
 * BACKLOG.md, backlog add/remove/rank/set) take the feature lock(s) FIRST,
 * then the `backlog` lock, in that fixed order — matching the
 * with-lock/withLockfile convention already used for .id-seq and the event
 * log, so two concurrent grooming operations can't interleave a
 * feature-file write with a BACKLOG.md rewrite.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { logEvent, withLockfile } from "./_hook_lib.mjs";
import {
  BACKLOG_REMOVING_STATUSES,
  FEATURE_TRANSITIONS,
  IDEA_TRANSITIONS,
  validateStatusTransition,
} from "./spec-lifecycle.mjs";

// --- generic helpers -----------------------------------------------------

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Thrown by `fail()` instead of calling `process.exit()` directly. Several
 * validation checks run INSIDE a `withNamedLock` callback (e.g. the epic-
 * existence check in `feature set`) — `process.exit()` terminates the
 * process immediately without unwinding the stack, which would skip
 * withLockfile's `finally` block and leave the lock file orphaned for the
 * next caller to wait out (up to the 30s stale-lock TTL). Throwing a
 * catchable error lets every `finally` (lock release) run normally; the
 * outer dispatch in `specStateCmd` is the only place that actually calls
 * `process.exit()`.
 */
class CliFail extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, msg) {
  throw new CliFail(code, msg);
}

function withNamedLock(dataDir, key, fn) {
  const locksDir = join(dataDir, ".locks");
  mkdirSync(locksDir, { recursive: true });
  withLockfile(join(locksDir, `${key}.lock`), fn);
}

function atomicWriteFile(path, content) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/** Parse the leading `---\n...\n---` frontmatter block. Returns null if absent. */
function parseFm(content) {
  const m = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!m) return null;
  return { open: m[1], block: m[2], close: m[3], matchLen: m[0].length, rest: content.slice(m[0].length) };
}

function getScalar(block, key) {
  const m = block.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!m) return undefined;
  return m[1].trim();
}

/** Escape a literal for safe interpolation into a RegExp. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Set (or append) a scalar `key: value` line inside a frontmatter block. */
function setScalar(block, key, value) {
  const lineRe = new RegExp(`^${escapeRe(key)}:.*$`, "m");
  if (lineRe.test(block)) {
    return block.replace(lineRe, `${key}: ${value}`);
  }
  return block.replace(/\s*$/, "") + `\n${key}: ${value}`;
}

/** Parse an inline flow-style array field: `key: [a, b, "c"]  # comment`. */
function getArrayField(block, key) {
  const m = block.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"));
  if (!m) return [];
  const inner = m[1].trim();
  if (!inner) return [];
  return inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
}

/** Set an inline flow-style array field, preserving a trailing `# comment`. */
function setArrayField(block, key, arr) {
  const re = new RegExp(`^(${key}:)\\s*\\[[^\\]]*\\](\\s*#.*)?$`, "m");
  const rendered = `[${arr.join(", ")}]`;
  if (re.test(block)) {
    return block.replace(re, (_full, prefix, comment) => `${prefix} ${rendered}${comment ?? ""}`);
  }
  return block.replace(/\s*$/, "") + `\n${key}: ${rendered}`;
}

function writeFrontmatteredFile(path, fm, block, extraTransform) {
  let content = fm.open + block + fm.close + fm.rest;
  if (extraTransform) content = extraTransform(content);
  atomicWriteFile(path, content);
}

/** Remove a whole `key: ...` scalar line from a frontmatter block, if present. */
function removeScalarKey(block, key) {
  return block.replace(new RegExp(`^${key}:.*$\\n?`, "m"), "");
}

/**
 * Locate the span of lines belonging to a top-level frontmatter key: the
 * key's own line plus every subsequent indented line (block scalar/sequence
 * continuation), up to (not including) the next non-indented line or the
 * end of the block. Returns null if the key isn't present at all.
 */
function findKeySpan(block, key) {
  const lines = block.split("\n");
  const startIdx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return { lines, startIdx, endIdx };
}

/**
 * Append a YAML block-sequence entry under `key:` (e.g. `verify_history:`),
 * where each entry is a `- k: v` mapping rather than a flow scalar. Used for
 * structured, growing histories that a regex-based flow array can't
 * represent. Handles three starting shapes: key absent, key present as an
 * empty flow array (`key: []`), and key present with existing block entries
 * (new entry is appended after the last one, before the next top-level key).
 *
 * `entryLines` is the fully-rendered indented block for one entry, e.g.:
 *   ["  - iteration: 3", '    command: "npm test"', "    exit: 0"]
 */
function appendBlockListEntry(block, key, entryLines) {
  const span = findKeySpan(block, key);
  if (!span) {
    return block.replace(/\s*$/, "") + `\n${key}:\n` + entryLines.join("\n");
  }
  const { lines, startIdx, endIdx } = span;
  const ownLine = lines[startIdx];
  const isFlowEmpty = /^\s*\S+:\s*\[\]\s*$/.test(ownLine);
  const newLines = [...lines];
  if (isFlowEmpty && endIdx === startIdx + 1) {
    // Rewrite `key: []` -> `key:` and insert the first entry right after.
    newLines[startIdx] = `${key}:`;
    newLines.splice(startIdx + 1, 0, ...entryLines);
  } else {
    // Insert the new entry right before the next top-level key (or EOF).
    newLines.splice(endIdx, 0, ...entryLines);
  }
  return newLines.join("\n");
}

/** Extract every `- iteration: N` value from a block-sequence span's text. */
function parseBlockIterations(block, key) {
  const span = findKeySpan(block, key);
  if (!span) return [];
  const { lines, startIdx, endIdx } = span;
  const spanText = lines.slice(startIdx, endIdx).join("\n");
  return [...spanText.matchAll(/^\s*-\s*iteration:\s*(\d+)/gm)].map((m) => parseInt(m[1], 10));
}

/** Acquire two feature-scoped locks in a fixed (lexicographic) order to avoid deadlock. */
function withTwoFeatureLocks(dataDir, fidA, fidB, fn) {
  const [first, second] = [fidA, fidB].sort();
  withNamedLock(dataDir, `feature-${first}`, () => {
    withNamedLock(dataDir, `feature-${second}`, fn);
  });
}

// --- feature / idea resolution -------------------------------------------

const FID_RE = /^F\d{3}$/;
const IDEA_ID_RE = /^IDEA-\d{3}$/;
const EPIC_ID_RE = /^E\d{3}$/;
const TID_RE = /^T\d{3}$/;

function resolveEntityFile(dataDir, subdir, id, { optional = false } = {}) {
  const dir = join(dataDir, "spec", subdir);
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    entries = [];
  }
  const matches = entries.filter((name) => name === `${id}.md` || name.startsWith(`${id}-`));
  if (matches.length === 0) {
    if (optional) return null;
    fail(4, `spec-state: ${id} not found under spec/${subdir}/`);
  }
  if (matches.length > 1) {
    fail(
      4,
      `spec-state: ${id} is ambiguous — ${matches.length} candidates in spec/${subdir}/: ${matches.join(", ")}`,
    );
  }
  return join(dir, matches[0]);
}

function resolveFeatureFile(dataDir, fid, opts) {
  if (!FID_RE.test(fid)) fail(2, `spec-state: invalid feature id "${fid}" — expected F### (e.g. F004)`);
  return resolveEntityFile(dataDir, "features", fid, opts);
}

function resolveIdeaFile(dataDir, ideaId, opts) {
  if (!IDEA_ID_RE.test(ideaId)) fail(2, `spec-state: invalid idea id "${ideaId}" — expected IDEA-### (e.g. IDEA-045)`);
  return resolveEntityFile(dataDir, "ideas", ideaId, opts);
}

function epicExists(dataDir, epicId) {
  if (!EPIC_ID_RE.test(epicId)) return false;
  return resolveEntityFile(dataDir, "epics", epicId, { optional: true }) !== null;
}

function resolveTaskFile(dataDir, tid, opts) {
  if (!TID_RE.test(tid)) fail(2, `spec-state: invalid task id "${tid}" — expected T### (e.g. T004)`);
  return resolveEntityFile(dataDir, "tasks", tid, opts);
}

function validateTaskId(tid) {
  if (!TID_RE.test(tid)) fail(2, `spec-state: invalid task id "${tid}" — expected T### (e.g. T004)`);
}

// --- RICE ------------------------------------------------------------------

function readFeatureRice(dataDir, fid) {
  const path = resolveFeatureFile(dataDir, fid, { optional: true });
  if (!path) return { score: null, missing: ["file_not_found"] };
  const content = readFileSync(path, "utf8");
  const fm = parseFm(content);
  if (!fm) return { score: null, missing: ["no_frontmatter"] };
  const reach = parseFloat(getScalar(fm.block, "rice_reach"));
  const impact = parseFloat(getScalar(fm.block, "rice_impact"));
  const confidence = parseFloat(getScalar(fm.block, "rice_confidence"));
  const effort = parseFloat(getScalar(fm.block, "rice_effort"));
  const missing = [];
  if (!Number.isFinite(reach)) missing.push("rice_reach");
  if (!Number.isFinite(impact)) missing.push("rice_impact");
  if (!Number.isFinite(confidence)) missing.push("rice_confidence");
  if (!Number.isFinite(effort) || effort <= 0) missing.push("rice_effort");
  if (missing.length > 0) return { score: null, missing };
  return { score: (reach * impact * confidence) / effort, missing: [] };
}

function formatRiceScore(score) {
  return Number.isInteger(score) ? String(score) : score.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function computeRiceScoreFromBlock(block) {
  const reach = parseFloat(getScalar(block, "rice_reach"));
  const impact = parseFloat(getScalar(block, "rice_impact"));
  const confidence = parseFloat(getScalar(block, "rice_confidence"));
  const effort = parseFloat(getScalar(block, "rice_effort"));
  if (![reach, impact, confidence, effort].every(Number.isFinite) || effort <= 0) return null;
  return (reach * impact * confidence) / effort;
}

// --- BACKLOG.md parse / serialize ------------------------------------------

function backlogPath(dataDir) {
  return join(dataDir, "backlog", "BACKLOG.md");
}

/**
 * Parse BACKLOG.md into { fm, preTable, tableOpen, ids, tail }.
 *   fm       — { open, block, close } frontmatter pieces
 *   preTable — content between frontmatter and the `| Rank | ID |` header
 *              (inclusive of the header + separator row)
 *   ids      — ordered array of feature IDs read from `| N | FID |` rows
 *   tail     — everything after the last table row (e.g. `## Overrides`)
 */
function parseBacklog(dataDir) {
  const path = backlogPath(dataDir);
  if (!existsSync(path)) {
    fail(1, `spec-state: no ${path} — run shipyard-data onboarding bootstrap first`);
  }
  const content = readFileSync(path, "utf8");
  const fm = parseFm(content);
  if (!fm) fail(1, "spec-state: BACKLOG.md has no frontmatter block — refusing");
  const body = fm.rest;
  const lines = body.split("\n");
  const headerIdx = lines.findIndex((l) => /^\s*\|\s*Rank\s*\|\s*ID\s*\|/i.test(l));
  if (headerIdx === -1) {
    fail(1, "spec-state: BACKLOG.md has no `| Rank | ID |` table — refusing");
  }
  // header + separator row (the `|---|---|` line right after it)
  const sepIdx = headerIdx + 1;
  const preTable = lines.slice(0, sepIdx + 1).join("\n") + "\n";
  let i = sepIdx + 1;
  const ids = [];
  const rowRe = /^\s*\|\s*\d+\s*\|\s*(\S+?)\s*\|\s*$/;
  for (; i < lines.length; i++) {
    const m = lines[i].match(rowRe);
    if (!m) break;
    ids.push(m[1]);
  }
  const tail = lines.slice(i).join("\n");
  return { path, fm, preTable, ids, tail };
}

function serializeBacklog({ path, fm, preTable, ids, tail }) {
  const rows = ids.map((id, i) => `| ${i + 1} | ${id} |`).join("\n");
  const body = preTable + rows + (rows ? "\n" : "") + tail;
  const content = fm.open + fm.block + fm.close + body;
  atomicWriteFile(path, content);
}

// --- feature commands -------------------------------------------------------

function featureSetStatus(dataDir, args) {
  const fid = args[0];
  const toStatus = args[1];
  const force = args.includes("--force");
  if (!fid || !toStatus) fail(2, "usage: feature set-status <FID> <status> [--force]");

  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${fid} has no frontmatter block — refusing`);
    const fromStatus = getScalar(fm.block, "status");
    const check = validateStatusTransition(FEATURE_TRANSITIONS, fromStatus, toStatus);
    if (!check.ok && !force) {
      const known = FEATURE_TRANSITIONS[fromStatus];
      fail(
        3,
        `spec-state: illegal feature status transition ${fromStatus} -> ${toStatus} for ${fid}. ` +
          `Valid next states from "${fromStatus}": ${known ? (known.length ? known.join(", ") : "(none — terminal)") : "(unknown status)"}. ` +
          `Re-run with --force to override the graph (side effects still apply).`,
      );
    }

    let block = setScalar(fm.block, "status", toStatus);
    block = setScalar(block, "updated", today());
    writeFrontmatteredFile(path, fm, block);

    if (BACKLOG_REMOVING_STATUSES.has(toStatus)) {
      withNamedLock(dataDir, "backlog", () => {
        const b = parseBacklog(dataDir);
        if (b.ids.includes(fid)) {
          b.ids = b.ids.filter((id) => id !== fid);
          serializeBacklog(b);
        }
      });
    }

    logEvent(dataDir, "feature_status_changed", {
      feature: fid,
      from: fromStatus,
      to: toStatus,
      forced: !check.ok && force,
    });
    process.stdout.write(`${fid}: ${fromStatus} -> ${toStatus}\n`);
  });
}

const FEATURE_SET_ALLOWLIST = new Set([
  "rice_reach",
  "rice_impact",
  "rice_confidence",
  "rice_effort",
  "story_points",
  "epic",
  "updated",
  "synced_at",
]);
const FEATURE_SET_REFUSED_HINTS = {
  status: "use `feature set-status <FID> <status>` instead",
  id: "the id is fixed at creation — not settable",
  title: "title changes go through Edit on the feature file body/frontmatter directly (not CLI-owned)",
  tasks: "use `feature set-tasks <FID> <TID,TID,...>` or `feature clear-tasks <FID>` instead",
  references: "use `feature add-ref <FID> <path>` instead",
  external_refs: "use `feature add-external-ref <FID> <key>` instead",
};

function featureSet(dataDir, args) {
  const fid = args[0];
  const kvArgs = args.slice(1);
  if (!fid || kvArgs.length === 0) {
    fail(2, "usage: feature set <FID> k=v [k=v ...]");
  }
  const kv = {};
  for (const a of kvArgs) {
    const eq = a.indexOf("=");
    if (eq <= 0) fail(2, `spec-state: unrecognized argument "${a}" — expected k=v`);
    kv[a.slice(0, eq)] = a.slice(eq + 1);
  }
  for (const key of Object.keys(kv)) {
    if (FEATURE_SET_REFUSED_HINTS[key]) {
      fail(3, `spec-state: feature set refuses key "${key}" — ${FEATURE_SET_REFUSED_HINTS[key]}`);
    }
    if (!FEATURE_SET_ALLOWLIST.has(key)) {
      fail(
        3,
        `spec-state: feature set: unknown key "${key}". Allowed: ${[...FEATURE_SET_ALLOWLIST].join(", ")}`,
      );
    }
  }
  // Validate values before touching disk.
  for (const key of ["rice_reach", "rice_impact", "rice_confidence", "rice_effort"]) {
    if (key in kv) {
      const n = Number(kv[key]);
      if (!Number.isFinite(n)) fail(3, `spec-state: ${key} must be numeric (got "${kv[key]}")`);
      if (key === "rice_effort" && n <= 0) fail(3, `spec-state: rice_effort must be > 0 (got "${kv[key]}")`);
    }
  }
  if ("story_points" in kv) {
    const n = Number(kv.story_points);
    if (!Number.isInteger(n) || n <= 0) {
      fail(3, `spec-state: story_points must be a positive integer (got "${kv.story_points}")`);
    }
  }
  if ("epic" in kv && kv.epic !== "") {
    if (!EPIC_ID_RE.test(kv.epic)) fail(3, `spec-state: epic must match E### or be "" to unassign (got "${kv.epic}")`);
  }
  for (const key of ["updated", "synced_at"]) {
    if (key in kv && !/^\d{4}-\d{2}-\d{2}$/.test(kv[key])) {
      fail(3, `spec-state: ${key} must be an ISO date YYYY-MM-DD (got "${kv[key]}")`);
    }
  }

  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    if ("epic" in kv && kv.epic !== "" && !epicExists(dataDir, kv.epic)) {
      fail(3, `spec-state: epic ${kv.epic} does not exist under spec/epics/ — create it first`);
    }
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${fid} has no frontmatter block — refusing`);
    let block = fm.block;
    for (const [key, value] of Object.entries(kv)) {
      block = setScalar(block, key, key === "epic" && value === "" ? '""' : value);
    }
    if (Object.keys(kv).some((key) => key.startsWith("rice_"))) {
      const score = computeRiceScoreFromBlock(block);
      if (score !== null) block = setScalar(block, "rice_score", formatRiceScore(score));
    }
    if (!("updated" in kv)) {
      block = setScalar(block, "updated", today());
    }
    writeFrontmatteredFile(path, fm, block);
    logEvent(dataDir, "feature_field_set", { feature: fid, keys: Object.keys(kv).join(",") });
    process.stdout.write(`${fid}: ${Object.keys(kv).join(", ")} updated\n`);
  });
}

function featureAddRef(dataDir, args) {
  const fid = args[0];
  const refPath = args[1];
  if (!fid || !refPath) fail(2, "usage: feature add-ref <FID> <path>");
  if (!existsSync(refPath)) fail(3, `spec-state: add-ref target does not exist: ${refPath}`);

  const refsRoot = join(dataDir, "spec", "references");
  let realRoot, realTarget;
  try {
    realRoot = realpathSync(refsRoot);
  } catch {
    fail(3, `spec-state: spec/references/ does not exist under the data dir`);
  }
  try {
    realTarget = realpathSync(refPath);
  } catch {
    fail(3, `spec-state: cannot resolve realpath of ${refPath}`);
  }
  const rel = relative(realRoot, realTarget);
  if (rel.startsWith("..") || rel === "") {
    // rel === "" would mean refPath IS spec/references itself — also invalid.
    fail(
      3,
      `spec-state: add-ref refuses ${refPath} — must resolve inside <SHIPYARD_DATA>/spec/references/ (got outside via realpath containment check)`,
    );
  }

  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${fid} has no frontmatter block — refusing`);
    const existing = getArrayField(fm.block, "references");
    if (existing.includes(refPath)) {
      process.stdout.write(`${fid}: ${refPath} already in references — no-op\n`);
      return;
    }
    const block = setArrayField(fm.block, "references", [...existing, refPath]);
    writeFrontmatteredFile(path, fm, block);
    logEvent(dataDir, "feature_ref_added", { feature: fid, path: refPath });
    process.stdout.write(`${fid}: added reference ${refPath}\n`);
  });
}

const EXTERNAL_REF_RE = /^([A-Z][A-Z0-9]*-\d+|#\d+)$/;

function featureAddExternalRef(dataDir, args) {
  const fid = args[0];
  const key = args[1];
  if (!fid || !key) fail(2, "usage: feature add-external-ref <FID> <key>");
  if (!EXTERNAL_REF_RE.test(key)) {
    fail(3, `spec-state: "${key}" doesn't look like an external ref — expected PROJECT-123 or #123`);
  }

  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${fid} has no frontmatter block — refusing`);
    const existing = getArrayField(fm.block, "external_refs");
    if (existing.includes(key)) {
      process.stdout.write(`${fid}: ${key} already in external_refs — no-op\n`);
      return;
    }
    const block = setArrayField(fm.block, "external_refs", [...existing, key]);
    writeFrontmatteredFile(path, fm, block);
    logEvent(dataDir, "feature_external_ref_added", { feature: fid, key });
    process.stdout.write(`${fid}: added external ref ${key}\n`);
  });
}

/**
 * Bidirectional dependency link/unlink between two features. "A depends on
 * B" is stored on BOTH files (A's `dependencies:` gets B, B's gets A) so
 * either file alone tells the whole story without a cross-file query. No
 * cycle detection — the CLI trusts the caller's judgment on whether A->B
 * makes sense; it only guarantees both sides of whichever edge is asked for
 * stay in sync.
 */
function featureDepLink(dataDir, args, { add }) {
  const fidA = args[0];
  const fidB = args[1];
  const verb = add ? "add-dep" : "remove-dep";
  if (!fidA || !fidB) fail(2, `usage: feature ${verb} <A> <B>`);
  if (!FID_RE.test(fidA)) fail(2, `spec-state: invalid feature id "${fidA}"`);
  if (!FID_RE.test(fidB)) fail(2, `spec-state: invalid feature id "${fidB}"`);
  if (fidA === fidB) fail(3, `spec-state: feature ${verb} refuses a self-dependency (${fidA} == ${fidB})`);

  withTwoFeatureLocks(dataDir, fidA, fidB, () => {
    const pathA = resolveFeatureFile(dataDir, fidA);
    const pathB = resolveFeatureFile(dataDir, fidB);

    const applyOne = (path, otherId) => {
      const content = readFileSync(path, "utf8");
      const fm = parseFm(content);
      if (!fm) fail(3, `spec-state: feature has no frontmatter block — refusing (${path})`);
      const existing = getArrayField(fm.block, "dependencies");
      let next;
      let changed;
      if (add) {
        changed = !existing.includes(otherId);
        next = changed ? [...existing, otherId] : existing;
      } else {
        changed = existing.includes(otherId);
        next = existing.filter((id) => id !== otherId);
      }
      if (changed) {
        const block = setArrayField(fm.block, "dependencies", next);
        writeFrontmatteredFile(path, fm, block);
      }
      return changed;
    };

    const changedA = applyOne(pathA, fidB);
    const changedB = applyOne(pathB, fidA);

    if (!changedA && !changedB) {
      process.stdout.write(`feature ${verb}: no-op — ${fidA} <-> ${fidB} already ${add ? "linked" : "unlinked"}\n`);
      return;
    }
    logEvent(dataDir, add ? "feature_dep_added" : "feature_dep_removed", { a: fidA, b: fidB });
    process.stdout.write(`feature ${verb}: ${fidA} <-> ${fidB}\n`);
  });
}

/**
 * Empty a feature's `tasks:` array. Dedicated verb rather than a
 * `feature set tasks=` escape hatch — `tasks` stays on the refused-keys list
 * for `feature set` (task membership belongs to the task-creation flow) and
 * this is the one sanctioned way to reset it (sprint cancel: cancelled
 * features get re-decomposed fresh next planning cycle). No task-state
 * validation — this does not touch the task files themselves.
 */
function featureClearTasks(dataDir, args) {
  const fid = args[0];
  if (!fid) fail(2, "usage: feature clear-tasks <FID>");
  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${fid} has no frontmatter block — refusing`);
    const existing = getArrayField(fm.block, "tasks");
    const block = setArrayField(fm.block, "tasks", []);
    writeFrontmatteredFile(path, fm, block);
    logEvent(dataDir, "feature_tasks_cleared", { feature: fid, count: existing.length });
    process.stdout.write(`${fid}: cleared ${existing.length} task(s) from tasks:\n`);
  });
}

function featureSetTasks(dataDir, args) {
  const fid = args[0];
  const raw = args[1];
  if (!fid || raw === undefined) fail(2, "usage: feature set-tasks <FID> <TID,TID,...>");
  if (!FID_RE.test(fid)) fail(2, `spec-state: invalid feature id "${fid}" — expected F###`);
  const tasks = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const tid of tasks) validateTaskId(tid);
  const deduped = [...new Set(tasks)];
  if (deduped.length !== tasks.length) fail(3, `spec-state: feature set-tasks refuses duplicate task IDs`);

  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    const validatedTasks = [];
    for (const tid of deduped) {
      const taskPath = resolveTaskFile(dataDir, tid, { optional: true });
      if (!taskPath) fail(4, `spec-state: feature set-tasks refuses missing task ${tid}`);
      const taskContent = readFileSync(taskPath, "utf8");
      const taskFm = parseFm(taskContent);
      if (!taskFm) fail(3, `spec-state: task ${tid} has no frontmatter block — refusing`);
      const parentFeature = getScalar(taskFm.block, "feature");
      if (parentFeature !== fid) {
        fail(3, `spec-state: feature set-tasks refuses ${tid}: task feature is "${parentFeature || "(missing)"}", not "${fid}"`);
      }
      validatedTasks.push(tid);
    }
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${fid} has no frontmatter block — refusing`);
    let block = setArrayField(fm.block, "tasks", validatedTasks);
    block = setScalar(block, "updated", today());
    writeFrontmatteredFile(path, fm, block);
    logEvent(dataDir, "feature_tasks_set", { feature: fid, tasks: validatedTasks.join(","), count: validatedTasks.length });
    process.stdout.write(`${fid}: tasks = [${validatedTasks.join(", ")}]\n`);
  });
}

// --- user_flow_probe ---------------------------------------------------------

export const USER_FLOW_PROBE_KINDS = ["auto", "assisted", "manual"];

/**
 * Classify a feature's `user_flow_probe:` field, tolerating the legacy
 * `demo_probe: <command>` scalar for one release.
 *
 * Shapes:
 *   absent   — neither key present.
 *   skip     — `user_flow_probe: skip-with-reason` (no proof of any kind exists;
 *              NOT "a human checked it" — that is kind: manual).
 *   scalar   — a bare command (legacy `demo_probe: |` or `user_flow_probe: |`).
 *              Treated as {kind: auto, command: <scalar>}.
 *   mapping  — the current shape; `kind` is read from the nested key.
 *
 * Returned `legacy` marks a value read from the old `demo_probe:` key, so
 * callers can print the one-line deprecation note.
 */
export function readUserFlowProbe(block) {
  for (const key of ["user_flow_probe", "demo_probe"]) {
    const span = findKeySpan(block, key);
    if (!span) continue;
    const legacy = key === "demo_probe";
    const ownLine = span.lines[span.startIdx];
    const inlineValue = (ownLine.match(new RegExp(`^${escapeRe(key)}:\\s*(.*)$`)) || [])[1].trim();

    if (inlineValue === "skip-with-reason") return { shape: "skip", key, legacy };
    // A block-scalar indicator (`|`, `>`, `|-`) or any inline text is the
    // legacy single-command form: auto by definition, since only a machine
    // can act on a bare command with no steps.
    if (inlineValue) return { shape: "scalar", kind: "auto", key, legacy };

    // Empty after the colon => nested mapping. Read `kind:` from its span.
    const nested = span.lines.slice(span.startIdx + 1, span.endIdx).join("\n");
    const kind = (nested.match(/^\s+kind:\s*(\S+)/m) || [])[1];
    return { shape: "mapping", kind, key, legacy };
  }
  return { shape: "absent" };
}

const PROOF_VERDICTS = ["pass", "fail"];
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;

/**
 * `feature record-proof <FID> verdict= confirmed-by= commit= [note=] [at=]`
 *
 * Persists a HUMAN verdict on an `assisted`/`manual` user_flow_probe as
 * first-class evidence. Before this existed, the only way to record
 * "a person installed the build and walked the flow" was
 * `demo_probe: skip-with-reason` — i.e. the strongest available proof was
 * filed as an ABSENCE of proof, and sprint-complete invariant 8 graded it
 * PASS-with-warning. This verb is the other half of that fix: the emitted
 * `user_flow_probe_confirmed` event satisfies invariant 8 exactly as an
 * exit-0 `auto` run does.
 *
 * Refuses on an `auto` probe: that kind's verdict IS its exit code, and
 * hand-recording one would let a green claim bypass the actual run.
 */
function featureRecordProof(dataDir, args) {
  const fid = args[0];
  const kv = {};
  for (const a of args.slice(1)) {
    const eq = a.indexOf("=");
    if (eq <= 0) fail(2, `spec-state: unrecognized argument "${a}" — expected k=v`);
    kv[a.slice(0, eq)] = a.slice(eq + 1);
  }
  const usage =
    'usage: feature record-proof <FID> verdict=pass|fail confirmed-by=<who> commit=<sha> [note="..."] [at=<ISO>]';
  if (!fid || !("verdict" in kv) || !("confirmed-by" in kv) || !("commit" in kv)) fail(2, usage);

  const verdict = kv.verdict;
  if (!PROOF_VERDICTS.includes(verdict)) {
    fail(3, `spec-state: verdict must be one of ${PROOF_VERDICTS.join("|")} (got "${verdict}")`);
  }
  const confirmedBy = kv["confirmed-by"].trim();
  if (!confirmedBy) {
    fail(3, "spec-state: confirmed-by must name who confirmed the flow — an unattributed verdict is not evidence");
  }
  const commit = kv.commit.trim();
  if (!COMMIT_RE.test(commit)) {
    fail(3, `spec-state: commit must be a git sha (7-40 hex chars, got "${commit}")`);
  }
  const at = kv.at || new Date().toISOString();

  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${fid} has no frontmatter block — refusing`);

    const probe = readUserFlowProbe(fm.block);
    if (probe.shape === "absent") {
      fail(3, `spec-state: ${fid} has no user_flow_probe — author one via /ship-discuss ${fid} before recording a verdict`);
    }
    if (probe.shape === "skip") {
      fail(
        3,
        `spec-state: ${fid} is marked skip-with-reason (no proof of any kind exists). A human verdict means the flow IS demonstrable — change it to kind: manual, then re-run.`,
      );
    }
    if (probe.kind === "auto") {
      fail(
        3,
        `spec-state: ${fid}'s user_flow_probe is kind: auto — its verdict is the probe's exit code. Run the probe, or change kind to assisted|manual if a human must confirm it.`,
      );
    }
    if (!USER_FLOW_PROBE_KINDS.includes(probe.kind)) {
      fail(3, `spec-state: ${fid}'s user_flow_probe has kind "${probe.kind ?? "(unset)"}" — expected ${USER_FLOW_PROBE_KINDS.join("|")}`);
    }

    let block = fm.block;
    block = setNestedScalarAppend(block, "user_flow_probe", "last_verdict", verdict);
    block = setNestedScalarAppend(block, "user_flow_probe", "last_confirmed_by", JSON.stringify(confirmedBy));
    block = setNestedScalarAppend(block, "user_flow_probe", "last_confirmed_at", JSON.stringify(at));
    block = setNestedScalarAppend(block, "user_flow_probe", "last_commit", commit);
    if (kv.note) block = setNestedScalarAppend(block, "user_flow_probe", "last_note", JSON.stringify(kv.note));
    block = setScalar(block, "updated", today());
    writeFrontmatteredFile(path, fm, block);

    logEvent(dataDir, "user_flow_probe_confirmed", {
      feature: fid,
      kind: probe.kind,
      verdict,
      commit,
      confirmed_by: confirmedBy,
    });
    if (probe.legacy) {
      process.stderr.write(
        `spec-state: ${fid} still uses the legacy \`demo_probe:\` key — rename to \`user_flow_probe:\` (mapping form).\n`,
      );
    }
    process.stdout.write(`${fid}: user_flow_probe ${probe.kind} verdict=${verdict} by ${confirmedBy} @ ${commit}\n`);
  });
}

/**
 * `feature check-probes <FID> [<FID> ...]`
 *
 * Deterministic, read-only gate: every named feature must carry a valid
 * `user_flow_probe:` (any kind, or a `skip-with-reason` whose reason is
 * populated; a legacy scalar `demo_probe:` counts). Exits 0 when all pass, 3
 * when any feature lacks one — printing one `<FID>: <verdict>` line per feature
 * so the caller can name the offenders.
 *
 * This is the enforcement half of the v3.17.0 authoring contract. Before it,
 * "every feature has a user_flow_probe" was checked only by prose (ship-discuss
 * Finalize) and a model self-review checklist row (ship-sprint Step 9.5), so
 * features reached a sprint with no probe and the gap surfaced only at execute
 * pre-flight / sprint-complete invariant 8 — the most expensive place. Both
 * ship-discuss Finalize and ship-sprint planning now call this instead of
 * eyeballing the field, matching the workspace rule that pipeline gates read
 * data artifacts rather than trust model self-review.
 */
function featureCheckProbes(dataDir, args) {
  const fids = args.filter((a) => !a.startsWith("--"));
  if (fids.length === 0) fail(2, "usage: feature check-probes <FID> [<FID> ...]");
  for (const fid of fids) {
    if (!FID_RE.test(fid)) fail(2, `spec-state: invalid feature id "${fid}" — expected F### (e.g. F004)`);
  }

  const failures = [];
  for (const fid of fids) {
    const path = resolveFeatureFile(dataDir, fid, { optional: true });
    if (!path) {
      failures.push(fid);
      process.stdout.write(`${fid}: MISSING-FILE — no feature file found\n`);
      continue;
    }
    const fm = parseFm(readFileSync(path, "utf8"));
    if (!fm) {
      failures.push(fid);
      process.stdout.write(`${fid}: NO-FRONTMATTER — cannot read user_flow_probe\n`);
      continue;
    }
    const probe = readUserFlowProbe(fm.block);
    const legacyNote = probe.legacy ? " (legacy demo_probe: — rename to user_flow_probe:)" : "";

    if (probe.shape === "absent") {
      failures.push(fid);
      process.stdout.write(`${fid}: MISSING — no user_flow_probe; author one via /ship-discuss ${fid}\n`);
    } else if (probe.shape === "skip") {
      const reason = (
        getScalar(fm.block, "user_flow_probe_skip_reason") ||
        getScalar(fm.block, "demo_probe_skip_reason") ||
        ""
      ).trim();
      if (!reason) {
        failures.push(fid);
        process.stdout.write(
          `${fid}: SKIP-NO-REASON — skip-with-reason requires a populated user_flow_probe_skip_reason\n`,
        );
      } else {
        process.stdout.write(`${fid}: OK skip-with-reason${legacyNote}\n`);
      }
    } else if (probe.shape === "scalar") {
      process.stdout.write(`${fid}: OK kind=auto${legacyNote}\n`);
    } else if (USER_FLOW_PROBE_KINDS.includes(probe.kind)) {
      process.stdout.write(`${fid}: OK kind=${probe.kind}${legacyNote}\n`);
    } else {
      failures.push(fid);
      process.stdout.write(
        `${fid}: BAD-KIND — user_flow_probe kind "${probe.kind ?? "(unset)"}" is not one of ${USER_FLOW_PROBE_KINDS.join("|")}\n`,
      );
    }
  }

  if (failures.length > 0) {
    fail(
      3,
      `spec-state: ${failures.length} feature(s) lack a valid user_flow_probe: ${failures.join(", ")}. ` +
        `Author one at spec time (/ship-discuss <FID>) — a probe written after the sprint builds is a rubber stamp.`,
    );
  }
  process.stdout.write(`user_flow_probe: all ${fids.length} feature(s) covered\n`);
}

// --- backlog commands --------------------------------------------------------

function backlogAdd(dataDir, args) {
  const fids = args.filter((a) => !a.startsWith("--"));
  if (fids.length === 0) fail(2, "usage: backlog add <FID> [<FID> ...]");

  for (const fid of fids) {
    if (!FID_RE.test(fid)) fail(2, `spec-state: invalid feature id "${fid}"`);
  }

  // Fixed lock order: each feature lock (sorted, for determinism), then backlog.
  const sortedFids = [...fids].sort();
  const acquire = (idx, cb) => {
    if (idx >= sortedFids.length) return cb();
    withNamedLock(dataDir, `feature-${sortedFids[idx]}`, () => acquire(idx + 1, cb));
  };

  acquire(0, () => {
    withNamedLock(dataDir, "backlog", () => {
      const b = parseBacklog(dataDir);
      const added = [];
      for (const fid of fids) {
        const path = resolveFeatureFile(dataDir, fid);
        const content = readFileSync(path, "utf8");
        const fm = parseFm(content);
        const status = fm ? getScalar(fm.block, "status") : undefined;
        if (status !== "approved") {
          fail(3, `spec-state: backlog add refuses ${fid} — status is "${status}", must be "approved"`);
        }
        if (b.ids.includes(fid)) continue; // dedupe no-op
        added.push(fid);
      }
      if (added.length === 0) {
        process.stdout.write("backlog add: nothing to add (all already present)\n");
        return;
      }
      // Insert each in RICE-descending position among current + newly added.
      const withScores = b.ids.map((id) => ({ id, ...readFeatureRice(dataDir, id) }));
      for (const fid of added) withScores.push({ id: fid, ...readFeatureRice(dataDir, fid) });
      const scored = withScores.filter((x) => x.score !== null).sort((a, c) => c.score - a.score);
      const unscored = withScores.filter((x) => x.score === null);
      b.ids = [...scored, ...unscored].map((x) => x.id);
      serializeBacklog(b);
      logEvent(dataDir, "backlog_added", { features: added.join(",") });
      process.stdout.write(`backlog add: added ${added.join(", ")}\n`);
    });
  });
}

function backlogRemove(dataDir, args) {
  const fids = args;
  if (fids.length === 0) fail(2, "usage: backlog remove <FID> [<FID> ...]");
  withNamedLock(dataDir, "backlog", () => {
    const b = parseBacklog(dataDir);
    const removed = [];
    const missing = [];
    for (const fid of fids) {
      if (b.ids.includes(fid)) removed.push(fid);
      else missing.push(fid);
    }
    b.ids = b.ids.filter((id) => !fids.includes(id));
    serializeBacklog(b);
    if (missing.length) {
      process.stderr.write(`backlog remove: not present (no-op): ${missing.join(", ")}\n`);
    }
    logEvent(dataDir, "backlog_removed", { features: removed.join(",") });
    process.stdout.write(`backlog remove: removed ${removed.length ? removed.join(", ") : "(none)"}\n`);
  });
}

function backlogRank(dataDir) {
  withNamedLock(dataDir, "backlog", () => {
    const b = parseBacklog(dataDir);
    const withScores = b.ids.map((id) => ({ id, ...readFeatureRice(dataDir, id) }));
    const scored = withScores.filter((x) => x.score !== null).sort((a, c) => c.score - a.score);
    const unscored = withScores.filter((x) => x.score === null);
    b.ids = [...scored, ...unscored].map((x) => x.id);
    serializeBacklog(b);
    const missingIds = unscored.map((x) => x.id);
    logEvent(dataDir, "backlog_ranked", { count: b.ids.length, missing_rice: missingIds.join(",") });
    process.stdout.write(
      `backlog rank: ${b.ids.length} item(s) ranked` +
        (missingIds.length ? `; missing RICE components (sunk to bottom): ${missingIds.join(", ")}\n` : "\n"),
    );
  });
}

function backlogSet(dataDir, args) {
  const key = args[0];
  let value = args[1];
  if (key !== "last_groomed" || !value) {
    fail(2, 'usage: backlog set last_groomed <date|today>. Allowed keys: last_groomed');
  }
  if (value === "today") value = today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(3, `spec-state: last_groomed must be an ISO date YYYY-MM-DD or "today" (got "${value}")`);
  }
  withNamedLock(dataDir, "backlog", () => {
    const path = backlogPath(dataDir);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(1, "spec-state: BACKLOG.md has no frontmatter block — refusing");
    const block = setScalar(fm.block, "last_groomed", value);
    writeFrontmatteredFile(path, fm, block);
    logEvent(dataDir, "backlog_groomed", { date: value });
    process.stdout.write(`backlog: last_groomed = ${value}\n`);
  });
}

// --- idea commands -----------------------------------------------------------

function ideaSetStatus(dataDir, args) {
  const ideaId = args[0];
  const toStatus = args[1];
  const toIdx = args.indexOf("--to");
  const toFeature = toIdx !== -1 ? args[toIdx + 1] : undefined;
  if (!ideaId || !toStatus) fail(2, "usage: idea set-status <IDEA-NNN> <graduated|rejected> [--to FNNN]");

  if (toStatus === "graduated" && !toFeature) {
    fail(3, "spec-state: idea set-status graduated requires --to FNNN (which feature it graduated to)");
  }
  if (toStatus === "rejected" && toFeature) {
    fail(3, "spec-state: idea set-status rejected refuses --to — a rejected idea has no graduation target");
  }
  if (toFeature) {
    if (!FID_RE.test(toFeature)) fail(3, `spec-state: --to "${toFeature}" is not a valid feature id (expected F###)`);
    if (!resolveFeatureFile(dataDir, toFeature, { optional: true })) {
      fail(3, `spec-state: --to ${toFeature} does not exist under spec/features/`);
    }
  }

  withNamedLock(dataDir, `idea-${ideaId}`, () => {
    const path = resolveIdeaFile(dataDir, ideaId);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${ideaId} has no frontmatter block — refusing`);
    const fromStatus = getScalar(fm.block, "status");
    const check = validateStatusTransition(IDEA_TRANSITIONS, fromStatus, toStatus);
    if (!check.ok) {
      const known = IDEA_TRANSITIONS[fromStatus];
      fail(
        3,
        `spec-state: illegal idea status transition ${fromStatus} -> ${toStatus} for ${ideaId}. ` +
          `Valid next states from "${fromStatus}": ${known ? (known.length ? known.join(", ") : "(none — terminal)") : "(unknown status)"}.`,
      );
    }
    let block = setScalar(fm.block, "status", toStatus);
    if (toFeature) block = setScalar(block, "graduated_to", toFeature);
    writeFrontmatteredFile(path, fm, block);
    // NOTE: the design spec says "event gains to= when present" — but this
    // CLI's status-change events already use `to` for the destination
    // STATUS (matching feature_status_changed's shape). Naming the target
    // feature field `to` as well would silently clobber that field in the
    // same JS object literal. Named `graduated_feature` instead so both
    // survive; see spec-state-cli's dev-notes deviation log.
    const fields = { idea: ideaId, from: fromStatus, to: toStatus };
    if (toFeature) fields.graduated_feature = toFeature;
    logEvent(dataDir, "idea_status_changed", fields);
    process.stdout.write(`${ideaId}: ${fromStatus} -> ${toStatus}` + (toFeature ? ` (-> ${toFeature})` : "") + "\n");
  });
}

// --- task commands -----------------------------------------------------------

const TASK_STATUS_ALLOWED = new Set(["pending", "in-progress", "done", "blocked", "approved", "needs-attention"]);
// Statuses that require --reason and stamp a paired reason/since field.
// `blocked` and `needs-attention` are documented as DISTINCT (blocked =
// waiting on an external dependency; needs-attention = a prior attempt
// produced a full audit trail but didn't converge, needs a human decision —
// see ship-status/SKILL.md's Task files note) — so each gets its own field
// pair rather than sharing `blocked_reason`/`blocked_since`.
const TASK_HELD_STATUS_FIELDS = {
  blocked: { reason: "blocked_reason", since: "blocked_since" },
  "needs-attention": { reason: "attention_reason", since: "attention_since" },
};

/**
 * `task set-status <TID> <status> [--reason "..."] [--force]` — no
 * transition graph (unlike feature/idea), just a fixed status vocabulary
 * plus three structural rules: `blocked`/`needs-attention` require --reason
 * and stamp their own reason/since field pair (see TASK_HELD_STATUS_FIELDS);
 * leaving either clears its pair; `done` is terminal (leaving it requires
 * --force). `--reason` also doubles as the `task_blocked` event's reason
 * when landing on `blocked` — that event auto-fires here, so callers (e.g.
 * ship-execute's Park handling) must NOT also emit it themselves.
 * `needs-attention` deliberately does NOT auto-emit `task_blocked` (the two
 * statuses are documented as distinct) — no dedicated event exists across
 * the sites that set it today (some emit task_blocked, some emit a
 * concern-specific event like subagent_timeout/research_out_of_scope_write,
 * some emit nothing), so only the always-on `task_status_set` fires; any
 * concern-specific event stays a separate manual emit at the call site.
 */
function taskSetStatus(dataDir, args) {
  const tid = args[0];
  const toStatus = args[1];
  const reasonIdx = args.indexOf("--reason");
  const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : undefined;
  const force = args.includes("--force");
  if (!tid || !toStatus) fail(2, "usage: task set-status <TID> <status> [--reason \"...\"] [--force]");
  if (!TASK_STATUS_ALLOWED.has(toStatus)) {
    fail(2, `spec-state: task set-status: unknown status "${toStatus}". Allowed: ${[...TASK_STATUS_ALLOWED].join(", ")}`);
  }
  if (TASK_HELD_STATUS_FIELDS[toStatus] && !reason) {
    fail(3, `spec-state: task set-status ${toStatus} requires --reason "<short reason>"`);
  }

  withNamedLock(dataDir, `task-${tid}`, () => {
    const path = resolveTaskFile(dataDir, tid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${tid} has no frontmatter block — refusing`);
    const fromStatus = getScalar(fm.block, "status");

    if (fromStatus === "done" && toStatus !== "done" && !force) {
      fail(
        3,
        `spec-state: task ${tid} status "done" is terminal — leaving it requires --force (attempted done -> ${toStatus})`,
      );
    }

    let block = setScalar(fm.block, "status", toStatus);
    // Set the destination status's own reason/since pair (if it's a held
    // status), and independently clear whichever held status's pair is
    // being LEFT — these are two separate checks (not if/else) so a
    // transition between the two held statuses (e.g. blocked ->
    // needs-attention) both stamps the new pair and clears the old one.
    const toFields = TASK_HELD_STATUS_FIELDS[toStatus];
    if (toFields) {
      block = setScalar(block, toFields.reason, JSON.stringify(reason));
      block = setScalar(block, toFields.since, JSON.stringify(new Date().toISOString()));
    }
    const fromFields = TASK_HELD_STATUS_FIELDS[fromStatus];
    if (fromFields && fromStatus !== toStatus) {
      block = removeScalarKey(block, fromFields.reason);
      block = removeScalarKey(block, fromFields.since);
    }
    writeFrontmatteredFile(path, fm, block);

    const eventFields = { task: tid, from: fromStatus, to: toStatus };
    if (reason) eventFields.reason = reason;
    logEvent(dataDir, "task_status_set", eventFields);
    if (toStatus === "blocked") {
      logEvent(dataDir, "task_blocked", { task: tid, reason });
    }
    process.stdout.write(`${tid}: ${fromStatus} -> ${toStatus}\n`);
  });
}

/**
 * `task append-verify <TID> iteration=<N> command="<cmd>" exit=<code>
 *   capture=<path> [at=<ISO>]` — append a structured entry to the task's
 * `verify_history:` block sequence (NOT a flow array — entries are
 * mappings, so this uses appendBlockListEntry rather than
 * getArrayField/setArrayField). Refuses a duplicate `iteration` (the
 * operational-task retry loop must not silently overwrite a prior attempt's
 * record).
 */
function taskAppendVerify(dataDir, args) {
  const tid = args[0];
  const kv = {};
  for (const a of args.slice(1)) {
    const eq = a.indexOf("=");
    if (eq <= 0) fail(2, `spec-state: unrecognized argument "${a}" — expected k=v`);
    kv[a.slice(0, eq)] = a.slice(eq + 1);
  }
  if (!tid || !("iteration" in kv) || !("command" in kv) || !("exit" in kv) || !("capture" in kv)) {
    fail(2, 'usage: task append-verify <TID> iteration=<N> command="<cmd>" exit=<code> capture=<path> [at=<ISO>]');
  }
  const iteration = Number(kv.iteration);
  if (!Number.isInteger(iteration)) fail(3, `spec-state: iteration must be an integer (got "${kv.iteration}")`);
  const exitCode = Number(kv.exit);
  if (!Number.isInteger(exitCode)) fail(3, `spec-state: exit must be an integer (got "${kv.exit}")`);
  const at = kv.at || new Date().toISOString();

  withNamedLock(dataDir, `task-${tid}`, () => {
    const path = resolveTaskFile(dataDir, tid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${tid} has no frontmatter block — refusing`);

    const existingIterations = parseBlockIterations(fm.block, "verify_history");
    if (existingIterations.includes(iteration)) {
      fail(3, `spec-state: verify_history already has an entry for iteration=${iteration} — refusing duplicate`);
    }

    const entryLines = [
      `  - iteration: ${iteration}`,
      `    command: ${JSON.stringify(kv.command)}`,
      `    exit: ${exitCode}`,
      `    capture: ${JSON.stringify(kv.capture)}`,
      `    at: ${JSON.stringify(at)}`,
    ];
    const block = appendBlockListEntry(fm.block, "verify_history", entryLines);
    writeFrontmatteredFile(path, fm, block);
    logEvent(dataDir, "task_verify_appended", { task: tid, iteration, exit: exitCode });
    process.stdout.write(`${tid}: verify_history +iteration ${iteration}\n`);
  });
}

// --- config commands ---------------------------------------------------------

// CLI-key (hyphenated, matches the command-line spelling) -> descriptor.
// `parent` absent/null => top-level scalar (setScalar's existing flat-key
// path). `parent` present => the key is nested one level under a
// `<parent>:` block (e.g. `worktree_warm:` / `test_commands:`) — config.md's
// frontmatter is NOT flat, so those need the nested setters below rather
// than the flat setScalar/setArrayField pair. `type` picks the setter:
// "scalar" (free-text, incl. commands with spaces/flags), "bool"
// (true/false only), "array" (comma-separated CLI value -> a rendered
// flow-style YAML array).
const CONFIG_SET_ALLOWLIST = {
  "product-spec-path": { fmKey: "product_spec_path", type: "scalar" },
  "worktree-warm-enabled": { parent: "worktree_warm", fmKey: "enabled", type: "bool" },
  "worktree-warm-paths": { parent: "worktree_warm", fmKey: "paths", type: "array" },
  "test-commands-rerun-failed": { parent: "test_commands", fmKey: "rerun_failed", type: "scalar" },
};

/**
 * Set (or append) a scalar `key: value` line nested one level under a
 * `<parent>:` block, preserving a trailing `# comment` on the line if one
 * was already there. Mirrors shipyard-data.mjs's configSetModel nested-
 * block scan (used for the `models:` block) — kept as a separate small
 * copy here rather than a shared import because the two modules
 * deliberately don't import each other's config-mutation internals (only
 * shipyard-data.mjs's `main()` dispatches into spec-state-cli's `configSet`
 * for the generic `config set` verb; each CLI owns its own writers).
 * Creates the parent block (with just this one key) if it doesn't exist
 * yet — a project initialized before a key existed should still be able to
 * opt in via this CLI rather than requiring a full re-init.
 */
function setNestedScalar(block, parentKey, key, value, { append = false } = {}) {
  const lines = block.split("\n");
  const startIdx = lines.findIndex((l) => new RegExp(`^${parentKey}:\\s*$`).test(l));
  if (startIdx === -1) {
    return block.replace(/\s*$/, "") + `\n${parentKey}:\n  ${key}: ${value}`;
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  let found = false;
  for (let i = startIdx + 1; i < endIdx; i++) {
    const m = lines[i].match(new RegExp(`^(\\s+${key}:)(.*)$`));
    if (m) {
      const trailingComment = (m[2].match(/(\s+#.*)$/) || [])[1] || "";
      lines[i] = `${m[1]} ${value}${trailingComment}`;
      found = true;
      break;
    }
  }
  // `append` puts a new key at the END of the parent's span rather than
  // directly under the parent line. Used where the block has a defining
  // prefix that should stay on top (user_flow_probe's kind/command/steps)
  // and appended keys are a growing record (last_verdict/…). Safe against a
  // trailing block scalar: the new line's 2-space indent terminates it.
  if (!found) lines.splice(append ? endIdx : startIdx + 1, 0, `  ${key}: ${value}`);
  return lines.join("\n");
}

/** setNestedScalar, inserting a new key at the end of the parent's span. */
function setNestedScalarAppend(block, parentKey, key, value) {
  return setNestedScalar(block, parentKey, key, value, { append: true });
}

/** Same as setNestedScalar, but for a flow-style array field (`paths: [...]`). */
function setNestedArray(block, parentKey, key, arr) {
  const rendered = `[${arr.map((s) => JSON.stringify(s)).join(", ")}]`;
  const lines = block.split("\n");
  const startIdx = lines.findIndex((l) => new RegExp(`^${parentKey}:\\s*$`).test(l));
  if (startIdx === -1) {
    return block.replace(/\s*$/, "") + `\n${parentKey}:\n  ${key}: ${rendered}`;
  }
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  let found = false;
  for (let i = startIdx + 1; i < endIdx; i++) {
    const m = lines[i].match(new RegExp(`^(\\s+${key}:)\\s*\\[[^\\]]*\\](\\s*#.*)?$`));
    if (m) {
      lines[i] = `${m[1]} ${rendered}${m[2] ?? ""}`;
      found = true;
      break;
    }
  }
  if (!found) lines.splice(startIdx + 1, 0, `  ${key}: ${rendered}`);
  return lines.join("\n");
}

/**
 * `config set <key> <value>` — generic sibling to `config set-model`
 * (shipyard-data.mjs) for allowlisted config.md fields that aren't part of
 * the `models:` block. Model hand-Edits of config.md frontmatter are the
 * corruption class this CLI exists to prevent — every settable field goes
 * through a descriptor here rather than a free-form Edit.
 *
 *   config set product-spec-path docs/spec/
 *   config set worktree-warm-enabled true
 *   config set worktree-warm-paths ".gradle,build,target"
 *   config set test-commands-rerun-failed "--onlyFailures"
 */
function configSet(dataDir, args) {
  const cliKey = args[0];
  const value = args[1];
  const allowedList = () => Object.keys(CONFIG_SET_ALLOWLIST).join(", ");
  if (!cliKey || value === undefined) {
    fail(2, `usage: config set <key> <value>. Allowed keys: ${allowedList()}`);
  }
  const descriptor = CONFIG_SET_ALLOWLIST[cliKey];
  if (!descriptor) {
    fail(2, `spec-state: config set: unknown key "${cliKey}". Allowed: ${allowedList()}`);
  }
  const { parent, fmKey, type } = descriptor;

  let writtenValue = value;
  let arrayValue = null;
  if (type === "bool") {
    if (value !== "true" && value !== "false") {
      fail(2, `spec-state: config set: "${cliKey}" is boolean — expected true|false, got "${value}"`);
    }
    writtenValue = value;
  } else if (type === "array") {
    arrayValue = value.split(",").map((s) => s.trim()).filter(Boolean);
  }

  const configPath = join(dataDir, "config.md");
  if (!existsSync(configPath)) fail(1, `spec-state: no ${configPath} — run shipyard-data onboarding bootstrap first`);
  const content = readFileSync(configPath, "utf8");
  const fm = parseFm(content);
  if (!fm) fail(1, "spec-state: config.md has no frontmatter block — refusing");

  let block;
  if (type === "array") {
    block = parent ? setNestedArray(fm.block, parent, fmKey, arrayValue) : setArrayField(fm.block, fmKey, arrayValue);
  } else if (parent) {
    block = setNestedScalar(fm.block, parent, fmKey, writtenValue);
  } else {
    block = setScalar(fm.block, fmKey, writtenValue);
  }
  writeFrontmatteredFile(configPath, fm, block);

  const loggedKey = parent ? `${parent}.${fmKey}` : fmKey;
  logEvent(dataDir, "config_set", { key: loggedKey });
  process.stdout.write(`config: ${loggedKey} = ${type === "array" ? `[${arrayValue.join(", ")}]` : writtenValue}\n`);
}

// --- draft/checkpoint state -------------------------------------------------

function draftObsoleteResearch(dataDir, args) {
  const topicIdx = args.indexOf("--topic");
  const expectedTopic = topicIdx !== -1 ? args[topicIdx + 1] : null;
  const path = join(dataDir, "spec", ".research-draft.md");
  if (!existsSync(path)) fail(4, `spec-state: no ${path}`);

  withNamedLock(dataDir, "research-draft", () => {
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, "spec-state: .research-draft.md has no frontmatter block — refusing");
    if (expectedTopic) {
      const actualTopic = (getScalar(fm.block, "topic") ?? "").replace(/^["']|["']$/g, "");
      if (actualTopic !== expectedTopic) {
        fail(3, `spec-state: .research-draft.md topic is ${JSON.stringify(actualTopic)}, expected ${JSON.stringify(expectedTopic)}`);
      }
    }
    const block = setScalar(fm.block, "obsolete", "true");
    writeFrontmatteredFile(path, fm, block);
    logEvent(dataDir, "research_draft_obsoleted", { topic: expectedTopic ?? null });
    process.stdout.write(".research-draft.md obsolete: true\n");
  });
}

function draftSetSprintStatus(dataDir, args) {
  const status = args[0];
  const allowed = new Set(["superseded", "cancelled"]);
  if (!status || !allowed.has(status)) {
    fail(2, "usage: draft set-sprint-status <superseded|cancelled>");
  }
  const path = join(dataDir, "sprints", "current", "SPRINT-DRAFT.md");
  if (!existsSync(path)) fail(4, `spec-state: no ${path}`);

  withNamedLock(dataDir, "sprint-draft", () => {
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, "spec-state: SPRINT-DRAFT.md has no frontmatter block — refusing");
    const block = setScalar(fm.block, "status", status);
    writeFrontmatteredFile(path, fm, block);
    logEvent(dataDir, "sprint_draft_status_set", { status });
    process.stdout.write(`SPRINT-DRAFT.md status: ${status}\n`);
  });
}

// --- dispatch ----------------------------------------------------------------

function dispatch(dataDir, entity, sub, rest) {
  if (entity === "feature") {
    switch (sub) {
      case "set-status":
        return featureSetStatus(dataDir, rest);
      case "set":
        return featureSet(dataDir, rest);
      case "add-ref":
        return featureAddRef(dataDir, rest);
      case "add-external-ref":
        return featureAddExternalRef(dataDir, rest);
      case "add-dep":
        return featureDepLink(dataDir, rest, { add: true });
      case "remove-dep":
        return featureDepLink(dataDir, rest, { add: false });
      case "clear-tasks":
        return featureClearTasks(dataDir, rest);
      case "set-tasks":
        return featureSetTasks(dataDir, rest);
      case "record-proof":
        return featureRecordProof(dataDir, rest);
      case "check-probes":
        return featureCheckProbes(dataDir, rest);
      default:
        fail(2, `shipyard-data feature: unknown subcommand "${sub ?? ""}". Expected: set-status|set|add-ref|add-external-ref|add-dep|remove-dep|set-tasks|clear-tasks|record-proof|check-probes`);
    }
  } else if (entity === "backlog") {
    switch (sub) {
      case "add":
        return backlogAdd(dataDir, rest);
      case "remove":
        return backlogRemove(dataDir, rest);
      case "rank":
        return backlogRank(dataDir);
      case "set":
        return backlogSet(dataDir, rest);
      default:
        fail(2, `shipyard-data backlog: unknown subcommand "${sub ?? ""}". Expected: add|remove|rank|set`);
    }
  } else if (entity === "idea") {
    switch (sub) {
      case "set-status":
        return ideaSetStatus(dataDir, rest);
      default:
        fail(2, `shipyard-data idea: unknown subcommand "${sub ?? ""}". Expected: set-status`);
    }
  } else if (entity === "task") {
    switch (sub) {
      case "set-status":
        return taskSetStatus(dataDir, rest);
      case "append-verify":
        return taskAppendVerify(dataDir, rest);
      default:
        fail(2, `shipyard-data task: unknown subcommand "${sub ?? ""}". Expected: set-status|append-verify`);
    }
  } else if (entity === "config") {
    switch (sub) {
      case "set":
        return configSet(dataDir, rest);
      default:
        fail(2, `shipyard-data config: unknown subcommand "${sub ?? ""}" (via spec-state-cli). Expected: set`);
    }
  } else if (entity === "draft") {
    switch (sub) {
      case "obsolete-research":
        return draftObsoleteResearch(dataDir, rest);
      case "set-sprint-status":
        return draftSetSprintStatus(dataDir, rest);
      default:
        fail(2, `shipyard-data draft: unknown subcommand "${sub ?? ""}". Expected: obsolete-research|set-sprint-status`);
    }
  } else {
    fail(2, `shipyard-data: unknown entity "${entity ?? ""}". Expected: feature|backlog|idea|task|config|draft`);
  }
}

/**
 * Entry point called from shipyard-data.mjs's main(). All validation
 * failures throw CliFail (see above) instead of calling process.exit
 * directly, so every withLockfile finally block runs before the process
 * actually exits. This is the one place that turns a CliFail into a real
 * exit code.
 */
export function specStateCmd(dataDir, args) {
  const [entity, sub, ...rest] = args;
  try {
    dispatch(dataDir, entity, sub, rest);
  } catch (err) {
    if (err instanceof CliFail) {
      process.stderr.write(err.message.endsWith("\n") ? err.message : err.message + "\n");
      process.exit(err.code);
    }
    if (err && err.code === "ELOCKTIMEOUT") {
      // Lock contention exhausted its retries (withLockfile no longer fails
      // open). Surface a clean message + exit 3 rather than a raw stack trace.
      process.stderr.write(`spec-state: ${err.message} — another process holds it; retry shortly.\n`);
      process.exit(3);
    }
    throw err;
  }
}
