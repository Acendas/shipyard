/**
 * `shipyard-data agents <spawned|stopped|live|check>` — the agent ledger (v4.5).
 *
 * Why: finished builders and reviewers used to linger until the owner asked
 * what they were and killed them. The rule is "stop an agent the moment its
 * return is accepted, unless it is being given more work" — and a rule that
 * lives only in prose is not enforced, so the ledger is event-derived and the
 * terminal gate reads it: a pipeline cannot reach a terminal while any agent
 * it spawned is still unaccounted for.
 *
 * Live set (pure over the event log, since the last `pipeline_terminal`):
 *   + every name in an `agent_spawned` event
 *   + every `worker` of a `worker_queue_claimed` event (the queue's ground truth)
 *   − every name whose latest ledger event is `agent_stopped`
 *
 *   agents spawned <name> [<name> ...] [--step <id>] [--wave <n>] [--purpose "..."]
 *   agents stopped <name> [<name> ...] [--reason done|finished|reused|dead|never_started]
 *   agents stopped --all [--reason ...]          record every live agent as stopped (after TaskStop on each)
 *   agents live [--json]
 *   agents check                                  exit 3 when any agent is live
 */
import { logEvent } from "./_hook_lib.mjs";
import { readEvents, liveAgents } from "./terminal-gate.mjs";
import { readMaxAgents } from "./config-read.mjs";
export { liveAgents };

const REASONS = ["done", "finished", "reused", "dead", "never_started"];


function usage(msg) {
  process.stderr.write(
    `shipyard-data agents: ${msg}\n` +
      "  Usage: agents spawned <name> [<name> ...] [--step <id>] [--wave <n>] [--purpose \"...\"]\n" +
      "         agents stopped <name> [<name> ...] | --all  [--reason done|finished|reused|dead|never_started]\n" +
      "         agents live [--json]\n" +
      "         agents check\n",
  );
  process.exit(2);
}

export function main(dataDir, args = []) {
  const sub = args[0];
  const names = [];
  const o = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") o.json = true;
    else if (a === "--all") o.all = true;
    else if (a.startsWith("--")) { const v = args[++i]; if (v === undefined) usage(`${a} needs a value`); o[a.slice(2)] = v; }
    else names.push(a);
  }
  if (sub === "spawned") {
    if (!names.length) usage("spawned needs at least one agent name");
    for (const n of names) logEvent(dataDir, "agent_spawned", { agent: n, step: o.step ?? "", wave: o.wave ?? "", purpose: o.purpose ?? "" });
    process.stdout.write(`agents: recorded ${names.length} spawned (${names.join(", ")})\n`);
    return;
  }
  if (sub === "stopped") {
    const reason = o.reason ?? "done";
    if (!REASONS.includes(reason)) usage(`--reason must be one of ${REASONS.join("|")}`);
    const targets = o.all ? liveAgents(readEvents(dataDir)).map((a) => a.name) : names;
    if (!o.all && !targets.length) usage("stopped needs agent names or --all");
    for (const n of targets) logEvent(dataDir, "agent_stopped", { agent: n, reason });
    process.stdout.write(targets.length ? `agents: recorded ${targets.length} stopped (${targets.join(", ")})\n` : "agents: none live\n");
    return;
  }
  if (sub === "live" || sub === "check") {
    const live = liveAgents(readEvents(dataDir));
    if (o.json) process.stdout.write(JSON.stringify({ live, limit: readMaxAgents(dataDir) }) + "\n");
    else if (!live.length) process.stdout.write("agents: none live\n");
    else for (const a of live) process.stdout.write(`${a.name}${a.step ? ` (${a.step})` : ""}${a.wave ? ` wave ${a.wave}` : ""}${a.since ? ` since ${a.since}` : ""}\n`);
    if (sub === "check" && live.length) {
      process.stderr.write(`shipyard-data agents check: ${live.length} agent(s) still live: ${live.map((a) => a.name).join(", ")} — TaskStop each one that is finished, then \`shipyard-data agents stopped <name> ...\` (or \`--all\`)\n`);
      process.exit(3);
    }
    return;
  }
  usage(`unknown subcommand "${sub ?? ""}"`);
}
