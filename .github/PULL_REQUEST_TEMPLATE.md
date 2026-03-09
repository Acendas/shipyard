## What does this PR do?

<!-- One or two sentences. Link related issues with "Closes #123". -->

## What changed?

<!-- Bullet list of changes. Be specific — file paths, behavior changes, new commands. -->

-

## How was this tested?

<!-- How did you verify this works? -->

- [ ] Ran `python3 plugins/shipyard/tests/eval-run.py --skill ship-<name>` for affected skills
- [ ] Ran full eval suite (`python3 plugins/shipyard/tests/eval-run.py`)
- [ ] Manual test in a separate project with `claude --plugin-dir ./plugins/shipyard`

## Checklist

- [ ] Added/updated test assertions in `tests/assertions/` for new or changed behavior
- [ ] Evals pass
- [ ] Commit messages follow `type(scope): description` convention
- [ ] No hardcoded paths — all data access uses `$(shipyard-data)`
- [ ] Skills under 500 lines (or complexity is inherent, not bloat)
- [ ] Did not install Shipyard into its own repo for testing
