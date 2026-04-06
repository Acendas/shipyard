#!/usr/bin/env python3
"""PreToolUse hook: auto-approve Edit/Write to Shipyard data files.

Works around two Claude Code permission bugs:
- #39973: ExitPlanMode resets permission mode to acceptEdits (Shipyard uses
  plan mode at wave boundaries, so every wave boundary downgrades permissions)
- #41763: Writes to paths outside the project root trigger "suspicious path"
  checks that are bypass-immune and further downgrade the permission mode

The only reliable workaround is a PreToolUse hook that returns
permissionDecision: "allow" — this fires before the permission evaluator
and short-circuits the prompt. Hooks are inherited by subagents (they read
from the same settings/plugin hooks), survive plan mode transitions, and
don't reset at system boundaries.

STDOUT CONTRACT: This hook outputs JSON to stdout ONLY when approving —
the JSON is the hook protocol response. When not approving, it exits
silently (no stdout). This is a PreToolUse hook, not WorktreeCreate,
so stdout is interpreted as a hook response, not a path.
"""

import json
import os
import sys


def main():
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_name = hook_input.get('tool_name', '')

    # Only intercept file-writing tools (Read removed — too broad a scope
    # and Read does not need permission prompts in default Claude Code)
    if tool_name not in ('Edit', 'Write', 'NotebookEdit'):
        sys.exit(0)

    tool_input = hook_input.get('tool_input', {})
    if not isinstance(tool_input, dict):
        sys.exit(0)

    file_path = tool_input.get('file_path', '')
    if not file_path:
        sys.exit(0)

    # Reject paths with traversal segments before resolution (defense in depth)
    if '..' in file_path.replace('\\', '/').split('/'):
        sys.exit(0)

    # Resolve to canonical absolute path — realpath() resolves symlinks,
    # which is critical: abspath() alone allows symlink-based escapes
    # (CVE-2026-34452 class of bug). If the file doesn't exist yet, realpath
    # still resolves any symlinks in parent components.
    try:
        file_path = os.path.realpath(os.path.expanduser(file_path))
    except (OSError, ValueError):
        sys.exit(0)

    # Get Shipyard data directory
    shipyard_data = os.environ.get('SHIPYARD_DATA', '')
    if not shipyard_data:
        sys.exit(0)

    try:
        shipyard_data = os.path.realpath(os.path.expanduser(shipyard_data))
    except (OSError, ValueError):
        sys.exit(0)

    # Containment check using commonpath — handles trailing separators,
    # Windows drive letters, and edge cases more reliably than startswith.
    try:
        common = os.path.commonpath([file_path, shipyard_data])
    except ValueError:
        # Different drives on Windows or other path mismatch
        sys.exit(0)

    if common == shipyard_data:
        response = {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "Shipyard data file — auto-approved"
            }
        }
        json.dump(response, sys.stdout)
        sys.exit(0)

    # Not a Shipyard data file — let default permission evaluation proceed
    sys.exit(0)


if __name__ == '__main__':
    main()
