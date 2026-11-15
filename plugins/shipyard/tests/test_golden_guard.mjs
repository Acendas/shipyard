// AC-6: every golden pin declares rename (identical|changes) and a non-empty alias row id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { checkPinSource, pin } from './lib/golden.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('guard reports a planted pin call without rename', () => {
  const bad = checkPinSource("pin('x', { alias: 'A-01' }, actual);");
  assert.equal(bad.length, 1);
  assert.match(bad[0], /rename/);
});

test('guard reports a planted pin call without alias or with empty alias', () => {
  assert.equal(checkPinSource("pin('x', { rename: 'changes' }, a);").length, 1);
  assert.equal(checkPinSource("pin('x', { rename: 'changes', alias: '' }, a);").length, 1);
});

test('guard accepts a well-annotated pin', () => {
  assert.deepEqual(checkPinSource("pin('x', { rename: 'identical', alias: 'A-02' }, a);"), []);
});

test('guard rejects an alias that fails the row-id format', () => {
  const bad = checkPinSource("pin('x', { rename: 'identical', alias: 'nope' }, a);");
  assert.equal(bad.length, 1);
  assert.match(bad[0], /alias/);
});

test('pin: missing fixture fails with record hint; record mode writes; then compares', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-'));
  const meta = { rename: 'identical', alias: 'A-01' };
  const prev = process.env.SHIPYARD_GOLDEN_RECORD;
  try {
    delete process.env.SHIPYARD_GOLDEN_RECORD;
    assert.throws(() => pin('t', meta, { a: 1 }, dir), /SHIPYARD_GOLDEN_RECORD=1/);
    process.env.SHIPYARD_GOLDEN_RECORD = '1';
    pin('t', meta, { a: 1 }, dir);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 't.json'), 'utf8')), { a: 1 });
    delete process.env.SHIPYARD_GOLDEN_RECORD;
    pin('t', meta, { a: 1 }, dir);
    assert.throws(() => pin('t', meta, { a: 2 }, dir));
  } finally {
    if (prev === undefined) delete process.env.SHIPYARD_GOLDEN_RECORD; else process.env.SHIPYARD_GOLDEN_RECORD = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pin: refuses bad rename and bad alias', () => {
  const dir = os.tmpdir();
  assert.throws(() => pin('t', { rename: 'maybe', alias: 'A-01' }, 1, dir), /rename/);
  assert.throws(() => pin('t', { alias: 'A-01' }, 1, dir), /rename/);
  assert.throws(() => pin('t', { rename: 'changes', alias: 'nope' }, 1, dir), /alias/);
  assert.throws(() => pin('t', { rename: 'changes' }, 1, dir), /alias/);
});

test('every pin in test_golden_*.mjs is annotated', () => {
  const files = fs.readdirSync(here).filter((f) => /^test_golden_(?!guard).*\.mjs$/.test(f));
  for (const f of files) {
    const problems = checkPinSource(fs.readFileSync(path.join(here, f), 'utf8'));
    assert.deepEqual(problems, [], `${f}: ${problems.join('; ')}`);
  }
});
