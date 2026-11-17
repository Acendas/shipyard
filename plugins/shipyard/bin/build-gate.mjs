/**
 * build-gate — one door for every build and test run of a project.
 *
 * Found on a real sprint (after 4.0.4): five builders each ran the project's
 * build tool at the same time on a 16 GB, 10-core machine. The load average
 * was 34 to 44, there were 26 JVMs, single probes took three to six minutes,
 * and builds failed for reasons that had nothing to do with the code ("cannot
 * find a Java installation"). The planner had warned about it in a sentence;
 * nothing could act on a sentence.
 *
 * Builders already run their builds through `shipyard-logcap run`, so the
 * door is there. A builder does nothing new: it runs the same command and the
 * CLI makes it wait.
 *
 *   nothing running            -> go (so a bad measurement can never deadlock)
 *   room for one more?         -> go
 *   otherwise wait, at most a few minutes, then QUEUED (exit 75): the builder
 *   runs the same command again and keeps its place.
 *
 * "Room" is measured, never a default number:
 *   - what one run takes (cores, memory) is read from runs that ran alone;
 *   - until one such run exists, runs go one at a time;
 *   - the machine's free memory and load are read at the moment of asking, so
 *     another session's build counts too;
 *   - a run killed while others ran lowers the limit by one for 12 hours;
 *   - `execution.build_slots` is the owner's number and replaces all of it.
 *
 * Two lanes. `local` is this machine. `runner` is the project's own script
 * (`execution.runner_command`) that runs the command somewhere else; its
 * limit is what the script answers to `--capacity`.
 *
 * Why the runner lane is gated too: a tool call ends after ten minutes. A run
 * parked in the remote host's own queue would be killed while waiting.
 *
 * State: <data>/.build-gate.json, CLI-owned, written under a lockfile.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { logEvent, withLockfile } from "./_hook_lib.mjs";

export const QUEUED_EXIT = 75;
export const RUNNER_UNAVAILABLE_EXIT = 69;
export const STATE_NAME = ".build-gate.json";

const TICKET_TTL_MS = 6 * 60_000;
const SHRINK_TTL_MS = 12 * 60 * 60_000;
const RUNNER_CACHE_MS = 5 * 60_000;
/** Fits inside a tool call's default two minutes; a caller that set a longer timeout passes `--wait`. */
const DEFAULT_WAIT_MS = 100_000;
/** A run that waited longer than this is not started in the same call: see `enter`. */
const START_LATE_MS = 20_000;
const RESERVE_MS = 90_000;
const POLL_MS = 2_000;
const MIN_MEASURED_SECONDS = 10;
const KEEP_SAMPLES = 8;
/** Part of the machine's memory that a second run must leave free. */
const RESERVE_FRACTION = 0.15;

// ─── Config ────────────────────────────────────────────────────────────────

function frontmatter(dataDir) {
  try {
    const text = readFileSync(join(dataDir, "config.md"), "utf8");
    return (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) ?? [])[1] ?? "";
  } catch { return ""; }
}

function unquote(raw) {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") { const end = v.indexOf(q, 1); return end > 0 ? v.slice(1, end) : v.slice(1); }
  return v.replace(/\s+#.*$/, "").trim();
}

/** Every `key: value` directly under a top-level `block:`. */
function blockEntries(fm, block) {
  const lines = fm.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${block}:\\s*$`).test(l));
  const out = {};
  if (start === -1) return out;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*(#|$)/.test(lines[i])) continue;
    if (/^\S/.test(lines[i])) break;
    const m = lines[i].match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

export function readGateConfig(dataDir) {
  const fm = frontmatter(dataDir);
  const ex = blockEntries(fm, "execution");
  const n = Number(ex.build_slots);
  return {
    enabled: String(ex.build_gate ?? "").toLowerCase() !== "false",
    slots: ex.build_slots && Number.isInteger(n) && n >= 1 ? n : null,
    runner: (ex.runner_command ?? "").trim() ? ex.runner_command.trim().split(/\s+/) : null,
    commands: [...Object.values(blockEntries(fm, "test_commands")), ...Object.values(blockEntries(fm, "build_commands"))].filter(Boolean),
  };
}

// ─── Which commands are builds ─────────────────────────────────────────────

/** Words that start another program: the tool is what comes after them. */
const LAUNCHERS = new Set(["env", "sh", "bash", "zsh", "python", "python3", "node", "npx", "bunx", "time", "nice", "command", "exec", "sudo", "timeout", "gtimeout", "nohup", "caffeinate"]);
/** Package runners: a tool of their own (`npm test`) or a launcher (`pnpm exec vitest`). */
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Tools whose first word says too little: `go test` is a build, `go fmt` is not. */
const TWO_WORD = new Set(["go", "cargo", "dotnet", "npm", "pnpm", "yarn", "bun", "mvn", "bazel"]);
const SHELLS = new Set(["sh", "bash", "zsh"]);

const base = (tok) => basename(String(tok)).replace(/\.(cmd|bat|exe|sh)$/i, "");

/** The tool a command runs, as "tool" or "tool sub": "./gradlew test" -> "gradlew", "go test ./..." -> "go test". */
export function signatureOf(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || t.startsWith("-") || /^\d+[smh]?$/.test(t)) { i++; continue; }
    const b = base(t);
    if (LAUNCHERS.has(b)) { i++; if (tokens[i] === "-m") i++; continue; }
    if (RUNNERS.has(b) && ["exec", "dlx", "x"].includes(tokens[i + 1])) { i += 2; continue; }
    if (TWO_WORD.has(b)) {
      const sub = tokens.slice(i + 1).find((x) => !x.startsWith("-"));
      return sub ? `${b} ${sub}` : b;
    }
    return b;
  }
  return "";
}

/** The set of build and test tools this project configured. Empty: nothing is gated. */
export function heavySignatures(commands) {
  const out = new Set();
  for (const c of commands) {
    const s = signatureOf(String(c).trim().split(/\s+/).filter(Boolean));
    if (s) out.add(s);
  }
  return out;
}

function matches(sig, sigs) {
  if (!sig) return false;
  if (sigs.has(sig)) return true;
  // "gradlew" configured, any gradlew call matches; "go test" configured, only `go test`.
  const first = sig.split(" ")[0];
  return sigs.has(first);
}

/** A shell script named on the command line that itself runs a build tool (a wrapper written to set an env var). */
function scriptRunsHeavy(tokens, sigs, cwd) {
  const i = tokens.findIndex((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  if (i === -1) return false;
  let file = null;
  if (SHELLS.has(base(tokens[i])) && tokens[i + 1] && !tokens[i + 1].startsWith("-")) file = tokens[i + 1];
  else if (/\.(sh|zsh|bash)$/.test(tokens[i])) file = tokens[i];
  if (!file) return false;
  let text;
  try { text = readFileSync(isAbsolute(file) ? file : resolve(cwd, file), "utf8").slice(0, 64 * 1024); } catch { return false; }
  return text.split(/\r?\n/).some((line) => segments(line).some((seg) => matches(signatureOf(seg), sigs)));
}

/** `sh -c "<commands>"`: the commands inside. */
function inlineRunsHeavy(tokens, sigs) {
  const i = tokens.findIndex((t) => SHELLS.has(base(t)));
  if (i === -1) return false;
  const c = tokens.findIndex((t, k) => k > i && /^-[a-z]*c$/.test(t));
  return c !== -1 && tokens[c + 1] != null && segments(tokens[c + 1]).some((seg) => matches(signatureOf(seg), sigs));
}

/** Is this argv a build or test run of the project's tool? */
export function isHeavyArgv(argv, sigs, cwd = process.cwd()) {
  if (!sigs.size) return false;
  return matches(signatureOf(argv), sigs) || scriptRunsHeavy(argv, sigs, cwd) || inlineRunsHeavy(argv, sigs);
}

/** A shell command line cut at `&&`, `||`, `;`, `|` and newlines, each part as words. Quotes are not parsed. */
export function segments(command) {
  return String(command).split(/&&|\|\||[;|\n]/).map((s) => s.trim().split(/\s+/).filter(Boolean)).filter((t) => t.length);
}

/**
 * For the builder hook: the first part of a shell command that runs a build
 * tool outside `shipyard-logcap run`, or null.
 */
export function ungatedHeavy(command, sigs, cwd = process.cwd()) {
  if (!sigs.size) return null;
  for (const seg of segments(command)) {
    const words = seg.filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
    if (!words.length || base(words[0]) === "shipyard-logcap" || words[0] === "export" || words[0] === "cd") continue;
    if (matches(signatureOf(seg), sigs) || scriptRunsHeavy(seg, sigs, cwd)) return seg.join(" ");
  }
  return null;
}

// ─── What the machine has ──────────────────────────────────────────────────

/**
 * Memory another run could use, in bytes, or null when this platform has no
 * reading worth trusting. `os.freemem()` is not one on macOS: it reported
 * 0.07 GB of 16 on a machine whose own figure was 35% free.
 */
export function availableBytes() {
  try {
    const p = platform();
    if (p === "darwin") {
      const pct = Number(execFileSync("sysctl", ["-n", "kern.memorystatus_level"], { encoding: "utf8", timeout: 2000 }).trim());
      return Number.isFinite(pct) && pct >= 0 && pct <= 100 ? Math.round((pct / 100) * totalmem()) : null;
    }
    if (p === "linux") {
      const m = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)\s+kB/m);
      return m ? Number(m[1]) * 1024 : null;
    }
    if (p === "win32") return freemem();
  } catch { /* unknown */ }
  return null;
}

function cpuSnapshot() {
  let busy = 0, total = 0;
  for (const c of cpus()) {
    const t = c.times;
    const all = t.user + t.nice + t.sys + t.idle + t.irq;
    total += all;
    busy += all - t.idle;
  }
  return { busy, total };
}

export function machine() {
  const p = platform();
  return {
    cores: cpus().length || 1,
    total: totalmem(),
    available: availableBytes(),
    load1: p === "win32" ? null : loadavg()[0],
  };
}

// ─── State ─────────────────────────────────────────────────────────────────

const emptyState = () => ({ v: 1, holders: [], queue: [], need: { cores: [], mem: [] }, shrink: null, runner: null });

function readState(dataDir) {
  try {
    const s = JSON.parse(readFileSync(join(dataDir, STATE_NAME), "utf8"));
    return { ...emptyState(), ...s, need: { cores: [], mem: [], ...(s.need ?? {}) } };
  } catch { return emptyState(); }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export function prune(state, now = Date.now(), isAlive = alive) {
  state.holders = state.holders.filter((h) => (h.reserved ? now < h.until : isAlive(h.pid)));
  state.queue = state.queue.filter((q) => now - q.seen <= TICKET_TTL_MS);
  if (state.shrink && now - state.shrink.at > SHRINK_TTL_MS) state.shrink = null;
  return state;
}

function mutate(dataDir, fn) {
  let out;
  withLockfile(join(dataDir, STATE_NAME + ".lock"), () => {
    const state = prune(readState(dataDir));
    out = fn(state);
    writeFileSync(join(dataDir, STATE_NAME), JSON.stringify(state, null, 1) + "\n");
  }, { ttlMs: 10_000, retryMs: 50, maxRetries: 400 });
  return out;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** What one run takes, from runs that ran alone. null fields: not measured yet. */
export function needOf(state) {
  return {
    cores: state.need.cores.length ? median(state.need.cores) : null,
    mem: state.need.mem.length ? Math.max(...state.need.mem) : null,
  };
}

/** How many local runs fit at once, and why. */
export function localLimit(state, cfg, m) {
  if (cfg.slots) return { limit: cfg.slots, why: `execution.build_slots is ${cfg.slots}` };
  const need = needOf(state);
  if (need.cores == null || need.mem == null) return { limit: 1, why: "no run has been measured alone yet" };
  const byCpu = Math.max(1, Math.floor(m.cores / Math.max(1, need.cores)));
  const byMem = need.mem > 0 ? Math.max(1, Math.floor((m.total * (1 - RESERVE_FRACTION)) / need.mem)) : byCpu;
  const shrink = state.shrink?.n ?? 0;
  const limit = Math.max(1, Math.min(byCpu, byMem) - shrink);
  return { limit, why: `one run takes about ${need.cores.toFixed(1)} of ${m.cores} cores and ${(need.mem / 2 ** 30).toFixed(1)} GB${shrink ? `, lowered by ${shrink} after a killed run` : ""}` };
}

/**
 * May this ticket run now? Pure: state in, verdict out.
 * { go, solo?, place?, of?, why }
 */
export function decide(state, ticket, cfg, m) {
  const lane = ticket.lane;
  const line = state.queue.filter((q) => q.lane === lane).sort((a, b) => (Number(b.first) - Number(a.first)) || (a.at - b.at));
  const place = line.findIndex((q) => q.key === ticket.key);
  const running = state.holders.filter((h) => h.lane === lane).length;
  const wait = (why) => ({ go: false, place: place + 1, of: line.length, running, why });
  if (place > 0) return wait("others are ahead in line");
  if (lane === "runner") {
    const cap = state.runner?.capacity ?? 0;
    return running < cap ? { go: true, solo: false, why: `runner has room (${running} of ${cap})` } : wait(`the runner is full (${running} of ${cap})`);
  }
  if (running === 0) return { go: true, solo: true, why: "nothing else is running" };
  const { limit, why } = localLimit(state, cfg, m);
  if (running >= limit) return wait(`${running} running, room for ${limit}: ${why}`);
  if (!cfg.slots) {
    const need = needOf(state);
    if (m.available == null) return wait("this machine's free memory cannot be read");
    if (m.available - need.mem < m.total * RESERVE_FRACTION) return wait(`not enough free memory for another run (${(m.available / 2 ** 30).toFixed(1)} GB free)`);
    if (m.load1 != null && m.load1 > m.cores) return wait(`the machine is busy (load ${m.load1.toFixed(1)} on ${m.cores} cores)`);
  }
  return { go: true, solo: false, why };
}

// ─── Runner ────────────────────────────────────────────────────────────────

/** Ask the project's runner how many runs it takes at once. null: it did not answer, so it is not used. */
export function askRunnerCapacity(runner, cwd = process.cwd()) {
  try {
    const out = execFileSync(runner[0], [...runner.slice(1), "--capacity"], { encoding: "utf8", timeout: 20_000, cwd, stdio: ["ignore", "pipe", "ignore"] });
    const n = Number(out.trim().split(/\s+/).pop());
    return Number.isInteger(n) && n >= 1 ? n : null;
  } catch { return null; }
}

/** Which lane a run takes. Refreshes the runner's capacity at most every five minutes. */
export function chooseLane(dataDir, cfg, argv, sigs, { ask = askRunnerCapacity, now = Date.now() } = {}) {
  // A wrapper script stays here: only a direct call of the tool is something a runner can repeat elsewhere.
  if (!cfg.runner || !matches(signatureOf(argv), sigs)) return "local";
  const cached = readState(dataDir).runner;
  if (cached && now - cached.at < RUNNER_CACHE_MS) return cached.capacity ? "runner" : "local";
  const capacity = ask(cfg.runner);
  mutate(dataDir, (s) => { s.runner = { capacity, at: now }; });
  if (!capacity) {
    try { logEvent(dataDir, "runner_unavailable", { reason: "no answer to --capacity" }); } catch { /* best effort */ }
    return "local";
  }
  return "runner";
}

/** The runner said it could not run the command (exit 69): stay local for five minutes. */
export function markRunnerDown(dataDir) {
  mutate(dataDir, (s) => { s.runner = { capacity: null, at: Date.now() }; });
  try { logEvent(dataDir, "runner_unavailable", { reason: "exit 69" }); } catch { /* best effort */ }
}

export function runnerArgv(cfg, argv, cwd = process.cwd()) {
  return [...cfg.runner, "--worktree", cwd, "--", ...argv];
}

// ─── Enter and leave ───────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The step a capture name belongs to ("P026-probe-1" -> "P026"), for the queue's liveness. */
export const taskOf = (name) => (String(name).match(/^([A-Z]{1,3}\d{2,})(?:-|$)/) ?? [])[1] ?? null;

/**
 * Wait for a place. Resolves
 *   { granted: true, id, solo }                 run now
 *   { granted: false, turn: true }              a place is held for this command: run it again now
 *   { granted: false, place, of, why }          the wait ran out
 *
 * Why "run it again" instead of running: the caller's tool call has a time
 * limit that started before the wait. A build started four minutes into a
 * ten-minute call is killed at minute ten. Held for 90 seconds, the place
 * waits for a new call with its whole time ahead of it.
 */
export async function enter(dataDir, { key, name, lane, first = false, cfg, waitMs = DEFAULT_WAIT_MS, pollMs = POLL_MS, onWait = () => {} }) {
  const started = Date.now();
  let told = false;
  for (;;) {
    const now = Date.now();
    const verdict = mutate(dataDir, (state) => {
      const held = state.holders.find((h) => h.reserved && h.key === key);
      if (held) {
        Object.assign(held, { reserved: false, until: undefined, pid: process.pid, id: `${process.pid}-${now}`, at: now, name });
        return { go: true, solo: held.solo, id: held.id };
      }
      let t = state.queue.find((q) => q.key === key);
      if (!t) { t = { key, name, lane, first, at: now, seen: now }; state.queue.push(t); }
      t.seen = now;
      t.lane = lane;
      const v = decide(state, t, cfg, lane === "local" ? machine() : null);
      if (v.go) {
        state.queue = state.queue.filter((q) => q.key !== key);
        // A run that gets company was not measured alone.
        for (const h of state.holders) if (h.lane === lane) h.solo = false;
        const late = now - started > START_LATE_MS;
        state.holders.push({ id: `${process.pid}-${now}`, pid: process.pid, key, name, lane, at: now, solo: v.solo, ...(late ? { reserved: true, until: now + RESERVE_MS } : {}) });
        v.id = `${process.pid}-${now}`;
        v.turn = late;
      }
      return v;
    });
    if (verdict.go) {
      if (told) { try { logEvent(dataDir, "build_gate_admitted", { name, lane, task: taskOf(name), waited_s: Math.round((Date.now() - started) / 1000) }); } catch { /* best effort */ } }
      if (verdict.turn) return { granted: false, turn: true };
      return { granted: true, id: verdict.id, solo: verdict.solo };
    }
    if (!told) {
      told = true;
      onWait(verdict);
      try { logEvent(dataDir, "build_gate_waiting", { name, lane, task: taskOf(name), place: verdict.place, why: verdict.why }); } catch { /* best effort */ }
    }
    if (Date.now() - started + pollMs > waitMs) {
      try { logEvent(dataDir, "build_gate_waiting", { name, lane, task: taskOf(name), place: verdict.place, queued: true }); } catch { /* best effort */ }
      return { granted: false, place: verdict.place, of: verdict.of, why: verdict.why };
    }
    await sleep(pollMs);
  }
}

/**
 * Samples the machine while a run that started alone is going. Resolves null
 * when the machine is already busy with something else: a reading taken then
 * says nothing about this run (seen live: `sleep 12` "took" 10 of 10 cores
 * while another project's sprint held the machine at load 31).
 */
export async function startMeter({ settleMs = 250 } = {}) {
  const n = cpus().length || 1;
  const before = cpuSnapshot();
  await sleep(settleMs);
  const after = cpuSnapshot();
  const dt0 = after.total - before.total;
  const idleBusy = dt0 > 0 ? ((after.busy - before.busy) / dt0) * n : 0;
  if (idleBusy > n * 0.5) return null;
  const startAvail = availableBytes();
  let prev = after;
  let minAvail = startAvail;
  const busy = [];
  const timer = setInterval(() => {
    const cur = cpuSnapshot();
    const dt = cur.total - prev.total;
    if (dt > 0) busy.push(((cur.busy - prev.busy) / dt) * n);
    prev = cur;
    const a = availableBytes();
    if (a != null && (minAvail == null || a < minAvail)) minAvail = a;
  }, 3000);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      if (!busy.length) return null;
      const sorted = [...busy].sort((a, b) => a - b);
      const cores = Math.min(n, Math.max(1, sorted[Math.floor(sorted.length * 0.75)] - idleBusy));
      const mem = startAvail != null && minAvail != null ? Math.max(0, startAvail - minAvail) : null;
      return { cores, mem };
    },
  };
}

/**
 * The run ended. Frees the place, keeps the measurement of a run that stayed
 * alone, and lowers the limit when the run was killed while others ran.
 */
export function leave(dataDir, id, { seconds = 0, sample = null, killed = false, name = "" } = {}) {
  let measured = null, shrunk = false;
  mutate(dataDir, (state) => {
    const h = state.holders.find((x) => x.id === id);
    state.holders = state.holders.filter((x) => x.id !== id);
    if (!h || h.lane !== "local") return;
    if (killed && state.holders.some((x) => x.lane === "local")) {
      state.shrink = { n: (state.shrink?.n ?? 0) + 1, at: Date.now() };
      shrunk = true;
    }
    if (h.solo && sample && sample.mem != null && seconds >= MIN_MEASURED_SECONDS && !killed) {
      state.need.cores = [...state.need.cores, sample.cores].slice(-KEEP_SAMPLES);
      state.need.mem = [...state.need.mem, sample.mem].slice(-KEEP_SAMPLES);
      measured = sample;
    }
  });
  try {
    if (measured) logEvent(dataDir, "build_need_measured", { name, cores: Number(measured.cores.toFixed(1)), mem_mb: Math.round(measured.mem / 2 ** 20), seconds });
    if (shrunk) logEvent(dataDir, "build_gate_shrunk", { name });
  } catch { /* best effort */ }
}

// ─── `shipyard-data build-gate` ────────────────────────────────────────────

export function status(dataDir) {
  const cfg = readGateConfig(dataDir);
  const state = prune(readState(dataDir));
  const m = machine();
  const sigs = [...heavySignatures(cfg.commands)];
  const { limit, why } = localLimit(state, cfg, m);
  return {
    enabled: cfg.enabled && sigs.length > 0,
    tools: sigs,
    local: { limit, why, running: state.holders.filter((h) => h.lane === "local").map((h) => h.name), waiting: state.queue.filter((q) => q.lane === "local").map((q) => q.name) },
    runner: cfg.runner ? { command: cfg.runner.join(" "), capacity: state.runner?.capacity ?? null, running: state.holders.filter((h) => h.lane === "runner").map((h) => h.name), waiting: state.queue.filter((q) => q.lane === "runner").map((q) => q.name) } : null,
    machine: { cores: m.cores, total_gb: Number((m.total / 2 ** 30).toFixed(1)), free_gb: m.available == null ? null : Number((m.available / 2 ** 30).toFixed(1)), load: m.load1 == null ? null : Number(m.load1.toFixed(1)) },
  };
}

export function renderStatus(s) {
  if (!s.tools.length) return "BUILD GATE · off: no test or build command is configured, so nothing is held.";
  if (!s.enabled) return "BUILD GATE · off (execution.build_gate: false)";
  const lines = [
    `BUILD GATE · ${s.local.running.length} running here, ${s.local.waiting.length} waiting, room for ${s.local.limit}`,
    `  why      ${s.local.why}`,
    `  machine  ${s.machine.cores} cores, ${s.machine.total_gb} GB${s.machine.free_gb == null ? ", free memory unreadable" : `, ${s.machine.free_gb} GB free`}${s.machine.load == null ? "" : `, load ${s.machine.load}`}`,
    `  held     ${s.tools.join(", ")}`,
  ];
  if (s.runner) lines.push(`  runner   ${s.runner.command}: ${s.runner.capacity == null ? "no answer yet" : `${s.runner.running.length} of ${s.runner.capacity} running, ${s.runner.waiting.length} waiting`}`);
  return lines.join("\n");
}

// ─── The ready check ───────────────────────────────────────────────────────

/**
 * The quick command that proves the build can start: `test_commands.ready`,
 * or, for the two tools whose "do nothing but configure" call is certain, that
 * call. Anything else: none, and the check says so instead of guessing.
 */
export function readyCommand(dataDir) {
  const fm = frontmatter(dataDir);
  const own = (blockEntries(fm, "test_commands").ready ?? "").trim();
  if (own) return { command: own, source: "test_commands.ready" };
  for (const c of readGateConfig(dataDir).commands) {
    const tok = String(c).trim().split(/\s+/)[0] ?? "";
    const b = base(tok);
    if (b === "gradlew" || b === "gradle") return { command: `${tok} help`, source: "the build tool's own configure-only call" };
    if (b === "mvnw" || b === "mvn") return { command: `${tok} -q validate`, source: "the build tool's own configure-only call" };
  }
  return null;
}

/** Did the sprint's readiness stage settle the ready check? Used by `cursor advance`. */
export function readySettled(events, sprint) {
  let start = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === "pipeline_tick_completed" && e.next_stage === "readiness" && (!e.sprint || !sprint || sprint === "unknown" || e.sprint === sprint)) start = i;
  }
  if (start === -1) return true; // no readiness stage in sight: nothing to hold
  for (let i = events.length - 1; i > start; i--) {
    if (events[i].type === "build_ready_checked") return events[i].result !== "failed";
  }
  return false;
}

/** Is the ready check owed at all for this project? */
export function readyOwed(dataDir) {
  const cfg = readGateConfig(dataDir);
  return cfg.enabled && heavySignatures(cfg.commands).size > 0;
}

async function check(dataDir, args) {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname } = await import("node:path");
  const say = (line) => process.stdout.write(line + "\n");
  const accept = args.indexOf("--accept");
  if (accept !== -1) {
    const answer = (args[accept + 1] ?? "").trim();
    if (!answer) { process.stderr.write("shipyard-data build-gate check: --accept needs the person's answer in quotes.\n"); process.exit(2); }
    logEvent(dataDir, "build_ready_checked", { result: "accepted", answer: answer.slice(0, 200) });
    say("READY CHECK · accepted by the owner: the sprint starts although the build did not.");
    return;
  }
  if (!readyOwed(dataDir)) {
    logEvent(dataDir, "build_ready_checked", { result: "skipped", reason: "no test or build command configured" });
    say("READY CHECK · skipped: no test or build command is configured.");
    return;
  }
  const cfg = readGateConfig(dataDir);
  const ready = readyCommand(dataDir);
  if (!ready) {
    logEvent(dataDir, "build_ready_checked", { result: "skipped", reason: "no ready command" });
    say("READY CHECK · skipped: set `test_commands.ready` to a quick command that proves the build can start (a few seconds, no full suite).");
    return;
  }
  let root = "";
  try { root = readFileSync(join(dataDir, ".project-root"), "utf8").trim(); } catch { /* cwd */ }
  const logcap = join(dirname(fileURLToPath(import.meta.url)), "shipyard-logcap.mjs");
  const started = Date.now();
  const r = spawnSync(process.execPath, [logcap, "run", "ready-check", "--gate", "--", ...ready.command.split(/\s+/)], {
    cwd: root && existsSync(root) ? root : process.cwd(), encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, SHIPYARD_DATA: dataDir },
  });
  const seconds = Math.round((Date.now() - started) / 1000);
  const code = r.status ?? 1;
  if (code === QUEUED_EXIT) {
    say("READY CHECK · not run yet: another build is running on this machine. Run the same command again.");
    process.exit(QUEUED_EXIT);
  }
  const where = cfg.runner ? (readState(dataDir).runner?.capacity ? `on the runner (room for ${readState(dataDir).runner.capacity})` : "on this machine: the runner did not answer `--capacity`") : "on this machine";
  if (code === 0) {
    logEvent(dataDir, "build_ready_checked", { result: "passed", command: ready.command.slice(0, 160), seconds });
    say(`READY CHECK · the build starts (${seconds} s, ${where}): ${ready.command}`);
    return;
  }
  logEvent(dataDir, "build_ready_checked", { result: "failed", command: ready.command.slice(0, 160), exit: code, seconds });
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("logcap:")).slice(-15);
  say(`READY CHECK · FAILED (exit ${code}, ${where}): ${ready.command}`);
  say("  The build does not start, so no builder is dispatched. The end of its output:");
  for (const l of tail) say(`    ${l.slice(0, 200)}`);
  say("  Fix it (often an expired login or token: that is the person's to renew), then run this again.");
  say("  To start anyway, with the person's recorded answer: shipyard-data build-gate check --accept \"<their answer>\"");
  process.exit(3);
}

export async function main(dataDir, args = []) {
  if (!dataDir || !existsSync(dataDir)) { process.stderr.write("shipyard-data build-gate: no Shipyard data folder for this project.\n"); process.exit(1); }
  if (args[0] === "status") {
    const s = status(dataDir);
    process.stdout.write((args.includes("--json") ? JSON.stringify(s) : renderStatus(s)) + "\n");
    return;
  }
  if (args[0] === "check") return check(dataDir, args.slice(1));
  process.stderr.write("shipyard-data build-gate: usage: build-gate status [--json] | build-gate check [--accept \"<answer>\"]\n");
  process.exit(2);
}
