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

import { spawnSync as spawnSyncForGit } from "node:child_process";
import { main as probeCommandMain, readProbeCommand, trailingSuite } from "./probe-command.mjs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { logEvent, withLockfile } from "./_hook_lib.mjs";
import { parseFrontmatterList } from "./frontmatter-list.mjs";
import { readRequireParkEvidence } from "./config-read.mjs";
import { FINDING_KINDS, FINDING_SEVERITIES } from "./sprint-findings.mjs";
import { readDesign } from "./design.mjs";
import { designSystemOwed } from "./design-system.mjs";
import { planGateProblems } from "./plan-score.mjs";
import "./probes-at-base.mjs"; // registers the probe check with the plan gate
import { approvalProblems as openQuestionProblems } from "./discuss-questions.mjs";
import { ideaPromote } from "./idea-promote.mjs";
import { storyAdd, storyRefine, taskAdd } from "./record-add.mjs";
import { setFixVersion } from "./version.mjs";
import { sprintStoryIds as planSprintStoryIds } from "./terminal-gate.mjs";

/** A UI story's design decision is on record: an approval (hash) or a waiver. */
function designDecided(block) {
  const d = readDesign(block);
  return Boolean(d && (d.hash || d.waived));
}
import {
  BACKLOG_REMOVING_STATUSES,
  STORY_TRANSITIONS,
  LEGACY_BUG_STATUS_ALIASES,
  IDEA_TRANSITIONS,
  IDEA_STATUS_ALIASES,
  EPIC_TRANSITIONS,
  TASK_TRANSITIONS,
  normalizeStatus,
  validateStatusTransition,
} from "./spec-lifecycle.mjs";
import {
  ENTITIES,
  STORY_ID_RE,
  LEGACY_FEATURE_ID_RE,
  LEGACY_BUG_ID_RE,
  HOTFIX_ID_RE,
  isStoryId as isStoryIdVocab,
  STEP_ID_RE,
  TASK_ID_RE,
  QUICK_ID_RE,
  EPIC_ID_RE,
  entityForVerb,
  isBuilderRecord,
  canonicalEventType,
  TASK_KINDS,
} from "./vocab.mjs";

// v4 (F022): every mutating subcommand emits through the vocabulary table so
// writers always use the new event names (patch_step_created, story_*) while
// the historical log keeps the old ones untouched.
const emit = (dataDir, type, fields) => logEvent(dataDir, canonicalEventType(type), fields);
const FEATURE_TRANSITIONS = STORY_TRANSITIONS;

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
    // function replacer: a value containing `$&` / `$1` must be written literally
    return block.replace(lineRe, () => `${key}: ${value}`);
  }
  return block.replace(/\s*$/, "") + `\n${key}: ${value}`;
}

/**
 * Read a list field via the shared tolerant helper. Inline `[a, b]` lists —
 * single- or multi-line — and absent/empty keys are safe to rewrite; block
 * (`- a`) and bare (`a, b`) forms are REFUSED (exit 3) so a rewrite can never
 * silently drop data.
 */
function getArrayField(block, key) {
  const { items, form } = parseFrontmatterList(block, key);
  // A multiline inline list (`[a,\n b]`) is complete and rewrites safely as one line.
  if (form === "block" || form === "bare") {
    fail(
      3,
      `spec-state: "${key}" is a ${form} list — refusing to rewrite it (would risk data loss). Convert it to inline form \`${key}: [a, b]\` first.`,
    );
  }
  return items;
}

/** Set an inline flow-style array field, preserving a trailing `# comment`. Never appends a duplicate key. */
function setArrayField(block, key, arr) {
  const { form } = parseFrontmatterList(block, key);
  if (form === "block" || form === "bare") {
    fail(3, `spec-state: "${key}" is a ${form} list — refusing to overwrite it. Convert it to inline form \`${key}: [a, b]\` first.`);
  }
  const rendered = `[${arr.join(", ")}]`;
  // Existing key line, inline or valueless (`key:` / `key: # c`): replace in place.
  const re = new RegExp(`^(${escapeRe(key)}\\s*:)(?:[ \\t]*\\[[^\\]]*\\]|[ \\t]*(?=#|$))(\\s*#.*)?$`, "m");
  if (re.test(block)) {
    return block.replace(re, (_full, prefix, comment) => `${prefix} ${rendered}${comment ?? ""}`);
  }
  if (new RegExp(`^${escapeRe(key)}\\s*:`, "m").test(block)) {
    fail(3, `spec-state: "${key}" has an unrecognised value form — refusing to append a duplicate key`);
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

/**
 * Feature ids come in two shapes:
 *   F004   — a plain feature, what `next-id features` allocates.
 *   F071d  — a CHILD / sub-feature: the parent's number plus one lowercase
 *            letter suffix.
 *
 * The child form is a documented, first-class convention, not an ad-hoc
 * spelling: `project-files/rules/shipyard-spec.md` shows `F001a`/`F001b`/
 * `F001c` as the canonical split, and ship-discuss's 200-line limit tells
 * authors to "split into sub-features (F001a, F001b)". Real projects carry
 * `F036a`, `F071a`..`F071e` on disk. But this regex only ever accepted
 * `F\d{3}`, so `backlog add F071d` was refused and the backlog index had to
 * be hand-edited — logged as a known bug seven times in one project's
 * BACKLOG.md Overrides section before it was fixed.
 *
 * Exactly one lowercase letter: `next-id`'s allocator matches `^F0*(\d+)`
 * and a multi-letter or uppercase suffix appears nowhere in the repo or the
 * docs, so widening further would accept ids nothing else can produce.
 */
// v4 (F022): a story id is S### (new), or a legacy F###/B###/B-HOT-### alias
// (terminology-v4 I-2, I-4); a builder-unit id is P### (step) or a legacy T###.
const isStoryId = isStoryIdVocab; // one definition (vocab.mjs); every CLI accepts the same story spellings
const FID_RE = { test: isStoryId };
const IDEA_ID_RE = /^IDEA-\d{3,}$/;
const TID_RE = { test: (id) => STEP_ID_RE.test(id) || TASK_ID_RE.test(id) || QUICK_ID_RE.test(id) };
const STORY_ID_HINT = "expected S### (or a legacy F###, F###<letter>, B### alias), e.g. S004, F071d";
const UNIT_ID_HINT = "expected P### (step) or T### (task), e.g. P004, T012";

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

/**
 * Resolve a story by id across its directories: S### under spec/stories/,
 * legacy F### under spec/features/, legacy B###/B-HOT-### under spec/bugs/
 * (terminology-v4 A-01, A-04, A-05: legacy records are read in place).
 */
function resolveFeatureFile(dataDir, fid, opts) {
  if (!isStoryId(fid)) fail(2, `spec-state: invalid story id "${fid}" — ${STORY_ID_HINT}`);
  const subdirs = STORY_ID_RE.test(fid) ? ["stories"] : LEGACY_FEATURE_ID_RE.test(fid) ? ["features", "stories"] : ["bugs", "stories"];
  for (let i = 0; i < subdirs.length; i++) {
    const last = i === subdirs.length - 1;
    const hit = resolveEntityFile(dataDir, subdirs[i], fid, { optional: !last || opts?.optional });
    if (hit) return hit;
  }
  return null;
}
const resolveStoryFile = resolveFeatureFile;

function resolveIdeaFile(dataDir, ideaId, opts) {
  if (!IDEA_ID_RE.test(ideaId)) fail(2, `spec-state: invalid idea id "${ideaId}" — expected IDEA-### (e.g. IDEA-045)`);
  return resolveEntityFile(dataDir, "ideas", ideaId, opts);
}

function epicExists(dataDir, epicId) {
  if (!EPIC_ID_RE.test(epicId)) return false;
  return resolveEntityFile(dataDir, "epics", epicId, { optional: true }) !== null;
}

/** Resolve a builder unit or task: P### under spec/steps/, T### / Q-### under spec/tasks/. */
function resolveTaskFile(dataDir, tid, opts) {
  if (!TID_RE.test(tid)) fail(2, `spec-state: invalid id "${tid}" — ${UNIT_ID_HINT}`);
  return resolveEntityFile(dataDir, STEP_ID_RE.test(tid) ? "steps" : "tasks", tid, opts);
}

function validateTaskId(tid) {
  if (!TID_RE.test(tid)) fail(2, `spec-state: invalid id "${tid}" — ${UNIT_ID_HINT}`);
}

function resolveEpicFile(dataDir, eid, opts) {
  if (!EPIC_ID_RE.test(eid)) fail(2, `spec-state: invalid epic id "${eid}" — expected E### (e.g. E002)`);
  return resolveEntityFile(dataDir, "epics", eid, opts);
}

// --- RICE ------------------------------------------------------------------

/**
 * RICE score for a feature id, or `{ score: null, missing: [...] }`.
 *
 * Never throws on a bad id. This is called once per EXISTING backlog row by
 * `backlog add` and `backlog rank`, so a hard `fail()` here is whole-index
 * validation: a single malformed row anywhere in BACKLOG.md would refuse
 * every future add and every re-rank, with an error naming an id the caller
 * never mentioned. That is what made the `F071d` refusal so sticky — the
 * widened FID_RE fixes the specific id, but one typo'd row would still
 * deadlock the whole file. Pre-existing junk is now reported as a warning by
 * the callers and sunk to the bottom of the index alongside the other
 * unscoreable rows; only the entry actually being added is hard-validated.
 */
function readFeatureRice(dataDir, fid) {
  if (!FID_RE.test(fid)) return { score: null, missing: ["invalid_id"] };
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
  return (reach * impact * riceConfidence(confidence)) / effort;
}
/**
 * Confidence as a share of 1. The spec text asks for a percentage (0 to 100) and the score multiplied it as it
 * stood, so `rice_confidence=70` gave 840 where the same story scored by hand had 8.4 (after 4.0.2, live: three
 * stories outranked their siblings a hundredfold and a session "fixed" the score by hand). Above 1 is a percentage.
 */
export function riceConfidence(c) {
  return c > 1 ? c / 100 : c;
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

/**
 * Whose order the backlog is in (after 4.0.0). LeSS: one list, ordered by the product owner by what a delay
 * costs; a score is a first sort, never the last word. `backlog/order.json` (CLI-owned) records that the
 * owner has placed items (`ordered_by: "owner"`) and each placement's one-line reason ("why here"). From then
 * on nothing re-sorts the list by score behind their back: a new item goes to the bottom, and `backlog rank`
 * refuses unless asked for by name.
 */
function orderPath(dataDir) { return join(dataDir, "backlog", "order.json"); }
export function readOrder(dataDir) {
  try { const o = JSON.parse(readFileSync(orderPath(dataDir), "utf8")); return { ordered_by: o.ordered_by === "owner" ? "owner" : "score", why: o.why && typeof o.why === "object" ? o.why : {} }; }
  catch { return { ordered_by: "score", why: {} }; }
}
function writeOrder(dataDir, o) { atomicWriteFile(orderPath(dataDir), JSON.stringify(o, null, 2) + "\n"); }

function backlogMove(dataDir, args) {
  const usage = 'usage: backlog move <id> [<id>...] (--top | --bottom | --above <id> | --below <id> | --to <n>) --why "<what a delay of this item costs, in one line>"   (several ids move together and keep the order given)';
  const val = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : undefined; };
  // Several ids move as one block, in the order given (after 4.0.2, live: five stories moved one by one with
  // `--below <the first>` ended up in reverse order, and the session moved all of them again).
  const firstFlag = args.findIndex((a) => a.startsWith("--"));
  const ids = [...new Set((firstFlag === -1 ? args : args.slice(0, firstFlag)).flatMap((a) => a.split(",")).map((a) => a.trim()).filter(Boolean))];
  const why = String(val("--why") ?? "").replace(/\s+/g, " ").trim();
  const modes = [args.includes("--top"), args.includes("--bottom"), val("--above") !== undefined, val("--below") !== undefined, val("--to") !== undefined].filter(Boolean).length;
  if (!ids.length || modes !== 1) fail(2, usage);
  if (why.length < 10) fail(2, `spec-state: backlog move needs --why: one line on what a delay of this item costs (who is hurt, how much, how soon)\n  ${usage}`);
  withNamedLock(dataDir, "backlog", () => {
    const b = parseBacklog(dataDir);
    const was = new Map(ids.map((id) => [id, b.ids.indexOf(id)]));
    const missing = ids.filter((id) => was.get(id) === -1);
    if (missing.length) fail(3, `spec-state: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on the backlog (${b.ids.join(", ") || "empty"}). Add an approved story with: backlog add ${missing[0]}`);
    const rest = b.ids.filter((x) => !ids.includes(x));
    let at;
    if (args.includes("--top")) at = 0;
    else if (args.includes("--bottom")) at = rest.length;
    else if (val("--to") !== undefined) { const n = Number(val("--to")); if (!Number.isInteger(n) || n < 1) fail(2, "spec-state: --to takes a position, 1 for the top"); at = Math.min(n - 1, rest.length); }
    else { const ref = val("--above") ?? val("--below"); const k = rest.indexOf(ref); if (k === -1) fail(3, `spec-state: ${ref} is not on the backlog${ids.includes(ref) ? " apart from the items being moved" : ""}`); at = val("--above") !== undefined ? k : k + 1; }
    rest.splice(at, 0, ...ids);
    b.ids = rest;
    serializeBacklog(b);
    const o = readOrder(dataDir);
    o.ordered_by = "owner";
    for (const id of ids) o.why[id] = { text: why.slice(0, 300), at: today() };
    for (const k of Object.keys(o.why)) if (!b.ids.includes(k)) delete o.why[k];
    writeOrder(dataDir, o);
    ids.forEach((id, n) => emit(dataDir, "backlog_moved", { id, from: was.get(id) + 1, to: at + n + 1, why: why.slice(0, 300) }));
    const end = at + ids.length - 1;
    const what = ids.length === 1 ? `${ids[0]} is now ${at + 1} of ${b.ids.length}` : `${ids.join(", ")} are now ${at + 1} to ${end + 1} of ${b.ids.length}, in that order`;
    process.stdout.write(`backlog: ${what}${at > 0 ? `, after ${b.ids[at - 1]}` : ", at the top"}${end < b.ids.length - 1 ? ` and before ${b.ids[end + 1]}` : ""}. The backlog is in your order from here on: a new story goes to the bottom until you place it.\n`);
  });
}

function serializeBacklog({ path, fm, preTable, ids, tail }) {
  const rows = ids.map((id, i) => `| ${i + 1} | ${id} |`).join("\n");
  const body = preTable + rows + (rows ? "\n" : "") + tail;
  const content = fm.open + fm.block + fm.close + body;
  atomicWriteFile(path, content);
}

// --- feature commands -------------------------------------------------------

function featureSetStatus(dataDir, args) {
  // Positionals only — a flag must never be read as the id or the status.
  // `feature set-status F001 --force done` used to bind toStatus="--force",
  // which `--force` then waved past the transition graph: the CLI wrote
  // `status: --force` into the feature file and exited 0.
  // `--reason` and `--replaced-by` take a value; it is lifted out first so it
  // is never read as the id or the status.
  let reason = "";
  let replacedBy = [];
  const bare = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reason") reason = String(args[++i] ?? "").trim();
    else if (args[i] === "--replaced-by") replacedBy = String(args[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else bare.push(args[i]);
  }
  const positional = bare.filter((a) => !a.startsWith("--"));
  const fid = positional[0];
  const toStatus = positional[1];
  const force = args.includes("--force");
  if (!fid || !toStatus) fail(2, "usage: story set-status <SID> <status> [--force] [--reason \"<why>\"] [--replaced-by <SID,SID>]");
  // Vocabulary check runs BEFORE (and independently of) --force. --force
  // overrides the transition GRAPH — which edges are legal — not the set of
  // statuses that exist at all. Writing an unknown status is never a
  // successful flip, and every downstream reader (backlog auto-removal,
  // sprint gates, ship-status) keys off this exact vocabulary.
  if (!Object.prototype.hasOwnProperty.call(FEATURE_TRANSITIONS, toStatus)) {
    fail(
      2,
      `spec-state: unknown story status "${toStatus}". Allowed: ${Object.keys(FEATURE_TRANSITIONS).join(", ")}`,
    );
  }

  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${fid} has no frontmatter block — refusing`);
    // A legacy bug record's `open` reads as `proposed` (spec-lifecycle alias).
    const fromStatus = normalizeStatus(LEGACY_BUG_STATUS_ALIASES, getScalar(fm.block, "status"));
    // v4: an imported (tracker pull) or captured story carries `refined: false`
    // until /ship-discuss refines it; such a story is never sprint-ready, so it
    // cannot be approved (and therefore cannot enter the backlog) — F027 AC-3.
    if (toStatus === "approved" && String(getScalar(fm.block, "refined") ?? "").replace(/\s+#.*$/, "").trim() === "false") {
      fail(3, `spec-state: ${fid} is unrefined (refined: false) — refine it with /ship-discuss ${fid} before approving; an imported ticket is never sprint-ready until refined`);
    }
    // E005: a UI story needs its design decision BEFORE it is sprint-ready —
    // approved (`design approve`) or explicitly waived (`design waive`). Found
    // live: /ship-discuss skipped the DESIGN stage in prose, /ship-sprint's
    // Check 25 then refused the story, and the user was sent back to discuss.
    if (toStatus === "approved" && /^ui:\s*true\b/m.test(fm.block) && !designDecided(fm.block)) {
      fail(3, `spec-state: ${fid} is a UI story (ui: true) with no design decision — run the DESIGN stage: shipyard-data design approve ${fid} --file <snapshot>, or shipyard-data design waive ${fid} --reason "<why>"`);
    }
    // A screen belongs to a design system, and the project says which, once: one
    // it defined, its own, or none (the owner's word). Asked for every UI story,
    // with or without a mock-up: the first live run answered "no mock-up" (the
    // recommended choice for a small change), so a fresh project built its
    // screen with no system at all. A waiver is about the picture, not the system.
    if (toStatus === "approved" && /^ui:\s*true\b/m.test(fm.block)) {
      const owed = designSystemOwed(dataDir);
      if (owed) fail(3, `spec-state: ${fid} changes what a person sees, and ${owed}`);
    }
    // Behaviour-first (4.15.3): a story is approved from `proposed` only when
    // its scenarios follow the rules (ids, one level tag each, a reason below
    // the journey, a path map naming every scenario). The rule was first a
    // reference text, then a separate check the lanes were told to run; the
    // idea and chained lanes approved a story without either. Approval is the
    // one call every lane makes. Not applied to a hotfix (minimal ceremony),
    // to a story coming back from a sprint, or with `spec.behaviour_first: false`.
    // The same check where a story enters a sprint (approved -> in-progress):
    // a story approved before the rule is brought to it by the planner, never
    // by a builder. Sprint planning's check 24b says to do this earlier; this
    // is the call it cannot get past.
    const entering = (toStatus === "approved" && fromStatus === "proposed") || (toStatus === "in-progress" && fromStatus === "approved");
    if (entering && behaviourFirstOn(dataDir) && !/^lane:\s*hotfix\b/m.test(fm.block)) {
      const problems = scenarioProblems(content);
      if (problems.length) {
        fail(3, `spec-state: ${fid} cannot ${toStatus === "approved" ? "be approved" : "enter a sprint"} yet — its scenarios do not start from the behaviour:\n${problems.map((p) => `  - ${p}`).join("\n")}\n  Rules: skills/tdd-cycle/references/test-economy.md. Fix the story, then run this again (shipyard-data story check-scenarios ${fid} shows the same list).`);
      }
    }
    // The question list (4.20): a story is not approved while its discussion
    // still has a question waiting, research running, or an answer the
    // researcher never read. Only the topic bound to this story counts.
    if (toStatus === "approved" && fromStatus === "proposed") {
      const waiting = openQuestionProblems(dataDir, fid);
      if (waiting.length) fail(3, `spec-state: ${fid} cannot be approved yet — its discussion is not finished:\n${waiting.map((p) => `  - ${p}`).join("\n")}`);
    }
    // The plan gate (4.19): a story enters a sprint only when that sprint's
    // plan has no step later than it has to be, no two steps of one wave on
    // the same file, and no solo mode over a wide wave. The planner shows
    // `sprint plan-score` before approval; this is the call it cannot get past.
    if (toStatus === "in-progress" && fromStatus === "approved" && !/^lane:\s*hotfix\b/m.test(fm.block)) {
      let listed = false;
      try { listed = planSprintStoryIds(readFileSync(join(dataDir, "sprints", "current", "SPRINT.md"), "utf8")).includes(fid); } catch { listed = false; }
      const planProblems = listed ? planGateProblems(dataDir) : [];
      if (planProblems.length) {
        fail(3, `spec-state: ${fid} cannot enter the sprint yet — the plan can be more parallel or is not safe to run in parallel:\n${planProblems.map((p) => `  - ${p}`).join("\n")}\n  See it whole: shipyard-data sprint plan-score. Fix the plan (waves, \`dependencies:\`, \`touches:\`), never the check. The owner can turn it off with \`execution.parallel_plan: false\`.`);
      }
    }
    const check = validateStatusTransition(FEATURE_TRANSITIONS, fromStatus, toStatus);
    if (!check.ok && !force) {
      const known = FEATURE_TRANSITIONS[fromStatus];
      fail(
        3,
        `spec-state: illegal story status transition ${fromStatus} -> ${toStatus} for ${fid}. ` +
          `Valid next states from "${fromStatus}": ${known ? (known.length ? known.join(", ") : "(none — terminal)") : "(unknown status)"}. ` +
          `Re-run with --force to override the graph (side effects still apply).`,
      );
    }

    let block = setScalar(fm.block, "status", toStatus);
    block = setScalar(block, "updated", today());
    // Why it ended and what replaced it (4.0), for a story that is retired or put off.
    if (reason && ["rejected", "deferred"].includes(toStatus)) block = setScalar(block, "status_reason", JSON.stringify(reason.slice(0, 300)));
    if (replacedBy.length && toStatus === "rejected") block = setArrayField(block, "replaced_by", replacedBy);
    // The release date is the CLI's to write (4.13.3): the release step told
    // the model to `story set released_at=`, a key `story set` refuses, so
    // stories were released with no date.
    if (toStatus === "released" && !/^released_at:\s*\S/m.test(block)) block = setScalar(block, "released_at", today());
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

    emit(dataDir, "feature_status_changed", {
      story: fid,
      feature: fid,
      from: fromStatus,
      to: toStatus,
      forced: !check.ok && force,
      ...(reason && ["rejected", "deferred"].includes(toStatus) ? { reason: reason.slice(0, 180) } : {}),
      ...(replacedBy.length && toStatus === "rejected" ? { replaced_by: replacedBy.join(",") } : {}),
    });
    process.stdout.write(`${fid}: ${fromStatus} -> ${toStatus}\n`);
    // The story's epic follows its stories, now (4.0.1). It was only brought
    // in line by `reconcile` (at archive, at the next plan): in between, an
    // epic read "proposed" while its stories were being built.
    rollUpEpic(dataDir, String((fm.block.match(/^epic:\s*(.*)$/m) ?? [])[1] ?? "").replace(/^["']|["']$/g, "").trim());
    // Retiring a story (4.0): say where the project still names it. A story was
    // retired as "already built" while a code comment still read "placeholder
    // until <that story> lands", and the owner found the placeholder on the
    // device. A note, never a refusal: the mention may be history.
    if (toStatus === "rejected") {
      const where = projectMentions(dataDir, fid);
      if (where.length) {
        process.stderr.write(`note: the project still names ${fid} in ${where.length} file(s): ${where.slice(0, 6).join(", ")}${where.length > 6 ? ", ..." : ""}\n  Read them before the story is gone: a "until ${fid}" or "TODO ${fid}" line means work that nothing else covers now.\n`);
        emit(dataDir, "retired_story_still_named", { story: fid, files: where.slice(0, 6).join(","), count: where.length });
      }
    }
  });
}

function spawnSyncGit(args, cwd) {
  const r = spawnSyncForGit("git", args, { cwd, encoding: "utf8", timeout: 15000 });
  return r.status === 0 ? r.stdout : r.status === 1 ? "" : null; // git grep exits 1 when nothing matches
}

/**
 * Set an epic's status from its stories: every one finished -> done; any one
 * started or finished -> in-progress. Stories that were rejected or put off do
 * not count. A `done` epic with a story still to build goes back to
 * in-progress (the same rule `reconcile` applies). Quiet and
 * best-effort: a story's own status change never fails because of its epic.
 */
function rollUpEpic(dataDir, eid) {
  try {
    if (!eid) return;
    const path = resolveEntityFile(dataDir, "epics", eid, { optional: true });
    if (!path) return;
    const FINISHED = new Set(["done", "deployed", "released", "fixed"]);
    const statuses = [];
    for (const sub of ["stories", "features", "bugs"]) {
      let names = [];
      try { names = readdirSync(join(dataDir, "spec", sub)); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith(".md")) continue;
        let block = "";
        try { block = parseFm(readFileSync(join(dataDir, "spec", sub, n), "utf8"))?.block ?? ""; } catch { continue; }
        if (String((block.match(/^epic:\s*(.*)$/m) ?? [])[1] ?? "").replace(/^["']|["']$/g, "").trim() !== eid) continue;
        const st = String((block.match(/^status:\s*(\S+)/m) ?? [])[1] ?? "").trim();
        if (st && !["rejected", "deferred"].includes(st)) statuses.push(st);
      }
    }
    if (!statuses.length) return;
    const want = statuses.every((s) => FINISHED.has(s)) ? "done" : statuses.some((s) => s === "in-progress" || FINISHED.has(s)) ? "in-progress" : null;
    const content = readFileSync(path, "utf8");
    const efm = parseFm(content);
    if (!efm || !want) return;
    const cur = String((efm.block.match(/^status:\s*(\S+)/m) ?? [])[1] ?? "").trim();
    // A finished epic that gets a new story is no longer finished: it reopens.
    if (cur === want) return;
    writeFrontmatteredFile(path, efm, setScalar(setScalar(efm.block, "status", want), "updated", today()));
    emit(dataDir, "epic_status_changed", { epic: eid, from: cur, to: want, rolled_up: true });
    process.stdout.write(`${eid}: ${cur || "unset"} -> ${want} (follows its stories)\n`);
  } catch { /* best-effort */ }
}

/** Tracked project files that still contain this id as a whole word (best effort; [] when it cannot be told). */
function projectMentions(dataDir, id) {
  try {
    const root = readFileSync(join(dataDir, ".project-root"), "utf8").trim();
    if (!root || !/^[A-Za-z][A-Za-z0-9-]*$/.test(id)) return [];
    const r = spawnSyncGit(["grep", "-l", "-w", "-F", "-e", id], root);
    return r === null ? [] : r.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

const FEATURE_SET_ALLOWLIST = new Set([
  "ui",
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
  status: "use `story set-status <id> <status>` instead",
  id: "the id is fixed at creation — not settable",
  title: "title changes go through Edit on the feature file body/frontmatter directly (not CLI-owned)",
  tasks: "use `story set-steps <SID> <PID,PID,...>` or `story clear-steps <SID>` instead",
  steps: "use `story set-steps <SID> <PID,PID,...>` or `story clear-steps <SID>` instead",
  references: "use `story add-ref <id> <path>` to add one and `story remove-ref <id> <path>` to take one out",
  external_refs: "use `story add-external-ref <id> <key>` instead",
  fix_version: "use `shipyard-data version set <version> <id>` instead (the version must exist; a move needs --reason)",
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
  // `fix_version=<name>` is what a session reaches for (after 4.0.2, live: three tries before `version set`). It
  // goes through the version command's own rules: the version exists, and a move between versions needs a reason.
  if (kv.fix_version !== undefined) {
    try { setFixVersion(dataDir, kv.fix_version, [fid]); }
    catch (e) { fail(typeof e?.exitCode === "number" ? e.exitCode : 1, `spec-state: story set fix_version: ${e.message}${/needs --reason/.test(e.message) ? `\n  shipyard-data version set ${kv.fix_version} ${fid} --reason "<why>"` : ""}`); }
    process.stdout.write(`${fid}: fix version ${kv.fix_version}\n`);
    delete kv.fix_version;
    if (!Object.keys(kv).length) return;
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
  if ("ui" in kv && !["true", "false"].includes(kv.ui)) fail(3, `spec-state: ui must be true or false (got "${kv.ui}")`);
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
    emit(dataDir, "feature_field_set", { feature: fid, keys: Object.keys(kv).join(",") });
    // a story moved between epics: both follow their stories (4.0.1)
    if ("epic" in kv) {
      const was = String((fm.block.match(/^epic:\s*(.*)$/m) ?? [])[1] ?? "").replace(/^["']|["']$/g, "").trim();
      for (const e of new Set([was, kv.epic].filter(Boolean))) rollUpEpic(dataDir, e);
    }
    process.stdout.write(`${fid}: ${Object.keys(kv).join(", ")} updated\n`);
  });
}

/**
 * One spelling for comparing reference entries. A story's `references:` may
 * hold the same file as an absolute path or in the portable form the template
 * shows, `$(shipyard-data)/spec/references/<file>`. Seen on a real project
 * (4.0.0): the story was written with the portable form, `add-ref` then added
 * the absolute path beside it, and no verb could take either out.
 */
function refKey(dataDir, entry) {
  let e = String(entry ?? "").trim().replace(/^["']|["']$/g, "");
  e = e.replace(/^(\$\(shipyard-data\)|<SHIPYARD_DATA>|\$\{?SHIPYARD_DATA\}?)[\\/]/, "");
  const abs = isAbsolute(e) ? e : join(dataDir, e);
  try { return realpathSync(abs); } catch { return abs; }
}

function featureRemoveRef(dataDir, args) {
  const fid = args[0];
  const refPath = args[1];
  if (!fid || !refPath) fail(2, "usage: story remove-ref <id> <path>");
  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    const fm = parseFm(readFileSync(path, "utf8"));
    if (!fm) fail(3, `spec-state: ${fid} has no frontmatter block — refusing`);
    const existing = getArrayField(fm.block, "references");
    // The exact text first (one of two spellings of the same file can be taken out), then any spelling of that file.
    const exact = existing.filter((x) => x.replace(/^["']|["']$/g, "") === refPath);
    const gone = exact.length ? exact : existing.filter((x) => refKey(dataDir, x) === refKey(dataDir, refPath));
    if (!gone.length) fail(3, `spec-state: ${fid} has no reference ${refPath}. It lists: ${existing.join(", ") || "(none)"}`);
    writeFrontmatteredFile(path, fm, setArrayField(fm.block, "references", existing.filter((x) => !gone.includes(x))));
    emit(dataDir, "story_ref_removed", { feature: fid, path: refPath });
    process.stdout.write(`${fid}: removed reference ${gone.join(", ")} (the file itself is left in place)\n`);
  });
}

function featureAddRef(dataDir, args) {
  const fid = args[0];
  const refPath = args[1];
  if (!fid || !refPath) fail(2, "usage: story add-ref <id> <path>");
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
    const same = existing.find((x) => x === refPath || refKey(dataDir, x) === realTarget);
    if (same) {
      process.stdout.write(`${fid}: ${refPath} already in references${same === refPath ? "" : ` (as ${same})`} — no-op\n`);
      return;
    }
    const block = setArrayField(fm.block, "references", [...existing, refPath]);
    writeFrontmatteredFile(path, fm, block);
    emit(dataDir, "feature_ref_added", { feature: fid, path: refPath });
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
    emit(dataDir, "feature_external_ref_added", { feature: fid, key });
    process.stdout.write(`${fid}: added external ref ${key}\n`);
  });
}

/**
 * Dependency link/unlink between two records. `add-dep A B` means "A waits
 * for B": A's `dependencies:` gets B, and B's `dependents:` gets A, so either
 * file alone tells the whole story without a cross-file query.
 *
 * Until 4.0.0 the reverse side was written into B's `dependencies:` too, so
 * every link was a loop (A waits for B, B waits for A). An epic of eight
 * stories came out with every pair depending on each other and was untangled
 * by hand. A link that would close a loop is refused; `remove-dep A B` clears
 * the pair in both directions, the old symmetric form included.
 */
function featureDepLink(dataDir, args, { add }) {
  const fidA = args[0];
  const fidB = args[1];
  const verb = add ? "add-dep" : "remove-dep";
  if (!fidA || !fidB) fail(2, `usage: story ${verb} <A> <B>  (B may be a story or a T### task, e.g. a debug spike that blocks the story)`);
  if (!isStoryId(fidA)) fail(2, `spec-state: invalid story id "${fidA}" — ${STORY_ID_HINT}`);
  // F025 AC-4: a bug with an unknown root cause gets a debug-spike TASK attached
  // through dependencies, so the task blocks the story until it is done.
  const bIsTask = TASK_ID_RE.test(fidB);
  if (!isStoryId(fidB) && !bIsTask) fail(2, `spec-state: invalid id "${fidB}" — a story (${STORY_ID_HINT}) or a task (T###)`);
  if (fidA === fidB) fail(3, `spec-state: story ${verb} refuses a self-dependency (${fidA} == ${fidB})`);

  withTwoFeatureLocks(dataDir, fidA, fidB, () => {
    const pathA = resolveFeatureFile(dataDir, fidA);
    const pathB = bIsTask ? resolveTaskFile(dataDir, fidB) : resolveFeatureFile(dataDir, fidB);
    if (bIsTask) {
      const fmB = parseFm(readFileSync(pathB, "utf8"));
      if (fmB && isBuilderRecord({ type: getScalar(fmB.block, "type"), kind: getScalar(fmB.block, "kind"), feature: getScalar(fmB.block, "feature") })) {
        fail(3, `spec-state: ${fidB} is a builder step, not a task — a story depends on tasks (spike|unblocker|study|debug|chore), its steps are listed in steps:`);
      }
    }

    const applyOne = (path, otherId, key) => {
      const content = readFileSync(path, "utf8");
      const fm = parseFm(content);
      if (!fm) fail(3, `spec-state: feature has no frontmatter block — refusing (${path})`);
      const existing = getArrayField(fm.block, key);
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
        const block = setArrayField(fm.block, key, next);
        writeFrontmatteredFile(path, fm, block);
      }
      return changed;
    };

    let changedA, changedB;
    if (add) {
      // A waits for B. If B already waits for A, this link would close a loop.
      const fmB = parseFm(readFileSync(pathB, "utf8"));
      if (fmB && getArrayField(fmB.block, "dependencies").includes(fidA)) {
        fail(3, `spec-state: story add-dep ${fidA} ${fidB} would make a loop: ${fidB} already waits for ${fidA}. If that is wrong, remove it first: shipyard-data story remove-dep ${fidB} ${fidA}`);
      }
      changedA = applyOne(pathA, fidB, "dependencies");
      changedB = applyOne(pathB, fidA, "dependents");
    } else {
      // Unlink the pair in both directions (also clears a pre-4.0 symmetric pair).
      const a1 = applyOne(pathA, fidB, "dependencies"), a2 = applyOne(pathA, fidB, "dependents");
      const b1 = applyOne(pathB, fidA, "dependencies"), b2 = applyOne(pathB, fidA, "dependents");
      changedA = a1 || a2; changedB = b1 || b2;
    }

    if (!changedA && !changedB) {
      process.stdout.write(`story ${verb}: no-op — ${fidA} and ${fidB} already ${add ? "linked" : "unlinked"}\n`);
      return;
    }
    emit(dataDir, add ? "feature_dep_added" : "feature_dep_removed", { a: fidA, b: fidB, ...(bIsTask ? { b_kind: "task" } : {}) });
    process.stdout.write(add ? `story add-dep: ${fidA} waits for ${fidB}\n` : `story remove-dep: ${fidA} and ${fidB} unlinked\n`);
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
/** The story's step-list key: `steps:` (v4) when present or when neither exists; legacy `tasks:` is kept where it already exists. */
function stepsKey(block) {
  if (/^steps:/m.test(block)) return "steps";
  if (/^tasks:/m.test(block)) return "tasks";
  return "steps";
}

function featureClearTasks(dataDir, args) {
  const fid = args[0];
  if (!fid) fail(2, "usage: story clear-steps <SID>");
  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${fid} has no frontmatter block — refusing`);
    const key = stepsKey(fm.block);
    const existing = getArrayField(fm.block, key);
    const block = setArrayField(fm.block, key, []);
    writeFrontmatteredFile(path, fm, block);
    emit(dataDir, "feature_tasks_cleared", { story: fid, feature: fid, count: existing.length });
    process.stdout.write(`${fid}: cleared ${existing.length} step(s) from ${key}:\n`);
  });
}

function featureSetTasks(dataDir, args) {
  const fid = args[0];
  const raw = args[1];
  if (!fid || raw === undefined) fail(2, "usage: story set-steps <SID> <PID,PID,...>");
  if (!isStoryId(fid)) fail(2, `spec-state: invalid story id "${fid}" — ${STORY_ID_HINT}`);
  const tasks = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const tid of tasks) validateTaskId(tid);
  const deduped = [...new Set(tasks)];
  if (deduped.length !== tasks.length) fail(3, `spec-state: story set-steps refuses duplicate step IDs`);

  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    const validatedTasks = [];
    for (const tid of deduped) {
      const taskPath = resolveTaskFile(dataDir, tid, { optional: true });
      if (!taskPath) fail(4, `spec-state: story set-steps refuses missing step ${tid}`);
      const taskContent = readFileSync(taskPath, "utf8");
      const taskFm = parseFm(taskContent);
      if (!taskFm) fail(3, `spec-state: step ${tid} has no frontmatter block — refusing`);
      // A step points at its story through `story:` (v4) or the legacy `feature:` key.
      const parentFeature = getScalar(taskFm.block, "story") || getScalar(taskFm.block, "feature");
      if (parentFeature !== fid) {
        fail(3, `spec-state: story set-steps refuses ${tid}: step story is "${parentFeature || "(missing)"}", not "${fid}"`);
      }
      validatedTasks.push(tid);
    }
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${fid} has no frontmatter block — refusing`);
    const key = stepsKey(fm.block);
    let block = setArrayField(fm.block, key, validatedTasks);
    block = setScalar(block, "updated", today());
    writeFrontmatteredFile(path, fm, block);
    emit(dataDir, "feature_tasks_set", { story: fid, feature: fid, steps: validatedTasks.join(","), tasks: validatedTasks.join(","), count: validatedTasks.length });
    process.stdout.write(`${fid}: ${key} = [${validatedTasks.join(", ")}]\n`);
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
    'usage: story record-proof <id> verdict=pass|fail confirmed-by=<who> commit=<sha> answer="<what that person said about THIS flow>" [note="..."] [at=<ISO>]';
  if (!fid || !("verdict" in kv) || !("confirmed-by" in kv) || !("commit" in kv)) fail(2, usage);
  // A human verdict is that person's answer about THIS flow (4.12). At a real
  // sprint review four "look at it on the device" checks were recorded as
  // confirmed by the owner because the owner accepted the sprint; nobody had
  // looked. Accepting a sprint is not looking at a screen, so the answer is
  // required and kept, where a wrong one is plain to see.
  const answer = String(kv.answer ?? "").replace(/\s+/g, " ").trim();
  if (answer.length < 2) {
    fail(3, `spec-state: record-proof needs answer="<what ${kv["confirmed-by"] || "that person"} said about this flow>". Accepting the sprint, or silence, is not a confirmation: leave the probe pending and list it as not verified.`);
  }

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
    block = setNestedScalarAppend(block, "user_flow_probe", "last_answer", JSON.stringify(answer.slice(0, 300)));
    if (kv.note) block = setNestedScalarAppend(block, "user_flow_probe", "last_note", JSON.stringify(kv.note));
    block = setScalar(block, "updated", today());
    writeFrontmatteredFile(path, fm, block);

    emit(dataDir, "user_flow_probe_confirmed", {
      feature: fid,
      kind: probe.kind,
      verdict,
      commit,
      confirmed_by: confirmedBy,
      answer: answer.slice(0, 300),
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
 * `story retract-proof <id> reason="..."` (4.12) — take back a human verdict
 * that should not have been recorded. The event log is never rewritten: a
 * `user_flow_probe_retracted` event follows the confirmation and readers take
 * the later of the two.
 */
function featureRetractProof(dataDir, args) {
  const fid = args[0];
  const m = args.slice(1).join(" ").match(/reason=(.*)$/s);
  const reason = (m ? m[1] : "").replace(/^["']|["']$/g, "").replace(/\s+/g, " ").trim();
  if (!fid || reason.length < 2) fail(2, 'usage: story retract-proof <id> reason="<why the recorded verdict does not stand>"');
  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    const fm = parseFm(readFileSync(path, "utf8"));
    if (!fm) fail(3, `spec-state: ${fid} has no frontmatter block — refusing`);
    let block = setNestedScalarAppend(fm.block, "user_flow_probe", "last_verdict", "retracted");
    block = setNestedScalarAppend(block, "user_flow_probe", "last_note", JSON.stringify(`retracted: ${reason}`.slice(0, 300)));
    block = setScalar(block, "updated", today());
    writeFrontmatteredFile(path, fm, block);
    emit(dataDir, "user_flow_probe_retracted", { feature: fid, reason: reason.slice(0, 300) });
    process.stdout.write(`${fid}: the recorded human verdict is retracted — ${reason}\n`);
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
/**
 * Advisory (4.15): scenarios start from a path map. A story with tagged
 * scenarios and no `## Paths` section, or with a scenario the map never
 * names, gets a note. Never a failure: stories written before the rule pass.
 */
export function pathMapNote(text) {
  const ids = [...new Set((String(text).match(/@AC-\d+\b/g) || []))];
  if (!ids.length) return "";
  const lines = String(text).split(/\r?\n/);
  const at = lines.findIndex((l) => /^##\s+Paths\s*$/i.test(l));
  if (at === -1) return " — note: no `## Paths` section (every way the trigger can end, each with its scenario or the reason it cannot happen)";
  let end = lines.findIndex((l, i) => i > at && /^##\s+/.test(l));
  if (end === -1) end = lines.length;
  const map = lines.slice(at, end).join("\n");
  const missing = ids.filter((id) => !new RegExp(`${id.replace("@", "@?")}\\b`).test(map));
  return missing.length ? ` — note: \`## Paths\` names no ending for ${missing.join(", ")}` : "";
}

const LEVEL_TAGS = ["@e2e", "@component", "@unit"];

/** `spec.behaviour_first` (config.md, default true): the approval gate below. */
function behaviourFirstOn(dataDir) {
  try {
    const cfg = readFileSync(join(dataDir, "config.md"), "utf8");
    const m = /^spec:\s*\n((?:[ \t]+.*\n?)*)/m.exec(cfg);
    return !(m && /^[ \t]+behaviour_first:\s*false\b/m.test(m[1]));
  } catch { return true; }
}

/**
 * What is wrong with a story's scenarios under the behaviour-first rules
 * (4.15.2). Pure: text in, list of problems out.
 *   - every scenario has an id (`@AC-n`) and exactly one level tag;
 *   - a level below the journey says why, on the next line:
 *     `# why not e2e: <reason>`;
 *   - `## Paths` exists and names every scenario.
 */
export function scenarioProblems(text) {
  const out = [];
  const lines = String(text ?? "").split(/\r?\n/);
  const scen = lines.map((l, i) => ({ l, i })).filter((x) => /^\s*Scenario( Outline)?:/.test(x.l));
  if (!scen.length) return ["no Gherkin scenario"];
  const ids = new Set();
  for (const s of scen) {
    // the tag lines directly above the scenario (comments allowed between)
    const tags = []; let why = false;
    for (let j = s.i - 1; j >= 0; j--) {
      const t = lines[j].trim();
      if (t.startsWith("@")) tags.push(...t.split(/\s+/));
      else if (/^#\s*why not e2e:\s*\S/i.test(t)) why = true;
      else if (t.startsWith("#")) continue;
      else break;
    }
    const name = s.l.trim().replace(/^Scenario( Outline)?:\s*/, "").slice(0, 50);
    const id = tags.find((t) => /^@AC-\d+$/.test(t));
    if (!id) { out.push(`scenario "${name}" has no @AC-<n> id`); continue; }
    ids.add(id);
    const levels = tags.filter((t) => LEVEL_TAGS.includes(t));
    if (levels.length !== 1) out.push(`${id} needs exactly one level tag (@e2e by default; @component or @unit with a reason), has ${levels.length ? levels.join(" ") : "none"}`);
    else if (levels[0] !== "@e2e" && !why) out.push(`${id} is ${levels[0]} with no reason: add the line \`# why not e2e: <a fault, race or timing the journey cannot stage | a rule with many input values>\` under its tags`);
  }
  const at = lines.findIndex((l) => /^##\s+Paths\s*$/i.test(l));
  if (at === -1) out.push("no `## Paths` section: list every way the trigger can end, each with its scenario or the reason it cannot happen");
  else {
    let end = lines.findIndex((l, i) => i > at && /^##\s+/.test(l));
    if (end === -1) end = lines.length;
    const map = lines.slice(at, end).join("\n");
    const missing = [...ids].filter((id) => !new RegExp(`${id.slice(1)}\\b`).test(map));
    if (missing.length) out.push(`\`## Paths\` names no ending for ${missing.join(", ")}`);
  }
  return out;
}

/**
 * `story check-scenarios <ID> [<ID> ...]` — the behaviour-first gate, run
 * where scenarios are written and where they enter a sprint (discuss
 * finalize, sprint planning). Never part of execute: a sprint planned before
 * the rule is not stopped mid-flight. Exit 0 all good, 3 with one line per
 * problem.
 */
/**
 * `story acs <id> [<id> ...]` — the acceptance criteria as a short list: one line each, the id and the
 * scenario's name, never the Given/When/Then text.
 *
 * The owner: "explanations for gherkin bdd ac's make sure its not verbatim rather a natural language few
 * simple words explanation … one liner if possible each ac". An approval used to paste every scenario in
 * full; with a dozen criteria per story that is a wall nobody reads. The full text stays in the story file.
 */
export function acList(text) {
  const lines = String(text).split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*Scenario(?: Outline)?:\s*(.+?)\s*$/);
    if (!m) continue;
    let tags = "";
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) { const t = lines[j].trim(); if (t.startsWith("@")) tags = `${t} ${tags}`; else if (t && !t.startsWith("#")) break; }
    const id = (tags.match(/@(AC-\d+)/) || [])[1] ?? `#${out.length + 1}`;
    const level = (tags.match(/@(e2e|component|unit)\b/) || [])[1] ?? "";
    out.push({ id, name: m[1], level });
  }
  return out;
}
function storyAcs(dataDir, args) {
  const ids = args.filter((a) => !a.startsWith("--"));
  if (!ids.length) fail(2, "usage: story acs <id> [<id> ...]");
  for (const id of ids) {
    const path = resolveFeatureFile(dataDir, id);
    const text = readFileSync(path, "utf8");
    const acs = acList(text);
    const title = (text.match(/^title:[ \t]*"?(.*?)"?[ \t]*$/m) || [])[1] ?? "";
    process.stdout.write(`${id} — ${title} · ${acs.length} acceptance criteria · full text: ${path}\n`);
    if (!acs.length) { process.stdout.write("  (no scenario yet)\n\n"); continue; }
    process.stdout.write("| AC | What it checks |\n|---|---|\n" + acs.map((a) => `| ${a.id} | ${a.name}${a.level && a.level !== "e2e" ? ` (${a.level})` : ""} |`).join("\n") + "\n\n");
  }
  process.stdout.write('NEXT (not part of the list): show the person this table, one line per criterion. Where a name is terse, reword it into a few plain words a person would say ("a failed card sale gives the money back by itself"). Do not paste the Given/When/Then text; show one criterion in full only when they ask for it.\n');
}

function featureCheckScenarios(dataDir, args) {
  const fids = args.filter((a) => !a.startsWith("--"));
  if (fids.length === 0) fail(2, "usage: story check-scenarios <ID> [<ID> ...]");
  let bad = 0;
  for (const fid of fids) {
    if (!FID_RE.test(fid)) fail(2, `spec-state: invalid story id "${fid}"`);
    const path = resolveFeatureFile(dataDir, fid, { optional: true });
    if (!path) { bad++; process.stdout.write(`${fid}: MISSING-FILE\n`); continue; }
    const problems = scenarioProblems(readFileSync(path, "utf8"));
    if (!problems.length) { process.stdout.write(`${fid}: OK\n`); continue; }
    bad++;
    for (const p of problems) process.stdout.write(`${fid}: ${p}\n`);
  }
  if (bad) {
    process.stdout.write(`check-scenarios: ${bad} of ${fids.length} stor${fids.length === 1 ? "y" : "ies"} need work (rules: skills/tdd-cycle/references/test-economy.md)\n`);
    process.exit(3);
  }
  process.stdout.write(`check-scenarios: all ${fids.length} stor${fids.length === 1 ? "y" : "ies"} start from the behaviour\n`);
}

function featureCheckProbes(dataDir, args) {
  const fids = args.filter((a) => !a.startsWith("--"));
  if (fids.length === 0) fail(2, "usage: feature check-probes <FID> [<FID> ...]");
  for (const fid of fids) {
    if (!FID_RE.test(fid)) fail(2, `spec-state: invalid feature id "${fid}" — expected F### or F###<letter> (e.g. F004, F071d)`);
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
    } else if (probe.shape === "scalar" || USER_FLOW_PROBE_KINDS.includes(probe.kind)) {
      // A probe proves the story, not the project (4.14): one that ends with
      // the full test command still passes, with a note to drop that part.
      let suiteNote = "";
      try { const pc = readProbeCommand(readFileSync(path, "utf8")); const t = pc ? trailingSuite(dataDir, pc.command) : null; if (t) suiteNote = ` — note: ends with the full ${t.tier} suite (\`${t.command}\`); the sprint proves the suite once, so drop it from the probe`; } catch { /* note only */ }
      process.stdout.write(`${fid}: OK kind=${probe.shape === "scalar" ? "auto" : probe.kind}${legacyNote}${suiteNote}${pathMapNote(readFileSync(path, "utf8"))}\n`);
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

/**
 * Report BACKLOG.md rows whose id doesn't parse, without failing. Scoped
 * separately from the entry being mutated: pre-existing junk is the file
 * owner's problem to clean up, not a reason to block an unrelated add/rank
 * (see readFeatureRice's note on whole-index validation).
 */
function warnMalformedBacklogIds(ids) {
  const bad = ids.filter((id) => !FID_RE.test(id));
  if (bad.length) {
    process.stderr.write(
      `spec-state: warning — BACKLOG.md has ${bad.length} row(s) with an unrecognized id: ${bad.join(", ")}. ` +
        `Expected F### or F###<letter>. They are kept, ranked last, and otherwise ignored.\n`,
    );
  }
}

function backlogAdd(dataDir, args) {
  const fids = args.filter((a) => !a.startsWith("--"));
  if (fids.length === 0) fail(2, "usage: backlog add <FID> [<FID> ...]");

  for (const fid of fids) {
    if (!FID_RE.test(fid)) {
      fail(2, `spec-state: invalid feature id "${fid}" — expected F### or F###<letter> (e.g. F004, F071d)`);
    }
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
      warnMalformedBacklogIds(b.ids);
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
      if (readOrder(dataDir).ordered_by === "owner") {
        // The owner has ordered this list: nothing is re-sorted behind their back. New work waits at the bottom.
        b.ids = [...b.ids, ...added];
        serializeBacklog(b);
        emit(dataDir, "backlog_added", { features: added.join(","), placed: "bottom" });
        process.stdout.write(`backlog add: added ${added.join(", ")} at the bottom (the backlog is in the owner's order). Place it: shipyard-data backlog move <id> --top|--above <id>|--to <n> --why "<what a delay costs>"\n`);
        return;
      }
      const withScores = b.ids.map((id) => ({ id, ...readFeatureRice(dataDir, id) }));
      for (const fid of added) withScores.push({ id: fid, ...readFeatureRice(dataDir, fid) });
      const scored = withScores.filter((x) => x.score !== null).sort((a, c) => c.score - a.score);
      const unscored = withScores.filter((x) => x.score === null);
      b.ids = [...scored, ...unscored].map((x) => x.id);
      serializeBacklog(b);
      emit(dataDir, "backlog_added", { features: added.join(",") });
      process.stdout.write(`backlog add: added ${added.join(", ")}\n`);
    });
  });
}

/**
 * Remove ids from the backlog index.
 *
 * Exit shape: 0 if at least one id was actually removed (a partial hit still
 * prints the misses to stderr and succeeds — removal is idempotent per id),
 * 4 if NONE of the named ids were in the index. The all-missing case used to
 * print an error to stderr, print `removed (none)` to stdout, and exit 0 —
 * indistinguishable to an exit-code-checking caller from a real removal,
 * which is the same false-green shape as a failed status flip reporting
 * success.
 */
function backlogRemove(dataDir, args) {
  const fids = args.filter((a) => !a.startsWith("--"));
  if (fids.length === 0) fail(2, "usage: backlog remove <FID> [<FID> ...]");
  withNamedLock(dataDir, "backlog", () => {
    const b = parseBacklog(dataDir);
    const removed = [];
    const missing = [];
    for (const fid of fids) {
      if (b.ids.includes(fid)) removed.push(fid);
      else missing.push(fid);
    }
    if (removed.length === 0) {
      fail(4, `spec-state: backlog remove: none of the named id(s) are in BACKLOG.md: ${missing.join(", ")}`);
    }
    b.ids = b.ids.filter((id) => !fids.includes(id));
    serializeBacklog(b);
    if (missing.length) {
      process.stderr.write(`backlog remove: not present (no-op): ${missing.join(", ")}\n`);
    }
    emit(dataDir, "backlog_removed", { features: removed.join(",") });
    process.stdout.write(`backlog remove: removed ${removed.join(", ")}\n`);
  });
}

function backlogRank(dataDir, args = []) {
  withNamedLock(dataDir, "backlog", () => {
    const order = readOrder(dataDir);
    if (order.ordered_by === "owner" && !args.includes("--by-score")) {
      fail(3, `spec-state: the backlog is in the owner's order (${Object.keys(order.why).length} placement(s) with a reason). A re-sort by score would undo it. Move single items with \`backlog move\`; to throw the order away and sort by score: backlog rank --by-score`);
    }
    if (order.ordered_by === "owner") writeOrder(dataDir, { ordered_by: "score", why: {} });
    const b = parseBacklog(dataDir);
    warnMalformedBacklogIds(b.ids);
    const withScores = b.ids.map((id) => ({ id, ...readFeatureRice(dataDir, id) }));
    const scored = withScores.filter((x) => x.score !== null).sort((a, c) => c.score - a.score);
    const unscored = withScores.filter((x) => x.score === null);
    b.ids = [...scored, ...unscored].map((x) => x.id);
    serializeBacklog(b);
    const missingIds = unscored.map((x) => x.id);
    emit(dataDir, "backlog_ranked", { count: b.ids.length, missing_rice: missingIds.join(",") });
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
    emit(dataDir, "backlog_groomed", { date: value });
    process.stdout.write(`backlog: last_groomed = ${value}\n`);
  });
}

/**
 * `feature assign-ac-ids <FID>` — give every Gherkin scenario under the
 * feature's `## Acceptance Criteria` section a stable `@AC-<n>` tag, so
 * acceptance criteria have machine-addressable ids that `verify-ac-coverage`
 * (and the `// AC-<n>` code markers builders emit) can key on. Idempotent:
 * a scenario already carrying an `@AC-<n>` tag is left untouched; new ids
 * continue from the current max. Tags are inserted as a gherkin tag line
 * directly above the scenario, at the scenario's indentation.
 *
 * Prints `assign-ac-ids <FID>: assigned N (total M)`.
 */
function featureAssignAcIds(dataDir, args) {
  const fid = args[0];
  if (!fid) fail(2, "usage: feature assign-ac-ids <FID>");
  withNamedLock(dataDir, `feature-${fid}`, () => {
    const path = resolveFeatureFile(dataDir, fid);
    const content = readFileSync(path, "utf8");
    const lines = content.split(/\r?\n/);

    // Bound the AC section: from the `## Acceptance Criteria` heading to the
    // next `## ` heading (or EOF). Only tag scenarios inside it.
    const acStart = lines.findIndex((l) => /^##\s+Acceptance Criteria\s*$/i.test(l));
    if (acStart === -1) {
      process.stdout.write(`assign-ac-ids ${fid}: no "## Acceptance Criteria" section — nothing to tag\n`);
      return;
    }
    let acEnd = lines.length;
    for (let i = acStart + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i])) { acEnd = i; break; }
    }

    // Highest existing @AC-<n> anywhere in the section → continue from there.
    let maxId = 0;
    for (let i = acStart; i < acEnd; i++) {
      const m = lines[i].match(/@AC-(\d+)\b/);
      if (m) maxId = Math.max(maxId, parseInt(m[1], 10));
    }

    const out = [];
    let assigned = 0;
    let total = 0;
    for (let i = 0; i < lines.length; i++) {
      const inSection = i > acStart && i < acEnd;
      const scen = inSection ? lines[i].match(/^(\s*)(Scenario|Scenario Outline):/) : null;
      if (scen) {
        total += 1;
        // Already tagged? Look through everything that belongs to this scenario's
        // header: blank lines, `# comment` lines (the `# why not e2e:` reason sits
        // between the tag and `Scenario:`) and tag lines. Reading only the one
        // line above gave a second id to every scenario with such a comment.
        let tagged = false;
        for (let j = out.length - 1; j >= 0; j--) {
          const t = out[j].trim();
          if (t === "" || t.startsWith("#")) continue;
          if (!t.startsWith("@")) break;
          if (/@AC-\d+\b/.test(t)) { tagged = true; break; }
        }
        if (!tagged) {
          maxId += 1;
          assigned += 1;
          out.push(`${scen[1]}@AC-${maxId}`);
        }
      }
      out.push(lines[i]);
    }

    if (assigned > 0) atomicWriteFile(path, out.join("\n"));
    emit(dataDir, "feature_ac_ids_assigned", { feature: fid, assigned, total });
    process.stdout.write(`assign-ac-ids ${fid}: assigned ${assigned} (total ${total})\n`);
  });
}

// --- idea commands -----------------------------------------------------------

/**
 * `idea set-status <IDEA-NNN> <captured|assessing|promoted|rejected|parked> [--to <S###|F###|E###>]`
 * (terminology-v4 D-9 / A-07). Old values are accepted on input and read from
 * disk through IDEA_STATUS_ALIASES (`proposed` = captured, `graduated` =
 * promoted); the file is written with the new value. `promoted` requires
 * `--to` naming an existing story or epic; the target is written to
 * `promoted_to:` (and `graduated_to:` when it is a story, so pre-v4 readers
 * still find it). `rejected`/`parked` refuse `--to`.
 */
/**
 * `idea triage <IDEA-NNN> --kind defect|improvement|question [--severity low|medium|high]
 *              [--fixed-by <step id>] [--reason "..."]` (4.7.2)
 *
 * The decision on a finding, recorded where the gates read it. A defect needs
 * a severity; calling a defect low (so it may wait in the backlog) needs a
 * one-line reason, which the sprint review shows. `--fixed-by` names the patch
 * step that fixes a defect in the sprint and must exist.
 */
/**
 * `idea capture --title "..." [--idea "..."] [--why "..."] [--thoughts "..."] [--source "..."] [--points <n>]`
 *
 * One call writes a captured idea: the id is allocated, the file is written
 * from the template's shape, the event is logged (4.0.1). Before this an idea
 * was "run `next-id ideas`, then write the file yourself"; on a real project a
 * discussion captured five at once with nine `next-id` calls and a shell
 * here-document inside the data folder, which the start-up rules forbid and no
 * hook sees. Capture stays unblockable: this refuses only a missing title.
 */
function ideaCapture(dataDir, args) {
  const o = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) fail(2, `spec-state: idea capture: unexpected argument "${a}"`);
    const v = args[++i];
    if (v === undefined) fail(2, `spec-state: idea capture: ${a} needs a value`);
    o[a.slice(2)] = v;
  }
  const usage = 'usage: idea capture --title "..." [--idea "..."] [--why "..."] [--thoughts "..."] [--source "..."] [--points <n>]';
  // a session reaches for the word it would use: --description was refused as unknown on a real project
  for (const [alias, name] of [["description", "idea"], ["desc", "idea"], ["body", "idea"], ["what", "idea"], ["reason", "why"], ["notes", "thoughts"]]) if (o[alias] !== undefined && o[name] === undefined) { o[name] = o[alias]; delete o[alias]; }
  const unknown = Object.keys(o).filter((k) => !["title", "idea", "why", "thoughts", "source", "points"].includes(k));
  if (unknown.length) fail(2, `spec-state: idea capture: unknown flag --${unknown[0]}\n  ${usage}`);
  const title = String(o.title ?? "").replace(/\s+/g, " ").trim();
  if (!title) fail(2, usage);
  const points = o.points === undefined ? 0 : Number(o.points);
  if (!Number.isFinite(points) || points < 0) fail(2, `spec-state: idea capture: --points must be a number (got "${o.points}")`);
  const cli = join(dirname(fileURLToPath(import.meta.url)), "shipyard-data.mjs");
  const r = spawnSyncForGit("node", [cli, "next-id", "ideas", "--data-dir", dataDir], { encoding: "utf8" });
  const n = String(r.stdout ?? "").trim();
  if (r.status !== 0 || !/^\d+$/.test(n)) fail(1, `spec-state: idea capture: could not allocate an id: ${(r.stderr || r.stdout || "").trim().split("\n")[0]}`);
  if (r.stderr && r.stderr.trim()) process.stderr.write(r.stderr); // the backlog-size warning, never a refusal
  const id = `IDEA-${n}`;
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "idea";
  const path = join(dataDir, "spec", "ideas", `${id}-${slug}.md`);
  const para = (v) => String(v ?? "").trim() || "-";
  const body = [
    "---", `id: ${id}`, `title: ${JSON.stringify(title)}`, "type: idea", "status: captured",
    `source: ${JSON.stringify(String(o.source ?? "").trim())}`, `story_points: ${points}`, `created: ${today()}`, "---", "",
    `# ${title}`, "", "## Idea", "", para(o.idea ?? title), "", "## Why It Might Matter", "", para(o.why),
    ...(String(o.thoughts ?? "").trim() ? ["", "## Initial Thoughts", "", String(o.thoughts).trim()] : []), "",
  ].join("\n");
  mkdirSync(join(dataDir, "spec", "ideas"), { recursive: true });
  atomicWriteFile(path, body);
  emit(dataDir, "idea_captured", { idea: id, source: String(o.source ?? "").trim().slice(0, 80) });
  process.stdout.write(`${id} captured: ${path}\nFlesh out later with: /ship-discuss ${id}\n`);
}

function ideaTriage(dataDir, args) {
  const ideaId = args[0];
  const val = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : undefined; };
  const kind = val("--kind"), severity = val("--severity"), fixedBy = val("--fixed-by"), reason = val("--reason");
  const usage = 'usage: idea triage <IDEA-NNN> --kind defect|improvement|question [--severity low|medium|high] [--fixed-by <step id>] [--reason "..."]';
  if (!ideaId || ideaId.startsWith("--") || !kind) fail(2, usage);
  if (!FINDING_KINDS.includes(kind)) fail(2, `spec-state: idea triage: unknown kind "${kind}". Allowed: ${FINDING_KINDS.join(", ")}`);
  if (severity !== undefined && !FINDING_SEVERITIES.includes(severity)) fail(2, `spec-state: idea triage: unknown severity "${severity}". Allowed: ${FINDING_SEVERITIES.join(", ")}`);
  if (kind === "defect" && !severity) fail(3, "spec-state: idea triage: a defect needs --severity low|medium|high (how badly a user is affected)");
  if (kind === "defect" && severity === "low" && !(reason && reason.trim())) fail(3, 'spec-state: idea triage: calling a defect low severity sends it to the backlog instead of fixing it in the sprint — say why in --reason "..." (the sprint review shows it)');
  if (fixedBy !== undefined) {
    if (kind !== "defect") fail(3, "spec-state: idea triage: --fixed-by applies to a defect only");
    if (!resolveTaskFile(dataDir, fixedBy, { optional: true })) fail(3, `spec-state: idea triage: --fixed-by ${fixedBy} is not a step file under spec/steps/ (or the legacy spec/tasks/) — write the patch step first`);
  }
  withNamedLock(dataDir, `idea-${ideaId}`, () => {
    const path = resolveIdeaFile(dataDir, ideaId);
    const fm = parseFm(readFileSync(path, "utf8"));
    if (!fm) fail(3, `spec-state: ${ideaId} has no frontmatter block — refusing`);
    let block = setScalar(fm.block, "kind", kind);
    if (severity) block = setScalar(block, "severity", severity);
    if (fixedBy) block = setScalar(block, "fixed_by", fixedBy);
    if (reason && reason.trim()) block = setScalar(block, "triage_reason", JSON.stringify(reason.trim().replace(/\s+/g, " ")));
    writeFrontmatteredFile(path, fm, block);
    emit(dataDir, "idea_triaged", { idea: ideaId, kind, ...(severity ? { severity } : {}), ...(fixedBy ? { fixed_by: fixedBy } : {}), ...(reason ? { reason: reason.trim() } : {}) });
    process.stdout.write(`${ideaId}: ${kind}${severity ? `, ${severity}` : ""}${fixedBy ? `, fixed by ${fixedBy}` : ""}\n`);
  });
}

function ideaSetStatus(dataDir, args) {
  const ideaId = args[0];
  const rawTo = args[1];
  const toIdx = args.indexOf("--to");
  const target = toIdx !== -1 ? args[toIdx + 1] : undefined;
  if (!ideaId || !rawTo || rawTo.startsWith("--")) {
    fail(2, "usage: idea set-status <IDEA-NNN> <captured|assessing|promoted|rejected|parked> [--to <S###|E###|T###>]");
  }
  const toStatus = normalizeStatus(IDEA_STATUS_ALIASES, rawTo);
  if (!Object.prototype.hasOwnProperty.call(IDEA_TRANSITIONS, toStatus)) {
    fail(2, `spec-state: unknown idea status "${rawTo}". Allowed: ${Object.keys(IDEA_TRANSITIONS).join(", ")} (legacy: proposed, graduated)`);
  }
  if (toStatus === "promoted" && !target) {
    fail(3, "spec-state: idea set-status promoted requires --to <S###|E###|T###> (the story, epic or task it was promoted to)");
  }
  if (toStatus !== "promoted" && target) {
    fail(3, `spec-state: idea set-status ${toStatus} refuses --to — only a promoted idea has a target`);
  }
  let targetKind = null;
  if (target) {
    if (EPIC_ID_RE.test(target)) {
      if (!resolveEpicFile(dataDir, target, { optional: true })) fail(3, `spec-state: --to ${target} does not exist under spec/epics/`);
      targetKind = "epic";
    } else if (isStoryId(target)) {
      if (!resolveStoryFile(dataDir, target, { optional: true })) fail(3, `spec-state: --to ${target} does not exist under spec/stories/ (or the legacy spec/features/, spec/bugs/)`);
      targetKind = "story";
    } else if (TASK_ID_RE.test(target)) {
      if (!readUnitFrontmatter(dataDir, target)) fail(3, `spec-state: --to ${target} does not exist under spec/tasks/`);
      targetKind = "task";
    } else {
      fail(3, `spec-state: --to "${target}" is not a story, epic or task id (${STORY_ID_HINT}; E###; T###)`);
    }
  }

  withNamedLock(dataDir, `idea-${ideaId}`, () => {
    const path = resolveIdeaFile(dataDir, ideaId);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${ideaId} has no frontmatter block — refusing`);
    const rawFrom = getScalar(fm.block, "status");
    let fromStatus = normalizeStatus(IDEA_STATUS_ALIASES, rawFrom);
    // A status the lifecycle does not know (`new`, `pending`, `open`, or none:
    // what a builder writes when nobody told it the word) is the entry state.
    // Nine of a real project's ideas were `status: new`, and this verb refused
    // every one, so a promotion could not be recorded. `idea repair` still
    // lists such records; a move from one is simply allowed and fixes it.
    if (!Object.prototype.hasOwnProperty.call(IDEA_TRANSITIONS, fromStatus)) {
      process.stderr.write(`spec-state: ${ideaId} had status "${rawFrom || "(none)"}", which is not a lifecycle state — read as captured\n`);
      fromStatus = "captured";
    }
    const check = validateStatusTransition(IDEA_TRANSITIONS, fromStatus, toStatus);
    if (!check.ok) {
      const known = IDEA_TRANSITIONS[fromStatus];
      fail(
        3,
        `spec-state: illegal idea status transition ${rawFrom} -> ${toStatus} for ${ideaId}. ` +
          `Valid next states from "${fromStatus}": ${known ? (known.length ? known.join(", ") : "(none — terminal)") : "(unknown status)"}.`,
      );
    }
    let block = setScalar(fm.block, "status", toStatus);
    if (target) {
      block = setScalar(block, "promoted_to", target);
      if (targetKind === "story") block = setScalar(block, "graduated_to", target);
    }
    writeFrontmatteredFile(path, fm, block);
    // `to` is the destination STATUS (same shape as story_status_changed);
    // the promotion target travels as `promoted_to` (+ legacy `graduated_feature`).
    const fields = { idea: ideaId, from: fromStatus, to: toStatus };
    if (target) {
      fields.promoted_to = target;
      fields.promoted_kind = targetKind;
      if (targetKind === "story") fields.graduated_feature = target;
    }
    emit(dataDir, "idea_status_changed", fields);
    process.stdout.write(`${ideaId}: ${fromStatus} -> ${toStatus}` + (target ? ` (-> ${target})` : "") + "\n");
  });
}

/**
 * `epic set-status <E###> <decided|refined|in-progress|done> [--force]`
 * (terminology-v4 D-10 / A-08). `proposed` is the pre-v4 template value and
 * reads as the entry state.
 */
function epicSetStatus(dataDir, args) {
  const positional = args.filter((a) => !a.startsWith("--"));
  const eid = positional[0];
  const toStatus = positional[1];
  const force = args.includes("--force");
  if (!eid || !toStatus) fail(2, "usage: epic set-status <E###> <decided|refined|in-progress|done> [--force]");
  if (!Object.prototype.hasOwnProperty.call(EPIC_TRANSITIONS, toStatus) || toStatus === "proposed") {
    fail(2, `spec-state: unknown epic status "${toStatus}". Allowed: ${Object.keys(EPIC_TRANSITIONS).filter((k) => k !== "proposed").join(", ")}`);
  }
  withNamedLock(dataDir, `epic-${eid}`, () => {
    const path = resolveEpicFile(dataDir, eid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${eid} has no frontmatter block — refusing`);
    const fromStatus = getScalar(fm.block, "status") || "proposed";
    const check = validateStatusTransition(EPIC_TRANSITIONS, fromStatus, toStatus);
    if (!check.ok && !force) {
      const known = EPIC_TRANSITIONS[fromStatus];
      fail(
        3,
        `spec-state: illegal epic status transition ${fromStatus} -> ${toStatus} for ${eid}. ` +
          `Valid next states from "${fromStatus}": ${known ? (known.length ? known.join(", ") : "(none — terminal)") : "(unknown status)"}. ` +
          `Re-run with --force to override the graph.`,
      );
    }
    let block = setScalar(fm.block, "status", toStatus);
    block = setScalar(block, "updated", today());
    writeFrontmatteredFile(path, fm, block);
    emit(dataDir, "epic_status_changed", { epic: eid, from: fromStatus, to: toStatus, forced: !check.ok && force });
    process.stdout.write(`${eid}: ${fromStatus} -> ${toStatus}\n`);
  });
}

/**
 * `task set-status <T###> <open|in-progress|done|dropped> [--force]` for the
 * v4 task entity (enabling work, terminology-v4 T-4). A legacy builder record
 * reached through the `task` verb is routed to the step vocabulary instead
 * (see dispatch); this function never sees one.
 */
function taskEntitySetStatus(dataDir, args) {
  const positional = args.filter((a) => !a.startsWith("--"));
  const tid = positional[0];
  const toStatus = positional[1];
  const force = args.includes("--force");
  if (!tid || !toStatus) fail(2, "usage: task set-status <T###> <open|in-progress|done|dropped> [--force]");
  if (!Object.prototype.hasOwnProperty.call(TASK_TRANSITIONS, toStatus)) {
    fail(2, `spec-state: unknown task status "${toStatus}". Allowed: ${Object.keys(TASK_TRANSITIONS).join(", ")} (a builder step uses step set-status)`);
  }
  withNamedLock(dataDir, `task-${tid}`, () => {
    const path = resolveTaskFile(dataDir, tid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${tid} has no frontmatter block — refusing`);
    const fromStatus = getScalar(fm.block, "status") || "open";
    const check = validateStatusTransition(TASK_TRANSITIONS, fromStatus, toStatus);
    if (!check.ok && !force) {
      const known = TASK_TRANSITIONS[fromStatus];
      fail(
        3,
        `spec-state: illegal task status transition ${fromStatus} -> ${toStatus} for ${tid}. ` +
          `Valid next states from "${fromStatus}": ${known ? (known.length ? known.join(", ") : "(none — terminal)") : "(unknown status)"}. ` +
          `Re-run with --force to override the graph.`,
      );
    }
    let block = setScalar(fm.block, "status", toStatus);
    block = setScalar(block, "updated", today());
    writeFrontmatteredFile(path, fm, block);
    emit(dataDir, "task_status_set", { task: tid, entity: "task", from: fromStatus, to: toStatus, forced: !check.ok && force });
    process.stdout.write(`${tid}: ${fromStatus} -> ${toStatus}\n`);
  });
}

/** Read a unit record's frontmatter (null when the file or block is missing). */
function readUnitFrontmatter(dataDir, tid) {
  const path = resolveTaskFile(dataDir, tid, { optional: true });
  if (!path) return null;
  const fm = parseFm(readFileSync(path, "utf8"));
  if (!fm) return null;
  const out = {};
  for (const key of ["type", "kind", "feature", "story", "status"]) out[key] = getScalar(fm.block, key) ?? "";
  return out;
}

// Valid on disk: the v4 vocabulary plus the two pre-v4 values it aliases
// (proposed = captured, graduated = promoted) — those are read, not repaired.
const IDEA_STATUSES = new Set([...Object.keys(IDEA_TRANSITIONS), ...Object.keys(IDEA_STATUS_ALIASES)]);
const LEGACY_IDEA_STATUSES = new Set([
  "open",
  "idea",
  "new",
  "backlog",
  "resolved",
  "merged",
  "reclassified",
]);

function ideaRepair(dataDir, args) {
  const fix = args.includes("--fix");
  const json = args.includes("--json");
  const unknown = args.filter((arg) => !["--fix", "--json"].includes(arg));
  if (unknown.length) fail(2, `usage: idea repair [--fix] [--json] (unknown argument: ${unknown[0]})`);

  const dir = join(dataDir, "spec", "ideas");
  mkdirSync(dir, { recursive: true });
  withNamedLock(dataDir, "idea-repair", () => {
    const files = readdirSync(dir).filter((name) => !name.startsWith(".") && name.endsWith(".md")).sort();
    const records = files.map((name) => {
      const path = join(dir, name);
      const content = readFileSync(path, "utf8");
      const fm = parseFm(content);
      const filenameId = name.match(/^(IDEA-\d{3})(?:-|\.md$)/)?.[1] ?? null;
      const frontmatterId = fm ? getScalar(fm.block, "id") : "";
      return { name, path, content, fm, filenameId, frontmatterId };
    });

    let max = 0;
    for (const record of records) {
      for (const id of [record.filenameId, IDEA_ID_RE.test(record.frontmatterId) ? record.frontmatterId : null]) {
        if (id) max = Math.max(max, Number(id.slice(5)));
      }
    }
    const seqPath = join(dir, ".id-seq");
    if (existsSync(seqPath)) {
      const seq = Number.parseInt(readFileSync(seqPath, "utf8").trim(), 10);
      if (Number.isFinite(seq)) max = Math.max(max, seq);
    }

    const claimed = new Set();
    const changes = [];
    const allocate = () => {
      do max += 1; while (claimed.has(`IDEA-${String(max).padStart(3, "0")}`));
      return `IDEA-${String(max).padStart(3, "0")}`;
    };

    for (const record of records) {
      let id = record.filenameId || (IDEA_ID_RE.test(record.frontmatterId) ? record.frontmatterId : null);
      const reasons = [];
      if (!record.fm) reasons.push("no_frontmatter");
      if (!IDEA_ID_RE.test(record.frontmatterId)) reasons.push(record.frontmatterId ? "malformed_id" : "missing_id");
      if (!record.filenameId) reasons.push("noncanonical_filename");
      if (!id || claimed.has(id)) {
        if (id && claimed.has(id)) reasons.push("duplicate_id");
        id = allocate();
      }
      claimed.add(id);

      let status = record.fm ? (getScalar(record.fm.block, "status") ?? "").toLowerCase() : "";
      if (!IDEA_STATUSES.has(status)) {
        reasons.push(status ? (LEGACY_IDEA_STATUSES.has(status) ? "legacy_status" : "unknown_status") : "missing_status");
        // Invalid historical terminal-looking states cannot safely be called
        // graduated without a verified feature target. Proposed is the only
        // lossless repair state: it makes the record reachable for grooming.
        status = "captured";
      }

      if (record.filenameId && record.filenameId !== id) reasons.push("filename_id_changed");
      if (record.frontmatterId && record.frontmatterId !== id && !reasons.includes("malformed_id")) reasons.push("frontmatter_id_changed");
      if (!reasons.length) continue;

      let targetName = record.name;
      if (!record.filenameId || record.filenameId !== id) {
        const rawSlug = record.name.replace(/\.md$/, "").replace(/^IDEA-[^-]+-?/, "");
        const slug = rawSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        targetName = `${id}${slug ? `-${slug}` : ""}.md`;
        if (existsSync(join(dir, targetName)) && targetName !== record.name) targetName = `${id}.md`;
      }

      changes.push({ file: record.name, target: targetName, id, status, reasons });
      if (!fix) continue;

      let output;
      if (record.fm) {
        let block = setScalar(record.fm.block, "id", id);
        block = setScalar(block, "status", status);
        output = record.fm.open + block + record.fm.close + record.fm.rest;
      } else {
        const heading = record.content.match(/^#\s+(.+)$/m)?.[1]?.trim();
        const title = (heading || record.name.replace(/\.md$/, "").replace(/[-_]+/g, " ")).replace(/"/g, "\\\"");
        output = `---\nid: ${id}\ntitle: "${title}"\ntype: idea\nstatus: ${status}\ncreated: null\n---\n\n${record.content}`;
      }
      atomicWriteFile(record.path, output);
      if (targetName !== record.name) renameSync(record.path, join(dir, targetName));
    }

    if (fix && changes.length) {
      atomicWriteFile(seqPath, String(max) + "\n");
      emit(dataDir, "ideas_repaired", { count: changes.length, highest_id: max });
    }
    const result = { clean: changes.length === 0, fixed: fix ? changes.length : 0, findings: changes };
    if (json) process.stdout.write(JSON.stringify(result) + "\n");
    else process.stdout.write(`${fix ? "IDEA_REPAIR" : "IDEA_AUDIT"} findings=${changes.length} fixed=${result.fixed}\n`);
    if (!fix && changes.length) fail(3, `idea repair: ${changes.length} invalid idea record(s); rerun with --fix`);
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
  const evidenceIdx = args.indexOf("--evidence");
  const evidence = evidenceIdx !== -1 ? args[evidenceIdx + 1] : undefined;
  const force = args.includes("--force");
  if (!tid || !toStatus) fail(2, "usage: step set-status <PID> <status> [--reason \"...\"] [--evidence <path>] [--force]");
  if (!TASK_STATUS_ALLOWED.has(toStatus)) {
    fail(2, `spec-state: step set-status: unknown status "${toStatus}". Allowed: ${[...TASK_STATUS_ALLOWED].join(", ")}`);
  }
  if (TASK_HELD_STATUS_FIELDS[toStatus] && !reason) {
    fail(3, `spec-state: step set-status ${toStatus} requires --reason "<short reason>"`);
  }

  withNamedLock(dataDir, `task-${tid}`, () => {
    const path = resolveTaskFile(dataDir, tid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${tid} has no frontmatter block — refusing`);
    const fromStatus = getScalar(fm.block, "status");

    // Park-evidence price parity (rec 2, opt-in via execution.require_park_evidence).
    // A task that was actively being built and is now parked should have a
    // capture/return to show for it — mirroring what `task accept-return`
    // demands for completion. Scoped to the in-progress → parked transition:
    // pre-dispatch parks (from approved/todo — routing/design blocks like
    // misrouted_kind or design_ambiguity) legitimately have NO capture, so
    // requiring evidence there would break them. `--force` bypasses.
    if (
      TASK_HELD_STATUS_FIELDS[toStatus] &&
      fromStatus === "in-progress" &&
      !force &&
      readRequireParkEvidence(dataDir)
    ) {
      let evidenceOk = false;
      if (evidence) {
        try { evidenceOk = statSync(evidence).size > 0; } catch { evidenceOk = false; }
      }
      if (!evidenceOk) {
        fail(
          3,
          `spec-state: step set-status ${toStatus} from in-progress requires --evidence <path> to a non-empty capture/return file ` +
            `(execution.require_park_evidence is on). Point it at the builder's capture log or .subagent-returns/<id>.json, or pass --force.`,
        );
      }
    }

    if (fromStatus === "done" && toStatus !== "done" && !force) {
      fail(
        3,
        `spec-state: step ${tid} status "done" is terminal — leaving it requires --force (attempted done -> ${toStatus})`,
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

    // v4: the builder unit is a step; writers emit step_status_set (readers
    // accept the old task_status_set). task_blocked keeps its name (A-02).
    const eventFields = { task: tid, step: tid, from: fromStatus, to: toStatus };
    if (reason) eventFields.reason = reason;
    emit(dataDir, "step_status_set", eventFields);
    if (toStatus === "blocked") {
      emit(dataDir, "task_blocked", { task: tid, reason });
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
    emit(dataDir, "step_verify_appended", { task: tid, iteration, exit: exitCode });
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
  // 4.20.1: project files a discussion may write (where this project records
  // its decisions); everything else in the project is read-only to /ship-discuss.
  "discuss-writable": { fmKey: "discuss_writable", type: "array" },
  "verify-ignore": { fmKey: "verify_ignore", type: "array" },
  // after 4.0.0: ask | auto | off — how tracker tickets are kept in step with what Shipyard decides and builds
  "tracker-sync": { fmKey: "tracker_sync", type: "scalar" },
  "worktree-warm-enabled": { parent: "worktree_warm", fmKey: "enabled", type: "bool" },
  "worktree-warm-paths": { parent: "worktree_warm", fmKey: "paths", type: "array" },
  "test-commands-rerun-failed": { parent: "test_commands", fmKey: "rerun_failed", type: "scalar" },
  // 4.4: the commands the pipeline runs were not settable by CLI, so the
  // orchestrator hand-edited config.md (seen live) — now typed and atomic.
  "test-commands-unit": { parent: "test_commands", fmKey: "unit", type: "scalar" },
  "test-commands-integration": { parent: "test_commands", fmKey: "integration", type: "scalar" },
  "test-commands-e2e": { parent: "test_commands", fmKey: "e2e", type: "scalar" },
  "test-commands-scoped": { parent: "test_commands", fmKey: "scoped", type: "scalar" },
  "build-commands-full": { parent: "build_commands", fmKey: "full", type: "scalar" },
  "build-commands-scoped": { parent: "build_commands", fmKey: "scoped", type: "scalar" },
  "project-type": { fmKey: "project_type", type: "scalar" },
  "ui-adapter": { parent: "ui", fmKey: "adapter", type: "scalar" },
  "routing-size-tiers": { parent: "routing", fmKey: "size_tiers", type: "scalar" },
  "ui-frame-command": { parent: "ui", fmKey: "frame_command", type: "scalar" },
  "ui-base-url": { parent: "ui", fmKey: "base_url", type: "scalar" },
  "ui-playwright-root": { parent: "ui", fmKey: "playwright_root", type: "scalar" },
  "testing-framework": { fmKey: "testing_framework", type: "scalar" },
  "e2e-framework": { fmKey: "e2e_framework", type: "scalar" },
  "max-undispositioned-ideas": { parent: "execution", fmKey: "max_undispositioned_ideas", type: "scalar" },
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
  emit(dataDir, "config_set", { key: loggedKey });
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
    emit(dataDir, "research_draft_obsoleted", { topic: expectedTopic ?? null });
    process.stdout.write(".research-draft.md obsolete: true\n");
  });
}

function draftSetSprintStatus(dataDir, args) {
  const status = args[0];
  const allowed = new Set(["superseded", "cancelled"]);
  if (!status || !allowed.has(status)) {
    fail(2, "usage: draft set-sprint-status <superseded|cancelled> [--next]");
  }
  // --next: the sprint drafted ahead while another one runs (4.17)
  const path = join(dataDir, "sprints", args.includes("--next") ? "next" : "current", "SPRINT-DRAFT.md");
  if (!existsSync(path)) fail(4, `spec-state: no ${path}`);

  withNamedLock(dataDir, "sprint-draft", () => {
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, "spec-state: SPRINT-DRAFT.md has no frontmatter block — refusing");
    const block = setScalar(fm.block, "status", status);
    writeFrontmatteredFile(path, fm, block);
    emit(dataDir, "sprint_draft_status_set", { status });
    process.stdout.write(`SPRINT-DRAFT.md status: ${status}\n`);
  });
}

// --- dispatch ----------------------------------------------------------------

function storyDispatch(dataDir, sub, rest) {
  switch (sub) {
    case "add":
      try { return storyAdd(dataDir, rest); } catch (e) { if (typeof e?.exitCode === "number") fail(e.exitCode, `spec-state: story add: ${e.message}`); throw e; }
    case "refine":
      try { return storyRefine(dataDir, rest); } catch (e) { if (typeof e?.exitCode === "number") fail(e.exitCode, `spec-state: story refine: ${e.message}`); throw e; }
    case "set-status":
      return featureSetStatus(dataDir, rest);
    case "set":
      return featureSet(dataDir, rest);
    case "add-ref":
      return featureAddRef(dataDir, rest);
    case "remove-ref":
      return featureRemoveRef(dataDir, rest);
    case "add-external-ref":
      return featureAddExternalRef(dataDir, rest);
    case "add-dep":
      return featureDepLink(dataDir, rest, { add: true });
    case "remove-dep":
      return featureDepLink(dataDir, rest, { add: false });
    case "clear-steps":
    case "clear-tasks":
      return featureClearTasks(dataDir, rest);
    case "set-steps":
    case "set-tasks":
      return featureSetTasks(dataDir, rest);
    case "retract-proof":
      return featureRetractProof(dataDir, rest);
    case "record-proof":
      return featureRecordProof(dataDir, rest);
    case "check-probes":
      return featureCheckProbes(dataDir, rest);
    case "probe-command":
      return probeCommandMain(dataDir, rest);
    case "check-scenarios":
      return featureCheckScenarios(dataDir, rest);
    case "acs":
      return storyAcs(dataDir, rest);
    case "assign-ac-ids":
      return featureAssignAcIds(dataDir, rest);
    default:
      fail(2, `shipyard-data story: unknown subcommand "${sub ?? ""}". Expected: add|refine|set-status|set|add-ref|remove-ref|add-external-ref|add-dep|remove-dep|set-steps|clear-steps|record-proof|retract-proof|check-probes|check-scenarios|acs|probe-command|assign-ac-ids`);
  }
}

/**
 * `step set-deps <PID> <PID,PID|none>` (4.0): the steps this one waits for.
 * A step's frontmatter is CLI-owned, and there was no verb for this field: a
 * planner repairing a plan could not move one step to an earlier wave without
 * editing the file around the guard. Refuses an unknown step, the step
 * itself, and a loop (a step it names already waits for it).
 */
function stepSetDeps(dataDir, args) {
  const positional = args.filter((a) => !a.startsWith("--"));
  const pid = positional[0];
  const raw = positional[1];
  if (!pid || raw === undefined) fail(2, "usage: step set-deps <PID> <PID,PID,...|none>");
  const deps = raw === "none" ? [] : [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  const depsOf = (id) => {
    try { const fm = parseFm(readFileSync(resolveTaskFile(dataDir, id), "utf8")); return fm ? parseFrontmatterList(fm.block, "dependencies").items : []; } catch { return null; }
  };
  for (const d of deps) {
    if (d === pid) fail(3, `spec-state: ${pid} cannot wait for itself`);
    if (!TID_RE.test(d) || depsOf(d) === null) fail(3, `spec-state: ${d} is not a step that exists`);
    // a loop: does d (or anything it waits for) wait for pid?
    const seen = new Set();
    const stack = [d];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const n of depsOf(cur) ?? []) { if (n === pid) fail(3, `spec-state: ${d} already waits for ${pid} (through ${cur}): that would be a loop`); stack.push(n); }
    }
  }
  withNamedLock(dataDir, `task-${pid}`, () => {
    const path = resolveTaskFile(dataDir, pid);
    const content = readFileSync(path, "utf8");
    const fm = parseFm(content);
    if (!fm) fail(3, `spec-state: ${pid} has no frontmatter block — refusing`);
    const before = parseFrontmatterList(fm.block, "dependencies").items;
    let block = setArrayField(fm.block, "dependencies", deps);
    block = setScalar(block, "updated", today());
    writeFrontmatteredFile(path, fm, block);
    emit(dataDir, "step_dependencies_set", { step: pid, from: before.join(","), to: deps.join(",") });
    process.stdout.write(`${pid}: waits for ${deps.length ? deps.join(", ") : "nothing"} (was ${before.length ? before.join(", ") : "nothing"})\n`);
  });
}

function stepDispatch(dataDir, sub, rest) {
  switch (sub) {
    case "set-status":
      return taskSetStatus(dataDir, rest);
    case "append-verify":
      return taskAppendVerify(dataDir, rest);
    case "set-deps":
      return stepSetDeps(dataDir, rest);
    default:
      fail(2, `shipyard-data step: unknown subcommand "${sub ?? ""}". Expected: set-status|append-verify|set-deps`);
  }
}

/**
 * v4 (F022, terminology-v4 §3): entity words are aliases — `story` (canonical),
 * `feature`, `bug` all reach the story commands; `step` is the builder unit;
 * `task` is the new enabling-work entity, except that a `task` verb aimed at a
 * legacy builder record (type task, kind feature|operational|research) keeps
 * working with the step vocabulary, so pre-v4 skill text and un-migrated data
 * never break (A-02: "task set-status accepted, step set-status canonical").
 */
function dispatch(dataDir, entity, sub, rest) {
  const canonical = entityForVerb(entity);
  if (canonical === "story") return storyDispatch(dataDir, sub, rest);
  if (canonical === "step") return stepDispatch(dataDir, sub, rest);
  if (canonical === "task") {
    if (sub === "add") { try { return taskAdd(dataDir, rest); } catch (e) { if (typeof e?.exitCode === "number") fail(e.exitCode, `spec-state: task add: ${e.message}`); throw e; } }
    if (sub === "append-verify") return taskAppendVerify(dataDir, rest);
    if (sub === "set-status") {
      const positional = rest.filter((a) => !a.startsWith("--"));
      const tid = positional[0];
      const toStatus = positional[1];
      const fm = tid && TID_RE.test(tid) ? readUnitFrontmatter(dataDir, tid) : null;
      // A record is a NEW task only when it says so (kind in TASK_KINDS). Pre-v4
      // builder files — including minimal ones with just id/status — keep the
      // step vocabulary, so nothing written before v4 changes meaning.
      const isNewTask = fm ? TASK_KINDS.includes(String(fm.kind ?? "").trim()) : false;
      const taskOnlyStatus = !!(toStatus && TASK_TRANSITIONS[toStatus] && !TASK_STATUS_ALLOWED.has(toStatus));
      if (fm && !STEP_ID_RE.test(tid) && (isNewTask || (taskOnlyStatus && !isBuilderRecord(fm)))) return taskEntitySetStatus(dataDir, rest);
      if (!fm && taskOnlyStatus) return taskEntitySetStatus(dataDir, rest);
      return taskSetStatus(dataDir, rest);
    }
    fail(2, `shipyard-data task: unknown subcommand "${sub ?? ""}". Expected: add|set-status|append-verify   (a new spike or chore: task add --title "..." --kind spike [--parent <E###>])`);
  }
  if (canonical === "epic") {
    if (sub === "set-status") return epicSetStatus(dataDir, rest);
    fail(2, `shipyard-data epic: unknown subcommand "${sub ?? ""}". Expected: set-status`);
  }
  if (canonical === "idea") {
    switch (sub) {
      case "set-status":
        return ideaSetStatus(dataDir, rest);
      case "repair":
        return ideaRepair(dataDir, rest);
      case "triage":
        return ideaTriage(dataDir, rest);
      case "capture":
        return ideaCapture(dataDir, rest);
      case "promote":
        try { return ideaPromote(dataDir, rest); } catch (e) { if (typeof e?.exitCode === "number") fail(e.exitCode, `spec-state: idea promote: ${e.message}`); throw e; }
      default:
        fail(2, `shipyard-data idea: unknown subcommand "${sub ?? ""}". Expected: capture|promote|set-status|triage|repair`);
    }
  }
  if (entity === "backlog") {
    switch (sub) {
      case "add":
        return backlogAdd(dataDir, rest);
      case "remove":
        return backlogRemove(dataDir, rest);
      case "rank":
        return backlogRank(dataDir, rest);
      case "move":
        return backlogMove(dataDir, rest);
      case "set":
        return backlogSet(dataDir, rest);
      default:
        fail(2, `shipyard-data backlog: unknown subcommand "${sub ?? ""}". Expected: board|add|remove|move|rank|set`);
    }
  }
  if (entity === "config") {
    if (sub === "set") return configSet(dataDir, rest);
    fail(2, `shipyard-data config: unknown subcommand "${sub ?? ""}" (via spec-state-cli). Expected: set`);
  }
  if (entity === "draft") {
    switch (sub) {
      case "obsolete-research":
        return draftObsoleteResearch(dataDir, rest);
      case "set-sprint-status":
        return draftSetSprintStatus(dataDir, rest);
      default:
        fail(2, `shipyard-data draft: unknown subcommand "${sub ?? ""}". Expected: obsolete-research|set-sprint-status`);
    }
  }
  fail(2, `shipyard-data: unknown entity "${entity ?? ""}". Expected: story|step|task|epic|idea|backlog|config|draft (feature and bug are accepted aliases of story)`);
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
