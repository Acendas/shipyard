// The build gate (after 4.0.4): one door for every build and test run.
// Found on a real sprint: five builders ran the build tool at once on a 16 GB, 10-core
// machine; load 34 to 44, 26 JVMs, and builds failing for reasons unrelated to the code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  decide, heavySignatures, isHeavyArgv, localLimit, needOf, prune, readySettled, readyCommand,
  segments, signatureOf, taskOf, ungatedHeavy, QUEUED_EXIT, RUNNER_UNAVAILABLE_EXIT,
} from "../bin/build-gate.mjs";
import { extendedDeadlineMs } from "../bin/worker-queue.mjs";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin");
const GB = 2 ** 30;
const words = (s) => s.split(/\s+/);

test("the tool a command runs is found behind launchers and env settings", () => {
  assert.equal(signatureOf(words("./gradlew test")), "gradlew");
  assert.equal(signatureOf(words("TOKEN=abc ./gradlew --offline :a:test")), "gradlew");
  assert.equal(signatureOf(words("python3 -m pytest -q")), "pytest");
  assert.equal(signatureOf(words("pnpm exec vitest run")), "vitest");
  assert.equal(signatureOf(words("npx jest --ci")), "jest");
  assert.equal(signatureOf(words("go test ./...")), "go test");
  assert.equal(signatureOf(words("npm test")), "npm test");
  assert.equal(signatureOf(words("make -k test")), "make");
});

test("only the project's own build and test tool is held; nothing configured means nothing held", () => {
  const sigs = heavySignatures(["./gradlew test", "./gradlew assemble", ""]);
  assert.deepEqual([...sigs], ["gradlew"]);
  assert.equal(isHeavyArgv(words("./gradlew --offline :x:testStagingUnitTest"), sigs), true);
  assert.equal(isHeavyArgv(words("git status"), sigs), false);
  assert.equal(isHeavyArgv(words("grep -n gradlew build.gradle"), sigs), false);
  assert.equal(isHeavyArgv(words("./gradlew test"), heavySignatures([])), false);
  const go = heavySignatures(["go test ./..."]);
  assert.equal(isHeavyArgv(words("go test ./pkg"), go), true);
  assert.equal(isHeavyArgv(words("go fmt ./..."), go), false, "the same tool's light command is not a build");
});

test("a wrapper script that runs the tool is the tool (a builder wrote one to set a token)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gate-wrap-"));
  try {
    writeFileSync(join(dir, "gw.sh"), "export TOKEN=$(cat ~/.cache/t)\n./gradlew --offline \"$@\"\n");
    writeFileSync(join(dir, "other.sh"), "echo hello\n");
    const sigs = heavySignatures(["./gradlew test"]);
    assert.equal(isHeavyArgv(["zsh", "gw.sh", ":a:test"], sigs, dir), true);
    assert.equal(isHeavyArgv(["sh", "other.sh"], sigs, dir), false);
    assert.equal(isHeavyArgv(["sh", "missing.sh"], sigs, dir), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a build hidden in `sh -c` or behind `timeout` is still the build", () => {
  const sigs = heavySignatures(["./gradlew test"]);
  assert.equal(isHeavyArgv(["sh", "-c", "cd mod && ./gradlew test"], sigs), true);
  assert.equal(isHeavyArgv(["bash", "-lc", "echo hi"], sigs), false);
  assert.equal(isHeavyArgv(words("timeout 300 ./gradlew test"), sigs), true);
});

test("the builder hook finds a build outside the gate, and leaves a gated or harmless command alone", () => {
  const sigs = heavySignatures(["./gradlew test"]);
  assert.equal(ungatedHeavy("./gradlew :a:test --tests '*X*'", sigs), "./gradlew :a:test --tests '*X*'");
  assert.equal(ungatedHeavy("cd mod && ./gradlew test | tail -5", sigs), "./gradlew test");
  assert.equal(ungatedHeavy("shipyard-logcap run P1-probe -- ./gradlew :a:test ; echo EXIT=$?", sigs), null);
  assert.equal(ungatedHeavy("export T=$(cat f) && shipyard-logcap run P1-red -- ./gradlew --offline :a:test 2>&1 | tail -40", sigs), null);
  assert.equal(ungatedHeavy("T=1 shipyard-logcap run P1-red -- ./gradlew :a:test", sigs), null);
  assert.equal(ungatedHeavy("grep -rn gradlew . ; cat gradlew ; git add gradlew", sigs), null);
  assert.equal(ungatedHeavy("shipyard-logcap run a -- ./gradlew a && ./gradlew b", sigs), "./gradlew b", "a second run chained after the gated one");
  assert.equal(ungatedHeavy("./gradlew test", heavySignatures([])), null);
});

// Seen live, 11 refusals in one evening, none of them a build on this machine.
test("text that names the build tool is not a build: a file body, a commit message, a job sent elsewhere", () => {
  const sigs = heavySignatures(["./gradlew test"]);
  assert.equal(ungatedHeavy("cat > /tmp/brief.md <<'EOF'\nVerify P018\nRun exactly:\n./gradlew :a:test\nEOF\nagent run KEY-1 - < /tmp/brief.md", sigs), null, "a here-document's body");
  assert.equal(ungatedHeavy("git commit -q -m \"feat(P017): count\n\n./gradlew :a:test passes; ./gradlew detekt too\"", sigs), null, "a commit message");
  assert.equal(ungatedHeavy("agent run KEY-1 \"verify P005: run one gradle command; ./gradlew :a:test && report\"", sigs), null, "a quoted argument");
  assert.equal(ungatedHeavy("echo './gradlew test' | pbcopy", sigs), null);
  assert.equal(ungatedHeavy("cat <<-EOF > notes\n\t./gradlew test\n\tEOF\n./gradlew :b:test", sigs), "./gradlew :b:test", "the command after the here-document still counts");
  assert.equal(ungatedHeavy("out=$(./gradlew :a:test 2>&1); echo \"$out\" | tail -3", sigs), "./gradlew :a:test 2>&1", "a build inside $( ) is a build");
  assert.equal(ungatedHeavy("sh -c 'cd mod && ./gradlew test'", sigs), "sh -c 'cd mod && ./gradlew test'", "a build inside sh -c is a build");
  assert.deepEqual(segments("a 'b c' \"d;e\" && f\\ g").map((w) => [...w]), [["a", "b c", "d;e"], ["f g"]]);
});

const cfg = { enabled: true, slots: null, runner: null, commands: ["./gradlew test"] };
const mac = (over = {}) => ({ cores: 10, total: 16 * GB, available: 10 * GB, load1: 3, ...over });
const st = (over = {}) => ({ v: 1, holders: [], queue: [], need: { cores: [], mem: [] }, shrink: null, runner: null, ...over });
const tk = (key, over = {}) => ({ key, name: key, lane: "local", first: false, at: 1, seen: 1, ...over });
const hold = (name, lane = "local") => ({ id: name, pid: process.pid, key: name, name, lane, at: 1, solo: false });

test("nothing running: go, whatever the machine says (a bad reading can never deadlock)", () => {
  const t = tk("a");
  const v = decide(st({ queue: [t] }), t, cfg, mac({ available: null, load1: 99 }));
  assert.equal(v.go, true);
  assert.equal(v.solo, true);
});

test("until one run was measured alone, runs go one at a time", () => {
  const t = tk("b");
  const v = decide(st({ queue: [t], holders: [hold("a")] }), t, cfg, mac());
  assert.equal(v.go, false);
  assert.match(v.why, /no run has been measured alone yet/);
  assert.deepEqual(needOf(st()), { cores: null, mem: null });
});

test("room is what was measured: cores, memory, and the machine as it is right now", () => {
  const measured = st({ need: { cores: [3, 3, 4], mem: [4 * GB, 2 * GB] }, holders: [hold("a")] });
  assert.equal(localLimit(measured, cfg, mac()).limit, 3, "10 cores / 3, and 13.6 GB / 4 GB");
  const t = tk("b");
  measured.queue = [t];
  assert.equal(decide(measured, t, cfg, mac()).go, true);
  assert.match(decide(measured, t, cfg, mac({ available: 5 * GB })).why, /not enough free memory/, "5 GB free minus 4 leaves less than the reserve");
  assert.match(decide(measured, t, cfg, mac({ load1: 31 })).why, /the machine is busy \(load 31\.0 on 10 cores\)/, "another session's build counts");
  assert.match(decide(measured, t, cfg, mac({ available: null })).why, /free memory cannot be read/);
  measured.holders = [hold("a"), hold("c"), hold("d")];
  assert.match(decide(measured, t, cfg, mac()).why, /3 running, room for 3/);
});

test("a killed run lowers the limit; the owner's number replaces the measurement", () => {
  const s = st({ need: { cores: [2], mem: [2 * GB] }, shrink: { n: 2, at: Date.now() } });
  assert.equal(localLimit(s, cfg, mac()).limit, 3, "5 by cores, minus 2");
  assert.equal(localLimit(s, { ...cfg, slots: 4 }, mac()).limit, 4);
  const t = tk("b");
  const busy = st({ queue: [t], holders: [hold("a")] });
  assert.equal(decide(busy, t, { ...cfg, slots: 2 }, mac({ available: null, load1: 50 })).go, true, "with the owner's number no reading is consulted");
  s.shrink.at = Date.now() - 13 * 60 * 60_000;
  assert.equal(prune(s, Date.now(), () => true).shrink, null, "the lowering ends after 12 hours");
});

test("the line is first come first served, the wave boundary goes first, and each lane has its own line", () => {
  const a = tk("a", { at: 1 }), b = tk("b", { at: 2 }), boundary = tk("suite", { at: 3, first: true }), remote = tk("r", { at: 4, lane: "runner" });
  const s = st({ queue: [a, b, boundary, remote], runner: { capacity: 2, at: Date.now() }, holders: [hold("x", "runner")] });
  assert.equal(decide(s, boundary, cfg, mac()).go, true);
  assert.deepEqual([decide(s, a, cfg, mac()).place, decide(s, b, cfg, mac()).place], [2, 3]);
  assert.equal(decide(s, remote, cfg, null).go, true, "the runner has room for 2 and 1 runs");
  s.holders.push(hold("y", "runner"));
  assert.match(decide(s, remote, cfg, null).why, /the runner is full \(2 of 2\)/);
});

test("a dead holder and a ticket nobody came back for are dropped", () => {
  const now = Date.now();
  const s = st({ holders: [hold("live"), { ...hold("dead"), pid: 999999 }], queue: [tk("fresh", { seen: now }), tk("stale", { seen: now - 7 * 60_000 })] });
  prune(s, now, (pid) => pid === process.pid);
  assert.deepEqual(s.holders.map((h) => h.name), ["live"]);
  assert.deepEqual(s.queue.map((q) => q.name), ["fresh"]);
});

test("time in line does not use up a builder's claim", () => {
  const claimed = Date.parse("2026-11-17T19:03:00Z");
  const task = { id: "P026", claimed_at: new Date(claimed).toISOString(), deadline_at: new Date(claimed + 30 * 60_000).toISOString(), ttl_seconds: 1800 };
  const at = (min, type) => ({ ts: new Date(claimed + min * 60_000).toISOString(), type, task: "P026" });
  assert.equal(extendedDeadlineMs("/nowhere", task, [at(100, "task_loop_iteration")]), claimed + 90 * 60_000, "work alone is capped at three times the claim");
  assert.equal(extendedDeadlineMs("/nowhere", task, [at(100, "build_gate_waiting")]), claimed + 130 * 60_000, "a builder that asked the gate at minute 100 is alive");
  assert.equal(taskOf("P026-probe-1"), "P026");
  assert.equal(taskOf("ready-check"), null);
});

test("the ready check is settled by a pass, a skip or the owner's answer, and only inside this readiness stage", () => {
  const tick = { type: "pipeline_tick_completed", next_stage: "readiness", sprint: "sprint-001" };
  const res = (result) => ({ type: "build_ready_checked", result });
  assert.equal(readySettled([res("passed"), tick], "sprint-001"), false, "an earlier sprint's pass does not count");
  assert.equal(readySettled([tick, res("passed")], "sprint-001"), true);
  assert.equal(readySettled([tick, res("failed")], "sprint-001"), false);
  assert.equal(readySettled([tick, res("failed"), res("accepted")], "sprint-001"), true);
  assert.equal(readySettled([tick, res("skipped")], "sprint-001"), true);
  assert.equal(readySettled([], "sprint-001"), true, "no readiness stage: nothing to hold (resume, crash recovery)");
});

// ─── Through the real commands ─────────────────────────────────────────────

function project({ unit = "./build.sh 1", execution = "" } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gate-")));
  const repo = join(base, "repo"), pd = join(base, "pd");
  mkdirSync(repo); mkdirSync(pd);
  writeFileSync(join(repo, "build.sh"), "#!/bin/sh\nsleep ${1:-1}\necho built $1\nexit ${2:-0}\n");
  chmodSync(join(repo, "build.sh"), 0o755);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: pd, CLAUDE_PROJECT_DIR: repo, SHIPYARD_GATE_WAIT_MS: "1500", SHIPYARD_GATE_POLL_MS: "100" };
  delete env.SHIPYARD_DATA;
  const d = spawnSync("node", ["-e", `import(${JSON.stringify(join(BIN, "shipyard-resolver.mjs"))}).then(m=>console.log(m.getDataDir({silent:true})))`], { cwd: repo, env, encoding: "utf8" }).stdout.trim();
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, ".project-root"), repo + "\n");
  writeFileSync(join(d, "config.md"), `---\ntest_commands:\n  unit: "${unit}"\nexecution:\n  isolation: worktree\n${execution}---\n`);
  const logcap = (name, ...cmd) => { const r = spawnSync("node", [join(BIN, "shipyard-logcap.mjs"), "run", name, ...cmd], { cwd: repo, env, encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const data = (...a) => { const r = spawnSync("node", [join(BIN, "shipyard-data.mjs"), ...a], { cwd: repo, env, encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
  const events = () => (existsSync(join(d, ".shipyard-events.jsonl")) ? readFileSync(join(d, ".shipyard-events.jsonl"), "utf8") : "");
  return { base, repo, d, env, logcap, data, events, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test("a second build waits, then is QUEUED (exit 75, not a failure) and runs when asked again", async () => {
  const p = project();
  try {
    const first = spawn("node", [join(BIN, "shipyard-logcap.mjs"), "run", "P001-probe", "--", "./build.sh", "4"], { cwd: p.repo, env: p.env, stdio: "ignore" });
    const done = new Promise((r) => first.on("exit", r));
    await new Promise((r) => setTimeout(r, 900));
    const exitFile = join(p.base, "exit");
    const second = p.logcap("P002-probe", "--exit-file", exitFile, "--", "./build.sh", "1");
    assert.equal(second.code, QUEUED_EXIT);
    assert.match(second.out, /QUEUED, not run \(place 1 of 1\).*This is not a failure\. Run the same command again/);
    assert.match(second.err, /waiting for room to build/);
    assert.equal(readFileSync(exitFile, "utf8").trim(), "75", "a waiter polling the exit file is not left hanging");
    assert.doesNotMatch(second.out, /built/);
    assert.match(p.data("build-gate", "status").out, /1 running here, 1 waiting, room for 1/);
    assert.match(p.events(), /"build_gate_waiting".*"task":"P002"/);
    assert.equal(await done, 0);
    const again = p.logcap("P002-probe", "--", "./build.sh", "1");
    assert.equal(again.code, 0);
    assert.match(again.out, /built 1/);
    assert.doesNotMatch(p.events(), /"command_run","name":"P002-probe","exit":75/, "a run that never started is not a recorded run");
  } finally { p.cleanup(); }
});

test("a run whose turn came after a long wait is not started in a call that is nearly over: the place is held", async () => {
  const p = project();
  try {
    const first = spawn("node", [join(BIN, "shipyard-logcap.mjs"), "run", "a", "--", "./build.sh", "2"], { cwd: p.repo, env: p.env, stdio: "ignore" });
    const done = new Promise((r) => first.on("exit", r));
    await new Promise((r) => setTimeout(r, 700));
    const state = () => JSON.parse(readFileSync(join(p.d, ".build-gate.json"), "utf8"));
    // The second run's place is taken as if its wait had been long: a held place with no process behind it.
    await done;
    const s = state();
    s.holders.push({ id: "held", pid: 0, key: `${p.repo}\u0000./build.sh 1`, name: "b", lane: "local", at: Date.now(), solo: true, reserved: true, until: Date.now() + 60_000 });
    writeFileSync(join(p.d, ".build-gate.json"), JSON.stringify(s));
    const other = p.logcap("c", "--", "./build.sh", "3");
    assert.equal(other.code, QUEUED_EXIT, "the held place counts as taken");
    const mine = p.logcap("b", "--", "./build.sh", "1");
    assert.equal(mine.code, 0, "the command the place is held for takes it");
    assert.match(mine.out, /built 1/);
    assert.deepEqual(state().holders, []);
    s.holders[s.holders.length - 1].until = Date.now() - 1;
    writeFileSync(join(p.d, ".build-gate.json"), JSON.stringify(s));
    assert.equal(p.logcap("c", "--", "./build.sh", "1").code, 0, "a held place nobody came back for is given up");
  } finally { p.cleanup(); }
});

test("a command that is not the project's tool, and a timed stream, are never held", async () => {
  const p = project();
  try {
    const first = spawn("node", [join(BIN, "shipyard-logcap.mjs"), "run", "a", "--", "./build.sh", "8"], { cwd: p.repo, env: p.env, stdio: "ignore" });
    const done = new Promise((r) => first.on("exit", r));
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(p.logcap("light", "--", "echo", "hello").code, 0);
    assert.equal(p.logcap("stream", "--duration", "1s", "--", "./build.sh", "5").code, 0);
    assert.equal(p.logcap("forced", "--gate", "--", "echo", "hello").code, QUEUED_EXIT, "--gate holds any command");
    first.kill("SIGTERM");
    await done;
  } finally { p.cleanup(); }
});

test("the owner's switch turns the gate off", async () => {
  const p = project({ execution: "  build_gate: false\n" });
  try {
    const first = spawn("node", [join(BIN, "shipyard-logcap.mjs"), "run", "a", "--", "./build.sh", "2"], { cwd: p.repo, env: p.env, stdio: "ignore" });
    const done = new Promise((r) => first.on("exit", r));
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(p.logcap("b", "--", "./build.sh", "1").code, 0);
    await done;
  } finally { p.cleanup(); }
});

test("a project runner takes the build, in its own lane, and a broken runner is never a red test", () => {
  const p = project();
  try {
    const runner = join(p.base, "runner.sh");
    const script = (body) => { writeFileSync(runner, `#!/bin/sh\nif [ "$1" = "--capacity" ]; then ${body.capacity}; fi\n${body.run}\n`); chmodSync(runner, 0o755); };
    writeFileSync(join(p.d, "config.md"), `---\ntest_commands:\n  unit: "./build.sh 1"\nexecution:\n  runner_command: ${runner}\n---\n`);
    script({ capacity: "echo 4; exit 0", run: 'echo "remote: $*"; exit 0' });
    const ok = p.logcap("P001-probe", "--", "./build.sh", "1");
    assert.equal(ok.code, 0);
    assert.match(ok.out, new RegExp(`remote: --worktree ${p.repo} --job [0-9a-f]{10}-[0-9a-z]+ -- ./build.sh 1`));
    assert.match(p.data("build-gate", "status").out, /runner .*runner\.sh: 0 of 4 running, 0 waiting/);
    assert.match(p.logcap("w", "--", "echo", "hello").out, /^hello/m, "only the build tool goes to the runner");

    script({ capacity: "echo 4; exit 0", run: "echo no route to host; exit 69" });
    const down = p.logcap("P001-probe", "--", "./build.sh", "1");
    assert.equal(down.code, RUNNER_UNAVAILABLE_EXIT);
    assert.match(down.out, /RUNNER UNAVAILABLE, not a test result.*Run the same command again; it will run on this machine/);
    assert.doesNotMatch(p.events(), /"command_run","name":"P001-probe","exit":69/);
    assert.match(p.events(), /"runner_unavailable","reason":"exit 69"/);
    const local = p.logcap("P001-probe", "--", "./build.sh", "1");
    assert.equal(local.code, 0);
    assert.match(local.out, /built 1/, "asked again, it runs here");
  } finally { p.cleanup(); }
});

// Seen live: a job on the owner's other machine took 19 minutes and a tool call ends at 10, so builders asked
// the host by hand, over and over, and nothing was recorded as a run.
test("a run the runner has not finished ends the call with RUNNING, keeps its place, and the same command continues the same job", () => {
  const p = project();
  try {
    const runner = join(p.base, "runner.sh");
    const jobs = join(p.base, "jobs.log");
    // The first call for a job answers "still running" (75); the second call with the same --job finishes it.
    writeFileSync(runner, `#!/bin/sh\nif [ "$1" = "--capacity" ]; then echo 1; exit 0; fi\njob="$4"\necho "$job" >> ${jobs}\nif [ "$(grep -c "^$job$" ${jobs})" -lt 2 ]; then echo started; exit 75; fi\necho "report of $job"; exit 0\n`);
    chmodSync(runner, 0o755);
    writeFileSync(join(p.d, "config.md"), `---\ntest_commands:\n  unit: "./build.sh 1"\nexecution:\n  runner_command: ${runner}\n---\n`);
    const first = p.logcap("P007-probe", "--", "./build.sh", "1");
    assert.equal(first.code, QUEUED_EXIT);
    assert.match(first.out, /RUNNING on the project's runner, not finished yet\. This is not a failure\. Run the same command again/);
    assert.doesNotMatch(p.events(), /"command_run","name":"P007-probe"/, "a run that has not ended is not a recorded run");
    assert.match(p.events(), /"build_gate_waiting","name":"P007-probe","lane":"runner","task":"P007","running":true/, "the queue sees the builder as alive");
    const state = JSON.parse(readFileSync(join(p.d, ".build-gate.json"), "utf8"));
    assert.equal(state.holders.length, 1, "the place stays taken while the job runs elsewhere");
    assert.equal(state.holders[0].reserved, true);
    assert.equal(p.logcap("P008-probe", "--", "./build.sh", "2").code, QUEUED_EXIT, "the runner takes one run and it is still running");
    const again = p.logcap("P007-probe", "--", "./build.sh", "1");
    assert.equal(again.code, 0);
    const ids = readFileSync(jobs, "utf8").trim().split("\n");
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1], "the second call names the same job");
    assert.match(again.out, new RegExp(`report of ${ids[0]}`));
    assert.match(p.events(), /"command_run","name":"P007-probe","exit":0/);
    assert.deepEqual(JSON.parse(readFileSync(join(p.d, ".build-gate.json"), "utf8")).holders, []);
    const next = p.logcap("P007-probe-2", "--", "./build.sh", "1");
    assert.equal(next.code, QUEUED_EXIT, "the same command after the job ended is a new job");
    assert.notEqual(readFileSync(jobs, "utf8").trim().split("\n")[2], ids[0]);
  } finally { p.cleanup(); }
});

test("a runner that does not say how many runs it takes is not used", () => {
  const p = project();
  try {
    const runner = join(p.base, "runner.sh");
    writeFileSync(runner, "#!/bin/sh\necho remote\n"); chmodSync(runner, 0o755);
    writeFileSync(join(p.d, "config.md"), `---\ntest_commands:\n  unit: "./build.sh 1"\nexecution:\n  runner_command: ${runner}\n---\n`);
    const r = p.logcap("a", "--", "./build.sh", "1");
    assert.match(r.out, /built 1/);
    assert.match(p.events(), /"runner_unavailable","reason":"no answer to --capacity"/);
  } finally { p.cleanup(); }
});

test("the ready check: a build that starts passes; one that does not is shown and stops the start; the owner's answer is the way through", () => {
  const p = project();
  try {
    writeFileSync(join(p.d, "config.md"), `---\ntest_commands:\n  unit: "./build.sh 1"\n  ready: "./build.sh 0"\n---\n`);
    assert.deepEqual(readyCommand(p.d), { command: "./build.sh 0", source: "test_commands.ready" });
    const ok = p.data("build-gate", "check");
    assert.equal(ok.code, 0);
    assert.match(ok.out, /READY CHECK · the build starts \(\d+ s, on this machine\): \.\/build\.sh 0/);
    writeFileSync(join(p.d, "config.md"), `---\ntest_commands:\n  unit: "./build.sh 1"\n  ready: "./build.sh 0 7"\n---\n`);
    const bad = p.data("build-gate", "check");
    assert.equal(bad.code, 3);
    assert.match(bad.out, /READY CHECK · FAILED \(exit 7, on this machine\)/);
    assert.match(bad.out, /built 0/, "the end of the output is shown");
    assert.match(bad.out, /build-gate check --accept/);
    assert.equal(p.data("build-gate", "check", "--accept").code, 2, "an acceptance needs the person's words");
    assert.equal(p.data("build-gate", "check", "--accept", "start anyway, I will log in later").code, 0);
    assert.match(p.events(), /"build_ready_checked","result":"passed"[\s\S]*"result":"failed"[\s\S]*"result":"accepted","answer":"start anyway, I will log in later"/);
  } finally { p.cleanup(); }
});

test("the ready check never invents a command: gradle and maven have a certain one, others say what to set", () => {
  const p = project({ unit: "./gradlew test" });
  try {
    assert.equal(readyCommand(p.d).command, "./gradlew help");
    writeFileSync(join(p.d, "config.md"), `---\ntest_commands:\n  unit: "make -k test"\n---\n`);
    assert.equal(readyCommand(p.d), null);
    const r = p.data("build-gate", "check");
    assert.equal(r.code, 0);
    assert.match(r.out, /skipped: set `test_commands\.ready`/);
    writeFileSync(join(p.d, "config.md"), `---\ntest_commands:\n  unit: ""\n---\n`);
    assert.match(p.data("build-gate", "check").out, /skipped: no test or build command is configured/);
    assert.match(p.data("build-gate", "status").out, /off: no test or build command is configured/);
  } finally { p.cleanup(); }
});
