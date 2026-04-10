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

    def test_rejects_sub_1k_max_size(self):
        # Min is 1 * 1024 = 1024. With line-boundary rotation (carry-over
        # buffer keyed on \n), chunk size no longer sets a floor — the
        # minimum exists only so rotation bookkeeping doesn't dominate
        # real capture bytes at extremely small sizes.
        #
        # Historically the floor was 64K because chunk-boundary rotation
        # couldn't split a chunk mid-text. That limitation no longer
        # applies after the line-boundary rotation fix; see the "Line
        # boundaries and rotation" section in live-capture.md.
        for bad in ['1', '100', '500', '1023']:
            _, stderr, rc = run_cli(
                ['run', 'tiny', '--max-size', bad,
                 '--', 'sh', '-c', 'true'],
                env_extra=self.env,
            )
            self.assertNotEqual(rc, 0, f'size {bad!r} should be rejected')
            self.assertIn('1024', stderr,
                f'error for {bad!r} should mention the 1K floor')

    def test_rejects_zero_max_files(self):
        _, _, rc = run_cli(
            ['run', 'zero', '--max-files', '0', '--', 'sh', '-c', 'true'],
            env_extra=self.env,
        )
        self.assertNotEqual(rc, 0)

    def test_parses_valid_size_units(self):
        # All values must be >= 1K to pass the (lowered) floor check.
        for size in ['1K', '64K', '128K', '1M', '2m', '65536']:
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


class TestLineBoundaryRotation(LogcapTestBase):
    """Load-bearing test for the line-boundary rotation fix. Without it,
    high-rate streams like `adb logcat` get lines cut across rotation
    boundaries, and `grep` against either file misses the match.

    The test emits a known pattern of complete lines, forces many
    rotations via a tight --max-size, then concatenates all rotated files
    and asserts every original line is present intact (no broken lines).
    """

    def _cat_all_rotations(self, name):
        """Read the base capture file plus all .log.N rotations, return
        the concatenated content as a single string (oldest first so the
        ordering matches the child's emission order)."""
        stdout, _, _ = run_cli(['path', name], env_extra=self.env)
        live_path = stdout.strip()
        directory = os.path.dirname(live_path)
        # Order: highest .N first (oldest), then base file (newest).
        rotations = []
        for entry in sorted(os.listdir(directory), reverse=True):
            if entry.startswith(os.path.basename(live_path) + '.'):
                with open(os.path.join(directory, entry)) as f:
                    rotations.append(f.read())
        with open(live_path) as f:
            rotations.append(f.read())
        return ''.join(rotations)

    def test_high_volume_rotation_preserves_line_boundaries(self):
        """Emit 200 distinctive long lines under a tight 2K bound — this
        will trigger rotation ~every 20–30 lines. Every original line
        must appear intact in the concatenated output. A broken line
        (split mid-message at a rotation boundary) is a test failure."""
        # Each line is ~80 chars; at max-size 2K we rotate every ~25 lines
        # across 200 lines → ~8 rotations during this capture.
        cmd = ('for i in $(seq 1 200); do '
               'printf "line_%03d_ActivityManager: Starting activity message_here_padding\\n" $i; '
               'done')
        _, _, rc = run_cli(
            ['run', 'linetest', '--max-size', '2048', '--max-files', '20',
             '--', 'sh', '-c', cmd],
            env_extra=self.env,
        )
        self.assertEqual(rc, 0)

        content = self._cat_all_rotations('linetest')
        lines = [l for l in content.split('\n') if l]
        # Every line should match the exact pattern — no truncation.
        import re
        pattern = re.compile(
            r'^line_\d{3}_ActivityManager: Starting activity message_here_padding$'
        )
        broken = [l for l in lines if not pattern.match(l)]
        self.assertEqual(broken, [],
            f'found {len(broken)} broken lines (first 3): {broken[:3]}')
        # And every line 001–200 should be present.
        self.assertEqual(len(lines), 200,
            f'expected 200 lines, got {len(lines)}')

    def test_eof_flushes_unterminated_final_line(self):
        """If the child emits a final line without a trailing newline,
        the carry buffer must be flushed at EOF so the line lands on
        disk. Without the flush, the tail of the output would silently
        disappear."""
        _, _, rc = run_cli(
            ['run', 'noeof', '--', 'sh', '-c',
             'printf "line1\\nline2\\nfinal-no-newline"'],
            env_extra=self.env,
        )
        self.assertEqual(rc, 0)

        content = self._cat_all_rotations('noeof')
        self.assertIn('line1', content)
        self.assertIn('line2', content)
        self.assertIn('final-no-newline', content)


class TestCmdFile(LogcapTestBase):
    """Tests for --cmd-file — the Windows-safe / shell-hostile command
    escape hatch that reads argv tokens from a file instead of the command
    line. Needed for things like `adb logcat ActivityManager:I '*:S'`
    where the filter spec has globs and quotes that cmd.exe mangles."""

    def _write_cmd_file(self, lines):
        path = os.path.join(self.tmp_root, 'cmd.txt')
        with open(path, 'w') as f:
            f.write('\n'.join(lines) + '\n')
        return path

    def test_cmd_file_runs_command(self):
        cmd_path = self._write_cmd_file([
            '# comment (should be ignored)',
            '',  # blank line (should be ignored)
            'sh',
            '-c',
            'echo "hello from cmd-file"',
        ])
        _, _, rc = run_cli(
            ['run', 'cmdfiletest', '--cmd-file', cmd_path],
            env_extra=self.env,
        )
        self.assertEqual(rc, 0)

        stdout, _, _ = run_cli(['path', 'cmdfiletest'], env_extra=self.env)
        with open(stdout.strip()) as f:
            content = f.read()
        self.assertIn('hello from cmd-file', content)

    def test_cmd_file_preserves_shell_hostile_tokens(self):
        """The whole point of --cmd-file: tokens with spaces, globs,
        quotes, colons land verbatim in argv without shell re-tokenization.
        Simulates the adb logcat filter use case."""
        cmd_path = self._write_cmd_file([
            'sh',
            '-c',
            # This line contains spaces, a literal *, single quotes, and colons
            "echo 'ActivityManager:I *:S token with spaces'",
        ])
        _, _, rc = run_cli(
            ['run', 'hostile', '--cmd-file', cmd_path],
            env_extra=self.env,
        )
        self.assertEqual(rc, 0)

        stdout, _, _ = run_cli(['path', 'hostile'], env_extra=self.env)
        with open(stdout.strip()) as f:
            content = f.read()
        self.assertIn('ActivityManager:I *:S token with spaces', content)

    def test_cmd_file_and_dashdash_mutually_exclusive(self):
        cmd_path = self._write_cmd_file(['sh', '-c', 'true'])
        _, stderr, rc = run_cli(
            ['run', 'both', '--cmd-file', cmd_path, '--', 'sh', '-c', 'true'],
            env_extra=self.env,
        )
        self.assertNotEqual(rc, 0)
        self.assertIn('mutually exclusive', stderr)

    def test_cmd_file_missing_path_fails(self):
        _, stderr, rc = run_cli(
            ['run', 'missing', '--cmd-file', '/nonexistent/path.txt'],
            env_extra=self.env,
        )
        self.assertNotEqual(rc, 0)
        self.assertIn('cannot read', stderr)

    def test_cmd_file_empty_file_fails(self):
        cmd_path = self._write_cmd_file(['# only a comment', ''])
        _, stderr, rc = run_cli(
            ['run', 'empty', '--cmd-file', cmd_path],
            env_extra=self.env,
        )
        self.assertNotEqual(rc, 0)
        self.assertIn('no command tokens', stderr)


class TestActiveSessionFile(LogcapTestBase):
    """Tests for the <SHIPYARD_DATA>/.active-logcap-session file sentinel
    that replaces the env-var-based session grouping. Bulletproof across
    Claude Code Bash tool calls (which don't share env state between
    invocations)."""

    def _data_dir(self):
        stdout, _, _ = run_cli([], env_extra=self.env)
        # logcap doesn't print the data dir — use shipyard-data for that.
        result = subprocess.run(
            ['node', os.path.join(os.path.dirname(CLI), 'shipyard-data.mjs')],
            capture_output=True, text=True,
            env={**os.environ, **self.env, **{
                k: '' for k in ['CLAUDE_PROJECT_DIR'] if k not in self.env
            }},
        )
        return result.stdout.strip()

    def test_active_session_file_controls_grouping(self):
        # Initialize the data dir (ensures the directory exists)
        subprocess.run(
            ['node', os.path.join(os.path.dirname(CLI), 'shipyard-data.mjs'), 'init'],
            capture_output=True, text=True,
            env={**os.environ, **self.env},
        )
        data_dir = self._data_dir()
        session_file = os.path.join(data_dir, '.active-logcap-session')
        with open(session_file, 'w') as f:
            f.write('sprint-007-wave-2')

        # No env var set — logcap should read the file
        env_no_session = dict(self.env)
        env_no_session.pop('SHIPYARD_LOGCAP_SESSION', None)

        _, _, rc = run_cli(
            ['run', 'filesess', '--', 'sh', '-c', 'echo hello'],
            env_extra=env_no_session,
        )
        self.assertEqual(rc, 0)

        stdout, _, _ = run_cli(['path', 'filesess'], env_extra=env_no_session)
        capture_path = stdout.strip()
        # The capture path should contain the session name from the file
        self.assertIn('sprint-007-wave-2', capture_path)

    def test_env_var_beats_active_session_file(self):
        subprocess.run(
            ['node', os.path.join(os.path.dirname(CLI), 'shipyard-data.mjs'), 'init'],
            capture_output=True, text=True,
            env={**os.environ, **self.env},
        )
        data_dir = self._data_dir()
        session_file = os.path.join(data_dir, '.active-logcap-session')
        with open(session_file, 'w') as f:
            f.write('file-wins')

        env_with_env = dict(self.env)
        env_with_env['SHIPYARD_LOGCAP_SESSION'] = 'env-wins'

        _, _, rc = run_cli(
            ['run', 'envbeats', '--', 'sh', '-c', 'echo hello'],
            env_extra=env_with_env,
        )
        self.assertEqual(rc, 0)

        stdout, _, _ = run_cli(['path', 'envbeats'], env_extra=env_with_env)
        capture_path = stdout.strip()
        self.assertIn('env-wins', capture_path)
        self.assertNotIn('file-wins', capture_path)

    def test_invalid_session_file_falls_through_to_daily(self):
        subprocess.run(
            ['node', os.path.join(os.path.dirname(CLI), 'shipyard-data.mjs'), 'init'],
            capture_output=True, text=True,
            env={**os.environ, **self.env},
        )
        data_dir = self._data_dir()
        session_file = os.path.join(data_dir, '.active-logcap-session')
        # Plant invalid content that won't match the allowlist
        with open(session_file, 'w') as f:
            f.write('../escape/attempt')

        env_no_session = dict(self.env)
        env_no_session.pop('SHIPYARD_LOGCAP_SESSION', None)

        # Should fall through to per-day fallback, not fail
        _, _, rc = run_cli(
            ['run', 'fallback', '--', 'sh', '-c', 'echo hello'],
            env_extra=env_no_session,
        )
        self.assertEqual(rc, 0)

        stdout, _, _ = run_cli(['path', 'fallback'], env_extra=env_no_session)
        capture_path = stdout.strip()
        # The session directory should be session-YYYYMMDD, not the bad content
        self.assertIn('session-', capture_path)
        self.assertNotIn('escape', capture_path)


if __name__ == '__main__':
    unittest.main()
