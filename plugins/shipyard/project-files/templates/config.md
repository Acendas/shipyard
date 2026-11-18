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
  ready: ""              # a quick command that proves the build can start (seconds, never the suite); run once before the first builder by `shipyard-data build-gate check`. Empty: gradle and maven get their own configure-only call, other tools skip the check.
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
tracker_sync: ask            # ask | auto | off. How tickets in your tracker (Jira, Linear, GitHub …) are kept in step, for every linked epic, story, bug and task, from discussion to release. ask: Shipyard shows what differs and asks before it writes (after a discussion, after sprint planning, after the sprint review). auto: it sends those updates itself and reports them (it still asks before creating a ticket). off: it never proposes tracker changes. Set with: shipyard-data config set tracker-sync <ask|auto|off>
spec:
  behaviour_first: true      # a story is approved from `proposed` only when every scenario has an @AC id and one level tag (@e2e by default; a lower level says why) and `## Paths` names every scenario. false = approve without the check.
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
  # The build gate: a build or test run of the tool named in test_commands / build_commands waits in `shipyard-logcap run` until the machine has room, measured from runs that ran alone (unmeasured: one at a time). `shipyard-data build-gate status` shows it. `build_gate: false` turns it off.
  # build_slots: 2            # your own number of builds at once on this machine; replaces the measurement
  # runner_command: tools/remote-run.sh   # your script that runs a build somewhere else: `<script> --worktree <dir> --job <id> -- <command...>` (output and exit code are the command's; exit 69 = "I could not run it" (never a red test); exit 75 = "still running", for a run longer than about 8 minutes: called again with the same --job, pick it up); `<script> --capacity` prints how many runs it takes at once.
  max_agents: 100             # the most agents (builders, reviewers, researchers, every named helper) alive at the same moment in this project. The agent hook refuses a spawn over it. Change it with `shipyard-data config set-max-agents <n>`. (Replaces the old 3-builder limit, which was only a sentence in a skill.)
  patch_wave_tests: sprint    # sprint | wave. sprint = a wave made only of fix steps skips its own build and test run (each fix step's check already ran, and the sprint's full build and suite cover everything once at the end). wave = build and test after every fix wave.
  probe_must_fail_first: true # a step's acceptance probe must fail on the code as it is today (`shipyard-data sprint probes-at-base`), or the step says why a pass is right. A probe that already passes proves nothing. false = not checked.
  parallel_plan: true         # the plan gate: a story cannot enter a sprint while `shipyard-data sprint plan-score` reports a problem (a step later than its dependencies require, two steps of one wave on the same file, solo mode over a wide wave). false = score only.
  # A wave is as wide as its dependencies allow, up to max_agents. Set max_tasks_per_wave: <n> only to force narrower waves (each extra wave costs a full boundary: build, tests, review, gate).
  isolation: worktree         # worktree | none. worktree = task/track builders each get an isolated git worktree (parallel, branch-integrated). none = run sequentially in-place on the working branch, no worktrees — the deliberate choice for a heavy build where a warm canonical checkout beats parallelism (no-isolation is sequential-only). Override per run with `/ship-execute --isolation true|false`. Set with `shipyard-data config set-isolation <worktree|none>`.
  max_parked_ratio: 0.34      # deferral guard: max fraction of a sprint's tasks that may be parked (blocked/needs-attention) and still allow terminal advance. Above this, terminal-gate refuses unless a `terminal_parked_accepted` event records explicit user acceptance. 1 = disable.
  max_undispositioned_ideas: 12 # deferral guard: once this many UNDISPOSITIONED idea files exist (status not graduated/rejected), /ship-sprint refuses to OPEN a new sprint until you groom via /ship-backlog. Capture is never blocked — `next-id ideas` always allocates and only warns, because a lost finding is worse than an untidy backlog. Escape hatch: `shipyard-data events emit idea_backlog_accepted count=<n>`, valid only while the backlog stays at or under <n>. 0 = disable. (Legacy key `max_ideas_per_sprint` is still read; it never was per-sprint.)
  max_patch_tasks: 5          # deferral guard: floor of the fix-step budget per sprint (mirrors operational_tasks.max_patch_tasks). The budget is the larger of this and patch_steps_per_story × the sprint's stories; `shipyard-data patch-budget` prints it. 0 = disable.
  patch_steps_per_story: 2    # the budget grows with the sprint: story reviews create fix steps by design, so a flat cap ran out on healthy work in a seven-story sprint.
  presumed_dead_minutes: 60   # a claimed builder older than this with no completion and no task_loop_iteration heartbeat in the last 15 minutes is reported (never requeued) on each cursor tick as subagent_presumed_dead. Positive whole number; invalid values fall back to 60 and are reported by `shipyard-data doctor`.
  story_review: true          # v4.1 (F028): review each story (spec review + gap analysis) when its last step merges at the wave boundary, and require a settled verdict per story before the sprint can complete. false = pre-4.1: review only at sprint end.
  assumed_points_per_hour: "" # optional, OFF by default: your own observed points-per-hour, used only to convert a `/ship-sprint --hours`/`--until` time budget while no MEASURED rate exists (one is recorded by archive-sprint from the event log and always wins). Labeled "your assumed rate, not measured" in the planner. Non-numeric or non-positive is ignored and reported by `shipyard-data doctor`.
  max_session_minutes: 0      # optional session wall-clock budget in minutes. 0 (default) = OFF. Opt-in only, e.g. 240; no default number is recommended because real event logs could not justify one. When set and exceeded, the pipeline stops at the next safe boundary instead of mid-task. Negative or non-numeric values are ignored (budget off) and reported by `shipyard-data doctor`.
  require_park_evidence: false # when true, parking an in-progress task (blocked/needs-attention) requires --evidence <capture/return path>, mirroring task accept-return. Opt-in.
  enforce_ac_coverage: true   # when true, sprint-complete invariant 4 hard-fails on an orphan AC (a @AC-<n>-tagged acceptance criterion with no // AC-<n> marker in the sprint diff). Features with NO tagged ACs are always advisory (never false-block a project pre-adoption). Assign ids with `shipyard-data feature assign-ac-ids <FID>`.
  # --- sprint-speed knobs (v3.24.0) ---
  refactor_scope: sprint      # sprint | wave. sprint = ONE REFACTOR+MUTATE pass at the `sprint_refactor` stage, just before the full build/suite that validates it. wave = the pre-3.24 per-wave pass. Per-wave refactoring put N LLM agent dispatches on the critical path between one wave's builders finishing and the next wave's starting, for a stage explicitly declared "not a wave blocker" — and a sprint-wide pass dedupes across waves that narrow passes each miss. Set `wave` when failure attribution on a smaller diff matters more than the saved boundaries.
  dispatch_order: critical_path # critical_path | task_id. critical_path enqueues a wave's tasks longest-effort-first (XL→L→M→S, id tie-break) so the long pole overlaps the short work instead of running alone in the wave's tail. Enforced by `queue enqueue` (claim order == enqueue order), not by prose. Merge order at the wave boundary stays task-id order either way.
  merge_independent_layers: true # keep a mutually-independent dependency layer as ONE wave instead of splitting it into waves that run one after another. Set false only when a smaller merge per wave matters more than the saved boundaries.
  code_review: true           # code review happens in /ship-execute: each story gets spec review, gap analysis AND a code review (security, bugs, silent failures, patterns, tests, observability, data) as soon as its last step merges, findings are fixed in the sprint, and a multi-story sprint gets one cross-story pass before the final suite. /ship-review is then the sprint review (evidence, numbers, decisions, retro, release) and scans nothing. false = the pre-4.6 shape (/ship-review scans and fixes).
  sweep_branches: true        # when a sprint is archived, delete this sprint's Shipyard branches that are already merged and move the rest under refs/shipyard/archive/<sprint>/ (out of `git branch`, never garbage-collected). false = leave shipyard/wt-* and shipyard/keep-* branches in place.
  design_review: true         # a UI story with an approved design is reviewed only after the delivered screen was compared with it: `story-review record` needs --design MATCHES|DIFFERS|UNVERIFIED and a `ui verify --level screen` run on record. false = skip.
  triage_sprint_findings: true # ideas captured during a sprint are triaged before the wave closes (`shipyard-data idea triage`); a defect above low severity is fixed in the sprint by a named patch step. false = skip.
  overlap_waves: true         # dispatch wave N+1 the moment wave N is merged; N's build/tests/spec-verify/per-story review and its fix steps run alongside and land at the next boundary (N+1 rebases onto them). false = the pre-4.4 serial boundary (next wave waits for N's whole gate).
  unattended: true            # /ship-execute runs the sprint to completion without asking: findings are fixed in-sprint (only severity: low may go to the backlog), undecidable calls consult the think tier then park, human probes move to /ship-review Stage 5, and every decision is logged (execute_decision) and shown at review. false = the pre-4.4 pause-and-ask behavior.
  default_capacity: 20        # story points assumed for a sprint before any sprint has been archived (velocity replaces it afterwards). Planning states it; it never asks and never persists it.
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
  # (fable | opus | sonnet | haiku);
  # empty string = omit the model override and inherit the session model.
  # Three speeds (v4.10). Routing sends each step to the lowest tier that fits it and a
  # failed dispatch climbs one rung: light → build → think.
  think: opus                 # hard work: L/XL steps, high or critical risk, research, design deep-dives, critics, spec and code review, consults.
  build: sonnet               # work that needs reasoning: M steps, debugging, fixing a failed command, anything the light tier failed.
  light: haiku                # straightforward work: S steps with an exact spec, command runners, coordinators, quick bounded decisions. Fast. "" = no light tier (everything light runs on the build model, the pre-4.10 behaviour).
  orchestrate: opus           # user-command orchestration shell tier for ship-execute/review/sprint/discuss. Flip anytime with `shipyard-data config set-model orchestrate <model>`; the CLI syncs the command skill frontmatter.
agent_effort:
  # Effort tier per spawned-agent work class. Values are low | medium | high;
  # empty string = omit the effort override and inherit runtime/session default.
  # Flip anytime: `shipyard-data config set-effort <tier> <low|medium|high|inherit>`.
  build: medium               # measured: passed at low, medium and high in the maintainers' effort sweep (3 builder tasks x 2 runs), so medium is a safe default, not a measured need - normal implementation builders and research/spike labor
  build_trivial: low          # measured: the small (effort S) sweep task passed at low - task-loop effort:S builders
  fixer: medium               # not measured (no sweep covered this class) - review fix batches and failure-fix work
  operational: low            # not measured (no sweep covered this class) - build/test/lint command runners
  operational_fix: medium     # not measured (no sweep covered this class) - command-failure diagnosis/fix agents
  think: high                 # not measured (no sweep covered this class) - critics, spec review, gap analysis, sprint analysts, escalation consults
  coordinator: low            # not measured (no sweep covered this class) - flat orchestration helpers that route already-planned work
  simplifier: low             # not measured (no sweep covered this class) - cleanup/simplification passes over known diffs
  decide: low                 # v4.10 - the quick-decision rung of the decision ladder (light tier): which of the written-down options applies
escalation:
  enabled: true               # allow orchestrators to dispatch a models.think consult when stuck
  max_consults_per_sprint: 6  # hard cap on escalation consults per sprint
review:
  code_review: off            # v4.1 (F031): also run Claude Code's built-in `code-review` skill in /ship-review Stage 0 at this level — off | low | medium | high. Its prose findings join the review plan like any scanner's. Shipyard never selects ultra/max (user-triggered, billed) and never passes --fix or --comment.
  workflow: false             # v4.1 (F033): opt-in — run the READ-ONLY review fan-out (Stage 0 scanners, per-story spec/gap review) as a Workflow; the CLI stays the ledger and the regular dispatch is the fallback. Builders never run in workflows.
risk:
  # v4.2 (E004): the business risk profile lives in risk-profile.json, captured lazily by the first
  # /ship-sprint or /ship-review that needs a level (`shipyard-data risk profile add-harm`). Baseline
  # floors apply with or without a profile: auth, secrets, migrations, payments = high; deploy,
  # dependency manifests = medium. `shipyard-data risk score` combines them with the diff by MAX.
  max_critical_per_sprint: 3    # `risk score --cap` refuses (exit 3) once this many critical scores exist in the sprint. 0 = off.
routing:
  rules: true                   # v4.2 (E004): `resolve-model --subject` consults `shipyard-data route` (kind, effort, risk → tier + effort, logged as route_decided). false = static tiers and agent_effort only.
  size_tiers: "S=light,M=build,L=think,XL=think"  # v4.10: tier by step size for feature/bug/fixer/unblocker steps. Risk, the role's floor and a step's own `tier:` pin can only raise it. To keep large steps on the build model: "S=light,M=build,L=build,XL=think".
  quick_decisions: true         # v4.11: the decision ladder's quick rung — `shipyard-data decide` asks the light model (through `claude -p`, forced JSON, effort low, ~4 s, about a tenth of a cent) to choose between written-down options; only a high-confidence answer is taken. false = go straight to the think-tier consult.
  haiku_router: false           # v4.2 (E004): opt-in — `route-intake --haiku` asks a Haiku `claude -p` run to RAISE ambiguity/risk/urgency (never lower). Spends your own quota (~$0.01, ~5 s per consult); only for ambiguity=medium.
ui:
  # v4.3 (E005): render-target adapter for UI stories (`ui: true` in the story). none = every UI
  # stage (render-and-look, design check, visual verification) is skipped with one line.
  adapter: none                 # none | web | frames. web drives Playwright from the PROJECT's install — the plugin downloads nothing. frames runs the project's own renderer (a game harness, a device screenshot tool, a terminal recorder) through frame_command, so a native app's screens diff against the approved design too.
  frame_command: ""             # frames only: a shell command that writes one PNG, with {scene} (what `ui screenshot --url` was given) and {out} (the PNG path). e.g. "make scenario S=tests/scenarios/{scene}.njs >/dev/null && cp $(ls build/runs/{scene}/frames/*.png | tail -1) {out}"  or  "tools/device-shot.sh {scene} {out}"
  base_url: ""                  # e.g. http://localhost:3000 — screenshots and verification resolve relative URLs against it
  playwright_root: ""           # optional: a dir holding node_modules/playwright (or playwright-core) when the project has none
  rule_pack: ""                 # optional: JSON {rules:[{id,status:verified|draft,check,params}]} extending the built-in design lint (verified = error, draft = warning)
  widths: ""                    # optional: screenshot widths, default 375,768,1024
verify_ignore: []             # paths (relative to the project's folder) that cannot change a build or a test result, e.g. [CHANGELOG.md, docs/decisions/]. A commit that touches only these keeps a test proof fresh, so the suite is not run again for it. Leave out anything a test or a check reads. Set with `shipyard-data config set verify-ignore <a,b>`.
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
