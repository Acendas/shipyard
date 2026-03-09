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

    # Fallback to env var
    env_root = os.environ.get('CLAUDE_PLUGIN_ROOT', '')
    if env_root and os.path.isdir(env_root):
        return env_root

    # Last resort: use the derived path anyway
    return plugin_root


def resolve_shipyard_data(plugin_root):
    """Compute SHIPYARD_DATA by running shipyard-data logic inline.

    Avoids subprocess call for speed and to eliminate shell dependency.
    """
    import hashlib
    import subprocess

    # Get project root from git
    project_root = os.environ.get('CLAUDE_PROJECT_DIR', '')
    if not project_root:
        try:
            result = subprocess.run(
                ['git', 'rev-parse', '--show-toplevel'],
                capture_output=True, text=True
            )
            if result.returncode == 0:
                project_root = result.stdout.strip()
        except FileNotFoundError:
            pass
    if not project_root:
        project_root = os.getcwd()

    # Hash the project root (match bash: echo adds trailing newline)
    project_hash = hashlib.sha256((project_root + '\n').encode()).hexdigest()[:12]

    plugin_data = os.environ.get(
        'CLAUDE_PLUGIN_DATA',
        os.path.join(os.path.expanduser('~'), '.claude', 'plugins', 'data', 'shipyard')
    )
    return os.path.join(plugin_data, 'projects', project_hash)


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

    # Set environment for the target script
    os.environ['SHIPYARD_DATA'] = shipyard_data
    os.environ.setdefault('CLAUDE_PLUGIN_ROOT', plugin_root)

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
