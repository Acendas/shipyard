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
 *       --force skips transition-graph validation ONLY — the evidence
 *       gates always run. Terminal stages emit pipeline_terminal and print
 *       the stop marker as the final line.
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

function buildProposed({ pipeline, stage, prior, cursorFields, note, terminal, nowIso }) {
  const priorFm = prior?.fm ?? {};
  const merged = {
    pipeline,
    sprint: cursorFields.sprint ?? priorFm.sprint ?? "",
    stage,
    wave_number: cursorFields.wave_number ?? deriveWave(pipeline, stage) ?? undefined,
    iteration: cursorFields.iteration ?? deriveIter(pipeline, stage) ?? 1,
    last_advance_at: nowIso,
    loop_owner: cursorFields.loop_owner ?? priorFm.loop_owner ?? "",
    status: cursorFields.status ?? (terminal ? terminalDefaultStatus(stage) : "in_progress"),
    next_action: cursorFields.next_action ?? "",
    terminal: terminal,
    stuck_counter:
      cursorFields.stuck_counter ??
      (prior && priorFm.stage === stage ? priorFm.stuck_counter ?? 0 : 0),
    hard_ceiling: cursorFields.hard_ceiling ?? priorFm.hard_ceiling ?? 50,
    mode: cursorFields.mode ?? priorFm.mode ?? "",
    working_branch: cursorFields.working_branch ?? priorFm.working_branch ?? "",
    auto_loop_attempted: cursorFields.auto_loop_attempted ?? priorFm.auto_loop_attempted ?? undefined,
  };

  let pending = prior?.pending ?? [];
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

/** ---- advance ------------------------------------------------------- */

export function cursorAdvance(dataDir, pipelineArg, stage, rest, { now = new Date() } = {}) {
  const pipeline = canonicalPipeline(pipelineArg);
  if (!pipeline) usageFail(`cursor advance: unknown pipeline "${pipelineArg}" — expected execute|review`);
  if (!stage) usageFail("cursor advance: missing <stage>");

  const { fields, note, force } = parseArgs(rest);
  const { outcome, reason, cursorFields } = splitEventFields(fields);
  const prior = readCursor(dataDir, pipeline);
  const from = prior?.fm?.stage ?? null;

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
  const nowIso = now.toISOString();
  const { merged, pending, body } = buildProposed({
    pipeline,
    stage,
    prior,
    cursorFields,
    note,
    terminal,
    nowIso,
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

  const sprint = sprintIdOf(merged, prior);
  if (terminal) {
    logEvent(dataDir, "pipeline_terminal", {
      pipeline,
      sprint,
      outcome: outcome || terminalDefaultOutcome(stage),
      reason: reason || stage,
    });
  } else {
    logEvent(dataDir, "pipeline_tick_completed", {
      pipeline,
      sprint,
      stage: from ?? "(fresh)",
      outcome: from === stage ? "self_loop" : "advanced",
      next_stage: stage,
      ...(merged.wave_number != null ? { wave: merged.wave_number } : {}),
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

  process.stdout.write(`cursor: ${from ?? "(fresh)"} → ${stage} (${path})\n`);
  if (terminal) {
    if (stage === "terminal_handoff_to_review") {
      // NEXT-UP first, stop marker LAST — the v2.8.2 handoff-seam rule,
      // now enforced by construction.
      process.stdout.write(
        "▶ NEXT UP: /ship-review — a SEPARATE cycle you start yourself (tip: /clear first for a fresh window).\n",
      );
    }
    process.stdout.write(STOP_MARKER + "\n");
  } else {
    const waveBit = merged.wave_number != null ? ` wave ${merged.wave_number},` : "";
    process.stdout.write(`▶ TICK COMPLETE —${waveBit} stage ${stage}. /loop continues.\n`);
  }
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
  process.stdout.write(`cursor: paused at stage ${merged.stage}. Resume with the same skill; the cursor body carries the note.\n`);
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
  process.stdout.write(`cursor: escalated at stage ${merged.stage} (${reason}).\n`);
  process.stdout.write("▶ CYCLE COMPLETE — pipeline terminal (escalated). /loop should stop.\n");
}

/** ---- noop ---------------------------------------------------------- */

export function cursorNoop(dataDir, pipelineArg, rest) {
  const pipeline = canonicalPipeline(pipelineArg);
  if (!pipeline) usageFail(`cursor noop: unknown pipeline "${pipelineArg}" — expected execute|review`);
  const { fields } = parseArgs(rest);

  const prior = readCursor(dataDir, pipeline);
  const sprint = fields.sprint || prior?.fm?.sprint || "unknown";
  const reason =
    fields.reason ||
    (prior && String(prior.fm.terminal).toLowerCase() === "true"
      ? "cursor_already_terminal"
      : pipeline === "ship-review"
        ? "sprint_already_archived"
        : "sprint_already_complete");

  // Emit FIRST, unconditionally — a silent no-op is what made the original
  // /loop leak invisible (v2.8.2 incident: zero outcome=noop events in the
  // whole audit log despite the auto-loop bootstrapping every sprint).
  logEvent(dataDir, "pipeline_terminal", { pipeline, sprint, outcome: "noop", reason });

  // Repeat-leak detection over the tail (the event just emitted included).
  const events = readEvents(dataDir, 100);
  const noops = events.filter(
    (ev) =>
      ev.type === "pipeline_terminal" &&
      ev.pipeline === pipeline &&
      ev.outcome === "noop" &&
      (ev.sprint || "unknown") === sprint,
  ).length;

  if (noops >= 2) {
    logEvent(dataDir, "pipeline_loop_leak_detected", { pipeline, sprint, noop_count: noops });
    process.stdout.write(
      `⛔ LOOP LEAK — /loop is still firing /shipyard:${pipeline === "ship-execute" ? "ship-execute" : "ship-review"} against an already-complete sprint (${noops} no-op wakeups). It is NOT self-stopping. There is no further work — cancel this /loop now and do NOT schedule another wakeup.\n`,
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
          `    cursor pause <execute|review> --note "..."\n` +
          `    cursor escalate <execute|review> reason=<short> [--note "..."]\n` +
          `    cursor noop <execute|review> [sprint=<id>] [reason=<r>]\n`,
      );
  }
}
