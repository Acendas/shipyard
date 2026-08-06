#!/usr/bin/env python3
"""Tests for bin/shipyard-data.mjs CLI subcommands.

Focuses on the `migrate` subcommand's safety guards (R4): refuses to
overwrite a populated destination unless --force, and when --force is
passed it creates a timestamped backup snapshot before overwriting.

Each test uses an isolated CLAUDE_PLUGIN_DATA so the real plugin data
dir is never touched.
"""

import os
import json
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


def git_init_project(path):
    """Init a git repo at `path` so the resolver treats it as a real project.

    Issue #4: data-dir resolution now refuses a non-git project root (it would
    otherwise mint a phantom project dir). Test fixtures that stand in for a
    Shipyard project — always a git repo in practice — must git-init.
    """
    subprocess.run(['git', 'init', '-q'], cwd=path, check=True)
    subprocess.run(['git', 'config', 'user.email', 't@t'], cwd=path, check=True)
    subprocess.run(['git', 'config', 'user.name', 't'], cwd=path, check=True)
    subprocess.run(['git', 'commit', '--allow-empty', '-m', 'init', '-q'],
                   cwd=path, check=True)


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


class TestShipyardDataOnboarding(unittest.TestCase):
    """CLI-owned setup/onboarding surface used by skills."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-onboarding-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        git_init_project(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_onboarding_status_ensures_tree_and_reports_missing_config(self):
        out, err, code = run_cli(['onboarding', 'status'], env_extra=self.env)
        self.assertEqual(code, 0, err)
        self.assertIn('SHIPYARD_DATA=', out)
        self.assertIn('SHIPYARD_ONBOARDING_REQUIRED=true', out)
        self.assertIn('SHIPYARD_ONBOARDING_REASON=missing_config', out)
        data_dir = next(line.split('=', 1)[1] for line in out.splitlines() if line.startswith('SHIPYARD_DATA='))
        self.assertTrue(os.path.exists(os.path.join(data_dir, '.project-root')))
        self.assertTrue(os.path.isdir(os.path.join(data_dir, 'templates')))
        self.assertFalse(os.path.exists(os.path.join(data_dir, 'config.md')))

    def test_onboarding_bootstrap_creates_config_and_becomes_ready(self):
        out, err, code = run_cli(['onboarding', 'bootstrap'], env_extra=self.env)
        self.assertEqual(code, 0, err)
        self.assertIn('SHIPYARD_ONBOARDING_REQUIRED=false', out)
        self.assertIn('SHIPYARD_ONBOARDING_REASON=ready', out)
        data_dir = next(line.split('=', 1)[1] for line in out.splitlines() if line.startswith('SHIPYARD_DATA='))
        config_path = os.path.join(data_dir, 'config.md')
        self.assertTrue(os.path.exists(config_path))
        with open(config_path) as f:
            self.assertIn('project_name: "project"', f.read())


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
        git_init_project(self.project_dir)
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

    def write_completed_sprint_features(self):
        with open(os.path.join(self.current, 'SPRINT.md'), 'w') as f:
            f.write(
                '---\n'
                'id: sprint-042\n'
                'status: completed\n'
                'features: "F001,F002,F003"\n'
                '---\n'
            )
        features_dir = os.path.join(self.data_dir, 'spec', 'features')
        os.makedirs(features_dir, exist_ok=True)
        with open(os.path.join(features_dir, 'F001-alpha.md'), 'w') as f:
            f.write('---\nid: F001\nstatus: done\nstory_points: 5\n---\n')
        with open(os.path.join(features_dir, 'F002-beta.md'), 'w') as f:
            f.write('---\nid: F002\nstatus: released\nstory_points: 8\n---\n')
        with open(os.path.join(features_dir, 'F003-gamma.md'), 'w') as f:
            f.write('---\nid: F003\nstatus: approved\nstory_points: 13\n---\n')

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

    def test_archive_records_velocity_for_next_sprint_capacity(self):
        """Archive is the deterministic handoff that seeds next-sprint velocity."""
        self.write_completed_sprint_features()
        out, err, code = run_cli(
            ['archive-sprint', 'sprint-042'], env_extra=self.env
        )
        self.assertEqual(code, 0, f'archive failed: {err}')
        self.assertTrue(out.strip().endswith(os.path.join('sprints', 'sprint-042')))
        metrics_path = os.path.join(self.data_dir, 'memory', 'metrics.md')
        with open(metrics_path) as f:
            metrics = f.read()
        self.assertIn('Velocity: 13 pts  # sprint-042', metrics)
        self.assertIn('features=F001:5,F002:8', metrics)
        self.assertNotIn('F003:13', metrics)
        with open(os.path.join(self.data_dir, 'memory', 'metrics.json')) as f:
            metrics_json = json.load(f)
        self.assertEqual(metrics_json['velocity']['all_time']['count'], 1)
        self.assertEqual(metrics_json['velocity']['all_time']['total'], 13)
        self.assertEqual(metrics_json['velocity']['all_time']['min'], 13)
        self.assertEqual(metrics_json['velocity']['all_time']['max'], 13)
        self.assertEqual(metrics_json['velocity']['recent'][0]['sprint'], 'sprint-042')

    def test_archive_does_not_duplicate_existing_velocity_metric(self):
        """A recovery archive should not append a second velocity line."""
        self.write_completed_sprint_features()
        metrics_dir = os.path.join(self.data_dir, 'memory')
        os.makedirs(metrics_dir, exist_ok=True)
        metrics_path = os.path.join(metrics_dir, 'metrics.md')
        with open(metrics_path, 'w') as f:
            f.write('Velocity: 13 pts  # sprint-042; features=F001:5,F002:8\n')

        _, err, code = run_cli(
            ['archive-sprint', 'sprint-042'], env_extra=self.env
        )
        self.assertEqual(code, 0, f'archive failed: {err}')
        with open(metrics_path) as f:
            metrics = f.read()
        self.assertEqual(metrics.count('Velocity: 13 pts'), 1)
        with open(os.path.join(self.data_dir, 'memory', 'metrics.json')) as f:
            metrics_json = json.load(f)
        self.assertEqual(metrics_json['velocity']['all_time']['count'], 1)

    def test_archive_cancelled_sprint_does_not_record_zero_velocity(self):
        """Cancelled sprints should not poison future capacity with 0 pts."""
        self.write_completed_sprint_features()
        with open(os.path.join(self.current, 'SPRINT.md'), 'w') as f:
            f.write(
                '---\n'
                'id: sprint-042\n'
                'status: cancelled\n'
                'features: "F001,F002"\n'
                '---\n'
            )
        _, err, code = run_cli(
            ['archive-sprint', 'sprint-042'], env_extra=self.env
        )
        self.assertEqual(code, 0, f'archive failed: {err}')
        metrics_path = os.path.join(self.data_dir, 'memory', 'metrics.md')
        self.assertFalse(os.path.exists(metrics_path))

    def test_archive_bounds_recent_velocity_but_keeps_all_time_summary(self):
        """metrics.json keeps all-time stats while retaining only 10 sprint samples."""
        features_dir = os.path.join(self.data_dir, 'spec', 'features')
        os.makedirs(features_dir, exist_ok=True)
        for n in range(1, 12):
            sprint_id = f'sprint-{n:03d}'
            fid = f'F{n:03d}'
            with open(os.path.join(self.current, 'SPRINT.md'), 'w') as f:
                f.write(
                    '---\n'
                    f'id: {sprint_id}\n'
                    'status: completed\n'
                    f'features: "{fid}"\n'
                    '---\n'
                )
            with open(os.path.join(self.current, 'PROGRESS.md'), 'w') as f:
                f.write('done\n')
            with open(os.path.join(features_dir, f'{fid}-feature.md'), 'w') as f:
                f.write(
                    '---\n'
                    f'id: {fid}\n'
                    'status: done\n'
                    f'story_points: {n}\n'
                    '---\n'
                )
            _, err, code = run_cli(
                ['archive-sprint', sprint_id], env_extra=self.env
            )
            self.assertEqual(code, 0, f'archive {sprint_id} failed: {err}')

        with open(os.path.join(self.data_dir, 'memory', 'metrics.json')) as f:
            metrics_json = json.load(f)
        self.assertEqual(metrics_json['velocity']['all_time']['count'], 11)
        self.assertEqual(metrics_json['velocity']['all_time']['total'], 66)
        self.assertEqual(metrics_json['velocity']['all_time']['min'], 1)
        self.assertEqual(metrics_json['velocity']['all_time']['max'], 11)
        self.assertEqual(len(metrics_json['velocity']['recent']), 10)
        self.assertEqual(metrics_json['velocity']['recent'][0]['sprint'], 'sprint-002')
        with open(os.path.join(self.data_dir, 'memory', 'metrics.md')) as f:
            metrics = f.read()
        self.assertNotIn('Velocity: 1 pts  # sprint-001', metrics)
        self.assertIn('Velocity total: 66 pts across 11 sprints', metrics)

    def test_metrics_record_retro_updates_json_and_generated_markdown(self):
        _, err, code = run_cli([
            'metrics', 'record-retro',
            'sprint=sprint-042',
            'throughput=4.25',
            'carry_over=1 task',
            'bug_rate=0',
            'estimate_accuracy=90%',
            'flags=none',
        ], env_extra=self.env)
        self.assertEqual(code, 0, f'metrics record-retro failed: {err}')
        with open(os.path.join(self.data_dir, 'memory', 'metrics.json')) as f:
            metrics_json = json.load(f)
        self.assertEqual(metrics_json['throughput']['all_time']['average'], 4.25)
        self.assertEqual(metrics_json['retro']['recent'][0]['carry_over'], '1 task')
        with open(os.path.join(self.data_dir, 'memory', 'metrics.md')) as f:
            metrics = f.read()
        self.assertIn('Throughput: 4.25 pts/hr  # sprint-042', metrics)
        self.assertIn('Generated by `shipyard-data metrics`', metrics)

    def test_metrics_regenerate_migrates_legacy_lines_before_bounding_recent(self):
        metrics_dir = os.path.join(self.data_dir, 'memory')
        os.makedirs(metrics_dir, exist_ok=True)
        metrics_path = os.path.join(metrics_dir, 'metrics.md')
        with open(metrics_path, 'w') as f:
            for n in range(1, 12):
                f.write(f'Velocity: {n} pts  # sprint-{n:03d}; features=F{n:03d}:{n}\n')

        _, err, code = run_cli(['metrics', 'regenerate'], env_extra=self.env)
        self.assertEqual(code, 0, f'metrics regenerate failed: {err}')
        with open(os.path.join(metrics_dir, 'metrics.json')) as f:
            metrics_json = json.load(f)
        self.assertEqual(metrics_json['velocity']['all_time']['count'], 11)
        self.assertEqual(metrics_json['velocity']['all_time']['total'], 66)
        self.assertEqual(len(metrics_json['velocity']['recent']), 10)
        self.assertEqual(metrics_json['velocity']['recent'][0]['sprint'], 'sprint-002')



class TestShipyardDataEvents(unittest.TestCase):
    """Tests for \`shipyard-data events emit\` (the only events subcommand
    in 2.0; tail/grep/since/json query subs were retired in F-13/F-14
    — query the JSONL directly).
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-events-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        git_init_project(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
            'SHIPYARD_DATA': self.plugin_data,
        }

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _read_events(self):
        """Read the on-disk JSONL log directly — replaces the old query
        subcommands (tail/grep/since/json), which were retired in 2.0.
        The data dir is plugin_data/projects/<hash>/, so ask the CLI."""
        import json as _json
        out, _, code = run_cli([], env_extra=self.env)
        self.assertEqual(code, 0, 'shipyard-data (no args) failed')
        data_dir = out.strip()
        log = os.path.join(data_dir, '.shipyard-events.jsonl')
        if not os.path.exists(log):
            return []
        with open(log) as f:
            return [_json.loads(line) for line in f if line.strip()]

    def _emit(self, event_type, **fields):
        import json as _json
        args = ['events', 'emit', event_type]
        for k, v in fields.items():
            args.append(f'{k}={_json.dumps(v)}')
        _, err, code = run_cli(args, env_extra=self.env)
        self.assertEqual(code, 0, f'emit failed: {err}')

    def test_events_emit_writes_jsonl_record(self):
        self._emit('something_happened', count=3, ok=True, label='S007')
        events = self._read_events()
        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertEqual(ev['type'], 'something_happened')
        self.assertEqual(ev['count'], 3)
        self.assertEqual(ev['ok'], True)
        self.assertEqual(ev['label'], 'S007')

    def test_events_emit_typed_fields(self):
        # Numbers and booleans round-trip as their native JSON types —
        # not coerced to strings.
        self._emit('typed', count=42, ratio=3.14, flag=True, name='S007')
        events = self._read_events()
        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertIsInstance(ev['count'], int)
        self.assertEqual(ev['count'], 42)
        self.assertIsInstance(ev['ratio'], float)
        self.assertEqual(ev['flag'], True)
        self.assertEqual(ev['name'], 'S007')

    def test_events_emit_type_field_does_not_clobber_event_type(self):
        """Issue #4 (defect 2): a `type=<value>` field must NOT overwrite the
        positional event type. ship-review's quality-gate reference once
        documented `events emit quality_gate_result type=sprint_specific ...`
        verbatim, which produced `{"type":"sprint_specific"}` — the
        quality_gate_result event silently vanished from every type-based
        query. The positional type must always win; the collided field is
        preserved under `type_field` so nothing is lost.
        """
        self._emit('quality_gate_result', gate_id='SSG-2',
                   type='sprint_specific', status='pass')
        events = self._read_events()
        self.assertEqual(len(events), 1)
        ev = events[0]
        self.assertEqual(ev['type'], 'quality_gate_result',
                         'positional event type must survive a type= field')
        self.assertEqual(ev['type_field'], 'sprint_specific',
                         'collided type= field must be preserved under type_field')
        self.assertEqual(ev['gate_id'], 'SSG-2')
        self.assertEqual(ev['status'], 'pass')

    def test_events_emit_requires_type(self):
        _, err, code = run_cli(['events', 'emit'], env_extra=self.env)
        self.assertNotEqual(code, 0)
        self.assertIn('type', err)

    def test_events_unknown_subcommand_rejected(self):
        # 2.0: only "emit" is supported. Anything else is rejected with
        # a hint to read the JSONL directly.
        _, err, code = run_cli(['events', 'bogus'], env_extra=self.env)
        self.assertNotEqual(code, 0)
        self.assertIn('emit', err)


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


class TestShipyardDataLinkDataDir(unittest.TestCase):
    """Tests for `shipyard-data link-data-dir`.

    The subcommand creates `<projectRoot>/.shipyard` as a directory symlink
    (POSIX) or NTFS junction (Windows) pointing at the resolved Shipyard
    data dir. It serves human navigation AND is the resolver's last-resort,
    env/TMPDIR-independent data-dir fallback (read only inside
    shipyard-resolver.mjs::readDataDirLink, validated against the project
    hash). These tests pin idempotency, repoint-on-stale, and
    refuse-on-real-entry semantics.

    Windows junction creation is exercised by the same code path
    (`symlinkSync(target, link, 'junction')`); CI runs on POSIX so the
    behavioral coverage is symlink-side.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-link-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        git_init_project(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }
        # Resolve the actual data dir via the CLI — getDataDir nests under
        # projects/<hash>/ when CLAUDE_PLUGIN_DATA is given, so we can't
        # assume plugin_data IS the data dir.
        out, _, code = run_cli([], env_extra=self.env)
        self.assertEqual(code, 0)
        self.expected_target = os.path.realpath(out.strip())
        self.expected_link = os.path.join(
            os.path.realpath(self.project_dir), '.shipyard'
        )
        # Actually initialize the data dir. link-data-dir now refuses an
        # uninitialized one: a data dir can be minted as a side effect of
        # diagnostic logging alone, and linking that planted a stray
        # `.shipyard` into projects that never completed onboarding. Real usage
        # always inits first, so the fixture should too.
        _, init_err, init_code = run_cli(['init'], env_extra=self.env)
        self.assertEqual(init_code, 0, f'init failed: {init_err}')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_refuses_when_data_dir_was_never_initialized(self):
        """A data dir minted by diagnostic logging is not a real project.

        _hook_lib's log writers mkdir the data dir recursively, so one appears
        merely from editing a file in any git repo with Shipyard installed.
        Linking that planted a stray `.shipyard` symlink into projects the user
        never completed onboarding against (observed 2026-07-28). Refuse loudly
        rather than silently no-op, so "I ran link-data-dir and got nothing"
        is never a mystery.
        """
        # Strip the init markers written by setUp, leaving only a diagnostic
        # log — exactly the shape the auto-approve hook leaves behind.
        for marker in ('.project-root', 'config.md'):
            path = os.path.join(self.expected_target, marker)
            if os.path.exists(path):
                os.remove(path)
        shutil.rmtree(os.path.join(self.expected_target, 'templates'),
                      ignore_errors=True)
        with open(os.path.join(self.expected_target, '.auto-approve.log'),
                  'w') as fh:
            fh.write('some diagnostics\n')

        out, err, code = run_cli(['link-data-dir'], env_extra=self.env)
        self.assertEqual(code, 1, 'should refuse an uninitialized data dir')
        self.assertIn('never initialized', err)
        self.assertFalse(
            os.path.lexists(self.expected_link),
            'no .shipyard may be planted for an uninitialized project',
        )

    def test_creates_symlink_pointing_at_data_dir(self):
        out, err, code = run_cli(['link-data-dir'], env_extra=self.env)
        self.assertEqual(code, 0, f'link failed: {err}')
        link_path = os.path.join(self.project_dir, '.shipyard')
        self.assertTrue(os.path.islink(link_path),
            '.shipyard should be a symlink')
        # readlink may be relative or absolute — resolve through the link
        # via realpath, which is what every consumer (cd, editors, hooks)
        # actually sees.
        self.assertEqual(os.path.realpath(link_path), self.expected_target)
        # Stdout reports the link path so callers can pipe / log it.
        self.assertIn('.shipyard', out)

    def test_idempotent_on_correct_target(self):
        """Second call is a no-op — same link, same target, exit 0."""
        run_cli(['link-data-dir'], env_extra=self.env)
        link_path = os.path.join(self.project_dir, '.shipyard')
        # Record the inode of the link itself (lstat, not stat) so we can
        # confirm it wasn't recreated.
        link_stat_before = os.lstat(link_path)
        _, err, code = run_cli(['link-data-dir'], env_extra=self.env)
        self.assertEqual(code, 0, f'second call failed: {err}')
        link_stat_after = os.lstat(link_path)
        self.assertEqual(link_stat_before.st_ino, link_stat_after.st_ino,
            'idempotent call should not recreate the symlink')

    def test_repoints_stale_symlink(self):
        """If .shipyard points at a stale target, repoint to the current data dir."""
        if sys.platform == 'win32':
            self.skipTest('os.symlink requires elevated privileges on Windows')

        link_path = os.path.join(self.project_dir, '.shipyard')
        stale_target = os.path.join(self.tmp, 'old-plugin-data')
        os.makedirs(stale_target)
        os.symlink(stale_target, link_path)
        # Sanity: stale link is in place
        self.assertEqual(os.path.realpath(link_path),
            os.path.realpath(stale_target))

        _, err, code = run_cli(['link-data-dir'], env_extra=self.env)
        self.assertEqual(code, 0, f'repoint failed: {err}')
        # Now points at the real data dir
        self.assertEqual(os.path.realpath(link_path), self.expected_target)

    def test_refuses_when_real_directory_at_path(self):
        """A user-created real .shipyard/ must not be silently clobbered."""
        link_path = os.path.join(self.project_dir, '.shipyard')
        os.makedirs(link_path)
        sentinel = os.path.join(link_path, 'user-content.md')
        with open(sentinel, 'w') as f:
            f.write('do not delete\n')

        _, err, code = run_cli(['link-data-dir'], env_extra=self.env)
        self.assertEqual(code, 1, 'should refuse without --force')
        self.assertIn('refusing', err)
        self.assertIn('--force', err)
        # User content survived
        self.assertTrue(os.path.isfile(sentinel),
            'real directory contents must not be touched')

    def test_refuses_when_real_file_at_path(self):
        """Same refuse-without-force for a plain file at .shipyard."""
        link_path = os.path.join(self.project_dir, '.shipyard')
        with open(link_path, 'w') as f:
            f.write('user notes\n')

        _, err, code = run_cli(['link-data-dir'], env_extra=self.env)
        self.assertEqual(code, 1, 'should refuse without --force')
        self.assertIn('refusing', err)
        # File survived
        self.assertTrue(os.path.isfile(link_path))
        with open(link_path) as f:
            self.assertEqual(f.read(), 'user notes\n')

    def test_force_replaces_real_directory(self):
        """With --force, a real .shipyard/ is removed and replaced with the symlink.
        Destructive — the operator explicitly opted in.
        """
        link_path = os.path.join(self.project_dir, '.shipyard')
        os.makedirs(link_path)
        with open(os.path.join(link_path, 'user-content.md'), 'w') as f:
            f.write('will be deleted\n')

        _, err, code = run_cli(['link-data-dir', '--force'], env_extra=self.env)
        self.assertEqual(code, 0, f'--force failed: {err}')
        self.assertTrue(os.path.islink(link_path),
            'after --force, .shipyard should be a symlink')
        self.assertEqual(os.path.realpath(link_path), self.expected_target)


class TestShipyardDataDoctor(unittest.TestCase):
    """Tests for `shipyard-data doctor` — the read-only integrity scan added
    for issue #4: phantom/forked project dirs, nested projects/ dirs, and
    dangling patch tasks."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-doctor-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        git_init_project(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }
        # `init` writes .project-root + templates/ so the current project reads
        # as legitimately initialized (not a phantom).
        _, err, code = run_cli(['init'], env_extra=self.env)
        self.assertEqual(code, 0, f'init failed: {err}')
        self.data_dir = self._data_dir()
        self.projects_dir = os.path.dirname(self.data_dir)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _data_dir(self):
        out, _, code = run_cli([], env_extra=self.env)
        self.assertEqual(code, 0)
        return out.strip()

    def _write_feature(self, fid='F001', **overrides):
        features_dir = os.path.join(self.data_dir, 'spec', 'features')
        os.makedirs(features_dir, exist_ok=True)
        fm = {
            'id': fid,
            'title': 'Doctor Feature',
            'type': 'feature',
            'epic': 'E001',
            'status': 'proposed',
            'story_points': '3',
            'complexity': 'M',
            'token_estimate': '1000',
            'rice_reach': '10',
            'rice_impact': '2',
            'rice_confidence': '0.8',
            'rice_effort': '2',
            'rice_score': '8',
            'dependencies': '[]',
            'references': '[]',
            'tasks': '[]',
            'created': '2026-01-01',
        }
        fm.update(overrides)
        lines = [f'{k}: {v}' for k, v in fm.items() if v is not None]
        path = os.path.join(features_dir, f'{fid}-doctor.md')
        with open(path, 'w') as f:
            f.write('---\n' + '\n'.join(lines) + '\n---\n\n# Doctor Feature\n')
        return path

    def _watermark(self):
        with open(os.path.join(self.data_dir, '.doctor-watermark.json')) as f:
            return json.load(f)

    def test_doctor_clean_project_reports_no_issues(self):
        out, _, code = run_cli(['doctor'], env_extra=self.env)
        self.assertEqual(code, 0, f'clean project should exit 0; out={out!r}')
        self.assertIn('no issues found', out)

    def test_doctor_flags_phantom_project_dir(self):
        # A sibling project dir that holds state (an event log) but was never
        # initialized — the fork signature.
        phantom = os.path.join(self.projects_dir, 'deadbeefcafe')
        os.makedirs(phantom)
        with open(os.path.join(phantom, '.shipyard-events.jsonl'), 'w') as f:
            f.write('{"ts":"2026-07-03T00:00:00+00:00","type":"next_id_allocated"}\n')

        out, _, code = run_cli(['doctor'], env_extra=self.env)
        self.assertEqual(code, 1, f'phantom dir must make doctor exit 1; out={out!r}')
        self.assertIn('phantom-project', out)
        self.assertIn('deadbeefcafe', out)

    def test_doctor_flags_nested_projects_dir(self):
        # A projects/ dir nested INSIDE the real project dir.
        nested = os.path.join(self.data_dir, 'projects', '799a0a66a4f7')
        os.makedirs(nested)
        out, _, code = run_cli(['doctor'], env_extra=self.env)
        self.assertEqual(code, 1, f'nested projects/ must make doctor exit 1; out={out!r}')
        self.assertIn('nested-projects', out)

    def test_doctor_flags_dangling_patch_task(self):
        # Emit patch_task_created for a task whose file was never written.
        self._emit_patch_task('T-CI016')
        out, _, code = run_cli(['doctor'], env_extra=self.env)
        self.assertEqual(code, 1, f'dangling patch task must make doctor exit 1; out={out!r}')
        self.assertIn('dangling-patch-task', out)
        self.assertIn('T-CI016', out)

    def test_doctor_passes_when_patch_task_file_exists(self):
        self._emit_patch_task('T-CI017')
        tasks_dir = os.path.join(self.data_dir, 'spec', 'tasks')
        os.makedirs(tasks_dir, exist_ok=True)
        # Full frontmatter (not just `id:`) — P5's registry-schema scan
        # (shipyard-data doctor) now also validates required task fields,
        # so a minimal fixture would itself trip a registry-schema finding
        # and mask the thing this test actually checks (dangling-patch-task
        # absence once the file exists).
        with open(os.path.join(tasks_dir, 'T-CI017-ci-fix.md'), 'w') as f:
            f.write(
                '---\nid: T-CI017\ntitle: ci fix\nfeature: F-CI\nstatus: done\n'
                'effort: S\ndependencies: []\n---\n'
            )
        out, _, code = run_cli(['doctor'], env_extra=self.env)
        self.assertEqual(code, 0, f'patch task with a file must pass; out={out!r}')
        self.assertIn('no issues found', out)

    def test_doctor_flags_invalid_feature_status(self):
        self._write_feature(status='cancelled')
        out, _, code = run_cli(['doctor', '--full'], env_extra=self.env)
        self.assertEqual(code, 1, f'invalid feature status must fail; out={out!r}')
        self.assertIn('registry-schema', out)
        self.assertIn('invalid status: "cancelled"', out)

    def test_doctor_accepts_feature_lifecycle_statuses(self):
        for i, status in enumerate([
            'proposed', 'approved', 'in-progress', 'done', 'deployed',
            'released', 'deferred', 'rejected',
        ], start=1):
            self._write_feature(fid=f'F{i:03d}', status=status)
        out, _, code = run_cli(['doctor', '--full'], env_extra=self.env)
        self.assertEqual(code, 0, f'valid feature lifecycle statuses should pass; out={out!r}')
        self.assertIn('registry: 8 file(s) checked', out)

    def test_doctor_flags_missing_required_feature_field(self):
        self._write_feature(rice_score=None)
        out, _, code = run_cli(['doctor', '--full'], env_extra=self.env)
        self.assertEqual(code, 1, f'missing required field must fail; out={out!r}')
        self.assertIn('missing/empty field: rice_score', out)

    def test_doctor_clean_run_creates_watermark_and_dirty_run_does_not_advance_it(self):
        self._write_feature()
        out, _, code = run_cli(['doctor', '--full'], env_extra=self.env)
        self.assertEqual(code, 0, f'clean full doctor should pass; out={out!r}')
        first = self._watermark()
        self.assertEqual(first['schemaVersion'], 1)
        self._write_feature(fid='F002', status='cancelled')
        out, _, code = run_cli(['doctor', '--full'], env_extra=self.env)
        self.assertEqual(code, 1, f'dirty doctor should fail; out={out!r}')
        self.assertEqual(first, self._watermark(), 'dirty doctor run must not advance the watermark')

    def test_doctor_full_forces_scan_even_when_incremental_would_skip(self):
        self._write_feature()
        out, _, code = run_cli(['doctor', '--full'], env_extra=self.env)
        self.assertEqual(code, 0, f'initial clean scan should pass; out={out!r}')
        wm = self._watermark()
        skipped = self._write_feature(fid='F002', status='cancelled')
        old = 1
        os.utime(skipped, (old, old))

        out, _, code = run_cli(['doctor'], env_extra=self.env)
        self.assertEqual(code, 0, f'incremental scan should skip old untouched file; out={out!r}')
        self.assertIn('incremental', out)
        with open(os.path.join(self.data_dir, '.doctor-watermark.json'), 'w') as f:
            json.dump(wm, f)

        out, _, code = run_cli(['doctor', '--full'], env_extra=self.env)
        self.assertEqual(code, 1, f'--full must re-check skipped files; out={out!r}')
        self.assertIn('invalid status: "cancelled"', out)

    def _emit_patch_task(self, task_id):
        _, err, code = run_cli(
            ['events', 'emit', 'patch_task_created', f'task_id={task_id}',
             'feature=F-CI', 'source=execute-deviation'],
            env_extra=self.env,
        )
        self.assertEqual(code, 0, f'emit failed: {err}')


class TestShipyardDataConfigIsolation(unittest.TestCase):
    """`config set-isolation <worktree|none>` — the persistent backing store
    for `/ship-execute --isolation`. Validates the enum, mutates the nested
    execution.isolation key atomically, and preserves the inline comment.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-isolation-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        git_init_project(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }
        out, err, code = run_cli(['onboarding', 'bootstrap'], env_extra=self.env)
        self.assertEqual(code, 0, err)
        self.data_dir = next(
            line.split('=', 1)[1] for line in out.splitlines()
            if line.startswith('SHIPYARD_DATA=')
        )
        self.config_path = os.path.join(self.data_dir, 'config.md')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _isolation_line(self):
        with open(self.config_path) as f:
            for line in f:
                if line.strip().startswith('isolation:'):
                    return line
        return None

    def test_default_template_is_worktree(self):
        line = self._isolation_line()
        self.assertIsNotNone(line, 'template must ship execution.isolation')
        self.assertIn('worktree', line)

    def test_set_isolation_none(self):
        out, err, code = run_cli(['config', 'set-isolation', 'none'], env_extra=self.env)
        self.assertEqual(code, 0, err)
        self.assertIn('execution.isolation: none', out)
        line = self._isolation_line()
        self.assertRegex(line, r'^\s+isolation:\s+none')
        # Inline comment must survive the atomic mutation.
        self.assertIn('#', line)

    def test_set_isolation_worktree_roundtrip(self):
        run_cli(['config', 'set-isolation', 'none'], env_extra=self.env)
        out, err, code = run_cli(['config', 'set-isolation', 'worktree'], env_extra=self.env)
        self.assertEqual(code, 0, err)
        self.assertRegex(self._isolation_line(), r'^\s+isolation:\s+worktree')

    def test_rejects_invalid_value(self):
        out, err, code = run_cli(['config', 'set-isolation', 'bogus'], env_extra=self.env)
        self.assertEqual(code, 2, 'invalid isolation value must exit 2')
        self.assertIn('worktree|none', err)
        # config.md must be untouched on rejection.
        self.assertIn('worktree', self._isolation_line())

    def test_rejects_parallel_no_iso_is_documented_sequential_only(self):
        # Guard: the skill contract states no-isolation is sequential-only.
        # This pins the CLI enum surface; the dispatch coercion lives in the
        # ship-execute skill (prose gate), asserted in the eval suite.
        out, _, code = run_cli(['config', 'set-isolation', 'parallel'], env_extra=self.env)
        self.assertEqual(code, 2)


class TestShipyardDataEnsureSharedCaches(unittest.TestCase):
    """`ensure-shared-caches` — materialize the config `shared_caches:` map into
    .claude/settings.json `env` (the injection seam for warm package-manager
    download caches across worktrees). Opt-in, absolute-paths-only, idempotent,
    and non-destructive to other settings.json keys.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-sharedcache-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        git_init_project(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }
        out, err, code = run_cli(['onboarding', 'bootstrap'], env_extra=self.env)
        self.assertEqual(code, 0, err)
        self.data_dir = next(
            line.split('=', 1)[1] for line in out.splitlines()
            if line.startswith('SHIPYARD_DATA=')
        )
        self.config_path = os.path.join(self.data_dir, 'config.md')
        self.settings_path = os.path.join(self.project_dir, '.claude', 'settings.json')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _add_shared_cache(self, line):
        with open(self.config_path) as f:
            s = f.read()
        s = s.replace('shared_caches:\n', f'shared_caches:\n  {line}\n', 1)
        with open(self.config_path, 'w') as f:
            f.write(s)

    def test_empty_is_noop(self):
        out, err, code = run_cli(['ensure-shared-caches'], env_extra=self.env)
        self.assertEqual(code, 0, err)
        self.assertIn('none configured', out)
        self.assertFalse(os.path.exists(self.settings_path),
                         'no-op must not create settings.json')

    def test_absolute_value_written_to_env(self):
        self._add_shared_cache('GRADLE_USER_HOME: /Users/you/.gradle')
        out, err, code = run_cli(['ensure-shared-caches'], env_extra=self.env)
        self.assertEqual(code, 0, err)
        with open(self.settings_path) as f:
            settings = json.load(f)
        self.assertEqual(settings['env']['GRADLE_USER_HOME'], '/Users/you/.gradle')

    def test_relative_value_refused(self):
        self._add_shared_cache('npm_config_cache: relative/bad')
        out, err, code = run_cli(['ensure-shared-caches'], env_extra=self.env)
        self.assertIn('must resolve to an absolute path', err)
        # Nothing valid to write → no settings.json.
        self.assertFalse(os.path.exists(self.settings_path))

    def test_prunes_removed_key_but_keeps_user_env(self):
        # Shipyard writes GRADLE_USER_HOME; a user separately hand-sets MY_VAR.
        self._add_shared_cache('GRADLE_USER_HOME: /Users/you/.gradle')
        run_cli(['ensure-shared-caches'], env_extra=self.env)
        with open(self.settings_path) as f:
            settings = json.load(f)
        settings['env']['MY_VAR'] = 'user-set'
        with open(self.settings_path, 'w') as f:
            json.dump(settings, f)
        # Now remove the cache entry from config and re-run.
        with open(self.config_path) as f:
            s = f.read()
        s = s.replace('  GRADLE_USER_HOME: /Users/you/.gradle\n', '')
        with open(self.config_path, 'w') as f:
            f.write(s)
        run_cli(['ensure-shared-caches'], env_extra=self.env)
        with open(self.settings_path) as f:
            settings = json.load(f)
        self.assertNotIn('GRADLE_USER_HOME', settings.get('env', {}),
                         'our removed key must be pruned')
        self.assertEqual(settings['env']['MY_VAR'], 'user-set',
                         "a user's own env key must never be pruned")

    def test_expands_home_and_tilde(self):
        home = os.path.expanduser('~')
        self._add_shared_cache('CARGO_HOME: ~/.cargo')
        self._add_shared_cache('PIP_CACHE_DIR: ${HOME}/.cache/pip')
        run_cli(['ensure-shared-caches'], env_extra={**self.env, 'HOME': home})
        with open(self.settings_path) as f:
            settings = json.load(f)
        self.assertEqual(settings['env']['CARGO_HOME'], os.path.join(home, '.cargo'))
        self.assertEqual(settings['env']['PIP_CACHE_DIR'], f'{home}/.cache/pip')

    def test_quoted_value_with_hash_survives(self):
        # F6: a quoted value may contain a space or '#' without truncation.
        self._add_shared_cache('GRADLE_USER_HOME: "/Users/you/My Cache#1"')
        run_cli(['ensure-shared-caches'], env_extra=self.env)
        with open(self.settings_path) as f:
            settings = json.load(f)
        self.assertEqual(settings['env']['GRADLE_USER_HOME'], '/Users/you/My Cache#1')

    def test_preserves_other_settings_keys(self):
        os.makedirs(os.path.dirname(self.settings_path), exist_ok=True)
        with open(self.settings_path, 'w') as f:
            json.dump({'worktree': {'baseRef': 'head'}, 'env': {'EXISTING': '1'}}, f)
        self._add_shared_cache('CARGO_HOME: /Users/you/.cargo')
        out, err, code = run_cli(['ensure-shared-caches'], env_extra=self.env)
        self.assertEqual(code, 0, err)
        with open(self.settings_path) as f:
            settings = json.load(f)
        self.assertEqual(settings['worktree']['baseRef'], 'head',
                         'unrelated keys must survive')
        self.assertEqual(settings['env']['EXISTING'], '1',
                         'pre-existing env keys must survive')
        self.assertEqual(settings['env']['CARGO_HOME'], '/Users/you/.cargo')

    def test_idempotent(self):
        self._add_shared_cache('GOMODCACHE: /Users/you/go/pkg/mod')
        run_cli(['ensure-shared-caches'], env_extra=self.env)
        with open(self.settings_path) as f:
            first = f.read()
        run_cli(['ensure-shared-caches'], env_extra=self.env)
        with open(self.settings_path) as f:
            second = f.read()
        self.assertEqual(first, second, 're-run must be a no-op byte-for-byte')


class TestShipyardDataResolveIsolation(unittest.TestCase):
    """`resolve-isolation` — the single deterministic on/off answer used by
    /ship-execute so the dispatch decision has a CLI source of truth (F1)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-resolveiso-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        git_init_project(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }
        run_cli(['onboarding', 'bootstrap'], env_extra=self.env)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_default_is_worktree(self):
        out, err, code = run_cli(['resolve-isolation'], env_extra=self.env)
        self.assertEqual(code, 0, err)
        self.assertEqual(out.strip(), 'worktree')

    def test_config_none_resolves_none(self):
        run_cli(['config', 'set-isolation', 'none'], env_extra=self.env)
        out, _, code = run_cli(['resolve-isolation'], env_extra=self.env)
        self.assertEqual(code, 0)
        self.assertEqual(out.strip(), 'none')

    def test_flag_overrides_config(self):
        run_cli(['config', 'set-isolation', 'none'], env_extra=self.env)
        out, _, _ = run_cli(['resolve-isolation', '--flag', 'true'], env_extra=self.env)
        self.assertEqual(out.strip(), 'worktree', 'flag must win over config')

    def test_flag_vocabularies(self):
        for token, expect in [('false', 'none'), ('none', 'none'), ('off', 'none'),
                              ('true', 'worktree'), ('worktree', 'worktree'), ('on', 'worktree')]:
            out, _, code = run_cli(['resolve-isolation', '--flag', token], env_extra=self.env)
            self.assertEqual((out.strip(), code), (expect, 0), f'token {token!r}')

    def test_bad_flag_exits_2(self):
        _, err, code = run_cli(['resolve-isolation', '--flag', 'maybe'], env_extra=self.env)
        self.assertEqual(code, 2)
        self.assertIn('invalid --flag', err)


class TestWorkerQueueIsolationGuard(unittest.TestCase):
    """Enqueue refuses parallel builders when isolation is off — the structural
    backstop against parallel-in-place corruption (F1). Scoped to ship-execute;
    ship-review (read-only scanners) is never blocked."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-queueguard-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        git_init_project(self.project_dir)
        self.env = {
            'CLAUDE_PROJECT_DIR': self.project_dir,
            'CLAUDE_PLUGIN_DATA': self.plugin_data,
        }
        run_cli(['onboarding', 'bootstrap'], env_extra=self.env)
        self.input = os.path.join(self.tmp, 'items.json')
        with open(self.input, 'w') as f:
            json.dump([{'id': 'T-1'}], f)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _enqueue(self, extra):
        return run_cli(['queue', 'enqueue', '--pipeline', 'ship-execute',
                        '--stage', 'wave_1_dispatch', '--input', self.input] + extra,
                       env_extra=self.env)

    def test_config_none_blocks_ship_execute_enqueue(self):
        run_cli(['config', 'set-isolation', 'none'], env_extra=self.env)
        _, err, code = self._enqueue([])
        self.assertEqual(code, 2)
        self.assertIn('sequential-only', err)

    def test_require_isolation_none_blocks(self):
        _, err, code = self._enqueue(['--require-isolation', 'false'])
        self.assertEqual(code, 2)
        self.assertIn('sequential-only', err)

    def test_require_isolation_worktree_allows(self):
        out, err, code = self._enqueue(['--require-isolation', 'worktree'])
        self.assertEqual(code, 0, err)
        self.assertIn('enqueued', out)

    def test_default_worktree_allows(self):
        out, err, code = self._enqueue([])
        self.assertEqual(code, 0, err)

    def test_ship_review_not_blocked_by_config_none(self):
        run_cli(['config', 'set-isolation', 'none'], env_extra=self.env)
        out, err, code = run_cli(['queue', 'enqueue', '--pipeline', 'ship-review',
                                  '--stage', 'review_fix_wave', '--input', self.input],
                                 env_extra=self.env)
        self.assertEqual(code, 0, f'read-only ship-review must not be blocked: {err}')

    def test_bad_require_isolation_exits_2(self):
        _, err, code = self._enqueue(['--require-isolation', 'nope'])
        self.assertEqual(code, 2)
        self.assertIn('invalid --require-isolation', err)


class TestParkEvidenceGate(unittest.TestCase):
    """rec 2: execution.require_park_evidence gates in-progress → parked
    transitions on a real --evidence file. Off by default; routing parks
    (from non-in-progress) never require evidence."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-parkev-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        git_init_project(self.project_dir)
        self.env = {'CLAUDE_PROJECT_DIR': self.project_dir, 'CLAUDE_PLUGIN_DATA': self.plugin_data}
        out, _, _ = run_cli(['onboarding', 'bootstrap'], env_extra=self.env)
        self.data_dir = next(l.split('=', 1)[1] for l in out.splitlines() if l.startswith('SHIPYARD_DATA='))
        self.tdir = os.path.join(self.data_dir, 'spec', 'tasks')
        os.makedirs(self.tdir, exist_ok=True)
        self._enable()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _enable(self):
        with open(self.data_dir + '/config.md') as f:
            s = f.read()
        with open(self.data_dir + '/config.md', 'w') as f:
            f.write(s.replace('require_park_evidence: false', 'require_park_evidence: true'))

    def _task(self, tid, status):
        with open(os.path.join(self.tdir, f'{tid}-x.md'), 'w') as f:
            f.write(f'---\nid: {tid}\nstatus: {status}\n---\nbody\n')

    def test_in_progress_park_without_evidence_refused(self):
        self._task('T001', 'in-progress')
        out, err, code = run_cli(['task', 'set-status', 'T001', 'needs-attention',
                                  '--reason', 'persistent_failure'], env_extra=self.env)
        self.assertEqual(code, 3, out)
        self.assertIn('requires --evidence', err)

    def test_in_progress_park_with_evidence_ok(self):
        self._task('T002', 'in-progress')
        ev = os.path.join(self.tmp, 'capture.log')
        with open(ev, 'w') as f:
            f.write('probe output\n')
        out, err, code = run_cli(['task', 'set-status', 'T002', 'needs-attention',
                                  '--reason', 'persistent_failure', '--evidence', ev], env_extra=self.env)
        self.assertEqual(code, 0, err)

    def test_routing_park_from_approved_needs_no_evidence(self):
        self._task('T003', 'approved')
        out, err, code = run_cli(['task', 'set-status', 'T003', 'blocked',
                                  '--reason', 'design_ambiguity'], env_extra=self.env)
        self.assertEqual(code, 0, f'pre-dispatch routing park must not require evidence: {err}')


class TestFeatureAssignAcIds(unittest.TestCase):
    """`feature assign-ac-ids <FID>` — stable @AC-<n> tags on Gherkin scenarios
    (rec 6 foundation). Idempotent."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-acids-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        git_init_project(self.project_dir)
        self.env = {'CLAUDE_PROJECT_DIR': self.project_dir, 'CLAUDE_PLUGIN_DATA': self.plugin_data}
        out, _, _ = run_cli(['onboarding', 'bootstrap'], env_extra=self.env)
        self.data_dir = next(l.split('=', 1)[1] for l in out.splitlines() if l.startswith('SHIPYARD_DATA='))
        self.fdir = os.path.join(self.data_dir, 'spec', 'features')
        os.makedirs(self.fdir, exist_ok=True)
        self.fpath = os.path.join(self.fdir, 'F001-demo.md')
        with open(self.fpath, 'w') as f:
            f.write('---\nid: F001\n---\n\n## Acceptance Criteria\n\n'
                    '```gherkin\nFeature: D\n  Scenario: one\n    Given x\n'
                    '  Scenario: two\n    Given y\n```\n\n## Interface\nx\n')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_assigns_and_is_idempotent(self):
        out, err, code = run_cli(['feature', 'assign-ac-ids', 'F001'], env_extra=self.env)
        self.assertEqual(code, 0, err)
        self.assertIn('assigned 2', out)
        body = open(self.fpath).read()
        self.assertIn('@AC-1', body)
        self.assertIn('@AC-2', body)
        out2, _, _ = run_cli(['feature', 'assign-ac-ids', 'F001'], env_extra=self.env)
        self.assertIn('assigned 0', out2)

    def test_no_ac_section_is_noop(self):
        with open(self.fpath, 'w') as f:
            f.write('---\nid: F001\n---\n\n## Interface\nx\n')
        out, _, code = run_cli(['feature', 'assign-ac-ids', 'F001'], env_extra=self.env)
        self.assertEqual(code, 0)
        self.assertIn('no "## Acceptance Criteria"', out)


class TestVerifyAcCoverage(unittest.TestCase):
    """`verify-ac-coverage` — orphan-AC gate (rec 6). Marker in diff satisfies;
    untagged feature is advisory; enforce flag toggles hard-fail."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='shipyard-accov-test-')
        self.plugin_data = os.path.join(self.tmp, 'plugin-data')
        self.project_dir = os.path.join(self.tmp, 'project')
        os.makedirs(self.plugin_data)
        os.makedirs(self.project_dir)
        git_init_project(self.project_dir)
        self.env = {'CLAUDE_PROJECT_DIR': self.project_dir, 'CLAUDE_PLUGIN_DATA': self.plugin_data}
        out, _, _ = run_cli(['onboarding', 'bootstrap'], env_extra=self.env)
        self.data_dir = next(l.split('=', 1)[1] for l in out.splitlines() if l.startswith('SHIPYARD_DATA='))
        os.makedirs(os.path.join(self.data_dir, 'spec', 'features'), exist_ok=True)
        os.makedirs(os.path.join(self.data_dir, 'sprints', 'current'), exist_ok=True)
        with open(os.path.join(self.data_dir, 'spec', 'features', 'F001-demo.md'), 'w') as f:
            f.write('---\nid: F001\n---\n## Acceptance Criteria\n```gherkin\nFeature: D\n'
                    '  @AC-1\n  Scenario: one\n  @AC-2\n  Scenario: two\n```\n')
        with open(os.path.join(self.data_dir, 'sprints', 'current', 'SPRINT.md'), 'w') as f:
            f.write('---\nid: sprint-1\nfeatures: [F001]\n---\n')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _git(self, *args):
        subprocess.run(['git', '-C', self.project_dir] + list(args), check=True, capture_output=True)

    def _commit_all(self, msg):
        self._git('add', '-A')
        subprocess.run(['git', '-C', self.project_dir, '-c', 'user.email=t@t',
                        '-c', 'user.name=t', 'commit', '-m', msg, '-q'], check=True, capture_output=True)

    def _base(self):
        subprocess.run(['git', '-C', self.project_dir, '-c', 'user.email=t@t', '-c', 'user.name=t',
                        'commit', '--allow-empty', '-m', 'base', '-q'], check=True, capture_output=True)
        return subprocess.run(['git', '-C', self.project_dir, 'rev-parse', 'HEAD'],
                              capture_output=True, text=True).stdout.strip()

    def test_orphan_ac_hard_fails(self):
        base = self._base()
        with open(os.path.join(self.project_dir, 'src.js'), 'w') as f:
            f.write('function one() { /* AC-1 */ return 1; }\n')  # AC-2 missing
        self._commit_all('impl-ac1')
        out, err, code = run_cli(['verify-ac-coverage', '--base', base, '--head', 'HEAD'],
                                 env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 3, out)
        self.assertIn('F001 AC-2', out)

    def test_all_markers_present_passes(self):
        base = self._base()
        with open(os.path.join(self.project_dir, 'src.js'), 'w') as f:
            f.write('/* AC-1 */\n// AC-2\n')
        self._commit_all('impl-both')
        out, err, code = run_cli(['verify-ac-coverage', '--base', base, '--head', 'HEAD'],
                                 env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 0, out)

    def test_untagged_feature_is_advisory(self):
        # Strip the @AC tags → feature has no tagged ACs → WARN, never fail.
        with open(os.path.join(self.data_dir, 'spec', 'features', 'F001-demo.md'), 'w') as f:
            f.write('---\nid: F001\n---\n## Acceptance Criteria\n```gherkin\nFeature: D\n'
                    '  Scenario: one\n```\n')
        base = self._base()
        with open(os.path.join(self.project_dir, 'src.js'), 'w') as f:
            f.write('nothing\n')
        self._commit_all('impl')
        out, err, code = run_cli(['verify-ac-coverage', '--base', base, '--head', 'HEAD'],
                                 env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 0, out)
        self.assertIn('WARN', out)

    def test_advisory_mode_does_not_block(self):
        with open(self.data_dir + '/config.md') as f:
            s = f.read()
        with open(self.data_dir + '/config.md', 'w') as f:
            f.write(s.replace('enforce_ac_coverage: true', 'enforce_ac_coverage: false'))
        base = self._base()
        with open(os.path.join(self.project_dir, 'src.js'), 'w') as f:
            f.write('/* AC-1 */\n')  # AC-2 orphan
        self._commit_all('impl-ac1')
        out, err, code = run_cli(['verify-ac-coverage', '--base', base, '--head', 'HEAD'],
                                 env_extra=self.env, cwd=self.project_dir)
        self.assertEqual(code, 0, f'advisory mode must not block: {out}')
        self.assertIn('advisory mode', out)


if __name__ == '__main__':
    unittest.main()
