/**
 * Tests for the v2.9.0 deterministic cursor CLI:
 *   bin/pipeline-stages.mjs  (stage graph)
 *   bin/cursor-cli.mjs       (advance / pause / escalate / noop)
 *   shipyard-data sprint set|check, task-return
 *
 * The CLI is exercised as a subprocess (it owns process.exit semantics:
 * 0 ok, 2 usage, 3 gate/validation refusal) against a throwaway git repo
 * with CLAUDE_PLUGIN_DATA pointed at a temp dir — same resolution path
 * production uses.
 *
 * Run: node --test tests/test_cursor_cli.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeStage, validateTransition, isTerminalStage } from "../bin/pipeline-stages.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(PLUGIN_ROOT, "bin", "shipyard-data.mjs");

// --- pipeline-stages unit tests -----------------------------------------

test("stage graph: normalizeStage extracts wave and iter", () => {
  const n = normalizeStage("ship-execute", "wave_3_tests_fix_iter_2");
  assert.equal(n.key, "wave_tests_fix_iter");
  assert.equal(n.wave, 3);
  assert.equal(n.iter, 2);
  assert.equal(n.terminal, false);
});

test("stage graph: terminal stages classified", () => {
  assert.ok(isTerminalStage("ship-execute", "terminal_handoff_to_review"));
  assert.ok(isTerminalStage("ship-execute", "terminal_hotfix"));
  assert.ok(isTerminalStage("ship-review", "terminal_issues"));
  assert.ok(!isTerminalStage("ship-review", "demo_user"));
});

test("stage graph: fresh start requires an entry stage", () => {
  assert.ok(validateTransition("ship-execute", null, "preflight").ok);
  assert.ok(validateTransition("ship-execute", null, "hotfix").ok);
  assert.ok(!validateTransition("ship-execute", null, "wave_1_dispatch").ok);
  assert.ok(validateTransition("ship-review", null, "preflight").ok);
  assert.ok(!validateTransition("ship-review", null, "verdict").ok);
});

test("stage graph: legal chain and illegal jump", () => {
  assert.ok(validateTransition("ship-execute", "preflight", "salvage").ok);
  assert.ok(validateTransition("ship-execute", "load", "wave_4_dispatch").ok, "resume into any wave from load");
  assert.ok(!validateTransition("ship-execute", "preflight", "sprint_full_build").ok);
  assert.ok(!validateTransition("ship-execute", "wave_1_dispatch", "wave_1_gate").ok, "cannot skip to gate");
});

test("stage graph: wave arithmetic — same wave inside, +1 only at the gate", () => {
  assert.ok(validateTransition("ship-execute", "wave_2_gate", "wave_3_dispatch").ok);
  assert.ok(!validateTransition("ship-execute", "wave_2_gate", "wave_4_dispatch").ok);
  assert.ok(!validateTransition("ship-execute", "wave_2_tests", "wave_3_verify").ok);
  assert.ok(validateTransition("ship-execute", "wave_2_tests", "wave_2_verify").ok);
});

test("stage graph: self-loops only where declared", () => {
  assert.ok(validateTransition("ship-execute", "wave_1_waiting", "wave_1_waiting").ok);
  assert.ok(validateTransition("ship-review", "code_review_iter_1", "code_review_iter_2").ok);
  assert.ok(validateTransition("ship-review", "gap_analysis", "gap_analysis").ok);
  assert.ok(!validateTransition("ship-execute", "wave_1_boundary", "wave_1_boundary").ok);
});

test("stage graph: review skip-flag routes from preflight", () => {
  assert.ok(validateTransition("ship-review", "preflight", "review_scan").ok);
  assert.ok(validateTransition("ship-review", "preflight", "code_review_iter_1").ok);
  assert.ok(validateTransition("ship-review", "preflight", "tests").ok, "--skip-code-review");
  assert.ok(validateTransition("ship-review", "preflight", "retro_step_1").ok, "--retro-only");
  assert.ok(validateTransition("ship-review", "process_approved", "retro_decision").ok);
  assert.ok(validateTransition("ship-review", "retro_decision", "retro_step_1").ok);
  assert.ok(validateTransition("ship-review", "retro_decision", "release_step_1").ok);
  assert.ok(validateTransition("ship-review", "process_approved", "release_step_1").ok, "--skip-retro");
});

test("stage graph: review batched scan and fix wave routes", () => {
  assert.ok(validateTransition("ship-review", "review_scan", "review_plan").ok);
  assert.ok(validateTransition("ship-review", "review_plan", "review_fix_wave_1").ok);
  assert.ok(validateTransition("ship-review", "review_plan", "review_validation").ok, "clean scanners skip fix waves");
  assert.ok(validateTransition("ship-review", "review_fix_wave_1", "review_fix_wave_2").ok);
  assert.ok(validateTransition("ship-review", "review_fix_wave_2", "review_validation").ok);
  assert.ok(validateTransition("ship-review", "review_validation", "simplify").ok);
  assert.ok(validateTransition("ship-review", "review_validation", "review_scan").ok, "failed validation re-scans before redispatch");
  assert.ok(!validateTransition("ship-review", "review_scan", "review_fix_wave_1").ok);
});

// --- CLI integration fixture --------------------------------------------

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), "cursor-cli-test-"));
  const repo = join(root, "repo");
  const data = join(root, "data");
  mkdirSync(repo, { recursive: true });
  mkdirSync(data, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  delete env.SHIPYARD_DATA;
  delete env.CLAUDE_PROJECT_DIR; // a host project dir would redirect git/anchor operations away from the temp repo
  // Deterministic session identity: the host's own id must not leak into tests.
  delete env.CLAUDE_CODE_SESSION_ID;
  const run = (args, opts = {}) => {
    try {
      const stdout = execFileSync("node", [CLI, ...args], {
        cwd: repo,
        env: opts.env ? { ...env, ...opts.env } : env,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      if (opts.expectFail === false) throw err;
      return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  };
  const initResult = run(["init"]);
  const dataDir = initResult.stdout.trim();
  // Fail HERE if init didn't actually work. Without this guard an empty stdout
  // leaves dataDir === "", and every later join(dataDir, "spec", ...) silently
  // degrades to a RELATIVE path — surfacing much later as a baffling
  // `ENOENT: spec/...` that looks like a product bug rather than a failed
  // fixture. That is the shape of the intermittent failure seen under
  // concurrent `node --test tests/*.mjs` runs.
  if (initResult.code !== 0 || !isAbsolute(dataDir)) {
    throw new Error(
      `fixture setup failed: shipyard-data init exited ${initResult.code}, ` +
        `stdout=${JSON.stringify(initResult.stdout)} stderr=${initResult.stderr}`,
    );
  }
  return { root, repo, dataDir, run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function seedSprint(p, { waves = "### Wave 1\nTasks: [T001]\n", status = "in-progress" } = {}) {
  p.run(["init-sprint", "sprint-001"]);
  const sprintPath = join(p.dataDir, "sprints", "current", "SPRINT.md");
  writeFileSync(
    sprintPath,
    `---\nid: sprint-001\nstatus: ${status}\nfeatures: [F001]\n---\n\n## Waves\n\n${waves}`,
  );
}

test("cursor CLI: fresh advance to preflight writes cursor + tick event + marker", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    const r = p.run(["cursor", "advance", "execute", "preflight", "sprint=sprint-001", "--note", "starting"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /▶ TICK COMPLETE/);
    const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /stage: preflight/);
    assert.match(cursor, /terminal: false/);
    assert.match(cursor, /starting/);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /pipeline_tick_completed/);
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: illegal transition exits 3; --force overrides graph only", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"]);
    const bad = p.run(["cursor", "advance", "execute", "wave_1_gate"]);
    assert.equal(bad.code, 3);
    assert.match(bad.stderr, /illegal stage transition/);
    const forced = p.run(["cursor", "advance", "execute", "wave_1_gate", "--force"]);
    assert.equal(forced.code, 0, "force skips the graph for crash recovery");
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: leaving wave_N_boundary is refused while the latest integration verdict is failed (IDEA-009)", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    for (const s of ["preflight", "salvage", "load", "wave_1_dispatch", "wave_1_boundary"]) {
      assert.equal(p.run(["cursor", "advance", "execute", s]).code, 0, s);
    }
    p.run(["events", "emit", "wave_integration_failed", "working_branch=main"]);
    const r = p.run(["cursor", "advance", "execute", "wave_1_build"]);
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /wave integration gate/);
    const forced = p.run(["cursor", "advance", "execute", "wave_1_build", "--force"]);
    assert.equal(forced.code, 3, "--force never bypasses an evidence gate");
    p.run(["events", "emit", "wave_integration_verified", "working_branch=main"]);
    const ok = p.run(["cursor", "advance", "execute", "wave_1_build"]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    // A failure from an EARLIER boundary never leaks into the next wave's boundary.
    for (const s of ["wave_1_refactor", "wave_1_tests", "wave_1_verify", "wave_1_gate", "wave_2_dispatch", "wave_2_boundary"]) {
      assert.equal(p.run(["cursor", "advance", "execute", s]).code, 0, s);
    }
    assert.equal(p.run(["cursor", "advance", "execute", "wave_2_build"]).code, 0, "no verdict in this window = not refused");
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: terminal advance without evidence is refused even with --force", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"]);
    const r = p.run(["cursor", "advance", "execute", "terminal_handoff_to_review", "--force"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /terminal-evidence gate/);
    assert.match(r.stderr, /wave_1_gate|sprint_complete_passed/);
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: terminal advance with complete evidence succeeds; stop marker is the FINAL line after NEXT-UP", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"]);
    // Drive to the terminal's legal predecessor and lay down the evidence.
    for (const s of ["salvage", "load", "wave_1_dispatch", "wave_1_waiting", "wave_1_recovery", "wave_1_boundary", "wave_1_build", "wave_1_refactor", "wave_1_tests", "wave_1_verify", "wave_1_gate", "sprint_full_build", "sprint_full_tests", "sprint_demo_probes", "sprint_complete_gate"]) {
      p.run(["cursor", "advance", "execute", s], { expectFail: false });
    }
    p.run(["events", "emit", "task_dispatch_returned", "pipeline=ship-execute", "task=T001", "status=complete", "commit_sha=abc1234"]);
    p.run(["events", "emit", "sprint_complete_passed", "sprint=sprint-001"]);
    p.run(["story-review", "record", "F001", "--verdict", "approve", "--code", "CLEAN"], { expectFail: false }); // F028
    const r = p.run(["cursor", "advance", "execute", "terminal_handoff_to_review", "reason=sprint_complete"], { expectFail: false });
    const lines = r.stdout.trim().split("\n");
    const last = lines[lines.length - 1];
    assert.match(last, /\/goal should stop\./, "stop marker must be the FINAL line");
    const nextUpIdx = lines.findIndex((l) => /NEXT UP: \/ship-review/.test(l));
    assert.ok(nextUpIdx >= 0 && nextUpIdx < lines.length - 1, "NEXT-UP hint prints BEFORE the stop marker");
    const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /terminal: true/);
    assert.match(cursor, /status: complete/);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /"pipeline_terminal"/);
    // PROGRESS.md re-rendered in-process (no PostToolUse hook involved).
    const progress = readFileSync(join(p.dataDir, "sprints", "current", "PROGRESS.md"), "utf8");
    assert.match(progress, /current_wave: complete/);
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: advance on an already-terminal cursor is refused", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"]);
    p.run(["cursor", "escalate", "execute", "reason=test"], { expectFail: false });
    const r = p.run(["cursor", "advance", "execute", "salvage"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /already terminal/);
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: stale-cycle guard — non-terminal advance against completed sprint exits 3", () => {
  const p = makeProject();
  try {
    seedSprint(p, { status: "completed" });
    const r = p.run(["cursor", "advance", "execute", "preflight"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /stale-cycle guard/);
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: escalate bypasses evidence gate, emits outcome=escalated, stop marker last", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"]);
    const r = p.run(["cursor", "escalate", "execute", "reason=hard_ceiling_stage_preflight"], { expectFail: false });
    const lines = r.stdout.trim().split("\n");
    assert.match(lines[lines.length - 1], /\/goal should stop\./);
    const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /status: escalated/);
    assert.match(cursor, /terminal: true/);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /"outcome":"escalated"/);
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: pause keeps stage, sets paused, removes HANDOFF.md, note becomes body", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"]);
    writeFileSync(join(p.dataDir, "sprints", "current", "HANDOFF.md"), "legacy");
    const r = p.run(["cursor", "pause", "execute", "--note", "resume at preflight, waiting on creds"], { expectFail: false });
    assert.match(r.stdout, /\/goal should stop\./);
    const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /status: paused/);
    assert.match(cursor, /stage: preflight/);
    assert.match(cursor, /waiting on creds/);
    assert.ok(!existsSync(join(p.dataDir, "sprints", "current", "HANDOFF.md")), "HANDOFF.md consumed");
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: pending_subagents JSON round-trips and carries forward", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"]);
    p.run(["cursor", "advance", "execute", "salvage"], { expectFail: false });
    p.run(["cursor", "advance", "execute", "load"], { expectFail: false });
    p.run([
      "cursor", "advance", "execute", "wave_1_dispatch",
      'pending_subagents=[{"task_id":"T001","spawned_at":"2026-01-01T00:00:00Z","max_execution_minutes":60}]',
    ], { expectFail: false });
    // Self-loop into waiting WITHOUT re-passing the list: it must carry forward.
    p.run(["cursor", "advance", "execute", "wave_1_waiting"], { expectFail: false });
    let cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /pending_subagents:/);
    assert.match(cursor, /task_id: T001/);
    // Drain: explicit empty array clears it.
    p.run(["cursor", "advance", "execute", "wave_1_waiting", "pending_subagents=[]"], { expectFail: false });
    cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.ok(!cursor.includes("pending_subagents:"), "drained list is removed");
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: session_started_at is set on preflight, survives advances, refreshed on resume, not settable", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    const cpath = join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md");
    const field = () => (readFileSync(cpath, "utf8").match(/^session_started_at: (.+)$/m) ?? [])[1];
    p.run(["cursor", "advance", "execute", "preflight"]);
    const first = field();
    assert.ok(first && !Number.isNaN(Date.parse(first.replace(/"/g, ""))), "set on preflight");
    p.run(["cursor", "advance", "execute", "salvage"], { expectFail: false });
    p.run(["cursor", "advance", "execute", "load"], { expectFail: false });
    p.run(["cursor", "advance", "execute", "wave_1_dispatch"], { expectFail: false });
    assert.equal(field(), first, "unchanged across advances");
    const r = p.run(["cursor", "set", "execute", "session_started_at=x"]);
    assert.notEqual(r.code, 0, "cursor set refuses session_started_at");
    assert.equal(field(), first);
    // Resume refreshes it.
    p.run(["cursor", "pause", "execute", "--note", "pause for test"]);
    writeFileSync(cpath, readFileSync(cpath, "utf8").replace(/^session_started_at: .+\n/m, ""));
    assert.equal(field(), undefined, "absent field tolerated");
    const rr = p.run(["cursor", "resume", "execute"]);
    assert.equal(rr.code, 0, rr.stderr);
    assert.ok(field(), "set on resume");
  } finally {
    p.cleanup();
  }
});

function budgetSetup(p, { max = 1, ageMinutes = 120 } = {}) {
  seedSprint(p);
  writeFileSync(join(p.dataDir, "config.md"), `---\nexecution:\n  max_session_minutes: ${max}\n---\n`);
  const cpath = join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md");
  p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
  p.run(["cursor", "advance", "execute", "salvage"], { expectFail: false });
  p.run(["cursor", "advance", "execute", "load"], { expectFail: false });
  const old = new Date(Date.now() - ageMinutes * 60000).toISOString();
  writeFileSync(cpath, readFileSync(cpath, "utf8").replace(/^session_started_at: .+$/m, `session_started_at: "${old}"`));
  const events = () => readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
  return { cpath, events };
}

test("session_budget: exceeded budget pauses before wave_N_dispatch with exit 0, even with --force", () => {
  for (const extra of [[], ["--force"]]) {
    const p = makeProject();
    try {
      const { cpath, events } = budgetSetup(p);
      const r = p.run(["cursor", "advance", "execute", "wave_1_dispatch", ...extra]);
      assert.equal(r.code, 0, r.stderr);
      const cursor = readFileSync(cpath, "utf8");
      assert.match(cursor, /stage: load/, "paused at the prior stage, advance not performed");
      assert.match(cursor, /status: paused/);
      const ev = events().split("\n").filter((l) => l.includes("session_budget_reached"));
      assert.equal(ev.length, 1);
      const e = JSON.parse(ev[0]);
      assert.equal(e.max, 1);
      assert.ok(e.elapsed >= 119, `elapsed ${e.elapsed}`);
      assert.equal(e.stage, "wave_1_dispatch");
      assert.match(events(), /pipeline_paused/);
      assert.ok(!/"next_stage":"wave_1_dispatch"/.test(events()), "no tick into the wave");
      assert.match(r.stdout, /cursor resume execute/, "resume hint");
      const lines = r.stdout.trimEnd().split("\n");
      assert.match(lines[lines.length - 1], /\/goal should stop\./, "stop marker is last");
    } finally {
      p.cleanup();
    }
  }
});

test("session_budget: forced recovery entry into a later wave is gated too", () => {
  const p = makeProject();
  try {
    const { cpath } = budgetSetup(p);
    const r = p.run(["cursor", "advance", "execute", "wave_3_dispatch", "--force"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(cpath, "utf8"), /status: paused/);
  } finally {
    p.cleanup();
  }
});

test("session_budget: off, within budget, and absent clock all proceed; no event", () => {
  const cases = [
    { max: 0, ageMinutes: 500 },
    { max: 240, ageMinutes: 30 },
  ];
  for (const c of cases) {
    const p = makeProject();
    try {
      const { cpath, events } = budgetSetup(p, c);
      const r = p.run(["cursor", "advance", "execute", "wave_1_dispatch"]);
      assert.equal(r.code, 0, r.stderr);
      assert.match(readFileSync(cpath, "utf8"), /stage: wave_1_dispatch/);
      assert.ok(!events().includes("session_budget_reached"));
    } finally {
      p.cleanup();
    }
  }
  const p = makeProject();
  try {
    const { cpath, events } = budgetSetup(p);
    writeFileSync(cpath, readFileSync(cpath, "utf8").replace(/^session_started_at: .+\n/m, ""));
    const r = p.run(["cursor", "advance", "execute", "wave_1_dispatch"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(cpath, "utf8"), /stage: wave_1_dispatch/);
    assert.ok(!events().includes("session_budget_reached"));
  } finally {
    p.cleanup();
  }
});

test("session_budget: mid-wave and sprint-level stages are never gated", () => {
  const p = makeProject();
  try {
    const { cpath, events } = budgetSetup(p, { max: 240, ageMinutes: 30 });
    p.run(["cursor", "advance", "execute", "wave_1_dispatch"], { expectFail: false });
    // Budget now exceeded.
    const old = new Date(Date.now() - 600 * 60000).toISOString();
    writeFileSync(cpath, readFileSync(cpath, "utf8").replace(/^session_started_at: .+$/m, `session_started_at: "${old}"`));
    writeFileSync(join(p.dataDir, "config.md"), `---\nexecution:\n  max_session_minutes: 1\n---\n`);
    for (const st of ["wave_1_waiting", "wave_1_recovery", "wave_1_boundary"]) {
      const r = p.run(["cursor", "advance", "execute", st], { expectFail: false });
      assert.equal(r.code, 0, r.stderr);
      assert.match(readFileSync(cpath, "utf8"), new RegExp(`stage: ${st}`));
    }
    // Sprint-level: forced entry (graph skipped) must not be budget-gated.
    const r = p.run(["cursor", "advance", "execute", "sprint_full_build", "--force"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(cpath, "utf8"), /stage: sprint_full_build/);
    assert.ok(!events().includes("session_budget_reached"));
    // Pausing and recording are never refused.
    const pz = p.run(["cursor", "pause", "execute", "--note", "x"]);
    assert.equal(pz.code, 0, pz.stderr);
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: noop emits terminal event first; repeat noop is detected", () => {
  const p = makeProject();
  try {
    // No sprint at all — the archived case.
    const r1 = p.run(["cursor", "noop", "review", "sprint=sprint-001"], { expectFail: false });
    assert.match(r1.stdout, /\/goal should stop\./);
    const r2 = p.run(["cursor", "noop", "review", "sprint=sprint-001"], { expectFail: false });
    assert.match(r2.stdout, /⛔ REPEATED NOOP/);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    const noops = events.split("\n").filter((l) => l.includes('"outcome":"noop"')).length;
    assert.equal(noops, 2, "every noop is emitted — a silent no-op is the v2.8.2 invisibility bug");
    assert.match(events, /pipeline_repeated_noop_detected/);
  } finally {
    p.cleanup();
  }
});

// --- sprint set / sprint check / task-return -----------------------------

test("sprint set: mutates only the frontmatter key; unknown keys refused", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    const r = p.run(["sprint", "set", "status", "completed"], { expectFail: false });
    assert.equal(r.code, 0);
    const sprint = readFileSync(join(p.dataDir, "sprints", "current", "SPRINT.md"), "utf8");
    assert.match(sprint, /^status: completed$/m);
    assert.match(sprint, /### Wave 1/, "body untouched");
    const bad = p.run(["sprint", "set", "waves", "nope"]);
    assert.equal(bad.code, 2);
    // A key not present yet is appended inside the frontmatter block.
    p.run(["sprint", "set", "completed_at", "2026-07-20T00:00:00Z"], { expectFail: false });
    const sprint2 = readFileSync(join(p.dataDir, "sprints", "current", "SPRINT.md"), "utf8");
    const fmEnd = sprint2.indexOf("---", 4);
    assert.ok(sprint2.indexOf("completed_at:") < fmEnd, "new key lands inside frontmatter");
  } finally {
    p.cleanup();
  }
});

test("sprint check: passes on parseable waves, exit 3 on empty/missing", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    const ok = p.run(["sprint", "check"], { expectFail: false });
    assert.match(ok.stdout, /1 wave\(s\), 1 task\(s\)/);
    seedSprintBroken(p);
    const bad = p.run(["sprint", "check"]);
    assert.equal(bad.code, 3);
    assert.match(bad.stderr, /ZERO task IDs/);
  } finally {
    p.cleanup();
  }

  function seedSprintBroken(proj) {
    writeFileSync(
      join(proj.dataDir, "sprints", "current", "SPRINT.md"),
      `---\nid: sprint-001\nstatus: in-progress\n---\n\n## Waves\n\n### Wave 1\n(no tasks listed)\n`,
    );
  }
});

test("task-return: writes JSON record; refuses COMPLETE with failing probe", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.repo, encoding: "utf8" }).trim();
    const ok = p.run(["task-return", "T001", "status=COMPLETE", `commit=${sha}`, "probe-exit=0"], { expectFail: false });
    assert.equal(ok.code, 0);
    const rec = JSON.parse(readFileSync(join(p.dataDir, "sprints", "current", ".subagent-returns", "T001.json"), "utf8"));
    assert.equal(rec.status, "COMPLETE");
    assert.equal(rec.commit_sha, sha);
    assert.equal(rec.probe_exit_code, 0);

    const bad = p.run(["task-return", "T002", "status=COMPLETE", `commit=${sha}`, "probe-exit=1"]);
    assert.equal(bad.code, 3, "COMPLETE + failing probe is the false-completion class");

    const blocked = p.run(["task-return", "T003", "status=BLOCKED", "escalation-code=missing_dep"], { expectFail: false });
    assert.equal(blocked.code, 0, "BLOCKED needs no sha/probe");
  } finally {
    p.cleanup();
  }
});

test("task accept-return: anchors commit, emits return event, and marks task done", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    mkdirSync(join(p.dataDir, "spec", "tasks"), { recursive: true });
    writeFileSync(
      join(p.dataDir, "spec", "tasks", "T001-build-thing.md"),
      `---\nid: T001\nfeature: F001\nstatus: in-progress\n---\n\n# Build thing\n`,
    );
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.repo, encoding: "utf8" }).trim();
    const r = p.run(
      ["task", "accept-return", "T001", "sprint=sprint-001", "wave=1", `commit=${sha}`, "--data-dir", p.dataDir],
      { expectFail: false },
    );
    assert.equal(r.code, 0);
    execFileSync("git", ["cat-file", "-e", `shipyard/keep-T001^{commit}`], { cwd: p.repo });

    const task = readFileSync(join(p.dataDir, "spec", "tasks", "T001-build-thing.md"), "utf8");
    assert.match(task, /^status: done$/m);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /"type":"task_commit_anchored"/);
    assert.match(events, /"type":"task_dispatch_returned"/);
    assert.match(events, /"task":"T001"/);
    assert.match(events, /"commit_sha":/);
  } finally {
    p.cleanup();
  }
});

test("task accept-operational: emits evidence events and marks task done", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    mkdirSync(join(p.dataDir, "spec", "tasks"), { recursive: true });
    writeFileSync(
      join(p.dataDir, "spec", "tasks", "T002-operational.md"),
      `---\nid: T002\nfeature: F001\nstatus: in-progress\n---\n\n# Fix operational task\n`,
    );
    mkdirSync(join(p.dataDir, "captures"), { recursive: true });
    const capture = join(p.dataDir, "captures", "T002.txt");
    writeFileSync(capture, "all green\n");
    const r = p.run(
      [
        "task",
        "accept-operational",
        "T002",
        "sprint=sprint-001",
        "wave=1",
        `capture=${capture}`,
        "iterations=2",
        "--data-dir",
        p.dataDir,
      ],
      { expectFail: false },
    );
    assert.equal(r.code, 0);

    const task = readFileSync(join(p.dataDir, "spec", "tasks", "T002-operational.md"), "utf8");
    assert.match(task, /^status: done$/m);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /"type":"operational_task_completed"/);
    assert.match(events, /"capture":/);
    assert.match(events, /"iterations_run":2/);
    assert.match(events, /"type":"task_dispatch_returned"/);
    assert.match(events, /"kind":"operational"/);
    assert.match(events, /"commit_sha":/);
  } finally {
    p.cleanup();
  }
});

test("draft commands mutate checkpoint frontmatter through CLI", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    mkdirSync(join(p.dataDir, "spec"), { recursive: true });
    writeFileSync(
      join(p.dataDir, "spec", ".research-draft.md"),
      `---\ntopic: checkout rewrite\nobsolete: false\n---\n\n## Research Findings\n`,
    );
    writeFileSync(
      join(p.dataDir, "sprints", "current", "SPRINT-DRAFT.md"),
      `---\nid: sprint-001\nstatus: draft\n---\n\n# Draft\n`,
    );

    const research = p.run(
      ["draft", "obsolete-research", "--topic", "checkout rewrite", "--data-dir", p.dataDir],
      { expectFail: false },
    );
    assert.equal(research.code, 0);
    const researchDraft = readFileSync(join(p.dataDir, "spec", ".research-draft.md"), "utf8");
    assert.match(researchDraft, /^obsolete: true$/m);
    assert.match(researchDraft, /## Research Findings/);

    const sprint = p.run(
      ["draft", "set-sprint-status", "superseded", "--data-dir", p.dataDir],
      { expectFail: false },
    );
    assert.equal(sprint.code, 0);
    const sprintDraft = readFileSync(join(p.dataDir, "sprints", "current", "SPRINT-DRAFT.md"), "utf8");
    assert.match(sprintDraft, /^status: superseded$/m);
    assert.match(sprintDraft, /# Draft/);
  } finally {
    p.cleanup();
  }
});

test("task-return: verify-wave-integrated reads the JSON returns (Check B)", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.repo, encoding: "utf8" }).trim();
    p.run(["task-return", "T001", "status=COMPLETE", `commit=${sha}`, "probe-exit=0"], { expectFail: false });
    const r = p.run(["verify-wave-integrated"], { expectFail: false });
    assert.match(r.stdout, /1 return commit\(s\) reachable/);
  } finally {
    p.cleanup();
  }
});

// --- v3.1.0 CLI absorption ------------------------------------------------

test("cursor set: field-only update — no transition, no tick event", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
    const before = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8").split("\n").length;
    const r = p.run(["cursor", "set", "execute", "next_action=continue"], { expectFail: false });
    assert.equal(r.code, 0);
    const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /next_action: continue/);
    assert.match(cursor, /stage: preflight/, "stage unchanged");
    const after = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8").split("\n").length;
    assert.equal(after, before, "field set emits no pipeline events");
  } finally {
    p.cleanup();
  }
});

test("cursor resume: escalated cursor becomes in_progress at the same stage; advance works again", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
    p.run(["cursor", "escalate", "execute", "reason=wave_gate_failed"], { expectFail: false });
    // noop on an escalated cursor must NOT claim the sprint complete or arm the leak alarm
    const noop = p.run(["cursor", "noop", "execute"], { expectFail: false });
    assert.match(noop.stdout, /ESCALATED at stage preflight/);
    assert.match(noop.stdout, /NOT complete/);
    const r = p.run(["cursor", "resume", "execute"], { expectFail: false });
    assert.match(r.stdout, /resumed at stage preflight/);
    const adv = p.run(["cursor", "advance", "execute", "salvage"], { expectFail: false });
    assert.equal(adv.code, 0, "post-resume advance follows the normal graph");
    // resume refuses a complete terminal
    const bad = p.run(["cursor", "resume", "execute"]);
    assert.equal(bad.code, 3, "resume only applies to escalated/paused");
  } finally {
    p.cleanup();
  }
});

// --- F4: cursor `sprint` backfills from SPRINT.md's own id ---------------

test("F4: sprint id backfills from SPRINT.md when the advance carries none, and is persisted", () => {
  const p = makeProject();
  try {
    seedSprint(p); // SPRINT.md has id: sprint-001
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false }); // no sprint= passed
    const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /^sprint: sprint-001$/m, "backfilled from SPRINT.md id and persisted on the cursor");
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.ok(!events.includes('"sprint":"unknown"'), "events for this tick are no longer tagged unknown");
  } finally {
    p.cleanup();
  }
});

test("F4: sprint id is never fabricated when SPRINT.md is absent or unreadable", () => {
  const p = makeProject();
  try {
    // No SPRINT.md at all — use `hotfix`, the one entry stage exempt from
    // the stale-cycle guard's sprint-presence requirement.
    p.run(["cursor", "advance", "execute", "hotfix"], { expectFail: false });
    let cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.ok(!/^sprint: /m.test(cursor), "no sprint field fabricated when SPRINT.md is absent");
  } finally {
    p.cleanup();
  }
});

test("F4: sprint id is never fabricated when SPRINT.md exists but is unreadable as text", () => {
  const p = makeProject();
  try {
    // A directory at the SPRINT.md path: existsSync is true, readFileSync throws.
    mkdirSync(join(p.dataDir, "sprints", "current", "SPRINT.md"), { recursive: true });
    p.run(["cursor", "advance", "execute", "hotfix"], { expectFail: false });
    const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.ok(!/^sprint: /m.test(cursor), "no sprint field fabricated when SPRINT.md can't be read");
  } finally {
    p.cleanup();
  }
});

// --- F5: pending_subagents resets on a wave_N_dispatch advance -----------

test("F5: an advance INTO wave_N_dispatch replaces pending_subagents rather than inheriting a prior wave's leftovers", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
    p.run(["cursor", "advance", "execute", "salvage"], { expectFail: false });
    p.run(["cursor", "advance", "execute", "load"], { expectFail: false });
    p.run(
      [
        "cursor", "advance", "execute", "wave_1_dispatch",
        'pending_subagents=[{"task_id":"T-STALE","spawned_at":"2020-01-01T00:00:00Z","max_execution_minutes":60}]',
      ],
      { expectFail: false },
    );
    let cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /T-STALE/, "seeded stale entry present");

    // Force-jump straight to a later wave's dispatch stage WITHOUT
    // re-passing pending_subagents — simulates the customer's wave_8_dispatch
    // cursor still carrying wave-5 entries hours past their budget.
    p.run(["cursor", "advance", "execute", "wave_2_dispatch", "--force"], { expectFail: false });
    cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.ok(!cursor.includes("pending_subagents:"), "dispatch-stage advance clears stale entries by default");
    assert.ok(!cursor.includes("T-STALE"));
  } finally {
    p.cleanup();
  }
});

test("F5: a wave_N_waiting self-loop still carries pending_subagents forward unchanged (not a dispatch stage)", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
    p.run(["cursor", "advance", "execute", "salvage"], { expectFail: false });
    p.run(["cursor", "advance", "execute", "load"], { expectFail: false });
    p.run(
      [
        "cursor", "advance", "execute", "wave_1_dispatch",
        'pending_subagents=[{"task_id":"T001","spawned_at":"2026-01-01T00:00:00Z","max_execution_minutes":60}]',
      ],
      { expectFail: false },
    );
    p.run(["cursor", "advance", "execute", "wave_1_waiting"], { expectFail: false });
    // Self-loop again WITHOUT re-passing the list.
    p.run(["cursor", "advance", "execute", "wave_1_waiting"], { expectFail: false });
    const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /task_id: T001/, "waiting self-loop carries the list forward, unlike a dispatch advance");
  } finally {
    p.cleanup();
  }
});

test("non-terminal advance prints the goal continuation marker", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
    const r = p.run(["cursor", "advance", "execute", "salvage"], { expectFail: false });
    assert.match(r.stdout.trim().split("\n").pop(), /\/goal continues\./);
  } finally {
    p.cleanup();
  }
});

test("stuck_counter: auto-increments on iter self-loops, exempt on wave_waiting, refuses at ceiling", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    for (const s of ["preflight", "salvage", "load", "wave_1_dispatch", "wave_1_waiting"]) {
      p.run(["cursor", "advance", "execute", s], { expectFail: false });
    }
    p.run(["cursor", "advance", "execute", "wave_1_waiting"], { expectFail: false });
    let cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /stuck_counter: 0/, "poll stage exempt from auto-increment");
    // iter-family self-loop auto-increments and the ceiling refuses
    p.run(["cursor", "advance", "execute", "wave_1_recovery"], { expectFail: false });
    p.run(["cursor", "advance", "execute", "wave_1_redispatch_iter_1", "hard_ceiling=3"], { expectFail: false });
    p.run(["cursor", "advance", "execute", "wave_1_redispatch_iter_1"], { expectFail: false }); // stuck 1
    p.run(["cursor", "advance", "execute", "wave_1_redispatch_iter_1"], { expectFail: false }); // stuck 2
    const refused = p.run(["cursor", "advance", "execute", "wave_1_redispatch_iter_1"]); // stuck 3 = ceiling
    assert.equal(refused.code, 3);
    assert.match(refused.stderr, /hard ceiling/);
    assert.match(refused.stderr, /cursor escalate/);
  } finally {
    p.cleanup();
  }
});

test("terminal advance clears the execute advisory lock", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    writeFileSync(join(p.dataDir, ".active-execution.json"), '{"skill":"ship-execute","started":"x"}');
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
    p.run(["cursor", "escalate", "execute", "reason=test"], { expectFail: false });
    const lock = JSON.parse(readFileSync(join(p.dataDir, ".active-execution.json"), "utf8"));
    assert.equal(lock.skill, null, "escalate clears the lock (soft-delete sentinel)");
    assert.ok(lock.cleared);
  } finally {
    p.cleanup();
  }
});

test("resting-path lock clear routes through skill-lock.mjs (force ignores depth, exact 2-key sentinel shape)", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    // `depth` is a skill-lock.mjs-only concept — the pre-v3.7.0 inline
    // writer in cursor-cli.mjs had no notion of it and always overwrote
    // unconditionally. Seed a depth:3 held lock: only if the resting-path
    // clear now genuinely calls skill-lock.mjs's releaseLock(...,
    // {force:true}) will a depth>1 lock still be FULLY released (force
    // skips the decrement-only path); the old code would have "worked" by
    // accident (blind overwrite), but this pins the new call, not the old
    // coincidence.
    writeFileSync(
      join(p.dataDir, ".active-execution.json"),
      JSON.stringify({ skill: "ship-execute", sprint: "sprint-001", wave: 1, started: new Date().toISOString(), session_id: "sess-x", cleared: null, depth: 3 }),
    );
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
    p.run(["cursor", "escalate", "execute", "reason=test"], { expectFail: false });
    const lock = JSON.parse(readFileSync(join(p.dataDir, ".active-execution.json"), "utf8"));
    assert.deepEqual(Object.keys(lock).sort(), ["cleared", "skill"], "sentinel shape is exactly {skill, cleared} — skill-lock.mjs's writeLockObj shape");
    assert.equal(lock.skill, null, "force fully releases even a depth:3 lock, not a decrement");
  } finally {
    p.cleanup();
  }
});

test("advance emits pipeline_tick_started for the new stage (CLI-owned, no model ritual)", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /"pipeline_tick_started"/);
  } finally {
    p.cleanup();
  }
});

test("sprint check: placeholder tokens (TBD) are not parsed as task IDs", () => {
  const p = makeProject();
  try {
    seedSprint(p, { waves: "### Wave 1\nTasks: [T001, TBD, T-P002]\n" });
    const r = p.run(["sprint", "check"], { expectFail: false });
    assert.match(r.stdout, /W1\[T001,T-P002\]/, "TBD excluded, patch-task id kept");
  } finally {
    p.cleanup();
  }
});

test("config set-model: flips think tier opus <-> fable atomically, preserves the rest", () => {
  const p = makeProject();
  try {
    writeFileSync(
      join(p.dataDir, "config.md"),
      `---\nconfig_version: 4\nproject_name: "x"\nmodels:\n  think: opus  # comment kept\n  build: sonnet\n  orchestrate: opus\nescalation:\n  enabled: true\n---\n\n# Project Configuration\n`,
    );
    let r = p.run(["config", "set-model", "think", "fable"], { expectFail: false });
    assert.match(r.stdout, /models\.think: fable/);
    let cfg = readFileSync(join(p.dataDir, "config.md"), "utf8");
    assert.match(cfg, /^  think: fable\s*# comment kept$/m, "value flipped, trailing comment preserved");
    assert.match(cfg, /^  build: sonnet$/m, "sibling keys untouched");
    assert.match(cfg, /enabled: true/, "other blocks untouched");
    r = p.run(["config", "set-model", "think", "opus"], { expectFail: false });
    cfg = readFileSync(join(p.dataDir, "config.md"), "utf8");
    assert.match(cfg, /^  think: opus\s*# comment kept$/m, "flipped back");
    p.run(["config", "set-model", "build", "inherit"], { expectFail: false });
    cfg = readFileSync(join(p.dataDir, "config.md"), "utf8");
    assert.match(cfg, /^  build: ""$/m);
    for (const bad of ["claude-opus-4-8", "claude-sonnet-5"]) {
      const rej = p.run(["config", "set-model", "think", bad]);
      assert.equal(rej.code, 2, `${bad} rejected`);
      assert.match(rej.stderr, /think\|build\|light\|orchestrate/);
      assert.match(rej.stderr, /fable\|opus\|sonnet\|haiku\|inherit/);
      assert.doesNotMatch(rej.stderr, /claude-\*/);
    }
    cfg = readFileSync(join(p.dataDir, "config.md"), "utf8");
    assert.match(cfg, /^  think: opus\s*# comment kept$/m, "rejected value never written");
    assert.equal(p.run(["config", "set-model", "think", "gpt5"]).code, 2);
    assert.equal(p.run(["config", "set-model", "think", "anthropic.claude-opus-5"]).code, 2);
    assert.equal(p.run(["config", "set-model", "reviewer", "opus"]).code, 2);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /config_model_set/);
  } finally {
    p.cleanup();
  }
});

test("config set-model: orchestrate syncs command skill frontmatter (hermetic copy) and rejects claude-* ids", () => {
  const p = makeProject();
  const skillNames = ["ship-execute", "ship-review", "ship-sprint", "ship-discuss"];
  // Operate on a COPY of the four SKILL.md files so a killed run can never
  // leave stray `model:` lines in the real plugin tree.
  const fakeRoot = mkdtempSync(join(tmpdir(), "cursor-cli-pluginroot-"));
  const skillPaths = skillNames.map((name) => join(fakeRoot, "skills", name, "SKILL.md"));
  for (const name of skillNames) {
    mkdirSync(join(fakeRoot, "skills", name), { recursive: true });
    copyFileSync(join(PLUGIN_ROOT, "skills", name, "SKILL.md"), join(fakeRoot, "skills", name, "SKILL.md"));
  }
  const env = { SHIPYARD_PLUGIN_ROOT: fakeRoot };
  try {
    writeFileSync(
      join(p.dataDir, "config.md"),
      `---\nconfig_version: 4\nproject_name: "x"\nmodels:\n  think: opus\n  build: sonnet\n  orchestrate: opus\n---\n\n# Project Configuration\n`,
    );

    const r = p.run(["config", "set-model", "orchestrate", "sonnet"], { expectFail: false, env });
    assert.match(r.stdout, /models\.orchestrate: sonnet synced=4/);
    const cfg = readFileSync(join(p.dataDir, "config.md"), "utf8");
    assert.match(cfg, /^  orchestrate: sonnet$/m);
    for (const path of skillPaths) {
      assert.match(readFileSync(path, "utf8"), /^model: sonnet$/m, `${path} synced`);
    }

    const bad = p.run(["config", "set-model", "orchestrate", "claude-opus-4-8"], { env });
    assert.equal(bad.code, 2);
    assert.match(readFileSync(join(p.dataDir, "config.md"), "utf8"), /^  orchestrate: sonnet$/m, "config untouched on reject");
    for (const path of skillPaths) {
      assert.doesNotMatch(readFileSync(path, "utf8"), /claude-opus/, "skill untouched on reject");
    }
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
    p.cleanup();
  }
});

test("config set-model: pre-v4 config (no models block) gets one appended", () => {
  const p = makeProject();
  try {
    writeFileSync(
      join(p.dataDir, "config.md"),
      `---\nconfig_version: 3\nproject_name: "x"\n---\n\n# Project Configuration\n`,
    );
    p.run(["config", "set-model", "think", "fable"], { expectFail: false });
    const cfg = readFileSync(join(p.dataDir, "config.md"), "utf8");
    const fmEnd = cfg.indexOf("---", 4);
    assert.ok(cfg.indexOf("models:") < fmEnd, "models block added inside frontmatter");
    assert.match(cfg, /^  think: fable$/m);
  } finally {
    p.cleanup();
  }
});

test("config set-effort: updates agent effort tiers atomically and validates values", () => {
  const p = makeProject();
  try {
    writeFileSync(
      join(p.dataDir, "config.md"),
      `---\nconfig_version: 4\nproject_name: "x"\nagent_effort:\n  build: medium  # comment kept\n  fixer: medium\nexecution:\n  max_parallel_agents: 4\n---\n\n# Project Configuration\n`,
    );
    let r = p.run(["config", "set-effort", "build", "low"], { expectFail: false });
    assert.match(r.stdout, /agent_effort\.build: low/);
    let cfg = readFileSync(join(p.dataDir, "config.md"), "utf8");
    assert.match(cfg, /^  build: low\s*# comment kept$/m, "value flipped, trailing comment preserved");
    assert.match(cfg, /^  fixer: medium$/m, "sibling keys untouched");
    assert.match(cfg, /max_parallel_agents: 4/, "other blocks untouched");

    p.run(["config", "set-effort", "think", "inherit"], { expectFail: false });
    cfg = readFileSync(join(p.dataDir, "config.md"), "utf8");
    assert.match(cfg, /^  think: ""$/m, "missing effort tier inserted");

    assert.equal(p.run(["config", "set-effort", "build", "ultra"]).code, 2);
    assert.equal(p.run(["config", "set-effort", "runner", "low"]).code, 2);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /config_agent_effort_set/);
  } finally {
    p.cleanup();
  }
});

test("config set-effort: pre-v4 config gets agent_effort block appended", () => {
  const p = makeProject();
  try {
    writeFileSync(
      join(p.dataDir, "config.md"),
      `---\nconfig_version: 3\nproject_name: "x"\n---\n\n# Project Configuration\n`,
    );
    p.run(["config", "set-effort", "fixer", "medium"], { expectFail: false });
    const cfg = readFileSync(join(p.dataDir, "config.md"), "utf8");
    const fmEnd = cfg.indexOf("---", 4);
    assert.ok(cfg.indexOf("agent_effort:") < fmEnd, "agent_effort block added inside frontmatter");
    assert.match(cfg, /^  fixer: medium$/m);
  } finally {
    p.cleanup();
  }
});

// --- goal lifecycle hardening ---------------------------------------------

test("noop on a PAUSED cursor: goal-inert with accounting, resume hint, no auto-resume", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight", "sprint=sprint-001"], { expectFail: false });
    p.run(["cursor", "pause", "execute", "--note", "waiting on user creds"], { expectFail: false });
    const r1 = p.run(["cursor", "noop", "execute"], { expectFail: false });
    assert.match(r1.stdout, /PAUSED at stage preflight/);
    assert.match(r1.stdout, /NOT complete/);
    assert.match(r1.stdout, /cursor resume execute/);
    assert.match(r1.stdout.trim().split("\n").pop(), /\/goal should stop\./, "stop marker last");
    // Second noop against the same paused sprint → repeated-noop warning pointing at resume
    const r2 = p.run(["cursor", "noop", "execute"], { expectFail: false });
    assert.match(r2.stdout, /⛔ REPEATED NOOP/);
    assert.match(r2.stdout, /cursor resume execute/);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /awaiting_user_paused/, "paused noops are event-accounted");
    assert.match(events, /pipeline_repeated_noop_detected/);
  } finally {
    p.cleanup();
  }
});

test("noop on an ESCALATED cursor: accounted + repeat detection (no more invisible spin)", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight", "sprint=sprint-001"], { expectFail: false });
    p.run(["cursor", "escalate", "execute", "reason=gate_failure"], { expectFail: false });
    p.run(["cursor", "noop", "execute"], { expectFail: false });
    const r2 = p.run(["cursor", "noop", "execute"], { expectFail: false });
    assert.match(r2.stdout, /⛔ REPEATED NOOP/);
    assert.match(r2.stdout, /ESCALATED|escalated/);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /awaiting_user_escalated/);
  } finally {
    p.cleanup();
  }
});

test("archive-terminal seam: terminal advance with NO cursor emits + markers, writes nothing", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    // Evidence for a review `terminal` (demo_user tick) then simulate archive:
    p.run(["events", "emit", "pipeline_tick_completed", "pipeline=ship-review", "stage=demo_user"]);
    rmSync(join(p.dataDir, "sprints", "current", "SPRINT.md"), { force: true });
    const r = p.run(["cursor", "advance", "review", "terminal", "sprint=sprint-001", "reason=cycle_complete"], { expectFail: false });
    assert.match(r.stdout, /no cursor written/);
    assert.match(r.stdout.trim().split("\n").pop(), /\/goal should stop\./);
    assert.ok(!existsSync(join(p.dataDir, "sprints", "current", "REVIEW-CURSOR.md")), "no stale terminal cursor planted for the next sprint");
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /"outcome":"success"/);
  } finally {
    p.cleanup();
  }
});

test("wave_waiting tick marker carries a bounded goal re-entry hint", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    for (const s of ["preflight", "salvage", "load", "wave_1_dispatch"]) {
      p.run(["cursor", "advance", "execute", s], { expectFail: false });
    }
    const r = p.run(["cursor", "advance", "execute", "wave_1_waiting"], { expectFail: false });
    assert.match(r.stdout, /Background workers are running/);
    // Non-waiting stages carry no hint
    const r2 = p.run(["cursor", "advance", "execute", "wave_1_recovery"], { expectFail: false });
    assert.ok(!r2.stdout.includes("Background workers are running"));
  } finally {
    p.cleanup();
  }
});

test("cursor set refuses the status lifecycle field (no silent un-pause backdoor)", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
    const r = p.run(["cursor", "set", "execute", "status=in_progress"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /lifecycle field/);
  } finally {
    p.cleanup();
  }
});

test("stage graph: sprint_refactor sits between the last wave gate and the full build", () => {
  assert.equal(validateTransition("ship-execute", "wave_2_gate", "sprint_refactor").ok, true);
  assert.equal(validateTransition("ship-execute", "sprint_refactor", "sprint_full_build").ok, true);
  // refactor_scope: wave keeps the direct edge.
  assert.equal(validateTransition("ship-execute", "wave_2_gate", "sprint_full_build").ok, true);
  // It never jumps straight to tests.
  // 4.0: the cleanup pass's mutation check can need a fix wave (the orchestrator had to force the cursor back before)
  assert.equal(validateTransition("ship-execute", "sprint_refactor", "wave_3_dispatch").ok, true);
  assert.equal(validateTransition("ship-execute", "sprint_refactor", "sprint_full_tests").ok, false);
});

test("cursor CLI: --via collapses pass-through stages into one tick with a full event trail", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    for (const s of ["preflight", "salvage", "load", "readiness", "wave_1_dispatch", "wave_1_waiting", "wave_1_recovery", "wave_1_boundary"]) {
      p.run(["cursor", "advance", "execute", s, "sprint=sprint-001"], { expectFail: false });
    }
    // build → refactor → tests in ONE call. (boundary is NOT collapsible — it
    // performs the merges — so it gets its own tick above.)
    const r = p.run([
      "cursor", "advance", "execute", "wave_1_tests",
      "--via", "wave_1_build", "--via", "wave_1_refactor",
      "sprint=sprint-001",
    ], { expectFail: false });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /collapsed 3 stages into one tick/);

    // Cursor landed on the final stage only.
    const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /stage: wave_1_tests/);

    // Every intermediate hop still left its tick events — this is what keeps
    // the terminal gate and wave invariants (event-log readers) whole.
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    for (const s of ["wave_1_build", "wave_1_refactor", "wave_1_tests"]) {
      assert.match(events, new RegExp(`"next_stage":"${s}"`), `missing tick_completed hop for ${s}`);
      assert.match(events, new RegExp(`"pipeline_tick_started"[^\\n]*"stage":"${s}"`), `missing tick_started for ${s}`);
    }
  } finally {
    p.cleanup();
  }
});

test("a wave made only of fix steps may skip its build and test run; an ordinary wave may not (4.0)", () => {
  const p = makeProject();
  try {
    seedSprint(p, { waves: "### Wave 1\nTasks: [T001, T002]\n" });
    for (const s of ["preflight", "salvage", "load", "readiness", "wave_1_dispatch", "wave_1_waiting", "wave_1_recovery", "wave_1_boundary"]) {
      p.run(["cursor", "advance", "execute", s, "sprint=sprint-001"], { expectFail: false });
    }
    const skip = ["cursor", "advance", "execute", "wave_1_verify", "--via", "wave_1_build", "--via", "wave_1_refactor", "--via", "wave_1_tests", "sprint=sprint-001"];
    let r = p.run(skip);
    assert.notEqual(r.code, 0, "planned steps: the suite is not skipped");
    assert.match(r.stderr, /--via wave_1_tests is not collapsible/);
    // one of the two is a fix step: still an ordinary wave
    p.run(["events", "emit", "patch_step_created", "step=T001", "source=story-review"], { expectFail: false });
    assert.notEqual(p.run(skip).code, 0);
    p.run(["events", "emit", "patch_step_created", "step=T002", "source=wave-verify"], { expectFail: false });
    r = p.run(skip, { expectFail: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /collapsed 4 stages into one tick/);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /"next_stage":"wave_1_tests"/, "the skipped stage still leaves its tick, marked collapsed");
  } finally {
    p.cleanup();
  }
});

test("execution.patch_wave_tests: wave keeps a build and test run after every fix wave", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    writeFileSync(join(p.dataDir, "config.md"), "---\nconfig_version: 5\nexecution:\n  patch_wave_tests: wave\n---\n");
    for (const s of ["preflight", "salvage", "load", "readiness", "wave_1_dispatch", "wave_1_waiting", "wave_1_recovery", "wave_1_boundary"]) {
      p.run(["cursor", "advance", "execute", s, "sprint=sprint-001"], { expectFail: false });
    }
    p.run(["events", "emit", "patch_step_created", "step=T001", "source=story-review"], { expectFail: false });
    const r = p.run(["cursor", "advance", "execute", "wave_1_verify", "--via", "wave_1_build", "--via", "wave_1_refactor", "--via", "wave_1_tests", "sprint=sprint-001"]);
    assert.notEqual(r.code, 0);
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: an illegal hop refuses the WHOLE chain — no cursor write, no events", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight", "sprint=sprint-001"], { expectFail: false });
    const eventsBefore = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");

    // wave_1_build is collapsible, but preflight → wave_1_build is not a legal
    // graph edge — so the chain must be refused as a whole.
    const r = p.run([
      "cursor", "advance", "execute", "wave_1_refactor", "--via", "wave_1_build",
    ]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /illegal stage transition/);
    assert.match(r.stderr, /of chain/);

    const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /stage: preflight/, "cursor must not have moved");
    assert.equal(
      readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"),
      eventsBefore,
      "a refused chain must emit no partial hop events",
    );
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: terminals cannot be reached or hidden inside a --via chain", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight", "sprint=sprint-001"], { expectFail: false });

    const asTarget = p.run([
      "cursor", "advance", "execute", "terminal_handoff_to_review", "--via", "salvage",
    ]);
    assert.notEqual(asTarget.code, 0);
    assert.match(asTarget.stderr, /cannot chain --via into terminal stage/);

    const asHop = p.run([
      "cursor", "advance", "execute", "wave_1_refactor", "--via", "terminal_single_task",
    ]);
    assert.notEqual(asHop.code, 0);
    assert.match(asHop.stderr, /is a terminal stage/);
  } finally {
    p.cleanup();
  }
});





test("cursor CLI: --via refuses gate/verdict stages whose tick IS downstream evidence", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight", "sprint=sprint-001"], { expectFail: false });

    // Collapsing is an ALLOWLIST: anything that dispatches an agent, runs a
    // command, or produces a verdict must be refused, in BOTH pipelines.
    const gate = p.run(["cursor", "advance", "execute", "sprint_refactor", "--via", "wave_3_gate"]);
    assert.notEqual(gate.code, 0);
    assert.match(gate.stderr, /not collapsible in this project/);

    for (const stage of [
      "wave_2_dispatch", "wave_2_verify", "wave_2_recovery", "wave_2_waiting",
      "sprint_complete_gate", "sprint_demo_probes", "sprint_full_tests",
      // sprint_refactor is the ONLY refactor pass under refactor_scope: sprint —
      // collapsing it would silently remove refactoring from the whole sprint.
      "sprint_refactor",
    ]) {
      const r = p.run(["cursor", "advance", "execute", "load", "--via", stage]);
      assert.notEqual(r.code, 0, `${stage} must not be collapsible`);
    }
    for (const stage of ["critic", "final_pass", "spec_review", "goal_verify", "simplify", "tests"]) {
      const r = p.run(["cursor", "advance", "review", "verdict", "--via", stage]);
      assert.notEqual(r.code, 0, `review stage ${stage} must not be collapsible`);
    }

    // Pass-through stages nothing gates on stay collapsible.
    // wave_boundary performs the merges — it must NOT be collapsible.
    const boundary = p.run(["cursor", "advance", "execute", "wave_1_build", "--via", "wave_1_boundary"]);
    assert.notEqual(boundary.code, 0, "wave_boundary rebases/merges; collapsing it fabricates integration proof");

    for (const s of ["salvage", "load", "readiness", "wave_1_dispatch", "wave_1_waiting", "wave_1_recovery", "wave_1_boundary"]) {
      p.run(["cursor", "advance", "execute", s, "sprint=sprint-001"], { expectFail: false });
    }
    const ok = p.run([
      "cursor", "advance", "execute", "wave_1_tests", "--via", "wave_1_build", "--via", "wave_1_refactor", "sprint=sprint-001",
    ], { expectFail: false });
    assert.equal(ok.code, 0, ok.stderr);

    // ...but the SAME stages stop being collapsible once configured, because
    // then they do real work and the tick would be fabricated evidence.
    writeFileSync(
      join(p.dataDir, "config.md"),
      `---\nbuild_commands:\n  full: "npm run build"\nexecution:\n  refactor_scope: wave\n---\n\n# Config\n`,
    );
    for (const stage of ["wave_2_build", "wave_2_refactor", "sprint_full_build"]) {
      const r = p.run(["cursor", "advance", "execute", "load", "--via", stage]);
      assert.notEqual(r.code, 0, `${stage} must not collapse when its command is configured`);
      assert.match(r.stderr, /not collapsible in this project/);
    }
  } finally {
    p.cleanup();
  }
});






// ---- T033: session clock keyed on CLAUDE_CODE_SESSION_ID (F005 AC-14, AC-16) ----
// Behavior across /compact, --continue, --resume is UNVERIFIED (session-id-probe.md);
// the design fails safe: ambiguity never resets the clock.
function clockSetup(p, envId, { max = 60, ageMinutes = 120 } = {}) {
  seedSprint(p);
  writeFileSync(join(p.dataDir, "config.md"), `---\nexecution:\n  max_session_minutes: ${max}\n---\n`);
  const cpath = join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md");
  const env = envId ? { CLAUDE_CODE_SESSION_ID: envId } : {};
  for (const st of ["preflight", "salvage", "load"]) p.run(["cursor", "advance", "execute", st], { expectFail: false, env });
  const old = new Date(Date.now() - ageMinutes * 60000).toISOString();
  writeFileSync(cpath, readFileSync(cpath, "utf8").replace(/^session_started_at: .+$/m, `session_started_at: "${old}"`));
  const field = (k) => ((readFileSync(cpath, "utf8").match(new RegExp(`^${k}: (.+)$`, "m")) ?? [])[1] ?? "").replace(/"/g, "");
  return { cpath, env, field, old };
}

test("new_session: preflight stores the env id; it is not settable", () => {
  const p = makeProject();
  try {
    const { field } = clockSetup(p, "sess-A");
    assert.equal(field("session_id"), "sess-A");
    assert.equal(field("session_key"), "env");
    const r = p.run(["cursor", "set", "execute", "session_id=x"]);
    assert.notEqual(r.code, 0);
    assert.equal(field("session_id"), "sess-A");
  } finally {
    p.cleanup();
  }
});

test("session_clock: differing env id resets the clock, logs session_clock_reset, no budget trip", () => {
  const p = makeProject();
  try {
    const { cpath, field, old } = clockSetup(p, "sess-A");
    const r = p.run(["cursor", "advance", "execute", "wave_1_dispatch"], { env: { CLAUDE_CODE_SESSION_ID: "sess-B" } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(cpath, "utf8"), /stage: wave_1_dispatch/);
    assert.ok(!readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8").includes("session_budget_reached"));
    assert.equal(field("session_id"), "sess-B");
    assert.ok(Date.parse(field("session_started_at")) > Date.parse(old) + 60 * 60000, "clock restarted");
    const evs = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8").split("\n").filter((l) => l.includes("session_clock_reset"));
    assert.equal(evs.length, 1);
    const e = JSON.parse(evs[0]);
    assert.equal(e.key, "env");
    assert.equal(e.prior_started_at, old);
    assert.equal(e.prior_session_id, "sess-A");
  } finally {
    p.cleanup();
  }
});

test("session_clock: same env id after a 2h gap does not reset and still trips", () => {
  const p = makeProject();
  try {
    const { cpath, field, old } = clockSetup(p, "sess-A");
    const r = p.run(["cursor", "advance", "execute", "wave_1_dispatch"], { env: { CLAUDE_CODE_SESSION_ID: "sess-A" } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(cpath, "utf8"), /status: paused/);
    assert.equal(field("session_started_at"), old);
  } finally {
    p.cleanup();
  }
});

test("new_session: legacy cursor without a stored id adopts the env id without resetting", () => {
  const p = makeProject();
  try {
    const { cpath, field, old } = clockSetup(p, null);
    assert.equal(field("session_id"), "");
    const r = p.run(["cursor", "advance", "execute", "wave_1_dispatch"], { env: { CLAUDE_CODE_SESSION_ID: "sess-A" } });
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(cpath, "utf8"), /status: paused/, "clock kept, budget tripped");
    assert.equal(field("session_started_at"), old);
  } finally {
    p.cleanup();
  }
});

test("session_clock: env id missing never resets on a time gap; ambiguity keeps", () => {
  // No env id, recent events: keep the clock (trips).
  let p = makeProject();
  try {
    const { cpath, field, old } = clockSetup(p, "sess-A");
    const r = p.run(["cursor", "advance", "execute", "wave_1_dispatch"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(cpath, "utf8"), /status: paused/);
    assert.equal(field("session_started_at"), old);
    assert.equal(field("session_id"), "sess-A", "stored id kept");
  } finally {
    p.cleanup();
  }
  // No env id, last event 45 min old: a time gap never resets (31+ min quiet keeps the clock).
  p = makeProject();
  try {
    const { cpath, field, old } = clockSetup(p, null);
    const ev = join(p.dataDir, ".shipyard-events.jsonl");
    const stale = new Date(Date.now() - 45 * 60000).toISOString();
    writeFileSync(ev, readFileSync(ev, "utf8").split("\n").filter(Boolean).map((l) => l.replace(/"ts":"[^"]+"/, `"ts":"${stale}"`)).join("\n") + "\n");
    const r = p.run(["cursor", "advance", "execute", "wave_1_dispatch"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(cpath, "utf8"), /status: paused/);
    assert.equal(field("session_started_at"), old);
    assert.ok(!readFileSync(ev, "utf8").includes("session_clock_reset"));
  } finally {
    p.cleanup();
  }
  // No env id and no event log at all: ambiguity, keep.
  p = makeProject();
  try {
    const { cpath, field, old } = clockSetup(p, null);
    rmSync(join(p.dataDir, ".shipyard-events.jsonl"), { force: true });
    const r = p.run(["cursor", "advance", "execute", "wave_1_dispatch"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(cpath, "utf8"), /status: paused/);
    assert.equal(field("session_started_at"), old);
  } finally {
    p.cleanup();
  }
});

test("new_session: resume records the current env id", () => {
  const p = makeProject();
  try {
    const { field } = clockSetup(p, "sess-A");
    p.run(["cursor", "pause", "execute", "--note", "x"]);
    const r = p.run(["cursor", "resume", "execute"], { env: { CLAUDE_CODE_SESSION_ID: "sess-C" } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(field("session_id"), "sess-C");
  } finally {
    p.cleanup();
  }
});

// --- F013/T042: presumed-dead detector wired into cursor advance ----------

function deadQueue(p, over = {}) {
  const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
  const item = {
    id: "T001", pipeline: "execute", stage: "wave_1_dispatch", status: "claimed",
    claimed_by: "builder-9", claimed_at: ago(90), deadline_at: ago(60), attempt: 1, ...over,
  };
  const qpath = join(p.dataDir, "sprints", "current", ".worker-queue.json");
  writeFileSync(qpath, JSON.stringify({ version: 1, tasks: [item] }));
  return qpath;
}

test("presumed_dead: advance reports a dead builder once, never mutates queue/cursor, quiet otherwise", () => {
  // AC-1 AC-4 AC-5 AC-6 AC-8
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
    const clean = p.run(["cursor", "advance", "execute", "salvage"], { expectFail: false });
    assert.ok(!/presumed dead/.test(clean.stdout), "quiet with no queue items");

    const qpath = deadQueue(p);
    const queueBefore = readFileSync(qpath, "utf8");
    const r = p.run(["cursor", "advance", "execute", "load"], { expectFail: false });
    assert.match(r.stdout, /presumed dead: T001 \(claimed_by builder-9/);
    const lines = r.stdout.trimEnd().split("\n");
    assert.match(lines[lines.length - 1], /TICK COMPLETE/, "detector line precedes tick marker");
    assert.equal(readFileSync(qpath, "utf8"), queueBefore, "queue byte-identical");
    const ev = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8")
      .split("\n").filter((l) => l.includes("subagent_presumed_dead"));
    assert.equal(ev.length, 1);
    assert.equal(JSON.parse(ev[0]).claimed_by, "builder-9");

    const again = p.run(["cursor", "advance", "execute", "wave_1_dispatch"], { expectFail: false });
    assert.ok(!/presumed dead/.test(again.stdout), "reported once");
  } finally {
    p.cleanup();
  }
});

test("presumed_dead: completed_unacked flag reaches the emitted event and printed line", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
    p.run(["cursor", "advance", "execute", "salvage"], { expectFail: false });
    deadQueue(p);
    const done = new Date(Date.now() - 30 * 60000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
    writeFileSync(join(p.dataDir, ".shipyard-events.jsonl"),
      JSON.stringify({ ts: done, type: "subagent_completed", task: "T001" }) + "\n", { flag: "a" });
    const r = p.run(["cursor", "advance", "execute", "load"], { expectFail: false });
    assert.match(r.stdout, /completed but not acknowledged: reconcile via the return gate/);
    assert.ok(!/no completion or recent heartbeat/.test(r.stdout));
    const ev = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8")
      .split("\n").filter((l) => l.includes("subagent_presumed_dead"));
    assert.equal(ev.length, 1);
    assert.equal(JSON.parse(ev[0]).completed_unacked, true);
  } finally {
    p.cleanup();
  }
});

test("presumed_dead: heartbeat and missing claimed_at are not reported", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight"], { expectFail: false });
    deadQueue(p, { claimed_at: undefined, deadline_at: undefined });
    const r = p.run(["cursor", "advance", "execute", "salvage"], { expectFail: false });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!/presumed dead/.test(r.stdout));
  } finally {
    p.cleanup();
  }
});

// AC-18 AC-20
function trigAdvance(p, extra) {
  seedSprint(p);
  for (const s of ["preflight", "salvage", "load", "readiness", "wave_1_dispatch", "wave_1_waiting", "wave_1_recovery"]) {
    p.run(["cursor", "advance", "execute", s, "sprint=sprint-001"], { expectFail: false });
  }
  return p.run(["cursor", "advance", "execute", "wave_1_redispatch_iter_1", ...extra, "sprint=sprint-001"], { expectFail: extra[0] === "--trigger" && extra[1] === "bogus" });
}
test("cursor CLI: trigger_enum_valid records trigger on the tick event", () => {
  const p = makeProject();
  try {
    const r = trigAdvance(p, ["--trigger", "gate_failure"]);
    assert.equal(r.code, 0);
    const ev = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(ev, /"next_stage":"wave_1_redispatch_iter_1"[^\n]*"trigger":"gate_failure"/);
  } finally { p.cleanup(); }
});
test("cursor CLI: trigger_invalid_rejected", () => {
  const p = makeProject();
  try {
    const r = trigAdvance(p, ["--trigger", "bogus"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--trigger must be one of/);
  } finally { p.cleanup(); }
});
test("cursor CLI: trigger_missing_event logs trigger_missing, no guess", () => {
  const p = makeProject();
  try {
    const r = trigAdvance(p, []);
    assert.equal(r.code, 0);
    const ev = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(ev, /"next_stage":"wave_1_redispatch_iter_1"[^\n]*"trigger_missing":true/);
    assert.doesNotMatch(ev, /"trigger":"/);
  } finally { p.cleanup(); }
});

// --- T097: F005 AC-6 / AC-8 / AC-9 coverage gaps ---

test("session_budget AC-6: task-return, events emit, anchor-commit and cursor pause are never refused when over budget", () => {
  // AC-6
  const p = makeProject();
  try {
    const { cpath } = budgetSetup(p);
    const trip = p.run(["cursor", "advance", "execute", "wave_1_dispatch"]);
    assert.equal(trip.code, 0, trip.stderr);
    assert.match(readFileSync(cpath, "utf8"), /status: paused/, "budget is exceeded and tripped");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.repo, encoding: "utf8" }).trim();

    const tr = p.run(["task-return", "T001", "status=COMPLETE", `commit=${sha}`, "probe-exit=0", "--data-dir", p.dataDir]);
    assert.equal(tr.code, 0, `task-return refused over budget: ${tr.stderr}`);
    const ev = p.run(["events", "emit", "budget_probe_event", "k=v", "--data-dir", p.dataDir]);
    assert.equal(ev.code, 0, `events emit refused over budget: ${ev.stderr}`);
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /budget_probe_event/);
    const an = p.run(["anchor-commit", "T001", sha, "--data-dir", p.dataDir]);
    assert.equal(an.code, 0, `anchor-commit refused over budget: ${an.stderr}`);
    execFileSync("git", ["cat-file", "-e", "shipyard/keep-T001^{commit}"], { cwd: p.repo });
    const pz = p.run(["cursor", "pause", "execute", "--note", "still allowed"]);
    assert.equal(pz.code, 0, pz.stderr);
  } finally {
    p.cleanup();
  }
});

test("session_budget AC-8: pause on budget, resume, then advance into wave_N_dispatch succeeds", () => {
  // AC-8
  const p = makeProject();
  try {
    const { cpath, events } = budgetSetup(p);
    const trip = p.run(["cursor", "advance", "execute", "wave_1_dispatch"]);
    assert.equal(trip.code, 0, trip.stderr);
    assert.match(readFileSync(cpath, "utf8"), /status: paused/);
    const stale = (readFileSync(cpath, "utf8").match(/^session_started_at: (.+)$/m) ?? [])[1];
    const rr = p.run(["cursor", "resume", "execute"]);
    assert.equal(rr.code, 0, rr.stderr);
    const fresh = (readFileSync(cpath, "utf8").match(/^session_started_at: (.+)$/m) ?? [])[1];
    assert.notEqual(fresh, stale, "resume reset the clock");
    const adv = p.run(["cursor", "advance", "execute", "wave_1_dispatch"]);
    assert.equal(adv.code, 0, adv.stderr);
    const after = readFileSync(cpath, "utf8");
    assert.match(after, /stage: wave_1_dispatch/);
    assert.match(after, /status: in_progress/);
    assert.equal(events().split("\n").filter((l) => l.includes("session_budget_reached")).length, 1, "only the first trip");
  } finally {
    p.cleanup();
  }
});

test("session_budget AC-9: SPRINT.md started_at is unchanged by cursor resume", () => {
  // AC-9
  const p = makeProject();
  try {
    const { cpath } = budgetSetup(p);
    const sprintPath = join(p.dataDir, "sprints", "current", "SPRINT.md");
    const original = "2020-01-02T03:04:05.000Z";
    writeFileSync(sprintPath, readFileSync(sprintPath, "utf8").replace(/^---\n/, `---\nstarted_at: "${original}"\n`));
    const before = readFileSync(sprintPath, "utf8");
    assert.match(before, /started_at: "2020-01-02T03:04:05.000Z"/);
    p.run(["cursor", "advance", "execute", "wave_1_dispatch"]); // budget pause
    const rr = p.run(["cursor", "resume", "execute"]);
    assert.equal(rr.code, 0, rr.stderr);
    assert.match(readFileSync(cpath, "utf8"), /status: in_progress/);
    assert.equal(readFileSync(sprintPath, "utf8"), before, "SPRINT.md untouched by resume");
    assert.doesNotMatch(readFileSync(cpath, "utf8"), new RegExp(original), "cursor clock is not the sprint started_at");
  } finally {
    p.cleanup();
  }
});

test("cursor CLI: parked --task/--hotfix escalates from the real stage, and resume returns to it (C-2)", () => {
  for (const stage of ["single_task", "hotfix"]) {
    const p = makeProject();
    try {
      seedSprint(p);
      p.run(["cursor", "advance", "execute", stage], { expectFail: false });
      const r = p.run(["cursor", "escalate", "execute", "reason=task_needs_attention"], { expectFail: false });
      assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
      assert.match(r.stdout.trim().split("\n").pop(), /\/goal should stop\./);
      const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
      assert.match(cursor, /status: escalated/);
      assert.match(cursor, /terminal: true/);
      const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
      const term = events.split("\n").filter((l) => l.includes('"pipeline_terminal"')).pop() || "";
      assert.match(term, /"outcome":"escalated"/);
      assert.match(term, /"reason":"task_needs_attention"/);
      const rr = p.run(["cursor", "resume", "execute"], { expectFail: false });
      assert.equal(rr.code, 0, `${rr.stdout}${rr.stderr}`);
      assert.match(rr.stdout, new RegExp(`resumed at stage ${stage}`));
    } finally {
      p.cleanup();
    }
  }
});

test("an escalation with nothing in flight leaves no cursor behind (4.0): a task that outgrew its lane does not block the sprint", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    const r = p.run(["cursor", "escalate", "execute", "reason=escalate_to_discuss", "next_action=/ship-discuss T462"], { expectFail: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /nothing was in flight, so no cursor is left behind\. Next: \/ship-discuss T462/);
    assert.equal(existsSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md")), false);
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"pipeline_terminal"[^\n]*"outcome":"escalated"[^\n]*"reason":"escalate_to_discuss"/);
    // the sprint's own run starts normally
    assert.equal(p.run(["cursor", "advance", "execute", "preflight", "sprint=sprint-001"], { expectFail: false }).code, 0);
    // and a run that IS in flight still leaves its escalated cursor to resume
    p.run(["cursor", "escalate", "execute", "reason=blocked"], { expectFail: false });
    assert.match(readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8"), /status: escalated/);
  } finally { p.cleanup(); }
});

test("accept-return takes a hotfix story id: commit anchored, event written, the story's own status left alone (4.0)", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    mkdirSync(join(p.dataDir, "spec", "stories"), { recursive: true });
    const story = join(p.dataDir, "spec", "stories", "S069-real-art.md");
    writeFileSync(story, `---\nid: S069\ntype: bug\nlane: hotfix\nstatus: approved\n---\n\n# Real art\n`);
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: p.repo, encoding: "utf8" }).trim();
    const r = p.run(["step", "accept-return", "S069", "sprint=none", "wave=0", `commit=${sha}`, "--data-dir", p.dataDir], { expectFail: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /story S069 accepted complete return/);
    execFileSync("git", ["cat-file", "-e", `shipyard/keep-S069^{commit}`], { cwd: p.repo });
    assert.match(readFileSync(story, "utf8"), /^status: approved$/m);
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"type":"task_dispatch_returned"[^\n]*"task":"S069"/);
  } finally { p.cleanup(); }
});

test("a sprint starts over the finished cursor of a hotfix or single task; any other finished cursor still refuses (4.0)", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    const cur = join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md");
    writeFileSync(cur, "---\npipeline: ship-execute\nstage: terminal_hotfix\nstatus: complete\nterminal: true\n---\n");
    let r = p.run(["cursor", "advance", "execute", "preflight", "sprint=sprint-001"], { expectFail: false });
    assert.equal(r.code, 0, r.stderr);
    assert.match(readFileSync(cur, "utf8"), /stage: preflight/);
    assert.match(readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8"), /"finished_short_run_cursor_replaced"[^\n]*"was":"terminal_hotfix"/);
    // a finished sprint is not started over this way
    writeFileSync(cur, "---\npipeline: ship-execute\nstage: terminal_handoff_to_review\nstatus: complete\nterminal: true\nsprint: sprint-001\n---\n");
    r = p.run(["cursor", "advance", "execute", "preflight", "sprint=sprint-001"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /already terminal/);
  } finally { p.cleanup(); }
});

test("stage graph: from waiting on wave N+1 the cursor may step back to wave N's build, and nowhere else backwards (4.0)", () => {
  assert.equal(validateTransition("ship-execute", "wave_2_waiting", "wave_1_build").ok, true);
  assert.equal(validateTransition("ship-execute", "wave_2_waiting", "wave_2_build").ok, false, "its own wave's build comes after its boundary");
  assert.equal(validateTransition("ship-execute", "wave_3_waiting", "wave_1_build").ok, false);
  assert.equal(validateTransition("ship-execute", "wave_2_waiting", "wave_1_tests").ok, false);
});
