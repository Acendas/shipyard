/**
 * cursor-cli — deterministic pipeline-cursor state machine for
 * `shipyard-data cursor <advance|pause|escalate|noop>`.
 *
 * v2.9.0 moved cursor authorship out of the model. Before this, skills
 * Wrote EXECUTE-CURSOR.md / REVIEW-CURSOR.md freeform and the
 * auto-approve PreToolUse hook retroactively policed the writes
 * (terminal-evidence gate + loop-leak guard). That worked, but it meant
 * the cursor and the event log encoded the same progress twice, with a
 * hook proving they matched. This CLI writes both in lockstep:
 *
 *   validate transition (pipeline-stages.mjs graph)
 *     → run loop-leak guard + terminal-evidence gate IN-PROCESS
 *     → append the pipeline event
 *     → atomically rewrite the cursor
 *     → re-render PROGRESS.md
 *     → print the tick/terminal marker (stop marker LAST — v2.8.2 rule)
 *
 * A failed gate is exit 3 with the same structured reasons the hook used
 * to put in the deny message. The auto-approve hook now simply denies all
 * model writes to cursor paths, pointing here.
 *
 * Subcommands:
 *   advance <execute|review> <stage> [k=v ...] [--note "..."] [--force]
 *       Advance the cursor to <stage>. k=v pairs set frontmatter fields
 *       (sprint, wave_number, iteration, next_action, status, mode,
 *       working_branch, loop_owner, stuck_counter, pending_subagents=<json>).
 *       An unset `sprint` backfills from SPRINT.md's own `id:` when
 *       resolvable, never fabricated otherwise. A `wave_N_dispatch` target
 *       stage REPLACES pending_subagents with exactly what this call
 *       passes (empty if none) rather than inheriting a prior wave's
 *       leftovers; wave_N_waiting self-loops keep the merge/carry
 *       semantics. --force skips transition-graph validation ONLY — the
 *       evidence gates always run. Terminal stages emit pipeline_terminal
 *       and print the stop marker as the final line; a non-terminal
 *       advance prints the ordinary tick marker when a /loop looks live,
 *       or an explicit "no loop is driving this sprint" marker when it
 *       does not (same liveness signal as bootstrap-check).
 *   pause <execute|review> --note "..." [k=v ...]
 *       Keep the current stage, set status: paused, record the note in the
 *       cursor body. Replaces HANDOFF.md (v2.9.0): one resume source.
 *   escalate <execute|review> reason=<short> [k=v ...] [--note "..."]
 *       Terminal escalation from any stage: terminal: true,
 *       status: escalated, pipeline_terminal outcome=escalated. Bypasses
 *       the evidence gate by design (matches the hook-era classify()).
 *   noop <execute|review> [sprint=<id>] [reason=<r>]
 *       The idempotent already-complete sweep: emits pipeline_terminal
 *       outcome=noop FIRST, then repeat-leak detection
 *       (pipeline_loop_leak_detected + hard ⛔ marker on the 2nd noop for
 *       the same sprint). Never writes a cursor.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logEvent } from "./_hook_lib.mjs";
import { releaseLock } from "./skill-lock.mjs";
import {
  canonicalPipeline,
  isTerminalStage,
  normalizeStage,
  validateTransition,
} from "./pipeline-stages.mjs";
import {
  evaluateLoopLeakGuard,
  evaluateTerminalGate,
  parseFrontmatter,
  readEvents,
} from "./terminal-gate.mjs";
import { writeProgress } from "./progress-render.mjs";

const CURSOR_FILE = {
  "ship-execute": "EXECUTE-CURSOR.md",
  "ship-review": "REVIEW-CURSOR.md",
};

const STOP_MARKER = "▶ CYCLE COMPLETE — pipeline terminal. /loop should stop.";

// Tick-recency window shared by the loop_owner heuristic (resolveLoopOwner,
// used by both `cursor bootstrap-check`'s eligibility computation and the
// mid-sprint-exit marker on `cursor advance`) and bootstrap-check's
// dead-loop re-arm detection. 5 minutes: a live /loop ticks well inside
// this; a stale tick means the loop died (Ctrl-C, /clear, session end).
const LOOP_TICK_WINDOW_MS = 5 * 60 * 1000;
const NO_LOOP_DRIVING_MARKER =
  "▶ TICK COMPLETE — no loop is driving this sprint. Re-run /shipyard:ship-execute to continue.";

/** Frontmatter keys the CLI accepts via k=v and their render order. */
const FIELD_ORDER = [
  "pipeline",
  "sprint",
  "stage",
  "wave_number",
  "iteration",
  "last_advance_at",
  "loop_owner",
  "status",
  "next_action",
  "terminal",
  "stuck_counter",
  "hard_ceiling",
  "mode",
  "working_branch",
  "auto_loop_attempted",
];
const SETTABLE_FIELDS = new Set([
  "sprint",
  "wave_number",
  "iteration",
  "loop_owner",
  "status",
  "next_action",
  "mode",
  "working_branch",
  "stuck_counter",
  "hard_ceiling",
  "auto_loop_attempted",
  "pending_subagents",
]);

// `cursor set` may not touch lifecycle fields — status transitions belong
// to resume/pause/escalate (which emit their events); a `cursor set
// status=in_progress` would be a silent un-pause backdoor.
const SET_ONLY_EXCLUDED = new Set(["status"]);

/**
 * If a loop-silence fallback cron was armed this cycle, remind the model
 * to clean it up — read from the EVENT LOG, not conversation memory (a
 * compacted session forgets it armed a cron; the log doesn't). Printed
 * BEFORE the stop marker so the marker stays the final line.
 *
 * Scoped to `method=cron` specifically: `cursor bootstrap-check`'s F3
 * dead-loop re-arm emits this SAME event type with `method=cli` (it
 * re-arms directly via the next `Skill(loop)` invocation, no cron
 * involved) — without this scope, a CLI re-arm would make every
 * subsequent pause/escalate/noop/terminal-advance within the 500-event
 * tail falsely tell the model to CronList/CronDelete a cron that was
 * never created.
 */
function cronCleanupReminder(dataDir, pipeline) {
  try {
    const events = readEvents(dataDir, 500);
    const armed = events.some(
      (ev) => ev.type === "pipeline_loop_bootstrap_fallback" && ev.pipeline === pipeline && ev.method === "cron",
    );
    if (armed) {
      process.stdout.write(
        `(a pipeline_loop_bootstrap_fallback cron was armed this cycle — CronList and CronDelete any cron targeting /shipyard:${pipeline === "ship-execute" ? "ship-execute" : "ship-review"} now)\n`,
      );
    }
  } catch { /* best-effort */ }
}

function usageFail(msg) {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
  process.exit(2);
}

function gateFail(header, reasons) {
  process.stderr.write(`✗ ${header}\n`);
  for (const r of reasons) process.stderr.write(`  - ${r}\n`);
  process.exit(3);
}

/**
 * Parse an existing cursor file: flat frontmatter via the shared
 * terminal-gate parser, plus the one nested field (`pending_subagents:`)
 * extracted structurally, plus the narrative body.
 */
export function readCursor(dataDir, pipeline) {
  const path = join(dataDir, "sprints", "current", CURSOR_FILE[pipeline]);
  if (!existsSync(path)) return null;
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(content);
  delete fm.pending_subagents; // flat parser mangles the nested list

  const pending = [];
  const fmBlock = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmBlock) {
    const lines = fmBlock[1].split(/\r?\n/);
    let inPending = false;
    let current = null;
    for (const line of lines) {
      if (/^pending_subagents:\s*$/.test(line)) {
        inPending = true;
        continue;
      }
      if (inPending) {
        const item = line.match(/^\s+-\s+(\w+):\s*(.+)$/);
        const cont = line.match(/^\s+(\w+):\s*(.+)$/);
        if (item) {
          current = { [item[1]]: coerce(item[2].trim()) };
          pending.push(current);
        } else if (cont && current && !/^\S/.test(line)) {
          current[cont[1]] = coerce(cont[2].trim());
        } else if (/^\S/.test(line)) {
          inPending = false;
          current = null;
        }
      }
    }
  }

  const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return {
    path,
    fm,
    pending,
    body: bodyMatch ? bodyMatch[1].trim() : "",
  };
}

function coerce(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function yamlValue(v) {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  // Quote when the value could parse ambiguously.
  if (s === "" || /[:#'"\n]|^\s|\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

export function renderCursor(fields, pending, body) {
  const lines = ["---"];
  for (const key of FIELD_ORDER) {
    if (fields[key] === undefined || fields[key] === null || fields[key] === "") continue;
    lines.push(`${key}: ${yamlValue(fields[key])}`);
  }
  if (pending && pending.length > 0) {
    lines.push("pending_subagents:");
    for (const entry of pending) {
      const keys = Object.keys(entry);
      keys.forEach((k, i) => {
        lines.push(`${i === 0 ? "  - " : "    "}${k}: ${yamlValue(entry[k])}`);
      });
    }
  }
  lines.push("---", "");
  if (body) lines.push(body.trim(), "");
  return lines.join("\n");
}

function writeCursorFile(dataDir, pipeline, content) {
  const dir = join(dataDir, "sprints", "current");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, CURSOR_FILE[pipeline]);
  const tmp = path + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
  return path;
}

/** Parse trailing `k=v` args + flags. Returns { fields, note, force }. */
function parseArgs(rest) {
  const fields = {};
  let note = null;
  let force = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--force") {
      force = true;
      continue;
    }
    if (a === "--note") {
      note = rest[++i] ?? "";
      continue;
    }
    const eq = a.indexOf("=");
    if (eq <= 0) usageFail(`cursor: unrecognized argument "${a}" — expected k=v, --note <text>, or --force`);
    const k = a.slice(0, eq);
    const v = a.slice(eq + 1);
    fields[k] = v;
  }
  return { fields, note, force };
}

function splitEventFields(fields) {
  // outcome/reason ride the event, not the cursor.
  const { outcome, reason, ...rest } = fields;
  for (const k of Object.keys(rest)) {
    if (!SETTABLE_FIELDS.has(k)) {
      usageFail(
        `cursor: unknown field "${k}". Settable: ${[...SETTABLE_FIELDS].join(", ")} (plus outcome=/reason= for the event)`,
      );
    }
  }
  return { outcome, reason, cursorFields: rest };
}

/**
 * Best-effort clear of the execute-skill advisory lock when the execute
 * pipeline reaches a resting state (terminal / paused / noop). The lock
 * and the cursor used to flip on the same transition but with split
 * ownership (CLI wrote the cursor, the model hand-Wrote the lock JSON) —
 * a forgettable model step. Review has no per-pipeline lock file.
 */
function clearExecutionLock(dataDir, pipeline) {
  if (pipeline !== "ship-execute") return;
  // v3.7.0: skill-lock.mjs is the single writer of both lock files now.
  // {force:true} unconditionally soft-deletes regardless of holder;
  // {bestEffort:true} swallows any error internally (returns null) so a
  // lock-file hiccup never fails the cursor's state transition over it —
  // same never-fail contract the old inline try/catch had.
  releaseLock(dataDir, "execution", { force: true, bestEffort: true });
}

function buildProposed({ pipeline, stage, prior, cursorFields, note, terminal, nowIso, dataDir }) {
  const priorFm = prior?.fm ?? {};

  // F4: backfill from SPRINT.md when neither this call nor the prior
  // cursor carries a sprint id — see resolveSprintIdFromFile above.
  let sprint = cursorFields.sprint ?? priorFm.sprint ?? "";
  if (!sprint && dataDir) {
    const resolved = resolveSprintIdFromFile(dataDir);
    if (resolved) sprint = resolved;
  }

  const merged = {
    pipeline,
    sprint,
    stage,
    wave_number: cursorFields.wave_number ?? deriveWave(pipeline, stage) ?? undefined,
    iteration: cursorFields.iteration ?? deriveIter(pipeline, stage) ?? 1,
    last_advance_at: nowIso,
    loop_owner: cursorFields.loop_owner ?? priorFm.loop_owner ?? "",
    status: cursorFields.status ?? (terminal ? terminalDefaultStatus(stage) : "in_progress"),
    next_action: cursorFields.next_action ?? "",
    terminal: terminal,
    // stuck_counter is CLI-owned (v3.1.0): a self-loop advance without an
    // explicit stuck_counter= auto-INCREMENTS (forgetting now counts as
    // stuck — the safe direction; pass stuck_counter=0 when the self-loop
    // made real progress). Stage change resets to 0. Exception:
    // wave_N_waiting is a poll stage — "no progress yet" is its normal
    // state and its stuck protection is the per-task timeout machinery,
    // so it carries the counter without incrementing.
    stuck_counter:
      cursorFields.stuck_counter ??
      (prior && priorFm.stage === stage
        ? normalizeStage(pipeline, stage)?.key === "wave_waiting"
          ? (parseInt(priorFm.stuck_counter, 10) || 0)
          : (parseInt(priorFm.stuck_counter, 10) || 0) + 1
        : 0),
    hard_ceiling: cursorFields.hard_ceiling ?? priorFm.hard_ceiling ?? 50,
    mode: cursorFields.mode ?? priorFm.mode ?? "",
    working_branch: cursorFields.working_branch ?? priorFm.working_branch ?? "",
    auto_loop_attempted: cursorFields.auto_loop_attempted ?? priorFm.auto_loop_attempted ?? undefined,
  };

  // F5: an advance whose TARGET stage is a wave_N_dispatch REPLACES
  // pending_subagents with exactly what this call passes (empty if none),
  // rather than inheriting whatever a prior wave's waiting/recovery cycle
  // left behind. Without this, entries from a wave that already finished
  // (and was never re-passed on the dispatch→dispatch hop across wave
  // boundaries) sit in the cursor with a stale spawned_at forever, and the
  // NEXT wave's wave_N_waiting reconciliation marks tasks that no longer
  // exist as needs-attention. Self-loops on wave_N_waiting are NOT dispatch
  // stages — they keep today's merge/carry semantics (a poll tick that
  // doesn't repeat the list must not appear to drop it).
  const isDispatchStage = normalizeStage(pipeline, stage)?.key === "wave_dispatch";
  let pending = isDispatchStage ? [] : (prior?.pending ?? []);
  if (cursorFields.pending_subagents !== undefined) {
    const raw = cursorFields.pending_subagents;
    if (raw === "" || raw === "[]") {
      pending = [];
    } else {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error("not an array");
        pending = parsed;
      } catch (err) {
        usageFail(`cursor: pending_subagents must be a JSON array (${err.message})`);
      }
    }
  }

  const body = note !== null && note !== undefined ? note : (prior?.body ?? "");
  return { merged, pending, body };
}

function deriveWave(pipeline, stage) {
  return normalizeStage(pipeline, stage)?.wave ?? null;
}
function deriveIter(pipeline, stage) {
  return normalizeStage(pipeline, stage)?.iter ?? null;
}

function terminalDefaultStatus(stage) {
  if (stage === "terminal_issues" || stage === "terminal_changes") return "escalated";
  return "complete";
}

function terminalDefaultOutcome(stage) {
  switch (stage) {
    case "terminal_handoff_to_review":
      return "success";
    case "terminal_hotfix":
    case "terminal_single_task":
    case "terminal":
      return "success";
    case "terminal_issues":
      return "issues";
    case "terminal_changes":
      return "changes";
    default:
      return "success";
  }
}

function sprintIdOf(fields, prior) {
  return fields.sprint || prior?.fm?.sprint || "unknown";
}

/**
 * F4: resolve a sprint id from SPRINT.md's own `id:` frontmatter when a
 * cursor advance carries no `sprint` field at all (neither passed on this
 * call nor already on the prior cursor). Without this a cursor can go a
 * whole sprint with `sprint:` absent, and every event it emits tags
 * `sprint:"unknown"` — which breaks the noop repeat-leak detector's and the
 * wave-waiting reconciliation filter's sprint-scoping (they key off the
 * cursor's sprint id). Never fabricate: an absent or unreadable SPRINT.md
 * leaves the field exactly as it was, same as today.
 */
function resolveSprintIdFromFile(dataDir) {
  try {
    const sprintPath = join(dataDir, "sprints", "current", "SPRINT.md");
    if (!existsSync(sprintPath)) return null;
    const fm = parseFrontmatter(readFileSync(sprintPath, "utf8"));
    const id = (fm.id || "").trim();
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Shared loop_owner heuristic — the SAME liveness signal for both
 * `cursor bootstrap-check` (auto-loop eligibility) and the mid-sprint-exit
 * marker on `cursor advance` (F6), centralized so the two can never drift
 * on what "a loop is live" means. An explicit `loop_owner` field on the
 * cursor wins; otherwise a recent (LOOP_TICK_WINDOW_MS) `pipeline_tick_
 * completed` for this pipeline whose `next_stage` matches `fm.stage` means
 * a /loop driver landed the cursor there and is actively ticking.
 */
function resolveLoopOwner(dataDir, pipeline, fm) {
  const explicit = (fm?.loop_owner || "").trim();
  if (explicit === "/loop" || explicit === "user") return explicit;
  const cutoff = Date.now() - LOOP_TICK_WINDOW_MS;
  const events = readEvents(dataDir, 200);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== "pipeline_tick_completed" || ev.pipeline !== pipeline) continue;
    const ts = Date.parse(ev.ts || "");
    if (Number.isFinite(ts) && ts >= cutoff && ev.next_stage === fm?.stage) {
      return "/loop";
    }
    break; // only the most recent tick matters
  }
  return "user";
}

/**
 * F3: the timestamp of the most recent `pipeline_tick_completed` for this
 * pipeline, regardless of which stage it landed on — used to tell "no loop
 * has ticked in a while" (dead) apart from "a loop is ticking, just not
 * matching this exact stage yet" (resolveLoopOwner's narrower question).
 * Returns null when there has never been one (or its timestamp doesn't
 * parse), which the caller treats as dead.
 */
function mostRecentTickCompletedAt(dataDir, pipeline) {
  const events = readEvents(dataDir, 500);
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== "pipeline_tick_completed" || ev.pipeline !== pipeline) continue;
    const ts = Date.parse(ev.ts || "");
    return Number.isFinite(ts) ? ts : null;
  }
  return null;
}

/** ---- advance ------------------------------------------------------- */

export function cursorAdvance(dataDir, pipelineArg, stage, rest, { now = new Date() } = {}) {
  const pipeline = canonicalPipeline(pipelineArg);
  if (!pipeline) usageFail(`cursor advance: unknown pipeline "${pipelineArg}" — expected execute|review`);
  if (!stage) usageFail("cursor advance: missing <stage>");

  const { fields, note, force } = parseArgs(rest);
  const { outcome, reason, cursorFields } = splitEventFields(fields);
  const prior = readCursor(dataDir, pipeline);
  const from = prior?.fm?.stage ?? null;

  // Archive→terminal seam (v3.4.0). ship-review's release path runs
  // archive-sprint BEFORE its terminal advance, which rotates current/
  // away — the cursor is gone by design, and there is nothing left to
  // write a cursor INTO (writing one would plant a stale terminal cursor
  // that noops the NEXT sprint and false-trips the leak alarm). For a
  // terminal advance with no cursor: run the evidence gate against the
  // (persistent) event log, emit pipeline_terminal, print the markers —
  // and write nothing.
  if (!prior && isTerminalStage(pipeline, stage)) {
    const proposed = renderCursor(
      { pipeline, sprint: cursorFields.sprint ?? "", stage, terminal: true, status: cursorFields.status ?? terminalDefaultStatus(stage) },
      [],
      note ?? "",
    );
    const gate = evaluateTerminalGate({ dataDir, proposedContent: proposed });
    if (!gate.allowed) {
      gateFail("cursor advance refused — terminal-evidence gate (post-archive terminal)", gate.reasons);
    }
    logEvent(dataDir, "pipeline_terminal", {
      pipeline,
      sprint: cursorFields.sprint || "unknown",
      outcome: outcome || terminalDefaultOutcome(stage),
      reason: reason || stage,
    });
    clearExecutionLock(dataDir, pipeline);
    process.stdout.write(`cursor: (archived) → ${stage} — terminal recorded in the event log; no cursor written (current/ already rotated).\n`);
    cronCleanupReminder(dataDir, pipeline);
    process.stdout.write(STOP_MARKER + "\n");
    return;
  }

  if (prior && String(prior.fm.terminal).toLowerCase() === "true" && !force) {
    gateFail(
      `cursor advance refused — the ${pipeline} cursor is already terminal`,
      [
        `stage: ${prior.fm.stage}, status: ${prior.fm.status}`,
        "A terminal cursor means the pipeline finished. Use `shipyard-data cursor noop` for the idempotent already-complete sweep, or archive the sprint.",
      ],
    );
  }

  if (!force) {
    const verdict = validateTransition(pipeline, from, stage);
    if (!verdict.ok) {
      gateFail(`cursor advance refused — illegal stage transition`, [
        verdict.reason,
        "If this is deliberate recovery (crash mid-pipeline, hand-repair), re-run with --force. The evidence gates still apply.",
      ]);
    }
  }

  const terminal = isTerminalStage(pipeline, stage);

  // F6: capture the liveness signal BEFORE this call logs its own
  // pipeline_tick_completed event below — resolveLoopOwner's "most recent
  // tick" scan would otherwise always find the event THIS call is about to
  // write (next_stage=<stage>, which never matches prior.fm.stage) and
  // conclude "no loop" every single time, live loop or not.
  const loopLiveAtEntry = !terminal && resolveLoopOwner(dataDir, pipeline, prior?.fm ?? {}) === "/loop";

  const nowIso = now.toISOString();
  const { merged, pending, body } = buildProposed({
    pipeline,
    stage,
    prior,
    cursorFields,
    note,
    terminal,
    nowIso,
    dataDir,
  });

  const proposedContent = renderCursor(merged, pending, body);

  // The same two structural gates the PreToolUse hook enforced, now
  // in-process and unavoidable (the hook denies model cursor writes, so
  // this CLI is the only writer). --force does NOT bypass these.
  const leak = evaluateLoopLeakGuard({
    dataDir,
    proposedContent,
    cursorBasename: CURSOR_FILE[pipeline],
  });
  if (!leak.allowed) {
    gateFail("cursor advance refused — loop-leak guard", [
      ...leak.reasons,
      "Run `shipyard-data cursor noop " + (pipeline === "ship-execute" ? "execute" : "review") + "` instead, and cancel the /loop.",
    ]);
  }

  const gate = evaluateTerminalGate({ dataDir, proposedContent });
  if (!gate.allowed) {
    gateFail(
      "cursor advance refused — terminal-evidence gate (the claim of success is missing event-log evidence)",
      [
        ...gate.reasons,
        "Fix the gap (re-run the relevant skill stage so the events are emitted) and retry, or escalate via `shipyard-data cursor escalate`.",
      ],
    );
  }

  // Stuck detection is CLI-owned: warn at 5, refuse at the hard ceiling.
  const stuck = parseInt(merged.stuck_counter, 10) || 0;
  const ceiling = parseInt(merged.hard_ceiling, 10) || 50;
  if (!terminal && from === stage && stuck >= ceiling) {
    logEvent(dataDir, "pipeline_stuck", {
      pipeline,
      sprint: sprintIdOf(merged, prior),
      stage,
      iterations: stuck,
      reason: "hard-ceiling",
    });
    gateFail(`cursor advance refused — hard ceiling (${ceiling}) reached on self-looping stage ${stage}`, [
      `${stuck} self-loop ticks without progress. This is a runaway loop with broken state-change detection.`,
      `Escalate instead: shipyard-data cursor escalate ${pipeline === "ship-execute" ? "execute" : "review"} reason=hard_ceiling_stage_${stage}`,
    ]);
  }

  const sprint = sprintIdOf(merged, prior);
  if (terminal) {
    logEvent(dataDir, "pipeline_terminal", {
      pipeline,
      sprint,
      outcome: outcome || terminalDefaultOutcome(stage),
      reason: reason || stage,
    });
  } else {
    if (from === stage && stuck >= 5) {
      logEvent(dataDir, "pipeline_stuck", {
        pipeline,
        sprint,
        stage,
        iterations: stuck,
        reason: "re-entry-without-progress",
      });
    }
    logEvent(dataDir, "pipeline_tick_completed", {
      pipeline,
      sprint,
      stage: from ?? "(fresh)",
      outcome: from === stage ? "self_loop" : "advanced",
      next_stage: stage,
      ...(merged.wave_number != null ? { wave: merged.wave_number } : {}),
    });
    // The CLI also emits the next tick's started event — the last
    // pipeline-lifecycle event that used to be a model-side ritual
    // (forgettable, never verified). Zero consumers gate on it; it exists
    // for audit-log readability.
    logEvent(dataDir, "pipeline_tick_started", {
      pipeline,
      sprint,
      stage,
      ...(merged.iteration != null ? { iteration: merged.iteration } : {}),
      ...(merged.loop_owner ? { loop_owner: merged.loop_owner } : {}),
    });
  }

  const path = writeCursorFile(dataDir, pipeline, proposedContent);

  // HANDOFF.md is retired (v2.9.0) — pause state lives in the cursor. If a
  // pre-2.9 HANDOFF.md is still lying around, consume it so resume logic
  // never sees two sources.
  try {
    rmSync(join(dataDir, "sprints", "current", "HANDOFF.md"), { force: true });
  } catch { /* best-effort */ }

  try {
    writeProgress(dataDir);
  } catch { /* rendering is best-effort; next advance retries */ }
  if (terminal) clearExecutionLock(dataDir, pipeline);

  process.stdout.write(`cursor: ${from ?? "(fresh)"} → ${stage} (${path})\n`);
  if (terminal) {
    if (stage === "terminal_handoff_to_review") {
      // NEXT-UP first, stop marker LAST — the v2.8.2 handoff-seam rule,
      // now enforced by construction.
      process.stdout.write(
        "▶ NEXT UP: /ship-review — a SEPARATE cycle you start yourself (tip: /clear first for a fresh window).\n",
      );
    }
    cronCleanupReminder(dataDir, pipeline);
    process.stdout.write(STOP_MARKER + "\n");
  } else {
    // F6: a chained direct invocation and a /loop-driven tick print the
    // identical "▶ TICK COMPLETE" marker today, so the user cannot tell
    // "this will keep going on its own" from "this just stopped and
    // nothing will resume it." Use the SAME liveness signal bootstrap-check
    // uses (resolveLoopOwner, computed above against the PRE-advance
    // cursor): if nothing looks like it's actively driving this sprint,
    // say so explicitly instead of printing the ordinary continuation
    // marker.
    if (!loopLiveAtEntry) {
      process.stdout.write(NO_LOOP_DRIVING_MARKER + "\n");
    } else {
      const waveBit = merged.wave_number != null ? ` wave ${merged.wave_number},` : "";
      // Pacing hint for the /loop driver (v3.4.0): waiting stages are pure
      // polls of background builders — waking every 60s burns a full
      // context load per no-op poll on a wave that can run 30-60 minutes.
      // The driver reads the last line; give it a delay suggestion there.
      const pacing =
        normalizeStage(pipeline, stage)?.key === "wave_waiting"
          ? " Background builders are running — suggest next wakeup in 300s."
          : "";
      process.stdout.write(`▶ TICK COMPLETE —${waveBit} stage ${stage}. /loop continues.${pacing}\n`);
    }
  }
}

/** ---- set (field-only, no transition) -------------------------------- */

/**
 * Update cursor frontmatter fields WITHOUT a stage transition: no graph
 * traversal, no gates, no tick events. Exists because a "same-stage
 * advance just to set a field" (the pre-v3.1 auto-loop sentinel recipe)
 * was an illegal transition on every non-self-looping stage AND polluted
 * the event log with a phantom tick. Field sets cannot start work — the
 * stage and terminal flag are not settable here.
 */
export function cursorSet(dataDir, pipelineArg, rest) {
  const pipeline = canonicalPipeline(pipelineArg);
  if (!pipeline) usageFail(`cursor set: unknown pipeline "${pipelineArg}" — expected execute|review`);
  const { fields, note } = parseArgs(rest);
  if (Object.keys(fields).length === 0 && note === null) {
    usageFail("cursor set: nothing to set — pass k=v fields and/or --note");
  }
  const prior = readCursor(dataDir, pipeline);
  if (!prior) {
    gateFail("cursor set refused — no cursor exists", [
      `Expected sprints/current/${CURSOR_FILE[pipeline]}. Field sets update an existing cursor; use \`cursor advance\` to create one at an entry stage.`,
    ]);
  }
  const { cursorFields } = splitEventFields(fields);
  for (const k of Object.keys(cursorFields)) {
    if (SET_ONLY_EXCLUDED.has(k)) {
      usageFail(
        `cursor set: "${k}" is a lifecycle field — use cursor resume/pause/escalate (they emit the matching events); a raw set would be a silent state change`,
      );
    }
  }
  let pending = prior.pending;
  if (cursorFields.pending_subagents !== undefined) {
    const raw = cursorFields.pending_subagents;
    if (raw === "" || raw === "[]") pending = [];
    else {
      try {
        pending = JSON.parse(raw);
        if (!Array.isArray(pending)) throw new Error("not an array");
      } catch (err) {
        usageFail(`cursor set: pending_subagents must be a JSON array (${err.message})`);
      }
    }
    delete cursorFields.pending_subagents;
  }
  const merged = { ...prior.fm, ...cursorFields, pipeline };
  const content = renderCursor(merged, pending, note ?? prior.body);
  writeCursorFile(dataDir, pipeline, content);
  process.stdout.write(
    `cursor: fields updated at stage ${merged.stage} (${Object.keys(cursorFields).join(", ") || "note"})\n`,
  );
}

/** ---- resume (escalated/paused → in_progress) ------------------------ */

/**
 * Documented recovery from an escalated (or paused) cursor: flip
 * terminal/status back to in_progress at the SAME stage so normal
 * advances work again. Without this, an escalated sprint was bricked —
 * the entry recipe noop'd on any `terminal: true` cursor and `advance`
 * refused it, with `--force` as the only (undocumented) escape.
 */
export function cursorResume(dataDir, pipelineArg, rest, { now = new Date() } = {}) {
  const pipeline = canonicalPipeline(pipelineArg);
  if (!pipeline) usageFail(`cursor resume: unknown pipeline "${pipelineArg}" — expected execute|review`);
  const { fields, note } = parseArgs(rest);
  const prior = readCursor(dataDir, pipeline);
  if (!prior) {
    gateFail("cursor resume refused — no cursor exists", [
      `Expected sprints/current/${CURSOR_FILE[pipeline]}.`,
    ]);
  }
  const status = (prior.fm.status || "").toLowerCase();
  if (status !== "escalated" && status !== "paused") {
    gateFail(`cursor resume refused — cursor status is "${prior.fm.status}"`, [
      "Resume applies to escalated or paused cursors only. A status: complete terminal means the pipeline finished — start the next cycle instead.",
    ]);
  }
  const merged = {
    ...prior.fm,
    pipeline,
    status: "in_progress",
    terminal: false,
    last_advance_at: now.toISOString(),
    next_action: fields.next_action ?? `Resumed from ${status} at stage ${prior.fm.stage}`,
    stuck_counter: 0,
  };
  const content = renderCursor(merged, prior.pending, note ?? prior.body);
  writeCursorFile(dataDir, pipeline, content);
  logEvent(dataDir, "pipeline_resumed", {
    pipeline,
    sprint: sprintIdOf(merged, prior),
    stage: merged.stage,
    from_status: status,
  });
  try {
    writeProgress(dataDir);
  } catch { /* best-effort */ }
  process.stdout.write(`cursor: resumed at stage ${merged.stage} (was ${status}). Normal advances apply again.\n`);
}

/** ---- bootstrap-check ------------------------------------------------ */

/**
 * The auto-loop bootstrap eligibility computation, absorbed from ~20
 * lines of skill prose (5 ordered predicates over cursor + event log +
 * SPRINT.md). Prints one JSON line:
 *   { "loop_owner": "/loop"|"user", "eligible": bool, "reason": "...", "rearm": bool }
 * When eligible, sets `auto_loop_attempted: true` on the cursor as a
 * side effect (field-only, no tick event) so the /loop re-entry sees the
 * sentinel without a second CLI call. `rearm` is `true` only for the F3
 * dead-loop re-arm path below — `false` on every other branch, never
 * absent, so callers can always read it without an `undefined` check.
 *
 * loop_owner heuristic: see resolveLoopOwner above (shared with the
 * mid-sprint-exit marker on `cursor advance`). The window is deliberately
 * SHORT (v3.4.0, was 30 min): a live /loop ticks well inside 5 minutes,
 * and a stale tick means the loop died (Ctrl-C, crash) — the old 30-min
 * window misclassified a direct re-invocation as /loop for up to half
 * an hour, one-tick-stalling the pipeline AND disarming the cron
 * fallback (which requires loop_owner=user).
 *
 * F3 — re-arm instead of refusing forever. Before this, once
 * `auto_loop_attempted` was set, bootstrap-check returned `eligible: false`
 * for the rest of the sprint's life, unconditionally — so if the /loop
 * driver that accepted the bootstrap later died (Ctrl-C, /clear, session
 * end), NOTHING ever restarted it: the sprint sat dead until a human
 * noticed and manually re-invoked /ship-execute. The old prose asked the
 * model to derive "the loop went silent" itself by comparing tick
 * timestamps — but bootstrap-check never returned a timestamp, and the
 * Sonnet zero-thinking shell doesn't do that derivation (confirmed against
 * a live customer history: 14 pipeline_loop_bootstrap events, ZERO
 * pipeline_loop_bootstrap_fallback). So the CLI derives it instead: once
 * `auto_loop_attempted` is set, check the most recent
 * `pipeline_tick_completed` for this pipeline (mostRecentTickCompletedAt,
 * regardless of which stage it targeted) — absent or older than the same
 * 5-minute window means the loop is dead. Re-arm (`eligible: true,
 * rearm: true`) and emit the EXISTING `pipeline_loop_bootstrap_fallback`
 * event (reason=loop_silent) from here, so the re-arm is observable in the
 * audit log without relying on the model to emit it. Every refusal ahead
 * of this point (terminal cursor, paused cursor, absent SPRINT.md, a
 * `status: completed` sprint) still applies FIRST — a dead sprint must
 * NEVER re-arm, matching the v2.8.2 wakeup-leak lesson this same file
 * fixed once already.
 */
export function cursorBootstrapCheck(dataDir, pipelineArg) {
  const pipeline = canonicalPipeline(pipelineArg);
  if (!pipeline) usageFail(`cursor bootstrap-check: unknown pipeline "${pipelineArg}" — expected execute|review`);

  const out = (loop_owner, eligible, reason, rearm = false) => {
    process.stdout.write(JSON.stringify({ loop_owner, eligible, reason, rearm }) + "\n");
  };

  const prior = readCursor(dataDir, pipeline);
  if (!prior) return out("user", false, "no cursor — bootstrap runs after the first advance");
  if (String(prior.fm.terminal).toLowerCase() === "true") {
    return out("user", false, "cursor is terminal");
  }
  if ((prior.fm.status || "").toLowerCase() === "paused") {
    return out("user", false, "cursor is paused — resume is a user decision");
  }

  // Sprint liveness (the v2.2.0 wakeup-leak precondition).
  const sprintPath = join(dataDir, "sprints", "current", "SPRINT.md");
  if (!existsSync(sprintPath)) return out("user", false, "no live sprint (SPRINT.md absent)");
  try {
    const sprintFm = parseFrontmatter(readFileSync(sprintPath, "utf8"));
    if ((sprintFm.status || "").trim().toLowerCase() === "completed") {
      return out("user", false, "sprint is status: completed — never bootstrap a dead sprint");
    }
  } catch { /* unreadable — treat as live and let the advance-time guard decide */ }

  const loopOwner = resolveLoopOwner(dataDir, pipeline, prior.fm);
  if (loopOwner === "/loop") return out("/loop", false, "already driven by /loop");

  if (String(prior.fm.auto_loop_attempted).toLowerCase() === "true") {
    const lastTickAt = mostRecentTickCompletedAt(dataDir, pipeline);
    const loopSilent = lastTickAt === null || lastTickAt < Date.now() - LOOP_TICK_WINDOW_MS;
    if (loopSilent) {
      logEvent(dataDir, "pipeline_loop_bootstrap_fallback", {
        pipeline,
        sprint: sprintIdOf(prior.fm, prior),
        method: "cli",
        reason: "loop_silent",
      });
      return out(
        loopOwner,
        true,
        "auto_loop_attempted already set, but no live /loop tick in the last 5 minutes — the loop went silent; re-arming",
        true,
      );
    }
    return out(loopOwner, false, "auto_loop_attempted already set — bootstrap was already offered");
  }

  // Eligible: set the sentinel as a side effect (field-only write).
  const merged = { ...prior.fm, pipeline, auto_loop_attempted: true };
  writeCursorFile(dataDir, pipeline, renderCursor(merged, prior.pending, prior.body));
  logEvent(dataDir, "pipeline_loop_bootstrap_eligible", {
    pipeline,
    sprint: sprintIdOf(merged, prior),
    stage: merged.stage,
  });
  out(loopOwner, true, "eligible — sentinel auto_loop_attempted set; invoke Skill(loop) now");
}

/** ---- pause --------------------------------------------------------- */

export function cursorPause(dataDir, pipelineArg, rest, { now = new Date() } = {}) {
  const pipeline = canonicalPipeline(pipelineArg);
  if (!pipeline) usageFail(`cursor pause: unknown pipeline "${pipelineArg}" — expected execute|review`);
  const { fields, note } = parseArgs(rest);
  if (!note) usageFail('cursor pause: --note "<why paused / what next>" is required — it is the resume context');

  const prior = readCursor(dataDir, pipeline);
  if (!prior) {
    gateFail("cursor pause refused — no active cursor to pause", [
      `Expected sprints/current/${CURSOR_FILE[pipeline]} to exist.`,
    ]);
  }

  const merged = {
    ...prior.fm,
    pipeline,
    status: "paused",
    terminal: false,
    last_advance_at: now.toISOString(),
    next_action: fields.next_action ?? prior.fm.next_action ?? "",
  };
  const content = renderCursor(merged, prior.pending, note);
  writeCursorFile(dataDir, pipeline, content);
  logEvent(dataDir, "pipeline_paused", {
    pipeline,
    sprint: sprintIdOf(merged, prior),
    stage: merged.stage,
  });
  try {
    rmSync(join(dataDir, "sprints", "current", "HANDOFF.md"), { force: true });
  } catch { /* best-effort */ }
  try {
    writeProgress(dataDir);
  } catch { /* best-effort */ }
  clearExecutionLock(dataDir, pipeline);
  process.stdout.write(`cursor: paused at stage ${merged.stage}. Resume is a USER decision (\`shipyard-data cursor resume\`) — a /loop wakeup must never resume a paused sprint.\n`);
  cronCleanupReminder(dataDir, pipeline);
  process.stdout.write(STOP_MARKER + "\n");
}

/** ---- escalate ------------------------------------------------------ */

export function cursorEscalate(dataDir, pipelineArg, rest, { now = new Date() } = {}) {
  const pipeline = canonicalPipeline(pipelineArg);
  if (!pipeline) usageFail(`cursor escalate: unknown pipeline "${pipelineArg}" — expected execute|review`);
  const { fields, note } = parseArgs(rest);
  const reason = fields.reason;
  if (!reason) usageFail("cursor escalate: reason=<short> is required");

  const prior = readCursor(dataDir, pipeline);
  const merged = {
    ...(prior?.fm ?? {}),
    pipeline,
    stage: prior?.fm?.stage ?? "preflight",
    status: "escalated",
    terminal: true,
    last_advance_at: now.toISOString(),
    next_action: fields.next_action ?? `Escalated: ${reason}`,
  };
  // status: escalated bypasses the evidence gate by design — it is not a
  // claim of success (mirrors the hook-era classify()).
  const content = renderCursor(merged, prior?.pending ?? [], note ?? prior?.body ?? "");
  writeCursorFile(dataDir, pipeline, content);
  logEvent(dataDir, "pipeline_terminal", {
    pipeline,
    sprint: sprintIdOf(merged, prior),
    outcome: "escalated",
    reason,
  });
  try {
    writeProgress(dataDir);
  } catch { /* best-effort */ }
  clearExecutionLock(dataDir, pipeline);
  process.stdout.write(`cursor: escalated at stage ${merged.stage} (${reason}). Resume later with \`shipyard-data cursor resume\` once the cause is fixed.\n`);
  cronCleanupReminder(dataDir, pipeline);
  process.stdout.write("▶ CYCLE COMPLETE — pipeline terminal (escalated). /loop should stop.\n");
}

/** ---- noop ---------------------------------------------------------- */

export function cursorNoop(dataDir, pipelineArg, rest) {
  const pipeline = canonicalPipeline(pipelineArg);
  if (!pipeline) usageFail(`cursor noop: unknown pipeline "${pipelineArg}" — expected execute|review`);
  const { fields } = parseArgs(rest);

  const prior = readCursor(dataDir, pipeline);
  const sprint = fields.sprint || prior?.fm?.sprint || "unknown";
  const alias = pipeline === "ship-execute" ? "execute" : "review";
  const skillName = pipeline === "ship-execute" ? "ship-execute" : "ship-review";

  // PAUSED and ESCALATED are "awaiting the user" — the sprint is NOT
  // complete, and a wakeup must not resume it (resume is an explicit user
  // decision via `cursor resume`). But these wakeups still get leak
  // ACCOUNTING (v3.4.0): the v2.8.2 lesson is that a stop path with no
  // event trail lets a marker-ignoring driver spin invisibly forever. So:
  // emit a noop with an awaiting_user reason FIRST, then run the same
  // repeat detection — a second wakeup against the same halted sprint
  // screams, with the ⛔ text pointing at resume instead of "complete".
  const priorStatus = (prior?.fm?.status || "").toLowerCase();
  const awaitingUser =
    prior && (priorStatus === "escalated" || priorStatus === "paused");

  const reason =
    fields.reason ||
    (awaitingUser
      ? `awaiting_user_${priorStatus}`
      : prior && String(prior.fm.terminal).toLowerCase() === "true"
        ? "cursor_already_terminal"
        : pipeline === "ship-review"
          ? "sprint_already_archived"
          : "sprint_already_complete");

  // Emit FIRST, unconditionally — a silent no-op is what made the original
  // /loop leak invisible (v2.8.2 incident: zero outcome=noop events in the
  // whole audit log despite the auto-loop bootstrapping every sprint).
  logEvent(dataDir, "pipeline_terminal", { pipeline, sprint, outcome: "noop", reason });
  clearExecutionLock(dataDir, pipeline);

  // Repeat-leak detection over the tail (the event just emitted included).
  // Same-reason-class scoping so post-archive noops from a different dead
  // cycle don't aggregate with this one.
  const events = readEvents(dataDir, 500);
  const noops = events.filter(
    (ev) =>
      ev.type === "pipeline_terminal" &&
      ev.pipeline === pipeline &&
      ev.outcome === "noop" &&
      (ev.sprint || "unknown") === sprint &&
      (ev.reason || "") === reason,
  ).length;

  if (noops >= 2) {
    logEvent(dataDir, "pipeline_loop_leak_detected", { pipeline, sprint, noop_count: noops });
    const tail = awaitingUser
      ? `The sprint is ${priorStatus.toUpperCase()} awaiting the user — a wakeup cannot resume it. Cancel this /loop now; the user resumes with \`shipyard-data cursor resume ${alias}\` when ready.`
      : "There is no further work — cancel this /loop now and do NOT schedule another wakeup.";
    process.stdout.write(
      `⛔ LOOP LEAK — /loop is still firing /shipyard:${skillName} against a ${awaitingUser ? priorStatus : "already-complete"} sprint (${noops} no-op wakeups). It is NOT self-stopping. ${tail}\n`,
    );
    return;
  }

  cronCleanupReminder(dataDir, pipeline);
  if (awaitingUser) {
    process.stdout.write(
      `cursor: the ${pipeline} pipeline is ${priorStatus.toUpperCase()} at stage ${prior.fm.stage} — the sprint is NOT complete.\n` +
        `${priorStatus === "paused" ? `Pause note: ${String(prior.body || "").slice(0, 200)}\n` : ""}` +
        `Resume (a user decision, never a wakeup's) with: shipyard-data cursor resume ${alias}\n` +
        `▶ CYCLE COMPLETE — pipeline ${priorStatus} awaiting user. /loop should stop.\n`,
    );
    return;
  }
  process.stdout.write(
    `▶ CYCLE COMPLETE — sprint already complete${pipeline === "ship-review" ? " and archived" : ""}. /loop should stop.\n`,
  );
}

/** ---- dispatcher ---------------------------------------------------- */

export function cursorCmd(dataDir, args) {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "advance":
      cursorAdvance(dataDir, rest[0], rest[1], rest.slice(2));
      break;
    case "set":
      cursorSet(dataDir, rest[0], rest.slice(1));
      break;
    case "resume":
      cursorResume(dataDir, rest[0], rest.slice(1));
      break;
    case "bootstrap-check":
      cursorBootstrapCheck(dataDir, rest[0]);
      break;
    case "pause":
      cursorPause(dataDir, rest[0], rest.slice(1));
      break;
    case "escalate":
      cursorEscalate(dataDir, rest[0], rest.slice(1));
      break;
    case "noop":
      cursorNoop(dataDir, rest[0], rest.slice(1));
      break;
    default:
      usageFail(
        `shipyard-data cursor: unknown subcommand "${sub ?? ""}".\n` +
          `  Usage:\n` +
          `    cursor advance <execute|review> <stage> [k=v ...] [--note "..."] [--force]\n` +
          `    cursor set <execute|review> k=v [...] [--note "..."]      (field-only, no transition)\n` +
          `    cursor resume <execute|review>                            (escalated/paused → in_progress)\n` +
          `    cursor bootstrap-check <execute|review>                   (auto-loop eligibility JSON)\n` +
          `    cursor pause <execute|review> --note "..."\n` +
          `    cursor escalate <execute|review> reason=<short> [--note "..."]\n` +
          `    cursor noop <execute|review> [sprint=<id>] [reason=<r>]\n`,
      );
  }
}
