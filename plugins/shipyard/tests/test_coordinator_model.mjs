/** T026 / F004: coordinator_model (light tier) is distinct from the relayed build model. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const skill = read("skills/dispatching-track-coordinator/SKILL.md");
const track = read("skills/ship-execute/references/track-mode.md");

test("both docs name coordinator_model", () => {
  assert.match(skill, /coordinator_model/);
  assert.match(track, /coordinator_model/);
});

test("coordinator Agent dispatch uses coordinator_model, not build_model", () => {
  const dispatch = skill.slice(skill.indexOf("Agent(\n  subagent_type"));
  const line = dispatch.split("\n").find((l) => /^\s*model:/.test(l));
  assert.match(line, /coordinator_model/);
  assert.doesNotMatch(line, /build_model/);
});

test("build model is still relayed to nested builders as a string", () => {
  assert.match(skill, /Build model:\s+\{\{build_model/);
  assert.match(skill, /no `Bash`/);
});

test("track-mode dispatch model comes from coordinator_model", () => {
  const line = track.split("\n").find((l) => /^\s*model: <.*resolve-model coordinator/.test(l));
  assert.ok(line, "model line present");
  assert.match(line, /coordinator_model/);
});
