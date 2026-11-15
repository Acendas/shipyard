import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatterList } from "../bin/frontmatter-list.mjs";

const fm = (line) => `id: x\n${line}\nstatus: ok`;

const SPELLINGS = [
  ['["F003"]', ["F003"], "inline"],
  ["[F003]", ["F003"], "inline"],
  ["['F003']", ["F003"], "inline"],
  ['["F001", "F002"]', ["F001", "F002"], "inline"],
  ['[ "F001" ,"F002" ]', ["F001", "F002"], "inline"],
  ["F001, F002", ["F001", "F002"], "bare"],
  ['["F003"] # note', ["F003"], "inline"],
];

for (const [raw, ids, form] of SPELLINGS) {
  test(`AC-1 spelling ${raw}`, () => {
    const r = parseFrontmatterList(fm(`features: ${raw}`), "features");
    assert.deepEqual(r.items, ids);
    assert.equal(r.form, form);
  });
}

test("letter-suffixed ids and no id regex", () => {
  assert.deepEqual(parseFrontmatterList(fm("features: F071d, GH-6, x y"), "features").items, ["F071d", "GH-6", "x y"]);
});

test("AC-6 block list reports form=block", () => {
  const r = parseFrontmatterList("features:\n  - F001\n  - \"F002\"  # c\nother: 1", "features");
  assert.equal(r.form, "block");
  assert.deepEqual(r.items, ["F001", "F002"]);
});

test("empty forms", () => {
  for (const b of ["features: []", "features:", "features: ", "other: 1"]) {
    const r = parseFrontmatterList(b, "features");
    assert.equal(r.form, "empty", b);
    assert.deepEqual(r.items, []);
  }
});

test("AC-7 BOM and CRLF do not change result", () => {
  const base = parseFrontmatterList(fm('features: ["F001", "F002"]'), "features");
  const crlf = parseFrontmatterList("﻿" + fm('features: ["F001", "F002"]').replace(/\n/g, "\r\n"), "features");
  assert.deepEqual(crlf.items, base.items);
  assert.equal(crlf.form, base.form);
  const blk = parseFrontmatterList("﻿features:\r\n  - F001\r\n  - F002\r\n", "features");
  assert.deepEqual(blk.items, ["F001", "F002"]);
});

test("never throws on junk input", () => {
  for (const v of [null, undefined, 5, {}, ""]) {
    const r = parseFrontmatterList(v, "features");
    assert.deepEqual(r.items, []);
  }
});

test("wrapped in --- delimiters also works; key not confused by prefix", () => {
  const r = parseFrontmatterList("---\nfeatures_x: A\nfeatures: B\n---\nbody", "features");
  assert.deepEqual(r.items, ["B"]);
});

test("multiline_flow list reads every item and reports form=multiline", () => {
  const r = parseFrontmatterList("id: x\nexternal_refs: [GH-1,\n  GH-2]\nstatus: ok", "external_refs");
  assert.deepEqual(r.items, ["GH-1", "GH-2"]);
  assert.equal(r.form, "multiline");
});

test("multiline_flow quoted hash is not a comment", () => {
  assert.deepEqual(parseFrontmatterList('x: ["b # c"]', "x").items, ["b # c"]);
  assert.deepEqual(parseFrontmatterList('x: ["a",\n "b # c"] # tail', "x").items, ["a", "b # c"]);
});

test("a quoted item that contains a comma stays one item (4.0)", async () => {
  const { parseFrontmatterList: parse } = await import("../bin/frontmatter-list.mjs");
  const fm = 'touches: ["src/creep.c#creep_return_step,creep_pick(RETURN branch)", "tests/t.c", \'mk/a.mk#x, y\']\nother: [a, b]';
  assert.deepEqual(parse(fm, "touches").items, ["src/creep.c#creep_return_step,creep_pick(RETURN branch)", "tests/t.c", "mk/a.mk#x, y"]);
  assert.deepEqual(parse(fm, "other").items, ["a", "b"]);
  assert.deepEqual(parse("deps: [don't, stop]", "deps").items, ["don't", "stop"], "an apostrophe inside a word opens nothing");
});
