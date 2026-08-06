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
        self.assertIn('Project configuration missing', out)

    def test_bundled_context_reports_onboarding_before_work(self):
        out, err, rc = run_cli(['sprint-planning'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('SHIPYARD_ONBOARDING_REQUIRED=true', out)
        self.assertIn('SHIPYARD_ONBOARDING_REASON=missing_config', out)
        self.assertIn('SHIPYARD_ONBOARDING_COMMAND=shipyard-data onboarding bootstrap', out)
        self.assertNotIn('SHIPYARD_LOCK_ACQUIRED=', out)

    def test_path_auto_ensures_data_tree_without_config(self):
        data_dir = self.resolve_data_dir()
        self.assertTrue(os.path.exists(os.path.join(data_dir, '.project-root')))
        self.assertTrue(os.path.isdir(os.path.join(data_dir, 'templates')))
        self.assertFalse(os.path.exists(os.path.join(data_dir, 'config.md')))

    def test_view_config_reads_file(self):
        self.write_data_file('config.md', 'project: test\nversion: 1\n')
        out, _, rc = run_cli(['view', 'config'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0)
        self.assertIn('project: test', out)

    def test_view_config_includes_generated_model_and_effort_blocks(self):
        template = os.path.join(PLUGIN_ROOT, 'project-files', 'templates', 'config.md')
        with open(template) as f:
            self.write_data_file('config.md', f.read())

        out, _, rc = run_cli(['view', 'config'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0)
        self.assertIn('models:', out)
        self.assertIn('orchestrate: opus', out)
        self.assertIn('agent_effort:', out)
        self.assertIn('operational_fix: medium', out)

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
                     'metrics', 'data-version']:  # sprint-handoff retired in v2.9.0 (HANDOFF.md → paused cursor)
            out, err, rc = run_cli(['view', name], env_extra=self.env, cwd=self.project_dir)
            self.assertEqual(rc, 0, f"{name}: rc={rc} err={err}")
            self.assertTrue(out.strip(), f"{name}: empty output")


class TestSprintPlanningContext(NamedSubcommandBase):

    def test_sprint_planning_acquires_lock_and_bundles_context(self):
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        self.write_data_file('backlog/BACKLOG.md', '- F001\n')
        self.write_data_file('sprints/current/SPRINT.md', 'id: sprint-001\n')
        self.write_data_file('memory/metrics.md', 'Velocity: 8 pts\n')
        self.write_data_file('codebase-context.md', 'Stack: Node\n')

        out, err, rc = run_cli(['sprint-planning'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('SHIPYARD_LOCK_ACQUIRED=true', out)
        self.assertIn('--- config ---', out)
        self.assertIn('think: opus', out)
        self.assertIn('--- backlog ---', out)
        self.assertIn('- F001', out)
        self.assertIn('--- sprint ---', out)
        self.assertIn('id: sprint-001', out)
        self.assertIn('--- metrics ---', out)
        self.assertIn('Velocity: 8 pts', out)
        self.assertIn('--- codebase ---', out)
        self.assertIn('Stack: Node', out)

    def test_sprint_planning_blocked_lock_skips_context_reads(self):
        data_dir = self.resolve_data_dir()
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        lock_path = os.path.join(data_dir, '.active-session.json')
        with open(lock_path, 'w') as f:
            json.dump({
                'skill': 'ship-discuss',
                'sprint': None,
                'wave': None,
                'started': '2999-01-01T00:00:00.000Z',
                'session_id': 'other-session',
                'cleared': None,
                'depth': 1,
            }, f)

        out, err, rc = run_cli(['sprint-planning'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_LOCK_ACQUIRED=false', out)
        self.assertIn('SHIPYARD_LOCK_BLOCKED:', out)
        self.assertIn('⛔ Another planning session is active.', out)
        self.assertNotIn('--- config ---', out)
        self.assertNotIn('think: opus', out)


class TestSprintExecutionContext(NamedSubcommandBase):

    def test_sprint_execution_acquires_lock_with_sprint_and_bundles_context(self):
        self.write_data_file('config.md', 'models:\n  build: sonnet\n')
        self.write_data_file('sprints/current/SPRINT.md', '---\nid: sprint-042\n---\n# Sprint\n')
        self.write_data_file('sprints/current/PROGRESS.md', 'current_wave: 2\n')
        self.write_data_file(
            'sprints/current/EXECUTE-CURSOR.md',
            '---\n'
            'stage: wave_2_dispatch\n'
            'status: in_progress\n'
            'terminal: false\n'
            'sprint: sprint-042\n'
            'wave_number: 2\n'
            'iteration: 1\n'
            '---\n'
            'resume note\n',
        )
        self.write_data_file('codebase-context.md', 'Stack: React\n')

        out, err, rc = run_cli(['sprint-execution'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('SHIPYARD_SPRINT_ID=sprint-042', out)
        self.assertIn('SHIPYARD_LOCK_ACQUIRED=true', out)
        self.assertIn('SHIPYARD_CURSOR_PRESENT=true', out)
        self.assertIn('SHIPYARD_CURSOR_STAGE=wave_2_dispatch', out)
        self.assertIn('SHIPYARD_CURSOR_STATUS=in_progress', out)
        self.assertIn('SHIPYARD_CURSOR_TERMINAL=false', out)
        self.assertIn('SHIPYARD_CURSOR_WAVE_NUMBER=2', out)
        self.assertIn('SHIPYARD_CURSOR_NOTE:', out)
        self.assertIn('resume note', out)
        self.assertIn('--- config ---', out)
        self.assertIn('build: sonnet', out)
        self.assertIn('--- sprint ---', out)
        self.assertIn('id: sprint-042', out)
        self.assertIn('--- sprint-progress ---', out)
        self.assertIn('current_wave: 2', out)
        self.assertIn('--- codebase ---', out)
        self.assertIn('Stack: React', out)

    def test_sprint_execution_blocked_lock_skips_context_reads(self):
        data_dir = self.resolve_data_dir()
        self.write_data_file('config.md', 'models:\n  build: sonnet\n')
        lock_path = os.path.join(data_dir, '.active-execution.json')
        with open(lock_path, 'w') as f:
            json.dump({
                'skill': 'ship-review',
                'sprint': 'sprint-041',
                'wave': None,
                'started': '2999-01-01T00:00:00.000Z',
                'session_id': 'other-session',
                'cleared': None,
                'depth': 1,
            }, f)

        out, err, rc = run_cli(['sprint-execution'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_LOCK_ACQUIRED=false', out)
        self.assertIn('SHIPYARD_LOCK_BLOCKED:', out)
        self.assertIn('⛔ Another execution lock is active.', out)
        self.assertNotIn('--- config ---', out)
        self.assertNotIn('build: sonnet', out)


class TestQuickTaskContext(NamedSubcommandBase):

    def test_quick_task_checks_planning_acquires_execution_and_bundles_context(self):
        self.write_data_file('config.md', 'models:\n  build: sonnet\n')
        self.write_data_file('codebase-context.md', 'Stack: TypeScript\n')
        self.write_data_file('spec/tasks/Q-002-existing.md', 'x')
        self.write_data_file('spec/tasks/Q-001-existing.md', 'x')

        out, err, rc = run_cli(['quick-task'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('SHIPYARD_PLANNING_LOCK_CLEAR=true', out)
        self.assertIn('SHIPYARD_LOCK_ACQUIRED=true', out)
        self.assertIn('--- config ---', out)
        self.assertIn('build: sonnet', out)
        self.assertIn('--- codebase ---', out)
        self.assertIn('Stack: TypeScript', out)
        self.assertIn('--- quick-tasks ---', out)
        self.assertRegex(out, r'Q-001-existing\.md[\s\S]*Q-002-existing\.md')

    def test_quick_task_planning_block_skips_execution_and_context_reads(self):
        data_dir = self.resolve_data_dir()
        self.write_data_file('config.md', 'models:\n  build: sonnet\n')
        lock_path = os.path.join(data_dir, '.active-session.json')
        with open(lock_path, 'w') as f:
            json.dump({
                'skill': 'ship-sprint',
                'sprint': None,
                'wave': None,
                'started': '2999-01-01T00:00:00.000Z',
                'session_id': 'other-session',
                'cleared': None,
                'depth': 1,
            }, f)

        out, err, rc = run_cli(['quick-task'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_PLANNING_LOCK_CLEAR=false', out)
        self.assertIn('SHIPYARD_LOCK_ACQUIRED=false', out)
        self.assertIn('⛔ Another planning session is active.', out)
        self.assertNotIn('--- config ---', out)
        self.assertNotIn('build: sonnet', out)

    def test_quick_task_execution_block_skips_context_reads(self):
        data_dir = self.resolve_data_dir()
        self.write_data_file('config.md', 'models:\n  build: sonnet\n')
        lock_path = os.path.join(data_dir, '.active-execution.json')
        with open(lock_path, 'w') as f:
            json.dump({
                'skill': 'ship-debug',
                'sprint': None,
                'wave': None,
                'started': '2999-01-01T00:00:00.000Z',
                'session_id': 'other-session',
                'cleared': None,
                'depth': 1,
            }, f)

        out, err, rc = run_cli(['quick-task'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_PLANNING_LOCK_CLEAR=true', out)
        self.assertIn('SHIPYARD_LOCK_ACQUIRED=false', out)
        self.assertIn('⛔ Another execution lock is active.', out)
        self.assertNotIn('--- config ---', out)
        self.assertNotIn('build: sonnet', out)


class TestDebugSessionContext(NamedSubcommandBase):

    def test_debug_session_bundles_path_sessions_and_config(self):
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        self.write_data_file('debug/auth-timeout.md', '# Debug\n')

        out, err, rc = run_cli(['debug-session'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('--- debug-sessions ---', out)
        self.assertIn('auth-timeout.md', out)
        self.assertIn('--- config ---', out)
        self.assertIn('think: opus', out)


class TestHelpContext(NamedSubcommandBase):

    def test_help_context_bundles_project_state_and_version(self):
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        self.write_data_file('codebase-context.md', 'Stack: Rails\n')
        self.write_data_file('spec/features/F001-demo.md', 'x')
        self.write_data_file('sprints/current/SPRINT.md', 'id: sprint-001\n')
        self.write_data_file('sprints/current/PROGRESS.md', 'current_wave: 1\n')
        self.write_data_file('backlog/BACKLOG.md', '- F001\n')
        env = dict(self.env)
        env['CLAUDE_PLUGIN_ROOT'] = PLUGIN_ROOT

        out, err, rc = run_cli(['help-context'], env_extra=env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('--- config ---', out)
        self.assertIn('think: opus', out)
        self.assertIn('--- codebase ---', out)
        self.assertIn('Stack: Rails', out)
        self.assertIn('--- features ---', out)
        self.assertIn('F001-demo.md', out)
        self.assertIn('--- sprint ---', out)
        self.assertIn('id: sprint-001', out)
        self.assertIn('--- sprint-progress ---', out)
        self.assertIn('current_wave: 1', out)
        self.assertIn('--- backlog ---', out)
        self.assertIn('- F001', out)
        self.assertIn('--- version ---', out)
        self.assertIn('Shipyard v', out)


class TestSmallCommandContexts(NamedSubcommandBase):

    def test_review_context_bundles_review_inputs(self):
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        self.write_data_file('sprints/current/SPRINT.md', 'id: sprint-001\n')
        self.write_data_file('sprints/current/PROGRESS.md', 'current_wave: 1\n')
        self.write_data_file(
            'sprints/current/REVIEW-CURSOR.md',
            '---\nstage: tests\nstatus: paused\nterminal: false\nsprint: sprint-001\n---\nawaiting tests\n',
        )
        self.write_data_file('memory/metrics.md', 'Velocity: 8 pts\n')

        out, err, rc = run_cli(['review-context'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('SHIPYARD_CURSOR_PRESENT=true', out)
        self.assertIn('SHIPYARD_CURSOR_PIPELINE=ship-review', out)
        self.assertIn('SHIPYARD_CURSOR_STAGE=tests', out)
        self.assertIn('SHIPYARD_CURSOR_STATUS=paused', out)
        self.assertIn('awaiting tests', out)
        self.assertIn('--- config ---', out)
        self.assertIn('think: opus', out)
        self.assertIn('--- sprint ---', out)
        self.assertIn('id: sprint-001', out)
        self.assertIn('--- sprint-progress ---', out)
        self.assertIn('current_wave: 1', out)
        self.assertIn('--- metrics ---', out)
        self.assertIn('Velocity: 8 pts', out)

    def test_backlog_context_bundles_backlog_inputs(self):
        self.write_data_file('backlog/BACKLOG.md', '- F001\n')
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        self.write_data_file('memory/metrics.md', 'Velocity: 8 pts\n')

        out, err, rc = run_cli(['backlog-context'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('--- backlog ---', out)
        self.assertIn('- F001', out)
        self.assertIn('--- config ---', out)
        self.assertIn('think: opus', out)
        self.assertIn('--- metrics ---', out)
        self.assertIn('Velocity: 8 pts', out)

    def test_bug_context_bundles_bug_count_and_sprint(self):
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        self.write_data_file('spec/bugs/B-001.md', 'x')
        self.write_data_file('sprints/current/SPRINT.md', 'id: sprint-001\n')

        out, err, rc = run_cli(['bug-context'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('Bugs: 1', out)
        self.assertIn('--- sprint ---', out)
        self.assertIn('id: sprint-001', out)

    def test_spec_context_bundles_path_and_counts(self):
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        self.write_data_file('spec/epics/E001.md', 'x')
        self.write_data_file('spec/features/F001.md', 'x')
        self.write_data_file('spec/tasks/T001.md', 'x')
        self.write_data_file('spec/bugs/B001.md', 'x')
        self.write_data_file('spec/ideas/IDEA001.md', 'x')
        self.write_data_file('spec/references/R001.md', 'x')

        out, err, rc = run_cli(['spec-context'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('Epics: 1', out)
        self.assertIn('Features: 1', out)
        self.assertIn('Tasks: 1', out)
        self.assertIn('Bugs: 1', out)
        self.assertIn('Ideas: 1', out)
        self.assertIn('References: 1', out)


class TestInitStatusDiscussContexts(NamedSubcommandBase):

    def test_init_context_bundles_data_version_config_and_project_claude(self):
        self.write_data_file('version.md', '3.19.0\n')
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        with open(os.path.join(self.project_dir, 'CLAUDE.md'), 'w') as f:
            f.write('# Project Instructions\n')

        out, err, rc = run_cli(['init-context'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('--- data-version ---', out)
        self.assertIn('3.19.0', out)
        self.assertIn('--- config ---', out)
        self.assertIn('think: opus', out)
        self.assertIn('--- project-claude-md ---', out)
        self.assertIn('# Project Instructions', out)

    def test_status_dashboard_bundles_dashboard_inputs(self):
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        self.write_data_file('sprints/current/SPRINT.md', 'id: sprint-001\n')
        self.write_data_file('sprints/current/PROGRESS.md', 'current_wave: 1\n')
        self.write_data_file('backlog/BACKLOG.md', '- F001\n')
        self.write_data_file('memory/metrics.md', 'Velocity: 8 pts\n')
        self.write_data_file('debug/auth-timeout.md', 'x')
        self.write_data_file('spec/features/F001.md', 'x')
        self.write_data_file('spec/epics/E001.md', 'x')
        self.write_data_file('spec/bugs/B001.md', 'x')
        self.write_data_file('spec/ideas/IDEA001.md', 'x')
        self.write_data_file(
            'sprints/current/EXECUTE-CURSOR.md',
            '---\nstage: wave_1_gate\nstatus: in_progress\nterminal: false\nsprint: sprint-001\n---\n',
        )
        self.write_data_file(
            'sprints/current/REVIEW-CURSOR.md',
            '---\nstage: demo_user\nstatus: paused\nterminal: false\nsprint: sprint-001\n---\nreview pause\n',
        )

        out, err, rc = run_cli(['status-dashboard'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('SHIPYARD_EXECUTE_CURSOR_PRESENT=true', out)
        self.assertIn('SHIPYARD_EXECUTE_CURSOR_STAGE=wave_1_gate', out)
        self.assertIn('SHIPYARD_REVIEW_CURSOR_PRESENT=true', out)
        self.assertIn('SHIPYARD_REVIEW_CURSOR_STAGE=demo_user', out)
        self.assertIn('SHIPYARD_REVIEW_CURSOR_NOTE:', out)
        self.assertIn('--- config ---', out)
        self.assertIn('think: opus', out)
        self.assertIn('--- sprint ---', out)
        self.assertIn('id: sprint-001', out)
        self.assertIn('--- sprint-progress ---', out)
        self.assertIn('current_wave: 1', out)
        self.assertIn('--- backlog ---', out)
        self.assertIn('- F001', out)
        self.assertIn('--- metrics ---', out)
        self.assertIn('Velocity: 8 pts', out)
        self.assertIn('Debug sessions: 1 active', out)
        self.assertIn('Features: 1', out)
        self.assertIn('Epics: 1', out)
        self.assertIn('Bugs: 1', out)
        self.assertIn('Ideas: 1', out)

    def test_cursor_state_reports_absent_and_present_cursor(self):
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        out, err, rc = run_cli(['cursor-state', 'execute'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_CURSOR_PIPELINE=ship-execute', out)
        self.assertIn('SHIPYARD_CURSOR_PRESENT=false', out)

        self.write_data_file(
            'sprints/current/EXECUTE-CURSOR.md',
            '---\n'
            'stage: wave_1_waiting\n'
            'status: in_progress\n'
            'terminal: false\n'
            'sprint: sprint-001\n'
            'pending_subagents:\n'
            '  - task_id: T001\n'
            '    agent_name: builder-T001\n'
            '---\n'
            'waiting for builder\n',
        )
        out, err, rc = run_cli(['cursor-state', 'execute'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_CURSOR_PRESENT=true', out)
        self.assertIn('SHIPYARD_CURSOR_STAGE=wave_1_waiting', out)
        self.assertIn('SHIPYARD_CURSOR_PENDING_SUBAGENTS=', out)
        self.assertIn('"task_id":"T001"', out)
        self.assertIn('waiting for builder', out)

    def test_draft_state_reports_research_and_sprint_frontmatter(self):
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        out, err, rc = run_cli(['draft-state', 'research'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_RESEARCH_DRAFT_PRESENT=false', out)

        self.write_data_file('spec/.research-draft.md', '---\ntopic: billing\nobsolete: false\n---\nbody\n')
        self.write_data_file('sprints/current/SPRINT-DRAFT.md', '---\nstatus: draft\n---\n# Sprint\n')

        out, err, rc = run_cli(['draft-state', 'research'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_RESEARCH_DRAFT_PRESENT=true', out)
        self.assertIn('SHIPYARD_RESEARCH_DRAFT_TOPIC=billing', out)
        self.assertIn('SHIPYARD_RESEARCH_DRAFT_OBSOLETE=false', out)

        out, err, rc = run_cli(['draft-state', 'sprint'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_SPRINT_DRAFT_PRESENT=true', out)
        self.assertIn('SHIPYARD_SPRINT_DRAFT_STATUS=draft', out)

    def test_discuss_context_acquires_lock_and_bundles_context(self):
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        self.write_data_file('codebase-context.md', 'Stack: Go\n')
        self.write_data_file('spec/epics/E001.md', 'x')
        self.write_data_file('spec/features/F001.md', 'x')

        out, err, rc = run_cli(['discuss-context'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('SHIPYARD_LOCK_ACQUIRED=true', out)
        self.assertIn('--- config ---', out)
        self.assertIn('think: opus', out)
        self.assertIn('--- codebase ---', out)
        self.assertIn('Stack: Go', out)
        self.assertIn('--- epics ---', out)
        self.assertIn('E001.md', out)
        self.assertIn('--- features ---', out)
        self.assertIn('F001.md', out)

    def test_discuss_context_blocked_lock_skips_context_reads(self):
        data_dir = self.resolve_data_dir()
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        lock_path = os.path.join(data_dir, '.active-session.json')
        with open(lock_path, 'w') as f:
            json.dump({
                'skill': 'ship-sprint',
                'sprint': None,
                'wave': None,
                'started': '2999-01-01T00:00:00.000Z',
                'session_id': 'other-session',
                'cleared': None,
                'depth': 1,
            }, f)

        out, err, rc = run_cli(['discuss-context'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_LOCK_ACQUIRED=false', out)
        self.assertIn('SHIPYARD_LOCK_BLOCKED:', out)
        self.assertIn('⛔ Another planning session is active.', out)
        self.assertNotIn('--- config ---', out)
        self.assertNotIn('think: opus', out)

    def test_discuss_context_allows_execute_cross_lock_and_includes_sprint(self):
        data_dir = self.resolve_data_dir()
        self.write_data_file('config.md', 'models:\n  think: opus\n')
        self.write_data_file('codebase-context.md', 'Stack: Go\n')
        self.write_data_file('sprints/current/SPRINT.md', 'id: sprint-007\n')
        lock_path = os.path.join(data_dir, '.active-execution.json')
        with open(lock_path, 'w') as f:
            json.dump({
                'skill': 'ship-execute',
                'sprint': 'sprint-007',
                'wave': 1,
                'started': '2999-01-01T00:00:00.000Z',
                'session_id': 'other-session',
                'cleared': None,
                'depth': 1,
            }, f)

        out, err, rc = run_cli(['discuss-context'], env_extra=self.env, cwd=self.project_dir)

        self.assertEqual(rc, 0, err)
        self.assertIn('SHIPYARD_LOCK_ACQUIRED=true', out)
        self.assertIn('SHIPYARD_LOCK_CROSS_ALLOWED=ship-discuss+ship-execute', out)
        self.assertIn('--- sprint ---', out)
        self.assertIn('id: sprint-007', out)


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

    def test_count_of_ideas_empty(self):
        """Fresh project has no ideas directory — count-of ideas must return 0
        cleanly, not error. Pre-fix this count was missing from the registry
        entirely, so skill bodies couldn't ask 'how many ideas do we have?'
        in their context blocks."""
        out, _, rc = run_cli(['count-of', 'ideas'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip(), '0')

    def test_count_of_ideas_populated(self):
        """Populated ideas directory — count matches file count, mirroring
        the bugs/features/epics counters that already worked."""
        self.write_data_file('spec/ideas/IDEA-001-foo.md', 'x')
        self.write_data_file('spec/ideas/IDEA-002-bar.md', 'x')
        self.write_data_file('spec/ideas/IDEA-003-baz.md', 'x')
        out, _, _ = run_cli(['count-of', 'ideas'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(out.strip(), '3')

    def test_count_of_tasks_populated(self):
        """Tasks counter was also added alongside ideas — same shape, same
        registry entry."""
        self.write_data_file('spec/tasks/T001-foo.md', 'x')
        self.write_data_file('spec/tasks/T002-bar.md', 'x')
        out, _, _ = run_cli(['count-of', 'tasks'], env_extra=self.env, cwd=self.project_dir)
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


class TestDiagnoseEventsTail(NamedSubcommandBase):
    """`shipyard-context diagnose` should include the structured event log
    tail in its output. This is the surface customers paste into bug
    reports — the events are how we tell "orchestrator auto-paused"
    apart from "subagent ran out of context" without further questions.
    """

    def test_diagnose_reports_no_events_when_log_missing(self):
        out, _, code = run_cli(
            ['diagnose'], env_extra=self.env, cwd=self.project_dir
        )
        self.assertEqual(code, 0)
        self.assertIn('SHIPYARD_EVENTS_LOG=(does not exist', out)

    def test_diagnose_includes_events_tail_when_log_present(self):
        # Plant an events file via the shipyard-data emit subcommand so we
        # exercise the same write path that hooks use.
        data_cli = os.path.join(
            os.path.dirname(__file__), '..', 'bin', 'shipyard-data.mjs'
        )
        for i in range(3):
            subprocess.run(
                ['node', data_cli, 'events', 'emit',
                 'compaction_detected', f'count={i}', f'sprint="S00{i}"'],
                env={**os.environ, **self.env},
                check=True,
                capture_output=True,
            )
        out, _, code = run_cli(
            ['diagnose'], env_extra=self.env, cwd=self.project_dir
        )
        self.assertEqual(code, 0)
        # Header line shows the path
        self.assertIn('SHIPYARD_EVENTS_LOG=', out)
        self.assertIn('.shipyard-events.jsonl', out)
        # Tail line shows count
        self.assertIn('SHIPYARD_EVENTS_TAIL_3_LINES:', out)
        # All three events appear in raw JSONL form
        self.assertEqual(out.count('compaction_detected'), 3)
        self.assertIn('"count":0', out)
        self.assertIn('"count":2', out)


class TestCheckCommitExists(NamedSubcommandBase):
    """`shipyard-context check-commit-exists <sha>` — verifies a sha is
    present in the current git repo. Used by verifying-wave-completion and
    evaluating-sprint-complete to confirm subagent-returned commits are
    real before trusting the structured return contract.
    """

    def _make_commit(self):
        # Make an empty commit; return its sha.
        subprocess.run(['git', '-C', self.project_dir,
                        '-c', 'user.email=t@t', '-c', 'user.name=t',
                        'commit', '--allow-empty', '-m', 'test', '-q'],
                       check=True, capture_output=True)
        proc = subprocess.run(['git', '-C', self.project_dir, 'rev-parse', 'HEAD'],
                              capture_output=True, text=True, check=True)
        return proc.stdout.strip()

    def test_existing_sha_returns_zero_and_prints_full_sha(self):
        sha = self._make_commit()
        out, _, code = run_cli(['check-commit-exists', sha],
                               env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), sha)

    def test_abbreviated_sha_resolves_to_full(self):
        sha = self._make_commit()
        out, _, code = run_cli(['check-commit-exists', sha[:7]],
                               env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), sha)

    def test_missing_sha_returns_nonzero_and_prints_missing(self):
        # Make at least one commit so this isn't a bare repo case.
        self._make_commit()
        out, _, code = run_cli(['check-commit-exists', 'deadbeefcafe'],
                               env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 1)
        self.assertEqual(out.strip(), 'missing')

    def test_malformed_sha_rejected(self):
        _, err, code = run_cli(['check-commit-exists', 'not-a-sha'],
                               env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 1)
        self.assertIn('Usage', err)

    def test_missing_sha_arg_shows_usage(self):
        _, err, code = run_cli(['check-commit-exists'],
                               env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 1)
        self.assertIn('Usage', err)


class TestScanEvents(NamedSubcommandBase):
    """`shipyard-context scan-events --tail N <type1> [type2 ...]` — reads
    the structured event log tail, filtered to specific event types.
    """

    def _emit(self, event_type, **fields):
        data_cli = os.path.join(
            os.path.dirname(__file__), '..', 'bin', 'shipyard-data.mjs'
        )
        argv = ['node', data_cli, 'events', 'emit', event_type] + \
               [f'{k}={v}' for k, v in fields.items()]
        subprocess.run(argv, env={**os.environ, **self.env},
                       check=True, capture_output=True)

    def test_empty_log_prints_nothing_exit_zero(self):
        # Don't initialize the log; subcommand should exit 0 with no output.
        out, _, code = run_cli(
            ['scan-events', '--tail', '10', 'wave_check_passed'],
            env_extra=self.env, cwd=self.project_dir,
        )
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), '')

    def test_filters_by_type(self):
        self._emit('wave_check_passed', wave=1)
        self._emit('task_loop_iteration', task='T-001', iteration=1)
        self._emit('silent_failure', task='T-002')
        self._emit('wave_check_passed', wave=2)
        out, _, code = run_cli(
            ['scan-events', '--tail', '50', 'silent_failure', 'wave_check_passed'],
            env_extra=self.env, cwd=self.project_dir,
        )
        self.assertEqual(code, 0)
        lines = [l for l in out.strip().split('\n') if l]
        self.assertEqual(len(lines), 3)
        # Each filtered line should be valid JSON with the right type
        types = [json.loads(l)['type'] for l in lines]
        self.assertEqual(set(types), {'wave_check_passed', 'silent_failure'})
        # task_loop_iteration must NOT appear
        self.assertNotIn('task_loop_iteration', out)

    def test_tail_limits_search_window(self):
        for i in range(10):
            self._emit('wave_check_passed', wave=i)
        # With tail=3, only the last 3 emissions are scanned.
        out, _, code = run_cli(
            ['scan-events', '--tail', '3', 'wave_check_passed'],
            env_extra=self.env, cwd=self.project_dir,
        )
        self.assertEqual(code, 0)
        lines = [l for l in out.strip().split('\n') if l]
        self.assertEqual(len(lines), 3)

    def test_no_types_requires_usage(self):
        _, err, code = run_cli(
            ['scan-events', '--tail', '10'],
            env_extra=self.env, cwd=self.project_dir,
        )
        self.assertEqual(code, 1)
        self.assertIn('Usage', err)

    def test_invalid_tail_rejected(self):
        _, err, code = run_cli(
            ['scan-events', '--tail', '0', 'wave_check_passed'],
            env_extra=self.env, cwd=self.project_dir,
        )
        self.assertEqual(code, 1)
        self.assertIn('positive integer', err)


class TestCheckDirtyWorktrees(NamedSubcommandBase):
    """`shipyard-context check-dirty-worktrees` — lists `shipyard/wt-*`
    worktrees with uncommitted state. Output is one path per line; empty
    output means all-clean.
    """

    def _make_first_commit(self):
        # An initial commit is needed before `git worktree add` works.
        with open(os.path.join(self.project_dir, 'seed.txt'), 'w') as f:
            f.write('seed')
        subprocess.run(['git', '-C', self.project_dir, 'add', 'seed.txt'],
                       check=True, capture_output=True)
        subprocess.run(['git', '-C', self.project_dir,
                        '-c', 'user.email=t@t', '-c', 'user.name=t',
                        'commit', '-m', 'seed', '-q'],
                       check=True, capture_output=True)

    def test_no_worktrees_prints_nothing(self):
        out, _, code = run_cli(['check-dirty-worktrees'],
                               env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), '')

    def test_clean_shipyard_worktree_does_not_appear(self):
        self._make_first_commit()
        wt_path = os.path.join(self.tmp, 'wt-clean')
        subprocess.run(['git', '-C', self.project_dir, 'worktree', 'add',
                        '-b', 'shipyard/wt-clean', wt_path],
                       check=True, capture_output=True)
        out, _, code = run_cli(['check-dirty-worktrees'],
                               env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), '')

    def test_dirty_shipyard_worktree_listed(self):
        self._make_first_commit()
        wt_path = os.path.join(self.tmp, 'wt-dirty')
        subprocess.run(['git', '-C', self.project_dir, 'worktree', 'add',
                        '-b', 'shipyard/wt-dirty', wt_path],
                       check=True, capture_output=True)
        # Make the worktree dirty (untracked file is dirty per git status --porcelain).
        with open(os.path.join(wt_path, 'dirty.txt'), 'w') as f:
            f.write('uncommitted')
        out, _, code = run_cli(['check-dirty-worktrees'],
                               env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 0)
        # The dirty worktree appears in output (may be the realpath).
        self.assertIn('wt-dirty', out)

    def test_non_shipyard_worktree_ignored(self):
        # A worktree NOT named shipyard/wt-* is ignored even when dirty.
        self._make_first_commit()
        wt_path = os.path.join(self.tmp, 'user-worktree')
        subprocess.run(['git', '-C', self.project_dir, 'worktree', 'add',
                        '-b', 'feature/user', wt_path],
                       check=True, capture_output=True)
        with open(os.path.join(wt_path, 'dirty.txt'), 'w') as f:
            f.write('user-uncommitted')
        out, _, code = run_cli(['check-dirty-worktrees'],
                               env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 0)
        # User worktree must NOT be reported — scope is shipyard worktrees only.
        self.assertNotIn('user-worktree', out)


class TestCheckDirtyTree(NamedSubcommandBase):
    """`shipyard-context check-dirty-tree` — porcelain of the MAIN working
    tree, the in-place (isolation off) counterpart to check-dirty-worktrees
    (F3). Empty output = clean; non-empty = a failed in-place builder's residue
    that the wt-scoped check cannot see.
    """

    def _seed_commit(self):
        with open(os.path.join(self.project_dir, 'seed.txt'), 'w') as f:
            f.write('seed')
        subprocess.run(['git', '-C', self.project_dir, 'add', 'seed.txt'],
                       check=True, capture_output=True)
        subprocess.run(['git', '-C', self.project_dir,
                        '-c', 'user.email=t@t', '-c', 'user.name=t',
                        'commit', '-m', 'seed', '-q'],
                       check=True, capture_output=True)

    def test_clean_tree_prints_nothing(self):
        self._seed_commit()
        out, _, code = run_cli(['check-dirty-tree'],
                               env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), '')

    def test_dirty_main_tree_reported(self):
        self._seed_commit()
        # Uncommitted change in the MAIN checkout (what in-place builders share).
        with open(os.path.join(self.project_dir, 'residue.txt'), 'w') as f:
            f.write('partial in-place edit')
        out, _, code = run_cli(['check-dirty-tree'],
                               env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 0)
        self.assertIn('residue.txt', out)


class TestDiagnoseResolutionFailure(unittest.TestCase):
    """`diagnose` must produce a useful report even when the data dir CANNOT
    be resolved — that's the exact failure (e.g. a breadcrumb stranded by a
    TMPDIR split) a user runs diagnose to investigate. Every other subcommand
    fails fast; diagnose tolerates the error and dumps the discovery state.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-diag-fail-')
        self.project_dir = os.path.join(self.tmp, 'project')
        self.fake_home = os.path.join(self.tmp, 'home')
        self.fake_tmp = os.path.join(self.tmp, 'tmpdir')
        os.makedirs(self.project_dir)
        os.makedirs(self.fake_home)
        os.makedirs(self.fake_tmp)
        subprocess.run(['git', 'init', '-q'], cwd=self.project_dir, check=True)
        # No CLAUDE_PLUGIN_DATA; isolate tmp so no breadcrumb is reachable; a
        # fresh git project has no .shipyard link and a unique hash (so the
        # hardcoded /tmp breadcrumb candidate can't collide).
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'HOME': self.fake_home,
            'USERPROFILE': self.fake_home,
            'TMPDIR': self.fake_tmp,
            'TMP': self.fake_tmp,
            'TEMP': self.fake_tmp,
        }

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_diagnose_survives_unresolved_and_reports_discovery_state(self):
        out, err, code = run_cli(['diagnose'], env_extra=self.env, cwd=self.project_dir)
        # Produces a report (does not abort like other commands do on failure).
        self.assertEqual(code, 0, f'diagnose should still exit 0; err={err!r}')
        self.assertIn('SHIPYARD_DATA=(UNRESOLVED)', out)
        self.assertIn('RESOLVE_ERROR:', out)
        self.assertIn('PROJECT_HASH=', out)
        # Discovery state: every breadcrumb candidate is reported (and missing).
        self.assertIn('BREADCRUMB[', out)
        self.assertIn('(missing)', out)
        # .shipyard fallback reported as absent for a fresh project.
        self.assertIn('SHIPYARD_LINK=(absent)', out)

    def test_diagnose_reports_valid_shipyard_link(self):
        # Build a data dir of the right shape and link .shipyard at it, with
        # env + breadcrumb still absent — diagnose should both resolve via the
        # link AND report it as valid-for-hash.
        if sys.platform == 'win32':
            self.skipTest('os.symlink requires elevated privileges on Windows')

        out, _, rc = run_cli(['diagnose'], env_extra=self.env, cwd=self.project_dir)
        project_hash = next(
            line[len('PROJECT_HASH='):]
            for line in out.splitlines() if line.startswith('PROJECT_HASH=')
        )
        data_dir = os.path.join(self.tmp, 'plugin-data', 'projects', project_hash)
        os.makedirs(data_dir)
        os.symlink(data_dir, os.path.join(self.project_dir, '.shipyard'))

        out, err, code = run_cli(['diagnose'], env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 0, f'err={err!r}')
        self.assertNotIn('SHIPYARD_DATA=(UNRESOLVED)', out)
        self.assertIn(os.path.realpath(data_dir), out)
        self.assertIn('valid-for-hash: yes', out)


if __name__ == '__main__':
    unittest.main()
