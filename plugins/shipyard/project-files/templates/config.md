---
config_version: 5
project_name: ""
project_type: ""
tech_stack: []
testing_framework: ""
e2e_framework: ""
test_commands:
  unit: ""              # e.g., "vitest run", "pytest", "go test ./..."
  integration: ""       # e.g., "vitest run --config vitest.integration.config.ts"
  e2e: ""               # e.g., "playwright test", "cypress run"
  scoped: ""            # runs a subset by changed base/files — must be a complete, runnable
                         # command (with {base}/{files} placeholders where the runner needs an
                         # argument), never a bare flag. Substituted at wave-dispatch time from
                         # the wave's base sha / changed-file list.
                         # e.g., "jest --changedSince={base}", "vitest related {files} --run",
                         # "pytest {files}", "gradle test --tests {files}"
                         # Leave empty to always run the full tier (today's behavior) — an
                         # ecosystem with no native scoped form is never made worse.
  rerun_failed: ""       # re-runs only the tests that failed last iteration, for operational
                         # fix loops — a complete, runnable command, never a bare flag.
                         # e.g., "jest --onlyFailures", "vitest --changed", "pytest --lf",
                         # "gradle test --tests <pattern>", "mvn -Dtest=<pattern> test",
                         # "go test -run '<regex>'", "cargo test <name>", "dotnet test --filter <expr>"
                         # Leave empty if the runner has no failed-only mode — the fix loop
                         # keeps re-running the full command each iteration (today's behavior).
build_commands:
  scoped: ""              # builds a subset by changed base/files — same runnable-command
                           # requirement as test_commands.scoped, with {base}/{files} placeholders.
                           # e.g., "nx affected --target=build --base={base}", "turbo build --filter={files}"
                           # Leave empty to always run the full build (today's behavior).
  full: ""                # e.g., "gradle assemble", "npm run build", "cargo build"
                           # Must NOT embed a test command — Shipyard warns if it detects one,
                           # since the build stage running tests means the test stage re-runs them.
ci_platform: ""
repo_type: single
workflow: sprint
git:
  main_branch: main
  commit_format: conventional
  commit_scope: true
  commit_case: lowercase
  commit_examples: []
wip_limits:
  discuss: 3
  approved: 10
  in_progress: 3
  review: 5
staleness:
  warning_age: 60
  critical_age: 120
operational_tasks:
  max_iterations: 3           # fix-findings loop budget for kind:operational tasks
  max_patch_tasks: 5          # scope-creep guard — escalate if cumulative patch tasks > this
execution:
  max_parallel_agents: 3      # max concurrent builder subagents per wave (1-4, hard ceiling 4)
  max_tasks_per_wave: 6       # max tasks in one wave; wider dependency layers split into consecutive waves along track boundaries (wave COUNT is never capped — it's dependency depth)
  isolation: worktree         # worktree | none. worktree = task/track builders each get an isolated git worktree (parallel, branch-integrated). none = run sequentially in-place on the working branch, no worktrees — the deliberate choice for a heavy build where a warm canonical checkout beats parallelism (no-isolation is sequential-only). Override per run with `/ship-execute --isolation true|false`. Set with `shipyard-data config set-isolation <worktree|none>`.
  max_parked_ratio: 0.34      # deferral guard: max fraction of a sprint's tasks that may be parked (blocked/needs-attention) and still allow terminal advance. Above this, terminal-gate refuses unless a `terminal_parked_accepted` event records explicit user acceptance. 1 = disable.
  max_ideas_per_sprint: 12    # deferral guard: `next-id ideas` refuses once this many UNDISPOSITIONED idea files exist (groom via /ship-backlog first). 0 = disable.
  max_patch_tasks: 5          # deferral guard: cap on cumulative patch tasks per execute/review run before escalation (mirrors operational_tasks.max_patch_tasks, applied to the execute/review deviation paths too). 0 = disable.
  require_park_evidence: false # when true, parking an in-progress task (blocked/needs-attention) requires --evidence <capture/return path>, mirroring task accept-return. Opt-in.
  enforce_ac_coverage: true   # when true, sprint-complete invariant 4 hard-fails on an orphan AC (a @AC-<n>-tagged acceptance criterion with no // AC-<n> marker in the sprint diff). Features with NO tagged ACs are always advisory (never false-block a project pre-adoption). Assign ids with `shipyard-data feature assign-ac-ids <FID>`.
worktree_warm:
  enabled: false        # opt-in; empty paths + disabled = exact current behavior (cold worktrees)
  paths: []             # regenerable build/cache dirs to clone/copy into every new task worktree,
                         # e.g. [".gradle", "build", "target", "dist"] — populated by onboarding
                         # stack detection, user-overridable. Dependency-resolution dirs (node_modules,
                         # .venv, vendor/bundle, deps, ...) are refused by name in code even if listed
                         # here — copying/symlinking them causes false-green tests (probe-confirmed).
shared_caches:
  # Env vars pointing each package manager's GLOBAL DOWNLOAD cache at a stable
  # shared absolute path, materialized into .claude/settings.json `env` by
  # `shipyard-data ensure-shared-caches` (run at ship-execute Step 0). This shares
  # the network-bound download/unpack across worktrees; each worktree still
  # resolves its OWN node_modules/.venv, so the worktree_warm false-green refusal
  # stays intact. NOTE: most ecosystems ALREADY share these by default
  # (~/.npm, ~/.gradle, ~/.cargo, ~/.cache/pip) — this block only helps when a
  # project or sandbox has overridden them to a worktree-local dir. Empty = no-op.
  # Values must be ABSOLUTE paths. Example:
  #   GRADLE_USER_HOME: /Users/you/.gradle
  #   npm_config_cache: /Users/you/.npm
  #   PIP_CACHE_DIR: /Users/you/.cache/pip
  #   CARGO_HOME: /Users/you/.cargo
  #   GOMODCACHE: /Users/you/go/pkg/mod
models:
  # Model tier per work class. Values are Agent-tool model names
  # (fable | opus | sonnet | haiku) or first-party Claude IDs (`claude-*`);
  # empty string = omit the model override and inherit the session model.
  think: opus                 # deep reasoning: critics, spec review, sprint analysts, decomposition deep-dives, escalation consults. Flip anytime: `shipyard-data config set-model think <model>` — the next dispatch picks it up.
  build: sonnet               # labor: builder task loops, operational runs, research sweeps, fixers, simplifiers. Flip anytime with `shipyard-data config set-model build <model>`; high-volume work defaults fast and economical.
  orchestrate: opus           # user-command orchestration shell tier for ship-execute/review/sprint/discuss. Flip anytime with `shipyard-data config set-model orchestrate <model>`; the CLI syncs the command skill frontmatter. Versioned Claude IDs such as `claude-opus-4-8` are accepted.
agent_effort:
  # Effort tier per spawned-agent work class. Values are low | medium | high;
  # empty string = omit the effort override and inherit runtime/session default.
  # Flip anytime: `shipyard-data config set-effort <tier> <low|medium|high|inherit>`.
  build: medium               # normal implementation builders and research/spike labor
  build_trivial: low          # task-loop effort:S builders
  fixer: medium               # review fix batches and failure-fix work
  operational: low            # build/test/lint command runners
  operational_fix: medium     # command-failure diagnosis/fix agents
  think: high                 # critics, spec review, gap analysis, sprint analysts, escalation consults
  coordinator: low            # flat orchestration helpers that route already-planned work
  simplifier: low             # cleanup/simplification passes over known diffs
escalation:
  enabled: true               # allow orchestrators to dispatch a models.think consult when stuck
  max_consults_per_sprint: 6  # hard cap on escalation consults per sprint
quality_gates:
  standing: []              # standing gates applied to every sprint release
  # Examples of standing gates:
  #   - "No TODO/FIXME in sprint diff"
  #   - "Code coverage >= 80% on new code"
  #   - "No console.log in production code"
  # Gate format: free-text description. Each gate becomes a line item in
  # sprints/current/QUALITY-GATE.md. verification_type is auto-inferred:
  #   - References a test_commands key -> probe (uses that command)
  #   - References a specific tool -> tool
  #   - Otherwise -> manual (human checklist item during review)
---

# Project Configuration

This file is generated by `shipyard-data onboarding bootstrap`. Edit directly or use `shipyard-data config ...` commands to update CLI-owned fields.
