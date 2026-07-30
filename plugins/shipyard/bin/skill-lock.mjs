/**
 * skill-lock — single owner of both Shipyard skill-mutex lock files:
 *   `<SHIPYARD_DATA>/.active-session.json`   (kind: "planning"  — ship-discuss/ship-sprint/ship-quick's planning phase)
 *   `<SHIPYARD_DATA>/.active-execution.json` (kind: "execution" — ship-execute/ship-review/ship-quick's execution phase)
 *
 * Planning and execution are mutually exclusive except for the narrow
 * ship-discuss + ship-execute pair. That exception is intentional: discussion
 * can safely author future/backlog work while execute owns the active sprint.
 * The skill body is responsible for treating active-sprint specs/tasks as
 * read-only in that concurrent mode.
 *
 * Pre-v3.7.0, these were hand-Written by skill bodies following the
 * `acquiring-skill-lock` capability skill's prose procedure — the same
 * class of drift the CLI absorption already closed for SPRINT.md/feature
 * frontmatter/BACKLOG.md. One writer implementation now backs every read
 * path: `shipyard-data lock acquire|release|check|status`, `shipyard-data
 * init`'s pre-creation sentinel, and `cursor-cli.mjs`'s resting-path
 * auto-release (`clearExecutionLock` calls `releaseLock(dataDir,
 * "execution", {force:true, bestEffort:true})` from here instead of
 * hand-writing JSON).
 *
 * NOTE: bootstrap-check / loop_owner (the /loop auto-bootstrap eligibility
 * heuristic in cursor-cli.mjs) are a SEPARATE concern living on the
 * pipeline cursor, not on these lock files — no interaction between the
 * two mechanisms. Don't conflate "is a /loop wakeup eligible to auto-start
 * a pipeline" with "is a skill-mutex lock held."
 *
 * Lock shape (a held lock):
 *   {
 *     "skill": "ship-execute",
 *     "sprint": "sprint-007" | null,
 *     "wave": 2 | null,
 *     "started": "<iso>",
 *     "session_id": "<claude-code-session-id>" | null,
 *     "cleared": null,
 *     "depth": 1
 *   }
 * A released (soft-deleted) lock: {"skill": null, "cleared": "<iso>"}. The
 * file is NEVER unlinked — soft-delete keeps it on disk for diagnosability
 * and avoids a read/unlink/create race with a concurrent inspector.
 *
 * `compaction_count` from the pre-v3.7.0 shape is DELETED, not carried
 * forward — it was initialized but never incremented (the `post-compact`
 * hook that bumped it was retired well before this rewrite), so the
 * `/ship-execute` warning gated on it never fired. Any future PreCompact
 * re-wire should land as a NEW field/mechanism, not a resurrection of this
 * one — it was dead weight, not a working feature.
 *
 * Session identity: read `CLAUDE_SESSION_ID` from the environment; a
 * `--session <id>` CLI flag overrides it. If BOTH are absent, the caller is
 * "session_unverified" — the CLI degrades ASYMMETRICALLY on purpose:
 *   - acquire treats ANY fresh (non-stale, non-released) held lock as
 *     held-by-another-session, even if that lock's own `session_id` is
 *     also null — two different unverified callers must never silently
 *     treat each other's locks as their own.
 *   - release still succeeds when the held lock's `skill` matches the
 *     `--skill` argument — releasing is the lower-risk direction (worst
 *     case: a legitimate release no-ops and the lock sits held a bit
 *     longer for the next caller to recover-as-stale), so it falls back to
 *     name-matching instead of hard-refusing every unverified release.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, logEvent, sanitizeForLog, withLockfile } from "./_hook_lib.mjs";

export const LOCK_FILES = Object.freeze({
  planning: ".active-session.json",
  execution: ".active-execution.json",
});

// The one place the 2-hour stale-lock threshold is defined. Nothing else
// (skill bodies, other CLIs) should hardcode this number.
export const STALE_MS = 2 * 60 * 60 * 1000;

const SKILL_ARG_RE = /^ship-[a-z-]+$/;

function lockPath(dataDir, kind) {
  const base = LOCK_FILES[kind];
  if (!base) throw new Error(`skill-lock: unknown lock kind "${kind}" — expected planning|execution`);
  return join(dataDir, base);
}

function metaLockPath(dataDir, kind) {
  return join(dataDir, `.skill-lock.${kind}.lock`);
}

function acquireMetaLockPath(dataDir) {
  return join(dataDir, ".skill-lock.acquire.lock");
}

function isAllowedConcurrentPair(requestedKind, requestedSkill, otherKind, otherSkill) {
  return (
    requestedKind === "planning" &&
    requestedSkill === "ship-discuss" &&
    otherKind === "execution" &&
    otherSkill === "ship-execute"
  ) || (
    requestedKind === "execution" &&
    requestedSkill === "ship-execute" &&
    otherKind === "planning" &&
    otherSkill === "ship-discuss"
  );
}

/**
 * Resolve the caller's session identity. `--session <id>` (if present in
 * argv) wins over `CLAUDE_SESSION_ID`. Both absent => unverified.
 */
export function resolveSessionIdentity(args) {
  const idx = args.indexOf("--session");
  if (idx !== -1 && args[idx + 1]) {
    return { sessionId: args[idx + 1], unverified: false };
  }
  const envId = process.env.CLAUDE_SESSION_ID || "";
  if (envId) return { sessionId: envId, unverified: false };
  return { sessionId: null, unverified: true };
}

/** Read + parse a lock file. Never throws — corruption is a classification, not an error. */
function readLockFile(dataDir, kind) {
  const path = lockPath(dataDir, kind);
  if (!existsSync(path)) return { exists: false, corrupt: false, obj: null, raw: "" };
  let raw = "";
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { exists: true, corrupt: true, obj: null, raw: "" };
  }
  try {
    const obj = JSON.parse(raw);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return { exists: true, corrupt: true, obj: null, raw };
    }
    return { exists: true, corrupt: false, obj, raw };
  } catch {
    return { exists: true, corrupt: true, obj: null, raw };
  }
}

function isReleased(obj) {
  return !obj || obj.cleared || obj.skill === null || obj.skill === undefined;
}

function ageMs(obj, nowMs) {
  const started = obj?.started ? Date.parse(obj.started) : NaN;
  if (!Number.isFinite(started)) return Infinity; // unparseable timestamp -> treat as stale
  return nowMs - started;
}

/**
 * Classify a lock file's state relative to a caller's identity, WITHOUT
 * writing anything. Used by `lock check`, `lock status`, and as the first
 * half of `lock acquire`'s decision.
 *
 *   "free"     — no file at all
 *   "released" — soft-delete sentinel present
 *   "corrupt"  — file exists but isn't parseable JSON / not an object
 *   "stale"    — held, but `started` is older than STALE_MS
 *   "mine"     — held, session_id matches ours (never true when unverified)
 *   "held"     — held by someone else, fresh
 */
function classify(dataDir, kind, sessionId, unverified, nowMs) {
  const read = readLockFile(dataDir, kind);
  if (!read.exists) return { state: "free", read };
  if (read.corrupt) return { state: "corrupt", read };
  if (isReleased(read.obj)) return { state: "released", read };
  if (ageMs(read.obj, nowMs) > STALE_MS) return { state: "stale", read };
  if (!unverified && read.obj.session_id === sessionId) return { state: "mine", read };
  return { state: "held", read };
}

function blockText(kind, obj) {
  const label = kind === "planning" ? "planning session" : "execution lock";
  return (
    `⛔ Another ${label} is active.\n` +
    `   Skill:      ${obj.skill ?? "(unknown)"}\n` +
    (obj.sprint ? `   Sprint:     ${obj.sprint}\n` : "") +
    `   Started:    ${obj.started ?? "(unknown)"}\n` +
    `   Session ID: ${obj.session_id ?? "(none recorded)"}\n\n` +
    `Finish or pause that session first, or run /ship-status to clear a stale lock.`
  );
}

function writeLockObj(dataDir, kind, obj) {
  atomicWrite(lockPath(dataDir, kind), JSON.stringify(obj) + "\n");
}

/**
 * `shipyard-data lock acquire <planning|execution> --skill <ship-*>
 *   [--sprint <id>] [--wave <n>] [--session <id>]`
 *
 * Returns a result object; never calls process.exit itself (the CLI
 * wrapper does that) so it stays usable as a library call if ever needed.
 */
export function acquireLock(dataDir, kind, opts) {
  const { skill, sprint = null, wave = null, sessionId, unverified } = opts;
  if (!SKILL_ARG_RE.test(skill || "")) {
    return { ok: false, code: 2, message: `skill-lock: --skill must match ^ship-[a-z-]+$ (got "${skill}")` };
  }

  let result;
  withLockfile(acquireMetaLockPath(dataDir), () => {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const own = classify(dataDir, kind, sessionId, unverified, nowMs);

    // Held-by-another-fresh-session is checked FIRST — no write happens on
    // this path, and the cross-lock check below still runs so both sides
    // of a "both strangers" situation get reported together.
    const ownBlocked = own.state === "held";

    const otherKind = kind === "planning" ? "execution" : "planning";
    const other = classify(dataDir, otherKind, sessionId, unverified, nowMs);
    const concurrentAllowed =
      other.state === "held" &&
      isAllowedConcurrentPair(kind, skill, otherKind, other.read.obj?.skill ?? null);
    const otherBlocked = other.state === "held" && !concurrentAllowed;

    if (ownBlocked || otherBlocked) {
      const blocks = [];
      if (ownBlocked) blocks.push({ kind, ...own.read.obj });
      if (otherBlocked) blocks.push({ kind: otherKind, ...other.read.obj });
      let stderrText = blocks.map((b) => blockText(b.kind, b)).join("\n\n");
      if (ownBlocked && otherBlocked) {
        stderrText += "\n\nBoth lock files are held by other sessions — run /ship-status to clear a stale one.";
      }
      logEvent(dataDir, "skill_lock_blocked", { kind, skill, holder_skill: own.read.obj?.skill ?? null });
      result = {
        ok: false,
        code: 3,
        message: stderrText,
        json: { acquired: false, blocked: blocks.length === 1 ? blocks[0] : blocks },
      };
      return;
    }

    // Not blocked on either lock. Decide the write for the OWN lock.
    let reentry = false;
    let recovered = null; // "stale" | "corrupt" | null
    let depth = 1;
    let priorForEvent = null;

    if (own.state === "mine") {
      reentry = true;
      depth = (Number.isInteger(own.read.obj.depth) ? own.read.obj.depth : 1) + 1;
    } else if (own.state === "stale") {
      recovered = "stale";
      priorForEvent = {
        prior_session_id: own.read.obj.session_id ?? null,
        prior_skill: own.read.obj.skill ?? null,
        prior_age_hours: Math.round((ageMs(own.read.obj, nowMs) / 3600000) * 10) / 10,
      };
    } else if (own.state === "corrupt") {
      recovered = "corrupt";
    }
    // own.state === "free" | "released" -> plain fresh acquire, nothing extra.

    const newObj =
      reentry
        ? { ...own.read.obj, skill, sprint: sprint ?? own.read.obj.sprint ?? null, wave: wave ?? own.read.obj.wave ?? null, depth }
        : { skill, sprint, wave, started: nowIso, session_id: sessionId, cleared: null, depth: 1 };

    writeLockObj(dataDir, kind, newObj);

    if (recovered === "stale") {
      logEvent(dataDir, "stale_lock_recovered", { kind, ...priorForEvent });
    } else if (recovered === "corrupt") {
      logEvent(dataDir, "corrupt_lock_recovered", { kind, raw_tail: sanitizeForLog(own.read.raw.slice(-120), 120) });
    }
    logEvent(dataDir, "skill_lock_acquired", { kind, skill, reentry, recovered: recovered || false });

    let stderrText = "";
    if (recovered === "stale") {
      stderrText = `(recovered stale ${priorForEvent.prior_skill ?? "unknown"} lock started ${priorForEvent.prior_age_hours}h ago)`;
    } else if (recovered === "corrupt") {
      stderrText = `(recovered corrupt ${kind} lock — previous content was not valid JSON)`;
    }

    const crossLockSameSession = other.state === "mine";

    result = {
      ok: true,
      code: 0,
      message: stderrText,
      json: {
        acquired: true,
        reentry,
        depth: newObj.depth,
        ...(recovered ? { recovered } : {}),
        ...(crossLockSameSession ? { cross_lock_same_session: true } : {}),
        ...(concurrentAllowed ? { cross_lock_allowed: "ship-discuss+ship-execute" } : {}),
      },
    };
    if (concurrentAllowed) {
      logEvent(dataDir, "skill_lock_concurrent_allowed", {
        kind,
        skill,
        other_kind: otherKind,
        other_skill: other.read.obj?.skill ?? null,
      });
    }
  });
  return result;
}

/**
 * `shipyard-data lock release <planning|execution> [--skill <name>]
 *   [--force] [--session <id>]`
 */
export function releaseLock(dataDir, kind, opts = {}) {
  const { skill, sessionId, unverified = true, force = false, bestEffort = false } = opts;

  const run = () => {
    let result;
    withLockfile(metaLockPath(dataDir, kind), () => {
      const nowIso = new Date().toISOString();
      const read = readLockFile(dataDir, kind);

      if (force) {
        writeLockObj(dataDir, kind, { skill: null, cleared: nowIso });
        if (!bestEffort) {
          logEvent(dataDir, "skill_lock_released", { kind, skill: read.obj?.skill ?? null, forced: true });
        }
        result = { ok: true, code: 0, message: "", json: { released: true, forced: true } };
        return;
      }

      if (!read.exists || read.corrupt || isReleased(read.obj)) {
        // Idempotent no-op — already released (or nothing to release).
        result = { ok: true, code: 0, message: "", json: { released: true, alreadyReleased: true } };
        return;
      }

      const mine = unverified ? read.obj.skill === skill : read.obj.session_id === sessionId;
      if (!mine) {
        result = { ok: true, code: 0, message: "", json: { released: false, reason: "held_by_other" } };
        return;
      }

      const depth = Number.isInteger(read.obj.depth) ? read.obj.depth : 1;
      if (depth > 1) {
        writeLockObj(dataDir, kind, { ...read.obj, depth: depth - 1 });
        result = { ok: true, code: 0, message: "", json: { released: false, depth: depth - 1 } };
        return;
      }

      writeLockObj(dataDir, kind, { skill: null, cleared: nowIso });
      logEvent(dataDir, "skill_lock_released", { kind, skill: read.obj.skill, forced: false });
      result = { ok: true, code: 0, message: "", json: { released: true, depth: 0 } };
    });
    return result;
  };

  if (bestEffort) {
    try {
      return run();
    } catch {
      return null;
    }
  }
  return run();
}

/**
 * `shipyard-data lock check <planning|execution>` — read-only, no writes,
 * no recovery. Mirrors `acquire`'s "mine" identity test (session_id match,
 * never true when unverified) so it previews what an acquire would decide.
 */
export function checkLock(dataDir, kind, opts) {
  const { sessionId, unverified } = opts;
  const nowMs = Date.now();
  const c = classify(dataDir, kind, sessionId, unverified, nowMs);
  if (c.state === "held") {
    return {
      ok: false,
      code: 3,
      message: blockText(kind, c.read.obj),
      json: { state: "held", blocked: { kind, ...c.read.obj } },
    };
  }
  return { ok: true, code: 0, message: "", json: { state: c.state === "corrupt" ? "released" : c.state } };
}

/** `shipyard-data lock status` — read-only, both files, one JSON line, never recovers. */
export function lockStatus(dataDir, opts) {
  const { sessionId, unverified } = opts;
  const nowMs = Date.now();
  const out = {};
  for (const kind of ["planning", "execution"]) {
    const c = classify(dataDir, kind, sessionId, unverified, nowMs);
    out[kind] = {
      state: c.state === "corrupt" ? "released" : c.state,
      ...(c.read.obj && !isReleased(c.read.obj) ? { skill: c.read.obj.skill, sprint: c.read.obj.sprint ?? null, started: c.read.obj.started ?? null } : {}),
    };
  }
  return { ok: true, code: 0, message: "", json: out };
}

/**
 * CLI dispatch, called from shipyard-data.mjs's main(). Prints the JSON
 * line to stdout, the human block/recovery text to stderr (for the calling
 * skill to echo verbatim), and exits with the resolved code.
 */
export function skillLockCmd(dataDir, args) {
  const [sub, kind, ...rest] = args;
  const { sessionId, unverified } = resolveSessionIdentity(rest);
  const skillIdx = rest.indexOf("--skill");
  const skill = skillIdx !== -1 ? rest[skillIdx + 1] : undefined;
  const sprintIdx = rest.indexOf("--sprint");
  const sprint = sprintIdx !== -1 ? rest[sprintIdx + 1] : null;
  const waveIdx = rest.indexOf("--wave");
  const wave = waveIdx !== -1 ? parseInt(rest[waveIdx + 1], 10) : null;
  const force = rest.includes("--force");

  const emit = (r) => {
    if (r.message) process.stderr.write(r.message.endsWith("\n") ? r.message : r.message + "\n");
    process.stdout.write(JSON.stringify(r.json) + "\n");
    process.exit(r.code);
  };

  if (sub === "acquire") {
    if (!kind || !LOCK_FILES[kind]) {
      process.stderr.write("usage: lock acquire <planning|execution> --skill <ship-*> [--sprint <id>] [--wave <n>]\n");
      process.exit(2);
    }
    return emit(acquireLock(dataDir, kind, { skill, sprint, wave, sessionId, unverified }));
  }
  if (sub === "release") {
    if (!kind || !LOCK_FILES[kind]) {
      process.stderr.write("usage: lock release <planning|execution> [--skill <name>] [--force]\n");
      process.exit(2);
    }
    return emit(releaseLock(dataDir, kind, { skill, sessionId, unverified, force }));
  }
  if (sub === "check") {
    if (!kind || !LOCK_FILES[kind]) {
      process.stderr.write("usage: lock check <planning|execution>\n");
      process.exit(2);
    }
    return emit(checkLock(dataDir, kind, { sessionId, unverified }));
  }
  if (sub === "status") {
    return emit(lockStatus(dataDir, { sessionId, unverified }));
  }
  process.stderr.write(`shipyard-data lock: unknown subcommand "${sub ?? ""}". Expected: acquire|release|check|status\n`);
  process.exit(2);
}
