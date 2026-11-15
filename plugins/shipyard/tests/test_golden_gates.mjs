// Characterization pins (pre-rename): verify-ac-coverage results and the terminal gate
// (allowed/refused, with refusal reasons), driven through the real CLIs against temp fixtures.
// AC-3: coverage results + terminal gate captured from the unmodified tree.
// AC-5: pins pass before any rename. AC-6: every pin declares rename + alias row id.
// Alias note: terminology-v4 has no row for sprint gates; A-01 (feature = unit carrying the
// @AC tags) is used for verify-ac-coverage and A-02 (task = builder unit the gate counts) for
// the terminal gate.
// AC-1/AC-2: gate pins also cover ship-review, structural refusals and non-happy coverage exits.
// Rename tags: `identical` only where the recorded output contains no term terminology-v4 retires.
// Normalized in recorded output: temp data dir -> <DIR>, temp repo -> <REPO>, git SHAs -> <BASE>/<HEAD>.
import { test } from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pin } from './lib/golden.mjs';
import { getProjectHash } from '../bin/shipyard-resolver.mjs';
import { FULL_SUITE_KEY, recordVerification } from '../bin/verify-ledger.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const DATA = join(BIN, 'shipyard-data.mjs');
const CTX = join(BIN, 'shipyard-context.mjs');

function git(cwd, ...a) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
// Env points CLAUDE_PLUGIN_DATA at the temp plugin-data root; the data dir is <root>/projects/<hash(repo)>.
function withDirs(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'golden-gates-')));
  try {
    const repo = join(root, 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q');
    const pluginData = join(root, 'pd');
    const dir = join(pluginData, 'projects', getProjectHash(repo));
    for (const d of ['sprints/current', 'spec/features', 'verify']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, '.project-root'), repo + '\n');
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: pluginData };
    // Resolver-affecting vars: CLAUDE_PROJECT_DIR makes the resolver run git from that dir
    // before cwd (Claude Code sets it for hooks), so a leaked value breaks every pin.
    delete env.SHIPYARD_DATA;
    delete env.CLAUDE_PROJECT_DIR;
    return fn({ repo, dir, env });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function norm(s, subs) {
  let out = s;
  for (const [from, to] of subs) out = out.split(from).join(to);
  return out.trim();
}
function sprint(dir, features, waves = '### Wave 1\nTasks: [T001, T002]\n\n### Wave 2\nTasks: [T003]\n') {
  writeFileSync(join(dir, 'sprints', 'current', 'SPRINT.md'),
    `---\nid: sprint-001\nstatus: in-progress\ngoal: "g"\ncapacity: 20\nfeatures: [${features.join(', ')}]\nbranch: main\ncreated: 2026-05-19\nstarted_at: 2026-05-19T00:00:00Z\n---\n\n# Sprint 001\n\n## Waves\n\n${waves}\n## Critical Path\nT001 -> T003\n`);
}
function feature(dir, id, acBody) {
  writeFileSync(join(dir, 'spec', 'features', `${id}-x.md`), `---\nid: "${id}"\ntitle: "x"\nstatus: planned\n---\n\n# x\n\n## Acceptance Criteria\n\n${acBody}\n\n## Technical Notes\n\nn/a\n`);
}
const TAGGED = '  @AC-1\n  Scenario: one\n    Given a\n\n  @AC-2\n  Scenario: two\n    Given b\n';
const UNTAGGED = '  Scenario: one\n    Given a\n';

// Build a sprint repo: base commit, then a head commit whose diff contains `marker` lines.
function coverage(markers, { features, enforce }) {
  return withDirs(({ repo, dir, env }) => {
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'b.txt'), markers.map((m) => `// ${m}\n`).join('') + 'code\n');
    git(repo, 'add', 'b.txt');
    git(repo, 'commit', '-q', '-m', 'head');
    const head = git(repo, 'rev-parse', 'HEAD');
    sprint(dir, Object.keys(features));
    for (const [id, body] of Object.entries(features)) feature(dir, id, body);
    if (enforce !== undefined) writeFileSync(join(dir, 'config.md'), `---\nexecution:\n  enforce_ac_coverage: ${enforce}\n---\n`);
    const r = spawnSync('node', [DATA, 'verify-ac-coverage', '--base', base, '--head', head, ], { cwd: repo, encoding: 'utf8', env });
    const subs = [[base, '<BASE>'], [head, '<HEAD>'], [dir, '<DIR>'], [repo, '<REPO>']];
    return { code: r.status, stdout: norm(r.stdout ?? '', subs), stderr: norm(r.stderr ?? '', subs) };
  });
}

test('verify-ac-coverage: tagged feature fully covered -> OK exit 0', () => {
  pin('gates-ac-covered', { rename: 'changes', alias: 'A-01' }, coverage(['AC-1', 'AC-2'], { features: { F001: TAGGED } }));
});
test('verify-ac-coverage: orphan AC hard-fails (enforce default true)', () => {
  pin('gates-ac-orphan-enforced', { rename: 'identical', alias: 'A-01' }, coverage(['AC-1'], { features: { F001: TAGGED } }));
});
test('verify-ac-coverage: orphan with enforce_ac_coverage true explicit', () => {
  pin('gates-ac-orphan-enforce-true', { rename: 'identical', alias: 'A-01' }, coverage([], { features: { F001: TAGGED }, enforce: 'true' }));
});
test('verify-ac-coverage: orphan with enforce_ac_coverage false is advisory exit 0', () => {
  pin('gates-ac-orphan-enforce-false', { rename: 'identical', alias: 'A-01' }, coverage([], { features: { F001: TAGGED }, enforce: 'false' }));
});
test('verify-ac-coverage: untagged feature is advisory WARN', () => {
  pin('gates-ac-untagged-warn', { rename: 'changes', alias: 'A-01' }, coverage([], { features: { F001: UNTAGGED } }));
});
test('verify-ac-coverage: mixed tagged-covered + untagged', () => {
  pin('gates-ac-mixed', { rename: 'changes', alias: 'A-01' }, coverage(['AC-1', 'AC-2'], { features: { F001: TAGGED, F002: UNTAGGED } }));
});

// --- terminal gate (shipyard-context terminal-gate ship-execute) ---
function gate(events, { waves, noSprint } = {}) {
  return withDirs(({ repo, dir, env }) => {
    if (!noSprint) sprint(dir, ['F001'], waves);
    if (events) {
      writeFileSync(join(dir, '.shipyard-events.jsonl'),
        events.map((e) => JSON.stringify({ ts: '2026-05-19T00:00:00.000Z', ...e })).join('\n') + '\n');
    }
    const r = spawnSync('node', [CTX, 'terminal-gate', 'ship-execute'], { cwd: repo, encoding: 'utf8', env });
    const subs = [[dir, '<DIR>'], [repo, '<REPO>']];
    return { code: r.status, stdout: norm(r.stdout ?? '', subs), stderr: norm(r.stderr ?? '', subs) };
  });
}
const tick = (n) => ({ type: 'pipeline_tick_completed', pipeline: 'ship-execute', stage: `wave_${n}_gate` });
const done = (t) => ({ type: 'task_dispatch_returned', pipeline: 'ship-execute', status: 'complete', task_id: t, commit_sha: 'abc' });
const passed = { type: 'sprint_complete_passed', sprint_id: 'sprint-001' };
// F028: the fixture story's per-story review is settled, so pins recorded before F028 stay byte-identical.
const reviewed = { type: 'story_reviewed', story: 'F001', sprint: 'sprint-001', verdict: 'approve' };

test('terminal gate: all evidence present -> ALLOW', () => {
  pin('gates-terminal-allow', { rename: 'identical', alias: 'A-02' }, gate([tick(1), tick(2), done('T001'), done('T002'), done('T003'), passed, reviewed]));
});
test('terminal gate: no events log -> DENY with every missing item', () => {
  pin('gates-terminal-deny-no-events', { rename: 'changes', alias: 'A-02' }, gate(null));
});
test('terminal gate: one wave gate missing', () => {
  pin('gates-terminal-deny-wave-gate', { rename: 'identical', alias: 'A-02' }, gate([tick(1), done('T001'), done('T002'), done('T003'), passed, reviewed]));
});
test('terminal gate: parked ratio over cap -> DENY', () => {
  pin('gates-terminal-deny-parked-ratio', { rename: 'changes', alias: 'A-02' }, gate([tick(1), tick(2), done('T001'),
    { type: 'task_blocked', task_id: 'T002', reason: 'persistent_failure' },
    { type: 'task_blocked', task_id: 'T003', reason: 'salvage_failed' }, passed, reviewed]));
});
test('terminal gate: parked over cap but terminal_parked_accepted -> ALLOW', () => {
  pin('gates-terminal-allow-parked-accepted', { rename: 'identical', alias: 'A-02' }, gate([tick(1), tick(2), done('T001'),
    { type: 'task_blocked', task_id: 'T002', reason: 'persistent_failure' },
    { type: 'task_blocked', task_id: 'T003', reason: 'salvage_failed' },
    { type: 'terminal_parked_accepted', accepted_by: 'user' }, passed, reviewed]));
});
test('terminal gate: sprint_complete_passed missing', () => {
  pin('gates-terminal-deny-no-sprint-complete', { rename: 'identical', alias: 'A-02' }, gate([tick(1), tick(2), done('T001'), done('T002'), done('T003'), reviewed]));
});

test('terminal gate: no SPRINT.md -> structural DENY', () => {
  pin('gates-terminal-deny-no-sprint-md', { rename: 'identical', alias: 'A-02' }, gate(null, { noSprint: true }));
});
test('terminal gate: SPRINT.md without ### Wave headings -> structural DENY', () => {
  pin('gates-terminal-deny-no-waves', { rename: 'identical', alias: 'A-02' }, gate([passed], { waves: 'No waves here.\n' }));
});
test('terminal gate: one task parked, under the parked-ratio cap -> ALLOW', () => {
  pin('gates-terminal-allow-parked-under-cap', { rename: 'changes', alias: 'A-02' }, gate([tick(1), tick(2), done('T001'), done('T002'),
    { type: 'task_blocked', task_id: 'T003', reason: 'persistent_failure' }, passed, reviewed]));
});

// --- verify-ac-coverage non-happy results ---
function rawCoverage({ args, setup }) {
  return withDirs(({ repo, dir, env }) => {
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    if (setup) setup(dir);
    const r = spawnSync('node', [DATA, 'verify-ac-coverage', ...args(base)], { cwd: repo, encoding: 'utf8', env });
    const subs = [[base, '<BASE>'], [dir, '<DIR>'], [repo, '<REPO>']];
    return { code: r.status, stdout: norm(r.stdout ?? '', subs), stderr: norm(r.stderr ?? '', subs) };
  });
}
test('verify-ac-coverage: missing --base -> exit 2', () => {
  pin('gates-ac-no-base', { rename: 'identical', alias: 'A-01' }, rawCoverage({ args: () => [], setup: (d) => sprint(d, ['F001']) }));
});
test('verify-ac-coverage: no SPRINT.md -> exit 2', () => {
  pin('gates-ac-no-sprint-md', { rename: 'identical', alias: 'A-01' }, rawCoverage({ args: (b) => ['--base', b] }));
});
test('verify-ac-coverage: zero feature ids parsed -> exit 3', () => {
  pin('gates-ac-zero-features', { rename: 'identical', alias: 'A-01' }, rawCoverage({ args: (b) => ['--base', b], setup: (d) => sprint(d, []) }));
});
// Known current-behavior defect (reported, not fixed): a sprint feature whose file is missing is
// only a WARN and the gate still passes with exit 0 instead of failing closed.
test('verify-ac-coverage: feature file not found -> WARN then OK exit 0 (defect)', () => {
  pin('gates-ac-feature-file-missing', { rename: 'changes', alias: 'A-01' }, rawCoverage({ args: (b) => ['--base', b], setup: (d) => sprint(d, ['F009']) }));
});

// --- review terminal gate (shipyard-context terminal-gate ship-review) ---
function reviewGate({ stage, events, verdicts, proof }) {
  return withDirs(({ repo, dir, env }) => {
    sprint(dir, ['F001', 'F002']);
    if (events) {
      writeFileSync(join(dir, '.shipyard-events.jsonl'),
        events.map((e) => JSON.stringify({ ts: '2026-05-19T00:00:00.000Z', ...e })).join('\n') + '\n');
    }
    for (const [fid, rec] of Object.entries(verdicts ?? {})) {
      writeFileSync(join(dir, 'verify', `${fid}-verdict.md`), `---\nfeature: ${fid}\nrecommendation: ${rec}\n---\n\n# verdict\n`);
    }
    if (proof) {
      writeFileSync(join(repo, 'a.txt'), 'content\n');
      git(repo, 'add', '-A');
      git(repo, 'commit', '-q', '-m', 'init');
      const capture = join(dir, 'capture.log'); // outside the repo so the tree stays clean
      writeFileSync(capture, 'all green\n');
      const rec = recordVerification(dir, { key: FULL_SUITE_KEY, command: 'full test suite', exitCode: 0, capturePath: capture });
      if (!rec.ok) throw new Error('fixture setup failed: ' + rec.message);
    }
    const r = spawnSync('node', [CTX, 'terminal-gate', 'ship-review', ...(stage ? [stage] : [])], { cwd: repo, encoding: 'utf8', env });
    const subs = [[dir, '<DIR>'], [repo, '<REPO>']];
    return { code: r.status, stdout: norm(r.stdout ?? '', subs), stderr: norm(r.stderr ?? '', subs) };
  });
}
const demo = { type: 'pipeline_tick_completed', pipeline: 'ship-review', stage: 'demo_user' };
test('review terminal gate: approve verdicts + demo_user + fresh proof -> ALLOW', () => {
  pin('gates-review-allow', { rename: 'identical', alias: 'A-01' }, reviewGate({ events: [demo], verdicts: { F001: 'approve', F002: 'approve' }, proof: true }));
});
test('review terminal gate: nothing recorded -> DENY with every reason', () => {
  pin('gates-review-deny-empty', { rename: 'changes', alias: 'A-01' }, reviewGate({}));
});
test('review terminal gate: a verdict recommends changes -> DENY', () => {
  pin('gates-review-deny-verdict-changes', { rename: 'changes', alias: 'A-01' }, reviewGate({ events: [demo], verdicts: { F001: 'approve', F002: 'changes' }, proof: true }));
});
test('review terminal gate: terminal_changes without escalation evidence -> DENY', () => {
  pin('gates-review-deny-terminal-changes', { rename: 'changes', alias: 'A-01' }, reviewGate({ stage: 'terminal_changes', events: [demo] }));
});

// AC-5: harness hermeticity -- a CLAUDE_PROJECT_DIR pointing at an unrelated repo must not
// change any gate result (the pins below re-run against the recorded fixtures).
test('pins are hermetic when CLAUDE_PROJECT_DIR is set to an unrelated dir', () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'golden-unrelated-')));
  const prev = process.env.CLAUDE_PROJECT_DIR;
  try {
    git(other, 'init', '-q');
    process.env.CLAUDE_PROJECT_DIR = other;
    pin('gates-terminal-allow', { rename: 'identical', alias: 'A-02' }, gate([tick(1), tick(2), done('T001'), done('T002'), done('T003'), passed, reviewed]));
    pin('gates-ac-covered', { rename: 'changes', alias: 'A-01' }, coverage(['AC-1', 'AC-2'], { features: { F001: TAGGED } }));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PROJECT_DIR; else process.env.CLAUDE_PROJECT_DIR = prev;
    rmSync(other, { recursive: true, force: true });
  }
});
