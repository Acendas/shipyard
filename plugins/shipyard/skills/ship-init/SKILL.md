---
name: ship-init
description: "Initialize or update a Shipyard project — configure settings, create the directory structure, and analyze the codebase."
allowed-tools: [Read, Write, Edit, Bash, Grep, Glob, Agent, AskUserQuestion, WebSearch, WebFetch]
effort: medium
argument-hint: ""
---

# Shipyard: Initialize / Update Project

You are setting up (or updating) Shipyard for this project.

## Context

!`shipyard-context path`

!`shipyard-context view data-version`
!`shipyard-context view config`
!`shipyard-context project-claude-md`

**Paths.** All file ops use the absolute SHIPYARD_DATA prefix from the context block. No `~`, `$HOME`, or shell variables in `file_path`. **Never use `echo`/`printf`/shell redirects to write state files** — use the Write tool (auto-approved for SHIPYARD_DATA).

## Detect Mode

### Legacy Shipyard Footprint Cleanup

Older Shipyard installs leaked into the user's project: rule files in `.claude/rules/` (loaded into *every* Claude Code session) and permission entries in `.claude/settings.local.json`. Current Shipyard keeps rules in the plugin and treats permissions as opt-in (Step 5.5 below). Offer to clean up any leftover footprint on every `/ship-init`.

**Run before fresh-install / update detection. Two independent checks; either may fire.**

#### Check 1 — Legacy rule files in `.claude/rules/`

Use Glob `.claude/rules/shipyard-*.md`. If zero matches → skip to Check 2. Otherwise:

1. List the matched basenames.
2. AskUserQuestion:

   ```
   Found legacy Shipyard rule files in .claude/rules/. Claude Code loads
   everything there into every session in this project, leaking Shipyard
   discipline into non-Shipyard work. Current Shipyard keeps rules inside
   the plugin so they only load during /ship-* skills.

   Found N legacy rule files:
     [basenames]

   Remove?
     1. Yes — delete (recommended)
     2. Keep — leave in place (they keep loading into every session)
   ```

3. If "Yes", `rm <project>/.claude/rules/<basename>` per file (one Bash call each, no `&&` chaining). Report N files removed.
4. If "Keep", record and do not re-prompt this session.

#### Check 2 — Legacy permission entries in `.claude/settings.local.json`

Read `<project>/.claude/settings.local.json` if it exists. Parse the JSON `permissions.allow` array. Older `/ship-init` versions merged a known set of entries silently; current Shipyard treats those as opt-in (Step 5.5 below) and only with explicit consent.

**Known legacy footprint** (only what older Shipyard itself installed; do not touch the user's other entries):

- Shipyard-specific — `Bash(shipyard-data)`, `Bash(shipyard-data:*)`, `Bash(shipyard-context)`, `Bash(shipyard-context:*)`, `Bash(shipyard-logcap)`, `Bash(shipyard-logcap:*)`. Always safe to remove (only Shipyard skills use them).
- General — `Bash(git:*)`, `Bash(ls:*)`, `Bash(wc:*)`, `Bash(head:*)`, `Bash(grep:*)`, `WebSearch`, `WebFetch`. Shipyard added these but they're useful for everyday work; offer separately so the user can keep them.

Intersect `permissions.allow` with the footprint above. If empty intersection → skip. Otherwise:

1. AskUserQuestion:

   ```
   Found legacy Shipyard-installed permission entries in
   .claude/settings.local.json. Permissions are now opt-in with consent.
   Found:

     Shipyard-specific (safe to remove — only Shipyard skills use them):
       [list]

     General (Shipyard added these but useful for everyday work):
       [list]

   What should I remove?
     1. Shipyard-specific only (recommended — keeps your everyday allowlist)
     2. All of the above (full cleanup)
     3. Show me the file and let me edit manually
     4. Keep everything (decline cleanup)
   ```

2. **If 1 or 2:** Read the JSON file in full, filter `permissions.allow` to drop the chosen entries, Write the full file back. Preserve all other keys and any unrelated allow entries verbatim. Report the count removed.
3. **If 3:** Print the absolute path and the matched entries; do not modify.
4. **If 4:** Record and do not re-prompt this session.

Do NOT auto-edit without consent — permission files may be hand-tuned.

After both checks (or skip), continue to the normal flow below.

---

Check if `<SHIPYARD_DATA>/config.md` exists:
- **If NO** → FRESH INSTALL mode
- **If YES** → QUICK CHECK first, then UPDATE if needed

### Quick Check (fast path for already-initialized projects)

If `<SHIPYARD_DATA>/config.md` exists, run these checks before doing anything else:

1. **Legacy footprint clean?** The legacy cleanup section above runs first regardless. By the time you reach Quick Check, Check 1 (`.claude/rules/shipyard-*.md`) and Check 2 (`.claude/settings.local.json` legacy entries) have already been offered to the user. Nothing to re-check here.
2. **Config version current?** Read `config_version` from `<SHIPYARD_DATA>/config.md` — if matches latest (3), no migration needed
3. **Codebase context exists?** Use the Read tool on `<SHIPYARD_DATA>/codebase-context.md` (substitute the literal SHIPYARD_DATA path) — if it exists, no re-analysis needed

**If ALL checks pass** → report and exit immediately:
```
✓ Shipyard is up to date. Nothing to do.
  Run /ship-status for project overview, or /ship-discuss to start working.
```

**If any check fails** → continue to UPDATE mode to fix what's missing. Report what triggered the update:
```
Shipyard needs updating:
  [✗ config migration needed | ✗ codebase context missing]
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

   These keys double as the resolution target for `kind: operational` tasks — an operational task whose `verify_command: test_commands.e2e` resolves to whatever is under `test_commands.e2e` here. Keeping one source of truth for "how do I run X" means renaming a test runner in one place updates every operational task that references it.

   **`operational_tasks.max_iterations`** (default `3`) and **`operational_tasks.max_patch_tasks`** (default `5`) are the fix-findings loop budget and scope-creep guard for `kind: operational` tasks. See `skills/ship-sprint/references/task-kinds.md` for the full semantics. Override per-task with `verify_max_iterations:` in task frontmatter.

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
<SHIPYARD_DATA>/
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

**Do NOT install rules into the project.** Rules are NOT copied into `.claude/rules/shipyard-*.md` — every project-level `.claude/rules/` file gets loaded into every session's system prompt regardless of whether Shipyard is in use, leaking discipline into non-Shipyard work.

Skills that need a rule `Read` it directly from `${CLAUDE_PLUGIN_ROOT}/project-files/rules/<rule-name>.md` at the moment they need it (or `@`-import in the skill body where supported). Plugin updates ship rule changes automatically; no re-`/ship-init` required. The rules are scoped to active `/ship-*` skill invocations only.

If a project still has `.claude/rules/shipyard-*.md` files from an older install, the legacy cleanup step (earlier in this skill) detects and offers to remove them.

Templates are copied into plugin data by `shipyard-data init` above — no separate shell step. The init command copies everything under `$CLAUDE_PLUGIN_ROOT/project-files/templates/` into `<SHIPYARD_DATA>/templates/` via Node's `cpSync`, which stays inside the allowlisted `shipyard-data` CLI and never prompts for permission on the plugin data dir. Do NOT synthesize a raw template-copy bash line — the plugin data dir lives outside the project root and every such line would trigger a "suspicious path" prompt.

After init, write these via the Write tool (auto-approved for files inside the data dir):
- `<SHIPYARD_DATA>/backlog/BACKLOG.md` from `<SHIPYARD_DATA>/templates/BACKLOG.md`
- `<SHIPYARD_DATA>/config.md` — generate from user answers using template format

**Update .gitignore** — append any missing entries:
```
# Claude Code local memory (machine-specific paths — never commit)
.claude/projects/
# Shipyard task worktrees (temporary, created by builder subagents)
.claude/worktrees/
```

Note: Shipyard data lives in `${CLAUDE_PLUGIN_DATA}` (outside the project), so no `.shipyard/` gitignore entries needed. Worktrees DO live inside the project (`<repo>/.claude/worktrees/<name>`) and must be ignored to keep them out of git status.

### Step 3: Analyze Codebase

Scan the codebase and write findings to `<SHIPYARD_DATA>/codebase-context.md`.

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
2. Record the mapping in `<SHIPYARD_DATA>/codebase-context.md` under a `## Existing Specs` section:
   ```
   ## Existing Specs
   - [path/to/auth-spec.md] — authentication and authorization
   - [path/to/api-design.md] — API endpoint conventions
   - [path/to/data-model.md] — database schema and relationships
   ```
3. Do NOT copy, duplicate, or create feature files from these docs
4. Report: "Indexed [N] spec documents. Shipyard will reference them in-place during /ship-discuss and /ship-sprint."

Shipyard's spec directory (`<SHIPYARD_DATA>/spec/`) holds only the **working set** — features being planned, built, or reviewed. It is NOT a mirror of the entire product. The user's existing docs remain the source of truth for the system as a whole.

**If no spec docs found — note brownfield context:**

If the codebase analysis reveals an existing application with routes, components, APIs, or models — note this in `<SHIPYARD_DATA>/codebase-context.md` under `## Existing Functionality`:
- List discovered routes, API endpoints, components, models
- This gives `/ship-discuss` and `/ship-sprint` context about what already exists

Do NOT create feature specs for existing code. Shipyard's spec is for **new work being planned and built**, not a catalog of existing functionality. The codebase-context.md serves as the reference for what's already there.

If the user wants to formalize existing features later, they use `/ship-discuss [topic]`.

### Step 3c: Constitution Advisor

**Read the full guide:** `${CLAUDE_PLUGIN_ROOT}/skills/ship-init/references/constitution-advisor.md`

Evaluate the project's existing architectural rules across 11 categories: architecture boundaries, code size limits, naming conventions, component patterns, testing patterns, error handling, banned patterns, domain vocabulary, shared patterns, build order, and AI slop mitigation. The slop-mitigation category is not optional — for every project, walk each major area of the codebase (data, UI, API, jobs, tests, infra) and identify the specific failure modes an agent is likely to produce there given the stack, then propose concrete rules that prevent each one.

For each category, classify as COVERED / WEAK / MISSING by checking:
- `.claude/rules/` — existing path-scoped rules (use `ls .claude/rules/` explicitly, hidden dirs are not globbed by default)
- `.claude/skills/` — any custom skills that imply conventions or constraints
- `CLAUDE.md` — project-level instructions
- Linter configs (`.eslintrc`, `pyproject.toml`, `.rubocop.yml`, etc.)
- Existing conventions files (`CONTRIBUTING.md`, `ARCHITECTURE.md`, etc.)
- The codebase itself (actual patterns in use)

For any WEAK or MISSING category:
1. **Analyze the codebase** — measure actual file sizes, detect naming patterns already in use, find import boundaries
2. **Research the stack** — WebSearch for "[framework] [category] best practices", "[framework] production conventions", AND "[framework] common LLM mistakes / hallucinated APIs" to find both what experienced teams enforce and what agents reliably get wrong. Check framework docs for official style guides and recently-removed APIs that models still suggest.
3. **Propose specific rules** — not generic advice, but concrete enforceable rules grounded in the project's actual tech stack and existing patterns. Include a *why* inline so an agent can judge edge cases. For each area, include at least one slop-mitigation rule that names the specific failure mode (e.g., "no fabricated AR scopes — grep for the method on the model before using it", "no `as unknown as T` to silence the type-checker — fix the type or ask")

Present all proposals at once, grouped by category, with rationale for each. Let the user accept all, pick some, or skip entirely. Create accepted rules as `.claude/rules/` files (not prefixed with `shipyard-`).

### Step 3d: Generate SME Skills

After codebase analysis is complete, generate Subject Matter Expert skills for the project's technology stack. These skills encode how THIS project uses each technology — project-specific patterns, paths, commands, and conventions.

**Extract technologies** from the codebase analysis (Step 3):
- Languages and frameworks (from package.json, Gemfile, build.gradle, requirements.txt, go.mod, etc.)
- Databases (from ORM config, connection strings, migration directories)
- Infrastructure (from Dockerfile, docker-compose.yml, CI config, cloud provider files)
- Major libraries with significant usage patterns (not every dependency — only ones with project-specific conventions)

**Dispatch the skill-writer** via `general-purpose` with the inline prompt below. The skill-writer role is reused across `/ship-init` (this site) and `/ship-sprint` (knowledge-gap-driven generation); per S-1's granularity criterion, the prompt stays inline rather than getting its own Layer-2 capability skill — both callers pass the same shape.

Substitute the literal SHIPYARD_DATA path before spawning:

```
Agent(subagent_type: "general-purpose", prompt: |

You are generating project-specific SME (Subject Matter Expert) skills for
this codebase's technology stack. Each skill captures how THIS project uses
the technology — project-specific patterns, paths, commands, and conventions.
Do NOT write generic tutorials.

Technologies: [the extracted list from above]
Codebase context path: <SHIPYARD_DATA>/codebase-context.md
Project skills path: .claude/skills/

Process:
  1. Read the codebase context and skim relevant project files for each
     technology to learn its actual usage in this project.
  2. Scan .claude/skills/ for existing coverage; skip technologies already
     covered by an existing skill.
  3. For each remaining technology, generate a SKILL.md at
     .claude/skills/<tech>-expert/ with project-specific conventions,
     anti-patterns, and gotchas.
  4. Self-validate: every example you write must reference real files,
     real package versions, real commands from this project.

Run silently — do not prompt the user. Return a report listing skills
generated, skills skipped (with reason), and any technologies you couldn't
characterize confidently. No commits.
)
```

The subagent runs silently — no user prompts. It scans `.claude/skills/` for existing coverage, skips technologies already covered, generates SME skills for the rest, self-validates all paths and commands, and returns a report.

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

Write initial project conventions to `<SHIPYARD_DATA>/memory/project-context.md` so they persist across sessions and are shared across the team:

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

**Important:** Write to `<SHIPYARD_DATA>/memory/project-context.md`, not to Claude's `~/.claude/` memory system. Claude's memory path embeds the user's local filesystem path (e.g., `-Users-alice-...`), which breaks for other team members and gets misrouted when agents run inside git worktrees. The `<SHIPYARD_DATA>/memory/` path is project-relative, user-neutral, and tracked in git.

### Step 5: Self-Test (Doctor)

Run a quick diagnostic to verify the installation works. Check each item silently, report results:

Run each check using Claude's native tools (substitute the literal SHIPYARD_DATA path from the context block for `<SHIPYARD_DATA>`):

1. **Plugin rules reachable?** Use Glob `${CLAUDE_PLUGIN_ROOT}/project-files/rules/shipyard-*.md` and count results. Expected: 7. (Rules live in the plugin and are NOT installed into the project's `.claude/rules/`. Skills Read them on demand.)
2. **Legacy rule injection?** Use Glob `.claude/rules/shipyard-*.md`. Expected: 0. If non-zero → legacy cleanup step pending; route the user through it.
3. **Templates installed?** Use Glob `<SHIPYARD_DATA>/templates/*.md` and count results. Expected: 9.
4. **Config valid?** Use Read on `<SHIPYARD_DATA>/config.md` (limit 3) and confirm `config_version` appears. Expected: yes.
5. **Git ready?** Bash: `git rev-parse --git-dir 2>/dev/null && git log -1 --format=%H 2>/dev/null`. Expected: both succeed.
6. **Worktree capability?** Bash: `git rev-parse --git-common-dir 2>/dev/null`. If it differs from `--git-dir`, the project is a worktree and parallel execution falls back to the parent.
7. **Test commands configured?** Use Read on `<SHIPYARD_DATA>/config.md` and confirm a `unit:` field appears under `test_commands`. Expected: yes.

Report:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 SELF-TEST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Plugin rules: 7/7 reachable in plugin
  ✅ Legacy injection: clean (0 .claude/rules/shipyard-*.md)
  ✅ Templates: 9/9 installed
  ✅ Config: valid (v3)
  ✅ Git: ready (has commits)
  ✅ Worktree: supported (or: ⚠️ project is a worktree — parallel uses parent repo)
  ✅ Test commands: configured (vitest)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If any check fails, fix it before reporting. For example:
- Plugin rules unreachable → reinstall the Shipyard plugin (the plugin install is broken)
- Legacy injection found → run the legacy cleanup step (offer to remove `.claude/rules/shipyard-*.md`)
- No git → run `git init && git add -A && git commit -m "chore: initial commit"`
- No test commands → note in report: "⚠️ Test commands not configured. Run /ship-init again after setting up your test framework."

### Step 5.5: Configure Permissions (opt-in)

Shipyard does NOT silently edit `.claude/settings.local.json` — those files belong to the user. Instead, present the permission set and ask explicitly. Use `AskUserQuestion`:

> *"Shipyard skills run a few approved commands during execution. Adding these to `.claude/settings.local.json` makes them auto-allowed (no per-call prompts). Add now?*
> *1. Add — silences ~6 approval prompts per sprint (Recommended)*
> *2. Skip — I'll approve commands case-by-case as Shipyard runs them*
> *3. Show me the list first*"

**If user picks "Show me the list first"**, print the proposed `permissions.allow` entries:

```
Bash(git:*)         — git commands during sprint execution
Bash(shipyard-data) — shipyard-data CLI for atomic state ops
Bash(ls:*), Bash(wc:*), Bash(head:*), Bash(grep:*)
                    — read-only inspection during context loading
WebSearch, WebFetch — research during /ship-discuss + /ship-sprint
```

Plus per-command-prefix entries for any test commands detected in Step 3 (e.g., `Bash(npx vitest:*)`, `Bash(pytest:*)`).

Then re-prompt: Add / Skip.

**If user picks "Add"** (or after the list-first follow-up):
1. Read existing `.claude/settings.local.json` (or start from `{}`).
2. Merge missing entries into `permissions.allow` (exact string match, no duplicates).
3. Write back. Leave all other keys untouched.
4. Report:
   ```
   Permissions: added N entries to .claude/settings.local.json
     + Bash(git:*), Bash(shipyard-data), WebSearch, WebFetch, ...
   ```

**If user picks "Skip"**: do nothing to `.claude/settings.local.json`. Report:
```
Permissions: skipped (you'll see one approval prompt per command at first run).
Re-run /ship-init later if you change your mind.
```

If all required entries already exist when running update mode: report "Permissions: already configured ✓" and skip the prompt.

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
- `<SHIPYARD_DATA>/spec/` (user's spec data)
- `<SHIPYARD_DATA>/backlog/` (user's backlog)
- `<SHIPYARD_DATA>/sprints/` (sprint history)
- `<SHIPYARD_DATA>/memory/` (metrics, retro insights) — **exception:** create `project-context.md` if it doesn't exist (see Step 4c)

### Step 2: Migrate Config

Read the current config's `config_version` (absence = version 1). Compare against the latest template's version.

**If config is outdated:**
1. Read `<SHIPYARD_DATA>/templates/config.md` for the latest schema
2. Detect missing fields — compare existing config keys against template keys
3. Backfill missing fields with template defaults, preserving all existing values
4. Update `config_version` to current
5. Report what changed: "Added 3 new config fields: test_commands.scoped, git.delete_merged_branches, staleness.critical_age"

**If spec frontmatter has changed between versions:**
1. Scan `<SHIPYARD_DATA>/spec/features/*.md` and `<SHIPYARD_DATA>/spec/tasks/*.md`
2. Compare each file's frontmatter against the current template
3. Backfill missing frontmatter fields (e.g., `references: []`, `children: []`) with defaults
4. Report: "Updated frontmatter in 12 feature files (added references, children fields)"

Never remove existing fields — only add missing ones. If a field was renamed between versions, map the old value to the new field name and remove the old one.

**If migrating from v2 (or earlier) to v3:** proceed to Step 2b for data model migration.

### Step 2b: Data Model Migration (v2 → v3)

**Only run if migrating from config_version 2 (or absent) to 3.**

The v3 data model enforces single-source-of-truth: feature files own feature data, task files own task data, aggregate files (BACKLOG.md, SPRINT.md, PROGRESS.md) are lightweight ID indexes. This step migrates old-format files.

**1. BACKLOG.md — multi-column → ID-only**

Use the Read tool on `<SHIPYARD_DATA>/backlog/BACKLOG.md` (limit 5) and check if it contains columns beyond `Rank` and `ID` (e.g., `Title`, `RICE`, `Points`, `Status`):
If old format detected:
- Extract the `ID` column values and their rank order
- Rewrite BACKLOG.md using the new template format: `| Rank | ID |` rows + `## Overrides` section
- Data that was in extra columns already exists in feature files — no data loss

**2. SPRINT.md — full task tables → task ID waves**

If `<SHIPYARD_DATA>/sprints/current/SPRINT.md` exists and contains task data columns (Title, Effort, Status) beyond just task IDs in wave groups:
- Extract task IDs and their wave assignments
- Rewrite wave sections to contain only task IDs with `<!-- Read task files for details -->` comments
- Preserve all frontmatter (sprint goal, capacity, mode, branch, status)

**3. PROGRESS.md — old format → session log**

If `<SHIPYARD_DATA>/sprints/current/PROGRESS.md` exists and contains task completion tracking tables (columns like `Task`, `Status`, `Completed`):
- Task completion status lives in task files now — these tables are redundant
- Rewrite to new format: `## Blockers` table, `## Deviations` table, `## Patch Tasks` table, `## Session Log`
- Preserve any existing blocker or deviation entries

**4. Epic files — remove `features:` arrays**

Use Grep with `pattern: ^features:`, `path: <SHIPYARD_DATA>/spec/epics`, `glob: E*.md`, `output_mode: files_with_matches` to find epics with `features:` arrays. For each match:
- Remove the `features:` key and its array values from frontmatter
- Remove any `## Features` table in the body
- Epic membership is now derived from feature `epic:` fields

**5. Feature files — remove inline task tables**

Use Grep with `pattern: ^## Tasks`, `path: <SHIPYARD_DATA>/spec/features`, `glob: F*.md`, `output_mode: files_with_matches` to find feature files with inline task tables. For each match:
- Ensure `tasks:` array exists in frontmatter (extract task IDs from table if needed)
- Remove the `## Tasks` section and its table from the body
- Task data lives in task files referenced by the `tasks:` array

**6. Idea and bug file frontmatter backfill**

Scan `<SHIPYARD_DATA>/spec/ideas/*.md` — backfill `story_points: 0` if missing.
Scan `<SHIPYARD_DATA>/spec/bugs/*.md` — backfill `hotfix: false` if missing.

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

Regenerate `<SHIPYARD_DATA>/codebase-context.md`:
- Compare with previous version if it exists
- Report delta: "Found 15 new files, 2 new dependencies, 1 new test pattern"

### Step 4: Create Missing Directories and Update .gitignore

Check for any directories in the standard structure that don't exist yet (new versions may add directories like `debug/`, `spec/references/`). Create them silently.

**Update .gitignore** — append any missing entries (same list as fresh install). This is idempotent — skip entries already present. If `.gitignore` does not exist, create it. Specifically ensure both `.claude/projects/` (machine-specific Claude memory) and `.claude/worktrees/` (Shipyard task worktrees) are present. Both were added in recent Shipyard versions.

### Step 4b: Constitution Advisor (if no strong rules exist)

If the project lacks detailed `.claude/rules/` files (beyond Shipyard's own `shipyard-*.md` rules), run the same constitution advisor as fresh install Step 3c. Read `${CLAUDE_PLUGIN_ROOT}/skills/ship-init/references/constitution-advisor.md` for the full process. Only propose — never auto-create on update.

### Step 4c: Create project-context.md if missing

Check if `<SHIPYARD_DATA>/memory/project-context.md` exists:
- **If YES** — leave it untouched.
- **If NO** — create it using the fresh install Step 4 template format. Derive content by reading `<SHIPYARD_DATA>/codebase-context.md` (written in Step 3) and extracting: tech stack versions and frameworks → `## Tech Stack`, test framework and commands → `## Testing`, detected naming patterns → `## Naming Conventions`, project-specific terms → `## Key Terminology`. Set `updated:` to today's date in frontmatter.

This file was added in a recent Shipyard version. Existing projects won't have it until the first update run.

### Step 5: Validate State

Quick consistency check:
- All features referenced in backlog exist in spec?
- Active sprint references valid tasks?
- No orphaned files?

Report issues if found, suggest `/ship-status` to validate and auto-fix.

### Step 5.5: Update Permissions (opt-in)

Run the same opt-in permission flow as FRESH INSTALL Step 5.5: detect missing entries, present them via AskUserQuestion (Add / Skip / Show list), merge only with explicit consent. The same merge-not-replace logic applies — existing user entries are never touched, only new required ones are proposed for addition.

If the existing `.claude/settings.local.json` already has all entries Shipyard needs, skip the prompt and report "Permissions: already configured ✓".

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
