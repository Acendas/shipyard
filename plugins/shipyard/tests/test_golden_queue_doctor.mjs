// Characterization pins (pre-rename): the worker queue (enqueue/claim/complete/fail outputs) and
// the doctor registry rules (REGISTRY_ENTITY_RULES), driven through the real CLI against temp fixtures.
// AC-3 (part 2): queue + doctor output captured from the unmodified tree.
// AC-5: pins pass before any rename. AC-6: every pin declares rename + alias row id.
// AC-3 (part 2) covers the per-kind REGISTRY_ENTITY_RULES matrices (every required key, status, id regex).
// Alias note: terminology-v4 has no row for the queue or doctor rules themselves. A-02 (task = the
// builder unit the queue carries) is the nearest row for the queue pins. The doctor per-kind matrices
// cite the row of their entity kind: A-01 features, A-02 tasks, A-04 bugs, A-07 ideas, A-08 epics;
// the mixed all-kinds pins cite A-01. A-07/A-08 are PROPOSED rows (terminology-v4 D-9/D-10).
// Normalized in recorded output: temp root/data dir -> <ROOT>/<DIR>, ISO timestamps -> <TS>,
// backslashes -> '/', and doctor findings are sorted (scanRegistry emits raw readdir order).
import { test } from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { pin } from './lib/golden.mjs';
import { withoutUserSettings } from './lib/no-user-settings.mjs';
import * as lifecycle from '../bin/spec-lifecycle.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shipyard-data.mjs');

function norm(s, subs) {
  let out = s;
  for (const [from, to] of subs) out = out.split(from).join(to);
  return out.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<TS>').trim();
}

// Queue project: repo + CLAUDE_PLUGIN_DATA root, data dir created by `init` (never the real one).
function withQueue(fn, extraConfig) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'golden-queue-')));
  try {
    const repo = join(root, 'repo');
    const data = join(root, 'data');
    mkdirSync(repo, { recursive: true });
    mkdirSync(data, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: data };
    delete env.SHIPYARD_DATA;
    delete env.CLAUDE_PROJECT_DIR; // resolver starts git from it before cwd
    const raw = (args) => spawnSync('node', [CLI, ...args], { cwd: repo, env, encoding: 'utf8' });
    const init = raw(['init']);
    const dir = init.stdout.trim();
    if (init.status !== 0 || !isAbsolute(dir)) throw new Error('fixture setup failed: ' + init.stderr);
    if (extraConfig) extraConfig(dir);
    const subs = [[dir, '<DIR>'], [repo, '<REPO>'], [root, '<ROOT>']];
    const run = (args) => {
      const r = raw(args);
      return { code: r.status, stdout: norm(r.stdout ?? '', subs), stderr: norm(r.stderr ?? '', subs) };
    };
    return fn({ root, repo, dir, run });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const Q = ['--pipeline', 'ship-execute', '--stage', 'wave_1_dispatch'];
function enqueue(root, run, tasks, extra = []) {
  const input = join(root, 'tasks.json');
  writeFileSync(input, JSON.stringify(tasks));
  return run(['queue', 'enqueue', ...Q, '--input', input, ...extra]);
}
function artifact(path, id, fields = {}) {
  const capture = join(dirname(path), `${id}-capture.log`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(capture, 'probe output\n');
  writeFileSync(path, JSON.stringify({ task: id, status: 'COMPLETE', commit_sha: 'abc1234', probe_exit_code: 0,
    output_tail: 'probe output', capture_file: capture, escalation_code: null, ...fields }));
}

test('queue: enqueue/claim/complete/list lifecycle', () => {
  pin('queue_doctor-queue-lifecycle', { rename: 'changes', alias: 'A-02' }, withQueue(({ root, run }) => {
    const res = {};
    res.enqueue = enqueue(root, run, [{ id: 'T001', kind: 'build', files: ['src/a.ts'] }]);
    res.claim = run(['queue', 'claim', ...Q, '--worker', 'w1']);
    res.claimSecondWorker = run(['queue', 'claim', ...Q, '--worker', 'w2']);
    const result = join(root, 'T001-result.json');
    artifact(result, 'T001');
    res.complete = run(['queue', 'complete', 'T001', ...Q, '--worker', 'w1', '--result', result]);
    res.list = run(['queue', 'list', ...Q]);
    return res;
  }));
});

test('queue: critical_path ordering is longest-effort-first (claim order)', () => {
  pin('queue_doctor-queue-critical-path-order', { rename: 'changes', alias: 'A-02' }, withQueue(({ root, run }) => {
    const res = {};
    res.enqueue = enqueue(root, run, [{ id: 'T001', effort: 'S' }, { id: 'T002', effort: 'M' }, { id: 'T003', effort: 'XL' }, { id: 'T004', effort: 'L' }, { id: 'T005' }]);
    res.claims = [];
    for (let i = 0; i < 5; i++) res.claims.push(run(['queue', 'claim', ...Q, '--worker', `w${i}`]));
    return res;
  }));
});

test('queue: enqueue refuses when --require-isolation resolves to none', () => {
  pin('queue_doctor-queue-require-isolation-none', { rename: 'identical', alias: 'A-02' }, withQueue(({ root, run }) => {
    const res = {};
    res.refusedFlagNone = enqueue(root, run, [{ id: 'T001' }], ['--require-isolation', 'none']);
    res.refusedFlagFalse = enqueue(root, run, [{ id: 'T001' }], ['--require-isolation', 'false']);
    res.invalidValue = enqueue(root, run, [{ id: 'T001' }], ['--require-isolation', 'bogus']);
    res.allowedWorktree = enqueue(root, run, [{ id: 'T001' }], ['--require-isolation', 'worktree']);
    return res;
  }));
});

test('queue: claim of an empty queue', () => {
  pin('queue_doctor-queue-claim-empty', { rename: 'changes', alias: 'A-02' }, withQueue(({ run }) => ({
    claim: run(['queue', 'claim', ...Q, '--worker', 'w1']),
    list: run(['queue', 'list', ...Q]),
  })));
});

test('queue: complete refuses bad artifacts and wrong worker', () => {
  pin('queue_doctor-queue-complete-refusals', { rename: 'changes', alias: 'A-02' }, withQueue(({ root, dir, run }) => {
    const res = {};
    enqueue(root, run, [{ id: 'T001', expected_artifact: 'returns/T001.json' }]);
    run(['queue', 'claim', ...Q, '--worker', 'w1']);
    const expected = join(dir, 'sprints', 'current', 'returns', 'T001.json');
    const complete = (path, worker = 'w1') => run(['queue', 'complete', 'T001', ...Q, '--worker', worker, '--result', path]);
    const wrong = join(root, 'wrong.json');
    artifact(wrong, 'T001');
    res.wrongWorker = complete(wrong, 'w2');
    res.wrongPath = complete(wrong);
    mkdirSync(dirname(expected), { recursive: true });
    writeFileSync(expected, '{not-json');
    res.badJson = complete(expected);
    artifact(expected, 'OTHER');
    res.mismatchedId = complete(expected);
    artifact(expected, 'T001', { capture_file: 'relative.log' });
    res.relativeCapture = complete(expected);
    res.missingArtifact = complete(join(root, 'nope.json'));
    res.stillClaimed = run(['queue', 'list', ...Q]);
    return res;
  }));
});

test('queue: fail records terminal failure and refuses unclaimed', () => {
  pin('queue_doctor-queue-fail', { rename: 'changes', alias: 'A-02' }, withQueue(({ root, run }) => {
    const res = {};
    enqueue(root, run, [{ id: 'T001' }]);
    const fail = (worker) => run(['queue', 'fail', 'T001', ...Q, '--worker', worker, '--reason', 'blocked on migration choice']);
    res.failUnclaimed = fail('w1');
    run(['queue', 'claim', ...Q, '--worker', 'w1']);
    res.failWrongWorker = fail('w2');
    res.fail = fail('w1');
    res.failAgain = fail('w1');
    res.list = run(['queue', 'list', ...Q]);
    return res;
  }));
});

// --- doctor registry rules ---
// scanRegistry emits findings in raw readdir order (ext4 = hash order, APFS = sorted), so the
// finding blocks are sorted here; output is also made separator-neutral for Windows.
function sortDoctor(stdout) {
  const blocks = stdout.replace(/\\/g, '/').split('\n\n');
  return [blocks[0], ...blocks.slice(1).sort()].join('\n\n');
}
function withDoctor(files) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'golden-doctor-')));
  try {
    const d = join(base, 'projects', 'abc123abc123');
    mkdirSync(join(d, 'templates'), { recursive: true });
    writeFileSync(join(d, '.project-root'), '/nonexistent\n');
    writeFileSync(join(d, 'config.md'), '---\nmodels:\n  think: opus\n  build: sonnet\n  light: haiku\n---\n\n# Config\n');
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(d, rel)), { recursive: true });
      writeFileSync(join(d, rel), body);
    }
    const env = withoutUserSettings(base);
    delete env.CLAUDE_PROJECT_DIR;
    const r = spawnSync('node', [CLI, 'doctor', '--data-dir', d, '--full'], { encoding: 'utf8', env });
    const subs = [[d, '<DIR>'], [base, '<BASE>']];
    return { code: r.status, stdout: sortDoctor(norm(r.stdout ?? '', subs)), stderr: norm(r.stderr ?? '', subs) };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
const fm = (o) => '---\n' + Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n\n# x\n';
const FEATURE = { id: '"F001"', title: '"x"', type: 'feature', epic: '"E001"', status: 'approved', story_points: 3, complexity: 'M',
  token_estimate: 1000, rice_reach: 1, rice_impact: 1, rice_confidence: 1, rice_effort: 1, rice_score: 1,
  dependencies: '[]', references: '[]', tasks: '[]', created: 2026-11-12 };
const TASK = { id: '"T001"', title: '"x"', feature: '"F001"', status: 'pending', effort: 'S', dependencies: '[]' };
const BUG = { id: '"B001"', title: '"x"', status: 'open', severity: 'low' };
const IDEA = { id: '"IDEA-001"', title: '"x"', status: 'captured' };
const EPIC = { id: '"E001"', title: '"x"', status: 'planned' };
const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };

test('doctor: clean registry (every entity kind valid)', () => {
  pin('queue_doctor-doctor-registry-clean', { rename: 'identical', alias: 'A-01' }, withDoctor({
    'spec/features/F001-x.md': fm(FEATURE),
    'spec/tasks/T001-x.md': fm(TASK),
    'spec/bugs/B001-x.md': fm(BUG),
    'spec/ideas/IDEA-001-x.md': fm(IDEA),
    'spec/epics/E001-x.md': fm(EPIC),
  }));
});

test('doctor: each registry violation kind (missing field, invalid status, bad id)', () => {
  pin('queue_doctor-doctor-registry-violations', { rename: 'changes', alias: 'A-01' }, withDoctor({
    'spec/features/F001-missing.md': fm(without(FEATURE, 'rice_score')),
    'spec/features/F002-status.md': fm({ ...FEATURE, id: '"F002"', status: 'bogus' }),
    'spec/features/Fxx-id.md': fm({ ...FEATURE, id: '"FXX"' }),
    'spec/tasks/T001-missing.md': fm(without(TASK, 'effort')),
    'spec/tasks/T002-status.md': fm({ ...TASK, id: '"T002"', status: 'done-ish' }),
    'spec/tasks/bad-id.md': fm({ ...TASK, id: '"task1"' }),
    'spec/bugs/B001-missing.md': fm({ id: '"B001"', title: '"x"', status: 'open' }),
    'spec/bugs/B-bad.md': fm({ id: '"BUG-1"', title: '"x"', status: 'open', severity: 'low' }),
    'spec/ideas/IDEA-001-missing.md': fm({ id: '"IDEA-001"', status: 'captured' }),
    'spec/ideas/idea-bad.md': fm({ id: '"I-9"', title: '"x"', status: 'captured' }),
    'spec/epics/E001-missing.md': fm({ id: '"E001"', title: '"x"' }),
    'spec/epics/E-bad.md': fm({ id: '"EPIC1"', title: '"x"', status: 'planned' }),
  }));
});

// --- full REGISTRY_ENTITY_RULES matrix, one pin per kind ---
// Keys/statuses/id examples are listed here; the drift test below fails if the CLI's rules change.
const KINDS = {
  features: { dir: 'features', alias: 'A-01', base: FEATURE, idPrefix: 'F', anyOf: ['tasks'], statuses: Object.keys(lifecycle.FEATURE_TRANSITIONS),
    idOk: ['F1', 'F001', 'F036a', 'F071d'], idBad: ['FXX', 'F', 'F1A', 'F1ab', 'f001', 'F-1'] },
  tasks: { dir: 'tasks', alias: 'A-02', base: TASK, idPrefix: 'T', anyOf: ['feature'], statuses: ['pending', 'in-progress', 'done', 'blocked', 'needs-attention', 'approved', 'open', 'dropped'],
    idOk: ['T1', 'T001', 'T-001', 'T-HOT-12', 'Tab1'], idBad: ['T', 'T-', 'Tabc', 'T1a', 'task1', 't1'] },
  bugs: { dir: 'bugs', alias: 'A-04', base: BUG, idPrefix: 'B', statuses: null,
    idOk: ['B1', 'B001', 'B-001'], idBad: ['B', 'B-', 'B1a', 'BUG-1', 'b1'] },
  ideas: { dir: 'ideas', alias: 'A-07', base: IDEA, idPrefix: 'IDEA', statuses: null,
    idOk: ['IDEA-001', 'IDEA001', 'IDEA-1'], idBad: ['IDEA', 'IDEA-', 'IDEA-1a', 'idea-1', 'I-9'] },
  epics: { dir: 'epics', alias: 'A-08', base: EPIC, idPrefix: 'E', statuses: null,
    idOk: ['E1', 'E001'], idBad: ['E', 'E-1', 'E1a', 'EPIC1', 'e1'] },
};
const safe = (s) => s.replace(/[^A-Za-z0-9]/g, '_');

// Parse the sorted doctor output into case -> problems (an empty list means the file passed).
function matrix(res, kind, cases) {
  const found = {};
  const other = [];
  for (const block of res.stdout.split('\n\n').slice(1)) {
    const m = /^\s*\[registry-schema\] (\w+) <DIR>\/spec\/\w+\/(.+?)\.md — (.+?)(\n|$)/.exec(block);
    if (m) (found[m[2]] ??= []).push(m[3]); else other.push(block);
  }
  const out = { code: res.code, stderr: res.stderr, other, cases: {} };
  for (const c of cases) out.cases[c] = found[c] ?? [];
  return out;
}

function runMatrix(kind) {
  const k = KINDS[kind];
  const files = {};
  const cases = [];
  const add = (name, obj) => { cases.push(name); files[`spec/${k.dir}/${name}.md`] = fm(obj); };
  add('valid-base', k.base);
  for (const key of Object.keys(k.base)) {
    if (REQUIRED_KEYS[kind].includes(key)) add(`missing-${safe(key)}`, without(k.base, key));
  }
  if (k.statuses) for (const st of k.statuses) add(`status-ok-${safe(st)}`, { ...k.base, status: st });
  add('status-invalid', { ...k.base, status: 'bogus' }); // passes for kinds without statusValues
  for (const id of k.idOk) add(`id-ok-${safe(id)}`, { ...k.base, id: `"${id}"` });
  for (const id of k.idBad) add(`id-bad-${safe(id)}`, { ...k.base, id: `"${id}"` });
  return matrix(withDoctor(files), kind, cases);
}
// Literal pin calls (the golden guard statically requires a literal name and alias per pin).
test('doctor: features rules matrix (every required key, every status, id regex)', () => {
  pin('queue_doctor-doctor-matrix-features', { rename: 'changes', alias: 'A-01' }, runMatrix('features'));
});
test('doctor: tasks rules matrix (every required key, every status, id regex)', () => {
  pin('queue_doctor-doctor-matrix-tasks', { rename: 'changes', alias: 'A-02' }, runMatrix('tasks'));
});
test('doctor: bugs rules matrix (every required key, id regex; no statusValues)', () => {
  pin('queue_doctor-doctor-matrix-bugs', { rename: 'changes', alias: 'A-04' }, runMatrix('bugs'));
});
test('doctor: ideas rules matrix (every required key, id regex; no statusValues)', () => {
  pin('queue_doctor-doctor-matrix-ideas', { rename: 'changes', alias: 'A-07' }, runMatrix('ideas'));
});
test('doctor: epics rules matrix (every required key, id regex; no statusValues)', () => {
  pin('queue_doctor-doctor-matrix-epics', { rename: 'changes', alias: 'A-08' }, runMatrix('epics'));
});

// Drift guard: the matrices above enumerate the CLI's rules; fail if the rules change under them.
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shipyard-data.mjs'), 'utf8');
function ruleBlock(kind) {
  const start = SRC.indexOf(`\n  ${kind}: {`, SRC.indexOf('const REGISTRY_ENTITY_RULES'));
  const end = SRC.indexOf('\n  },', start);
  return SRC.slice(start, end);
}
const listOf = (block, field) => {
  const m = new RegExp(`${field}: \\[([^\\]]*)\\]`).exec(block);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
};
const REQUIRED_KEYS = Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, listOf(ruleBlock(kind), 'requiredKeys')]));

test('doctor matrices cover exactly the CLI REGISTRY_ENTITY_RULES', () => {
  assert.deepEqual(Object.keys(REQUIRED_KEYS), ['features', 'tasks', 'bugs', 'ideas', 'epics']);
  for (const [kind, k] of Object.entries(KINDS)) {
    const block = ruleBlock(kind);
    assert.deepEqual(REQUIRED_KEYS[kind], Object.keys(k.base).filter((key) => REQUIRED_KEYS[kind].includes(key)), `${kind} requiredKeys vs fixture base`);
    assert.deepEqual(Object.keys(k.base).filter((key) => !(k.anyOf ?? []).includes(key)).sort(), [...REQUIRED_KEYS[kind]].sort(), `${kind} fixture base must hold exactly the required keys (plus one any-of owner key)`);
    if (kind === 'tasks') assert.deepEqual(listOf(block, 'statusValues'), k.statuses);
    if (kind === 'features') assert.match(block, /statusValues: Object\.keys\(FEATURE_TRANSITIONS\)/);
    if (!k.statuses) assert.doesNotMatch(block, /statusValues/, `${kind} gained statusValues: add them to the matrix`);
    const idRe = /idRe: \/(.+)\/,/.exec(block)[1];
    const re = new RegExp(idRe);
    for (const id of k.idOk) assert.ok(re.test(id), `${kind} idOk ${id}`);
    for (const id of k.idBad) assert.ok(!re.test(id), `${kind} idBad ${id}`);
  }
});
