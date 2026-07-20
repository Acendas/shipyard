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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  assert.ok(validateTransition("ship-review", "preflight", "code_review_iter_1").ok);
  assert.ok(validateTransition("ship-review", "preflight", "tests").ok, "--skip-code-review");
  assert.ok(validateTransition("ship-review", "preflight", "retro_step_1").ok, "--retro-only");
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
  const run = (args, opts = {}) => {
    try {
      const stdout = execFileSync("node", [CLI, ...args], {
        cwd: repo,
        env,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      if (opts.expectFail === false) throw err;
      return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  };
  const dataDir = run(["init"]).stdout.trim();
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
    const r = p.run(["cursor", "advance", "execute", "terminal_handoff_to_review", "reason=sprint_complete"], { expectFail: false });
    const lines = r.stdout.trim().split("\n");
    const last = lines[lines.length - 1];
    assert.match(last, /\/loop should stop\./, "stop marker must be the FINAL line (v2.8.2 handoff-seam rule)");
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

test("cursor CLI: loop-leak guard — non-terminal advance against completed sprint exits 3", () => {
  const p = makeProject();
  try {
    seedSprint(p, { status: "completed" });
    const r = p.run(["cursor", "advance", "execute", "preflight"]);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /loop-leak guard/);
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
    assert.match(lines[lines.length - 1], /\/loop should stop\./);
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
    assert.match(r.stdout, /\/loop should stop\./);
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

test("cursor CLI: noop emits terminal event first; repeat noop detects the leak", () => {
  const p = makeProject();
  try {
    // No sprint at all — the archived case.
    const r1 = p.run(["cursor", "noop", "review", "sprint=sprint-001"], { expectFail: false });
    assert.match(r1.stdout, /\/loop should stop\./);
    const r2 = p.run(["cursor", "noop", "review", "sprint=sprint-001"], { expectFail: false });
    assert.match(r2.stdout, /⛔ LOOP LEAK/);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    const noops = events.split("\n").filter((l) => l.includes('"outcome":"noop"')).length;
    assert.equal(noops, 2, "every noop is emitted — a silent no-op is the v2.8.2 invisibility bug");
    assert.match(events, /pipeline_loop_leak_detected/);
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
    const r = p.run(["cursor", "set", "execute", "auto_loop_attempted=true"], { expectFail: false });
    assert.equal(r.code, 0);
    const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /auto_loop_attempted: true/);
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

test("cursor bootstrap-check: eligible sets sentinel; second call ineligible", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight", "loop_owner=user"], { expectFail: false });
    const r1 = JSON.parse(p.run(["cursor", "bootstrap-check", "execute"], { expectFail: false }).stdout);
    assert.equal(r1.eligible, true);
    const cursor = readFileSync(join(p.dataDir, "sprints", "current", "EXECUTE-CURSOR.md"), "utf8");
    assert.match(cursor, /auto_loop_attempted: true/, "sentinel set as side effect");
    const r2 = JSON.parse(p.run(["cursor", "bootstrap-check", "execute"], { expectFail: false }).stdout);
    assert.equal(r2.eligible, false);
    assert.match(r2.reason, /auto_loop_attempted/);
  } finally {
    p.cleanup();
  }
});

test("cursor bootstrap-check: dead sprint is never eligible", () => {
  const p = makeProject();
  try {
    seedSprint(p);
    p.run(["cursor", "advance", "execute", "preflight", "loop_owner=user"], { expectFail: false });
    p.run(["sprint", "set", "status", "completed"], { expectFail: false });
    const r = JSON.parse(p.run(["cursor", "bootstrap-check", "execute"], { expectFail: false }).stdout);
    assert.equal(r.eligible, false);
    assert.match(r.reason, /completed|dead/);
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
    assert.equal(p.run(["config", "set-model", "think", "gpt5"]).code, 2);
    assert.equal(p.run(["config", "set-model", "reviewer", "opus"]).code, 2);
    const events = readFileSync(join(p.dataDir, ".shipyard-events.jsonl"), "utf8");
    assert.match(events, /config_model_set/);
  } finally {
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
