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

import datetime
import json
import os
import subprocess
import sys

# Platform-aware file locking. POSIX append-mode writes ≤ PIPE_BUF are atomic
# for concurrent writers, but Windows provides no such guarantee. The rotation
# block (read → truncate → rewrite) is also racy under concurrency on every
# platform. We serialize both via fcntl/msvcrt — same idiom as worktree-branch.py.
if sys.platform == 'win32':
    import msvcrt
else:
    import fcntl


# Cap the breadcrumb log to keep it tail-friendly. When over, rewrite with
# only the most-recent N lines. Cheap because the log is short.
_LOG_MAX_LINES = 1000


def _log_breadcrumb(data_dir, decision, tool_name, file_path):
    """Append one line to $SHIPYARD_DATA/.auto-approve.log.

    Format: <iso-timestamp> <decision> <tool> <file_path> [data_dir]

    Decisions:
      allow — file is inside SHIPYARD_DATA, hook returns permissionDecision allow
      pass  — file is outside SHIPYARD_DATA, hook stays silent (default eval proceeds)
      skip  — couldn't resolve data dir or path, hook bailed early

    Errors writing the log are swallowed: diagnostics must NEVER break the
    hook itself. The data dir is created if missing (idempotent makedirs)
    so the first hook invocation for a brand-new project still leaves a
    breadcrumb — customers can then distinguish "hook never fired" from
    "hook fired but data dir was missing".
    """
    if not data_dir:
        return
    try:
        os.makedirs(data_dir, exist_ok=True)
    except OSError:
        return  # genuinely can't create — give up silently
    log_path = os.path.join(data_dir, '.auto-approve.log')
    try:
        ts = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
        line = f'{ts} {decision} {tool_name} {file_path} {data_dir}\n'
        # Open the log in append mode and acquire an exclusive lock for the
        # full duration of the write + rotation. POSIX O_APPEND atomicity only
        # holds for writes ≤ PIPE_BUF and Windows offers no guarantee at all,
        # so concurrent hook invocations could otherwise interleave bytes or
        # lose lines. The rotation block (read → truncate → rewrite) was also
        # racy on every platform. The lock serializes all of it.
        with open(log_path, 'a', encoding='utf-8') as f:
            try:
                if sys.platform == 'win32':
                    # Lock byte 0 of the file. msvcrt.locking locks `nbytes`
                    # starting at the current file position; seek to 0 first
                    # so every writer contends on the same byte. Restore the
                    # position to end-of-file afterward so the append works.
                    f.seek(0)
                    msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
                    f.seek(0, 2)
                else:
                    fcntl.flock(f.fileno(), fcntl.LOCK_EX)
            except OSError:
                # If locking fails for any reason, fall through to the write
                # — losing a log line is still better than failing the hook.
                pass
            f.write(line)
            f.flush()
            # Periodically truncate to keep the log bounded. Stat under the
            # lock so we observe the post-write size; rotation happens under
            # the same lock to avoid read-truncate-rewrite races.
            try:
                statres = os.stat(log_path)
                # Only rotate if file is larger than ~256KB to avoid stat-on-every-write
                if statres.st_size > 256 * 1024:
                    with open(log_path, 'r', encoding='utf-8') as rf:
                        lines = rf.readlines()
                    if len(lines) > _LOG_MAX_LINES:
                        with open(log_path, 'w', encoding='utf-8') as wf:
                            wf.writelines(lines[-_LOG_MAX_LINES:])
            except OSError:
                pass
            # Lock is released implicitly when the `with open` context exits
            # and the fd is closed. Explicit unlock is unnecessary on POSIX
            # (close releases the flock) and on Windows (LK_LOCK auto-releases
            # at process exit / fd close).
    except OSError:
        pass


def _resolve_shipyard_data_via_node():
    """Fallback resolver: invoke bin/shipyard-resolver.mjs to compute the
    data dir when SHIPYARD_DATA env var is unset.

    The Node resolver is the single source of truth for project-root,
    project-hash, and data-dir logic across the plugin (see DECISIONS D1
    and F6). Calling it here keeps this hook in sync with shipyard-data
    and shipyard-context regardless of which entry point set up the env.

    Returns the data dir path on success, or empty string on any failure
    (Node missing, resolver crashed, etc.) — the caller treats empty as
    "could not resolve, bail out without approving".
    """
    plugin_root = os.environ.get('CLAUDE_PLUGIN_ROOT', '')
    if not plugin_root:
        # Discover relative to this file: scripts/ → project-files/ → plugin root
        here = os.path.dirname(os.path.abspath(__file__))
        plugin_root = os.path.dirname(os.path.dirname(here))
    resolver = os.path.join(plugin_root, 'bin', 'shipyard-resolver.mjs')
    if not os.path.isfile(resolver):
        return ''
    try:
        # 2s timeout (R8): git rev-parse is bounded; long hangs are real
        # problems we should fail fast on, not paper over with a 10s wait.
        result = subprocess.run(
            ['node', resolver, 'data-dir'],
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return ''


def main():
    try:
        hook_input = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        sys.exit(0)

    tool_name = hook_input.get('tool_name', '')

    # Only intercept file-writing tools (Read removed — too broad a scope
    # and Read does not need permission prompts in default Claude Code)
    if tool_name not in ('Edit', 'Write', 'NotebookEdit', 'MultiEdit'):
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
    # (symlink-based path escape, TOCTOU class). If the file doesn't exist yet, realpath
    # still resolves any symlinks in parent components.
    try:
        file_path = os.path.realpath(os.path.expanduser(file_path))
    except (OSError, ValueError):
        sys.exit(0)

    # Get Shipyard data directory.
    # Prefer the env var (set by hook-runner.py for hook-dispatched calls),
    # but PreToolUse fires for ALL Edit/Write tool calls — including ones
    # that don't go through hook-runner — so the env var is often missing.
    # When missing, compute it via the shared Node resolver. This is the
    # critical fix from F2: previously the hook silently no-op'd in this
    # case, defeating the entire workaround.
    shipyard_data = os.environ.get('SHIPYARD_DATA', '')
    if not shipyard_data:
        shipyard_data = _resolve_shipyard_data_via_node()
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
        _log_breadcrumb(shipyard_data, 'allow', tool_name, file_path)
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
    _log_breadcrumb(shipyard_data, 'pass', tool_name, file_path)
    sys.exit(0)


if __name__ == '__main__':
    main()
