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
import sys
from datetime import datetime
from pathlib import Path


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

    sprint_id = read_frontmatter_field(sprint_file, 'id') or 'unknown'
    branch = read_frontmatter_field(sprint_file, 'branch') or 'unknown'
    current_wave = None
    if progress_file.exists():
        current_wave = read_frontmatter_field(progress_file, 'current_wave')

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
