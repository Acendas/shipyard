"""End-to-end test for the Monitor verify-run sentinel pattern documented in
dispatching-operational-task/SKILL.md Phase 1.

The sentinel-file pattern is the only one we ship. The naive
`<verify> | tee | grep` masks verify's exit with grep's; pipefail +
PIPESTATUS doesn't survive the `|| true` needed to suppress grep's
no-match exit. The sentinel writes verify's exit BEFORE the pipe, so
the pipe's apparent exit is irrelevant.

Regression cases:
- Green run, filter matches lines → verify exit 0 recorded
- Green run, filter matches NO lines → verify exit 0 recorded (was 1
  under the naive pattern)
- Red run, filter matches lines → verify exit code recorded
- Red run, filter matches NO lines → verify exit code recorded
- Generic-fallback filter must match common progress AND failure
  signatures so a healthy run produces events AND a crash produces
  events ("silence is not success").
"""

import os
import subprocess
import tempfile
import unittest


def run_sentinel_pattern(verify_command, capture_path, exit_path, filter_pattern):
    """The sentinel-file pattern from dispatching-operational-task SKILL.md.

    Writes the verify's exit code into <exit_path> BEFORE the pipe runs,
    so the pipeline's exit (which is grep's exit) is irrelevant. Reads
    the sentinel after to recover the authoritative exit code.
    """
    # Inner subshell around verify so its `exit` (if any) only kills the
    # inner subshell — outer still runs `echo $?` to write the sentinel.
    cmd = (
        f"( ({verify_command}); echo $? > {exit_path} ) 2>&1 "
        f"| tee {capture_path} "
        f"| grep -E --line-buffered '{filter_pattern}' || true"
    )
    subprocess.run(
        ["sh", "-c", cmd],
        capture_output=True,
        text=True,
        timeout=10,
    )
    with open(exit_path) as f:
        return int(f.read().strip())


class TestMonitorSentinelPattern(unittest.TestCase):

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.capture = os.path.join(self.tmpdir, "run.log")
        self.exit_file = os.path.join(self.tmpdir, "run.exit")

    def test_green_run_with_filter_match_records_zero(self):
        verify = "printf 'PASS test_one\\nPASS test_two\\n'"
        rc = run_sentinel_pattern(verify, self.capture, self.exit_file, "PASS|FAIL")
        self.assertEqual(rc, 0)

    def test_green_run_with_no_filter_match_records_zero(self):
        """The headline regression. Healthy verify, filter matches zero
        lines → must still record exit 0, not the pipeline's apparent 1."""
        verify = "printf 'silent green output\\n'"
        rc = run_sentinel_pattern(verify, self.capture, self.exit_file, "PASS|FAIL")
        self.assertEqual(rc, 0,
            "filter matching no lines must not mask verify's exit 0")

    def test_red_run_with_filter_match_records_exit_code(self):
        verify = "printf 'FAIL test_one\\n'; exit 2"
        rc = run_sentinel_pattern(verify, self.capture, self.exit_file, "PASS|FAIL")
        self.assertEqual(rc, 2)

    def test_red_run_with_no_filter_match_records_exit_code(self):
        verify = "printf 'silent red\\n'; exit 5"
        rc = run_sentinel_pattern(verify, self.capture, self.exit_file, "PASS|FAIL")
        self.assertEqual(rc, 5)

    def test_capture_file_contains_verify_output(self):
        verify = "printf 'line1\\nline2\\nline3\\n'"
        run_sentinel_pattern(verify, self.capture, self.exit_file, "PASS")
        with open(self.capture) as f:
            content = f.read()
        self.assertIn("line1", content)
        self.assertIn("line2", content)
        self.assertIn("line3", content)


class TestMonitorFilterCovers(unittest.TestCase):
    """Sanity check on the documented generic-fallback filter — it must
    match both progress and failure signatures.
    """

    GENERIC_FILTER = (
        r"PASS|FAIL|✓|✗|Tests:|Suites:|Ran [0-9]+|"
        r"Traceback|Error|FAILED|assert|Killed|OOM|"
        r"Segmentation fault|panic:"
    )

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.capture = os.path.join(self.tmpdir, "run.log")

    def _count_filtered(self, verify):
        proc = subprocess.run(
            ["bash", "-c",
             f"({verify}) 2>&1 | tee {self.capture} | "
             f"grep -E --line-buffered '{self.GENERIC_FILTER}' | wc -l"],
            capture_output=True, text=True, timeout=5,
        )
        return int(proc.stdout.strip())

    def test_filter_matches_progress_marker(self):
        verify = "printf 'PASS test_a\\nPASS test_b\\nTests: 2 passed\\n'"
        self.assertGreater(self._count_filtered(verify), 0,
            "generic filter must match progress markers")

    def test_filter_matches_failure_signature(self):
        verify = "printf 'Running...\\nTraceback (most recent call last):\\n  AssertionError\\n'"
        self.assertGreater(self._count_filtered(verify), 0,
            "generic filter must match failure signatures")

    def test_filter_matches_panic(self):
        verify = "printf 'Running...\\npanic: runtime error\\n'"
        self.assertGreater(self._count_filtered(verify), 0,
            "generic filter must match Go-style panics")


if __name__ == "__main__":
    unittest.main()
