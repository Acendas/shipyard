#!/usr/bin/env python3
"""Post-edit hook: detect agent loops and track struggle patterns.

Tracks how many times the same file is edited in sequence.
If a file is edited 5+ times without a commit, warns about potential loop.
Also records error context when struggles are detected, so the on-commit
hook can capture learnings after the struggle resolves.

STDOUT CONTRACT: PostToolUse hooks send stdout as conversation messages to Claude.
This is safe and intentional — only WorktreeCreate hooks have the stdout-as-path
issue (Claude Code bug #40262). Loop warnings are printed to stdout so Claude sees them.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

SHIPYARD_DATA = os.environ.get('SHIPYARD_DATA', '.shipyard')
STATE_FILE = os.path.join(SHIPYARD_DATA, '.loop-state.json')
LOOP_THRESHOLD = 5


def sanitize_for_claude(s, max_len=500):
    """Sanitize untrusted strings before printing them to hook stdout.

    Hook stdout becomes part of Claude's conversation context, so any
    untrusted string (file paths, git output, frontmatter values) can carry
    indirect prompt injection. This helper strips control characters and
    caps length.
    """
    if not isinstance(s, str):
        s = str(s)
    # Strip control chars except space; remove ANSI escapes
    s = ''.join(c for c in s if c == ' ' or (c.isprintable() and c != '\x7f'))
    if len(s) > max_len:
        s = s[:max_len] + '…[truncated]'
    return s


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, ValueError) as e:
            print(f"⚠️  loop-detect: Corrupt state file, resetting: {e}", file=sys.stderr)
        except OSError as e:
            print(f"⚠️  loop-detect: Cannot read state file: {e}", file=sys.stderr)
    return {'edits': {}, 'struggles': {}}


def save_state(state):
    dir_path = os.path.dirname(STATE_FILE)
    os.makedirs(dir_path, exist_ok=True)
    try:
        fd, tmp_path = tempfile.mkstemp(dir=dir_path, suffix='.json')
        with os.fdopen(fd, 'w') as f:
            json.dump(state, f, indent=2)
        os.replace(tmp_path, STATE_FILE)
    except OSError as e:
        print(f"⚠️  loop-detect: Failed to save state: {e}", file=sys.stderr)


def main():
    # Read hook input from stdin (Claude Code passes JSON via stdin)
    file_path = ''
    try:
        hook_input = json.loads(sys.stdin.read())
        tool_input = hook_input.get('tool_input', {})
        if isinstance(tool_input, dict):
            file_path = tool_input.get('file_path', '')
        else:
            file_path = str(tool_input)
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        print(f"⚠️  loop-detect: Could not parse hook input: {e}", file=sys.stderr)

    if not file_path:
        sys.exit(0)

    state = load_state()
    edits = state.get('edits', {})
    struggles = state.get('struggles', {})

    # Increment edit count for this file
    edits[file_path] = edits.get(file_path, 0) + 1
    state['edits'] = edits
    count = edits[file_path]

    # Mark as a struggle once threshold is hit
    if count >= LOOP_THRESHOLD and file_path not in struggles:
        struggles[file_path] = {
            'edit_count': count,
            'threshold_hit': True
        }
        state['struggles'] = struggles

    # Update edit count in struggle tracking
    if file_path in struggles:
        struggles[file_path]['edit_count'] = count

    save_state(state)

    if count >= LOOP_THRESHOLD:
        safe_path = sanitize_for_claude(file_path)
        print(f"⚠️  LOOP DETECTED: {safe_path} has been edited {count} times without a commit.")
        print("")
        print("This may indicate a test-fail-fix-fail loop.")
        print("Consider:")
        print("  1. Re-reading the spec to verify your approach")
        print("  2. Simplifying the implementation")
        print("  3. Asking the user for clarification")
        print("  4. Committing current state and starting fresh")
        print("")
        print("📝 When you resolve this, Shipyard will ask you to capture what you learned")
        print("   so this pattern doesn't repeat in future tasks.")
        # Warning only, don't block
        sys.exit(0)

    sys.exit(0)


if __name__ == '__main__':
    main()
