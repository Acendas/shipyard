/**
 * `shipyard-data discuss-queue <start|status|next|mark|decision|stop|clear>` (F026 — chained discuss)
 *
 * A CLI-owned queue so `/ship-discuss` can refine many ideas, stories or tickets
 * in a row without the earlier items bleeding into the later ones: each item is
 * handed to the model with ONLY the queue state and a short "decisions so far"
 * note, and the file survives a dead session (resume at the recorded position).
 *
 * State: `<dataDir>/.discuss-queue.json` (model writes denied by the data hook).
 *   { version, started_at, position, summary_every, items: [{ id, kind, status, note, marked_at }], decisions: [] }
 *   status: pending | in-discussion | refined | skipped | deferred | needs-info
 *
 *   start --items <id,id,...> [--summary-every <n>] [--force]   refuse if a queue is active (unless --force)
 *   status [--json]
 *   next [--json] [--peek <n>]      mark the current pending item in-discussion; print it + decisions-so-far
 *   mark <id> <status> [--note "..."]
 *   decision add "<one line>"
 *   stop                            keep the file for a later resume
 *   clear                           delete the file
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, logEvent } from "./_hook_lib.mjs";
import { entityOfId } from "./vocab.mjs";

export const QUEUE_BASENAME = ".discuss-queue.json";
export const STATUSES = Object.freeze(["pending", "in-discussion", "refined", "skipped", "deferred", "needs-info"]);
const TERMINAL = new Set(["refined", "skipped", "deferred"]);
const EXTERNAL_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const MAX_DECISIONS = 50;
const DECISIONS_IN_NOTE = 8;

export function queuePath(dataDir) {
  return join(dataDir, QUEUE_BASENAME);
}

export function readQueue(dataDir) {
  const p = queuePath(dataDir);
  if (!existsSync(p)) return null;
  try {
    const q = JSON.parse(readFileSync(p, "utf8"));
    return q && Array.isArray(q.items) ? q : null;
  } catch {
    return null;
  }
}

function writeQueue(dataDir, q) {
  atomicWrite(queuePath(dataDir), JSON.stringify(q, null, 2) + "\n");
}

export function kindOf(id) {
  const e = entityOfId(id);
  if (e === "idea") return "idea";
  if (e === "story") return "story";
  // "let's refine all of the epics": a queue of epics was refused, so eleven epics were refined in one sitting
  // with no queue (after 4.0.1). An epic is broken down in the queue like anything else.
  if (e === "epic" || /^E\d+$/.test(id)) return "epic";
  if (EXTERNAL_RE.test(id)) return "external";
  return null;
}

/** Index of the first non-terminal item at or after `from` (default: the recorded position), wrapping; -1 when none. */
function nextIndex(q, from = q.position) {
  const n = q.items.length;
  for (let k = 0; k < n; k++) {
    const i = (from + k) % n;
    if (!TERMINAL.has(q.items[i].status)) return i;
  }
  return -1;
}

export function summarize(q) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const it of q.items) counts[it.status] = (counts[it.status] ?? 0) + 1;
  const idx = nextIndex(q);
  return {
    total: q.items.length,
    position: q.position,
    current: idx === -1 ? null : q.items[idx].id,
    counts,
    done: q.items.filter((i) => TERMINAL.has(i.status)).length,
    decisions: q.decisions.length,
    active: idx !== -1,
  };
}

function decisionsNote(q) {
  const recent = q.decisions.slice(-DECISIONS_IN_NOTE);
  if (!recent.length) return "decisions so far: (none)";
  return "decisions so far:\n" + recent.map((d) => `- ${d}`).join("\n");
}

function usage(msg) {
  process.stderr.write(
    `shipyard-data discuss-queue: ${msg}\n` +
      "  Usage: discuss-queue start --items <id,id,...> [--summary-every <n>] [--force]\n" +
      "         discuss-queue status [--json] | next [--json] [--peek <n>] | mark <id> <" + STATUSES.join("|") + "> [--note \"...\"]\n" +
      "         discuss-queue decision add \"<one line>\" | stop | clear\n",
  );
  process.exit(2);
}

function refuse(msg) {
  process.stderr.write(`shipyard-data discuss-queue: ${msg}\n`);
  process.exit(3);
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) usage(`${name} needs a value`);
  return v;
}

export function main(dataDir, args = []) {
  const sub = args[0];
  const rest = args.slice(1);
  const json = rest.includes("--json");
  const q = readQueue(dataDir);

  if (sub === "start") {
    const raw = flag(rest, "--items");
    if (!raw) usage("start needs --items <id,id,...>");
    const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
    if (!ids.length) usage("--items is empty");
    const bad = ids.filter((id) => !kindOf(id));
    if (bad.length) usage(`not an idea, story or external key: ${bad.join(", ")}`);
    const every = Number(flag(rest, "--summary-every") ?? 3);
    if (!Number.isInteger(every) || every < 1) usage("--summary-every must be a positive integer");
    if (q && summarize(q).active && !rest.includes("--force")) {
      refuse(`a discuss queue is active (${summarize(q).done}/${q.items.length} done, current ${summarize(q).current}) — resume it with \`discuss-queue next\`, or start over with --force`);
    }
    const nq = {
      version: 1,
      started_at: new Date().toISOString(),
      position: 0,
      summary_every: every,
      items: ids.map((id) => ({ id, kind: kindOf(id), status: "pending", note: "", marked_at: null })),
      decisions: [],
    };
    writeQueue(dataDir, nq);
    try { logEvent(dataDir, "discuss_queue_started", { count: ids.length, items: ids.join(","), forced: rest.includes("--force") }); } catch { /* best-effort */ }
    process.stdout.write(json ? JSON.stringify(summarize(nq)) + "\n" : `discuss queue started: ${ids.length} item(s) — ${ids.join(", ")}\n`);
    return;
  }

  if (sub === "status") {
    if (!q) {
      process.stdout.write(json ? JSON.stringify({ active: false }) + "\n" : "no discuss queue\n");
      return;
    }
    const s = summarize(q);
    if (json) { process.stdout.write(JSON.stringify({ ...s, items: q.items, decisions: q.decisions }) + "\n"); return; }
    process.stdout.write(`discuss queue: ${s.done}/${s.total} done; current ${s.current ?? "(none)"}; ` +
      Object.entries(s.counts).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(" ") + `\n${decisionsNote(q)}\n`);
    return;
  }

  if (!q && sub !== "clear" && sub !== "stop") refuse("no discuss queue — start one with `discuss-queue start --items ...`");

  if (sub === "next") {
    const peek = Number(flag(rest, "--peek") ?? 0);
    if (!Number.isInteger(peek) || peek < 0 || peek > 2) usage("--peek must be 0, 1 or 2 (lookahead is bounded)");
    const idx = nextIndex(q);
    if (idx === -1) {
      process.stdout.write(json ? JSON.stringify({ done: true, ...summarize(q) }) + "\n" : "SHIPYARD_DISCUSS_QUEUE_DONE=true\nall items are refined, skipped or deferred — `discuss-queue clear` when the summary is shown\n");
      return;
    }
    q.position = idx;
    const item = q.items[idx];
    if (item.status === "pending" || item.status === "needs-info") {
      item.status = "in-discussion";
      item.marked_at = new Date().toISOString();
      writeQueue(dataDir, q);
    }
    const ahead = [];
    for (let i = idx + 1; i < q.items.length && ahead.length < peek; i++) if (!TERMINAL.has(q.items[i].status)) ahead.push(q.items[i].id);
    const s = summarize(q);
    const summaryDue = s.done > 0 && s.done % q.summary_every === 0 && item.status === "in-discussion";
    if (json) { process.stdout.write(JSON.stringify({ item, index: idx, total: q.items.length, decisions: q.decisions.slice(-DECISIONS_IN_NOTE), peek: ahead, summary_due: summaryDue }) + "\n"); return; }
    process.stdout.write(`item ${idx + 1} of ${q.items.length}: ${item.id} (${item.kind}, ${item.status})${item.note ? ` — ${item.note}` : ""}\n${decisionsNote(q)}\n`);
    if (ahead.length) process.stdout.write(`next up: ${ahead.join(", ")}\n`);
    if (summaryDue) process.stdout.write(`SHIPYARD_DISCUSS_QUEUE_SUMMARY_DUE=true\n`);
    return;
  }

  if (sub === "mark") {
    const [id, status] = rest.filter((a) => !a.startsWith("--") && a !== flag(rest, "--note"));
    if (!id || !status) usage("mark needs <id> <status>");
    if (!STATUSES.includes(status)) usage(`status must be one of ${STATUSES.join("|")}`);
    const item = q.items.find((i) => i.id === id);
    if (!item) refuse(`${id} is not in the queue`);
    item.status = status;
    item.note = flag(rest, "--note") ?? item.note;
    item.marked_at = new Date().toISOString();
    // Move on past the marked item even when its status is not terminal
    // (needs-info): the loop continues and wraps back to it at the end.
    const idx = nextIndex(q, q.items.indexOf(item) + 1);
    if (idx !== -1) q.position = idx;
    writeQueue(dataDir, q);
    try { logEvent(dataDir, "discuss_queue_item_marked", { id, status }); } catch { /* best-effort */ }
    process.stdout.write(`${id}: ${status}\n`);
    return;
  }

  if (sub === "decision") {
    if (rest[0] !== "add" || !rest[1]) usage('decision add "<one line>"');
    const line = rest.slice(1).join(" ").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!q.decisions.includes(line)) q.decisions.push(line);
    if (q.decisions.length > MAX_DECISIONS) q.decisions = q.decisions.slice(-MAX_DECISIONS);
    writeQueue(dataDir, q);
    process.stdout.write(`decision recorded (${q.decisions.length})\n`);
    return;
  }

  if (sub === "stop") {
    if (!q) { process.stdout.write("no discuss queue\n"); return; }
    try { logEvent(dataDir, "discuss_queue_stopped", { done: summarize(q).done, total: q.items.length }); } catch { /* best-effort */ }
    process.stdout.write(`stopped at ${summarize(q).done}/${q.items.length}; resume with /ship-discuss (the queue file is kept)\n`);
    return;
  }

  if (sub === "clear") {
    if (!q) { process.stdout.write("no discuss queue\n"); return; }
    rmSync(queuePath(dataDir), { force: true });
    try { logEvent(dataDir, "discuss_queue_cleared", { done: summarize(q).done, total: q.items.length }); } catch { /* best-effort */ }
    process.stdout.write("discuss queue cleared\n");
    return;
  }

  usage(`unknown subcommand "${sub ?? ""}"`);
}
