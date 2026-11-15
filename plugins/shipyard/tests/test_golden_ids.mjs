// Characterization pins (pre-rename): next-id output per kind + init-data SUBDIRS.
// AC-1: current behavior captured from the unmodified tree. AC-5: pins pass before any rename.
// AC-6: every pin declares rename + alias row id (see test_golden_guard.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync as writeFile } from 'node:fs';
import { pin } from './lib/golden.mjs';
import { ensureInitializedDataDir } from '../bin/init-data.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shipyard-data.mjs');

function nextIds(kind, n, setup) {
  const dir = mkdtempSync(join(tmpdir(), 'golden-ids-'));
  try {
    if (setup) setup(dir);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(execFileSync('node', [BIN, 'next-id', kind, '--data-dir', dir], { encoding: 'utf8' }));
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('next-id ideas', () => {
  pin('ids-next-ideas', { rename: 'identical', alias: 'A-06' }, nextIds('ideas', 3));
});
test('next-id epics', () => {
  pin('ids-next-epics', { rename: 'identical', alias: 'A-06' }, nextIds('epics', 3));
});
test('next-id features', () => {
  pin('ids-next-features', { rename: 'identical', alias: 'A-06' }, nextIds('features', 3));
});
test('next-id bugs', () => {
  pin('ids-next-bugs', { rename: 'identical', alias: 'A-06' }, nextIds('bugs', 3));
});
test('next-id tasks', () => {
  pin('ids-next-tasks', { rename: 'identical', alias: 'A-06' }, nextIds('tasks', 3));
});
// IDEA-008: the allocator also scans spec/archive/<kind>, so an archived T001 yields T002
// even with no counter and an empty live dir.
test('next-id tasks skips ids that exist only in the archive', () => {
  const out = nextIds('tasks', 1, (d) => {
    mkdirSync(join(d, 'spec', 'archive', 'tasks'), { recursive: true });
    writeArchived(d);
  });
  pin('ids-next-tasks-archived', { rename: 'changes', alias: 'A-06' }, out);
});
import { writeFileSync } from 'node:fs';
function writeArchived(d) {
  writeFileSync(join(d, 'spec', 'archive', 'tasks', 'T001-old.md'), '---\nid: "T001"\n---\n');
}

test('init-data SUBDIRS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'golden-init-'));
  try {
    ensureInitializedDataDir({ projectRoot: dir, dataDir: join(dir, 'data') });
    const walk = (p, rel = '') =>
      readdirSync(p).flatMap((e) => {
        const full = join(p, e);
        const r = rel ? `${rel}/${e}` : e;
        return statSync(full).isDirectory() ? [r, ...walk(full, r)] : [];
      });
    const dirs = walk(join(dir, 'data')).sort();
    pin('ids-init-subdirs', { rename: 'changes', alias: 'A-01' }, dirs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Prefix behavior: the allocator uses the KIND_TABLE prefix only in scanMax(), to seed from
// files already on disk. Empty-dir pins above cannot see a changed prefix, so these pins seed
// existing files per kind and record what `next-id <kind>` returns today.
function seeded(kind, files) {
  return nextIds(kind, 1, (d) => {
    const kd = join(d, 'spec', kind);
    mkdirSync(kd, { recursive: true });
    for (const f of files) writeFile(join(kd, f), '---\nid: x\n---\n');
  });
}
test('next-id features seeds from existing F042-x.md', () => {
  pin('ids-seeded-features', { rename: 'changes', alias: 'A-06' }, seeded('features', ['F042-x.md']));
});
test('next-id ideas seeds from existing IDEA-007-x.md', () => {
  pin('ids-seeded-ideas', { rename: 'identical', alias: 'A-06' }, seeded('ideas', ['IDEA-007-x.md']));
});
test('next-id epics seeds from existing E003-x.md', () => {
  pin('ids-seeded-epics', { rename: 'identical', alias: 'A-06' }, seeded('epics', ['E003-x.md']));
});
test('next-id tasks seeds from existing T010-x.md', () => {
  pin('ids-seeded-tasks', { rename: 'changes', alias: 'A-06' }, seeded('tasks', ['T010-x.md']));
});
// Known current-behavior defect (reported, not fixed): next-id bugs scans for the `B-` prefix
// but ship-bug writes `B<NNN>-slug.md` (doctor's idRe is ^B\d+$), so an existing B005 file is
// ignored and the allocator returns 001 -- it can re-issue a live bug id.
test('next-id bugs ignores BNNN files (defect)', () => {
  pin('ids-seeded-bugs-bnnn', { rename: 'changes', alias: 'A-06' }, seeded('bugs', ['B005-x.md']));
});
test('next-id bugs sees legacy B-NNN files', () => {
  pin('ids-seeded-bugs-legacy-dash', { rename: 'changes', alias: 'A-06' }, seeded('bugs', ['B-001-x.md']));
});
// Mixed prefixes: files of an unrelated prefix in the same dir are ignored; the matching ones count.
test('next-id features ignores a foreign-prefixed file next to a matching one', () => {
  pin('ids-seeded-features-mixed', { rename: 'changes', alias: 'A-06' }, seeded('features', ['F042-x.md', 'S090-x.md']));
});
test('next-id tasks ignores a foreign-prefixed file next to a matching one', () => {
  pin('ids-seeded-tasks-mixed', { rename: 'changes', alias: 'A-06' }, seeded('tasks', ['T010-x.md', 'P099-x.md']));
});
