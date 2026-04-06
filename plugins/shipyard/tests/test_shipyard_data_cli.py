#!/usr/bin/env python3
"""Tests for bin/shipyard-data.mjs CLI subcommands.

Focuses on the `migrate` subcommand's safety guards (R4): refuses to
overwrite a populated destination unless --force, and when --force is
passed it creates a timestamped backup snapshot before overwriting.

Each test uses an isolated CLAUDE_PLUGIN_DATA so the real plugin data
dir is never touched.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest

CLI = os.path.join(
    os.path.dirname(__file__),
    '..', 'bin', 'shipyard-data.mjs'
)


def run_cli(args, env_extra=None, cwd=None):
    env = os.environ.copy()
    for k in ('CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT'):
        env.pop(k, None)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        ['node', CLI] + args,
        capture_output=True, text=True, env=env, cwd=cwd,
    )
    return proc.stdout, proc.stderr, proc.returncode


class TestShipyardDataMigrate(unittest.TestCase):

    def setUp(self):
        # Sandbox: CLAUDE_PLUGIN_DATA isolated; CLAUDE_PROJECT_DIR points at
        # a tmp directory so the resolver computes a per-test data dir.
        self.tmp = tempfile.mkdtemp(prefix='shipyard-cli-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        self.src_dir = os.path.join(self.tmp, 'legacy-shipyard')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        os.makedirs(os.path.join(self.src_dir, 'spec'))
        # Drop a sentinel file in the legacy source so we can verify it
        # arrived at the destination after migration.
        with open(os.path.join(self.src_dir, 'spec', 'epic-1.md'), 'w') as f:
            f.write('source content\n')

        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _data_dir(self):
        # Resolve the data dir the CLI will compute given our env.
        out, _, code = run_cli([], env_extra=self.env)
        self.assertEqual(code, 0)
        return out.strip()

    def test_migrate_succeeds_on_empty_dest(self):
        """Fresh data dir → migrate should succeed and place the source files."""
        out, err, code = run_cli(['migrate', self.src_dir], env_extra=self.env)
        self.assertEqual(code, 0, f'migrate failed: {err}')
        data_dir = out.strip()
        self.assertTrue(os.path.exists(os.path.join(data_dir, 'spec', 'epic-1.md')),
                        'source file should have been copied')

    def test_migrate_rewrites_project_root_to_current(self):
        """R19: After migrate, .project-root in the dest must record the
        CURRENT project root, not the src's recorded path. Otherwise an
        orphan-data migration leaves a stale breadcrumb that points at the
        old worktree path the data used to belong to."""
        # Plant a stale .project-root in the source recording a fake path
        stale_path = '/some/old/worktree/path/that/no/longer/matters'
        with open(os.path.join(self.src_dir, '.project-root'), 'w') as f:
            f.write(stale_path + '\n')

        out, err, code = run_cli(['migrate', self.src_dir], env_extra=self.env)
        self.assertEqual(code, 0, f'migrate failed: {err}')
        data_dir = out.strip()

        recorded = os.path.join(data_dir, '.project-root')
        self.assertTrue(os.path.exists(recorded), '.project-root must exist after migrate')
        with open(recorded) as f:
            content = f.read().strip()
        # Must NOT be the stale src value; must be the current project_dir
        # (or its realpath, since the resolver canonicalizes via git/realpath).
        self.assertNotEqual(content, stale_path,
            f'.project-root should be rewritten to current project root, '
            f'still has stale src value {content!r}')
        self.assertEqual(
            os.path.realpath(content),
            os.path.realpath(self.project_dir),
            f'.project-root content {content!r} should resolve to '
            f'project_dir {self.project_dir!r}',
        )

    def test_migrate_refuses_on_populated_dest(self):
        """Existing user data in the dest → migrate refuses without --force."""
        data_dir = self._data_dir()
        # Pre-populate with user data
        os.makedirs(os.path.join(data_dir, 'spec'), exist_ok=True)
        with open(os.path.join(data_dir, 'spec', 'existing.md'), 'w') as f:
            f.write('user data — must not be lost\n')

        _, err, code = run_cli(['migrate', self.src_dir], env_extra=self.env)
        self.assertNotEqual(code, 0, 'migrate should refuse on populated dest')
        self.assertIn('refusing', err)
        self.assertIn('--force', err)
        # And the existing file MUST still be there untouched
        with open(os.path.join(data_dir, 'spec', 'existing.md')) as f:
            self.assertEqual(f.read(), 'user data — must not be lost\n')

    def test_migrate_force_creates_backup(self):
        """--force on populated dest → backup snapshot + migration proceeds."""
        data_dir = self._data_dir()
        os.makedirs(os.path.join(data_dir, 'spec'), exist_ok=True)
        original_content = 'user data to back up\n'
        with open(os.path.join(data_dir, 'spec', 'existing.md'), 'w') as f:
            f.write(original_content)

        _, err, code = run_cli(['migrate', self.src_dir, '--force'], env_extra=self.env)
        self.assertEqual(code, 0, f'migrate --force failed: {err}')

        # The new content from src_dir is in place
        self.assertTrue(os.path.exists(os.path.join(data_dir, 'spec', 'epic-1.md')))

        # R17: --force is REPLACEMENT, not merge. The original file must be
        # gone from the live data dir (it's only in the backup). Without
        # this assertion, the migrate would silently leak old state alongside
        # the new content, breaking the user's "I just migrated, my dest is
        # now src" mental model.
        self.assertFalse(
            os.path.exists(os.path.join(data_dir, 'spec', 'existing.md')),
            'R17: --force should REPLACE the live data dir, not merge — '
            'the original file should only exist in the backup, not in spec/',
        )

        # And there is exactly one backup dir containing the original file
        backups = [n for n in os.listdir(data_dir) if n.startswith('.pre-migrate-backup-')]
        self.assertEqual(len(backups), 1, f'expected 1 backup dir, got {backups}')
        backup_file = os.path.join(data_dir, backups[0], 'spec', 'existing.md')
        self.assertTrue(os.path.exists(backup_file),
                        f'original file should be in backup at {backup_file}')
        with open(backup_file) as f:
            self.assertEqual(f.read(), original_content)


class TestShipyardDataLockPidLiveness(unittest.TestCase):
    """R13: regression guard for the with-lock pid liveness check.

    A behavioral test (spawn a long-running holder, age its lock, contend)
    is hard to make non-flaky in a unit test, so we settle for a source-
    contains check that pins the implementation. Any future change that
    drops the pid check will fail this test and force a conscious decision.
    """

    def test_with_lock_uses_pid_liveness_check(self):
        with open(CLI) as f:
            src = f.read()
        # The fix must call process.kill(pid, 0) and treat ESRCH as dead.
        self.assertIn('process.kill', src,
            'withLock stale-detection should probe the holder pid via process.kill(pid, 0)')
        self.assertIn('isProcessAlive', src,
            'withLock should delegate to a named helper for clarity')
        self.assertIn('readFileSync', src,
            'withLock must read the pid out of the lock file before stealing it')


class TestShipyardDataFindOrphans(unittest.TestCase):
    """R18: find-orphans detects data dirs whose .project-root matches the
    current parent repo or its worktrees, surfacing data that would otherwise
    be silently abandoned after the worktree-detection hash change."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-orphans-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.parent_repo = os.path.join(self.tmp, 'parent')
        os.makedirs(self.plugin_data)
        os.makedirs(self.parent_repo)
        # Init real git repo for git worktree list
        subprocess.run(['git', 'init', '-q', self.parent_repo], check=True)
        subprocess.run(
            ['git', '-C', self.parent_repo, 'commit', '--allow-empty', '-m', 'init', '-q'],
            check=True,
            env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t',
                 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'},
        )
        self.env = {
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
            'CLAUDE_PROJECT_DIR': self.parent_repo,
        }

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_orphan(self, recorded_path, with_data=True):
        """Create a fake orphaned data dir under plugin_data/projects/<random-hash>
        whose .project-root records the given path. Returns the dir path."""
        import hashlib, secrets
        h = hashlib.sha256(secrets.token_bytes(32)).hexdigest()[:12]
        d = os.path.join(self.plugin_data, 'projects', h)
        os.makedirs(d)
        with open(os.path.join(d, '.project-root'), 'w') as f:
            f.write(recorded_path + '\n')
        if with_data:
            os.makedirs(os.path.join(d, 'spec', 'features'))
            with open(os.path.join(d, 'config.md'), 'w') as f:
                f.write('config_version: 3\n')
        return d

    def test_find_orphans_returns_nothing_for_fresh_install(self):
        """No orphans in plugin data → no output, exit 0."""
        out, err, code = run_cli(['find-orphans'], env_extra=self.env)
        self.assertEqual(code, 0, f'stderr={err!r}')
        self.assertEqual(out.strip(), '')

    def test_find_orphans_detects_worktree_orphan(self):
        """Orphan recorded as a worktree path of current parent repo → detected."""
        # Add a real worktree to the parent so git worktree list returns it
        wt_path = os.path.join(self.parent_repo, 'wt-feat')
        subprocess.run(
            ['git', '-C', self.parent_repo, 'worktree', 'add', '-q', wt_path],
            check=True,
            env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t',
                 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'},
        )
        # Create an orphaned data dir whose .project-root recorded the worktree path
        orphan = self._make_orphan(wt_path)
        # And an unrelated orphan that should NOT match
        unrelated = self._make_orphan('/some/totally/unrelated/path')

        out, err, code = run_cli(['find-orphans'], env_extra=self.env)
        self.assertEqual(code, 0, f'stderr={err!r}')
        # Output should include the orphan but not the unrelated one
        self.assertIn(orphan, out)
        self.assertNotIn(unrelated, out)

    def test_find_orphans_detects_parent_repo_orphan(self):
        """Orphan recorded as the parent repo path itself → detected (e.g.
        from a different machine where the path was the same)."""
        orphan = self._make_orphan(self.parent_repo)
        out, _, code = run_cli(['find-orphans'], env_extra=self.env)
        self.assertEqual(code, 0)
        self.assertIn(orphan, out)

    def test_find_orphans_skips_current_dir(self):
        """If the orphan candidate IS the current data dir, skip it."""
        # Compute the current data dir for the parent repo
        out, _, _ = run_cli([], env_extra=self.env)
        current = out.strip()
        os.makedirs(current)
        with open(os.path.join(current, '.project-root'), 'w') as f:
            f.write(self.parent_repo + '\n')
        os.makedirs(os.path.join(current, 'spec', 'features'))
        with open(os.path.join(current, 'config.md'), 'w') as f:
            f.write('config_version: 3\n')

        out, _, code = run_cli(['find-orphans'], env_extra=self.env)
        self.assertEqual(code, 0)
        self.assertNotIn(current, out)

    def test_find_orphans_skips_when_current_dir_populated(self):
        """If current dir already has user data, don't suggest migration."""
        # Make current dir populated
        out, _, _ = run_cli([], env_extra=self.env)
        current = out.strip()
        os.makedirs(current)
        with open(os.path.join(current, 'config.md'), 'w') as f:
            f.write('config_version: 3\n')
        # Create a separate orphan candidate
        self._make_orphan(self.parent_repo)

        out, _, code = run_cli(['find-orphans'], env_extra=self.env)
        self.assertEqual(code, 0)
        # No output — current dir is populated, no orphan suggestion
        self.assertEqual(out.strip(), '')


if __name__ == '__main__':
    unittest.main()
