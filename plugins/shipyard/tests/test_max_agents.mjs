/** v4.18 (owner): at most `execution.max_agents` agents alive at once (default 100), enforced at spawn. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMaxAgents, DEFAULT_MAX_AGENTS } from "../bin/config-read.mjs";
import { tooManyAgents } from "../bin/hooks/agent-ledger.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");
const HOOK = join(ROOT, "bin", "hook-runner.mjs");

function fixture(execution = "") {
  const base = mkdtempSync(join(tmpdir(), "maxagents-"));
  const d = join(base, "projects", "abc123abc123");
  mkdirSync(join(d, "sprints", "current"), { recursive: true });
  writeFileSync(join(d, ".project-root"), "/nonexistent\n");
  writeFileSync(join(d, "config.md"), `---\nconfig_version: 5\nexecution:\n${execution}  isolation: worktree\n---\n`);
  writeFileSync(join(d, ".active-execution.json"), JSON.stringify({ skill: "ship-execute", session_id: "s1", pid: process.pid, started: new Date().toISOString() }));
  return { base, d };
}
const spawned = (d, names) => writeFileSync(join(d, ".shipyard-events.jsonl"), names.map((n, i) => JSON.stringify({ ts: `2026-11-14T10:00:${String(i % 60).padStart(2, "0")}Z`, type: "agent_spawned", agent: n })).join("\n") + "\n", { flag: "a" });
const ask = (name, session = "s1") => ({ tool_name: "Agent", session_id: session, tool_input: { name, description: "x", subagent_type: "general-purpose", prompt: "p" } });

test("the default is 100, the new key wins, and the old key counts only when someone changed it from the template's 3", () => {
  const cases = [["", 100], ["  max_agents: 12\n", 12], ["  max_parallel_agents: 3\n", 100], ["  max_parallel_agents: 2\n", 2], ["  max_parallel_agents: 2\n  max_agents: 40\n", 40], ["  max_agents: 0\n", 100], ["  max_agents: many\n", 100]];
  assert.equal(DEFAULT_MAX_AGENTS, 100);
  for (const [cfg, want] of cases) {
    const { base, d } = fixture(cfg);
    try { assert.equal(readMaxAgents(d), want, JSON.stringify(cfg)); } finally { rmSync(base, { recursive: true, force: true }); }
  }
});

test("a spawn past the limit is refused with the count and the limit; under it, or outside a Shipyard command, it is not", () => {
  const { base, d } = fixture("  max_agents: 3\n");
  try {
    spawned(d, ["builder-P001", "builder-P002"]);
    assert.equal(tooManyAgents(d, ask("builder-P003")), null, "2 alive, limit 3: the third may start");
    spawned(d, ["builder-P003"]);
    const r = tooManyAgents(d, ask("spec-review-S001"));
    assert.deepEqual([r.live, r.cap], [3, 3]);
    assert.match(r.reason, /3 agents are already running in this project \(limit execution\.max_agents = 3\)/);
    assert.match(r.reason, /config set-max-agents/);
    assert.equal(tooManyAgents(d, ask("builder-P002")), null, "a name that is already alive replaces itself");
    assert.equal(tooManyAgents(d, { tool_name: "Agent", session_id: "s1", tool_input: { description: "no name" } }), null, "an unnamed helper is not in the ledger");
    assert.equal(tooManyAgents(d, ask("anything", "another-session")), null, "a session that holds no Shipyard lock is none of its business");
    // one stops: room again
    writeFileSync(join(d, ".shipyard-events.jsonl"), JSON.stringify({ ts: "2026-11-14T10:05:00Z", type: "agent_stopped", agent: "builder-P001" }) + "\n", { flag: "a" });
    assert.equal(tooManyAgents(d, ask("spec-review-S001")), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("with the default, the hundredth agent starts and the hundred-and-first is refused", () => {
  const { base, d } = fixture();
  try {
    spawned(d, Array.from({ length: 99 }, (_, i) => `helper-${i}`));
    assert.equal(tooManyAgents(d, ask("helper-99")), null);
    spawned(d, ["helper-99"]);
    assert.equal(tooManyAgents(d, ask("helper-100")).cap, 100);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the hook denies through the runner and logs the refusal; config set-max-agents writes one number", () => {
  const { base, d } = fixture("  max_parallel_agents: 3      # old template line\n");
  try {
    let r = spawnSync("node", [CLI, "config", "set-max-agents", "2", "--data-dir", d], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const cfg = readFileSync(join(d, "config.md"), "utf8");
    assert.match(cfg, /^ {2}max_agents: 2$/m); assert.doesNotMatch(cfg, /max_parallel_agents/);
    assert.equal(spawnSync("node", [CLI, "config", "set-max-agents", "0", "--data-dir", d], { encoding: "utf8" }).status, 2);
    spawned(d, ["a1", "a2"]);
    r = spawnSync("node", [HOOK, "agent-ledger"], { input: JSON.stringify({ hook_event_name: "PreToolUse", ...ask("a3") }), encoding: "utf8", env: { ...process.env, SHIPYARD_DATA: d } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /2 agents are already running/);
    const ev = readFileSync(join(d, ".shipyard-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(ev.filter((e) => e.type === "agent_spawn_refused").map((e) => [e.agent, e.live, e.cap]), [["a3", 2, 2]]);
    assert.equal(ev.filter((e) => e.type === "agent_spawned" && e.agent === "a3").length, 0, "a refused spawn is not recorded as started");
    assert.equal(JSON.parse(spawnSync("node", [CLI, "agents", "live", "--json", "--data-dir", d], { encoding: "utf8" }).stdout).limit, 2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
