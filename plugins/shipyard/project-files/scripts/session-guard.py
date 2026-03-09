#!/usr/bin/env python3
"""PreToolUse hook: prevent source code writes during non-implementation sessions.

When a discussion or planning skill is active (active-session.json in Shipyard data),
blocks Write/Edit to source code files. This prevents the agent from
implementing features after auto-compaction loses the skill context.

STDOUT CONTRACT: PreToolUse hooks can block tool execution via exit code 2.
All output goes to stderr (violations, warnings). stdout is unused.
"""

import json
import os
import sys


# Skills that should NOT write source code
NON_IMPL_SKILLS = {'ship-discuss', 'ship-sprint'}

# Directory prefixes that are always OK to write to (relative to project root)
SHIPYARD_DATA = os.environ.get('SHIPYARD_DATA', '.shipyard')
ALLOWED_PREFIXES = [
    '.claude' + os.sep, '.planning' + os.sep, 'templates' + os.sep,
    SHIPYARD_DATA + os.sep,
    # Also match forward slashes (git and Claude often use them on all platforms)
    '.claude/', '.planning/', 'templates/', SHIPYARD_DATA + '/',
]

# File extensions that are always OK (not source code)
ALLOWED_EXTENSIONS = [
    '.md', '.json', '.yaml', '.yml', '.toml', '.lock',
    '.css', '.scss', '.html', '.svg', '.png', '.jpg',
    '.gif', '.ico', '.woff', '.woff2', '.eot', '.ttf',
]


def main():
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_input = hook_input.get('tool_input', {})
    if not isinstance(tool_input, dict):
        sys.exit(0)

    file_path = tool_input.get('file_path', '')
    if not file_path:
        sys.exit(0)

    # Resolve to relative path from project dir
    project_dir = os.environ.get('CLAUDE_PROJECT_DIR', os.getcwd())
    if os.path.isabs(file_path):
        try:
            rel_path = os.path.relpath(file_path, project_dir)
        except ValueError:
            sys.exit(0)
    else:
        rel_path = file_path

    # Normalize separators
    rel_path = rel_path.replace('\\', '/')

    # Allow writes outside the project (shouldn't happen, but safe)
    if rel_path.startswith('..'):
        sys.exit(0)

    # Always allow writes to shipyard/claude/planning directories
    for prefix in ALLOWED_PREFIXES:
        if rel_path.startswith(prefix):
            sys.exit(0)

    # Always allow non-source files
    lower = rel_path.lower()
    for ext in ALLOWED_EXTENSIONS:
        if lower.endswith(ext):
            sys.exit(0)

    # Check for active session marker
    session_file = os.path.join(SHIPYARD_DATA, '.active-session.json')
    try:
        with open(session_file) as f:
            session = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        sys.exit(0)  # No marker or invalid — allow

    skill = session.get('skill', '')
    if skill not in NON_IMPL_SKILLS:
        sys.exit(0)  # Implementing skill or unknown — allow

    # Active non-implementation session + source code write → block
    topic = session.get('topic', 'unknown')
    print(
        f"⚠️  SESSION GUARD: You are in a /{skill} session (topic: {topic}).\n"
        f"Do not implement features during discussion/planning.\n"
        f"\n"
        f"Resume the discussion instead:\n"
        f"  - Use AskUserQuestion to re-align with the user\n"
        f"\n"
        f"To start implementing:\n"
        f"  Finish the discussion first, or /clear then /ship-execute\n"
        f"\n"
        f"To clear this guard: delete the .active-session.json in Shipyard data ($(shipyard-data))",
        file=sys.stderr
    )
    sys.exit(2)


if __name__ == '__main__':
    main()
