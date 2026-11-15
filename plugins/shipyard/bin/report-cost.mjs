/**
 * `shipyard-data report cost` (F010 AC-8, AC-10).
 *
 * Groups accepted tasks by tier (model) and task kind. Tokens are shown only
 * when an event carried them (`tokens=<n>`); absent means absent, never 0.
 * Without tokens the report shows attempts and duration, labelled as proxies;
 * a group where only some tasks carry tokens shows the partial sum labelled
 * `(n/m tasks have tokens)` plus the proxy for the tokenless tasks.
 * Task kind comes from the task file's frontmatter `kind:` when found under
 * spec/tasks or spec/archive/tasks, else the event/queue kind, else unknown.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readEvents } from "./event-report.mjs";
import { computeTimeReport } from "./report-time.mjs";
import { currentSprintId, parseFrontmatter } from "./terminal-gate.mjs";

const UNKNOWN = "unknown";
const SEP = "\u0000";
const sprintOf = (e) => (typeof e.sprint === "string" && e.sprint.trim() ? e.sprint.trim() : UNKNOWN);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const tokenOf = (v) => {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const min = (ms) => (ms / 60000).toFixed(1);

/** Index step/task id -> frontmatter kind from spec/steps, spec/tasks and their archives. */
export function loadTaskKinds(dataDir) {
  const kinds = new Map();
  if (!dataDir) return kinds;
  for (const sub of [["spec", "steps"], ["spec", "tasks"], ["spec", "archive", "steps"], ["spec", "archive", "tasks"]]) {
    const dir = join(dataDir, ...sub);
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".md")) continue;
      try {
        const fm = parseFrontmatter(readFileSync(join(dir, n), "utf8"));
        const kind = str(fm.kind);
        const id = str(fm.id) ?? n.replace(/\.md$/, "").split("-")[0];
        if (kind && id && !kinds.has(id)) kinds.set(id, kind);
      } catch { /* unreadable task file: fall back to event kind */ }
    }
  }
  return kinds;
}

export function computeCostReport(events, corrupt = 0, opts = {}) {
  const evs = events
    .filter((e) => Number.isFinite(Date.parse(e.ts)))
    .filter((e) => !opts.sprint || sprintOf(e) === opts.sprint || sprintOf(e) === UNKNOWN)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const durations = new Map();
  for (const t of computeTimeReport(evs, 0, {}).tasks) durations.set(t.sprint + SEP + t.task, t);

  const info = new Map(); // sprint\0task -> accumulated
  const get = (e) => {
    const k = sprintOf(e) + SEP + e.task;
    if (!info.has(k)) info.set(k, { sprint: sprintOf(e), task: e.task, accepted: false, model: null, kind: null, tokens: null, dispatches: 0, maxAttempt: 0 });
    return info.get(k);
  };
  for (const e of evs) {
    if (typeof e.task !== "string" || !e.task) continue;
    if (e.type === "worker_queue_claimed" || e.type === "worker_queue_completed") {
      const t = get(e);
      t.kind = str(e.kind) ?? t.kind;
      if (e.type === "worker_queue_completed") t.accepted = true;
    } else if (e.type === "task_dispatch_returned") {
      const t = get(e);
      t.dispatches++;
      t.maxAttempt = Math.max(t.maxAttempt, Number(e.attempt) || 0);
      if (e.status === "complete") {
        t.accepted = true;
        t.model = str(e.model) ?? t.model;
        t.kind = str(e.kind) ?? t.kind;
        const tk = tokenOf(e.tokens);
        if (tk != null) t.tokens = (t.tokens ?? 0) + tk;
      }
    }
  }

  const fileKinds = opts.taskKinds ?? loadTaskKinds(opts.dataDir);
  const tasks = [];
  for (const t of info.values()) {
    if (!t.accepted) continue;
    const fileKind = fileKinds.get(t.task) ?? null;
    const d = durations.get(t.sprint + SEP + t.task);
    tasks.push({
      sprint: t.sprint,
      task: t.task,
      tier: t.model ?? UNKNOWN,
      kind: fileKind ?? t.kind ?? UNKNOWN,
      tokens: t.tokens,
      attempts: Math.max(t.maxAttempt, d?.attempts ?? 0, t.dispatches, 1),
      durationMs: d ? d.reworkMs : null,
    });
  }
  const groups = new Map();
  for (const t of tasks) {
    const k = t.tier + SEP + t.kind;
    const g = groups.get(k) ?? { tier: t.tier, kind: t.kind, tasks: 0, tokens: null, tokenTasks: 0, attempts: 0, durationMs: 0, durationTasks: 0, noTokAttempts: 0, noTokDurationMs: 0, noTokDurationTasks: 0 };
    g.tasks++;
    if (t.tokens != null) { g.tokens = (g.tokens ?? 0) + t.tokens; g.tokenTasks++; }
    else {
      g.noTokAttempts += t.attempts;
      if (t.durationMs != null) { g.noTokDurationMs += t.durationMs; g.noTokDurationTasks++; }
    }
    g.attempts += t.attempts;
    if (t.durationMs != null) { g.durationMs += t.durationMs; g.durationTasks++; }
    groups.set(k, g);
  }
  const sorted = [...groups.values()].sort((a, b) => a.tier.localeCompare(b.tier) || a.kind.localeCompare(b.kind));
  const coverage = {
    accepted: tasks.length,
    withTier: tasks.filter((t) => t.tier !== UNKNOWN).length,
    withKind: tasks.filter((t) => t.kind !== UNKNOWN).length,
    withTokens: tasks.filter((t) => t.tokens != null).length,
    corrupt,
  };
  return { tasks, groups: sorted, coverage };
}

export function renderCostReport(r, scope = null) {
  const L = ["# Cost report", ""];
  if (scope) L.push(`Scope: ${scope}`, "");
  L.push("Per accepted task, grouped by tier (model) and task kind (kind source: task file frontmatter, else event/queue kind, else unknown)");
  if (r.groups.length === 0) L.push("  (none)");
  for (const g of r.groups) {
    const head = `  tier=${g.tier}  kind=${g.kind}  tasks=${g.tasks}`;
    const proxy = (a, ms, n) => `attempts=${a}, duration=${n ? min(ms) + "m" : "n/a"}`;
    if (g.tokens != null && g.tokenTasks < g.tasks) {
      L.push(`${head}  tokens=${g.tokens} (${g.tokenTasks}/${g.tasks} tasks have tokens)  tokenless tasks, not recorded (proxy: ${proxy(g.noTokAttempts, g.noTokDurationMs, g.noTokDurationTasks)})`);
    } else if (g.tokens != null) L.push(`${head}  tokens=${g.tokens}`);
    else L.push(`${head}  tokens=not recorded (proxy: attempts=${g.attempts}, duration=${g.durationTasks ? min(g.durationMs) + "m" : "n/a"})`);
  }
  const c = r.coverage;
  L.push(
    "",
    `Data coverage: ${c.withTier}/${c.accepted} accepted tasks have tier; ${c.withKind}/${c.accepted} have kind; ` +
      `${c.withTokens}/${c.accepted} have tokens; ${c.corrupt} corrupt log line${c.corrupt === 1 ? "" : "s"} skipped`,
  );
  return L.join("\n") + "\n";
}


/** `report cost [--sprint <id> | --all]`; default = current sprint, else all. */
export function reportMain(dataDir, args = []) {
  const { events, corrupt } = readEvents(dataDir);
  const si = args.indexOf("--sprint");
  let sprint = null;
  if (si >= 0 && args[si + 1]) sprint = args[si + 1];
  else if (!args.includes("--all")) sprint = currentSprintId(dataDir);
  const scope = sprint ? `sprint ${sprint} (plus events with no sprint field)` : "all sprints";
  process.stdout.write(renderCostReport(computeCostReport(events, corrupt, { sprint, dataDir }), scope));
}
