---
name: ship-init
description: "Initialize or update a Shipyard project — configure settings, create directory structure, and analyze codebase. Use this when the user wants to set up Shipyard in a new project, reconfigure an existing project, re-analyze the codebase after changes, or update Shipyard tool files."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, Agent, AskUserQuestion, WebSearch, WebFetch]
model: sonnet
effort: medium
argument-hint: ""
---

# Shipyard: Initialize / Update Project

You are setting up (or updating) Shipyard for this project.

## Context

!`shipyard-context path`

!`shipyard-context cat version.md NO_VERSION`
!`shipyard-context head config.md 50 NO_CONFIG`
!`[ -f .shipyard/config.md ] && echo "LEGACY_SHIPYARD_DETECTED" || echo "NO_LEGACY"`
!`head -50 CLAUDE.md 2>/dev/null || echo "No CLAUDE.md"`

## Detect Mode

**If context shows `LEGACY_SHIPYARD_DETECTED`** → MUST run legacy migration FIRST, before anything else. Do not skip this. Do not go to quick check. The `.shipyard/` directory in the project contains user data that needs to move to plugin data.

**If context shows `NO_LEGACY`** → skip migration, proceed to normal detect mode below.

### Legacy Migration (.shipyard/ → plugin data)

**This runs when `.shipyard/config.md` exists in the project directory.** This is a pre-v0.5.0 installation.

**⚠️ Branch check first:** The `.shipyard/` directory may contain data from a different branch (it was git-tracked, so it changes with branch switches). Before migrating, verify the data matches the current branch:

1. Check current branch: `git branch --show-current`
2. Check if `.shipyard/` was recently modified on this branch: `git log -1 --format=%H -- .shipyard/ 2>/dev/null`
3. If `.shipyard/` was last modified on a different branch, AskUserQuestion:

   ```
   The .shipyard/ directory may contain specs from a different branch.
   Current branch: [branch]
   Last .shipyard/ commit: [branch/hash]

   1. Migrate anyway — I'll use this data as a starting point
   2. Start fresh — ignore old data, initialize clean for this branch
   3. Let me check — I'll switch branches first

   Recommended: 2 — cleaner to start fresh on the current branch
   ```

**Migration steps (if proceeding):**

1. Create the plugin data directory: `shipyard-data init`
2. Copy contents: `cp -r .shipyard/* "$(shipyard-data)/"`
3. Remove legacy scripts (now served from plugin): `rm -rf "$(shipyard-data)/scripts/"`
4. Remove transient files: `rm -f "$(shipyard-data)/.loop-state.json" "$(shipyard-data)/.active-session.json" "$(shipyard-data)/.test-output.tmp"`
5. Report:

   ```
   Migrated Shipyard data from .shipyard/ to plugin data directory.
   The .shipyard/ directory is no longer needed — you can safely delete it:
     rm -rf .shipyard/
   ```

   Do NOT auto-delete `.shipyard/`.

6. **Re-run codebase analysis** (Step 3) to ensure `codebase-context.md` matches the current branch.
7. Continue to QUICK CHECK below.

---

Check if `$(shipyard-data)/config.md` exists:
- **If NO** → FRESH INSTALL mode
- **If YES** → QUICK CHECK first, then UPDATE if needed

### Quick Check (fast path for already-initialized projects)

If `$(shipyard-data)/config.md` exists, run these checks before doing anything else:

1. **Rules present and current?** Compare plugin rules against project rules:
   ```bash
   PLUGIN_RULES="${CLAUDE_PLUGIN_ROOT}/project-files/rules"
   for f in "$PLUGIN_RULES"/shipyard-*.md; do
     name=$(basename "$f")
     if [ ! -f ".claude/rules/$name" ]; then
       echo "MISSING: $name"
     elif ! diff -q "$f" ".claude/rules/$name" >/dev/null 2>&1; then
       echo "OUTDATED: $name"
     fi
   done
   ```
   If any rules are MISSING or OUTDATED → re-copy all rules from plugin.
2. **Config version current?** Read `config_version` from `$(shipyard-data)/config.md` — if matches latest (3), no migration needed
3. **Codebase context exists?** `ls $(shipyard-data)/codebase-context.md 2>/dev/null` — if exists, no re-analysis needed

**If ALL checks pass** → report and exit immediately:
```
✓ Shipyard is up to date. Nothing to do.
  Run /ship-status for project overview, or /ship-discuss to start working.
```

**If any check fails** → continue to UPDATE mode to fix what's missing. Report what triggered the update:
```
Shipyard needs updating:
  [✗ missing rules | ✗ config migration needed | ✗ codebase context missing]
```

---

## FRESH INSTALL Mode

### Step 0: Ensure Git Repository

Shipyard requires git (worktree isolation, branch strategy, TDD hooks all depend on it).

1. Check: `git rev-parse --git-dir 2>/dev/null`
2. If not a git repo → run `git init` and create an initial commit:
   ```bash
   git init
   git add -A
   git commit -m "chore: initial commit"
   ```
   If the directory is empty (nothing to add), create a `.gitkeep` and commit that.
3. If a git repo but no commits (`git log` fails) → create an initial commit with whatever exists.

This ensures worktree isolation and branching work from the first sprint.

### Step 1: Ask Configuration Questions

Scan the project first — auto-detect as much as possible. Only ask what you can't figure out.

**Ask these (skip if obvious from codebase):**
1. **Project name** — what is this project called?
2. **Tech stack** — languages, frameworks, libraries (scan package.json, Cargo.toml, go.mod, etc. first)
3. **Testing framework** — vitest, jest, pytest, go test, etc. (check existing test files first)
4. **Test commands** — auto-detect from package.json scripts, pytest.ini, Makefile, etc. Populate `test_commands` in config:
   - `unit` — run unit tests (e.g., `vitest run`)
   - `integration` — run integration tests
   - `e2e` — run E2E tests (if applicable)
   - `scoped` — run a subset by pattern (e.g., `vitest run --testPathPattern`)
   If not detectable, AskUserQuestion: "I couldn't auto-detect your test commands. What commands do you use to run tests? (e.g., `npm test`, `pytest`, `go test ./...`)"

**Auto-detect these (confirm, don't ask):**
Scan the project and present findings: "I detected [X]. Correct?" Only ask if detection fails.
5. **Project type** — infer from stack (Next.js → web-app, Express → api, etc.)
6. **CI (continuous integration) platform** — check .github/workflows/, .gitlab-ci.yml, etc.
7. **Repo type** — check for workspace configs (monorepo — multiple projects in one repo) or single package.json (single)
8. **Git main branch** — detect main branch name (`git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null` or check for `main`/`master`).

**Use defaults (only ask if the user brings it up):**
9. **E2E (end-to-end) framework** — only ask if E2E tests detected or project type is web-app/mobile
10. **Team size** — default: solo. Only ask if multiple contributors detected in git log.
11. **Workflow** — default: sprint. Only ask if team size > solo.
12. **Pull request workflow** — Shipyard does not create PRs or push. Skip.

### Step 2: Create Directory Structure

```
$(shipyard-data)/
├── config.md              ← from answers above
├── codebase-context.md    ← generated in step 3
├── spec/
│   ├── epics/
│   ├── features/
│   ├── tasks/
│   ├── bugs/
│   ├── ideas/
│   └── references/      ← detail docs split from large spec files
├── backlog/
│   └── BACKLOG.md
├── sprints/
│   └── current/           ← empty until first sprint
├── verify/
├── debug/
│   └── resolved/        ← closed debug sessions
├── memory/
│   └── metrics.md
├── releases/              ← changelog files per version
└── templates/             ← spec templates (copied from plugin)
```

Create the directory structure by running:
```bash
shipyard-data init
```
This creates all directories in the plugin data area (outside the project — no git noise).

**Install rules into the project:**
Rules live in the project's `.claude/rules/` (plugins can't ship rules directly):

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -d "$PLUGIN_ROOT/project-files" ]; then
  mkdir -p .claude/rules
  cp -r "$PLUGIN_ROOT/project-files/rules/"shipyard-*.md .claude/rules/ 2>/dev/null
fi
```

Templates are copied into plugin data (not the project):
```bash
cp -r "$PLUGIN_ROOT/project-files/templates/"*.md "$(shipyard-data)/templates/" 2>/dev/null
```

Copy template files:
- `$(shipyard-data)/backlog/BACKLOG.md` from `$(shipyard-data)/templates/BACKLOG.md`
- `$(shipyard-data)/config.md` — generate from user answers using template format

**Update .gitignore** — append if not already present:
```
# Claude Code local memory (machine-specific paths — never commit)
.claude/projects/
```

Note: Shipyard data lives in `${CLAUDE_PLUGIN_DATA}` (outside the project), so no `.shipyard/` gitignore entries needed.

### Step 3: Analyze Codebase

Scan the codebase and write findings to `$(shipyard-data)/codebase-context.md`.

1. **Project structure** — directory layout, key directories
2. **Tech stack detected** — frameworks, libraries, versions from package files
3. **Existing patterns** — naming conventions, file organization, import patterns
4. **Existing tests** — test framework, test file locations, coverage config
5. **Build system** — build scripts, bundler, compiler settings
6. **Environment** — .env files (list variables, NOT values), docker setup, CI config
7. **Entry points** — main files, route definitions, API entry points
8. **Dependencies** — key external dependencies and their purposes
9. **Commit conventions** — analyze the last 30 git commits to detect the project's commit style:
   ```bash
   git log --oneline -30 --no-decorate 2>/dev/null
   ```
   Detect patterns:
   - **Conventional Commits** — `feat:`, `fix:`, `chore:`, `docs:` with optional scope `feat(auth):`
   - **Gitmoji** — emoji prefixes like `:sparkles:`, `:bug:`
   - **Jira-prefixed** — `PROJ-123: description`
   - **Freeform** — no consistent pattern
   - **Scoped** — does the project use scopes? What scopes? `(auth)`, `(ui)`, `(api)`?
   - **Case** — lowercase, sentence case, title case?
   - **Length** — average subject line length, multi-line bodies?

   Also check for:
   - `.commitlintrc`, `commitlint.config.js` — explicit lint config
   - `.czrc`, `.cz.json` — commitizen config
   - Pre-commit hooks that validate commit messages (`.husky/`, `.git/hooks/`)

   Write detected convention to config:
   ```yaml
   git:
     commit_format: conventional  # conventional | gitmoji | jira | freeform
     commit_scope: true           # use scopes like feat(auth):
     commit_case: lowercase       # lowercase | sentence | title
     commit_examples:             # 3 representative examples from history
       - "feat(auth): add user registration flow"
       - "fix(api): handle null response from external endpoint"
       - "chore: update dependencies"
   ```

   If no commits exist (new project), AskUserQuestion: "What commit message format do you prefer? (conventional commits is the default)"

   **Generate a commit format rule** — write `.claude/rules/project-commit-format.md`:
   ```markdown
   ---
   paths: [".git/**/*"]
   ---
   # Commit Message Format

   This project uses [detected format]. Follow these conventions:

   Format: [format description]
   Case: [case convention]
   Scopes: [list of scopes or "none"]

   Examples from this project:
   - [example 1]
   - [example 2]
   - [example 3]
   ```
   This auto-loads whenever git operations happen, ensuring consistent commit messages across all agents and skills without every skill needing to read config.

Format codebase-context.md with YAML frontmatter summarizing key facts, markdown body with details.

### Step 3b: Detect Existing Tools & Brownfield Discovery

Check for existing project management tools before scanning the codebase:

**Check for existing spec documents:**

Scan for existing human-authored technical docs in these locations:
- `spec/`, `specs/`, `spec/docs/`, `docs/specs/`, `docs/spec/` — only if they contain 3+ `.md` files with product/feature-like content (not test runner config files)
- `documentation/`, `documents/`, `design-docs/`, `rfcs/`, `proposals/` — only if they contain 3+ `.md` files
- Any other directory with 5+ `.md` files whose names or titles suggest feature/product specs

First pass — scan filenames and titles only (do NOT read full file content yet):
- Count matching files
- Read the first 5 lines of each to confirm they look like feature/product docs

AskUserQuestion: "Found [N] spec documents in [path]/. Shipyard doesn't duplicate your existing docs — it references them. Want me to index these so Shipyard knows where your specs live? When you plan features, Shipyard will read them directly from their current location. (yes/no)"

If yes:
1. Scan each doc — read first 20 lines to understand what it covers
2. Record the mapping in `$(shipyard-data)/codebase-context.md` under a `## Existing Specs` section:
   ```
   ## Existing Specs
   - [path/to/auth-spec.md] — authentication and authorization
   - [path/to/api-design.md] — API endpoint conventions
   - [path/to/data-model.md] — database schema and relationships
   ```
3. Do NOT copy, duplicate, or create feature files from these docs
4. Report: "Indexed [N] spec documents. Shipyard will reference them in-place during /ship-discuss and /ship-sprint."

Shipyard's spec directory (`$(shipyard-data)/spec/`) holds only the **working set** — features being planned, built, or reviewed. It is NOT a mirror of the entire product. The user's existing docs remain the source of truth for the system as a whole.

**If no spec docs found — note brownfield context:**

If the codebase analysis reveals an existing application with routes, components, APIs, or models — note this in `$(shipyard-data)/codebase-context.md` under `## Existing Functionality`:
- List discovered routes, API endpoints, components, models
- This gives `/ship-discuss` and `/ship-sprint` context about what already exists

Do NOT create feature specs for existing code. Shipyard's spec is for **new work being planned and built**, not a catalog of existing functionality. The codebase-context.md serves as the reference for what's already there.

If the user wants to formalize existing features later, they use `/ship-discuss [topic]`.

### Step 3c: Constitution Advisor

**Read the full guide:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-init/references/constitution-advisor.md`

Evaluate the project's existing architectural rules across 10 categories: architecture boundaries, code size limits, naming conventions, component patterns, testing patterns, error handling, banned patterns, domain vocabulary, shared patterns, and build order.

For each category, classify as COVERED / WEAK / MISSING by checking:
- `.claude/rules/` — existing path-scoped rules (use `ls .claude/rules/` explicitly, hidden dirs are not globbed by default)
- `.claude/skills/` — any custom skills that imply conventions or constraints
- `CLAUDE.md` — project-level instructions
- Linter configs (`.eslintrc`, `pyproject.toml`, `.rubocop.yml`, etc.)
- Existing conventions files (`CONTRIBUTING.md`, `ARCHITECTURE.md`, etc.)
- The codebase itself (actual patterns in use)

For any WEAK or MISSING category:
1. **Analyze the codebase** — measure actual file sizes, detect naming patterns already in use, find import boundaries
2. **Research the stack** — WebSearch for "[framework] [category] best practices" and "[framework] production conventions" to find what experienced teams enforce. Check framework docs for official style guides.
3. **Propose specific rules** — not generic advice, but concrete enforceable rules grounded in the project's actual tech stack and existing patterns

Present all proposals at once, grouped by category, with rationale for each. Let the user accept all, pick some, or skip entirely. Create accepted rules as `.claude/rules/` files (not prefixed with `shipyard-`).

### Step 3d: Generate SME Skills

After codebase analysis is complete, generate Subject Matter Expert skills for the project's technology stack. These skills encode how THIS project uses each technology — project-specific patterns, paths, commands, and conventions.

**Extract technologies** from the codebase analysis (Step 3):
- Languages and frameworks (from package.json, Gemfile, build.gradle, requirements.txt, go.mod, etc.)
- Databases (from ORM config, connection strings, migration directories)
- Infrastructure (from Dockerfile, docker-compose.yml, CI config, cloud provider files)
- Major libraries with significant usage patterns (not every dependency — only ones with project-specific conventions)

**Spawn the skill-writer:**
```
subagent_type: shipyard:shipyard-skill-writer
```

Prompt with:
- Technologies: the extracted list from above
- Codebase context path: `$(shipyard-data)/codebase-context.md`
- Project skills path: `.claude/skills/`

The agent runs silently — no user prompts. It scans `.claude/skills/` for existing coverage, skips technologies already covered, generates SME skills for the rest, self-validates all paths and commands, and returns a report.

**Display the results to the user:**
```
Generated [N] project skills:
  /nextjs-expert — Next.js 15 (App Router, server components, middleware)
  /postgres-expert — PostgreSQL (Prisma ORM, migrations, connection pooling)

Skipped (already exist):
  /tailwind-expert

No coverage (insufficient usage):
  Redis — only used as cache in one file
```

### Step 4: Initialize Memory

Write initial project conventions to `$(shipyard-data)/memory/project-context.md` so they persist across sessions and are shared across the team:

```markdown
---
updated: [date]
---
# Project Context

## Tech Stack
[detected languages, frameworks, libraries and versions]

## Testing
[framework, test file locations, run commands]

## Naming Conventions
[file naming, class/function naming patterns found in codebase]

## Key Terminology
[project-specific domain terms and what they mean]
```

**Important:** Write to `$(shipyard-data)/memory/project-context.md`, not to Claude's `~/.claude/` memory system. Claude's memory path embeds the user's local filesystem path (e.g., `-Users-alice-...`), which breaks for other team members and gets misrouted when agents run inside git worktrees. The `$(shipyard-data)/memory/` path is project-relative, user-neutral, and tracked in git.

### Step 5: Self-Test (Doctor)

Run a quick diagnostic to verify the installation works. Check each item silently, report results:

```bash
# 1. Rules installed?
ls .claude/rules/shipyard-*.md 2>/dev/null | wc -l
# Expected: 7

# 2. Templates installed?
ls $(shipyard-data)/templates/*.md 2>/dev/null | wc -l
# Expected: 9

# 3. Config valid?
head -3 $(shipyard-data)/config.md 2>/dev/null | grep -q 'config_version'
# Expected: exit 0

# 4. Git ready?
git rev-parse --git-dir 2>/dev/null && git log -1 --format=%H 2>/dev/null
# Expected: both succeed

# 5. Worktree capability?
git rev-parse --git-common-dir 2>/dev/null
# If differs from --git-dir → project is a worktree, parallel execution unavailable

# 6. Plugin agents reachable?
# Verify agents exist at ${CLAUDE_PLUGIN_ROOT}/agents/shipyard-*.md
ls ${CLAUDE_PLUGIN_ROOT}/agents/shipyard-*.md 2>/dev/null | wc -l
# Expected: 4

# 7. Test commands configured?
grep -q 'unit:' $(shipyard-data)/config.md 2>/dev/null
# Expected: exit 0 (test commands detected)
```

Report:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SELF-TEST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Rules: 7/7 installed
  ✅ Templates: 9/9 installed
  ✅ Config: valid (v3)
  ✅ Git: ready (has commits)
  ✅ Worktree: supported (or: ⚠️ project is a worktree — parallel uses parent repo)
  ✅ Agents: 4/4 reachable
  ✅ Test commands: configured (vitest)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If any check fails, fix it before reporting. For example:
- Scripts are served from the plugin directly (no project copy needed)
- Missing rules → re-copy from plugin's `project-files/rules/`
- No git → run `git init && git add -A && git commit -m "chore: initial commit"`
- No test commands → note in report: "⚠️ Test commands not configured — TDD hooks may not work correctly. Run /ship-init again after setting up your test framework."

### Step 5.5: Configure Permissions

Shipyard skills and agents need specific tool permissions to run without interrupting the user mid-execution. Configure `.claude/settings.local.json` to allow these.

**Read existing `.claude/settings.local.json`** (may not exist). Merge — never replace existing entries.

**Required permissions:**

```json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(shipyard-data)",
      "Bash(ls:*)",
      "Bash(wc:*)",
      "Bash(head:*)",
      "Bash(grep:*)",
      "WebSearch",
      "WebFetch"
    ]
  }
}
```

**Why each entry:**
- `Bash(git:*)` — all git operations (commit, rebase, worktree, branch, log, diff, status, etc.). Used by every implementing skill and the builder agent.
- `Bash(shipyard-data)` — the data path resolver script. Used in every skill's context block.
- `Bash(ls:*)`, `Bash(wc:*)`, `Bash(head:*)`, `Bash(grep:*)` — self-test checks, context loading, file counting. Used throughout init, status, and execution.
- `WebSearch`, `WebFetch` — research during discuss, sprint planning, and builder knowledge gaps.

**Also add test command permissions** if test commands were detected in Step 3 (config.md `test_commands` section). For each detected command prefix, add `Bash(<prefix>:*)`. Common examples:
- `Bash(npx vitest:*)`, `Bash(npm test:*)`, `Bash(pytest:*)`, `Bash(go test:*)`, `Bash(cargo test:*)`

**How to merge:**
1. Read existing `.claude/settings.local.json` (or start with `{}`)
2. Get existing `permissions.allow` array (or `[]`)
3. Add each required entry only if not already present (exact string match)
4. Write back the merged file
5. Do NOT modify any other keys in the file (env, model, etc.)

**Report what was added** (not the full list — just new entries):
```
Permissions: added 6 entries to .claude/settings.local.json
  + Bash(git:*), Bash(shipyard-data), WebSearch, WebFetch, ...
```

If all required entries already exist: "Permissions: already configured ✓"

### Step 6: Report

Tell the user:
```
✓ Shipyard initialized for [project name]
  Project type: [type]
  Tech stack: [stack]
  Testing: [framework]

▶ NEXT UP: Define your first features
  /ship-discuss
  (tip: /clear first for a fresh context window)
```

---

## UPDATE Mode

### Step 1: Preserve State

Read existing config. Do NOT modify:
- `$(shipyard-data)/spec/` (user's spec data)
- `$(shipyard-data)/backlog/` (user's backlog)
- `$(shipyard-data)/sprints/` (sprint history)
- `$(shipyard-data)/memory/` (metrics, retro insights) — **exception:** create `project-context.md` if it doesn't exist (see Step 4c)

### Step 2: Migrate Config

Read the current config's `config_version` (absence = version 1). Compare against the latest template's version.

**If config is outdated:**
1. Read `$(shipyard-data)/templates/config.md` for the latest schema
2. Detect missing fields — compare existing config keys against template keys
3. Backfill missing fields with template defaults, preserving all existing values
4. Update `config_version` to current
5. Report what changed: "Added 3 new config fields: test_commands.scoped, git.delete_merged_branches, staleness.critical_age"

**If spec frontmatter has changed between versions:**
1. Scan `$(shipyard-data)/spec/features/*.md` and `$(shipyard-data)/spec/tasks/*.md`
2. Compare each file's frontmatter against the current template
3. Backfill missing frontmatter fields (e.g., `references: []`, `children: []`) with defaults
4. Report: "Updated frontmatter in 12 feature files (added references, children fields)"

Never remove existing fields — only add missing ones. If a field was renamed between versions, map the old value to the new field name and remove the old one.

**If migrating from v2 (or earlier) to v3:** proceed to Step 2b for data model migration.

### Step 2b: Data Model Migration (v2 → v3)

**Only run if migrating from config_version 2 (or absent) to 3.**

The v3 data model enforces single-source-of-truth: feature files own feature data, task files own task data, aggregate files (BACKLOG.md, SPRINT.md, PROGRESS.md) are lightweight ID indexes. This step migrates old-format files.

**1. BACKLOG.md — multi-column → ID-only**

Check if `$(shipyard-data)/backlog/BACKLOG.md` contains columns beyond `Rank` and `ID` (e.g., `Title`, `RICE`, `Points`, `Status`):
```bash
head -5 $(shipyard-data)/backlog/BACKLOG.md
```
If old format detected:
- Extract the `ID` column values and their rank order
- Rewrite BACKLOG.md using the new template format: `| Rank | ID |` rows + `## Overrides` section
- Data that was in extra columns already exists in feature files — no data loss

**2. SPRINT.md — full task tables → task ID waves**

If `$(shipyard-data)/sprints/current/SPRINT.md` exists and contains task data columns (Title, Effort, Status) beyond just task IDs in wave groups:
- Extract task IDs and their wave assignments
- Rewrite wave sections to contain only task IDs with `<!-- Read task files for details -->` comments
- Preserve all frontmatter (sprint goal, capacity, mode, branch, status)

**3. PROGRESS.md — old format → session log**

If `$(shipyard-data)/sprints/current/PROGRESS.md` exists and contains task completion tracking tables (columns like `Task`, `Status`, `Completed`):
- Task completion status lives in task files now — these tables are redundant
- Rewrite to new format: `## Blockers` table, `## Deviations` table, `## Patch Tasks` table, `## Session Log`
- Preserve any existing blocker or deviation entries

**4. Epic files — remove `features:` arrays**

Scan `$(shipyard-data)/spec/epics/*.md`:
```bash
grep -l "^features:" $(shipyard-data)/spec/epics/*.md 2>/dev/null
```
For each file with a `features:` array in frontmatter:
- Remove the `features:` key and its array values from frontmatter
- Remove any `## Features` table in the body
- Epic membership is now derived from feature `epic:` fields

**5. Feature files — remove inline task tables**

Scan `$(shipyard-data)/spec/features/*.md` for `## Tasks` sections containing markdown tables:
```bash
grep -l "^## Tasks" $(shipyard-data)/spec/features/*.md 2>/dev/null
```
For each file:
- Ensure `tasks:` array exists in frontmatter (extract task IDs from table if needed)
- Remove the `## Tasks` section and its table from the body
- Task data lives in task files referenced by the `tasks:` array

**6. Idea and bug file frontmatter backfill**

Scan `$(shipyard-data)/spec/ideas/*.md` — backfill `story_points: 0` if missing.
Scan `$(shipyard-data)/spec/bugs/*.md` — backfill `hotfix: false` if missing.

**Report migration:**
```
Data model migrated (v2 → v3):
  BACKLOG.md: migrated to ID-only format (was [N] columns)
  SPRINT.md: [migrated / no active sprint / already current]
  PROGRESS.md: [migrated / no active sprint / already current]
  Epics: removed features: arrays from [N] files
  Features: removed inline task tables from [N] files
  Ideas: backfilled story_points in [N] files
  Bugs: backfilled hotfix in [N] files
```

### Step 3: Re-analyze Codebase

Regenerate `$(shipyard-data)/codebase-context.md`:
- Compare with previous version if it exists
- Report delta: "Found 15 new files, 2 new dependencies, 1 new test pattern"

### Step 4: Create Missing Directories and Update .gitignore

Check for any directories in the standard structure that don't exist yet (new versions may add directories like `debug/`, `spec/references/`). Create them silently.

**Update .gitignore** — append any missing entries (same list as fresh install). This is idempotent — skip entries already present. If `.gitignore` does not exist, create it. Specifically ensure `.claude/projects/` is present (added in a recent Shipyard version to prevent user-specific memory paths from being committed).

### Step 4b: Constitution Advisor (if no strong rules exist)

If the project lacks detailed `.claude/rules/` files (beyond Shipyard's own `shipyard-*.md` rules), run the same constitution advisor as fresh install Step 3c. Read `${CLAUDE_PLUGIN_ROOT}/skills/ship-init/references/constitution-advisor.md` for the full process. Only propose — never auto-create on update.

### Step 4c: Create project-context.md if missing

Check if `$(shipyard-data)/memory/project-context.md` exists:
- **If YES** — leave it untouched.
- **If NO** — create it using the fresh install Step 4 template format. Derive content by reading `$(shipyard-data)/codebase-context.md` (written in Step 3) and extracting: tech stack versions and frameworks → `## Tech Stack`, test framework and commands → `## Testing`, detected naming patterns → `## Naming Conventions`, project-specific terms → `## Key Terminology`. Set `updated:` to today's date in frontmatter.

This file was added in a recent Shipyard version. Existing projects won't have it until the first update run.

### Step 5: Validate State

Quick consistency check:
- All features referenced in backlog exist in spec?
- Active sprint references valid tasks?
- No orphaned files?

Report issues if found, suggest `/ship-status` to validate and auto-fix.

### Step 5.5: Update Permissions

Run the same permission configuration as FRESH INSTALL Step 5.5. This ensures new permissions added in plugin updates are backfilled. The same merge-not-replace approach preserves existing user entries and only adds missing required ones.

### Step 6: Report

```
✓ Shipyard updated
  Config migrated: v[old] → v[new] ([N] fields added)
  Codebase re-analyzed: [N] new files, [M] changed patterns
  .gitignore: [N entries added / already up to date]
  project-context.md: [created / already exists]
  State: consistent (or: [N] issues found — run /ship-status to auto-fix)

▶ NEXT UP: Check project status
  /ship-status
  (tip: /clear first for a fresh context window)
```
