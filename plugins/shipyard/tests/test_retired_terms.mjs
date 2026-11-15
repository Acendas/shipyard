/**
 * F022 AC-7: a shipped skill or agent may not use a term terminology-v4 retired.
 * The list lives in bin/vocab.mjs (RETIRED_TERMS) so the lint and the CLI agree.
 * Run: node --test tests/test_retired_terms.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { RETIRED_TERMS } from "../bin/vocab.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// F024 removed ship-quick / ship-bug; nothing is pending any more. Keep the hook so a future
// retirement can stage its removal the same way.
export const PENDING_UNTIL_F024 = [];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

export function scanRetiredTerms(root = ROOT, { pending = PENDING_UNTIL_F024 } = {}) {
  const files = [...walk(join(root, "skills")), ...walk(join(root, "agents")), ...walk(join(root, "project-files", "rules"))];
  const hits = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
      // A line that explains how a LEGACY record is read may name the old path or
      // id (e.g. "pre-v4 records in spec/features/ are read in place"). That is
      // documentation of an alias, not use of the retired term.
      if (/\b(legacy|pre-v4)\b/i.test(line)) return;
      for (const t of RETIRED_TERMS) {
        if (!t.re.test(line)) continue;
        if (pending.some((p) => p.source === t.re.source)) continue;
        hits.push(`${relative(root, f)}:${i + 1}: ${t.re} -> use ${t.use}`);
      }
    });
  }
  return hits;
}

test("no shipped skill, agent or rule uses a retired term", () => {
  const hits = scanRetiredTerms();
  assert.deepEqual(hits, [], `retired terms found:\n${hits.join("\n")}`);
});

test("the pending list names only retired terms (empty since F024)", () => {
  assert.deepEqual(PENDING_UNTIL_F024, []);
});
