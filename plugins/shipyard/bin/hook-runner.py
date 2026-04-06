#!/usr/bin/env python3
"""Cross-platform hook launcher for Shipyard.

Eliminates bash-specific syntax from hooks.json by handling:
- Plugin root discovery (from __file__, no shell variable expansion needed)
- SHIPYARD_DATA resolution (calls shipyard-data internally)
- CWD management (changes to project dir)
- Script dispatch (runs target hook script)

Usage in hooks.json:
  "command": "python3 \"${CLAUDE_PLUGIN_ROOT}/bin/hook-runner.py\" <script-name>"

Falls back to discovering plugin root from its own file path if
CLAUDE_PLUGIN_ROOT is not set (Windows compatibility).
"""

import importlib.util
import os
import sys


def discover_plugin_root():
    """Find the plugin root directory.

    Primary: derive from this file's location (bin/hook-runner.py → plugin root).
    Fallback: CLAUDE_PLUGIN_ROOT environment variable.
    """
    # This file lives in plugins/shipyard/bin/
    bin_dir = os.path.dirname(os.path.abspath(__file__))
    plugin_root = os.path.dirname(bin_dir)

    # Sanity check: plugin.json should exist
    plugin_json = os.path.join(plugin_root, '.claude-plugin', 'plugin.json')
    if os.path.isfile(plugin_json):
        return plugin_root

    # Fallback to env var — but only if it actually contains plugin.json
    # (prevents env-based redirect to an arbitrary directory)
    env_root = os.environ.get('CLAUDE_PLUGIN_ROOT', '')
    if env_root and os.path.isfile(os.path.join(env_root, '.claude-plugin', 'plugin.json')):
        return env_root

    # Hard fail: refuse to run with an undetermined plugin root
    print(
        f'hook-runner: cannot locate plugin root. Tried {plugin_root} and '
        f'CLAUDE_PLUGIN_ROOT={env_root!r}. plugin.json not found in either.',
        file=sys.stderr
    )
    sys.exit(1)


def resolve_shipyard_data(plugin_root):
    """Compute SHIPYARD_DATA, preferring the env var set by hook-runner.mjs.

    Production fast path: hook-runner.mjs imports the Node resolver in-process
    and passes SHIPYARD_DATA via env, so we read it here and return immediately.
    No subprocess spawn — saves ~80ms per Edit hook (R7).

    Slow path (tests, direct invocation): subprocess to bin/shipyard-resolver.mjs.
    The Node resolver remains the single source of truth so this stays in sync
    with shipyard-data.mjs and shipyard-context.mjs.

    Worktree behavior: the resolver returns the PARENT repo's data dir even
    when called from inside a worktree, so all worktrees of one project share
    state. See DECISIONS.md D1.
    """
    env_value = os.environ.get('SHIPYARD_DATA', '')
    if env_value:
        return env_value

    import subprocess
    resolver = os.path.join(plugin_root, 'bin', 'shipyard-resolver.mjs')
    try:
        # 2s timeout (R8): git rev-parse is bounded; long hangs are real
        # problems we should fail fast on, not paper over with a 10s wait.
        result = subprocess.run(
            ['node', resolver, 'data-dir'],
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    # Hard fail rather than fall back to a divergent path. The auto-approve
    # hook depends on this matching the value the skill computes; a silent
    # fallback would split state between two directories.
    print(
        'hook-runner: shipyard-resolver.mjs failed. Ensure Node 18+ is on PATH.',
        file=sys.stderr,
    )
    sys.exit(1)


def run_script(script_path):
    """Run a Python script by loading it as a module and calling main()."""
    spec = importlib.util.spec_from_file_location('hook_script', script_path)
    if spec is None or spec.loader is None:
        print(f'hook-runner: cannot load {script_path}', file=sys.stderr)
        sys.exit(1)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if hasattr(module, 'main'):
        module.main()


# Map short names to script paths (relative to project-files/scripts/)
SCRIPT_MAP = {
    'auto-approve-data': 'auto-approve-data.py',
    'tdd-check': 'tdd-check.py',
    'session-guard': 'session-guard.py',
    'worktree-branch': 'worktree-branch.py',
    'loop-detect': 'loop-detect.py',
    'on-commit': 'on-commit.py',
    'cwd-restore': 'cwd-restore.py',
    'post-compact': 'post-compact.py',
}


def main():
    if len(sys.argv) < 2:
        print('Usage: hook-runner.py <script-name>', file=sys.stderr)
        sys.exit(1)

    script_name = sys.argv[1]

    if script_name not in SCRIPT_MAP:
        print(f'hook-runner: unknown script "{script_name}"', file=sys.stderr)
        print(f'Available: {", ".join(sorted(SCRIPT_MAP))}', file=sys.stderr)
        sys.exit(1)

    plugin_root = discover_plugin_root()
    shipyard_data = resolve_shipyard_data(plugin_root)

    # Set environment for the target script. Always overwrite CLAUDE_PLUGIN_ROOT
    # with the discovered value so it matches the value discover_plugin_root()
    # already preferred (file-derived path beats inherited env). Using
    # setdefault here would let a stale env value win — confusing.
    os.environ['SHIPYARD_DATA'] = shipyard_data
    os.environ['CLAUDE_PLUGIN_ROOT'] = plugin_root

    # Change to project directory if available
    project_dir = os.environ.get('CLAUDE_PROJECT_DIR', '')
    if project_dir and os.path.isdir(project_dir):
        try:
            os.chdir(project_dir)
        except OSError:
            pass

    # Resolve and run the target script
    script_file = SCRIPT_MAP[script_name]
    script_path = os.path.join(plugin_root, 'project-files', 'scripts', script_file)

    if not os.path.isfile(script_path):
        print(f'hook-runner: script not found: {script_path}', file=sys.stderr)
        sys.exit(1)

    run_script(script_path)


if __name__ == '__main__':
    main()
