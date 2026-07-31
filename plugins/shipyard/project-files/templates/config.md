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
worktree_warm:
  enabled: false        # opt-in; empty paths + disabled = exact current behavior (cold worktrees)
  paths: []             # regenerable build/cache dirs to clone/copy into every new task worktree,
                         # e.g. [".gradle", "build", "target", "dist"] — populated by onboarding
                         # stack detection, user-overridable. Dependency-resolution dirs (node_modules,
                         # .venv, vendor/bundle, deps, ...) are refused by name in code even if listed
                         # here — copying/symlinking them causes false-green tests (probe-confirmed).
models:
  # Model tier per work class. Values are Agent-tool model names
  # (fable | opus | sonnet | haiku) or first-party Claude IDs (`claude-*`);
  # empty string = omit the model override and inherit the session model.
  think: opus                 # deep reasoning: critics, spec review, sprint analysts, decomposition deep-dives, escalation consults. Flip anytime: `shipyard-data config set-model think <model>` — the next dispatch picks it up.
  build: sonnet               # labor: builder task loops, operational runs, research sweeps, fixers, simplifiers. Flip anytime with `shipyard-data config set-model build <model>`; high-volume work defaults fast and economical.
  orchestrate: sonnet         # ship-execute shell tier. Set by the skill's frontmatter model: — this value is informational (must match it). Editing here does NOT change the shell; edit skills/ship-execute/SKILL.md frontmatter.
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
