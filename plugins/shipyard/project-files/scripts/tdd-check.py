#!/usr/bin/env python3
"""Pre-commit hook: verify TDD compliance.

Checks that staged changes include test files alongside implementation files.
Blocks commits that have only implementation code with no tests.

STDOUT CONTRACT: PreToolUse hooks can block tool execution via exit code 2.
All output goes to stderr (violations, warnings). stdout is unused — PreToolUse
hooks that write to stdout risk corrupting tool input (Claude Code bug #40262).
"""

import json
import re
import subprocess
import sys
import os
from pathlib import PurePosixPath

# Path segments that indicate test directories
TEST_SEGMENTS = {'test', 'tests', '__tests__', 'spec', '__spec__'}

# File name patterns that indicate test files (require surrounding delimiters)
TEST_SUFFIXES = ['.test.', '.spec.', '_test.', '_spec.']

# File patterns considered implementation files (source code)
IMPL_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go',
    '.rs', '.java', '.kt', '.swift', '.dart'
]

# Extensions that are never flagged (config, docs, assets)
EXEMPT_EXTENSIONS = [
    '.md', '.json', '.yaml', '.yml', '.toml', '.lock',
    '.css', '.scss', '.html', '.svg', '.png', '.jpg',
]

# Directory prefixes that are never flagged
SHIPYARD_DATA = os.environ.get('SHIPYARD_DATA', '.shipyard')
# Exempt dirs — match both os.sep and forward slash (git uses / on all platforms)
if os.path.isabs(SHIPYARD_DATA):
    EXEMPT_DIRS = ['.claude/', '.claude' + os.sep]
else:
    EXEMPT_DIRS = [
        '.claude/', '.claude' + os.sep,
        SHIPYARD_DATA + '/', SHIPYARD_DATA + os.sep,
    ]
# Files inside the Shipyard data dir are always exempt (they're spec/config, not implementation)
# When SHIPYARD_DATA is an absolute path (plugin data), all Shipyard files are outside the repo


def get_staged_files():
    try:
        result = subprocess.run(
            ['git', 'diff', '--cached', '--name-only'],
            capture_output=True, text=True
        )
    except FileNotFoundError:
        print("⚠️  tdd-check: git not found on PATH", file=sys.stderr)
        return []
    if result.returncode != 0:
        print(f"⚠️  tdd-check: git diff failed: {result.stderr.strip()}", file=sys.stderr)
        return []
    return [f.strip() for f in result.stdout.strip().split('\n') if f.strip()]


def is_test_file(filepath):
    # Check path segments (directory names like test/, tests/, __tests__/)
    parts = set(p.lower() for p in PurePosixPath(filepath).parts)
    if parts & TEST_SEGMENTS:
        return True
    # Check filename suffixes (.test., .spec., _test., _spec.)
    lower = filepath.lower()
    return any(p in lower for p in TEST_SUFFIXES)


def is_impl_file(filepath):
    return any(filepath.endswith(ext) for ext in IMPL_EXTENSIONS)


def is_exempt(filepath):
    lower = filepath.lower()
    # Check directory prefixes
    if any(lower.startswith(d) for d in EXEMPT_DIRS):
        return True
    # Check file extensions (use endswith, not substring)
    if any(lower.endswith(ext) for ext in EXEMPT_EXTENSIONS):
        return True
    return False


def main():
    # Read hook input from stdin (Claude Code passes JSON via stdin)
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError) as e:
        print(f"⚠️  tdd-check: Could not parse hook input: {e}", file=sys.stderr)
        hook_input = {}

    # Only check on actual git commit commands
    tool_input = hook_input.get('tool_input', {})
    command = tool_input.get('command', '') if isinstance(tool_input, dict) else str(tool_input)
    if not re.search(r'\bgit\s+commit\b', command):
        sys.exit(0)
    # Honor --no-verify as an explicit bypass
    if '--no-verify' in command:
        sys.exit(0)

    staged = get_staged_files()
    if not staged:
        sys.exit(0)

    impl_files = []
    test_files = []

    for f in staged:
        if is_exempt(f):
            continue
        if is_test_file(f):
            test_files.append(f)
        elif is_impl_file(f):
            impl_files.append(f)

    # No implementation files? Fine (could be config, docs, tests-only)
    if not impl_files:
        sys.exit(0)

    # Implementation files but no test files? Block.
    if impl_files and not test_files:
        print("❌ TDD VIOLATION: Implementation files staged without tests.", file=sys.stderr)
        print("", file=sys.stderr)
        print("Implementation files:", file=sys.stderr)
        for f in impl_files:
            print(f"  {f}", file=sys.stderr)
        print("", file=sys.stderr)
        print("Write failing tests first (Red), then implement (Green).", file=sys.stderr)
        print("Stage test files alongside implementation files.", file=sys.stderr)
        print("", file=sys.stderr)
        print("If this is a legitimate exception (refactor, config), commit with:", file=sys.stderr)
        print("  git commit --no-verify", file=sys.stderr)
        sys.exit(2)

    sys.exit(0)


if __name__ == '__main__':
    main()
