/** The plugin-shipped workflows (4.5): scripts compile, start with a literal meta, and behave over stubbed agents. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "workflows");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function load(name) {
  const src = readFileSync(join(DIR, name), "utf8");
  assert.match(src, /^export const meta = \{/, `${name} must begin with a literal meta`);
  const body = src.replace(/^export const meta = /, "const meta = ");
  return new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", body);
}
const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => { let v = item; for (const s of stages) { v = await s(v, item, i); if (v == null) return null; } return v; }));

test("every shipped workflow compiles and declares a name matching its file", () => {
  for (const f of readdirSync(DIR).filter((n) => n.endsWith(".js"))) {
    load(f);
    const m = readFileSync(join(DIR, f), "utf8").match(/name: '([a-z-]+)'/);
    assert.equal(m && m[1], f.replace(/\.js$/, ""), f);
    assert.doesNotMatch(readFileSync(join(DIR, f), "utf8"), /Date\.now\(|Math\.random\(|new Date\(\)/, `${f}: forbidden in workflow scripts`);
  }
});

test("review-scan: one read-only reviewer per dimension, findings merged, a dead scanner is named in dropped", async () => {
  const calls = [];
  const agent = async (prompt, opts) => { calls.push(opts); return opts.label === "scan:bugs" ? null : { findings: [{ title: opts.label, severity: "low", files: [], confidence: 90, source: opts.label }] }; };
  const out = await load("review-scan.js")(agent, parallel, pipeline, () => {}, () => {}, { dimensions: ["security", "bugs"], target_ids: ["S001"], base_ref: "a", head_ref: "b", data_dir: "/d", model: "opus" });
  assert.deepEqual(out.dropped, ["bugs"]);
  assert.equal(out.findings.length, 1);
  assert.ok(calls.every((c) => c.agentType === "shipyard:shipyard-code-reviewer" && c.model === "opus" && c.schema));
});

test("story-review: spec review feeds gap analysis per story; a story whose reviewer died is left out", async () => {
  const agent = async (prompt, opts) => {
    if (opts.label === "spec:S002") return null;
    return opts.agentType.endsWith("spec-reviewer") ? { status: "PASS", met: 3, partial: 0, missing: 0, over_built: 0 } : { gaps: [] };
  };
  const out = await load("story-review.js")(agent, parallel, pipeline, () => {}, () => {}, { stories: ["S001", "S002"], base_ref: "a", head_ref: "b", data_dir: "/d" });
  assert.deepEqual(out.map((r) => r.story), ["S001"]);
  assert.equal(out[0].spec.status, "PASS");
});
