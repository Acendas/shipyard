/** F031 / F033 config switches: review.code_review level (never ultra/max) and review.workflow opt-in. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutUserSettings } from "./lib/no-user-settings.mjs";
import { readCodeReviewLevel, readReviewWorkflow, CODE_REVIEW_LEVELS, readStoryReview } from "../bin/config-read.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "shipyard-data.mjs");

function withConfig(block) {
  const dir = mkdtempSync(join(tmpdir(), "review-cfg-"));
  if (block != null) writeFileSync(join(dir, "config.md"), `---\n${block}\n---\n\n# Config\n`);
  return dir;
}

test("review.code_review: absent/empty/off -> off; low|medium|high accepted; ultra/max/junk -> off and invalid", () => {
  const d0 = withConfig(null);
  try { assert.deepEqual(readCodeReviewLevel(d0), { level: "off", valid: true }); } finally { rmSync(d0, { recursive: true, force: true }); }
  for (const [v, exp] of [["off", { level: "off", valid: true }], ["low", { level: "low", valid: true }], ["High", { level: "high", valid: true }], ['""', { level: "off", valid: true }], ["ultra", { level: "off", valid: false }], ["max", { level: "off", valid: false }], ["loud", { level: "off", valid: false }]]) {
    const d = withConfig(`review:\n  code_review: ${v}`);
    try { assert.deepEqual(readCodeReviewLevel(d), exp, v); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  assert.deepEqual([...CODE_REVIEW_LEVELS], ["off", "low", "medium", "high"]);
});

test("review.workflow: off unless explicitly true; execution.story_review defaults on", () => {
  const d0 = withConfig(null);
  try {
    assert.equal(readReviewWorkflow(d0), false);
    assert.equal(readStoryReview(d0), true);
  } finally { rmSync(d0, { recursive: true, force: true }); }
  for (const [v, exp] of [["true", true], ["on", true], ["false", false], ["maybe", false]]) {
    const d = withConfig(`review:\n  workflow: ${v}`);
    try { assert.equal(readReviewWorkflow(d), exp, v); } finally { rmSync(d, { recursive: true, force: true }); }
  }
  const off = withConfig("execution:\n  story_review: false");
  try { assert.equal(readStoryReview(off), false); } finally { rmSync(off, { recursive: true, force: true }); }
});

test("doctor reports an invalid review.code_review level", () => {
  const base = mkdtempSync(join(tmpdir(), "review-cfg-doctor-"));
  const d = join(base, "projects", "abc123abc123");
  try {
    mkdirSync(join(d, "templates"), { recursive: true });
    writeFileSync(join(d, ".project-root"), "/nonexistent\n");
    writeFileSync(join(d, "config.md"), "---\nreview:\n  code_review: ultra\n---\n");
    const r = spawnSync("node", [CLI, "doctor", "--data-dir", d], { encoding: "utf8", env: withoutUserSettings(base) });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /review\.code_review/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
