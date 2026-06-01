#!/usr/bin/env python3
"""Tests for the worktree-integration reliability surface (v2.8.x).

Covers the three pieces added to close the worktree-orphaning failure mode
(subagents committed real work in isolation worktrees, the orchestrator read
`worktreeBranch: undefined`, never merged, and teardown left the commits
dangling):

  - shipyard-data ensure-worktree-baseref   (verify-at-execute, self-healing)
  - shipyard-data anchor-commit             (insurance ref so SHAs survive)
  - shipyard-data verify-wave-integrated    (the pre-teardown ancestry gate)
  - bin/hooks/worktree-branch.mjs           (branch -D guard / #51596)

All tests drive the real entry points via subprocess against the .mjs, in
throwaway git repos, so they pin observable behavior callers depend on.
"""

import json
import os
import subprocess
import tempfile
import unittest

BIN = os.path.join(os.path.dirname(__file__), '..', 'bin')
SHIPYARD_DATA = os.path.join(BIN, 'shipyard-data.mjs')
HOOK_RUNNER = os.path.join(BIN, 'hook-runner.mjs')


def git(repo, *args, check=True):
    return subprocess.run(
        ['git', '-C', repo, *args],
        capture_output=True, text=True, check=check,
    )


def make_repo(tmp):
    """Init a git repo on `main` with one commit, deterministic identity."""
    repo = os.path.join(tmp, 'repo')
    os.makedirs(repo)
    subprocess.run(['git', 'init', '-b', 'main', repo], capture_output=True, check=True)
    git(repo, 'config', 'user.email', 't@t')
    git(repo, 'config', 'user.name', 'T')
    git(repo, 'config', 'commit.gpgsign', 'false')
    write_commit(repo, 'README.md', 'init\n', 'C0')
    return repo


def write_commit(repo, relpath, content, msg):
    path = os.path.join(repo, relpath)
    os.makedirs(os.path.dirname(path), exist_ok=True) if os.path.dirname(relpath) else None
    with open(path, 'w') as fh:
        fh.write(content)
    git(repo, 'add', relpath)
    git(repo, 'commit', '-m', msg)
    return git(repo, 'rev-parse', 'HEAD').stdout.strip()


class WorktreeTestBase(unittest.TestCase):
    def run_data(self, repo, plugin_data, *args):
        env = os.environ.copy()
        for k in ('CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'SHIPYARD_DATA'):
            env.pop(k, None)
        env['CLAUDE_PROJECT_DIR'] = repo
        env['CLAUDE_PLUGIN_DATA'] = plugin_data
        proc = subprocess.run(
            ['node', SHIPYARD_DATA, *args],
            capture_output=True, text=True, env=env, cwd=repo,
        )
        return proc

    def resolve_data_dir(self, repo, plugin_data):
        proc = self.run_data(repo, plugin_data)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.strip()

    def read_events(self, data_dir):
        path = os.path.join(data_dir, '.shipyard-events.jsonl')
        if not os.path.exists(path):
            return []
        out = []
        for line in open(path):
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return out

    def seed_return(self, data_dir, task, status='COMPLETE', sha=None):
        rd = os.path.join(data_dir, 'sprints', 'current', '.subagent-returns')
        os.makedirs(rd, exist_ok=True)
        body = f'STATUS: {status}\n'
        if sha:
            body += f'COMMIT: {sha}\nPROBE_EXIT: 0\n'
        with open(os.path.join(rd, f'{task}.txt'), 'w') as fh:
            fh.write(body)


# --------------------------------------------------------------------------
# ensure-worktree-baseref
# --------------------------------------------------------------------------
class TestEnsureWorktreeBaseref(WorktreeTestBase):
    def test_creates_settings_when_absent(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            proc = self.run_data(repo, plugin_data, 'ensure-worktree-baseref')
            self.assertEqual(proc.returncode, 0, proc.stderr)
            settings = json.load(open(os.path.join(repo, '.claude', 'settings.json')))
            self.assertEqual(settings['worktree']['baseRef'], 'head')

    def test_idempotent_second_run_is_noop(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            self.run_data(repo, plugin_data, 'ensure-worktree-baseref')
            before = open(os.path.join(repo, '.claude', 'settings.json')).read()
            proc = self.run_data(repo, plugin_data, 'ensure-worktree-baseref')
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn('already', proc.stdout)
            after = open(os.path.join(repo, '.claude', 'settings.json')).read()
            self.assertEqual(before, after)

    def test_preserves_unrelated_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            cdir = os.path.join(repo, '.claude')
            os.makedirs(cdir)
            with open(os.path.join(cdir, 'settings.json'), 'w') as fh:
                json.dump({'permissions': {'allow': ['Bash(ls:*)']},
                           'worktree': {'cleanupPeriodDays': 7}}, fh)
            proc = self.run_data(repo, plugin_data, 'ensure-worktree-baseref')
            self.assertEqual(proc.returncode, 0, proc.stderr)
            settings = json.load(open(os.path.join(cdir, 'settings.json')))
            self.assertEqual(settings['worktree']['baseRef'], 'head')
            # sibling keys preserved
            self.assertEqual(settings['worktree']['cleanupPeriodDays'], 7)
            self.assertEqual(settings['permissions']['allow'], ['Bash(ls:*)'])

    def test_refuses_invalid_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            cdir = os.path.join(repo, '.claude')
            os.makedirs(cdir)
            bad = '{ this is not valid json '
            with open(os.path.join(cdir, 'settings.json'), 'w') as fh:
                fh.write(bad)
            proc = self.run_data(repo, plugin_data, 'ensure-worktree-baseref')
            self.assertNotEqual(proc.returncode, 0)
            # File is left untouched — never half-written.
            self.assertEqual(open(os.path.join(cdir, 'settings.json')).read(), bad)

    def test_emits_event(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            data_dir = self.resolve_data_dir(repo, plugin_data)
            os.makedirs(data_dir, exist_ok=True)
            self.run_data(repo, plugin_data, 'ensure-worktree-baseref')
            events = self.read_events(data_dir)
            ensured = [e for e in events if e.get('type') == 'worktree_baseref_ensured']
            self.assertTrue(ensured)
            self.assertEqual(ensured[-1]['now'], 'head')
            self.assertTrue(ensured[-1]['changed'])


# --------------------------------------------------------------------------
# anchor-commit
# --------------------------------------------------------------------------
class TestAnchorCommit(WorktreeTestBase):
    def test_anchors_commit_surviving_branch_deletion(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            # commit on a side branch, then delete the branch -> would dangle
            git(repo, 'checkout', '-b', 'side')
            sha = write_commit(repo, 'f.txt', 'x\n', 'side work')
            git(repo, 'checkout', 'main')
            git(repo, 'branch', '-D', 'side')
            proc = self.run_data(repo, plugin_data, 'anchor-commit', 'T052', sha)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            # keep ref now points at the otherwise-dangling commit
            ref = git(repo, 'rev-parse', 'shipyard/keep-T052').stdout.strip()
            self.assertEqual(ref, sha)

    def test_rejects_bad_task_id(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            sha = git(repo, 'rev-parse', 'HEAD').stdout.strip()
            proc = self.run_data(repo, plugin_data, 'anchor-commit', 'bad id!', sha)
            self.assertNotEqual(proc.returncode, 0)

    def test_rejects_bad_sha(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            proc = self.run_data(repo, plugin_data, 'anchor-commit', 'T1', 'nothex')
            self.assertNotEqual(proc.returncode, 0)

    def test_rejects_nonexistent_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            proc = self.run_data(repo, plugin_data, 'anchor-commit', 'T1', 'deadbeef')
            self.assertNotEqual(proc.returncode, 0)


# --------------------------------------------------------------------------
# verify-wave-integrated
# --------------------------------------------------------------------------
class TestVerifyWaveIntegrated(WorktreeTestBase):
    def test_pass_when_return_merged(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            data_dir = self.resolve_data_dir(repo, plugin_data)
            sha = write_commit(repo, 'g.txt', 'y\n', 'merged work')  # on main now
            self.seed_return(data_dir, 'T010', sha=sha)
            proc = self.run_data(repo, plugin_data, 'verify-wave-integrated')
            self.assertEqual(proc.returncode, 0, proc.stderr)
            events = self.read_events(data_dir)
            self.assertTrue(any(e.get('type') == 'wave_integration_verified' for e in events))

    def test_fail_when_return_dangling(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            data_dir = self.resolve_data_dir(repo, plugin_data)
            git(repo, 'checkout', '-b', 'side')
            sha = write_commit(repo, 'h.txt', 'z\n', 'orphan work')
            git(repo, 'checkout', 'main')
            git(repo, 'branch', '-D', 'side')  # now dangling, no keep ref
            self.seed_return(data_dir, 'T011', sha=sha)
            proc = self.run_data(repo, plugin_data, 'verify-wave-integrated')
            self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
            self.assertIn('T011', proc.stderr)
            events = self.read_events(data_dir)
            self.assertTrue(any(e.get('type') == 'wave_integration_failed' for e in events))

    def test_pass_when_dangling_but_anchored(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            data_dir = self.resolve_data_dir(repo, plugin_data)
            git(repo, 'checkout', '-b', 'side')
            sha = write_commit(repo, 'i.txt', 'a\n', 'anchored work')
            git(repo, 'checkout', 'main')
            git(repo, 'branch', '-D', 'side')
            # anchor it -> reachable from keep ref -> Check B passes
            self.run_data(repo, plugin_data, 'anchor-commit', 'T012', sha)
            self.seed_return(data_dir, 'T012', sha=sha)
            proc = self.run_data(repo, plugin_data, 'verify-wave-integrated')
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_fail_when_worktree_branch_unintegrated(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            data_dir = self.resolve_data_dir(repo, plugin_data)
            os.makedirs(data_dir, exist_ok=True)
            # live worktree on a shipyard/wt-* branch with an un-merged commit
            wt = os.path.join(repo, '.claude', 'worktrees', 'agent-x')
            git(repo, 'worktree', 'add', '-b', 'shipyard/wt-agent-x', wt)
            write_commit(wt, 'j.txt', 'b\n', 'wt work')  # commit lives in the worktree
            proc = self.run_data(repo, plugin_data, 'verify-wave-integrated')
            self.assertEqual(proc.returncode, 3, proc.stdout + proc.stderr)
            self.assertIn('shipyard/wt-agent-x', proc.stderr)

    def test_pass_vacuous_when_nothing_dispatched(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            plugin_data = os.path.join(tmp, 'pdata')
            os.makedirs(plugin_data)
            self.resolve_data_dir(repo, plugin_data)
            proc = self.run_data(repo, plugin_data, 'verify-wave-integrated')
            self.assertEqual(proc.returncode, 0, proc.stderr)


# --------------------------------------------------------------------------
# worktree-branch.mjs hook — branch -D guard (#51596 collision preservation)
# --------------------------------------------------------------------------
class TestWorktreeBranchHookGuard(WorktreeTestBase):
    def run_hook(self, repo, name):
        env = os.environ.copy()
        env.pop('SHIPYARD_DATA', None)
        proc = subprocess.run(
            ['node', HOOK_RUNNER, 'worktree-branch'],
            input=json.dumps({'name': name}),
            capture_output=True, text=True, env=env, cwd=repo,
        )
        return proc

    def test_preserves_unintegrated_commits_on_name_collision(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            # Simulate a prior agent's un-integrated work on the colliding name.
            git(repo, 'branch', 'shipyard/wt-agent-z', 'HEAD')
            git(repo, 'worktree', 'add', os.path.join(repo, '.claude', 'worktrees', 'agent-z'),
                'shipyard/wt-agent-z')
            wt = os.path.join(repo, '.claude', 'worktrees', 'agent-z')
            prior = write_commit(wt, 'k.txt', 'c\n', 'prior agent work')
            # Remove the worktree dir but keep the branch (mimics CC reusing the name).
            git(repo, 'worktree', 'remove', '--force', wt)
            # Re-fire the hook with the same name.
            proc = self.run_hook(repo, 'agent-z')
            self.assertEqual(proc.returncode, 0, proc.stderr)
            # The prior commit must survive under a keep ref (not force-deleted).
            keep = [b.strip().lstrip('* ').strip()
                    for b in git(repo, 'branch', '--list', 'shipyard/keep-*',
                                 '--format=%(refname:short)').stdout.splitlines()
                    if b.strip()]
            self.assertTrue(keep, 'expected a shipyard/keep-* preservation ref')
            # At least one keep ref contains the prior commit.
            reachable = False
            for k in keep:
                r = subprocess.run(['git', '-C', repo, 'merge-base', '--is-ancestor', prior, k])
                if r.returncode == 0:
                    reachable = True
                    break
            self.assertTrue(reachable, 'prior agent commit was orphaned, not preserved')

    def test_clean_create_when_no_collision(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = make_repo(tmp)
            proc = self.run_hook(repo, 'agent-fresh')
            self.assertEqual(proc.returncode, 0, proc.stderr)
            # stdout is the worktree path (no newline); branch exists at HEAD.
            self.assertIn('agent-fresh', proc.stdout)
            branch = git(repo, 'rev-parse', '--verify', 'shipyard/wt-agent-fresh', check=False)
            self.assertEqual(branch.returncode, 0)


if __name__ == '__main__':
    unittest.main()
