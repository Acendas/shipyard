/**
 * The tutorial narration file (project-files/references/tutorial-narration.md) is read by the CLI, keyed by
 * stage. These pin that every key names something real: a quick-run stage, a build or review stage the
 * cursor can reach, or a gate whose source prints the key; and that every quick stage has an entry. The
 * golden fixture pins the key set, so a key added without a stage behind it fails here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pin } from "./lib/golden.mjs";
import { loadNarration, normalizeCursorKey, NARRATION_FILE, REFUSAL_KEYS } from "../bin/tutorial.mjs";
import { QUICK_STAGES } from "../bin/quick.mjs";
import { normalizeStage } from "../bin/pipeline-stages.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const binSource = () => {
  const dirs = [join(ROOT, "bin"), join(ROOT, "bin", "hooks")];
  return dirs.flatMap((d) => readdirSync(d).filter((n) => n.endsWith(".mjs")).map((n) => readFileSync(join(d, n), "utf8"))).join("\n");
};

test("every narration key names a real stage or gate, and every quick stage has an entry", () => {
  const narration = loadNarration(NARRATION_FILE);
  assert.ok(narration.size > 0, "the narration file has entries");
  const src = binSource();
  for (const [key, text] of narration) {
    assert.ok(text.trim().length > 0, `${key} has text`);
    if (key === "intro") continue;
    const [kind, name] = key.split(":");
    if (kind === "quick") {
      assert.ok(QUICK_STAGES.includes(name), `quick:${name} is a stage of quick.mjs (${QUICK_STAGES.join(", ")})`);
    } else if (kind === "cursor") {
      const concrete = name.replace(/^wave_N_/, "wave_1_").replace(/_iter_N$/, "_iter_1");
      assert.equal(normalizeCursorKey(concrete), name, `${name} is in its normalised form`);
      const known = normalizeStage("ship-execute", concrete) || normalizeStage("ship-review", concrete);
      assert.ok(known, `cursor:${name} is a stage the execute or review cursor can reach (${concrete})`);
    } else if (kind === "refusal") {
      assert.ok(REFUSAL_KEYS.includes(name), `refusal:${name} is a listed gate (${REFUSAL_KEYS.join(", ")})`);
      assert.ok(src.includes(`"refusal:${name}"`), `a gate's source prints "refusal:${name}"`);
    } else {
      assert.fail(`${key}: unknown key kind "${kind}"; expected intro, quick:<stage>, cursor:<stage id> or refusal:<gate>`);
    }
  }
  // `quick next` prints the `task` stage as `build`, so the task stage shares the build block.
  for (const stage of QUICK_STAGES) assert.ok(narration.has(`quick:${stage === "task" ? "build" : stage}`), `quick:${stage} has narration`);
  for (const gate of REFUSAL_KEYS) assert.ok(narration.has(`refusal:${gate}`), `refusal:${gate} has narration`);
  assert.ok(narration.has("intro"));
});

test("the narration key set is pinned", () => {
  const keys = [...loadNarration(NARRATION_FILE).keys()].sort();
  pin("tutorial-narration-keys", { rename: "identical", alias: "TUT-01" }, { keys });
});

test("a block is printed as a headline and indented lines, and a missing key prints nothing", async () => {
  const { tutorialBlock } = await import("../bin/tutorial.mjs");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "narration-"));
  try {
    writeFileSync(join(dir, "quick.json"), JSON.stringify({ run: "quick-001", state: "active", tutorial: true }));
    const narration = new Map([["quick:plan", "Headline here.\nSecond line.\n\nFourth line."]]);
    assert.equal(tutorialBlock(dir, "quick:plan", narration), "TUTORIAL: Headline here.\n  Second line.\n\n  Fourth line.\n");
    assert.equal(tutorialBlock(dir, "quick:nothing", narration), "");
    writeFileSync(join(dir, "quick.json"), JSON.stringify({ run: "quick-001", state: "active" }));
    assert.equal(tutorialBlock(dir, "quick:plan", narration), "", "a plain run prints nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
