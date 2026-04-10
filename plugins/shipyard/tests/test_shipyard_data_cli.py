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


class TestShipyardDataArchiveSprint(unittest.TestCase):
    """Tests for the `archive-sprint <sprint-id>` subcommand.

    This subcommand exists so skills can archive completed sprints via a
    single allowlisted call (`Bash(shipyard-data:*)`) instead of
    synthesizing raw cp/mv/mkdir commands against the plugin data dir,
    which trigger permission prompts because the data dir lives outside
    the project root (Claude Code issue #41763).
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-archive-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }
        # Resolve the per-test data dir and pre-populate sprints/current/
        out, _, code = run_cli([], env_extra=self.env)
        self.assertEqual(code, 0)
        self.data_dir = out.strip()
        self.current = os.path.join(self.data_dir, 'sprints', 'current')
        os.makedirs(self.current)
        with open(os.path.join(self.current, 'SPRINT.md'), 'w') as f:
            f.write('---\nid: sprint-042\nstatus: completed\n---\n')
        with open(os.path.join(self.current, 'PROGRESS.md'), 'w') as f:
            f.write('done\n')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_archive_moves_current_to_sprint_id(self):
        """Happy path: current/ contents land in sprints/sprint-NNN/."""
        out, err, code = run_cli(
            ['archive-sprint', 'sprint-042'], env_extra=self.env
        )
        self.assertEqual(code, 0, f'archive failed: {err}')
        archive = os.path.join(self.data_dir, 'sprints', 'sprint-042')
        self.assertEqual(out.strip(), archive)
        # Files moved
        self.assertTrue(os.path.isfile(os.path.join(archive, 'SPRINT.md')))
        self.assertTrue(os.path.isfile(os.path.join(archive, 'PROGRESS.md')))
        # Current recreated empty (directory exists, contents gone)
        self.assertTrue(os.path.isdir(self.current))
        self.assertEqual(os.listdir(self.current), [])

    def test_archive_refuses_when_destination_exists(self):
        """Safety guard: second archive to same ID fails without --force."""
        # First archive succeeds and recreates current/
        run_cli(['archive-sprint', 'sprint-042'], env_extra=self.env)
        # Populate new current/ and try to archive to the same ID
        with open(os.path.join(self.current, 'SPRINT.md'), 'w') as f:
            f.write('---\nid: sprint-042-v2\n---\n')
        _, err, code = run_cli(
            ['archive-sprint', 'sprint-042'], env_extra=self.env
        )
        self.assertEqual(code, 1)
        self.assertIn('already exists', err)

    def test_archive_force_overwrites(self):
        """--force: existing archive dir is replaced with current contents."""
        run_cli(['archive-sprint', 'sprint-042'], env_extra=self.env)
        with open(os.path.join(self.current, 'SPRINT.md'), 'w') as f:
            f.write('v2 content\n')
        _, err, code = run_cli(
            ['archive-sprint', 'sprint-042', '--force'], env_extra=self.env
        )
        self.assertEqual(code, 0, f'--force failed: {err}')
        archive = os.path.join(self.data_dir, 'sprints', 'sprint-042')
        with open(os.path.join(archive, 'SPRINT.md')) as f:
            self.assertEqual(f.read(), 'v2 content\n')

    def test_archive_rejects_missing_sprint_id(self):
        _, err, code = run_cli(['archive-sprint'], env_extra=self.env)
        self.assertEqual(code, 1)
        self.assertIn('missing sprint ID', err)

    def test_archive_rejects_invalid_sprint_id(self):
        """Strict allowlist: anything that doesn't match sprint-NNN rejected.

        This is the security-critical check — a crafted argv value like
        '../etc' must never be accepted because the subcommand would
        otherwise rename a legitimate current/ into an arbitrary path
        under sprints/.
        """
        for bad_id in ['../etc', 'sprint-', 'SPRINT-042', 'sprint-42',
                       'current', '..', '/etc', 'sprint-042/../escape']:
            _, err, code = run_cli(
                ['archive-sprint', bad_id], env_extra=self.env
            )
            self.assertEqual(code, 1, f'should reject {bad_id!r}')
            self.assertIn('invalid sprint ID', err)

    def test_archive_no_current_dir(self):
        """Trying to archive when sprints/current/ doesn't exist errors cleanly."""
        shutil.rmtree(self.current)
        _, err, code = run_cli(
            ['archive-sprint', 'sprint-042'], env_extra=self.env
        )
        self.assertEqual(code, 1)
        self.assertIn('no current sprint', err)

    def test_archive_is_atomic_rename(self):
        """Sanity: the archived dir is the SAME inode as the original
        current/, proving this was a rename, not a copy. Without a rename,
        a crash mid-archive could leave half-copied files behind.
        """
        current_stat = os.stat(self.current)
        run_cli(['archive-sprint', 'sprint-042'], env_extra=self.env)
        archive_stat = os.stat(
            os.path.join(self.data_dir, 'sprints', 'sprint-042')
        )
        # Same device + same inode → rename, not copy
        self.assertEqual(current_stat.st_dev, archive_stat.st_dev)
        self.assertEqual(current_stat.st_ino, archive_stat.st_ino)


class TestShipyardDataDropOrphan(unittest.TestCase):
    """Tests for `shipyard-data drop-orphan <hash>`.

    drop-orphan reaps orphaned per-project data dirs left behind when
    resolver semantics change. Customer-facing destructive op — every
    safety check matters.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-drop-orphan-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }
        # Resolve the per-test data dir so we know its parent (projects/)
        out, _, _ = run_cli([], env_extra=self.env)
        self.current_data_dir = out.strip()
        self.projects_dir = os.path.dirname(self.current_data_dir)
        # Materialize the current data dir on disk — the resolver only
        # computes the path; `init` would create the tree but we don't
        # need the full tree for these tests, just the dir + breadcrumb.
        os.makedirs(self.current_data_dir)
        with open(os.path.join(self.current_data_dir, '.project-root'), 'w') as f:
            f.write(self.project_dir + '\n')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_orphan(self, hash_str, recorded_root=None):
        """Create a plausible orphan data dir under projects/<hash>."""
        orphan = os.path.join(self.projects_dir, hash_str)
        os.makedirs(os.path.join(orphan, 'spec'))
        with open(os.path.join(orphan, '.project-root'), 'w') as f:
            f.write((recorded_root or '/some/old/path') + '\n')
        return orphan

    def test_drop_orphan_happy_path(self):
        orphan = self._make_orphan('abc123def456')
        out, err, code = run_cli(
            ['drop-orphan', 'abc123def456'], env_extra=self.env
        )
        self.assertEqual(code, 0, f'unexpected stderr: {err}')
        self.assertIn('Dropped orphan abc123def456', out)
        self.assertFalse(os.path.exists(orphan))

    def test_drop_orphan_writes_breadcrumb(self):
        self._make_orphan('abc123def456', recorded_root='/old/repo')
        run_cli(['drop-orphan', 'abc123def456'], env_extra=self.env)
        log_path = os.path.join(self.current_data_dir, '.data-ops.log')
        self.assertTrue(os.path.isfile(log_path))
        with open(log_path) as f:
            content = f.read()
        self.assertIn('drop-orphan', content)
        self.assertIn('hash=abc123def456', content)

    def test_drop_orphan_rejects_invalid_hash(self):
        """Strict regex: must be 12 lowercase hex characters."""
        for bad_hash in ['', 'TOOSHORT', 'ABC123DEF456', 'abc123def456!',
                         'abc123def4567', '../etc', 'g123456789ab']:
            _, err, code = run_cli(
                ['drop-orphan', bad_hash], env_extra=self.env
            )
            self.assertEqual(code, 1, f'should reject {bad_hash!r}')
            # Either invalid-format or missing-hash error
            self.assertTrue(
                'invalid hash' in err or 'missing project hash' in err,
                f'unexpected error for {bad_hash!r}: {err}',
            )

    def test_drop_orphan_refuses_current_project(self):
        """Safety: never delete the live data dir."""
        # The current project's hash is the basename of current_data_dir.
        current_hash = os.path.basename(self.current_data_dir)
        _, err, code = run_cli(
            ['drop-orphan', current_hash], env_extra=self.env
        )
        self.assertEqual(code, 1)
        self.assertTrue(
            'refusing to delete the current' in err
            or 'overlaps the current data dir' in err,
            f'unexpected error: {err}',
        )
        # Live dir untouched
        self.assertTrue(os.path.isdir(self.current_data_dir))

    def test_drop_orphan_requires_breadcrumb(self):
        """Safety: refuse to rm a directory without .project-root marker."""
        bad = os.path.join(self.projects_dir, 'def456abc789')
        os.makedirs(os.path.join(bad, 'spec'))
        # No .project-root file
        _, err, code = run_cli(
            ['drop-orphan', 'def456abc789'], env_extra=self.env
        )
        self.assertEqual(code, 1)
        self.assertIn('no .project-root breadcrumb', err)
        self.assertTrue(os.path.isdir(bad))

    def test_drop_orphan_missing_directory(self):
        _, err, code = run_cli(
            ['drop-orphan', '0123456789ab'], env_extra=self.env
        )
        self.assertEqual(code, 1)
        self.assertIn('no such directory', err)


class TestShipyardDataReapObsolete(unittest.TestCase):
    """Tests for `shipyard-data reap-obsolete [--dry-run] [--max-age-days N]`.

    reap-obsolete physically deletes markdown files marked with sentinel
    frontmatter (`obsolete: true` or `status: graduated|superseded|cancelled`)
    after a retention period. Soft-delete is the source of truth; this is
    just garbage collection.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-reap-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }
        out, _, _ = run_cli([], env_extra=self.env)
        self.data_dir = out.strip()
        self.spec = os.path.join(self.data_dir, 'spec')
        os.makedirs(os.path.join(self.spec, 'features'))
        os.makedirs(os.path.join(self.spec, 'ideas'))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_md(self, relpath, frontmatter, age_days=None):
        full = os.path.join(self.spec, relpath)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'w') as f:
            f.write('---\n' + frontmatter + '\n---\n\n# Body\n')
        if age_days is not None:
            mtime = (
                __import__('time').time() - age_days * 86400
            )
            os.utime(full, (mtime, mtime))
        return full

    def test_reap_obsolete_marker(self):
        old = self._write_md('features/F001-old.md', 'obsolete: true', age_days=60)
        out, err, code = run_cli(
            ['reap-obsolete'], env_extra=self.env
        )
        self.assertEqual(code, 0, err)
        self.assertIn('Reaped 1', out)
        self.assertFalse(os.path.exists(old))

    def test_reap_status_graduated(self):
        old = self._write_md('ideas/IDEA-001.md', 'status: graduated', age_days=60)
        run_cli(['reap-obsolete'], env_extra=self.env)
        self.assertFalse(os.path.exists(old))

    def test_reap_status_superseded(self):
        old = self._write_md('features/F002.md', 'status: superseded', age_days=60)
        run_cli(['reap-obsolete'], env_extra=self.env)
        self.assertFalse(os.path.exists(old))

    def test_reap_status_cancelled(self):
        old = self._write_md('features/F003.md', 'status: cancelled', age_days=60)
        run_cli(['reap-obsolete'], env_extra=self.env)
        self.assertFalse(os.path.exists(old))

    def test_reap_skips_recent(self):
        recent = self._write_md(
            'features/F004.md', 'obsolete: true', age_days=5
        )
        out, _, _ = run_cli(['reap-obsolete'], env_extra=self.env)
        self.assertIn('Reaped 0', out)
        self.assertTrue(os.path.exists(recent))

    def test_reap_skips_active(self):
        active = self._write_md(
            'features/F005.md', 'status: in-progress', age_days=60
        )
        out, _, _ = run_cli(['reap-obsolete'], env_extra=self.env)
        self.assertIn('Reaped 0', out)
        self.assertTrue(os.path.exists(active))

    def test_reap_dry_run(self):
        old = self._write_md('features/F006.md', 'obsolete: true', age_days=60)
        out, _, code = run_cli(
            ['reap-obsolete', '--dry-run'], env_extra=self.env
        )
        self.assertEqual(code, 0)
        self.assertIn('Would reap 1', out)
        self.assertIn('would-reap', out)
        self.assertTrue(os.path.exists(old))

    def test_reap_max_age_override(self):
        old = self._write_md('features/F007.md', 'obsolete: true', age_days=10)
        # Default 30 days → 10 days is too recent. With --max-age-days 5
        # the same file becomes eligible.
        out, _, _ = run_cli(['reap-obsolete'], env_extra=self.env)
        self.assertIn('Reaped 0', out)
        out, _, _ = run_cli(
            ['reap-obsolete', '--max-age-days', '5'], env_extra=self.env
        )
        self.assertIn('Reaped 1', out)
        self.assertFalse(os.path.exists(old))


class TestShipyardDataEvents(unittest.TestCase):
    """Tests for `shipyard-data events <subcmd>`.

    The events log is the cross-cutting diagnostic surface for bug
    reports — `shipyard-context diagnose` dumps its tail and customers
    paste it. The CLI must be ergonomic enough that "tail the events"
    and "filter by type" are one-liners that work without piping
    through jq.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-events-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
            'SHIPYARD_DATA': self.plugin_data,
        }

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _emit(self, event_type, **fields):
        """Use the CLI's own emit subcommand so we test the read+write path
        end to end via the same surface users hit."""
        args = ['events', 'emit', event_type]
        for k, v in fields.items():
            # Pass numbers/booleans as JSON so the CLI parses them as
            # typed values, not strings.
            import json as _json
            args.append(f'{k}={_json.dumps(v)}')
        out, err, code = run_cli(args, env_extra=self.env)
        self.assertEqual(code, 0, f'emit failed: {err}')

    def test_events_tail_empty(self):
        # No events file → tail returns empty stdout, exit 0
        out, err, code = run_cli(['events', 'tail'], env_extra=self.env)
        self.assertEqual(code, 0)
        self.assertEqual(out, '')

    def test_events_emit_then_tail(self):
        self._emit('compaction_detected', sprint='S001', count=3)
        out, _, code = run_cli(['events', 'tail'], env_extra=self.env)
        self.assertEqual(code, 0)
        # pretty form: ts type k=v k=v
        self.assertIn('compaction_detected', out)
        self.assertIn('sprint=S001', out)
        self.assertIn('count=3', out)

    def test_events_tail_n_limit(self):
        for i in range(10):
            self._emit('x', i=i)
        out, _, _ = run_cli(['events', 'tail', '-n', '3'], env_extra=self.env)
        lines = [l for l in out.strip().split('\n') if l]
        self.assertEqual(len(lines), 3)
        # Tail of last 3: i=7,8,9
        self.assertIn('i=9', lines[-1])
        self.assertIn('i=7', lines[0])

    def test_events_tail_json_mode(self):
        self._emit('compaction_detected', count=2)
        out, _, _ = run_cli(
            ['events', 'tail', '--json'], env_extra=self.env
        )
        import json
        parsed = [json.loads(l) for l in out.strip().split('\n') if l]
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]['type'], 'compaction_detected')
        self.assertEqual(parsed[0]['count'], 2)

    def test_events_grep_type(self):
        self._emit('compaction_detected', count=1)
        self._emit('session_guard_blocked', tool='Edit')
        self._emit('compaction_detected', count=2)
        out, _, _ = run_cli(
            ['events', 'grep', 'compaction'], env_extra=self.env
        )
        lines = [l for l in out.strip().split('\n') if l]
        self.assertEqual(len(lines), 2)
        self.assertTrue(all('compaction_detected' in l for l in lines))

    def test_events_grep_no_match(self):
        self._emit('x')
        out, _, code = run_cli(
            ['events', 'grep', 'nope'], env_extra=self.env
        )
        self.assertEqual(code, 0)
        self.assertEqual(out, '')

    def test_events_grep_requires_arg(self):
        _, err, code = run_cli(['events', 'grep'], env_extra=self.env)
        self.assertNotEqual(code, 0)
        self.assertIn('substring', err)

    def test_events_since_duration(self):
        self._emit('old')
        # All events have ts ≈ now, so 'since 1h' must include them all.
        out, _, _ = run_cli(
            ['events', 'since', '1h'], env_extra=self.env
        )
        self.assertIn('old', out)

    def test_events_since_iso(self):
        self._emit('marker')
        # ISO timestamp far in the past → all events match.
        out, _, _ = run_cli(
            ['events', 'since', '2000-01-01T00:00:00Z'], env_extra=self.env
        )
        self.assertIn('marker', out)

    def test_events_since_far_future(self):
        self._emit('past')
        # ISO timestamp in the far future → no events match.
        out, _, code = run_cli(
            ['events', 'since', '2099-01-01T00:00:00Z'], env_extra=self.env
        )
        self.assertEqual(code, 0)
        self.assertEqual(out, '')

    def test_events_since_invalid(self):
        self._emit('x')
        _, err, code = run_cli(
            ['events', 'since', 'not-a-time'], env_extra=self.env
        )
        self.assertNotEqual(code, 0)
        self.assertIn('cannot parse', err)

    def test_events_json_full_dump(self):
        self._emit('a')
        self._emit('b')
        out, _, _ = run_cli(['events', 'json'], env_extra=self.env)
        import json
        lines = [json.loads(l) for l in out.strip().split('\n') if l]
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]['type'], 'a')
        self.assertEqual(lines[1]['type'], 'b')

    def test_events_emit_typed_fields(self):
        # Numbers and booleans should round-trip as their native JSON
        # types — not get coerced to strings.
        self._emit('typed', count=42, ratio=3.14, flag=True, name='S007')
        out, _, _ = run_cli(['events', 'tail', '--json'], env_extra=self.env)
        import json
        ev = json.loads(out.strip())
        self.assertIsInstance(ev['count'], int)
        self.assertEqual(ev['count'], 42)
        self.assertIsInstance(ev['ratio'], float)
        self.assertEqual(ev['flag'], True)
        self.assertEqual(ev['name'], 'S007')

    def test_events_emit_requires_type(self):
        _, err, code = run_cli(['events', 'emit'], env_extra=self.env)
        self.assertNotEqual(code, 0)
        self.assertIn('type', err)

    def test_events_unknown_subcommand(self):
        _, err, code = run_cli(
            ['events', 'bogus'], env_extra=self.env
        )
        self.assertNotEqual(code, 0)
        self.assertIn('unknown subcommand', err)


class TestShipyardDataNextId(unittest.TestCase):
    """Tests for `shipyard-data next-id <kind>` — the atomic entity ID
    allocator that prevents parallel writers (builders in worktree waves,
    concurrent skill bodies) from colliding on IDEA/bug/feature numbering.

    Pre-existing bug this fixes: ship-discuss CAPTURE and ship-review retro
    both said 'generate next available IDEA-NNN' with no atomicity. Two
    processes would both scan spec/ideas/, see max=041, both write IDEA-042,
    and one would clobber the other. This test battery locks that down.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-nextid-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }
        # The resolver needs a git repo at project_dir to compute a stable
        # project root. Initialize one with a single empty commit so it's
        # indistinguishable from a real fresh project.
        subprocess.run(['git', 'init', '-q'], cwd=self.project_dir, check=True)
        subprocess.run(['git', 'config', 'user.email', 't@t'], cwd=self.project_dir, check=True)
        subprocess.run(['git', 'config', 'user.name', 't'], cwd=self.project_dir, check=True)
        subprocess.run(['git', 'commit', '--allow-empty', '-m', 'init', '-q'],
                       cwd=self.project_dir, check=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _data_dir(self):
        out, _, code = run_cli([], env_extra=self.env)
        self.assertEqual(code, 0)
        return out.strip()

    def test_next_id_ideas_starts_at_001(self):
        out, err, code = run_cli(['next-id', 'ideas'], env_extra=self.env)
        self.assertEqual(code, 0, f'next-id failed: {err}')
        self.assertEqual(out.strip(), '001')

    def test_next_id_ideas_monotonic(self):
        """Sequential calls must produce strictly increasing IDs."""
        results = []
        for _ in range(5):
            out, _, code = run_cli(['next-id', 'ideas'], env_extra=self.env)
            self.assertEqual(code, 0)
            results.append(out.strip())
        self.assertEqual(results, ['001', '002', '003', '004', '005'])

    def test_next_id_ideas_zero_padded_three_digits(self):
        """Output must be zero-padded to 3 digits — matches historical
        NNN convention. Skill bodies splice this directly into filenames
        like IDEA-042-*.md and expect a fixed width."""
        out, _, code = run_cli(['next-id', 'ideas'], env_extra=self.env)
        self.assertEqual(code, 0)
        self.assertEqual(len(out.strip()), 3)
        self.assertTrue(out.strip().isdigit())

    def test_next_id_ideas_respects_existing_files(self):
        """If existing IDEA files are present (e.g. from a prior plugin
        version with no allocator), the first next-id call must honor
        max(scanned) + 1 as the floor — never hand out an ID that already
        exists on disk."""
        data_dir = self._data_dir()
        ideas_dir = os.path.join(data_dir, 'spec', 'ideas')
        os.makedirs(ideas_dir, exist_ok=True)
        # Plant IDEA-017 and IDEA-042 with no .id-seq file.
        with open(os.path.join(ideas_dir, 'IDEA-017-legacy-one.md'), 'w') as f:
            f.write('---\nid: IDEA-017\n---\n')
        with open(os.path.join(ideas_dir, 'IDEA-042-legacy-two.md'), 'w') as f:
            f.write('---\nid: IDEA-042\n---\n')
        out, _, code = run_cli(['next-id', 'ideas'], env_extra=self.env)
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), '043')

    def test_next_id_parallel_processes_produce_distinct_ids(self):
        """THE LOAD-BEARING TEST. Spawn N concurrent next-id calls; assert
        the resulting set has exactly N distinct IDs. This is the exact
        scenario the allocator exists for — parallel wave builders racing
        on IDEA numbering under worktree mode."""
        import concurrent.futures

        def allocate():
            out, _, code = run_cli(['next-id', 'ideas'], env_extra=self.env)
            return (code, out.strip())

        N = 20
        with concurrent.futures.ThreadPoolExecutor(max_workers=N) as pool:
            results = list(pool.map(lambda _: allocate(), range(N)))

        codes = [c for c, _ in results]
        ids = [i for _, i in results]
        self.assertTrue(all(c == 0 for c in codes), f'some allocations failed: {results}')
        self.assertEqual(len(set(ids)), N, f'duplicate IDs in {ids}')
        # All IDs should be in the range [001, N]
        int_ids = sorted(int(i) for i in ids)
        self.assertEqual(int_ids, list(range(1, N + 1)))

    def test_next_id_unknown_kind_fails(self):
        _, err, code = run_cli(['next-id', 'bogus'], env_extra=self.env)
        self.assertNotEqual(code, 0)
        self.assertIn('unknown kind', err)

    def test_next_id_missing_kind_fails(self):
        _, err, code = run_cli(['next-id'], env_extra=self.env)
        self.assertNotEqual(code, 0)
        self.assertIn('missing kind', err)

    def test_next_id_bugs_uses_correct_prefix(self):
        """Per KIND_TABLE in the CLI: bugs use the B- prefix. Existing
        B-CR-001 files (from ship-review) must be recognized too — the
        regex strips the prefix then reads leading digits, so 'B-CR-001'
        shouldn't match (no digits immediately after B-). Verify by planting
        both shapes and asserting next-id bugs returns 001 (since the
        CR prefix isn't matched and nothing else exists)."""
        data_dir = self._data_dir()
        bugs_dir = os.path.join(data_dir, 'spec', 'bugs')
        os.makedirs(bugs_dir, exist_ok=True)
        with open(os.path.join(bugs_dir, 'B-CR-001-review-finding.md'), 'w') as f:
            f.write('---\nid: B-CR-001\n---\n')
        out, _, code = run_cli(['next-id', 'bugs'], env_extra=self.env)
        self.assertEqual(code, 0)
        # First numeric B- is 001 since B-CR-001 has non-digit after B-
        self.assertEqual(out.strip(), '001')

    def test_next_id_creates_kind_dir_if_missing(self):
        """Fresh project with no spec/ideas/ directory should still work —
        the allocator creates it on demand."""
        data_dir = self._data_dir()
        ideas_dir = os.path.join(data_dir, 'spec', 'ideas')
        # Explicitly ensure it does not exist (fresh project).
        if os.path.exists(ideas_dir):
            shutil.rmtree(ideas_dir)
        out, _, code = run_cli(['next-id', 'ideas'], env_extra=self.env)
        self.assertEqual(code, 0, f'next-id failed on fresh project: ({code})')
        self.assertEqual(out.strip(), '001')
        self.assertTrue(os.path.exists(ideas_dir))
        self.assertTrue(os.path.exists(os.path.join(ideas_dir, '.id-seq')))


if __name__ == '__main__':
    unittest.main()
