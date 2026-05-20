#!/usr/bin/env python3
"""Tests for `shipyard-data init-sprint <sprint-id>`.

The subcommand replaces the prior model-improvised "Use Write to create
SPRINT.md and PROGRESS.md" flow in /ship-sprint Step 11.1. The improvised
path drifted from the canonical templates at project-files/templates/ and
produced non-canonical schemas (Wave Status tables, Tasks Completed lists)
that triggered /ship-review drift alarms. These tests pin the contract:

  1. Successful init copies templates byte-for-byte (modulo id/created
     substitution) into sprints/current/.
  2. PROGRESS.md has no id/created substitution — it's written verbatim.
  3. Refuses to overwrite an existing SPRINT.md or PROGRESS.md.
  4. Strict sprint-id validation rejects malformed IDs.
  5. Missing argument prints a usage message and exits non-zero.
"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest

CLI = os.path.join(
    os.path.dirname(__file__),
    '..', 'bin', 'shipyard-data.mjs'
)
TEMPLATE_DIR = os.path.join(
    os.path.dirname(__file__),
    '..', 'project-files', 'templates'
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


class TestInitSprint(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-init-sprint-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        # Make the project dir a git repo so the resolver classifies it correctly.
        subprocess.run(['git', 'init', '-q'], cwd=self.project_dir, check=True)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }
        # Resolve the per-test data dir
        out, _, code = run_cli([], env_extra=self.env)
        self.assertEqual(code, 0)
        self.data_dir = out.strip()
        self.current = os.path.join(self.data_dir, 'sprints', 'current')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_happy_path_creates_both_files(self):
        out, err, code = run_cli(
            ['init-sprint', 'sprint-007'], env_extra=self.env,
        )
        self.assertEqual(code, 0, f'init-sprint failed: {err}')
        self.assertEqual(out.strip(), self.current)

        sprint_path = os.path.join(self.current, 'SPRINT.md')
        progress_path = os.path.join(self.current, 'PROGRESS.md')
        self.assertTrue(os.path.exists(sprint_path))
        self.assertTrue(os.path.exists(progress_path))

    def test_sprint_id_substituted_into_frontmatter(self):
        run_cli(['init-sprint', 'sprint-042'], env_extra=self.env)
        with open(os.path.join(self.current, 'SPRINT.md')) as f:
            content = f.read()
        self.assertRegex(content, re.compile(r'^id: sprint-042\s*$', re.M),
                         'id field must be substituted with the passed sprint ID')

    def test_created_substituted_with_iso_date(self):
        run_cli(['init-sprint', 'sprint-001'], env_extra=self.env)
        with open(os.path.join(self.current, 'SPRINT.md')) as f:
            content = f.read()
        # Match `created: YYYY-MM-DD` (ISO date)
        self.assertRegex(
            content,
            re.compile(r'^created: \d{4}-\d{2}-\d{2}\s*$', re.M),
            'created field must be substituted with ISO date'
        )

    def test_progress_md_is_byte_for_byte_template(self):
        run_cli(['init-sprint', 'sprint-001'], env_extra=self.env)
        with open(os.path.join(self.current, 'PROGRESS.md')) as f:
            produced = f.read()
        with open(os.path.join(TEMPLATE_DIR, 'PROGRESS.md')) as f:
            template = f.read()
        self.assertEqual(produced, template,
                         'PROGRESS.md must be byte-for-byte the canonical template '
                         '(no model-improvised sections)')

    def test_sprint_md_matches_template_except_for_substitutions(self):
        run_cli(['init-sprint', 'sprint-001'], env_extra=self.env)
        with open(os.path.join(self.current, 'SPRINT.md')) as f:
            produced = f.read()
        with open(os.path.join(TEMPLATE_DIR, 'SPRINT.md')) as f:
            template = f.read()
        # Normalize both: replace the substituted fields with placeholders
        def normalize(s):
            s = re.sub(r'^id: sprint-\d+\s*$', 'id: <substituted>', s, flags=re.M)
            s = re.sub(r'^created: (null|\d{4}-\d{2}-\d{2})\s*$', 'created: <substituted>', s, flags=re.M)
            return s
        self.assertEqual(normalize(produced), normalize(template),
                         'SPRINT.md must match the canonical template '
                         'except for id and created field substitution')

    def test_refuses_to_overwrite_existing_sprint_md(self):
        # First creation
        out1, _, code1 = run_cli(['init-sprint', 'sprint-001'], env_extra=self.env)
        self.assertEqual(code1, 0)
        # Capture the original content + mtime
        sprint_path = os.path.join(self.current, 'SPRINT.md')
        with open(sprint_path) as f:
            original = f.read()
        # Second creation must refuse
        out2, err2, code2 = run_cli(
            ['init-sprint', 'sprint-002'], env_extra=self.env,
        )
        self.assertNotEqual(code2, 0,
                           'init-sprint must refuse when sprints/current/ is populated')
        self.assertIn('Refusing to overwrite', err2)
        # Confirm the original file is untouched
        with open(sprint_path) as f:
            self.assertEqual(f.read(), original)

    def test_invalid_sprint_id_rejected(self):
        out, err, code = run_cli(
            ['init-sprint', 'not-a-sprint-id'], env_extra=self.env,
        )
        self.assertNotEqual(code, 0)
        self.assertIn('invalid sprint ID', err)

    def test_short_id_rejected(self):
        out, err, code = run_cli(
            ['init-sprint', 'sprint-1'], env_extra=self.env,
        )
        self.assertNotEqual(code, 0)
        self.assertIn('invalid sprint ID', err)

    def test_missing_arg_prints_usage(self):
        out, err, code = run_cli(['init-sprint'], env_extra=self.env)
        self.assertNotEqual(code, 0)
        self.assertIn('missing sprint ID', err)
        self.assertIn('Usage: shipyard-data init-sprint <sprint-id>', err)


if __name__ == '__main__':
    unittest.main()
