// story probe-command (4.14): a probe's trailing full-suite run is left out
// only when that exact command is proven fresh for this tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProbeCommand, probeRun, trailingSuite } from "../bin/probe-command.mjs";
import { recordVerification } from "../bin/verify-ledger.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "probecmd-"));
  const repo = join(root, "repo"), dataDir = join(root, "data");
  mkdirSync(repo); mkdirSync(join(dataDir, "sprints", "current"), { recursive: true });
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "a.txt"), "a\n"); g("add", "-A"); g("commit", "-q", "-m", "init");
  writeFileSync(join(dataDir, ".project-root"), repo + "\n");
  writeFileSync(join(dataDir, "config.md"), '---\ntest_commands:\n  unit: "make -k -j8 test"\n  integration: ""\n---\n');
  const capture = join(root, "run.log"); writeFileSync(capture, "ok\n");
  return { root, repo, dataDir, capture, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("readProbeCommand: block scalar, inline, legacy scalar; manual and skip have nothing to run", () => {
  assert.deepEqual(readProbeCommand("---\nid: S1\nuser_flow_probe:\n  kind: auto\n  command: |\n    cd x && make build/t && build/t\n    && make test\n---\nbody"), { kind: "auto", command: "cd x && make build/t && build/t\n&& make test" });
  assert.deepEqual(readProbeCommand('---\nuser_flow_probe:\n  kind: assisted\n  command: "sh setup.sh"\n  steps:\n    - look\n---\n'), { kind: "assisted", command: "sh setup.sh" });
  assert.deepEqual(readProbeCommand("---\ndemo_probe: sh probe.sh\n---\n"), { kind: "auto", command: "sh probe.sh" });
  assert.equal(readProbeCommand("---\nuser_flow_probe: skip-with-reason\n---\n"), null);
  assert.equal(readProbeCommand("---\nuser_flow_probe:\n  kind: manual\n  steps:\n    - open the menu\n---\n"), null);
});

test("probeRun: the trailing suite is dropped only with a fresh proof of that exact command", () => {
  const f = fixture();
  try {
    const probe = "sh tests/one.sh && make -k -j8 test";
    assert.deepEqual(trailingSuite(f.dataDir, probe), { tier: "unit", command: "make -k -j8 test" });
    assert.equal(probeRun(f.dataDir, probe).run, probe, "no proof: the whole probe runs");
    recordVerification(f.dataDir, { key: "test_commands.unit", command: "make test", exitCode: 0, capturePath: f.capture, projectDir: f.repo });
    assert.equal(probeRun(f.dataDir, probe).run, probe, "a proof of another command does not count");
    recordVerification(f.dataDir, { key: "test_commands.unit", command: "make -k -j8 test", exitCode: 0, capturePath: f.capture, projectDir: f.repo });
    const r = probeRun(f.dataDir, probe);
    assert.equal(r.run, "sh tests/one.sh"); assert.equal(r.reused[0].key, "test_commands.unit");
    // only the trailing part, and never the whole probe
    assert.equal(probeRun(f.dataDir, "make -k -j8 test && build/t").run, "make -k -j8 test && build/t");
    assert.equal(probeRun(f.dataDir, "make -k -j8 test").run, "make -k -j8 test");
    assert.equal(probeRun(f.dataDir, "sh a.sh; make -k -j8 test").run, "sh a.sh; make -k -j8 test", "only an && join is safe to cut");
    // the tree moves on: the proof is stale, the whole probe runs again
    writeFileSync(join(f.repo, "a.txt"), "changed\n");
    assert.equal(probeRun(f.dataDir, probe).run, probe);
  } finally { f.cleanup(); }
});

test("path map note: advisory, only for tagged stories, names scenarios the map leaves out", async () => {
  const { pathMapNote } = await import("../bin/spec-state-cli.mjs");
  assert.equal(pathMapNote("## Acceptance Criteria\nScenario: one\n"), "", "no tagged scenario: no note");
  assert.match(pathMapNote("## Acceptance Criteria\n@AC-1 @e2e\nScenario: one\n"), /no `## Paths` section/);
  const withMap = "## Paths\n| Ending | Covered by |\n|---|---|\n| paid | @AC-1 |\n| card refused | AC-2 |\n| double tap | cannot happen: the button disables on first tap |\n\n## Acceptance Criteria\n@AC-1\n@AC-2\n";
  assert.equal(pathMapNote(withMap), "");
  assert.match(pathMapNote(withMap + "@AC-3\n"), /names no ending for @AC-3/);
});

test("scenarioProblems: ids, one level tag, a reason below the journey, and a path map naming every scenario", async () => {
  const { scenarioProblems } = await import("../bin/spec-state-cli.mjs");
  const good = [
    "## Paths", "| Ending | Covered by |", "|---|---|", "| paid | @AC-1 |", "| card refused | @AC-2 |", "| fee table | AC-3 |", "| double tap | cannot happen: the button disables |", "",
    "## Acceptance Criteria", "```gherkin",
    "@AC-1 @e2e", "Scenario: pays", "  Given a cart", "  When the user taps Pay", "  Then the receipt screen shows the total", "",
    "@AC-2 @component", "# why not e2e: the gateway timeout cannot be staged in the journey", "Scenario: gateway times out", "",
    "@AC-3 @unit", "# why not e2e: a fee rule with many input values, one table", "Scenario Outline: fees", "```",
  ].join("\n");
  assert.deepEqual(scenarioProblems(good), []);
  assert.deepEqual(scenarioProblems("no scenarios here"), ["no Gherkin scenario"]);
  const p = scenarioProblems(good.replace("@AC-1 @e2e", "@AC-1").replace("# why not e2e: the gateway timeout cannot be staged in the journey\n", "").replace("| fee table | AC-3 |\n", "").replace("@AC-3 @unit", "@AC-3 @unit @e2e"));
  assert.equal(p.length, 4, p.join("\n"));
  assert.match(p[0], /@AC-1 needs exactly one level tag .* has none/);
  assert.match(p[1], /@AC-2 is @component with no reason/);
  assert.match(p[2], /@AC-3 needs exactly one level tag .* has @unit @e2e|has @e2e @unit/);
  assert.match(p[3], /names no ending for @AC-3/);
  assert.match(scenarioProblems("```gherkin\nScenario: untagged\n```\n").join("|"), /has no @AC-<n> id\|no `## Paths` section/);
});
