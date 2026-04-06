#!/usr/bin/env python3
"""Post-commit hook: reset loop detection and trigger learning capture.

Called after a successful git commit to:
1. Reset the loop detection counter for committed files
2. Detect if a struggle just resolved (files that hit the loop threshold)
3. Signal the agent to capture what it learned into .claude/rules/learnings/

STDOUT CONTRACT: PostToolUse hooks send stdout as conversation messages to Claude.
Learning capture prompts go to stdout intentionally. Diagnostics/errors go to stderr.
"""

import json
import os
import re
import subprocess
import sys
import tempfile

SHIPYARD_DATA = os.environ.get('SHIPYARD_DATA', '.shipyard')
LOOP_STATE = os.path.join(SHIPYARD_DATA, '.loop-state.json')
LEARNINGS_DIR = '.claude/rules/learnings'


def sanitize_for_claude(s, max_len=200):
    """Strip control chars and cap length before printing untrusted strings
    to hook stdout. Hook stdout enters Claude's context, so file paths and
    git output (attacker-influenceable) need sanitization to prevent
    indirect prompt injection.
    """
    if not isinstance(s, str):
        s = str(s)
    s = ''.join(c for c in s if c == ' ' or (c.isprintable() and c != '\x7f'))
    if len(s) > max_len:
        s = s[:max_len] + '…[truncated]'
    return s


def reset_loop_state():
    """Reset edit counters and detect resolved struggles."""
    if not os.path.exists(LOOP_STATE):
        return []

    # Get files in the last commit
    try:
        result = subprocess.run(
            ['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'],
            capture_output=True, text=True
        )
    except FileNotFoundError:
        print("⚠️  on-commit: git not found on PATH", file=sys.stderr)
        return []
    if result.returncode != 0:
        print(f"⚠️  on-commit: git diff-tree failed: {result.stderr.strip()}", file=sys.stderr)
        return []
    committed_files = set(f for f in result.stdout.strip().split('\n') if f.strip())

    try:
        with open(LOOP_STATE) as f:
            state = json.load(f)
    except (json.JSONDecodeError, ValueError) as e:
        print(f"⚠️  on-commit: Corrupt loop state, skipping reset: {e}", file=sys.stderr)
        return []
    except OSError as e:
        print(f"⚠️  on-commit: Cannot read loop state: {e}", file=sys.stderr)
        return []

    edits = state.get('edits', {})
    struggles = state.get('struggles', {})

    # Find struggles that just resolved (committed files that were struggling)
    resolved_struggles = []
    for file_path in committed_files:
        if file_path in struggles:
            resolved_struggles.append({
                'file': file_path,
                'edit_count': struggles[file_path].get('edit_count', 0)
            })

    # Reset counters for committed files
    for f in committed_files:
        edits.pop(f, None)
        struggles.pop(f, None)

    state['edits'] = edits
    state['struggles'] = struggles

    # Atomic write to prevent corruption
    dir_path = os.path.dirname(LOOP_STATE)
    os.makedirs(dir_path, exist_ok=True)
    try:
        fd, tmp_path = tempfile.mkstemp(dir=dir_path, suffix='.json')
        with os.fdopen(fd, 'w') as f_out:
            json.dump(state, f_out, indent=2)
        os.replace(tmp_path, LOOP_STATE)
    except OSError as e:
        print(f"⚠️  on-commit: Failed to save loop state: {e}", file=sys.stderr)

    return resolved_struggles


def detect_domain(file_path):
    """Suggest a learnings category based on the file path."""
    path_lower = file_path.lower()

    # Map file paths to learning domains
    domain_patterns = [
        (['auth', 'login', 'session', 'token', 'jwt', 'oauth'], 'auth'),
        (['api', 'route', 'endpoint', 'handler', 'controller'], 'api'),
        (['test', 'spec', '__test', '.test.', '.spec.'], 'testing'),
        (['component', 'page', 'layout', 'view', 'ui'], 'ui'),
        (['style', 'css', 'scss', 'tailwind', 'theme'], 'styling'),
        (['model', 'schema', 'migration', 'database', 'db', 'query', 'supabase', 'prisma'], 'data'),
        (['hook', 'context', 'provider', 'store', 'state', 'redux', 'zustand'], 'state'),
        (['config', 'env', '.config', 'setting'], 'config'),
        (['util', 'helper', 'lib', 'service', 'action'], 'logic'),
    ]

    for keywords, domain in domain_patterns:
        if any(kw in path_lower for kw in keywords):
            return domain

    return 'general'


def signal_learning_capture(resolved):
    """Print a message prompting the agent to capture learnings."""
    if not resolved:
        return

    files = [s['file'] for s in resolved]
    max_edits = max(s['edit_count'] for s in resolved)

    # Suggest domains based on file paths
    domains = set(detect_domain(f) for f in files)
    domain_hint = ', '.join(sorted(domains))

    # Sanitize file paths before echoing to Claude (prompt injection defense)
    safe_files = [sanitize_for_claude(f) for f in files]

    print("")
    print("📝 LEARNING OPPORTUNITY — You just resolved a struggle.")
    print(f"   Files: {', '.join(safe_files)}")
    print(f"   Edits before resolution: {max_edits}")
    print(f"   Suggested domain(s): {domain_hint}")
    print("")
    print(f"   Append what you learned to .claude/rules/learnings/<domain>.md")
    print(f"   (create the file if it doesn't exist)")
    print("")
    print("   Format each entry as:")
    print("   ### [Short title]")
    print("   **Symptom:** [What the error looked like]")
    print("   **Cause:** [What was actually wrong]")
    print("   **Fix:** [What solved it]")
    print("")
    print("   The file needs paths: frontmatter so it auto-loads for relevant files.")
    print("   Keep entries to 3 lines. These load into context automatically via Claude rules.")


def main():
    # Read hook input from stdin — only proceed on actual git commit commands
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError) as e:
        print(f"⚠️  on-commit: Could not parse hook input: {e}", file=sys.stderr)
        hook_input = {}

    tool_input = hook_input.get('tool_input', {})
    command = tool_input.get('command', '') if isinstance(tool_input, dict) else str(tool_input)
    if not re.search(r'\bgit\s+commit\b', command):
        sys.exit(0)

    # Check if the commit actually succeeded — failed commits have error output
    tool_response = hook_input.get('tool_response', '')
    response_str = str(tool_response).lower() if tool_response else ''
    if 'nothing to commit' in response_str or 'no changes added' in response_str:
        sys.exit(0)
    # Guard needed: 'nothing to commit' means git exited 0 but no commit was made — diff-tree HEAD would return unchanged files

    resolved = reset_loop_state()
    signal_learning_capture(resolved)
    sys.exit(0)


if __name__ == '__main__':
    main()
