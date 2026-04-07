#!/usr/bin/env python3
"""Tests for bin/shipyard-context.mjs named subcommands.

These subcommands exist so skill pre-exec lines don't pass quoted-with-spaces
arguments to the CLI — on Windows, `.cmd` wrappers mangle such args via
cmd.exe's `%*` quoting. Keeping fallbacks inside the Node CLI makes every
pre-exec single-token and cross-platform. See bin/shipyard-context.mjs
header comment and CLAUDE.md "Cross-Platform" section.

Every test isolates CLAUDE_PLUGIN_DATA so the real data dir is never touched.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

CLI = os.path.join(os.path.dirname(__file__), '..', 'bin', 'shipyard-context.mjs')
PLUGIN_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


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


class NamedSubcommandBase(unittest.TestCase):
    """Sandboxed plugin data dir + project dir per test."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-ctx-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        # Turn project dir into a git repo so resolver finds a project root.
        subprocess.run(['git', 'init', '-q'], cwd=self.project_dir, check=True)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def resolve_data_dir(self):
        """Discover the per-project data dir the resolver picked."""
        out, _, rc = run_cli(['path'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0, f"shipyard-context path failed: {out}")
        # Format: SHIPYARD_DATA=/absolute/path
        line = out.strip()
        self.assertTrue(line.startswith('SHIPYARD_DATA='), line)
        return line[len('SHIPYARD_DATA='):]

    def write_data_file(self, relpath, content):
        data_dir = self.resolve_data_dir()
        full = os.path.join(data_dir, relpath)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'w') as f:
            f.write(content)


class TestViewSubcommand(NamedSubcommandBase):

    def test_view_config_fallback_when_missing(self):
        out, _, rc = run_cli(['view', 'config'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0)
        self.assertIn('No project initialized', out)

    def test_view_config_reads_file(self):
        self.write_data_file('config.md', 'project: test\nversion: 1\n')
        out, _, rc = run_cli(['view', 'config'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0)
        self.assertIn('project: test', out)

    def test_view_backlog_fallback(self):
        out, _, _ = run_cli(['view', 'backlog'], env_extra=self.env, cwd=self.project_dir)
        self.assertIn('No backlog yet', out)

    def test_view_sprint_fallback(self):
        out, _, _ = run_cli(['view', 'sprint'], env_extra=self.env, cwd=self.project_dir)
        self.assertIn('No active sprint', out)

    def test_view_metrics_reads_file(self):
        self.write_data_file('memory/metrics.md', 'velocity: 8\n')
        out, _, _ = run_cli(['view', 'metrics'], env_extra=self.env, cwd=self.project_dir)
        self.assertIn('velocity: 8', out)

    def test_view_lines_override(self):
        self.write_data_file('config.md', ''.join(f'line{i}\n' for i in range(100)))
        out, _, _ = run_cli(['view', 'config', '3'], env_extra=self.env, cwd=self.project_dir)
        # 3 lines means 3 newline chars
        self.assertEqual(out.count('\n'), 3 + 1)  # +1 for trailing newline from println

    def test_view_unknown_name_errors(self):
        _, err, rc = run_cli(['view', 'bogus'], env_extra=self.env, cwd=self.project_dir)
        self.assertNotEqual(rc, 0)
        self.assertIn('unknown view name', err)

    def test_view_all_registry_names_resolve(self):
        """Sanity: every registered name either returns its fallback or reads a file.
        Catches a future typo where the registry points at a path safeJoin rejects."""
        for name in ['config', 'codebase', 'backlog', 'sprint', 'sprint-progress',
                     'sprint-handoff', 'metrics', 'data-version']:
            out, err, rc = run_cli(['view', name], env_extra=self.env, cwd=self.project_dir)
            self.assertEqual(rc, 0, f"{name}: rc={rc} err={err}")
            self.assertTrue(out.strip(), f"{name}: empty output")


class TestListSubcommand(NamedSubcommandBase):

    def test_list_epics_fallback(self):
        out, _, _ = run_cli(['list', 'epics'], env_extra=self.env, cwd=self.project_dir)
        self.assertIn('No epics yet', out)

    def test_list_epics_reads_dir(self):
        self.write_data_file('spec/epics/E-001.md', '# Epic 1\n')
        self.write_data_file('spec/epics/E-002.md', '# Epic 2\n')
        out, _, _ = run_cli(['list', 'epics'], env_extra=self.env, cwd=self.project_dir)
        self.assertIn('E-001.md', out)
        self.assertIn('E-002.md', out)

    def test_list_features_fallback(self):
        out, _, _ = run_cli(['list', 'features'], env_extra=self.env, cwd=self.project_dir)
        self.assertIn('No features yet', out)

    def test_list_debug_sessions_glob_fallback(self):
        out, _, _ = run_cli(['list', 'debug-sessions'], env_extra=self.env, cwd=self.project_dir)
        self.assertIn('No active debug sessions', out)

    def test_list_debug_sessions_glob_match(self):
        self.write_data_file('debug/stuck-oauth.md', '# debug\n')
        out, _, _ = run_cli(['list', 'debug-sessions'], env_extra=self.env, cwd=self.project_dir)
        self.assertIn('stuck-oauth.md', out)

    def test_list_quick_tasks_sorted(self):
        self.write_data_file('spec/tasks/Q-003.md', 'x')
        self.write_data_file('spec/tasks/Q-001.md', 'x')
        self.write_data_file('spec/tasks/Q-002.md', 'x')
        out, _, _ = run_cli(['list', 'quick-tasks'], env_extra=self.env, cwd=self.project_dir)
        lines = [l for l in out.strip().split('\n') if l.startswith('Q-')]
        self.assertEqual(lines, ['Q-001.md', 'Q-002.md', 'Q-003.md'])

    def test_list_unknown_name_errors(self):
        _, err, rc = run_cli(['list', 'bogus'], env_extra=self.env, cwd=self.project_dir)
        self.assertNotEqual(rc, 0)
        self.assertIn('unknown list name', err)


class TestCountOfSubcommand(NamedSubcommandBase):

    def test_count_of_bugs_empty(self):
        out, _, _ = run_cli(['count-of', 'bugs'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(out.strip(), '0')

    def test_count_of_bugs_populated(self):
        self.write_data_file('spec/bugs/B-001.md', 'x')
        self.write_data_file('spec/bugs/B-002.md', 'x')
        out, _, _ = run_cli(['count-of', 'bugs'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(out.strip(), '2')

    def test_count_of_unknown_errors(self):
        _, err, rc = run_cli(['count-of', 'bogus'], env_extra=self.env, cwd=self.project_dir)
        self.assertNotEqual(rc, 0)
        self.assertIn('unknown count-of name', err)


class TestReferenceSubcommand(NamedSubcommandBase):
    """Reads plugin reference files via CLAUDE_PLUGIN_ROOT.

    Security-critical: this subcommand builds a filesystem path from skill-body
    content, so the allowlist regexes and realpath containment are what prevent
    a malicious skill body from escaping the plugin tree.
    """

    def setUp(self):
        super().setUp()
        self.env['CLAUDE_PLUGIN_ROOT'] = PLUGIN_ROOT

    def test_reads_real_reference(self):
        # ship-discuss/references/challenge-surface.md exists in the tree.
        out, _, rc = run_cli(
            ['reference', 'ship-discuss', 'challenge-surface', '5'],
            env_extra=self.env, cwd=self.project_dir,
        )
        self.assertEqual(rc, 0)
        self.assertTrue(out.strip(), 'expected non-empty reference output')

    def test_rejects_invalid_skill_slug(self):
        out, _, _ = run_cli(
            ['reference', '../etc', 'passwd'],
            env_extra=self.env, cwd=self.project_dir,
        )
        self.assertIn('invalid skill slug', out)

    def test_rejects_invalid_reference_name(self):
        out, _, _ = run_cli(
            ['reference', 'ship-discuss', '../../../../etc/passwd'],
            env_extra=self.env, cwd=self.project_dir,
        )
        self.assertIn('invalid reference name', out)

    def test_rejects_slash_in_reference_name(self):
        # Even if each segment matches the char class, a slash must not get through.
        out, _, _ = run_cli(
            ['reference', 'ship-discuss', 'foo/bar'],
            env_extra=self.env, cwd=self.project_dir,
        )
        self.assertIn('invalid reference name', out)

    def test_missing_plugin_root(self):
        env = dict(self.env)
        env.pop('CLAUDE_PLUGIN_ROOT', None)
        out, _, _ = run_cli(
            ['reference', 'ship-discuss', 'challenge-surface'],
            env_extra=env, cwd=self.project_dir,
        )
        self.assertIn('CLAUDE_PLUGIN_ROOT unset', out)

    def test_nonexistent_reference_returns_fallback(self):
        out, _, _ = run_cli(
            ['reference', 'ship-discuss', 'does-not-exist-xyz'],
            env_extra=self.env, cwd=self.project_dir,
        )
        self.assertIn('reference not found', out)


class TestVersionSubcommand(NamedSubcommandBase):

    def test_reads_real_manifest(self):
        env = dict(self.env)
        env['CLAUDE_PLUGIN_ROOT'] = PLUGIN_ROOT
        out, _, rc = run_cli(['version'], env_extra=env, cwd=self.project_dir)
        self.assertEqual(rc, 0)
        self.assertTrue(out.startswith('Shipyard v'), f"got: {out!r}")
        # Verify the version matches what's actually in plugin.json
        with open(os.path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')) as f:
            manifest = json.load(f)
        self.assertIn(manifest['version'], out)

    def test_missing_plugin_root(self):
        env = dict(self.env)
        env.pop('CLAUDE_PLUGIN_ROOT', None)
        out, _, rc = run_cli(['version'], env_extra=env, cwd=self.project_dir)
        self.assertEqual(rc, 0)
        self.assertIn('version unknown', out)

    def test_malformed_manifest(self):
        # Point at a directory with a broken plugin.json.
        fake_root = os.path.join(self.tmp, 'fake-plugin')
        os.makedirs(os.path.join(fake_root, '.claude-plugin'))
        with open(os.path.join(fake_root, '.claude-plugin', 'plugin.json'), 'w') as f:
            f.write('{ not json')
        env = dict(self.env)
        env['CLAUDE_PLUGIN_ROOT'] = fake_root
        out, _, rc = run_cli(['version'], env_extra=env, cwd=self.project_dir)
        self.assertEqual(rc, 0)
        self.assertIn('version unknown', out)


class TestProjectClaudeMdSubcommand(NamedSubcommandBase):

    def test_missing_claude_md(self):
        out, _, _ = run_cli(['project-claude-md'], env_extra=self.env, cwd=self.project_dir)
        self.assertIn('No CLAUDE.md', out)

    def test_reads_claude_md(self):
        with open(os.path.join(self.project_dir, 'CLAUDE.md'), 'w') as f:
            f.write('# project rules\n\nrule one\n')
        out, _, _ = run_cli(['project-claude-md'], env_extra=self.env, cwd=self.project_dir)
        self.assertIn('project rules', out)

    def test_lines_override(self):
        with open(os.path.join(self.project_dir, 'CLAUDE.md'), 'w') as f:
            f.write(''.join(f'line{i}\n' for i in range(50)))
        out, _, _ = run_cli(['project-claude-md', '5'], env_extra=self.env, cwd=self.project_dir)
        self.assertIn('line0', out)
        self.assertNotIn('line10', out)


class TestLegacyCheckSubcommand(NamedSubcommandBase):

    def test_no_legacy(self):
        out, _, rc = run_cli(['legacy-check'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip(), 'NO_LEGACY')

    def test_legacy_detected(self):
        os.makedirs(os.path.join(self.project_dir, '.shipyard'))
        with open(os.path.join(self.project_dir, '.shipyard', 'config.md'), 'w') as f:
            f.write('old config\n')
        out, _, rc = run_cli(['legacy-check'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip(), 'LEGACY_SHIPYARD_DETECTED')


class TestWindowsSafetySmoke(NamedSubcommandBase):
    """Meta-test: every pre-exec line across all skills must parse as single-token
    argv — no quoted args, no shell metacharacters. If this test fails, a skill
    introduced a Windows-hostile pre-exec. The eval runner has a dedicated check
    for this too; duplicating here so pytest surfaces it alongside the CLI tests.
    """

    def test_no_preexec_has_quoted_space_args(self):
        import re
        skills_dir = os.path.join(PLUGIN_ROOT, 'skills')
        preexec_re = re.compile(r'^\s*!`([^`]+)`', re.MULTILINE)
        offenders = []
        for name in sorted(os.listdir(skills_dir)):
            skill_md = os.path.join(skills_dir, name, 'SKILL.md')
            if not os.path.isfile(skill_md):
                continue
            with open(skill_md) as f:
                content = f.read()
            # Strip frontmatter
            body = re.sub(r'^---\s*\n.*?\n---\s*\n', '', content, count=1, flags=re.DOTALL)
            for m in preexec_re.finditer(body):
                line = m.group(1)
                if re.search(r'"[^"]*\s[^"]*"', line) or re.search(r"'[^']*\s[^']*'", line):
                    offenders.append((name, line))
        self.assertEqual(offenders, [], f"quoted-space args found: {offenders}")


if __name__ == '__main__':
    unittest.main()
