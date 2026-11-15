// Characterization pins (pre-rename): feature + idea spec-state transition tables, refusals,
// and the ABSENCE of bug/epic transition tables.
// AC-2: transition tables and refusals captured from the unmodified tree.
// AC-5: pins pass before any rename. AC-6: every pin declares rename + alias row id.
// Alias note: A-01 = feature unit, A-04 = bugs, A-07 = idea lifecycle, A-08 = epic lifecycle
// (A-07/A-08 are PROPOSED rows, terminology-v4 D-9/D-10).
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pin } from './lib/golden.mjs';
import * as lifecycle from '../bin/spec-lifecycle.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shipyard-data.mjs');
const TEMPLATES = join(dirname(fileURLToPath(import.meta.url)), '..', 'project-files', 'templates');
const F_STATUSES = Object.keys(lifecycle.FEATURE_TRANSITIONS);
const I_STATUSES = Object.keys(lifecycle.IDEA_TRANSITIONS);

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'golden-spec-state-'));
  try {
    for (const s of ['features', 'ideas', 'epics', 'bugs']) mkdirSync(join(dir, 'spec', s), { recursive: true });
    mkdirSync(join(dir, 'backlog'), { recursive: true });
    writeFileSync(join(dir, 'backlog', 'BACKLOG.md'), readFileSync(join(TEMPLATES, 'BACKLOG.md'), 'utf8'));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function run(dir, args) {
  const r = spawnSync('node', [BIN, ...args, '--data-dir', dir], { encoding: 'utf8' });
  const norm = (s) => s.split(dir).join('<DIR>').trim();
  return { code: r.status, stdout: norm(r.stdout ?? ''), stderr: norm(r.stderr ?? '') };
}
// Keep only the refusal head; the trailing usage list changes whenever any verb is added.
function head(r) {
  return { code: r.code, stdout: r.stdout, stderr: r.stderr.split('. Expected:')[0] };
}
function seed(dir, kind, id, status) {
  writeFileSync(join(dir, 'spec', kind, `${id}-x.md`), `---\nid: "${id}"\ntitle: "x"\nstatus: ${status}\n---\n\nbody\n` + "\n## Paths\n| Ending | Covered by |\n|---|---|\n| works | @AC-1 |\n\n## Acceptance Criteria\n```gherkin\n@AC-1 @e2e\nScenario: works\n  Given a\n  When b\n  Then c\n```\n");
}

test('feature transition table + backlog-removing statuses', () => {
  pin('spec_state-feature-table', { rename: 'changes', alias: 'A-01' }, {
    table: lifecycle.FEATURE_TRANSITIONS,
    backlogRemoving: [...lifecycle.BACKLOG_REMOVING_STATUSES].sort(),
  });
});
test('idea transition table', () => {
  pin('spec_state-idea-table', { rename: 'changes', alias: 'A-07' }, lifecycle.IDEA_TRANSITIONS);
});
test('validateStatusTransition matrix incl. unknown from/to', () => {
  const out = {};
  for (const [name, g, sts] of [['feature', lifecycle.FEATURE_TRANSITIONS, F_STATUSES], ['idea', lifecycle.IDEA_TRANSITIONS, I_STATUSES]]) {
    out[name] = {};
    for (const from of [...sts, 'bogus']) for (const to of [...sts, 'bogus']) {
      out[name][`${from}->${to}`] = lifecycle.validateStatusTransition(g, from, to);
    }
  }
  pin('spec_state-validate-matrix-feature', { rename: 'changes', alias: 'A-01' }, out.feature);
  pin('spec_state-validate-matrix-idea', { rename: 'changes', alias: 'A-07' }, out.idea);
});
test('feature set-status CLI matrix (every from x to, no force)', () => {
  const out = {};
  withDir((dir) => {
    for (const from of F_STATUSES) for (const to of F_STATUSES) {
      seed(dir, 'features', 'F001', from);
      const r = run(dir, ['feature', 'set-status', 'F001', to]);
      out[`${from}->${to}`] = { code: r.code, stdout: r.stdout, stderr: r.stderr };
    }
  });
  pin('spec_state-feature-cli-matrix', { rename: 'changes', alias: 'A-01' }, out);
});
test('feature set-status refusals: unknown status, usage, missing, bad id, force', () => {
  const out = withDir((dir) => {
    const cases = {
      unknownStatus: ['feature', 'set-status', 'F001', 'bogus'],
      unknownStatusForce: ['feature', 'set-status', 'F001', '--force', 'bogus'],
      usage: ['feature', 'set-status', 'F001'],
      badId: ['feature', 'set-status', 'nope', 'approved'],
      missingFeature: ['feature', 'set-status', 'F999', 'approved'],
      forceIllegal: ['feature', 'set-status', 'F001', '--force', 'released'],
      forceToProposed: ['feature', 'set-status', 'F001', 'proposed', '--force'],
      legalProposedToDeferred: ['feature', 'set-status', 'F001', 'deferred'],
      unknownSub: ['feature', 'nope'],
    };
    const o = {};
    for (const [k, a] of Object.entries(cases)) {
      seed(dir, 'features', 'F001', 'proposed');
      o[k] = run(dir, a);
    }
    return o;
  });
  pin('spec_state-feature-cli-refusals', { rename: 'changes', alias: 'A-01' }, out);
});
test('idea set-status CLI matrix + refusals', () => {
  const out = withDir((dir) => {
    seed(dir, 'features', 'F001', 'proposed');
    const o = {};
    for (const from of I_STATUSES) {
      for (const [label, a] of [
        ['graduated', ['graduated', '--to', 'F001']],
        ['rejected', ['rejected']],
        ['graduated-no-to', ['graduated']],
        ['rejected-with-to', ['rejected', '--to', 'F001']],
        ['graduated-bad-to', ['graduated', '--to', 'X1']],
        ['graduated-missing-to', ['graduated', '--to', 'F999']],
        ['bogus', ['bogus']],
        ['proposed', ['proposed']],
      ]) {
        seed(dir, 'ideas', 'IDEA-001', from);
        const r = run(dir, ['idea', 'set-status', 'IDEA-001', ...a]);
        o[`${from}:${label}`] = r;
      }
    }
    o['usage'] = run(dir, ['idea', 'set-status', 'IDEA-001']);
    o['badId'] = run(dir, ['idea', 'set-status', 'nope', 'rejected']);
    o['missing'] = run(dir, ['idea', 'set-status', 'IDEA-999', 'rejected']);
    return o;
  });
  pin('spec_state-idea-cli', { rename: 'changes', alias: 'A-07' }, out);
});
test('absence: no bug transition table or set-status verb', () => {
  const out = withDir((dir) => {
    seed(dir, 'bugs', 'B001', 'open');
    return {
      lifecycleExports: Object.keys(lifecycle).sort(),
      bugTable: 'BUG_TRANSITIONS' in lifecycle,
      bugSetStatus: head(run(dir, ['bug', 'set-status', 'B001', 'fixed'])),
    };
  });
  pin('spec_state-absent-bug', { rename: 'changes', alias: 'A-04' }, out);
});
test('absence: no epic transition table or set-status verb', () => {
  const out = withDir((dir) => {
    seed(dir, 'epics', 'E001', 'open');
    return {
      epicTable: 'EPIC_TRANSITIONS' in lifecycle,
      epicSetStatus: head(run(dir, ['epic', 'set-status', 'E001', 'done'])),
    };
  });
  pin('spec_state-absent-epic', { rename: 'changes', alias: 'A-08' }, out);
});
