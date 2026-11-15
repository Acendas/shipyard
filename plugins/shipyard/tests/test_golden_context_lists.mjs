// Characterization pins (pre-rename): `shipyard-context list <kind>` and `count-of <kind>` for every
// registered kind (LIST_REGISTRY: epics, stories, features, ideas, debug-sessions; COUNT_REGISTRY:
// stories, steps, bugs, features, epics, ideas, tasks). quick-tasks retired with ship-quick (F024).
// AC-4: current behavior captured from the unmodified tree (SHIPYARD_GOLDEN_RECORD=1).
// AC-5: pins pass before any rename. AC-6: every pin declares rename + alias row id.
// Alias choices (terminology-v4): A-01 features, A-02 tasks, A-03 quick-tasks (Q-NNN), A-04 bugs,
// A-07 ideas (PROPOSED), A-08 epics (PROPOSED). Actual citations: every count-of pin cites A-01 (not
// A-02/A-04) as a generic row for the multi-kind refusal/edge pins. debug-sessions has no alias row (it is
// not a retired term); it is tagged 'identical' and cites A-01 only as a placeholder because the helper
// requires some row id.
// Retag rule: 'identical' only when the recorded output has no term F020 retires. Epic (E###) and idea
// (IDEA-###) are KEPT terms (terminology-v4 T-1/T-2 and id scheme), so the epics/ideas populated pins
// (filenames only; A-07/A-08 cover status values that `list` never prints) are 'identical'. Fallback
// strings naming retired kinds ("No features yet", "No quick tasks yet") make a pin 'changes'; so do
// pins whose ARGUMENTS are retired kinds (list-limits, count-empty, count-populated pass features/bugs/
// tasks) even though their recorded output is numbers only.
// Normalized: temp paths -> <ROOT>, backslashes -> '/', dir-list lines sorted (readdir order is
// platform-dependent) and, when a limit truncates, only the line count is recorded.
import { test } from 'node:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pin } from './lib/golden.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shipyard-context.mjs');

// Project: temp git repo + CLAUDE_PLUGIN_DATA root; CLAUDE_PROJECT_DIR is deleted (resolver would use it first).
function withProject(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'golden-ctxlists-')));
  try {
    const repo = join(root, 'repo');
    const plugin = join(root, 'plugin-data');
    mkdirSync(repo, { recursive: true });
    mkdirSync(plugin, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const env = { ...process.env, CLAUDE_PLUGIN_DATA: plugin };
    for (const k of ['CLAUDE_PROJECT_DIR', 'SHIPYARD_DATA', 'CLAUDE_PLUGIN_ROOT']) delete env[k];
    const raw = (args) => spawnSync('node', [CLI, ...args], { cwd: repo, env, encoding: 'utf8' });
    const p = raw(['path']);
    const dir = p.stdout.trim().replace(/^SHIPYARD_DATA=/, '');
    if (p.status !== 0 || !dir) throw new Error('fixture setup failed: ' + p.stderr);
    const norm = (s) => s.split(dir).join('<DIR>').split(repo).join('<REPO>').split(root).join('<ROOT>').replace(/\\/g, '/').trim();
    const write = (rel, body = 'x') => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), body);
    };
    const mkd = (rel) => mkdirSync(join(dir, rel), { recursive: true });
    const run = (args) => {
      const r = raw(args);
      return { code: r.status, stdout: norm(r.stdout ?? ''), stderr: norm(r.stderr ?? '') };
    };
    // Order-neutral view of a list: header-free sorted lines plus line count.
    const list = (args) => {
      const r = run(args);
      const lines = r.stdout === '' ? [] : r.stdout.split('\n');
      return { code: r.code, stderr: r.stderr, count: lines.length, lines: [...lines].sort() };
    };
    const countsOnly = (args) => {
      const r = run(args);
      return { code: r.code, stderr: r.stderr, count: r.stdout === '' ? 0 : r.stdout.split('\n').length };
    };
    return fn({ run, list, countsOnly, write, mkd, dir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const files = (write, dir, prefix, n, ext = '.md') => {
  for (let i = 1; i <= n; i++) write(`${dir}/${prefix}${String(i).padStart(3, '0')}${ext}`);
};

test('list: every kind on an empty data dir prints its fallback', () => {
  pin('context_lists-list-empty-fallbacks', { rename: 'changes', alias: 'A-01' }, withProject(({ run }) => {
    const res = {};
    for (const k of ['epics', 'stories', 'features', 'ideas', 'debug-sessions']) res[k] = run(['list', k]);
    return res;
  }));
});

test('list: kinds whose directories exist but are empty still print the fallback', () => {
  pin('context_lists-list-empty-dirs', { rename: 'changes', alias: 'A-01' }, withProject(({ run, mkd }) => {
    for (const d of ['spec/epics', 'spec/features', 'spec/ideas', 'spec/tasks', 'debug']) mkd(d);
    const res = {};
    for (const k of ['epics', 'stories', 'features', 'ideas', 'debug-sessions']) res[k] = run(['list', k]);
    return res;
  }));
});

test('list: epics populated (dir kind, default limit 20)', () => {
  pin('context_lists-list-epics-populated', { rename: 'identical', alias: 'A-08' }, withProject(({ list, write }) => {
    write('spec/epics/E001-a.md'); write('spec/epics/E002-b.md'); write('spec/epics/notes.txt');
    return { populated: list(['list', 'epics']) };
  }));
});

test('list: features populated', () => {
  pin('context_lists-list-features-populated', { rename: 'changes', alias: 'A-01' }, withProject(({ list, write }) => {
    write('spec/features/F001-a.md'); write('spec/features/F036a-b.md'); write('spec/features/README');
    return { populated: list(['list', 'features']) };
  }));
});

test('list: ideas populated', () => {
  pin('context_lists-list-ideas-populated', { rename: 'identical', alias: 'A-07' }, withProject(({ list, write }) => {
    write('spec/ideas/IDEA-001-a.md'); write('spec/ideas/IDEA-002-b.md');
    return { populated: list(['list', 'ideas']) };
  }));
});

test('list: default limits truncate (epics 20, features 30, ideas 20) and a numeric arg overrides', () => {
  pin('context_lists-list-limits', { rename: 'changes', alias: 'A-01' }, withProject(({ countsOnly, write }) => {
    files(write, 'spec/epics', 'E', 25);
    files(write, 'spec/features', 'F', 35);
    files(write, 'spec/ideas', 'IDEA-', 25);
    const res = {};
    for (const k of ['epics', 'features', 'ideas']) {
      res[k] = { default: countsOnly(['list', k]), limit3: countsOnly(['list', k, '3']), limit100: countsOnly(['list', k, '100']) };
    }
    return res;
  }));
});

test('list: odd limit arguments (0, negative, non-numeric, float)', () => {
  pin('context_lists-list-limit-edges', { rename: 'changes', alias: 'A-01' }, withProject(({ countsOnly, run, write }) => {
    files(write, 'spec/features', 'F', 5);
    return {
      zero: run(['list', 'features', '0']),
      negative: countsOnly(['list', 'features', '-2']),
      nonNumeric: run(['list', 'features', 'abc']),
      float: countsOnly(['list', 'features', '2.9']),
      emptyString: countsOnly(['list', 'features', '']),
    };
  }));
});

test('list: debug-sessions glob (debug/*.md, default limit 5)', () => {
  pin('context_lists-list-debug-sessions', { rename: 'identical', alias: 'A-01' }, withProject(({ countsOnly, list, run, write, mkd }) => {
    write('debug/stuck-oauth.md'); write('debug/other.txt'); mkd('debug/sub.md');
    const res = { populated: list(['list', 'debug-sessions']) };
    files(write, 'debug', 's', 8);
    res.truncated = countsOnly(['list', 'debug-sessions']);
    res.limit2 = countsOnly(['list', 'debug-sessions', '2']);
    res.limit50 = countsOnly(['list', 'debug-sessions', '50']);
    res.zero = run(['list', 'debug-sessions', '0']);
    return res;
  }));
});

test('list: refusals (unknown kind, missing name, case, retired names)', () => {
  pin('context_lists-list-refusals', { rename: 'changes', alias: 'A-01' }, withProject(({ run }) => ({
    unknown: run(['list', 'bogus']),
    missing: run(['list']),
    emptyName: run(['list', '']),
    upperCase: run(['list', 'Epics']),
    bugsNotListable: run(['list', 'bugs']),
    tasksNotListable: run(['list', 'tasks']),
    stories: run(['list', 'stories']),
  })));
});

test('count-of: every kind empty', () => {
  pin('context_lists-count-empty', { rename: 'changes', alias: 'A-01' }, withProject(({ run }) => {
    const res = {};
    for (const k of ['bugs', 'features', 'epics', 'ideas', 'tasks']) res[k] = run(['count-of', k]);
    return res;
  }));
});

test('count-of: every kind populated (counts every entry, including non-md files, dirs and Q- records)', () => {
  pin('context_lists-count-populated', { rename: 'changes', alias: 'A-01' }, withProject(({ run, write, mkd }) => {
    files(write, 'spec/bugs', 'B', 2);
    files(write, 'spec/features', 'F', 3);
    files(write, 'spec/epics', 'E', 4);
    files(write, 'spec/ideas', 'IDEA-', 5);
    files(write, 'spec/tasks', 'T', 2);
    write('spec/tasks/Q-001.md'); write('spec/tasks/Q-002.md'); write('spec/tasks/notes.txt'); mkd('spec/tasks/archive');
    const res = {};
    for (const k of ['bugs', 'features', 'epics', 'ideas', 'tasks']) res[k] = run(['count-of', k]);
    return res;
  }));
});

test('count-of: refusals (unknown, missing, quick-tasks and sprints not countable)', () => {
  pin('context_lists-count-refusals', { rename: 'changes', alias: 'A-01' }, withProject(({ run }) => ({
    unknown: run(['count-of', 'bogus']),
    missing: run(['count-of']),
    quickTasks: run(['count-of', 'quick-tasks']),
    stories: run(['count-of', 'stories']),
    upperCase: run(['count-of', 'Bugs']),
  })));
});
