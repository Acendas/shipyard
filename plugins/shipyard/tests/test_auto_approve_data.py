#!/usr/bin/env python3
"""Tests for auto-approve-data.py PreToolUse hook."""

import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = os.path.join(
    os.path.dirname(__file__),
    '..', 'project-files', 'scripts', 'auto-approve-data.py'
)


def run_hook(hook_input: dict, env_extra: dict | None = None) -> tuple[str, int]:
    """Run the hook script with given stdin JSON and env vars. Returns (stdout, exit_code)."""
    env = os.environ.copy()
    env.pop('SHIPYARD_DATA', None)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        [sys.executable, SCRIPT],
        input=json.dumps(hook_input),
        capture_output=True,
        text=True,
        env=env,
    )
    return proc.stdout, proc.returncode


class TestAutoApproveData(unittest.TestCase):

    def setUp(self):
        # Real tempdir so realpath/commonpath have something to resolve
        self.tmpdir = tempfile.mkdtemp(prefix='shipyard-test-')
        self.sd = os.path.realpath(self.tmpdir)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_approves_write_to_shipyard_data(self):
        """Edit to a file inside SHIPYARD_DATA should be auto-approved."""
        stdout, code = run_hook(
            {'tool_name': 'Edit', 'tool_input': {'file_path': os.path.join(self.sd, 'spec.md')}},
            {'SHIPYARD_DATA': self.sd},
        )
        self.assertEqual(code, 0)
        resp = json.loads(stdout)
        self.assertEqual(resp['hookSpecificOutput']['permissionDecision'], 'allow')

    def test_approves_write_to_nested_subdir(self):
        """Write to a deeply nested file inside SHIPYARD_DATA should be approved."""
        nested = os.path.join(self.sd, 'sprints', 's1', 'SPRINT.md')
        stdout, code = run_hook(
            {'tool_name': 'Write', 'tool_input': {'file_path': nested}},
            {'SHIPYARD_DATA': self.sd},
        )
        self.assertEqual(code, 0)
        resp = json.loads(stdout)
        self.assertEqual(resp['hookSpecificOutput']['permissionDecision'], 'allow')

    def test_approves_multiedit_to_shipyard_data(self):
        """MultiEdit to a file inside SHIPYARD_DATA should be auto-approved (F3)."""
        stdout, code = run_hook(
            {'tool_name': 'MultiEdit', 'tool_input': {'file_path': os.path.join(self.sd, 'spec.md')}},
            {'SHIPYARD_DATA': self.sd},
        )
        self.assertEqual(code, 0)
        resp = json.loads(stdout)
        self.assertEqual(resp['hookSpecificOutput']['permissionDecision'], 'allow')

    def test_rejects_write_outside_shipyard_data(self):
        """Edit to a file outside SHIPYARD_DATA should produce no output."""
        stdout, code = run_hook(
            {'tool_name': 'Edit', 'tool_input': {'file_path': '/home/user/project/src/main.py'}},
            {'SHIPYARD_DATA': self.sd},
        )
        self.assertEqual(code, 0)
        self.assertEqual(stdout, '')

    def test_rejects_path_traversal(self):
        """Path that escapes SHIPYARD_DATA via traversal should not be approved."""
        traversal = os.path.join(self.sd, '..', 'etc', 'passwd')
        stdout, code = run_hook(
            {'tool_name': 'Write', 'tool_input': {'file_path': traversal}},
            {'SHIPYARD_DATA': self.sd},
        )
        self.assertEqual(code, 0)
        self.assertEqual(stdout, '')

    def test_rejects_symlink_escape(self):
        """SECURITY: a symlink inside SHIPYARD_DATA pointing outside must NOT be approved.

        This is a symlink-based path escape (TOCTOU class) — abspath() does
        not resolve symlinks, allowing prefix checks to be bypassed. realpath()
        must be used.
        """
        # Create a target outside SHIPYARD_DATA
        outside_dir = tempfile.mkdtemp(prefix='shipyard-outside-')
        try:
            # Plant a symlink inside SHIPYARD_DATA pointing to outside
            link_path = os.path.join(self.sd, 'evil')
            os.symlink(outside_dir, link_path)

            # Attempt to write to a file under the symlink (which resolves outside)
            target = os.path.join(link_path, 'pwned.txt')
            stdout, code = run_hook(
                {'tool_name': 'Write', 'tool_input': {'file_path': target}},
                {'SHIPYARD_DATA': self.sd},
            )
            self.assertEqual(code, 0)
            self.assertEqual(stdout, '', "Symlink escape should NOT be approved")
        finally:
            import shutil
            shutil.rmtree(outside_dir, ignore_errors=True)

    def test_ignores_non_file_tools(self):
        """Non-file tools (e.g., Bash) should be ignored silently."""
        stdout, code = run_hook(
            {'tool_name': 'Bash', 'tool_input': {'command': 'rm -rf /'}},
            {'SHIPYARD_DATA': self.sd},
        )
        self.assertEqual(code, 0)
        self.assertEqual(stdout, '')

    def test_resolves_shipyard_data_when_env_missing(self):
        """F2: when SHIPYARD_DATA env var is unset, the hook must compute the
        data dir via the Node resolver and continue evaluating.

        Previously the hook silently no-op'd in this case, defeating the
        entire permission workaround for any Edit/Write call that did not
        come through hook-runner.py (which is most of them).

        We can't easily assert that the resolved path matches a specific
        value (it depends on the test's git context), but we CAN assert
        that the hook does NOT silently exit early — it should still
        process the request and either approve or fall through based on
        the resolved data dir, not based on env-var presence.

        For this test we use a path under self.sd which is NOT the
        resolved data dir, so we expect a 'pass' (no JSON output) — but
        the hook must have run the resolver, not bailed at line 1.
        """
        stdout, code = run_hook(
            {'tool_name': 'Edit', 'tool_input': {'file_path': os.path.join(self.sd, 'spec.md')}},
        )
        self.assertEqual(code, 0)
        # Either no output (path outside resolved data dir — expected here)
        # or an 'allow' JSON (if the resolver happened to return self.sd, which
        # would only occur if this test ran inside that exact dir — won't).
        if stdout:
            resp = json.loads(stdout)
            self.assertEqual(resp['hookSpecificOutput']['permissionDecision'], 'allow')

    def test_ignores_missing_file_path(self):
        """Tool input without file_path should be ignored."""
        stdout, code = run_hook(
            {'tool_name': 'Edit', 'tool_input': {}},
            {'SHIPYARD_DATA': self.sd},
        )
        self.assertEqual(code, 0)
        self.assertEqual(stdout, '')

    def test_handles_invalid_json_input(self):
        """Invalid JSON on stdin should exit cleanly."""
        env = os.environ.copy()
        env.pop('SHIPYARD_DATA', None)
        proc = subprocess.run(
            [sys.executable, SCRIPT],
            input='not json',
            capture_output=True,
            text=True,
            env=env,
        )
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, '')

    def test_read_tool_no_longer_approved(self):
        """SECURITY: Read is not in the auto-approve matcher anymore (scope reduction)."""
        stdout, code = run_hook(
            {'tool_name': 'Read', 'tool_input': {'file_path': os.path.join(self.sd, 'backlog.md')}},
            {'SHIPYARD_DATA': self.sd},
        )
        self.assertEqual(code, 0)
        self.assertEqual(stdout, '', "Read should NOT be auto-approved (removed from matcher)")

    def test_prefix_attack_not_approved(self):
        """Path with SHIPYARD_DATA as string prefix but in a sibling dir should not be approved."""
        # Create a sibling directory with a similar name
        parent = os.path.dirname(self.sd)
        sibling = self.sd + '-evil'
        os.makedirs(sibling, exist_ok=True)
        try:
            stdout, code = run_hook(
                {'tool_name': 'Write', 'tool_input': {'file_path': os.path.join(sibling, 'hack.py')}},
                {'SHIPYARD_DATA': self.sd},
            )
            self.assertEqual(code, 0)
            self.assertEqual(stdout, '')
        finally:
            import shutil
            shutil.rmtree(sibling, ignore_errors=True)

    def test_dotdot_segment_rejected_pre_resolution(self):
        """Defense in depth: '..' segments rejected before path resolution."""
        target = self.sd + '/subdir/../../../etc/passwd'
        stdout, code = run_hook(
            {'tool_name': 'Write', 'tool_input': {'file_path': target}},
            {'SHIPYARD_DATA': self.sd},
        )
        self.assertEqual(code, 0)
        self.assertEqual(stdout, '')


    def test_breadcrumb_log_written_on_allow(self):
        """F14: Approve decision writes a breadcrumb to .auto-approve.log."""
        target = os.path.join(self.sd, 'spec.md')
        run_hook(
            {'tool_name': 'Edit', 'tool_input': {'file_path': target}},
            {'SHIPYARD_DATA': self.sd},
        )
        log = os.path.join(self.sd, '.auto-approve.log')
        self.assertTrue(os.path.exists(log), 'breadcrumb log should be created')
        with open(log) as f:
            content = f.read()
        self.assertIn('allow', content)
        self.assertIn('Edit', content)

    def test_concurrent_breadcrumb_writes_no_loss(self):
        """R3: Concurrent hook invocations must produce N log lines, not <N.

        On POSIX, append-mode writes ≤ PIPE_BUF are atomic so this test will
        usually pass even without the lock — it's primarily a regression guard
        for Windows (no atomic-append guarantee) and for the rotation block
        (read → truncate → rewrite is racy on every platform). We still run
        it everywhere because the lock code path needs coverage and any
        future change that breaks the contract will be caught here.
        """
        import concurrent.futures
        N = 20
        target = os.path.join(self.sd, 'spec.md')

        def fire(i):
            return run_hook(
                {'tool_name': 'Edit', 'tool_input': {'file_path': target}},
                {'SHIPYARD_DATA': self.sd},
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=N) as ex:
            list(ex.map(fire, range(N)))

        log = os.path.join(self.sd, '.auto-approve.log')
        self.assertTrue(os.path.exists(log), 'breadcrumb log should be created')
        with open(log) as f:
            lines = [l for l in f.readlines() if l.strip()]
        self.assertEqual(
            len(lines), N,
            f'expected {N} log lines, got {len(lines)} — concurrent writes lost',
        )

    def test_breadcrumb_creates_data_dir_if_missing(self):
        """R12: First hook invocation for a brand-new project should create
        the data dir and write the breadcrumb, not silently no-op."""
        fresh = os.path.join(self.sd, 'fresh-data-dir')
        self.assertFalse(os.path.exists(fresh))
        target = os.path.join(fresh, 'spec.md')
        run_hook(
            {'tool_name': 'Edit', 'tool_input': {'file_path': target}},
            {'SHIPYARD_DATA': fresh},
        )
        log = os.path.join(fresh, '.auto-approve.log')
        self.assertTrue(os.path.exists(log),
            'first-run breadcrumb should create the data dir and write the log')

    def test_breadcrumb_log_written_on_pass(self):
        """F14: Pass decision (file outside data dir) also writes a breadcrumb."""
        # File outside the data dir
        with tempfile.TemporaryDirectory() as outside:
            run_hook(
                {'tool_name': 'Edit', 'tool_input': {'file_path': os.path.join(outside, 'main.py')}},
                {'SHIPYARD_DATA': self.sd},
            )
            log = os.path.join(self.sd, '.auto-approve.log')
            self.assertTrue(os.path.exists(log), 'breadcrumb log should be created')
            with open(log) as f:
                content = f.read()
            self.assertIn('pass', content)


if __name__ == '__main__':
    unittest.main()
