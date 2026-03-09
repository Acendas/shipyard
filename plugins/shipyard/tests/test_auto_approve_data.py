#!/usr/bin/env python3
"""Tests for auto-approve-data.py PreToolUse hook."""

import json
import os
import subprocess
import sys
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

    def test_approves_write_to_shipyard_data(self):
        """Edit to a file inside SHIPYARD_DATA should be auto-approved."""
        stdout, code = run_hook(
            {'tool_name': 'Edit', 'tool_input': {'file_path': '/tmp/shipyard-data/projects/abc/spec.md'}},
            {'SHIPYARD_DATA': '/tmp/shipyard-data/projects/abc'},
        )
        self.assertEqual(code, 0)
        resp = json.loads(stdout)
        self.assertEqual(resp['hookSpecificOutput']['permissionDecision'], 'allow')

    def test_approves_write_to_nested_subdir(self):
        """Write to a deeply nested file inside SHIPYARD_DATA should be approved."""
        stdout, code = run_hook(
            {'tool_name': 'Write', 'tool_input': {'file_path': '/tmp/sd/sprints/s1/SPRINT.md'}},
            {'SHIPYARD_DATA': '/tmp/sd'},
        )
        self.assertEqual(code, 0)
        resp = json.loads(stdout)
        self.assertEqual(resp['hookSpecificOutput']['permissionDecision'], 'allow')

    def test_rejects_write_outside_shipyard_data(self):
        """Edit to a file outside SHIPYARD_DATA should produce no output (silent pass-through)."""
        stdout, code = run_hook(
            {'tool_name': 'Edit', 'tool_input': {'file_path': '/home/user/project/src/main.py'}},
            {'SHIPYARD_DATA': '/tmp/shipyard-data/projects/abc'},
        )
        self.assertEqual(code, 0)
        self.assertEqual(stdout, '')

    def test_rejects_path_traversal(self):
        """Path that escapes SHIPYARD_DATA via traversal should not be approved."""
        stdout, code = run_hook(
            {'tool_name': 'Write', 'tool_input': {'file_path': '/tmp/sd/../etc/passwd'}},
            {'SHIPYARD_DATA': '/tmp/sd'},
        )
        self.assertEqual(code, 0)
        self.assertEqual(stdout, '')

    def test_ignores_non_file_tools(self):
        """Non-file tools (e.g., Bash) should be ignored silently."""
        stdout, code = run_hook(
            {'tool_name': 'Bash', 'tool_input': {'command': 'rm -rf /'}},
            {'SHIPYARD_DATA': '/tmp/sd'},
        )
        self.assertEqual(code, 0)
        self.assertEqual(stdout, '')

    def test_ignores_missing_shipyard_data_env(self):
        """No SHIPYARD_DATA env var should produce no output."""
        stdout, code = run_hook(
            {'tool_name': 'Edit', 'tool_input': {'file_path': '/tmp/sd/spec.md'}},
        )
        self.assertEqual(code, 0)
        self.assertEqual(stdout, '')

    def test_ignores_missing_file_path(self):
        """Tool input without file_path should be ignored."""
        stdout, code = run_hook(
            {'tool_name': 'Edit', 'tool_input': {}},
            {'SHIPYARD_DATA': '/tmp/sd'},
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

    def test_approves_read_to_shipyard_data(self):
        """Read tool on SHIPYARD_DATA file should be approved."""
        stdout, code = run_hook(
            {'tool_name': 'Read', 'tool_input': {'file_path': '/tmp/sd/backlog.md'}},
            {'SHIPYARD_DATA': '/tmp/sd'},
        )
        self.assertEqual(code, 0)
        resp = json.loads(stdout)
        self.assertEqual(resp['hookSpecificOutput']['permissionDecision'], 'allow')

    def test_prefix_attack_not_approved(self):
        """Path that starts with SHIPYARD_DATA as prefix but isn't inside it should not be approved."""
        stdout, code = run_hook(
            {'tool_name': 'Write', 'tool_input': {'file_path': '/tmp/sd-evil/hack.py'}},
            {'SHIPYARD_DATA': '/tmp/sd'},
        )
        self.assertEqual(code, 0)
        self.assertEqual(stdout, '')


if __name__ == '__main__':
    unittest.main()
