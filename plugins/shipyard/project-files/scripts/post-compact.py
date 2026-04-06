#!/usr/bin/env python3
"""PostCompact hook: re-inject sprint context and track compaction pressure.

After compaction, Claude loses conversation history but files persist.
This hook:
1. Outputs a brief state summary so Claude knows where it is
2. Tracks compaction count in .compaction-count
3. On 2+ compactions during execution, warns about context pressure

STDOUT CONTRACT: PostCompact hooks send stdout as conversation messages to Claude.
Context restoration info goes to stdout intentionally so Claude sees it after compaction.
"""

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

# Allowlist regex for frontmatter values that get printed back to Claude.
# Sprint IDs, branches, and wave numbers should be simple identifiers — if
# they contain anything else, the file may have been tampered with.
SAFE_VALUE_RE = re.compile(r'^[A-Za-z0-9._/-]{1,80}$')


def safe_value(s, fallback='unknown'):
    """Return s if it matches the strict allowlist, else fallback.

    Frontmatter fields are read from files in SHIPYARD_DATA, which a malicious
    actor could plant. Echoing arbitrary content to stdout is an indirect
    prompt injection vector — strict allowlisting blocks it.
    """
    if not isinstance(s, str):
        return fallback
    if SAFE_VALUE_RE.match(s):
        return s
    return fallback


def read_frontmatter_field(filepath, field):
    """Read a single field from YAML frontmatter."""
    try:
        with open(filepath) as f:
            in_fm = False
            for line in f:
                line = line.strip()
                if line == '---' and not in_fm:
                    in_fm = True
                    continue
                if line == '---' and in_fm:
                    break
                if in_fm and line.startswith(f'{field}:'):
                    return line.split(':', 1)[1].strip().strip('"').strip("'")
    except (FileNotFoundError, PermissionError):
        pass
    return None


def increment_compaction_count(shipyard_data):
    """Track how many compactions have fired in this execution session."""
    count_file = Path(shipyard_data) / '.compaction-count'
    count = 0
    try:
        with open(count_file) as f:
            data = json.load(f)
            count = data.get('count', 0)
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        pass

    count += 1
    with open(count_file, 'w') as f:
        json.dump({'count': count, 'last': datetime.now().isoformat()}, f)

    return count


def main():
    # Consume stdin (hook protocol)
    try:
        sys.stdin.read()
    except Exception:
        pass

    shipyard_data = os.environ.get('SHIPYARD_DATA', os.path.join(os.getcwd(), '.shipyard'))

    sprint_file = Path(shipyard_data) / 'sprints' / 'current' / 'SPRINT.md'
    progress_file = Path(shipyard_data) / 'sprints' / 'current' / 'PROGRESS.md'
    handoff_file = Path(shipyard_data) / 'sprints' / 'current' / 'HANDOFF.md'
    exec_lock = Path(shipyard_data) / '.active-execution.json'

    if not sprint_file.exists():
        sys.exit(0)

    status = read_frontmatter_field(sprint_file, 'status')
    if status != 'active':
        sys.exit(0)

    sprint_id = safe_value(read_frontmatter_field(sprint_file, 'id'))
    branch = safe_value(read_frontmatter_field(sprint_file, 'branch'))
    current_wave = None
    if progress_file.exists():
        raw_wave = read_frontmatter_field(progress_file, 'current_wave')
        current_wave = safe_value(raw_wave, fallback=None) if raw_wave else None

    parts = [f"Active sprint: {sprint_id}"]
    parts.append(f"Branch: {branch}")
    if current_wave:
        parts.append(f"Current wave: {current_wave}")
    if handoff_file.exists():
        parts.append("HANDOFF.md exists — read it for pause state")

    # Track compaction count during active execution
    if exec_lock.exists():
        count = increment_compaction_count(shipyard_data)
        if count >= 2:
            parts.append(
                f"⚠ CONTEXT PRESSURE: {count} compactions this session. "
                "Pause soon — type 'pause' to save progress before quota runs out. "
                "Finish the current task, then pause at the wave boundary."
            )
        else:
            parts.append(f"Compaction #{count} this session")

    parts.append("Read SPRINT.md and PROGRESS.md for full state")

    print(f"[Shipyard context restored] {' | '.join(parts)}")
    sys.exit(0)


if __name__ == '__main__':
    main()
