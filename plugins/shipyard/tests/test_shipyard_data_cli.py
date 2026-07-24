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

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

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
        with open(os.path.join(tasks_dir, 'T-CI017-ci-fix.md'), 'w') as f:
            f.write('---\nid: T-CI017\n---\n')
        out, _, code = run_cli(['doctor'], env_extra=self.env)
        self.assertEqual(code, 0, f'patch task with a file must pass; out={out!r}')
        self.assertIn('no issues found', out)

    def _emit_patch_task(self, task_id):
        _, err, code = run_cli(
            ['events', 'emit', 'patch_task_created', f'task_id={task_id}',
             'feature=F-CI', 'source=execute-deviation'],
            env_extra=self.env,
        )
        self.assertEqual(code, 0, f'emit failed: {err}')


if __name__ == '__main__':
    unittest.main()
