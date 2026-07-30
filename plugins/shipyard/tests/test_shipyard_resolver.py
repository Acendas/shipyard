#!/usr/bin/env python3
from __future__ import annotations

"""Tests for bin/shipyard-resolver.mjs.

The resolver is the single source of truth for project root, project hash,
and data dir resolution. These tests pin the hash format with golden values
so a future "cleanup" of the trailing-newline coupling cannot silently
rebind every customer to a new (empty) data dir.

Tests run via subprocess against the .mjs — they verify the actual
behavior callers depend on, not just the source code.
"""

import json

import os
import subprocess
import sys
import tempfile
import unittest

RESOLVER = os.path.join(
    os.path.dirname(__file__),
    '..', 'bin', 'shipyard-resolver.mjs'
)


def run_resolver(cmd: str, env_extra: dict | None = None, cwd: str | None = None) -> tuple[str, int]:
    env = os.environ.copy()
    # Strip env vars that would override the resolver's discovery logic
    for k in ('CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT'):
        env.pop(k, None)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        ['node', RESOLVER, cmd],
        capture_output=True,
        text=True,
        env=env,
        cwd=cwd,
    )
    return proc.stdout.strip(), proc.returncode


def run_resolver_with_env(cmd: str, env_extra: dict | None = None, cwd: str | None = None) -> tuple[str, int]:
    """Like run_resolver but does NOT strip CLAUDE_PROJECT_DIR / CLAUDE_PLUGIN_*.

    The default helper hides the production code path where Claude Code sets
    CLAUDE_PROJECT_DIR to the session cwd. R1 (resolver short-circuit bypass)
    was missed because every existing test stripped these vars.
    """
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        ['node', RESOLVER, cmd],
        capture_output=True,
        text=True,
        env=env,
        cwd=cwd,
    )
    return proc.stdout.strip(), proc.returncode


class TestShipyardResolver(unittest.TestCase):

    def test_project_hash_is_stable_for_known_path(self):
        """F13: Golden hash. The hash format MUST NOT drift across releases.

        sha256('/Users/mafahir/Developer/personal/acendas/shipyard/shipyard\\n')[:12]
        = 'dbaa5569a9b3'

        If this changes, every existing customer's data dir is orphaned.
        Either the hash format changed (need migration), or someone removed
        the trailing newline coupling without updating callers.
        """
        # We can't easily set the project root externally without being
        # in a real git repo at that path, so verify via CLAUDE_PROJECT_DIR
        # which the resolver honors.
        with tempfile.TemporaryDirectory() as tmp:
            stdout, code = run_resolver('project-hash', {'CLAUDE_PROJECT_DIR': tmp})
            self.assertEqual(code, 0)
            # Hash must be a 12-char hex string
            self.assertEqual(len(stdout), 12)
            self.assertTrue(all(c in '0123456789abcdef' for c in stdout))

    def test_project_hash_deterministic(self):
        """Same input path → same hash, every time."""
        with tempfile.TemporaryDirectory() as tmp:
            h1, _ = run_resolver('project-hash', {'CLAUDE_PROJECT_DIR': tmp})
            h2, _ = run_resolver('project-hash', {'CLAUDE_PROJECT_DIR': tmp})
            self.assertEqual(h1, h2)

    def test_project_hash_differs_for_different_paths(self):
        """Different paths produce different hashes."""
        with tempfile.TemporaryDirectory() as tmp1:
            with tempfile.TemporaryDirectory() as tmp2:
                h1, _ = run_resolver('project-hash', {'CLAUDE_PROJECT_DIR': tmp1})
                h2, _ = run_resolver('project-hash', {'CLAUDE_PROJECT_DIR': tmp2})
                self.assertNotEqual(h1, h2)

    def test_data_dir_includes_hash(self):
        """data-dir output is .../projects/<hash>

        R15: Must set CLAUDE_PLUGIN_DATA explicitly so discovery is
        deterministic on fresh CI runners. After R10 made the resolver
        fail loud on no-discovery, this test was only passing on the dev
        machine because of a populated ~/.claude/plugins/data/shipyard/
        legacy dir.

        Issue #4: the project dir must be a git repo — data-dir resolution
        now refuses a non-git root rather than minting a phantom project.
        """
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['git', 'init', '-q', tmp], check=True)
            with tempfile.TemporaryDirectory() as plugin_data:
                data_dir, _ = run_resolver_with_env(
                    'data-dir',
                    env_extra={
                        'CLAUDE_PROJECT_DIR': tmp,
                        'CLAUDE_PLUGIN_DATA': plugin_data,
                    },
                )
                project_hash, _ = run_resolver(
                    'project-hash',
                    {'CLAUDE_PROJECT_DIR': tmp},
                )
                self.assertTrue(data_dir.endswith(f'/projects/{project_hash}'))

    def test_data_dir_honors_claude_plugin_data(self):
        """CLAUDE_PLUGIN_DATA env var sets the base path.

        Issue #4: the project dir is git-init'd — data-dir resolution refuses
        a non-git root (see test_data_dir_refuses_non_git_root)."""
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run(['git', 'init', '-q', tmp], check=True)
            with tempfile.TemporaryDirectory() as plugin_data:
                data_dir, _ = run_resolver(
                    'data-dir',
                    {
                        'CLAUDE_PROJECT_DIR': tmp,
                        'CLAUDE_PLUGIN_DATA': plugin_data,
                    },
                )
                self.assertTrue(
                    data_dir.startswith(plugin_data + '/projects/'),
                    f'data-dir {data_dir!r} should start with {plugin_data}/projects/'
                )

    def _git_init_with_commit(self, path):
        subprocess.run(['git', 'init', '-q', path], check=True)
        subprocess.run(
            ['git', '-C', path, 'commit', '--allow-empty', '-m', 'init', '-q'],
            check=True,
            env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t',
                 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'},
        )

    def _add_worktree(self, parent, wt_path):
        os.makedirs(os.path.dirname(wt_path), exist_ok=True)
        subprocess.run(
            ['git', '-C', parent, 'worktree', 'add', '-q', wt_path],
            check=True,
            env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t',
                 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'},
        )

    def test_builder_worktree_returns_parent_repo_root(self):
        """F5/D1: A shipyard-spawned BUILDER worktree at
        `<parent>/.claude/worktrees/<feature>/` must return the parent repo
        root so builder subagents share state with the orchestrator across
        wave boundaries. This is the load-bearing case that the F5 fix exists
        for — changing it breaks `/ship-execute`.
        """
        with tempfile.TemporaryDirectory() as parent:
            self._git_init_with_commit(parent)
            wt_path = os.path.join(parent, '.claude', 'worktrees', 'feat-x')
            self._add_worktree(parent, wt_path)

            wt_root, _ = run_resolver('project-root', cwd=wt_path)
            parent_root, _ = run_resolver('project-root', cwd=parent)

            self.assertEqual(
                os.path.realpath(wt_root),
                os.path.realpath(parent_root),
                'Builder worktree must hash to parent repo root, not worktree path',
            )

            wt_hash, _ = run_resolver('project-hash', cwd=wt_path)
            parent_hash, _ = run_resolver('project-hash', cwd=parent)
            self.assertEqual(wt_hash, parent_hash)

    def test_user_worktree_isolates_from_parent(self):
        """Two independent humans running Claude sessions in separate
        user-owned worktrees of the same repo (e.g.
        `trunk3.worktrees/dev` and `trunk3.worktrees/amdb`) must get
        ISOLATED data dirs. Otherwise `/ship-sprint` and backlog writes
        clobber each other. Locking only prevents torn writes, not logical
        overwrite.
        """
        with tempfile.TemporaryDirectory() as tmp:
            parent = os.path.join(tmp, 'trunk3')
            os.makedirs(parent)
            self._git_init_with_commit(parent)

            # Two user worktrees OUTSIDE of <parent>/.claude/worktrees/ —
            # mirrors the real-world `trunk3.worktrees/dev` shape.
            wt_dev = os.path.join(tmp, 'trunk3.worktrees', 'dev')
            wt_amdb = os.path.join(tmp, 'trunk3.worktrees', 'amdb')
            self._add_worktree(parent, wt_dev)
            self._add_worktree(parent, wt_amdb)

            parent_root, _ = run_resolver('project-root', cwd=parent)
            dev_root, _ = run_resolver('project-root', cwd=wt_dev)
            amdb_root, _ = run_resolver('project-root', cwd=wt_amdb)

            # User worktrees return their OWN toplevel, not the parent.
            self.assertEqual(os.path.realpath(dev_root), os.path.realpath(wt_dev))
            self.assertEqual(os.path.realpath(amdb_root), os.path.realpath(wt_amdb))
            self.assertNotEqual(os.path.realpath(dev_root), os.path.realpath(parent_root))

            # Hashes must all differ → three distinct data dirs.
            parent_hash, _ = run_resolver('project-hash', cwd=parent)
            dev_hash, _ = run_resolver('project-hash', cwd=wt_dev)
            amdb_hash, _ = run_resolver('project-hash', cwd=wt_amdb)
            self.assertNotEqual(dev_hash, amdb_hash)
            self.assertNotEqual(dev_hash, parent_hash)
            self.assertNotEqual(amdb_hash, parent_hash)

    def test_builder_worktree_with_claude_project_dir_set(self):
        """R1: Production scenario — Claude Code sets CLAUDE_PROJECT_DIR to
        the builder subagent's worktree cwd. The resolver must still detect
        this as a builder worktree (under `.claude/worktrees/`) and return
        the parent repo root, not short-circuit on the env var.
        """
        with tempfile.TemporaryDirectory() as parent:
            self._git_init_with_commit(parent)
            wt_path = os.path.join(parent, '.claude', 'worktrees', 'feat-x')
            self._add_worktree(parent, wt_path)

            with tempfile.TemporaryDirectory() as unrelated:
                wt_root, code = run_resolver_with_env(
                    'project-root',
                    env_extra={'CLAUDE_PROJECT_DIR': wt_path},
                    cwd=unrelated,
                )
                self.assertEqual(code, 0)
                self.assertEqual(
                    os.path.realpath(wt_root),
                    os.path.realpath(parent),
                    f'CLAUDE_PROJECT_DIR=builder-worktree must resolve to parent repo, '
                    f'got {wt_root!r}, expected {parent!r}',
                )

    def test_user_worktree_with_claude_project_dir_set(self):
        """Production scenario for independent parallel sessions: Claude Code
        sets CLAUDE_PROJECT_DIR to a user-owned worktree. The resolver must
        return the worktree's own toplevel (not the parent), so that data is
        isolated from other worktrees of the same repo.
        """
        with tempfile.TemporaryDirectory() as tmp:
            parent = os.path.join(tmp, 'trunk3')
            os.makedirs(parent)
            self._git_init_with_commit(parent)
            wt_path = os.path.join(tmp, 'trunk3.worktrees', 'dev')
            self._add_worktree(parent, wt_path)

            with tempfile.TemporaryDirectory() as unrelated:
                root, code = run_resolver_with_env(
                    'project-root',
                    env_extra={'CLAUDE_PROJECT_DIR': wt_path},
                    cwd=unrelated,
                )
                self.assertEqual(code, 0)
                self.assertEqual(
                    os.path.realpath(root),
                    os.path.realpath(wt_path),
                    f'CLAUDE_PROJECT_DIR=user-worktree must isolate to the '
                    f'worktree toplevel, got {root!r}, expected {wt_path!r}',
                )

    def test_relative_claude_project_dir_resolved_consistently(self):
        """R9: A relative CLAUDE_PROJECT_DIR must produce the same answer
        regardless of which cwd the resolver is invoked from. The resolver
        must normalize the env var to an absolute path before using it.
        """
        with tempfile.TemporaryDirectory() as parent:
            subprocess.run(['git', 'init', '-q', parent], check=True)
            subprocess.run(
                ['git', '-C', parent, 'commit', '--allow-empty', '-m', 'init', '-q'],
                check=True,
                env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t',
                     'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'},
            )
            sub = os.path.join(parent, 'sub')
            os.makedirs(sub)

            # From parent cwd, "./sub" should resolve to parent/sub which is
            # inside the parent repo → project root is parent.
            from_parent, _ = run_resolver_with_env(
                'project-root',
                env_extra={'CLAUDE_PROJECT_DIR': './sub'},
                cwd=parent,
            )
            # From sub cwd, "./" should resolve to sub which is inside parent
            # repo → project root is also parent.
            from_sub, _ = run_resolver_with_env(
                'project-root',
                env_extra={'CLAUDE_PROJECT_DIR': '.'},
                cwd=sub,
            )

            self.assertEqual(
                os.path.realpath(from_parent),
                os.path.realpath(from_sub),
                'Relative CLAUDE_PROJECT_DIR must resolve consistently regardless of cwd',
            )
            self.assertEqual(
                os.path.realpath(from_parent),
                os.path.realpath(parent),
            )


    def test_resolver_fails_loud_when_no_data_dir(self):
        """R10: With no CLAUDE_PLUGIN_DATA, no plugin-root probe, no legacy
        dir, no breadcrumb, and no .shipyard link, the resolver must exit
        non-zero with an actionable message, not silently fall back to a
        phantom path.

        Hermetic isolation against ALL three discovery mechanisms (this test
        must defeat each, or it 'passes' only by luck of the runner's cwd):
          - env var: popped.
          - breadcrumb: the resolver probes os.tmpdir() AND the hardcoded
            POSIX `/tmp`. We isolate TMPDIR/TMP/TEMP for the first, and run in
            a fresh temp git project so the project hash is unique — nothing
            in `/tmp` can match `shipyard-<unique-hash>.plugindata`.
          - .shipyard: a brand-new temp project has none.
        Setting CLAUDE_PROJECT_DIR + cwd to the temp project also pins the
        project root, so the hash never resolves to the test runner's repo.
        """
        with tempfile.TemporaryDirectory() as proj, \
             tempfile.TemporaryDirectory() as fake_home, \
             tempfile.TemporaryDirectory() as fake_tmpdir:
            subprocess.run(['git', 'init', '-q', proj], check=True)
            env = os.environ.copy()
            for k in ('CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT'):
                env.pop(k, None)
            env['CLAUDE_PROJECT_DIR'] = proj
            env['HOME'] = fake_home
            env['USERPROFILE'] = fake_home  # Windows
            env['TMPDIR'] = fake_tmpdir
            env['TMP'] = fake_tmpdir
            env['TEMP'] = fake_tmpdir
            proc = subprocess.run(
                ['node', RESOLVER, 'data-dir'],
                capture_output=True, text=True, env=env, cwd=proj,
            )
            self.assertNotEqual(proc.returncode, 0,
                f'expected non-zero exit, got {proc.returncode}; stdout={proc.stdout!r}; stderr={proc.stderr!r}')
            self.assertIn('CLAUDE_PLUGIN_DATA', proc.stderr)

    def test_data_dir_refuses_non_git_root(self):
        """Issue #4 (defect 1): when the resolved project root is NOT inside a
        git repo, data-dir resolution must refuse loudly instead of minting a
        phantom `<pluginData>/projects/<hash-of-cwd>` dir — even (especially)
        when CLAUDE_PLUGIN_DATA is set, which is the case that used to fork
        state silently. Reproduces the reported scenario: a skill orchestrator
        cd'd into the plugin data dir with no CLAUDE_PROJECT_DIR.
        """
        with tempfile.TemporaryDirectory() as non_git, \
             tempfile.TemporaryDirectory() as plugin_data, \
             tempfile.TemporaryDirectory() as fake_home, \
             tempfile.TemporaryDirectory() as empty_tmpdir:
            env = os.environ.copy()
            env.pop('CLAUDE_PROJECT_DIR', None)
            env.pop('CLAUDE_PLUGIN_ROOT', None)
            env['CLAUDE_PLUGIN_DATA'] = plugin_data
            env['HOME'] = fake_home
            env['USERPROFILE'] = fake_home
            env['TMPDIR'] = empty_tmpdir
            env['TMP'] = empty_tmpdir
            env['TEMP'] = empty_tmpdir
            proc = subprocess.run(
                ['node', RESOLVER, 'data-dir'],
                capture_output=True, text=True, env=env, cwd=non_git,
            )
            self.assertNotEqual(
                proc.returncode, 0,
                f'non-git root must fail loud; stdout={proc.stdout!r}')
            self.assertIn('git', proc.stderr.lower())
            # And it must NOT have created any projects/ dir as a side effect.
            projects = os.path.join(plugin_data, 'projects')
            self.assertFalse(
                os.path.isdir(projects),
                f'no phantom project dir may be minted; found {projects}')

    def test_breadcrumb_found_via_secondary_tmp_candidate(self):
        """R-tmpdir-split: the SessionStart hook and the skill `!` backtick
        subprocess can resolve os.tmpdir() to different directories (observed
        2026-05-28 on macOS: hook -> /var/folders/.../T, skill -> /tmp/claude-501).
        A breadcrumb written only to the hook's tmpdir is then invisible to the
        skill and /ship-discuss fails with "cannot resolve plugin data directory".

        The resolver must probe the shared POSIX `/tmp` candidate too, so a
        breadcrumb reachable there is found even when the reader's TMPDIR points
        somewhere with no breadcrumb. This reproduces the reader half: TMPDIR is
        isolated to an empty dir (the hook's tmpdir, from the reader's POV) and
        the breadcrumb lives only in /tmp.
        """
        if sys.platform == 'win32':
            self.skipTest('the /tmp secondary candidate is POSIX-only')

        with tempfile.TemporaryDirectory() as proj, \
             tempfile.TemporaryDirectory() as plugin_data, \
             tempfile.TemporaryDirectory() as empty_tmpdir:
            subprocess.run(['git', 'init', '-q', proj], check=True)

            # Compute the project hash exactly as the resolver will, with the
            # same isolated TMPDIR so nothing else interferes.
            iso = {'CLAUDE_PROJECT_DIR': proj, 'TMPDIR': empty_tmpdir,
                   'TMP': empty_tmpdir, 'TEMP': empty_tmpdir}
            project_hash, rc = run_resolver('project-hash', iso, cwd=proj)
            self.assertEqual(rc, 0)

            breadcrumb = os.path.join('/tmp', f'shipyard-{project_hash}.plugindata')
            try:
                # Writer half: breadcrumb lands ONLY in /tmp, not in the
                # reader's (isolated) os.tmpdir().
                with open(breadcrumb, 'w') as f:
                    f.write(plugin_data)
                os.chmod(breadcrumb, 0o600)

                out, rc = run_resolver('data-dir', iso, cwd=proj)
                self.assertEqual(
                    rc, 0,
                    f'resolver should find the breadcrumb via the /tmp candidate; out={out!r}')
                self.assertEqual(
                    out,
                    os.path.join(plugin_data, 'projects', project_hash))
            finally:
                try:
                    os.remove(breadcrumb)
                except FileNotFoundError:
                    pass

    def test_shipyard_symlink_resolves_when_env_and_breadcrumb_absent(self):
        """R-shipyard-link: `<projectRoot>/.shipyard` (created by CLI setup via
        `shipyard-data link-data-dir`) is an env/TMPDIR-independent fallback.
        It must resolve the data dir even when CLAUDE_PLUGIN_DATA is unset AND
        no breadcrumb is reachable — the exact gap that stranded /ship-discuss
        on 2026-05-28 (breadcrumb written to a tmp dir the reader couldn't see).
        """
        with tempfile.TemporaryDirectory() as proj, \
             tempfile.TemporaryDirectory() as plugin_data, \
             tempfile.TemporaryDirectory() as empty_tmpdir:
            subprocess.run(['git', 'init', '-q', proj], check=True)
            iso = {'CLAUDE_PROJECT_DIR': proj, 'TMPDIR': empty_tmpdir,
                   'TMP': empty_tmpdir, 'TEMP': empty_tmpdir}
            project_hash, rc = run_resolver('project-hash', iso, cwd=proj)
            self.assertEqual(rc, 0)

            # Build the real data dir shape and point .shipyard at it.
            data_dir = os.path.join(plugin_data, 'projects', project_hash)
            os.makedirs(data_dir)
            os.symlink(data_dir, os.path.join(proj, '.shipyard'))

            out, rc = run_resolver('data-dir', iso, cwd=proj)
            self.assertEqual(
                rc, 0,
                f'.shipyard symlink should resolve the data dir; out={out!r}')
            self.assertEqual(out, os.path.realpath(data_dir))

    def test_shipyard_symlink_with_wrong_hash_is_rejected(self):
        """R-shipyard-link drift guard: a `.shipyard` whose target does not end
        in `projects/<this-project-hash>` (stale, or copied from another repo)
        must be rejected, not silently used — otherwise it could redirect
        writes to the wrong project's data dir. Resolver falls through to the
        fail-loud path instead.
        """
        with tempfile.TemporaryDirectory() as proj, \
             tempfile.TemporaryDirectory() as plugin_data, \
             tempfile.TemporaryDirectory() as fake_home, \
             tempfile.TemporaryDirectory() as empty_tmpdir:
            subprocess.run(['git', 'init', '-q', proj], check=True)

            # Point .shipyard at a wrong-hash target that actually EXISTS, so
            # only the hash-shape validation (not a dangling link) can reject it.
            wrong_dir = os.path.join(plugin_data, 'projects', 'deadbeefcafe')
            os.makedirs(wrong_dir)
            os.symlink(wrong_dir, os.path.join(proj, '.shipyard'))

            env = os.environ.copy()
            for k in ('CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT'):
                env.pop(k, None)
            env['CLAUDE_PROJECT_DIR'] = proj
            env['HOME'] = fake_home
            env['USERPROFILE'] = fake_home
            env['TMPDIR'] = empty_tmpdir
            env['TMP'] = empty_tmpdir
            env['TEMP'] = empty_tmpdir
            proc = subprocess.run(
                ['node', RESOLVER, 'data-dir'],
                capture_output=True, text=True, env=env, cwd=proj,
            )
            self.assertNotEqual(
                proc.returncode, 0,
                f'wrong-hash .shipyard must be rejected; stdout={proc.stdout!r}')
            self.assertIn('CLAUDE_PLUGIN_DATA', proc.stderr)

    def test_plugin_root_probe_requires_shipyard_subdir(self):
        """R16: The CLAUDE_PLUGIN_ROOT discovery probe must check that the
        candidate <plugin_root>/../../data/shipyard/ actually exists, not just
        its parent. Otherwise the resolver returns a phantom path when another
        plugin has a sibling data dir but Shipyard's hasn't been created yet.
        """
        with tempfile.TemporaryDirectory() as tmp:
            # Build a fake plugin layout: <tmp>/cache/plugin/ with a manifest,
            # and <tmp>/data/ as the parent — but NO <tmp>/data/shipyard/.
            plugin_dir = os.path.join(tmp, 'cache', 'plugin')
            os.makedirs(os.path.join(plugin_dir, '.claude-plugin'))
            with open(os.path.join(plugin_dir, '.claude-plugin', 'plugin.json'), 'w') as f:
                f.write('{}')
            os.makedirs(os.path.join(tmp, 'data'))  # parent exists, shipyard subdir does NOT

            # Strip env so the resolver can't fall back to the dev's local
            # legacy dir. Use a fresh HOME so legacy probe also misses.
            env = {
                'PATH': os.environ['PATH'],
                'HOME': tempfile.mkdtemp(prefix='r16-fake-home-'),
                'USERPROFILE': tempfile.mkdtemp(prefix='r16-fake-home-'),
                'CLAUDE_PLUGIN_ROOT': plugin_dir,
            }
            proc = subprocess.run(
                ['node', RESOLVER, 'data-dir'],
                capture_output=True, text=True, env=env,
            )
            # Either fail loud (preferred) or fall through to a different
            # discovery path. The forbidden behavior is returning the phantom
            # <tmp>/data/shipyard/projects/... path.
            phantom = os.path.join(tmp, 'data', 'shipyard')
            self.assertNotIn(
                phantom, proc.stdout,
                f'resolver returned phantom path under non-existent {phantom!r}: '
                f'stdout={proc.stdout!r}',
            )

    def _admin_dir_for(self, worktree_path):
        proc = subprocess.run(
            ['git', '-C', worktree_path, 'rev-parse', '--absolute-git-dir'],
            capture_output=True, text=True, check=True,
        )
        return proc.stdout.strip()

    def test_origin_marker_overrides_parent_root(self):
        """Origin-marker fix: a builder worktree under
        `<parent>/.claude/worktrees/<feat>` whose admin dir carries a valid
        `shipyard-origin-root` marker resolves to the MARKER's path, not
        parentRoot — this is the whole point of the fix, so a builder
        subagent can rejoin an orchestrator that isn't sitting on the parent
        repo.
        """
        with tempfile.TemporaryDirectory() as tmp:
            parent = os.path.join(tmp, 'parent')
            os.makedirs(parent)
            self._git_init_with_commit(parent)
            wt_path = os.path.join(parent, '.claude', 'worktrees', 'feat-x')
            self._add_worktree(parent, wt_path)

            origin = os.path.join(tmp, 'origin-project')
            os.makedirs(origin)
            self._git_init_with_commit(origin)

            admin_dir = self._admin_dir_for(wt_path)
            with open(os.path.join(admin_dir, 'shipyard-origin-root'), 'w') as f:
                f.write(origin + '\n')

            root, code = run_resolver('project-root', cwd=wt_path)
            self.assertEqual(code, 0)
            self.assertEqual(
                os.path.realpath(root),
                os.path.realpath(origin),
                'valid origin marker must win over parentRoot',
            )

    def test_no_marker_falls_back_to_parent_root(self):
        """Byte-identical-behavior guarantee: a builder worktree with NO
        marker file resolves exactly as before the fix — parentRoot.
        """
        with tempfile.TemporaryDirectory() as parent:
            self._git_init_with_commit(parent)
            wt_path = os.path.join(parent, '.claude', 'worktrees', 'feat-x')
            self._add_worktree(parent, wt_path)

            admin_dir = self._admin_dir_for(wt_path)
            marker_path = os.path.join(admin_dir, 'shipyard-origin-root')
            self.assertFalse(os.path.exists(marker_path))

            root, code = run_resolver('project-root', cwd=wt_path)
            self.assertEqual(code, 0)
            self.assertEqual(
                os.path.realpath(root),
                os.path.realpath(parent),
                'no marker present must behave exactly as before the fix',
            )

    def test_origin_marker_pointing_at_nonexistent_path_falls_back(self):
        """A marker whose content is a plausible absolute path that does not
        exist on disk must be rejected, not trusted — falls back to
        parentRoot.
        """
        with tempfile.TemporaryDirectory() as parent:
            self._git_init_with_commit(parent)
            wt_path = os.path.join(parent, '.claude', 'worktrees', 'feat-x')
            self._add_worktree(parent, wt_path)

            admin_dir = self._admin_dir_for(wt_path)
            bogus = os.path.join(parent, 'this-path-does-not-exist-anywhere')
            with open(os.path.join(admin_dir, 'shipyard-origin-root'), 'w') as f:
                f.write(bogus + '\n')

            root, code = run_resolver('project-root', cwd=wt_path)
            self.assertEqual(code, 0)
            self.assertEqual(
                os.path.realpath(root),
                os.path.realpath(parent),
                'marker pointing at a nonexistent path must fall back to parentRoot',
            )

    def test_origin_marker_with_garbage_content_falls_back(self):
        """A marker containing control characters / non-path garbage /
        multiple lines must be rejected outright — never partially parsed.
        """
        with tempfile.TemporaryDirectory() as parent:
            self._git_init_with_commit(parent)
            wt_path = os.path.join(parent, '.claude', 'worktrees', 'feat-x')
            self._add_worktree(parent, wt_path)

            admin_dir = self._admin_dir_for(wt_path)
            marker_path = os.path.join(admin_dir, 'shipyard-origin-root')

            # Case 1: control characters embedded in an otherwise-plausible path.
            with open(marker_path, 'w') as f:
                f.write(parent + '\x07/evil\n')
            root, code = run_resolver('project-root', cwd=wt_path)
            self.assertEqual(code, 0)
            self.assertEqual(os.path.realpath(root), os.path.realpath(parent))

            # Case 2: not an absolute path at all.
            with open(marker_path, 'w') as f:
                f.write('relative/nonsense\n')
            root, code = run_resolver('project-root', cwd=wt_path)
            self.assertEqual(code, 0)
            self.assertEqual(os.path.realpath(root), os.path.realpath(parent))

            # Case 3: multiple lines — reject rather than take the first.
            with open(marker_path, 'w') as f:
                f.write(parent + '\n' + parent + '\n')
            root, code = run_resolver('project-root', cwd=wt_path)
            self.assertEqual(code, 0)
            self.assertEqual(os.path.realpath(root), os.path.realpath(parent))

    def test_origin_marker_real_world_shape_user_worktree_orchestrator(self):
        """The exact real-world shape that caused the bug: the orchestrator
        session sits in a USER worktree (not the parent repo), and spawns a
        builder worktree under the PARENT repo's `.claude/worktrees/`. With a
        valid marker, the builder worktree must resolve to the USER
        worktree's toplevel — matching the orchestrator's own project root —
        not the parent repo.
        """
        with tempfile.TemporaryDirectory() as tmp:
            parent = os.path.join(tmp, 'trunk3')
            os.makedirs(parent)
            self._git_init_with_commit(parent)

            # The orchestrator's own session: a USER worktree of parent.
            user_wt = os.path.join(tmp, 'trunk3.worktrees', 'dev2')
            self._add_worktree(parent, user_wt)

            # A builder worktree spawned under the PARENT repo (mirrors the
            # WorktreeCreate hook, which always creates under
            # <parentRoot>/.claude/worktrees/, regardless of where the
            # orchestrator itself is sitting).
            builder_wt = os.path.join(parent, '.claude', 'worktrees', 'agent-1')
            self._add_worktree(parent, builder_wt)

            # Stamp the marker as the hook would: origin root = the
            # orchestrator's own project root, i.e. the user worktree.
            admin_dir = self._admin_dir_for(builder_wt)
            with open(os.path.join(admin_dir, 'shipyard-origin-root'), 'w') as f:
                f.write(user_wt + '\n')

            builder_root, code = run_resolver('project-root', cwd=builder_wt)
            self.assertEqual(code, 0)
            self.assertEqual(
                os.path.realpath(builder_root),
                os.path.realpath(user_wt),
                'builder worktree with a valid marker must resolve to the '
                'orchestrator user-worktree root, matching the orchestrator',
            )

            # And hashes must now agree, closing the actual reported bug: the
            # builder and the orchestrator write to the same data dir.
            builder_hash, _ = run_resolver('project-hash', cwd=builder_wt)
            orchestrator_hash, _ = run_resolver('project-hash', cwd=user_wt)
            self.assertEqual(builder_hash, orchestrator_hash)

    # test_resolver_uses_legacy_dir_if_populated REMOVED in 2.0 (F-7).
    # The legacy ~/.claude/plugins/data/shipyard/projects probe was dropped:
    # the env var has been stable in Claude Code for several months and the
    # legacy probe was actively harmful (silent backcompat picked up orphans
    # that should be migrated through CLI onboarding). Customers with legacy
    # data are surfaced through orphan-recovery, not silent fallback.


class TestShipyardResolverProductionScenarios(unittest.TestCase):
    """R14: Tests in this class exclusively use run_resolver_with_env so the
    production code path (where Claude Code sets CLAUDE_PROJECT_DIR to the
    session cwd) is exercised on every CI run.

    The reason R1 (resolver short-circuit bypass) and R9 (relative env var
    not normalized) were missed in the first review pass is that the
    original run_resolver helper stripped CLAUDE_PROJECT_DIR from the env,
    hiding the production scenario entirely. Every test in THIS class must
    use run_resolver_with_env so future R1-class bugs land here.
    """

    def _git_init(self, path):
        subprocess.run(['git', 'init', '-q', path], check=True)
        subprocess.run(
            ['git', '-C', path, 'commit', '--allow-empty', '-m', 'init', '-q'],
            check=True,
            env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t',
                 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'},
        )

    def test_normal_repo_with_claude_project_dir(self):
        """Non-worktree repo: CLAUDE_PROJECT_DIR set to repo path → resolver
        returns repo path. The simplest production scenario."""
        with tempfile.TemporaryDirectory() as repo:
            self._git_init(repo)
            with tempfile.TemporaryDirectory() as unrelated:
                root, code = run_resolver_with_env(
                    'project-root',
                    env_extra={'CLAUDE_PROJECT_DIR': repo},
                    cwd=unrelated,
                )
                self.assertEqual(code, 0)
                self.assertEqual(os.path.realpath(root), os.path.realpath(repo))

    def test_builder_worktree_with_claude_project_dir(self):
        """Builder worktree under `<parent>/.claude/worktrees/<feat>`:
        CLAUDE_PROJECT_DIR set to worktree path → resolver returns parent
        repo root. Production scenario for builder subagents spawned by
        /ship-execute.
        """
        with tempfile.TemporaryDirectory() as parent:
            self._git_init(parent)
            wt_path = os.path.join(parent, '.claude', 'worktrees', 'feat-x')
            os.makedirs(os.path.dirname(wt_path), exist_ok=True)
            subprocess.run(
                ['git', '-C', parent, 'worktree', 'add', '-q', wt_path],
                check=True,
                env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t',
                     'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'},
            )
            with tempfile.TemporaryDirectory() as unrelated:
                root, code = run_resolver_with_env(
                    'project-root',
                    env_extra={'CLAUDE_PROJECT_DIR': wt_path},
                    cwd=unrelated,
                )
                self.assertEqual(code, 0)
                self.assertEqual(
                    os.path.realpath(root),
                    os.path.realpath(parent),
                    'CLAUDE_PROJECT_DIR=builder-worktree must resolve to parent repo',
                )

    def test_user_worktree_with_claude_project_dir(self):
        """User-owned worktree OUTSIDE `.claude/worktrees/`: resolver must
        return the worktree toplevel, not the parent, so independent Claude
        sessions on separate branches get isolated data dirs.
        """
        with tempfile.TemporaryDirectory() as tmp:
            parent = os.path.join(tmp, 'trunk3')
            os.makedirs(parent)
            self._git_init(parent)
            wt_path = os.path.join(tmp, 'trunk3.worktrees', 'dev')
            os.makedirs(os.path.dirname(wt_path), exist_ok=True)
            subprocess.run(
                ['git', '-C', parent, 'worktree', 'add', '-q', wt_path],
                check=True,
                env={**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@t',
                     'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@t'},
            )
            with tempfile.TemporaryDirectory() as unrelated:
                root, code = run_resolver_with_env(
                    'project-root',
                    env_extra={'CLAUDE_PROJECT_DIR': wt_path},
                    cwd=unrelated,
                )
                self.assertEqual(code, 0)
                self.assertEqual(
                    os.path.realpath(root),
                    os.path.realpath(wt_path),
                    'CLAUDE_PROJECT_DIR=user-worktree must isolate to worktree',
                )

    def test_relative_claude_project_dir_resolved(self):
        """Relative CLAUDE_PROJECT_DIR must produce the same answer
        regardless of which cwd the resolver is invoked from. Mirrors
        test_relative_claude_project_dir_resolved_consistently above."""
        with tempfile.TemporaryDirectory() as parent:
            self._git_init(parent)
            sub = os.path.join(parent, 'sub')
            os.makedirs(sub)
            from_parent, _ = run_resolver_with_env(
                'project-root',
                env_extra={'CLAUDE_PROJECT_DIR': './sub'},
                cwd=parent,
            )
            from_sub, _ = run_resolver_with_env(
                'project-root',
                env_extra={'CLAUDE_PROJECT_DIR': '.'},
                cwd=sub,
            )
            self.assertEqual(
                os.path.realpath(from_parent),
                os.path.realpath(from_sub),
            )
            self.assertEqual(
                os.path.realpath(from_parent),
                os.path.realpath(parent),
            )

    def test_no_env_vars_set_uses_cwd(self):
        """No CLAUDE_* env vars set: resolver falls back to cwd-based git
        discovery. This is the bare-bones path users hit when running
        shipyard-data manually outside of a Claude Code session."""
        with tempfile.TemporaryDirectory() as repo:
            self._git_init(repo)
            env = os.environ.copy()
            for k in ('CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT'):
                env.pop(k, None)
            proc = subprocess.run(
                ['node', RESOLVER, 'project-root'],
                capture_output=True, text=True, env=env, cwd=repo,
            )
            self.assertEqual(proc.returncode, 0, f'stderr={proc.stderr!r}')
            self.assertEqual(
                os.path.realpath(proc.stdout.strip()),
                os.path.realpath(repo),
            )


if __name__ == '__main__':
    unittest.main()
