#!/usr/bin/env python3
"""PostToolUse hook for Agent: restore CWD after worktree agent returns.

After an Agent with isolation: worktree completes, Claude Code's CWD may be
left pointing at the (possibly deleted) worktree directory. This hook detects
that the CWD has drifted and outputs a message telling Claude to restore it.

Claude Code bug #42282: Sub-agents in worktrees cause persistent CWD drift.

STDOUT CONTRACT: This hook outputs plain text messages to stdout for Claude
to see. It never outputs JSON — Claude Code PostToolUse hooks send stdout
as conversation messages, not as hook protocol responses.
"""

import json
import os
import sys


def main():
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    # Only act on Agent tool completions
    tool_name = hook_input.get('tool_name', '')
    if tool_name != 'Agent':
        sys.exit(0)

    project_dir = os.environ.get('CLAUDE_PROJECT_DIR', '')
    if not project_dir:
        sys.exit(0)

    # Check if CWD still exists and matches the project directory
    try:
        cwd = os.getcwd()
    except OSError:
        # CWD was deleted (worktree removed) — definitely need to restore
        print(
            f"⚠️  CWD DRIFT: Current directory no longer exists (worktree was cleaned up). "
            f"Run: cd \"{project_dir}\"",
            file=sys.stderr
        )
        # Output the restore command for Claude to execute
        print(f"CWD_RESTORE_NEEDED: cd \"{project_dir}\"")
        sys.exit(0)

    # Normalize for comparison
    real_cwd = os.path.realpath(cwd)
    real_project = os.path.realpath(project_dir)

    if real_cwd != real_project:
        # Check if we're in a worktree directory
        worktree_marker = os.sep + '.claude' + os.sep + 'worktrees' + os.sep
        worktree_marker_short = os.sep + 'worktrees' + os.sep
        if worktree_marker in real_cwd or worktree_marker_short in real_cwd:
            print(
                f"⚠️  CWD DRIFT: Working directory is in a worktree ({os.path.basename(cwd)}), "
                f"not the project root. Run: cd \"{project_dir}\"",
                file=sys.stderr
            )
            print(f"CWD_RESTORE_NEEDED: cd \"{project_dir}\"")

    sys.exit(0)


if __name__ == '__main__':
    main()
