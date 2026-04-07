#!/usr/bin/env python3
"""Tests for bin/shipyard-logcap.mjs.

Covers the core contract: run tees output to file + stdout, propagates the
wrapped command's exit code, rotates on size overflow, validates capture
names strictly, and keeps captures isolated per project hash.

Each test runs in an isolated TMPDIR and CLAUDE_PROJECT_DIR so the real
user tmp and project state are never touched.
"""

import os
import shutil
import subprocess
import tempfile
import unittest

CLI = os.path.abspath(os.path.join(
    os.path.dirname(__file__), '..', 'bin', 'shipyard-logcap.mjs'
))


def run_cli(args, env_extra=None, cwd=None, input_text=None):
    """Invoke shipyard-logcap.mjs via node with a scrubbed env."""
    env = os.environ.copy()
    # Clear any ambient Claude state so the resolver sees only what we set.
    for k in ('CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT',
              'SHIPYARD_LOGCAP_SESSION', 'SHIPYARD_LOGCAP_MAX_SIZE',
              'SHIPYARD_LOGCAP_MAX_FILES'):
        env.pop(k, None)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        ['node', CLI] + args,
        capture_output=True, text=True, env=env, cwd=cwd,
        input=input_text,
    )
    return proc.stdout, proc.stderr, proc.returncode


class LogcapTestBase(unittest.TestCase):
    """Shared sandbox: per-test TMPDIR + project dir + fixed session."""

    def setUp(self):
        self.tmp_root = tempfile.mkdtemp(prefix='shipyard-logcap-test-')
        self.tmpdir = os.path.join(self.tmp_root, 'tmp')
        self.project_dir = os.path.join(self.tmp_root, 'project')
        os.makedirs(self.tmpdir)
        os.makedirs(self.project_dir)

        self.env = {
            'TMPDIR': self.tmpdir,
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'SHIPYARD_LOGCAP_SESSION': 'unit-test-session',
        }

    def tearDown(self):
        shutil.rmtree(self.tmp_root, ignore_errors=True)

    def capture_dir(self):
        """Return the expected per-project capture dir for this sandbox.

        We ask probe to compute the hash so we don't reimplement it here —
        tests should exercise the real resolver path, not a mock.
        """
        stdout, _, rc = run_cli(['probe'], env_extra=self.env)
        self.assertEqual(rc, 0, 'probe failed')
        hash_line = [l for l in stdout.splitlines() if l.startswith('project_hash:')][0]
        project_hash = hash_line.split(':', 1)[1].strip()
        return os.path.join(self.tmpdir, 'shipyard', project_hash)


class TestRun(LogcapTestBase):

    def test_run_creates_capture_file_and_forwards_stdout(self):
        stdout, stderr, rc = run_cli(
            ['run', 'smoke', '--', 'sh', '-c', 'echo hello world'],
            env_extra=self.env,
        )
        self.assertEqual(rc, 0)
        self.assertIn('hello world', stdout)
        log_path = os.path.join(
            self.capture_dir(), 'unit-test-session', 'smoke.log'
        )
        self.assertTrue(os.path.exists(log_path), f'missing {log_path}')
        with open(log_path) as f:
            self.assertIn('hello world', f.read())

    def test_run_propagates_nonzero_exit_code(self):
        _, _, rc = run_cli(
            ['run', 'failing', '--', 'sh', '-c', 'exit 42'],
            env_extra=self.env,
        )
        self.assertEqual(rc, 42)

    def test_run_propagates_zero_exit_code(self):
        _, _, rc = run_cli(
            ['run', 'passing', '--', 'sh', '-c', 'true'],
            env_extra=self.env,
        )
        self.assertEqual(rc, 0)

    def test_run_rejects_missing_separator(self):
        _, stderr, rc = run_cli(
            ['run', 'noop', 'echo', 'hi'],
            env_extra=self.env,
        )
        self.assertNotEqual(rc, 0)
        self.assertIn('--', stderr)

    def test_run_missing_binary_exits_127(self):
        _, _, rc = run_cli(
            ['run', 'noent', '--', '/nonexistent/bin/logcap-test-does-not-exist'],
            env_extra=self.env,
        )
        self.assertEqual(rc, 127)

    def test_run_prints_banner_to_stderr(self):
        _, stderr, _ = run_cli(
            ['run', 'banner', '--', 'sh', '-c', 'true'],
            env_extra=self.env,
        )
        # Banner should name the capture path and bounds so users can see
        # what they got without guessing.
        self.assertIn('banner.log', stderr)
        self.assertIn('bounds', stderr)


class TestRotation(LogcapTestBase):

    # The primitive's minimum --max-size is 64K (one Node pipe chunk).
    # To actually exercise rotation, output must comfortably exceed that
    # multiple times. Each "padding line" below is ~100 bytes, so 2000
    # lines ≈ 200KB — enough to fill a 64K capture and rotate several
    # times. Tests that need tighter ceilings are impossible by design
    # and covered instead by TestBoundsValidation.

    def test_rotation_creates_numbered_tails(self):
        script = (
            'for i in $(seq 1 2000); do '
            'echo "line $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; '
            'done'
        )
        _, _, rc = run_cli(
            ['run', 'rot', '--max-size', '64K', '--max-files', '4',
             '--', 'sh', '-c', script],
            env_extra=self.env,
        )
        self.assertEqual(rc, 0)
        session_dir = os.path.join(self.capture_dir(), 'unit-test-session')
        files = sorted(
            f for f in os.listdir(session_dir) if f.startswith('rot.log')
        )
        self.assertIn('rot.log', files)
        rotated = [f for f in files if f != 'rot.log']
        self.assertGreaterEqual(len(rotated), 1,
            f'expected rotation, got files={files}')

    def test_rotation_honors_max_files_cap(self):
        # 5000 lines * ~100 bytes ≈ 500KB — enough to overflow a 64K cap
        # many times over, well above max-files * max-size = 192KB.
        script = (
            'for i in $(seq 1 5000); do '
            'echo "padding line $i aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; '
            'done'
        )
        run_cli(
            ['run', 'cap', '--max-size', '64K', '--max-files', '3',
             '--', 'sh', '-c', script],
            env_extra=self.env,
        )
        session_dir = os.path.join(self.capture_dir(), 'unit-test-session')
        files = [f for f in os.listdir(session_dir) if f.startswith('cap.log')]
        self.assertLessEqual(len(files), 3,
            f'exceeded --max-files=3: {files}')


class TestNameValidation(LogcapTestBase):

    def test_rejects_path_traversal_in_name(self):
        _, stderr, rc = run_cli(
            ['run', '../escape', '--', 'sh', '-c', 'true'],
            env_extra=self.env,
        )
        self.assertNotEqual(rc, 0)
        self.assertIn('invalid name', stderr)

    def test_rejects_slash_in_name(self):
        _, stderr, rc = run_cli(
            ['run', 'a/b', '--', 'sh', '-c', 'true'],
            env_extra=self.env,
        )
        self.assertNotEqual(rc, 0)
        self.assertIn('invalid name', stderr)

    def test_rejects_reserved_lock_suffix(self):
        _, stderr, rc = run_cli(
            ['run', 'capture.lock', '--', 'sh', '-c', 'true'],
            env_extra=self.env,
        )
        self.assertNotEqual(rc, 0)
        self.assertIn('reserved suffix', stderr)

    def test_rejects_empty_name(self):
        _, _, rc = run_cli(
            ['run', '', '--', 'sh', '-c', 'true'],
            env_extra=self.env,
        )
        self.assertNotEqual(rc, 0)

    def test_accepts_normal_names(self):
        for name in ['smoke', 'e2e-test', 'bhot-042-repro', 'test_1.v2']:
            _, _, rc = run_cli(
                ['run', name, '--', 'sh', '-c', 'true'],
                env_extra=self.env,
            )
            self.assertEqual(rc, 0, f'name {name!r} should be accepted')

    def test_rejects_starting_with_non_alnum(self):
        for name in ['-leading', '.dotfile', '_underscore']:
            _, _, rc = run_cli(
                ['run', name, '--', 'sh', '-c', 'true'],
                env_extra=self.env,
            )
            self.assertNotEqual(rc, 0, f'name {name!r} should be rejected')


class TestBoundsValidation(LogcapTestBase):

    def test_rejects_sub_64k_max_size(self):
        # Min is 64 * 1024 = 65536. Anything smaller is rejected because
        # Node's pipe chunks can reach that size, and chunks can't be
        # split mid-text without breaking lines.
        for bad in ['1K', '8K', '32K', '63K', '65535']:
            _, stderr, rc = run_cli(
                ['run', 'tiny', '--max-size', bad,
                 '--', 'sh', '-c', 'true'],
                env_extra=self.env,
            )
            self.assertNotEqual(rc, 0, f'size {bad!r} should be rejected')
            self.assertIn('64', stderr,
                f'error for {bad!r} should mention the 64K floor')

    def test_rejects_zero_max_files(self):
        _, _, rc = run_cli(
            ['run', 'zero', '--max-files', '0', '--', 'sh', '-c', 'true'],
            env_extra=self.env,
        )
        self.assertNotEqual(rc, 0)

    def test_parses_valid_size_units(self):
        # All values must be >= 64K to pass the floor check.
        for size in ['64K', '128K', '1M', '2m', '65536']:
            _, _, rc = run_cli(
                ['run', 'sizetest', '--max-size', size,
                 '--', 'sh', '-c', 'true'],
                env_extra=self.env,
            )
            self.assertEqual(rc, 0, f'size {size!r} should parse')

    def test_env_var_overrides_default(self):
        env = dict(self.env)
        env['SHIPYARD_LOGCAP_MAX_SIZE'] = '2M'
        _, stderr, rc = run_cli(
            ['run', 'envsize', '--', 'sh', '-c', 'true'],
            env_extra=env,
        )
        self.assertEqual(rc, 0)
        self.assertIn('2M', stderr)


class TestReadSubcommands(LogcapTestBase):

    def _seed_capture(self, name='seed', content='alpha\nbeta\ngamma\n'):
        run_cli(
            ['run', name, '--', 'sh', '-c', f'printf {content!r}'],
            env_extra=self.env,
        )

    def test_list_shows_captures(self):
        self._seed_capture('one')
        self._seed_capture('two')
        stdout, _, rc = run_cli(['list'], env_extra=self.env)
        self.assertEqual(rc, 0)
        self.assertIn('one.log', stdout)
        self.assertIn('two.log', stdout)
        self.assertIn('unit-test-session', stdout)

    def test_list_empty_when_no_captures(self):
        stdout, _, rc = run_cli(['list'], env_extra=self.env)
        self.assertEqual(rc, 0)
        self.assertIn('no captures', stdout)

    def test_path_returns_live_file_path(self):
        self._seed_capture('pathed')
        stdout, _, rc = run_cli(['path', 'pathed'], env_extra=self.env)
        self.assertEqual(rc, 0)
        self.assertTrue(stdout.strip().endswith('pathed.log'))
        self.assertTrue(os.path.exists(stdout.strip()))

    def test_grep_matches_content(self):
        self._seed_capture('grepme', content='first\\nneedle\\nthird\\n')
        stdout, _, rc = run_cli(
            ['grep', 'grepme', 'needle'], env_extra=self.env,
        )
        self.assertEqual(rc, 0)
        self.assertIn('needle', stdout)

    def test_grep_no_match_returns_nonzero(self):
        self._seed_capture('grepmiss')
        _, _, rc = run_cli(
            ['grep', 'grepmiss', 'zzz-nope-zzz'], env_extra=self.env,
        )
        self.assertEqual(rc, 1)

    def test_tail_reads_existing_capture(self):
        self._seed_capture('tailed', content='one\\ntwo\\nthree\\n')
        stdout, _, rc = run_cli(
            ['tail', 'tailed'], env_extra=self.env,
        )
        self.assertEqual(rc, 0)
        # Captured content includes all three tokens.
        self.assertIn('two', stdout)


class TestProbeAndPrune(LogcapTestBase):

    def test_probe_prints_platform_facts(self):
        stdout, _, rc = run_cli(['probe'], env_extra=self.env)
        self.assertEqual(rc, 0)
        # Every probe field we care about must appear.
        for field in ('project_root:', 'project_hash:', 'tmp_dir:',
                      'capture_root:', 'session:'):
            self.assertIn(field, stdout)
        # The probe's reported tmp_dir should be our sandbox tmp.
        self.assertIn(self.tmpdir, stdout)

    def test_prune_removes_old_sessions(self):
        # Seed a capture and then backdate the session dir so prune finds it.
        run_cli(
            ['run', 'oldcap', '--', 'sh', '-c', 'echo x'],
            env_extra=self.env,
        )
        session_dir = os.path.join(self.capture_dir(), 'unit-test-session')
        self.assertTrue(os.path.exists(session_dir))
        # Push mtime back 48 hours.
        old_time = os.path.getmtime(session_dir) - 48 * 3600
        os.utime(session_dir, (old_time, old_time))

        stdout, _, rc = run_cli(
            ['prune', '--older-than', '24h'], env_extra=self.env,
        )
        self.assertEqual(rc, 0)
        self.assertIn('pruned 1', stdout)
        self.assertFalse(os.path.exists(session_dir))


class TestProjectIsolation(LogcapTestBase):

    def test_different_project_dirs_produce_different_capture_roots(self):
        other_project = os.path.join(self.tmp_root, 'other-project')
        os.makedirs(other_project)

        stdout_a, _, _ = run_cli(['probe'], env_extra=self.env)
        env_b = dict(self.env)
        env_b['CLAUDE_PROJECT_DIR'] = other_project
        stdout_b, _, _ = run_cli(['probe'], env_extra=env_b)

        hash_a = [l.split(':', 1)[1].strip() for l in stdout_a.splitlines()
                  if l.startswith('project_hash:')][0]
        hash_b = [l.split(':', 1)[1].strip() for l in stdout_b.splitlines()
                  if l.startswith('project_hash:')][0]
        self.assertNotEqual(hash_a, hash_b,
            'different project dirs must yield different hashes')

    def test_session_env_var_controls_grouping(self):
        env_a = dict(self.env); env_a['SHIPYARD_LOGCAP_SESSION'] = 'wave-1'
        env_b = dict(self.env); env_b['SHIPYARD_LOGCAP_SESSION'] = 'wave-2'
        run_cli(['run', 'a', '--', 'sh', '-c', 'true'], env_extra=env_a)
        run_cli(['run', 'b', '--', 'sh', '-c', 'true'], env_extra=env_b)

        stdout, _, _ = run_cli(['list'], env_extra=self.env)
        self.assertIn('wave-1', stdout)
        self.assertIn('wave-2', stdout)

    def test_rejects_invalid_session_env_var(self):
        env = dict(self.env)
        env['SHIPYARD_LOGCAP_SESSION'] = '../escape'
        _, stderr, rc = run_cli(
            ['run', 'ok', '--', 'sh', '-c', 'true'],
            env_extra=env,
        )
        self.assertNotEqual(rc, 0)
        self.assertIn('SHIPYARD_LOGCAP_SESSION', stderr)


if __name__ == '__main__':
    unittest.main()
