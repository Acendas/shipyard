#!/usr/bin/env python3
"""WorktreeCreate hook: create worktrees from the user's current branch.

This hook REPLACES Claude Code's default worktree creation to handle:
1. Default branches from origin/HEAD — we want the user's current branch
2. Nested worktrees fail — if project is already a worktree, create from parent repo
3. Parallel creation race condition — serialized via file lock (Claude Code bug #34645)

Receives JSON on stdin: {"name": "worktree-name"}
Outputs the worktree path as plain text on stdout (Claude Code uses it as the path).

STDOUT CONTRACT: This hook outputs ONLY the worktree path to stdout. All diagnostics
go to stderr. Claude Code reads stdout as the worktree path — any extra output
(JSON, warnings, debug info) corrupts the path (Claude Code bug #40262).
"""

import json
import os
import re
import subprocess
import sys
import time

# Platform-aware file locking
if sys.platform == 'win32':
    import msvcrt
else:
    import fcntl

# Strict allowlist for worktree names. Prevents:
# - Path traversal (../, /, absolute paths)
# - Git option injection (names starting with -)
# - Shell metacharacters (defense in depth even with array-form subprocess)
# - Git ref-format violations (:, ~, ^, ?, *, [, control chars, .lock suffix)
WORKTREE_NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')


def run_git(*args, cwd=None):
    """Run a git command and return stdout, or None on failure."""
    try:
        result = subprocess.run(
            ['git'] + list(args),
            capture_output=True, text=True, cwd=cwd
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except FileNotFoundError:
        pass
    return None


def find_repo_root():
    """Find the root repo that can create worktrees.

    If we're inside a worktree, git-common-dir points to the parent repo's .git.
    We need to create worktrees from the parent, not from the nested worktree.

    All paths are resolved to absolute before comparison to avoid relative path
    mismatches (git may return relative paths depending on CWD).
    """
    git_dir = run_git('rev-parse', '--absolute-git-dir')
    common_dir = run_git('rev-parse', '--git-common-dir')

    if not git_dir or not common_dir:
        toplevel = run_git('rev-parse', '--show-toplevel')
        if toplevel and os.path.isdir(toplevel):
            return toplevel
        sys.stderr.write("shipyard worktree hook: cannot determine repo root\n")
        sys.exit(1)

    # Resolve both to absolute paths for reliable comparison
    abs_git_dir = os.path.abspath(git_dir)
    abs_common_dir = os.path.abspath(common_dir)

    # If common_dir differs from git_dir, we're in a worktree
    # common_dir points to the parent repo's .git directory
    if abs_common_dir != abs_git_dir:
        # Parent repo root is one level up from .git
        parent_root = os.path.dirname(abs_common_dir)
        if os.path.isdir(parent_root):
            return parent_root
        sys.stderr.write(f"shipyard worktree hook: parent repo root not found at {parent_root}\n")
        sys.exit(1)

    # Normal repo — use show-toplevel
    toplevel = run_git('rev-parse', '--show-toplevel')
    if toplevel and os.path.isdir(toplevel):
        return toplevel

    sys.stderr.write("shipyard worktree hook: cannot determine repo root\n")
    sys.exit(1)


def acquire_lock(lock_dir, timeout=30):
    """Acquire an exclusive file lock to serialize worktree creation.

    Prevents concurrent `git worktree add` calls from racing on .git/config.lock
    (Claude Code bug #34645). Multiple subagents spawned in parallel all trigger
    WorktreeCreate hooks simultaneously — without serialization, some fail silently.

    Returns the lock file descriptor (caller must release with release_lock).
    """
    os.makedirs(lock_dir, exist_ok=True)
    lock_path = os.path.join(lock_dir, '.worktree-create.lock')
    lock_fd = open(lock_path, 'w')

    deadline = time.monotonic() + timeout
    while True:
        try:
            if sys.platform == 'win32':
                msvcrt.locking(lock_fd.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return lock_fd
        except (IOError, OSError):
            if time.monotonic() >= deadline:
                sys.stderr.write(f"shipyard worktree hook: lock timeout after {timeout}s\n")
                lock_fd.close()
                sys.exit(1)
            time.sleep(0.5)


def release_lock(lock_fd):
    """Release the worktree creation lock."""
    try:
        if sys.platform == 'win32':
            msvcrt.locking(lock_fd.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        lock_fd.close()
    except (IOError, OSError):
        pass


def main():
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        hook_input = {}

    name = hook_input.get('name', '')
    if not name:
        sys.stderr.write("shipyard worktree hook: no worktree name provided\n")
        sys.exit(1)

    # Validate worktree name against strict allowlist. Reject anything that
    # could enable path traversal, git option injection, or invalid refs.
    if not WORKTREE_NAME_RE.match(name) or name.endswith('.lock'):
        sys.stderr.write(
            f"shipyard worktree hook: invalid worktree name. "
            f"Must match {WORKTREE_NAME_RE.pattern} and not end in .lock\n"
        )
        sys.exit(1)

    # Get current commit SHA (what the worktree should start from)
    current_sha = run_git('rev-parse', 'HEAD')
    if not current_sha:
        sys.stderr.write("shipyard worktree hook: could not determine HEAD\n")
        sys.exit(1)

    # Detect if we're on a shipyard worktree branch in the primary repo.
    # If so, use the branch's merge-base with the working branch rather than
    # raw HEAD — prevents new worktrees from branching off stale worktree state.
    current_branch = run_git('rev-parse', '--abbrev-ref', 'HEAD')
    if current_branch and current_branch.startswith('shipyard/wt-'):
        sys.stderr.write(
            f"shipyard worktree hook: WARNING — creating worktree while on "
            f"worktree branch {current_branch}. Using HEAD as base.\n"
        )

    # Find the root repo that can create worktrees
    repo_root = find_repo_root()

    # Create worktree directory under the repo root
    worktrees_dir = os.path.realpath(os.path.join(repo_root, '.claude', 'worktrees'))
    os.makedirs(worktrees_dir, exist_ok=True)
    worktree_path = os.path.realpath(os.path.join(worktrees_dir, name))

    # Defense in depth: ensure the resolved worktree path is still inside
    # worktrees_dir, even though the regex should have caught traversal
    try:
        if os.path.commonpath([worktree_path, worktrees_dir]) != worktrees_dir:
            sys.stderr.write("shipyard worktree hook: worktree path escapes worktrees dir\n")
            sys.exit(1)
    except ValueError:
        sys.stderr.write("shipyard worktree hook: invalid worktree path\n")
        sys.exit(1)

    # Serialize worktree creation to avoid git config lock contention
    lock_fd = acquire_lock(worktrees_dir)
    try:
        # Clean up stale worktree at this path if it exists
        if os.path.exists(worktree_path):
            run_git('worktree', 'remove', '--force', worktree_path, cwd=repo_root)

        # Create the worktree with a new branch based on current HEAD
        branch_name = f'shipyard/wt-{name}'

        # Delete stale branch if it exists
        run_git('branch', '-D', branch_name, cwd=repo_root)

        result = run_git('worktree', 'add', '-b', branch_name, worktree_path, current_sha, cwd=repo_root)
        if result is None:
            sys.stderr.write(f"shipyard worktree hook: git worktree add failed for {name}\n")
            sys.exit(1)
    finally:
        release_lock(lock_fd)

    # Return the worktree path for Claude Code to use
    # STDOUT CONTRACT: Only the path, nothing else (bug #40262)
    sys.stdout.write(worktree_path)
    sys.stdout.flush()
    sys.exit(0)


if __name__ == '__main__':
    main()
