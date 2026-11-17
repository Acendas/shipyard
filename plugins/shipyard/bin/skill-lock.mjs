/**
 * skill-lock — single owner of both Shipyard skill-mutex lock files:
 *   `<SHIPYARD_DATA>/.active-session.json`   (kind: "planning"  — ship-discuss/ship-sprint)
 *   `<SHIPYARD_DATA>/.active-execution.json` (kind: "execution" — ship-execute/ship-review)
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
 * NOTE: goal-driven cursor re-entry is a SEPARATE concern living on the
 * pipeline cursor, not on these lock files — no interaction between the
 * two mechanisms. Don't conflate "should a goal tick continue a pipeline"
 * with "is a skill-mutex lock held."
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

import { readEvents, liveAgents } from "./terminal-gate.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { atomicWrite, logEvent, sanitizeForLog, withLockfile } from "./_hook_lib.mjs";
import { strayChanges } from "./stray.mjs";
import { syncOwed } from "./tracker.mjs";
import { sourcesOwed, waitingTopics } from "./discuss-questions.mjs";
import { readQueue, summarize as queueSummary } from "./discuss-queue.mjs";

/** Tracked files changed with no commit in the project folder; null when there is no repository to ask. */
function dirtyTracked(dataDir) {
  try { const s = strayChanges(dataDir); return s ? s.tracked : null; } catch { return null; }
}

/** Of `files` (repo-relative), those the write hook recorded this session writing since `sinceIso`. */
function wroteThisSession(dataDir, sessionId, sinceIso, files) {
  if (!sessionId) return [];
  const since = (Date.parse(sinceIso ?? "") || 0) - 1000; // event timestamps are whole seconds, the lock's start has milliseconds
  let lines = [];
  try { lines = readFileSync(join(dataDir, ".shipyard-events.jsonl"), "utf8").split("\n").slice(-4000); } catch { return []; }
  const wrote = [];
  for (const l of lines) {
    if (!l.includes("discuss_wrote_project_file")) continue;
    try { const e = JSON.parse(l); if (e.type === "discuss_wrote_project_file" && String(e.session ?? "") === String(sessionId) && Date.parse(e.ts) >= since) wrote.push(String(e.file ?? "")); } catch { /* skip */ }
  }
  return files.filter((f) => wrote.some((w) => w === f || w.endsWith(`/${f}`) || f.endsWith(w)));
}

export const LOCK_FILES = Object.freeze({
  planning: ".active-session.json",
  execution: ".active-execution.json",
  discuss: ".active-discuss.json",
});

/**
 * One lock per command family (4.17). A lock stops a second copy of the SAME
 * command; it never stops a different one:
 *   discuss    /ship-discuss
 *   planning   /ship-sprint
 *   execution  /ship-execute, /ship-review, /ship-debug's fix phase (they all
 *              act on the working tree and the current sprint, one at a time)
 * So a discussion runs beside planning or a sprint, and the next sprint is
 * drafted while the current one executes. What keeps them out of each other's
 * way is where they write (the running sprint is read-only to the others; a
 * sprint planned ahead lives in `sprints/next/`), not the lock.
 *
 * Before 4.17 discuss shared the planning lock with /ship-sprint, and planning
 * and execution excluded each other except for discuss + execute. Callers that
 * still say `planning --skill ship-discuss` are mapped to the discuss lock.
 */
export function resolveKind(kind, skill) {
  return kind === "planning" && skill === "ship-discuss" ? "discuss" : kind;
}

// The one place the 2-hour stale-lock threshold is defined. Nothing else
// (skill bodies, other CLIs) should hardcode this number.
export const STALE_MS = 2 * 60 * 60 * 1000;

const SKILL_ARG_RE = /^ship-[a-z-]+$/;

function lockPath(dataDir, kind) {
  const base = LOCK_FILES[kind];
  if (!base) throw new Error(`skill-lock: unknown lock kind "${kind}" — expected planning|execution|discuss`);
  return join(dataDir, base);
}

function metaLockPath(dataDir, kind) {
  return join(dataDir, `.skill-lock.${kind}.lock`);
}

function acquireMetaLockPath(dataDir) {
  return join(dataDir, ".skill-lock.acquire.lock");
}

/** Other command families holding a lock in ANOTHER session right now: [{kind, skill, session_id}]. */
export function runningBeside(dataDir, kind, sessionId, unverified, nowMs = Date.now()) {
  const out = [];
  for (const k of Object.keys(LOCK_FILES)) {
    if (k === kind) continue;
    const c = classify(dataDir, k, sessionId, unverified, nowMs);
    if (c.state === "held") out.push({ kind: k, skill: c.read.obj?.skill ?? null, session_id: c.read.obj?.session_id ?? null, state: c.state });
    else if (c.state === "mine") out.push({ kind: k, skill: c.read.obj?.skill ?? null, session_id: c.read.obj?.session_id ?? null, state: c.state });
  }
  return out;
}

/**
 * Resolve the caller's session identity. `--session <id>` (if present in
 * argv) wins over the environment. Both absent => unverified.
 *
 * Environment: Claude Code exports the session id as `CLAUDE_CODE_SESSION_ID`
 * to Bash tool subprocesses (verified 2026-07-31). The original code read
 * `CLAUDE_SESSION_ID`, a name Claude Code never sets, so EVERY skill acquired
 * its lock `unverified` (`session_id: null`) — which disabled the whole
 * same-session "mine" recovery path in `classify()`. The visible symptom was
 * that a skill which abruptly exited (error/halt) left a lock the SAME session
 * could no longer re-acquire (it was mis-read as held-by-a-stranger), forcing
 * the user to run `/ship-status` until the 2-hour stale threshold. We read the
 * real `CLAUDE_CODE_SESSION_ID` first and keep `CLAUDE_SESSION_ID` as a
 * backward-compatible fallback.
 */
export function resolveSessionIdentity(args) {
  const idx = args.indexOf("--session");
  if (idx !== -1 && args[idx + 1]) {
    return { sessionId: args[idx + 1], unverified: false };
  }
  const envId = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "";
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
/**
 * The owning Claude Code process is gone (4.6). A hard kill, a crash or a
 * closed terminal never runs the SessionEnd reaper, so the lock used to block
 * the next session for the full 2-hour stale window. The lock records the
 * owner's pid and host; a pid that no longer exists on this host means the
 * session is dead and the lock is recoverable at once. Unknown pid, another
 * host, or a permission error all read as "alive" — never steal a live lock.
 */
export function ownerIsDead(obj) {
  const pid = Number(obj?.owner_pid);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  if (obj.owner_host && obj.owner_host !== hostname()) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err && err.code === "ESRCH";
  }
}

function ownerIdentity() {
  const pid = Number(process.env.CLAUDE_PID);
  return Number.isInteger(pid) && pid > 1 ? { owner_pid: pid, owner_host: hostname() } : {};
}

function classify(dataDir, kind, sessionId, unverified, nowMs) {
  const read = readLockFile(dataDir, kind);
  if (!read.exists) return { state: "free", read };
  if (read.corrupt) return { state: "corrupt", read };
  if (isReleased(read.obj)) return { state: "released", read };
  if (ageMs(read.obj, nowMs) > STALE_MS) return { state: "stale", read };
  if (!unverified && read.obj.session_id === sessionId) return { state: "mine", read };
  if (ownerIsDead(read.obj)) return { state: "stale", read, dead_owner: true };
  return { state: "held", read };
}

function blockText(kind, obj) {
  const label = kind === "planning" ? "planning session" : kind === "discuss" ? "discussion" : "execution lock";
  return (
    `⛔ Another ${label} is active.\n` +
    `   Skill:      ${obj.skill ?? "(unknown)"}\n` +
    (obj.sprint ? `   Sprint:     ${obj.sprint}\n` : "") +
    `   Started:    ${obj.started ?? "(unknown)"}\n` +
    `   Session ID: ${obj.session_id ?? "(none recorded)"}\n\n` +
    `Finish or pause that session first. If it is already closed, free the lock: shipyard-data lock release ${kind} --force`
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
  kind = resolveKind(kind, skill);

  let result;
  withLockfile(acquireMetaLockPath(dataDir), () => {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const own = classify(dataDir, kind, sessionId, unverified, nowMs);

    // Held-by-another-fresh-session is checked FIRST — no write happens on
    // this path, and the cross-lock check below still runs so both sides
    // of a "both strangers" situation get reported together.
    const ownBlocked = own.state === "held";

    // Other command families never block (4.17); they are reported so the
    // caller knows what it is running beside.
    const beside = runningBeside(dataDir, kind, sessionId, unverified, nowMs);
    const others = beside.filter((b) => b.state === "held");
    const concurrentAllowed = others.length > 0;

    if (ownBlocked) {
      const blocks = [{ kind, ...own.read.obj }];
      const stderrText = blocks.map((b) => blockText(b.kind, b)).join("\n\n");
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
        ...(own.dead_owner ? { reason: "owner_process_gone", prior_owner_pid: own.read.obj.owner_pid ?? null } : {}),
      };
    } else if (own.state === "corrupt") {
      recovered = "corrupt";
    }
    // own.state === "free" | "released" -> plain fresh acquire, nothing extra.

    const newObj =
      reentry
        ? { ...own.read.obj, skill, sprint: sprint ?? own.read.obj.sprint ?? null, wave: wave ?? own.read.obj.wave ?? null, depth }
        : { skill, sprint, wave, started: nowIso, session_id: sessionId, cleared: null, depth: 1, ...ownerIdentity(),
            // a paused discussion left its sources and ticket questions for this one (see `--pause` at release)
            ...(kind === "discuss" && own.read.obj?.paused_since ? { owed_since: String(own.read.obj.paused_since) } : {}),
            // what was already uncommitted when a planning command began (4.13.5): release compares
            ...(kind === "planning" || kind === "discuss" ? { dirty_at_start: dirtyTracked(dataDir) } : {}) };

    writeLockObj(dataDir, kind, newObj);

    if (recovered === "stale") {
      logEvent(dataDir, "stale_lock_recovered", { kind, ...priorForEvent });
    } else if (recovered === "corrupt") {
      logEvent(dataDir, "corrupt_lock_recovered", { kind, raw_tail: sanitizeForLog(own.read.raw.slice(-120), 120) });
    }
    logEvent(dataDir, "skill_lock_acquired", { kind, skill, reentry, recovered: recovered || false });

    let stderrText = "";
    if (recovered === "stale") {
      stderrText = own.dead_owner
        ? `(recovered the ${priorForEvent.prior_skill ?? "unknown"} lock of a session that is no longer running, pid ${priorForEvent.prior_owner_pid})`
        : `(recovered stale ${priorForEvent.prior_skill ?? "unknown"} lock started ${priorForEvent.prior_age_hours}h ago)`;
    } else if (recovered === "corrupt") {
      stderrText = `(recovered corrupt ${kind} lock — previous content was not valid JSON)`;
    }

    const crossLockSameSession = beside.some((b) => b.state === "mine");

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
        ...(concurrentAllowed ? { cross_lock_allowed: [skill, ...others.map((o) => o.skill)].sort().join("+"), running_beside: others.map((o) => o.skill) } : {}),
      },
    };
    if (concurrentAllowed) {
      logEvent(dataDir, "skill_lock_concurrent_allowed", {
        kind,
        skill,
        other_kind: others.map((o) => o.kind).join(","),
        other_skill: others.map((o) => o.skill).join(","),
      });
    }
  });
  return result;
}

/**
 * `shipyard-data lock release <planning|execution> [--skill <name>]
 *   [--force] [--session <id>]`
 */
/**
 * Take the lock unless this caller already holds it (no second hold is stacked on the first).
 * For a step that must run under the lock but may be reached with or without it: `cursor resume`.
 */
export function ensureLock(dataDir, kind, opts) {
  const k = resolveKind(kind, opts.skill);
  const own = classify(dataDir, k, opts.sessionId, opts.unverified, Date.now());
  if (own.state === "mine") return { ok: true, code: 0, message: "", json: { acquired: false, already: true } };
  return acquireLock(dataDir, kind, opts);
}

export function releaseLock(dataDir, kind, opts = {}) {
  const { skill, sessionId, unverified = true, force = false, bestEffort = false, leaveChanges = "", pause = false } = opts;
  kind = resolveKind(kind, skill);

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
      // A command does not end with its helpers still listed (4.9.1): a
      // deep-dive or critic that finished is stopped, not left ticking in the
      // agent list. Only agents the hook recorded for this lock's session
      // since it was taken count; `--force` and the session-end reap skip this.
      if (depth <= 1) {
        let lingering = [];
        try {
          const since = Date.parse(read.obj.started ?? "");
          lingering = liveAgents(readEvents(dataDir, 20000)).filter((a) => a.via === "hook" && (!read.obj.session_id || !a.session || a.session === read.obj.session_id) && (!Number.isFinite(since) || !a.since || Date.parse(a.since) >= since - 1000));
        } catch { lingering = []; }
        if (lingering.length) {
          result = {
            ok: false, code: 3,
            message: `shipyard-data lock release: ${lingering.length} agent(s) this command started are still listed: ${lingering.map((a) => a.name).join(", ")}.\n  Stop each one (TaskStop <name>; the ledger records it by itself), then release again. An agent that already ended also needs the TaskStop: it only removes the listing.\n`,
            json: { released: false, reason: "agents_live", agents: lingering.map((a) => a.name) },
          };
          return;
        }
      }
      // A discussion that touched tracker-linked work asks about the tracker
      // before it ends (4.0.1). The owner: "when i provide jira links, and
      // research turns out theres more i should have let me know to create the
      // tickets in jira or ask to assist create. and then once discuss is done.
      // ask to sync". The answer (applied, later, none) is recorded; "later" is
      // a fine answer, silence is not.
      // A discussion that is only paused (after 4.0.2, live: an approval card went unanswered for ten minutes,
      // the session could not ask about the tickets either, the release was refused, and the lock stayed held
      // by a session that had ended its turn; a discussion lock also keeps that session from editing the
      // project). `--pause` releases it when something is verifiably unfinished: a question still waiting, or
      // a queue with items left. What it owes (where the research looked, the ticket question) is not
      // forgiven: the next discussion answers for it from this one's start (`owed_since`).
      const owedSince = read.obj.owed_since ?? read.obj.started ?? null;
      let paused = false;
      if (depth <= 1 && kind === "discuss" && pause) {
        let waiting = [], queue = null;
        try { waiting = waitingTopics(dataDir).waiting; } catch { waiting = []; }
        try { const q = readQueue(dataDir); queue = q && queueSummary(q).active ? queueSummary(q) : null; } catch { queue = null; }
        if (!waiting.length && !queue) {
          result = {
            ok: false, code: 3,
            message: "shipyard-data lock release: --pause is for a discussion with something left open (a question still waiting, or a queue with items left), and nothing is.\n  Finish it: release without --pause and answer what the release asks for.\n",
            json: { released: false, reason: "nothing_to_pause" },
          };
          return;
        }
        paused = true;
      }
      if (depth <= 1 && kind === "discuss" && !paused) {
        let src = null;
        try { src = sourcesOwed(dataDir, owedSince, readEvents(dataDir, 5000)); } catch { src = null; }
        if (src) {
          result = {
            ok: false, code: 3,
            message: src.missing === "registry"
              ? `shipyard-data lock release: this project has not said where its knowledge lives, besides the code.\n  The owner is asked once. This prints the question and how to record their answer:\n    shipyard-data sources suggest\n  Then release again. (To stop now and ask next time: --pause, while a question waits.)`
              : src.missing === "sources"
              ? `shipyard-data lock release: this discussion (topic ${src.topic}) has not said where its research looked.\n  For each source this project names (shipyard-data sources list), one line: searched, not needed for this piece of work, or out of reach:\n    shipyard-data discuss-questions sources --looked "<name>: <what was searched and found>" --skipped "<name>: <why not needed>" --unreachable "<name>: <why>"\n  Then release again.`
              : `shipyard-data lock release: a fact was left open and the person has not been asked about documents this session cannot reach (topic ${src.topic}).\n  Show them what the research looked at (shipyard-data discuss-questions status), ask once whether there is a PDF, a contract, a spec sheet or an email it could not see, read what they give, and record their answer:\n    shipyard-data discuss-questions sources --person-said "<their answer>"\n  Then release again.`,
            json: { released: false, reason: src.missing === "registry" ? "project_sources_not_asked" : src.missing === "sources" ? "research_sources_not_recorded" : "person_not_asked_about_documents", topic: src.topic },
          };
          return;
        }
        let owed = null;
        try { owed = syncOwed(dataDir, owedSince, readEvents(dataDir, 5000)); } catch { owed = null; }
        if (owed) {
          const creates = owed.filter((r) => r.action === "create").length;
          result = {
            ok: false, code: 3,
            message: `shipyard-data lock release: this discussion is not finished with the tracker: ${creates ? `${creates} item(s) written here have no ticket` : ""}${creates && owed.length > creates ? " and " : ""}${owed.length > creates ? `${owed.length - creates} linked item(s) changed here since they were last sent` : ""}.\n  Show the person the plan (shipyard-data tracker plan --since ${owedSince ?? ""}) and ask: create and update the tickets now, with your help, or later?\n  Then record the answer: shipyard-data tracker decided --sync applied|later|none, and release again.\n  If the person is away and a question of this discussion is still waiting for them, do not answer for them: release with --pause (the next /ship-discuss asks this).`,
            json: { released: false, reason: "tracker_sync_not_asked", items: owed.map((r) => r.id) },
          };
          return;
        }
      }
      // The same question when a sprint is planned and when it is reviewed (after 4.0.0, the owner: "will
      // shipyard work with user session to update external ticket details along the way until up to
      // completion"): a ticket learns that its story entered a sprint, and that it is done. Never from
      // /ship-execute, which asks nothing.
      if (depth <= 1 && ["ship-sprint", "ship-review"].includes(String(read.obj.skill ?? ""))) {
        let owed = null;
        try { owed = syncOwed(dataDir, read.obj.started ?? null, readEvents(dataDir, 5000)); } catch { owed = null; }
        if (owed) {
          result = {
            ok: false, code: 3,
            message: `shipyard-data lock release: ${owed.length} linked item(s) changed in this ${read.obj.skill === "ship-sprint" ? "planning" : "review"} and their tickets do not know yet (${owed.slice(0, 8).map((r) => r.id).join(", ")}${owed.length > 8 ? ", …" : ""}).\n  Show the plan (shipyard-data tracker plan --since ${read.obj.started ?? ""}) and ask to update the tickets (with tracker_sync: auto, send the updates and report them).\n  Then record it: shipyard-data tracker decided --sync applied|later|none, and release again.`,
            json: { released: false, reason: "tracker_sync_not_asked", items: owed.map((r) => r.id) },
          };
          return;
        }
      }
      // A planning command commits what it wrote to the project (4.13.5). It
      // records decisions in the project's own docs; the rule to commit that
      // file by path was prose, and the next sprint then started on a dirty
      // tree (seen twice). Only files that became dirty while this lock was
      // held count: what the owner had open before is theirs.
      if (depth <= 1 && (kind === "planning" || kind === "discuss") && Array.isArray(read.obj.dirty_at_start)) {
        const now = dirtyTracked(dataDir);
        const fresh = now ? now.filter((p) => !read.obj.dirty_at_start.includes(p)) : [];
        // Another command is running in this repository (4.17): a file that
        // turned dirty may be ITS work in progress, so this command cannot be
        // held responsible for it. Say so and release; never suggest setting
        // another command's files aside.
        const besideNow = fresh.length ? runningBeside(dataDir, kind, sessionId, unverified).filter((b) => b.state === "held") : [];
        // ...except the files the write hook SAW this session write (a
        // discussion's decision record): those are known to be its own.
        const mine = fresh.length && besideNow.length ? wroteThisSession(dataDir, sessionId, read.obj.started ?? read.obj.started_at, fresh) : [];
        // No `--leave-changes` here (4.0): the file is this discussion's own,
        // the owner listed it as the place decisions are written, and a build
        // is running on the same checkout. A live discussion left it with "a
        // commit is made only on request", and the sprint beside it could not
        // record its final test proof on a changed tree.
        if (mine.length) {
          result = {
            ok: false, code: 3,
            message: `shipyard-data lock release: this discussion wrote ${mine.join(", ")} and it is not committed${leaveChanges ? " (--leave-changes is not accepted for a file this discussion wrote while another command runs here: the owner set this file up as the decision record, and committing it by path is part of the discussion)" : ""}. ${besideNow.map((b) => b.skill).join(" and ")} is running in the same folder, and an uncommitted file there gets in the way of its next merge.\n  Commit exactly that path now: git add -- ${mine.join(" ")} && git commit -m "docs: <what was decided>"\n  (or release with --leave-changes "<why>")`,
            json: { released: false, reason: "uncommitted_own_changes", files: mine },
          };
          return;
        }
        if (fresh.length && besideNow.length && !leaveChanges) {
          logEvent(dataDir, "lock_released_with_changes", { kind, skill: read.obj.skill, files: fresh.join(","), reason: `beside ${besideNow.map((b) => b.skill).join("+")}` });
          writeLockObj(dataDir, kind, { skill: null, cleared: nowIso });
          logEvent(dataDir, "skill_lock_released", { kind, skill: read.obj.skill, forced: false });
          result = { ok: true, code: 0, message: `(released; ${fresh.length} uncommitted project file(s): ${fresh.join(", ")} — ${besideNow.map((b) => b.skill).join(" and ")} is running here too, so they may be its work. If YOU wrote one of them, commit that path now.)`, json: { released: true, depth: 0, uncommitted: fresh, beside: besideNow.map((b) => b.skill) } };
          return;
        }
        if (fresh.length && !leaveChanges) {
          result = {
            ok: false, code: 3,
            message: `shipyard-data lock release: ${fresh.length} project file(s) changed during this command and are not committed: ${fresh.join(", ")}.\n  If you wrote them (a decision record, a doc): commit exactly those paths — git add -- <paths> && git commit -m "docs: <what was decided>".\n  If you did not: shipyard-data stray set-aside --reason "<who or what>".\n  To end with them uncommitted on purpose: lock release ${kind} --skill ${read.obj.skill} --leave-changes "<why>".`,
            json: { released: false, reason: "uncommitted_changes", files: fresh },
          };
          return;
        }
        if (fresh.length) logEvent(dataDir, "lock_released_with_changes", { kind, skill: read.obj.skill, files: fresh.join(","), reason: String(leaveChanges).slice(0, 200) });
      }
      if (depth > 1) {
        writeLockObj(dataDir, kind, { ...read.obj, depth: depth - 1 });
        result = { ok: true, code: 0, message: "", json: { released: false, depth: depth - 1 } };
        return;
      }

      writeLockObj(dataDir, kind, { skill: null, cleared: nowIso, ...(paused && owedSince ? { paused_since: owedSince } : {}) });
      logEvent(dataDir, "skill_lock_released", { kind, skill: read.obj.skill, forced: false, ...(paused ? { paused: true } : {}) });
      result = { ok: true, code: 0, message: paused ? "(paused: the next /ship-discuss picks up the waiting question and what this discussion still owes)" : "", json: { released: true, depth: 0, ...(paused ? { paused: true } : {}) } };
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
 * Release every lock that the ending session still holds — the "on exit,
 * release" cleanup the model-driven skills cannot guarantee for themselves.
 *
 * A skill acquires its lock at start and is supposed to release it at its
 * finalize step, but a skill that aborts on an error or a gate halt never
 * reaches that step. The `SessionEnd` hook calls this with the ending
 * session's id so the lock does not linger until the 2-hour stale threshold
 * (or a manual `/ship-status`). Matching is by recorded `session_id`: only a
 * lock this exact session owns is released — a concurrent session's lock
 * (e.g. the allowed ship-discuss + ship-execute pair) is never touched.
 * Age is irrelevant here — we release our own lock even past the stale
 * threshold. A lock with no recorded session (`session_id` null, i.e. it was
 * acquired unverified) is left alone; it cannot be attributed to this session
 * and the stale path still reclaims it. Best-effort and never throws — a
 * SessionEnd hook must not fail the shutdown.
 */
export function reapSessionLocks(dataDir, sessionId) {
  const released = [];
  if (!sessionId) return { released };
  // All three kinds. `discuss` was added in 4.17 and left out here until 4.0.1:
  // an owner who typed /clear in the middle of a discussion was then told
  // "another discussion is active" by their own ended session, twice, and had
  // to force the release by hand.
  for (const kind of ["planning", "execution", "discuss"]) {
    try {
      const read = readLockFile(dataDir, kind);
      if (!read.exists || read.corrupt || isReleased(read.obj)) continue;
      if (read.obj.session_id && read.obj.session_id === sessionId) {
        // bestEffort suppresses releaseLock's own skill_lock_released event so
        // the single skill_lock_reaped line below is the one record of this.
        releaseLock(dataDir, kind, { sessionId, unverified: false, force: true, bestEffort: true });
        logEvent(dataDir, "skill_lock_reaped", {
          kind,
          skill: read.obj.skill ?? null,
          session_id: sessionId,
          reason: "session_end",
        });
        released.push({ kind, skill: read.obj.skill ?? null });
      }
    } catch {
      // best-effort per lock — one failure must not skip the other kind
    }
  }
  return { released };
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
  for (const kind of ["planning", "execution", "discuss"]) {
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
      process.stderr.write("usage: lock acquire <planning|execution|discuss> --skill <ship-*> [--sprint <id>] [--wave <n>]\n");
      process.exit(2);
    }
    return emit(acquireLock(dataDir, kind, { skill, sprint, wave, sessionId, unverified }));
  }
  if (sub === "release") {
    if (!kind || !LOCK_FILES[kind]) {
      process.stderr.write("usage: lock release <planning|execution|discuss> [--skill <name>] [--force] [--leave-changes \"<why>\"] [--pause]\n");
      process.exit(2);
    }
    const lc = args.indexOf("--leave-changes");
    const leaveChanges = lc !== -1 && args[lc + 1] && !String(args[lc + 1]).startsWith("--") ? String(args[lc + 1]) : "";
    if (lc !== -1 && !leaveChanges) { process.stderr.write("lock release: --leave-changes needs a reason\n"); process.exit(2); }
    return emit(releaseLock(dataDir, kind, { skill, sessionId, unverified, force, leaveChanges, pause: args.includes("--pause") }));
  }
  if (sub === "check") {
    if (!kind || !LOCK_FILES[kind]) {
      process.stderr.write("usage: lock check <planning|execution|discuss>\n");
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
