# Shipyard 2.0 — Action Items

Consolidated from all conversations on 2026-05-08. Theme: **lean, clean, reliable**.

Constraints:
- Per-project hashing kept (just make it reliable).
- Skills-md-driven; `.mjs` scripts only where genuinely necessary.
- Hooks minimized.
- Ralph-loop-grade reliability — but **without** bloating the user session context.
- Claude Code standard compliant; lean on recent worktree/agent-teams fixes (changelog through May 2026).
- Avoid over-engineering. When found, log it.

## Section index

- [Cross-cutting principles](#cross-cutting)
- [The Ralph-without-bloat design](#ralph-design)
- [File-by-file findings](#file-by-file)
- [Sprint sequence](#sequence)
- [Risks / open questions](#risks)

---

<a id="cross-cutting"></a>
## Cross-cutting principles (apply everywhere)

### CC-1. Zero registered agents
**Why:** Customer report — `shipyard-builder` was auto-dispatched in a non-Shipyard session. Root cause: 14 agents register globally; descriptions read like generic helpers.
**Action:** Delete `plugins/shipyard/agents/*.md`. Convert each agent body into a prompt template inside the owning skill (e.g., `skills/ship-execute/references/builder-prompt.md`). Dispatch via `subagent_type: general-purpose` with the loaded template. Pattern lifted from superpowers' `subagent-driven-development`.
**Footprint:** removes 14 globally-claimable agents.

### CC-2. Three hooks, not nine
**Why:** Customer report — Shipyard hooks fire on every Edit/Bash/Agent in any session in any project that ever ran `/ship-init`. Particularly egregious: `agent-heartbeat` on empty matcher = Node spawn after every tool call.
**Action:** Cut hooks to:
- `SessionStart` — bootstrap (mirrors superpowers).
- `PreToolUse` Edit|Write — `auto-approve-data` **only**, path-gated to `<SHIPYARD_DATA>` (bail O(1) if target isn't ours).
- `WorktreeCreate` — already correctly scoped; keep.

Drop everything else. Their behavior moves into skill prose (Iron-Law verification, TDD self-check, etc.) or skill-internal Read calls.

### CC-3. Zero project injection from `/ship-init`
**Why:** `.claude/rules/shipyard-*.md` (7 files) load into every session in the project — bleeds Shipyard rules into non-Shipyard work.
**Action:** Stop copying rules into `.claude/rules/`. Skills `Read` from `${CLAUDE_PLUGIN_ROOT}/project-files/rules/` on demand (or `@`-import inside skill body). `/ship-init` becomes: create `<SHIPYARD_DATA>`, write `config.md`, optionally add `.claude/worktrees/` to `.gitignore`. Permission/settings edits become opt-in with explicit reasoning.

### CC-4. Iron-Law reliability, not enforcement scaffolding
**Why:** Builder self-certifies done; reviewer reads code not runtime; tests pass against stubs. False completion leaks through. Ralph-loop and superpowers solve this without scanners — through Iron-Law prose ("NO CLAIMS WITHOUT EVIDENCE").
**Action:** Port `verification-before-completion` (superpowers) + the TDD Iron Law into Shipyard. Add a small anti-stub scanner as second-line defense, not first.

### CC-5. Reliability via fresh-context loop, not user-session loop
**Why:** Ralph Loop's reliability comes from refusing to exit until the completion promise is true. But it loops INSIDE the user session — each iteration accumulates context until compaction or exhaustion. Bloat is unavoidable.
**Action:** See [Ralph-without-bloat](#ralph-design) below.

### CC-6. Trust `CLAUDE_PLUGIN_DATA`; drop legacy fallbacks
**Why:** Shipyard's resolver has a 3-step fallback chain (`CLAUDE_PLUGIN_DATA` → `<plugin-root>/../../data/` → `~/.claude/plugins/data/...`) plus orphan recovery. Anthropic now ships `CLAUDE_PLUGIN_DATA` officially. The legacy chain is speculative — costs reliability and complexity.
**Action:** Trust `CLAUDE_PLUGIN_DATA`. Fail loud if missing. Drop the two fallback branches in `shipyard-resolver.mjs`. Drop orphan-find one release cycle after.

### CC-7. Session-ID stamped state files (Ralph pattern)
**Why:** Ralph Loop's Stop hook stamps Claude Code's `session_id` into the state file; if a different session's hook fires, it exits 0 (no false-block). Shipyard's `.active-execution.json` mutex doesn't do this — works only by timestamp + global lock.
**Action:** Embed `session_id` (from hook input or `CLAUDE_SESSION_ID` env) into every active-* state file. Hooks and skill re-entry checks compare. Solves "two terminals, one repo" cleanly.

### CC-8. Use Claude Code's worktree primitives directly
**Why:** Shipyard worked around `isolation: worktree` brokenness with manual worktree creation + cd-prefixing. Anthropic fixed `isolation: worktree` (changelog: stale-reuse fix, Read/Edit denial fix, cwd-leak fix, plus `WorktreeCreate` hook + `worktree.baseRef` setting + `workspace.git_worktree` status-line var).
**Action:** Re-evaluate every worktree workaround in `ship-execute` and `references/git-strategy.md`. Most should collapse to `isolation: worktree` + `WorktreeCreate` hook. See file-by-file section.

### CC-9. Native TaskCreate/TaskUpdate over custom task tracking
**Why:** Claude Code now has first-class `TaskCreate` / `TaskUpdate` / `TaskCompleted` hooks (and `TeammateIdle`/`TaskCreated`/`TaskCompleted` for Agent Teams). Shipyard rolled its own task-state machine in skill bodies before these existed.
**Action:** Audit where ship-execute manages task state by file IO; replace with native task tools where feasible. State files only for things that genuinely need to survive `/clear` (sprint identity, wave index, lock).

---

<a id="ralph-design"></a>
## The Ralph-without-bloat design

**The problem:** Ralph Loop's reliability is structural — agent can't escape until completion-promise is true. But every iteration runs in the same conversation, accumulating false attempts, reasoning, and tool output until the user session is choked.

**The fix:** Move the loop into a **fresh-context subagent invocation per task**, with the user session holding only a **summary handoff**, not the iteration trace.

### Architecture

```
┌─ User session (orchestrator) ──────────────────────────────────┐
│ /ship-execute reads sprint plan                                │
│   for each task in wave:                                       │
│     dispatch general-purpose subagent with:                    │
│       - task spec (full text inlined)                          │
│       - Iron-Law skills (TDD + verification) inlined in prompt │
│       - acceptance probe command                               │
│       - "loop until probe passes; do not exit otherwise"       │
│     subagent runs the loop in ITS OWN context                  │
│     subagent returns: { status, commit_sha, probe_output_tail }│
│   orchestrator reads return, marks task done, moves to next    │
└────────────────────────────────────────────────────────────────┘
```

The subagent's context absorbs the loop — false attempts, reflection, retries, all of it. When it returns, only the summary lands in the orchestrator. Orchestrator's context grows by ~200 tokens per task instead of ~10,000.

### Why this is better than Ralph's Stop-hook loop

| Property | Ralph (Stop hook) | Ralph-in-subagent |
|---|---|---|
| Reliability gate | Completion promise must be true to exit | Same — subagent prompt enforces probe pass before return |
| Context bloat | Accumulates in user session | Discarded with subagent context |
| Concurrency | One loop per session | N parallel loops via parallel `Agent()` calls |
| User can interrupt | Yes (Esc) | Yes (Esc on parent) |
| Survives `/clear` | State file | State file (same) |
| Implementation | Stop-hook script | Skill prose + general-purpose dispatch |

### The subagent's exit contract

The subagent is told:

> **You may not return until you have run the acceptance probe and observed exit 0 with output that demonstrates the wiring works end-to-end.**
>
> If the probe fails: reflect, fix, re-run. No completion claim until the probe passes.
>
> When you return, your reply MUST include:
> - `STATUS: COMPLETE` (literal — anything else is treated as failure)
> - `COMMIT: <sha>`
> - `PROBE_OUTPUT_TAIL:` followed by the last 20 lines of probe output, verbatim.
>
> If you cannot complete (genuinely blocked, not "I think it's done"), reply:
> - `STATUS: BLOCKED`
> - `REASON: <one-paragraph why>`
>
> Any other response shape is a violation.

The orchestrator parses the reply. If `STATUS: COMPLETE` and `PROBE_OUTPUT_TAIL` is present and the commit exists in git, mark done. Anything else: surface to user, do not advance.

This is Ralph's Iron Law applied at the subagent boundary, not the session boundary.

### Action items for Ralph-design

- [x] **R-1.** Define the subagent prompt template at `skills/ship-execute/references/task-loop-prompt.md`. Include the Iron-Law verification skill inline and the acceptance probe contract above. *(Path moved to `skills/dispatching-task-loop/SKILL.md` per S-1 capability-skill architecture; supersedes the original location.)*
- [~] **R-2.** `ship-execute` skill body: per-task dispatch via `general-purpose` agent type with the template. Parse the structured return. *(Template + parsing contract defined in `dispatching-task-loop`. ship-execute wiring is Sprint 4 work — F-37.)*
- [~] **R-3.** Acceptance probe field added to task spec template (`project-files/templates/task.md`). `/ship-sprint` planning step authors probes alongside ACs (Opus is doing that work anyway). *(Authoring contract defined in `authoring-acceptance-probe`. Template field add is F-32; `/ship-sprint` wiring is F-33.)*
- [x] **R-4.** No registered builder agent. The "builder" exists only as the prompt template loaded from inside the skill. *(Realized in `dispatching-task-loop`: dispatch via `general-purpose`; no `subagent_type` references a registered Shipyard agent.)*
- [x] **R-5.** Anti-stub scanner: small, run after the subagent returns, second-line defense. If it flags something, the orchestrator re-dispatches the subagent with the finding. *(Realized as `skills/anti-stub-scan/`. HIGH/MEDIUM/LOW confidence levels, `shipyard:placeholder reason=` opt-out marker, single-redispatch rule.)*

---

<a id="file-by-file"></a>
## File-by-file investigation

Tree summary:

- `plugins/shipyard/.claude-plugin/plugin.json` — manifest
- `plugins/shipyard/hooks/hooks.json` — 9 hook configurations
- `plugins/shipyard/bin/hooks/*.mjs` — 12 hook entry-point modules
- `plugins/shipyard/bin/*.mjs` — 4 CLIs + resolver = 6 files, **3,820 lines**
- `plugins/shipyard/agents/*.md` — 14 registered agents = **1,886 lines**
- `plugins/shipyard/project-files/rules/*.md` — 7 rules (563 lines, copied into `.claude/rules/` on init)
- `plugins/shipyard/project-files/templates/*.md` — 9 templates (270 lines)
- `plugins/shipyard/skills/*/SKILL.md` — 12 skills, **5,377 lines**
- Skill references — 26 reference files across discuss/execute/sprint/etc.

**Headline numbers worth fixing:** `bin/shipyard-data.mjs` (1,187 lines), `bin/shipyard-logcap.mjs` (1,146 lines), `skills/ship-sprint/SKILL.md` (844 lines), `skills/ship-discuss/SKILL.md` (792 lines), `skills/ship-execute/SKILL.md` (777 lines).

---

### `.claude-plugin/plugin.json`

Currently 31 lines, version `1.12.0`. Clean but missing useful metadata.

- [ ] **F-1.** Bump to `2.0.0` when this batch lands — it's a breaking change for anyone with `.claude/rules/shipyard-*.md` injected. Add a `breaking_changes` note in release notes about the new "skill-active footprint" model.
- [ ] **F-2.** Consider adding `"settings"` block (Claude Code now supports plugin-default settings via `settings.json` at plugin root) for any user-tunable defaults — but only after first thinking whether they belong in `<SHIPYARD_DATA>/config.md` instead. Today nothing belongs here.

---

### `hooks/hooks.json` + `bin/hooks/*.mjs`

Today: 9 hook configurations, all imported through `hook-runner.mjs` → 12 hook modules. **2,025 lines** total across hook handlers. Most fire on every tool call in any session in any Shipyard-initialized project.

Per-hook verdict (delete unless noted):

| Hook | Lines | Trigger | Verdict |
|---|---|---|---|
| `plugin-data-breadcrumb` | 45 | SessionStart | **Keep**, but verify it still has a job after [CC-6](#cross-cutting). The breadcrumb works around `CLAUDE_PLUGIN_DATA` not being exported to skill backtick subprocesses. If we drop `shipyard-context view *` (planned), the breadcrumb may have no consumer. |
| `auto-approve-data` | 129 | PreToolUse Edit\|Write\|MultiEdit\|NotebookEdit | **Keep**, but **path-gate at the top**: bail O(1) unless path is inside `<SHIPYARD_DATA>`. Today it does this work, but does it AFTER resolving SHIPYARD_DATA — no early exit. |
| `tdd-check` | 268 | PreToolUse Bash | **Delete**. Replace with Iron-Law TDD skill prose. Per CC-2/CC-4 — enforcement at the prompt level beats hook-level pre-test gating, and a Bash-tool hook firing on every command is exactly the customer pain. |
| `block-bash-state-write` | 104 | PreToolUse Bash | **Delete**. Skills already say "use Write tool, not Bash redirect for state files." If a skill violates the rule, the hook is mopping up after a bug; better to fix the skill. |
| `session-guard` | 227 | PreToolUse Edit\|Write\|… | **Delete**. Its job (block edits when `.active-session.json` is mismatched) becomes a skill-entry check (skills already do this — see ship-execute lines 28–80). Hook duplicates the work. |
| `loop-detect` | 93 | PostToolUse Edit\|Write\|MultiEdit | **Delete or downgrade**. Today fires on every Edit. Tracking "file edited 5+ times without commit" is a legitimate signal but a hook running on every edit is overkill. Move into skill-side check at task boundary. |
| `on-commit` | 220 | PostToolUse Bash | **Delete**. Captures struggle metrics + prompts for learnings. Move into the post-task gate inside `ship-execute` skill. Bash hook on every command for this is heavy. |
| `cwd-restore` | 78 | PostToolUse Agent | **Delete**. Existed because of subagent worktree cwd-leak bug. **That bug is fixed upstream** (changelog: "Fixed subagents with worktree isolation or `cwd:` override leaking their working directory back to the parent session's Bash tool"). Hook is now dead weight. |
| `agent-heartbeat` | 82 | PostToolUse `""` (matcher empty = ALL tools) | **Delete (highest priority)**. Empty matcher = Node spawn after every tool call. Solo mode skipped, only worktree-CWDs trigger writes — but the hook *runs* on every call to *check*. Replace with skill-side periodic write at task boundaries inside the builder prompt. |
| `subagent-stop` | 198 | SubagentStop | **Delete**. Job: block subagent exit if uncommitted changes. Replace with the explicit return contract in the new task-loop prompt template (CC-5/R-2): subagent must echo `STATUS: COMPLETE + COMMIT: <sha>` — orchestrator checks. |
| `post-compact` | 209 | PostCompact | **Delete**. Job: increment `compaction_count` on the lock so `ship-execute` can auto-pause at count ≥ 5. Replace with skill-side "after compact, read+increment counter" pattern, gated by a single PostCompact hook *only* if no skill alternative works. With Opus 1M, compaction pressure is rarely the issue. |
| `worktree-branch` | 152 | WorktreeCreate | **Keep**. WorktreeCreate is the right primitive — Anthropic added the hook event specifically. This hook gives Shipyard worktrees the `shipyard/wt-*` branch naming convention. Worth keeping. |

**Net hooks after change: 3** (`plugin-data-breadcrumb`, `auto-approve-data`, `worktree-branch`). Down from 12 modules / 9 configurations.

- [ ] **F-3.** Delete `agent-heartbeat`, `cwd-restore`, `subagent-stop`, `tdd-check`, `block-bash-state-write`, `session-guard`, `on-commit`, `loop-detect`, `post-compact`. (Move legitimate behaviors into skills.)
- [ ] **F-4.** Path-gate `auto-approve-data` at top of `run()` — return 0 immediately if target path doesn't start with the resolved data dir.
- [ ] **F-5.** Audit `plugin-data-breadcrumb` — once `shipyard-context view *` is gone (CLI removal item below), check whether anything still depends on the breadcrumb. If not, delete it; rely on `CLAUDE_PLUGIN_DATA` env var directly.
- [ ] **F-6.** Add `hook_skipped_inactive` and `hook_path_outside_data` event emission to `auto-approve-data` so we can audit silent-skip behavior in production.

---

### `bin/shipyard-resolver.mjs` (326 lines)

Three responsibilities today:
1. Project root resolution (worktree-aware: builder-vs-user split).
2. SHA-256 12-char hash.
3. Data dir discovery via 4-step fallback chain (`CLAUDE_PLUGIN_DATA` env → `<plugin-root>/../../data/shipyard` → legacy `~/.claude/plugins/data/shipyard` → tmpdir breadcrumb).

The 4-step chain exists because `CLAUDE_PLUGIN_DATA` wasn't always exported to skill backtick subprocesses. Today (May 2026), Claude Code reliably exports it to hooks/MCP/LSP and increasingly to skill subprocesses.

- [ ] **F-7.** Drop the 4-step chain to 2 steps: `CLAUDE_PLUGIN_DATA` env → fail loud. Drop the `<plugin-root>/../../data/shipyard` probe (speculative; never observed in production), the legacy `~/.claude/plugins/data/...` probe (orphans should be migrated, not silently picked up), and the tmpdir breadcrumb (only matters if env var is missing — let it fail loud and the user upgrades Claude Code).
- [ ] **F-8.** Keep the worktree builder-vs-user split — that's load-bearing and well-documented (D1 in DECISIONS). Don't "simplify" it; the comment block explaining why exists for a reason.
- [ ] **F-9.** Keep the `silent` opt for in-process callers — also load-bearing (hook-runner can't `process.exit`).
- [ ] **F-10.** Once F-7 lands, the resolver can drop from 326 lines to ~150. Acceptable size for genuine plumbing.
- [ ] **F-11. Over-engineering flag:** the Windows multi-drive special case (lines 232–248) is real but adds ~16 lines of branching for a corner case. Worth keeping (Windows is a first-class target per dev rules) — but mark it for a real Windows-multi-drive integration test if one doesn't exist.

---

### `bin/shipyard-data.mjs` (1,187 lines, 11 subcommands)

Subcommands: `init`, `migrate`, `with-lock`, `find-orphans`, `archive-sprint`, `drop-orphan`, `reap-obsolete`, `events` (with sub-subs `tail|grep|since|json|emit`), `project-id`, `next-id`, plus a default no-arg help.

Each is plumbing that could mostly be skill-side Read/Write — except for things that need atomicity/locking.

- [ ] **F-12.** Keep these (genuinely need a CLI):
  - `migrate` — atomic tree creation, copy, rename, transient-state cleanup. Eval-protected against being expanded back to bash sequences. ~100 lines.
  - `with-lock` — file locking primitive. ~120 lines.
  - `init` — atomic directory tree creation + template copy via `cpSync`. Could be inlined as a skill multi-Write but `cpSync` for templates is genuinely simpler. ~60 lines.

- [ ] **F-13. Retire these to skill bodies:**
  - `events emit` / `events tail|grep|since|json` — the JSONL log can be appended via Write tool (with-lock for atomicity). Reading it is a Read + filter in the skill. **820 lines worth retiring** (the events code is the largest single chunk).
  - `next-id` — getting the next free ID is "Glob the dir, parse names, increment". Skill-side Read+Glob is fine. ~100 lines.
  - `project-id` — wraps the resolver. Just call the resolver directly via `node -e` or context block. ~10 lines.
  - `archive-sprint` — file moves; could be skill-side Bash `mv`. **But:** keep if reliability matters more than line count. Decide after looking at real usage.
  - `find-orphans` — only matters if hash semantics changed. After CC-6 sequencing, this dies in one release cycle.
  - `drop-orphan` — same; dies with `find-orphans`.
  - `reap-obsolete` — sweeps obsolete sprints. Skill-side or weekly cron, not load-bearing.

- [ ] **F-14.** Net: `shipyard-data.mjs` should drop from 1,187 lines to ~300 lines covering `init`, `migrate`, `with-lock`. Plus a deprecation window for `events emit` (skills migrate first, then it's deletable).

- [ ] **F-15. Over-engineering flag:** `events.jsonl` is the cross-cutting structured event log Anthropic plugin authors usually skip. It's diagnostic gold but only when something breaks. Move to a single-file skill helper (skill calls `Write` with append flag through `with-lock`) — no separate CLI surface needed.

---

### `bin/shipyard-context.mjs` (563 lines)

Subcommands inferred from grep: `path`, `view`, `legacy-check`, `project-claude-md`, `diagnose`. Used in skill `!`-prefixed bash blocks to inject context into skill prompts.

- [ ] **F-16.** Retire most of this. Skill bodies can `Read` the same files directly using paths derived from the resolver. The patterns:
  - `shipyard-context path` → skill body says: `<SHIPYARD_DATA path computed from CLAUDE_PLUGIN_DATA>`. Plus the resolver CLI for the rare case.
  - `shipyard-context view config` → `Read <SHIPYARD_DATA>/config.md`.
  - `shipyard-context view sprint 80` → `Read <SHIPYARD_DATA>/sprints/current/SPRINT.md` (head 80 lines).
  - `shipyard-context view sprint-progress` → `Read <SHIPYARD_DATA>/sprints/current/PROGRESS.md`.
  - `shipyard-context view codebase` → `Read <SHIPYARD_DATA>/codebase-context.md`.
  - `shipyard-context view data-version` → `Read <SHIPYARD_DATA>/config.md` and look at frontmatter.
  - `shipyard-context legacy-check` → `Glob .shipyard/config.md`.
  - `shipyard-context project-claude-md` → `Read CLAUDE.md`.
- [ ] **F-17. Keep `diagnose`** — it's the customer support endpoint. Dumps env, resolver output, breadcrumb tail, event log tail. ~100 lines worth keeping, possibly renamed to `shipyard-doctor`.
- [ ] **F-18.** Delete `view`, `path`, `legacy-check`, `project-claude-md` subcommands. Net: `shipyard-context.mjs` → ~150 lines (just `diagnose`), or merged into `shipyard-data.mjs` as `shipyard-data doctor`.

---

### `bin/shipyard-logcap.mjs` (1,146 lines)

Massive module for capturing command output to rotating temp files with per-session grouping. Used by builder agents to capture test output verbatim for the orchestrator to read back.

- [ ] **F-19. Major over-engineering flag.** 1,146 lines for "tee command output to a file" is too much. The features inside:
  - Rotating logs (max-files, max-size)
  - Per-session directory grouping (sentinel file → env var → per-day fallback)
  - List/path/probe/prune subcommands
  - Cross-platform (POSIX + Windows .cmd shim)
- [ ] **F-20.** Replace 80% of this with the new task-loop subagent return contract (CC-5). The builder no longer captures output to a separate file — it captures the last 20 lines of probe output as `PROBE_OUTPUT_TAIL:` in its return message. The orchestrator parses that.

  When verbatim full output is needed (debugging, retrospectives), use `tee` directly: `command | tee /tmp/shipyard/<session>/<name>.log`. Cross-platform `tee` exists on Windows in PowerShell as `Tee-Object`; for cmd.exe a tiny `.cmd` shim is acceptable.

- [ ] **F-21.** If we still need `shipyard-logcap` after the loop refactor, target ≤300 lines: rotation + path resolution + run subcommand. Drop `list`, `path`, `probe`, `prune` from CLI surface — make them skill-side `Read` + `ls` patterns.
- [ ] **F-22.** **Don't keep the session-sentinel file mechanism** in its current form. The `<SHIPYARD_DATA>/.active-logcap-session` file is the same kind of state-as-side-channel that bites you with cross-session/cross-terminal races. Pass session names as CLI args to `shipyard-logcap run --session <name> -- <cmd>` instead. Explicit beats implicit.

---

### `bin/_hook_lib.mjs` (484 lines) + `bin/hook-runner.mjs` (114 lines)

Shared primitives: atomic write, sanitization, resolver wrapper, event log helper.

- [ ] **F-23.** Once half the hooks die (F-3), most of `_hook_lib.mjs` will be unused. Trim accordingly.
- [ ] **F-24.** `hook-runner.mjs` dispatches by name. With 3 hooks remaining, consider inlining each directly in `hooks.json` and deleting the runner. Or keep the runner if the dispatch-by-name pattern is genuinely cleaner than three separate scripts. Prefer fewer files unless there's a shared concern.

---

### `agents/*.md` (14 agents, 1,886 lines)

All going away per [CC-1](#cross-cutting). Conversion notes:

| Agent | Current size | Becomes |
|---|---|---|
| `shipyard-builder` | 376 | `skills/ship-execute/references/builder-prompt.md` (rewritten as the task-loop prompt template per [R-1](#ralph-design)). The 376 lines today carry a lot of branch-verification / mode-check / kind-routing prose that gets simpler when (a) `isolation: worktree` is fixed upstream, (b) kind routing happens orchestrator-side, (c) hard-stop gates collapse into the loop contract. Target ~150 lines. |
| `shipyard-critic` | 200 | `skills/ship-discuss/references/critic-prompt.md` |
| `shipyard-discovery-scout` | 78 | `skills/ship-discuss/references/discovery-scout-prompt.md` |
| `shipyard-investigator` | 119 | `skills/ship-review/references/investigator-prompt.md` |
| `shipyard-researcher` | 135 | `skills/ship-execute/references/researcher-prompt.md` |
| `shipyard-review-bugs` | 84 | merge into `skills/ship-review/references/scanner-prompts.md` |
| `shipyard-review-patterns` | 92 | same |
| `shipyard-review-security` | 88 | same |
| `shipyard-review-silent-failures` | 97 | same |
| `shipyard-review-spec` | 104 | same |
| `shipyard-review-tests` | 87 | same |
| `shipyard-skill-writer` | 173 | `skills/ship-init/references/skill-writer-prompt.md` |
| `shipyard-sprint-analyst` | 107 | `skills/ship-sprint/references/analyst-prompt.md` |
| `shipyard-test-runner` | 46 | inline into `skills/ship-execute/SKILL.md` (it's tiny) |

- [ ] **F-25.** Delete `plugins/shipyard/agents/` entirely after conversion. Each conversion is mechanical: take the body, drop the YAML frontmatter (description/model/tools — those become Agent dispatch params), wrap in a "Subagent: <role>" header and parameterize what the orchestrator passes.
- [ ] **F-26.** Update every `Agent(subagent_type: shipyard:shipyard-X, …)` call across all skills to `Agent(subagent_type: general-purpose, prompt: <load template> + <task params>)`. Skill body shows the `Read ${CLAUDE_PLUGIN_ROOT}/skills/<owner>/references/<role>-prompt.md` step explicitly.
- [ ] **F-27.** Six review-* agents collapse into one **scanner-prompts.md** file with sections per scanner (security, bugs, silent-failures, patterns, spec, tests). The `ship-review` skill picks which section to load based on what's being reviewed.
- [x] **F-28.** When converting `shipyard-builder` (the highest-leverage agent), inline the **Iron-Law verification** prose at the top of the prompt template (per [CC-4](#cross-cutting)). The prompt template is the only place where `verification-before-completion` and `test-driven-development` Iron Law content lands in the subagent's context — so it must be there explicitly, not behind a Skill tool call inside the subagent (the subagent has no `using-superpowers` bootstrap). *(Iron Laws inlined at top of `dispatching-task-loop`'s prompt template: NO PRODUCTION CODE WITHOUT FAILING TEST FIRST + NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION + NO STUBS.)*

---

### `project-files/rules/*.md` (7 files, 563 lines)

Today copied into `.claude/rules/shipyard-*.md` by `/ship-init`. Per [CC-3](#cross-cutting), stop the injection.

- [ ] **F-29.** Skills that need a rule should `Read ${CLAUDE_PLUGIN_ROOT}/project-files/rules/<basename>.md` on demand. Or use `@${CLAUDE_PLUGIN_ROOT}/project-files/rules/<basename>.md` import inside skill body where supported.
- [ ] **F-30.** `/ship-init` adds an **uninstall step** for legacy customers: detects existing `.claude/rules/shipyard-*.md`, asks "Shipyard 2.0 no longer needs these in your project. Remove? [Yes / Keep]". Defaults Yes.
- [ ] **F-31. Audit the rules themselves while we're here** — most are short (17–123 lines). They look like methodology documentation more than enforced rules. Consider:
  - `shipyard-tdd.md` (17 lines) — likely already covered by inlining the TDD Iron Law into the builder prompt template. Delete after CC-4 lands.
  - `shipyard-execution.md` (34 lines) — same; superseded by Iron-Law prose in builder template.
  - `shipyard-review.md` (36 lines) — fold into `ship-review` skill body or keep as small reference.
  - `shipyard-data-model.md` (201 lines) — keep; it's a real reference doc explaining the spec/sprint/task data model. Move to `references/` not `rules/`.
  - `shipyard-spec.md` (105 lines), `shipyard-ask-user.md` (123 lines), `shipyard-next-up.md` (47 lines) — review individually.

---

### `project-files/templates/*.md` (9 files, 270 lines)

Templates: `BACKLOG.md`, `bug.md`, `config.md`, `epic.md`, `feature.md`, `idea.md`, `PROGRESS.md`, `SPRINT.md`, `task.md`. Used during `/ship-init` (copied via `shipyard-data init`) and during `/ship-discuss`/`/ship-sprint` for new artifacts.

- [ ] **F-32.** Add an **`acceptance_probe`** field to `task.md` template (per [R-3](#ralph-design)). Field carries the smoke-probe command that the new task-loop subagent runs before claiming done.
- [ ] **F-33.** `/ship-sprint` planning step authors the probe alongside ACs. Update the planning prompt to require it.
- [ ] **F-34.** Templates are otherwise fine; small files, do their job. No over-engineering.

---

### `skills/ship-execute/SKILL.md` (777 lines, 11 references)

Already deeply analyzed in conversation — this is the critical broken skill. Findings per section:

- **Mutex/lock prose (lines 28–80)** — the planning-session-mutex check + execution-lock check is ~50 lines of careful state-machine prose. With CC-7 (session ID stamping) it shrinks; with [CC-2](#cross-cutting) (no session-guard hook) the skill owns this entirely. Net: same prose, but the hook duplication goes.
- **Pre-flight Status Check (line 92–94)** — runs a sub-pipeline silently. Fine, fast.
- **Pre-flight Git Check (97–117)** — explicit and clear.
- **Operating Principles (119–125)** — already lean. Keep.
- **FULL SPRINT (127+) → Step 0 worktree salvage (131–207)** — 76 lines of salvage protocol. **Most of this is workaround for `isolation: worktree` brokenness which is now fixed upstream.** With Anthropic's stale-worktree cleanup, untracked-file protection, and squash-merged cleanup, Shipyard's salvage protocol becomes much simpler.
- **Step 1.5 Readiness Check (226–279)** — has a manual worktree probe that re-creates isolation to test it. **F-35.** Delete the worktree probe entirely. With upstream fixes shipped, trust `isolation: worktree`. Drop `manual_worktrees = true` fallback path. Saves ~70 lines plus the entire "if manual_worktrees" branch later.
- **Step 2 Execute Waves (281+)** — three execution modes (solo/subagent/team) each with their own dispatch shape, plus kind-routing for feature/operational/research. **F-36.** Collapse to one execution path that uses `general-purpose` Agent dispatch with the task-loop prompt template (CC-5). Parallelism is `Agent` block fan-out, not a different mode. "Team mode" → just parallel dispatches with shared task list (Anthropic's native Agent Teams primitive when ready, but only as opt-in).
- **Subagent Prompt block (343–379)** — references the registered builder agent. **F-37.** Replace with: load `references/task-loop-prompt.md`, parameterize, dispatch `general-purpose`. The "manual_worktrees" branch dies (F-35). The "kind routing" gate moves to the orchestrator side and dispatches different prompt templates (`task-loop-prompt.md` for feature, `operational-task-prompt.md` for operational, `research-task-prompt.md` for research) — three small files instead of three branches in one prompt.
- **Post-Subagent gate (381–457)** — large, kind-aware. **F-38.** Per [R-2](#ralph-design), the loop subagent's structured return makes most of these checks easier (parse `STATUS:`/`COMMIT:`/`PROBE_OUTPUT_TAIL:`). Keep the salvage-and-redispatch pattern. Drop the heartbeat-file check (the heartbeat hook is being deleted — F-3).
- **Step 4 Wave Boundary (481–574)** — extensive: rebase loop, scoped build delegation, REFACTOR loop with up-to-3 iterations, MUTATE pass, VERIFY against acceptance scenarios, context-pressure auto-pause threshold. **F-39. Over-engineering flag:** the REFACTOR loop with iteration counter (`wave-[N]-refactor-iter-2`, `iter-3`) is a sub-loop inside the wave loop. Either delete (let the per-task probe carry the reliability) or keep but cap at 1 iteration. The 3-iteration cap was set when builders were unreliable; the new task-loop with Iron Law should make extra iterations rare.
- [ ] **F-40.** **Compaction Recovery (576–587) over-engineering:** the auto-pause-at-count-≥5 logic exists because the builder model gets confused after 5 compactions. With Opus 1M / Sonnet 200K and the new fresh-context-per-task design, compaction in the orchestrator session is much rarer. **Simplify:** still warn, but drop the auto-pause threshold; let the user pause if they want.
- [ ] **F-41.** **Pause/Resume + HANDOFF.md** — keep, but simplify the frontmatter. The `refactor_loop` block (lines 696–706) goes if F-39 lands.
- [ ] **F-42.** **Loop Detection (663–679)** — cross-references the loop-detect hook (being deleted). Move the "5+ edits same file" detection into the builder loop itself: subagent's own context tracks its edit history; if it loops, it reflects and exits with a STATUS: BLOCKED.
- [ ] **F-43.** Target after all changes: `ship-execute/SKILL.md` ~350 lines (down from 777). References down from 11 to 4: `task-loop-prompt.md`, `operational-task-prompt.md`, `research-task-prompt.md`, `git-strategy.md`. Delete: `context-management.md`, `context-pressure.md`, `live-capture.md`, `lsp-strategy.md`, `refactor-loop.md`, `tdd-cycle.md`, `team-mode.md`, `test-delegation.md` (most are absorbed into the prompt template or no longer needed).

---

### `skills/ship-review/SKILL.md` (618 lines)

User said reviewer "rubber-stamps stubs" — same root cause as builder false-completion. Apply the same Iron-Law treatment.

- [ ] **F-44.** Add a **demo-path probe** to the reviewer flow: before approving a feature, run a smoke command that exercises the demo path end-to-end. Capture output; reviewer can't approve without it.
- [ ] **F-45.** Six review-scanner agents collapse into one prompt template per [F-27](#).
- [ ] **F-46.** Investigator agent body → reference prompt per F-25.
- [ ] **F-47.** Critic prompt → reference prompt.
- [ ] **F-48.** Target size: ~350 lines.

---

### `skills/ship-init/SKILL.md` (671 lines)

Already exhaustively covered: rule injection (delete), permission settings injection (opt-in), gitignore additions (minimize to `.claude/worktrees/`), legacy `.shipyard/` migration (keep — atomic via `shipyard-data migrate`), orphan recovery (keep until F-7 simplification).

- [ ] **F-49.** Steps to delete or slim:
  - Step 5.5 (Configure Permissions, lines 478–514) — make opt-in. Default skip with explicit explainer.
  - "Install rules into the project" subsection (lines 233–238) — delete entirely.
  - Step 4 (Initialize Memory, line 418) — review whether the memory contents are doing real work; the `<SHIPYARD_DATA>/memory/project-context.md` is a good idea, keep but simplify.
- [ ] **F-50.** Add Step: **Migration of legacy footprint** — detect existing `.claude/rules/shipyard-*.md` and offer to remove. One Read + one prompt + AskUserQuestion + N Writes (deletes).
- [ ] **F-51.** Target: ~400 lines. Down from 671.

---

### `skills/ship-discuss/SKILL.md` (792 lines, 9 references)

User explicitly said this **works well** — minimum-touch.

- [ ] **F-52.** **Don't refactor for refactor's sake.** Only mechanical changes:
  - Replace any registered-agent dispatches with `general-purpose` + prompt templates (CC-1).
  - Drop any `shipyard-context view` / `shipyard-data` non-essential CLI calls.
- [ ] **F-53. Over-engineering check:** 9 references for one skill is a lot. Audit which references are actively read (Glob the SKILL.md for `references/<name>.md` paths) vs vestigial. Quick win if any are dead.

---

### `skills/ship-sprint/SKILL.md` (844 lines, 4 references)

User said this **works well** — minimum-touch. Same approach as ship-discuss.

- [ ] **F-54.** Mechanical CC-1 conversion only. Add the **acceptance_probe authoring step** (F-32/F-33).
- [ ] **F-55.** 844 lines is large but if behavior is good and not customer-facing pain, leave it. Re-evaluate after the high-leverage work lands.

---

### `skills/ship-backlog/SKILL.md` (264 lines)

User said it works. Minimum-touch.

- [ ] **F-56.** Replace any `shipyard-data events` calls with skill-side Read+Write through `with-lock`. No structural change.

---

### `skills/ship-spec/SKILL.md` (356 lines)

User said it works. Minimum-touch.

- [ ] **F-57.** Same minimum-touch.

---

### `skills/ship-status/SKILL.md` (296 lines)

User said it works. Minimum-touch. Possibly the cleanest skill since it's read-only.

- [ ] **F-58.** Keep as-is structurally. Update calls to retired CLIs.

---

### `skills/ship-bug/SKILL.md` (132 lines), `skills/ship-quick/SKILL.md` (182 lines), `skills/ship-help/SKILL.md` (134 lines), `skills/ship-debug/SKILL.md` (311 lines)

Smaller skills. Quick audit:

- [ ] **F-59.** `ship-help`, `ship-bug`, `ship-quick` — likely fine at current size. Check for registered-agent dispatches and CLI references; rewire.
- [ ] **F-60.** `ship-debug` — Anthropic now has a `Debug` plan-mode-style flow. Worth re-reading to see if any of `ship-debug`'s logic should defer to native debugging.

---

<a id="sequence"></a>
## Recommended sprint sequence

Order by leverage × independence. Items that ship customer-facing improvements early go first.

### Sprint 1 — De-globalize (1 week, immediate customer-facing win)
- **F-3** — delete 9 hooks, keep 3.
- **F-25, F-26** — delete `agents/` directory, convert to prompt templates, rewire dispatches to `general-purpose`.
- **F-30, F-50** — `/ship-init` stops injecting `.claude/rules/`; add legacy-footprint cleanup step.
- **F-29** — skills `Read` rules from plugin-root.

After Sprint 1: customer report is fixed. Hooks dormant unless skill active. Agents can't be auto-dispatched. Rules don't bleed.

### Sprint 2 — Ralph-without-bloat (1 week, reliability fix)
- **R-1, R-2, R-3, R-4, R-5** — task-loop prompt template, structured return contract, acceptance probe field, no-builder-agent, anti-stub scanner.
- **F-32, F-33** — task template gains `acceptance_probe`; `/ship-sprint` authors it.
- **F-28** — Iron-Law prose at top of builder prompt template.
- **F-44** — `/ship-review` demo probe.

After Sprint 2: false completion is structurally hard. Loop iterations don't bloat user session.

### Sprint 3 — Lean the data layer (1 week)
- **F-7, F-10** — resolver: trust `CLAUDE_PLUGIN_DATA`, drop fallback chain.
- **F-13, F-14** — `shipyard-data`: retire 7 of 11 subcommands.
- **F-16, F-17, F-18** — `shipyard-context`: keep only `diagnose`.
- **F-19, F-20, F-21, F-22** — `shipyard-logcap`: target ≤300 lines or replace with structured-return contract.
- **CC-7** — embed session ID in lock files.

After Sprint 3: ~3,000 lines of bin/ code retire. Resolver is reliable.

### Sprint 4 — Slim ship-execute (1 week)
- **F-35** — delete worktree probe + `manual_worktrees` fallback (upstream fixed).
- **F-36, F-37, F-38** — collapse three modes into one dispatch path; structured return drives gate.
- **F-39, F-40, F-41** — drop REFACTOR loop iteration counter; simplify compaction-recovery.
- **F-42, F-43** — loop detection in subagent context, not orchestrator hook. References 11 → 4.

After Sprint 4: `ship-execute/SKILL.md` ~350 lines. Behavior simpler and more reliable.

### Sprint 5 — Polish (as bandwidth allows)
- **F-31, F-46, F-47, F-48** — review-scanner consolidation, ship-review polish.
- **F-49, F-51** — ship-init slim.
- **F-53** — discuss audit reference usage.
- **F-58, F-59, F-60** — small skills cleanup.
- **F-24** — hook-runner removal if 3 hooks → inline.

---

<a id="risks"></a>
## Risks / open questions

1. **Iron-Law prose effectiveness varies by model.** Superpowers' tests show it works on Sonnet 4+. If users run on smaller models (e.g., Haiku for builder), the prose alone may not be enough — anti-stub scanner becomes load-bearing rather than belt-and-suspenders.

2. **Removing the post-compact hook may surprise long-running orchestrators.** Mitigation: skill-side compaction-counter stays as plain-file read+increment, just no hook-mediated tracking. If `tracks_compaction_pressure` is missing, treat as 0; let user decide when to pause.

3. **Deleting `subagent-stop` hook removes the "no commit on exit" enforcement.** Mitigation: structured return contract requires `COMMIT: <sha>` and orchestrator validates the sha exists in git before marking done. Achieves the same goal at a different boundary.

4. **The acceptance probe is a new authoring burden in `/ship-sprint`.** Mitigation: probe is one shell line per task, often derived from `test_commands.scoped` + the changed module path. Opus is doing the planning anyway. Net: shifts work left, doesn't add net work.

5. **Subagent-driven Iron-Law assumes the prompt template is loaded in the subagent context.** The subagent has no `using-superpowers`-style bootstrap; the only way it knows the contract is the prompt we hand it. Length of the prompt matters; keep it tight (~200 lines max) so the subagent doesn't burn its own context on instructions before doing work.

6. **Anthropic's native Agent Teams.** Worth trialing once `/ship-execute` is leaner — but only opt-in. Each teammate is a fresh-context session, which fits the Ralph-without-bloat goal naturally. Risk: token cost scales linearly with teammates.

7. **Eval coverage.** Every action item that touches a skill must have matching assertions in `tests/assertions/ship-*.json`. F-3, F-26, F-29 are eval-relevant — add CI checks for "no `agents/*.md` files exist", "no `.claude/rules/shipyard-*.md` written by ship-init", "hooks.json has at most 3 entries".

8. **Migration for existing users.** Sprint 1 changes plugin behavior without re-init. Add `/ship-init` legacy detection to clean up old `.claude/rules/shipyard-*.md` and old permission entries on next run. One release with a deprecation notice, then enforce.

---

## Skill decomposition — applying SRP to the skill layer

### The diagnosis

You named the actual root cause behind a lot of the unreliability: **a skill that holds 15 responsibilities can't keep them all in working memory while executing one of them.** The model lossy-compresses the rest, then fails to honor commitments it "agreed to" near the top of the file. Today:

| Skill | Lines | Distinct responsibilities (counted) |
|---|---|---|
| `ship-execute` | 777 | 15 — mutex, pre-flight×2, worktree salvage, readiness, wave loop, dispatch, kind routing, post-subagent gate, wave boundary, compaction recovery, sprint completion, single-task, hotfix, pause/resume, deviation rules |
| `ship-sprint` | 844 | ~10 — backlog selection, RICE, dependency analysis, wave planning, capacity calc, task decomposition, probe authoring (new), critical path, scope churn, retro carry-over |
| `ship-discuss` | 792 | ~8 — brainstorming, AC extraction, edge cases, NFRs, failure modes, persona evaluation, critic dispatch, spec authoring |

When you tell `ship-execute` to enforce an Iron Law about completion verification, the rule is on line 770; by the time the model gets to dispatching a builder on line 350, the rule is paged out. **You're not getting back what you wrote.**

### The pattern: two layers

**Layer 1 — command skills** (user-facing, 1 per `/ship-*` command, kept as today). Job: orchestrate. Hold the *flow*, not the *content*. Target ~150–300 lines each.

**Layer 2 — capability skills** (new, internal, invoked by command skills via the `Skill` tool). Job: encapsulate one focused methodology or operation. Target ~100–250 lines each. Marked `disable-model-invocation: true` in frontmatter so they don't pollute the slash-command picker — only invoked programmatically from a parent skill.

This is the same shape Superpowers uses (`verification-before-completion`, `test-driven-development`, `subagent-driven-development`, `using-git-worktrees` — focused methodologies, invoked from parent flows). It's also the shape Anthropic's plugin docs implicitly assume when they call out the `Skill` tool as the inter-skill primitive.

### How accuracy improves

Each capability skill loads its full content **only when invoked**. So when the model is dispatching a task, it loads `dispatching-task-loop` (~150 lines focused entirely on that), and the Iron Law is at the top of *that* skill — not at the bottom of a 777-line skill. **The rule is in working memory at the moment it has to fire.**

This is the same insight as progressive disclosure in Anthropic's skill guidance: don't load what you don't need yet. SRP is the operational form of that principle at the skill level.

### Granularity criterion (avoids over-decomposition)

A capability skill should satisfy **at least one** of:
1. **Reused across 2+ command skills** (worth extracting to avoid drift).
2. **A non-trivial methodology** that benefits from focused prose (e.g., `verifying-completion`, `tdd-cycle` — these are Iron-Law-style and need their own context).
3. **A single dispatchable operation** with a clear pre/post contract (e.g., `dispatching-task-loop` — input is a task spec, output is a structured return).

Anything that doesn't satisfy at least one of these stays inline in its parent command skill. This guards against the SOLID-taken-too-far failure mode where you have 50 micro-skills and the model gets confused chaining them.

### Proposed capability skill set (14 skills)

Final list after applying the granularity criterion:

| # | Capability skill | Reused by | Lines (target) |
|---|---|---|---|
| **Reliability methodologies** (Iron-Law style) | | | |
| 1 | `verifying-completion` | execute, review, bug, quick | 120 |
| 2 | `tdd-cycle` | execute, quick, bug | 180 |
| 3 | `running-acceptance-probe` | execute, review | 100 |
| 4 | `anti-stub-scan` | execute, review | 120 |
| **Dispatch patterns** | | | |
| 5 | `dispatching-task-loop` | execute, quick, bug | 200 |
| 6 | `dispatching-spec-review` | execute, review | 130 |
| 7 | `dispatching-code-review` | execute, review | 130 |
| 8 | `dispatching-research-task` | execute, discuss | 140 |
| 9 | `dispatching-operational-task` | execute, sprint | 150 |
| **Git / worktree** | | | |
| 10 | `using-worktrees` | execute, review | 150 |
| **State / lifecycle** | | | |
| 11 | `acquiring-skill-lock` | execute, discuss, sprint, review | 100 |
| **Discovery** (planning-side) | | | |
| 12 | `discovering-edge-cases` | discuss, sprint | 180 |
| 13 | `extracting-acceptance-criteria` | discuss, spec, sprint | 140 |
| 14 | `authoring-acceptance-probe` | sprint, quick, bug | 120 |

**Total ~1,860 lines** across 14 focused skills.

Compare to today: `ship-execute` alone is 777 lines plus 11 references (~2,100 more lines) — roughly the same total content, fragmented into focused chunks that load on demand instead of all-at-once.

### What stays in command skills (Layer 1)

After capability extraction, command skills hold only:
- The user-visible flow ("first do X, then Y, then Z")
- The orchestration calls (`use the X skill`, `dispatch via the Y skill`)
- The skill-specific glue that doesn't generalize (e.g., `/ship-execute`'s wave loop structure, which is unique to it)

Target sizes:

| Command skill | Today | After |
|---|---|---|
| `/ship-execute` | 777 | ~250 |
| `/ship-sprint` | 844 | ~300 |
| `/ship-discuss` | 792 | ~280 |
| `/ship-review` | 618 | ~220 |
| `/ship-init` | 671 | ~350 (slimmed via F-49/F-51) |
| `/ship-spec` | 356 | ~280 |
| `/ship-debug` | 311 | ~250 |
| `/ship-status` | 296 | ~280 (read-only, mostly fine) |
| `/ship-backlog` | 264 | ~220 |
| `/ship-quick` | 182 | ~180 (already lean; just add capability invocations) |
| `/ship-bug` | 132 | ~150 (slight grow from explicit capability invocations) |
| `/ship-help` | 134 | ~134 |

### How a command skill calls a capability skill

Inside `ship-execute/SKILL.md`, the per-task dispatch becomes:

```markdown
### Per-task dispatch

For each task in the wave:

1. Read task file frontmatter; route by `kind`:
   - `kind: feature` (or absent): use the **`shipyard:dispatching-task-loop`** skill
   - `kind: operational`: use the **`shipyard:dispatching-operational-task`** skill
   - `kind: research`: use the **`shipyard:dispatching-research-task`** skill

   Pass the task ID, working branch, data dir, and acceptance probe to the skill.

2. The capability skill returns `{ status, commit_sha, probe_output_tail }` (or
   the kind-specific equivalent). Parse the result and proceed to the
   post-dispatch check below.
```

The dispatch skill (Layer 2) holds the actual prompt template, structured-return parsing, salvage/redispatch flow, and the Iron-Law verification prose. It's ~200 lines, focused, and loaded only when needed.

### Applying SOLID — which principles, where

Mapping SOLID to skill design (your instinct was right; here's where each lands):

- **S — Single Responsibility.** ✓ Direct: each capability skill has one reason to change. `verifying-completion` changes only when the verification contract changes; `tdd-cycle` changes only when TDD discipline changes.
- **O — Open/Closed.** ✓ Indirect: command skills extend behavior by composing capability skills. Adding a new task kind is a new dispatch capability skill, not a 100-line if/else inside `ship-execute`.
- **L — Liskov Substitution.** Partial: dispatch capabilities (`dispatching-task-loop`, `dispatching-research-task`) follow the same input/output contract — pass `{task_id, branch, ...}`, get back `{status, summary}`. They're substitutable from the orchestrator's POV.
- **I — Interface Segregation.** ✓ Direct: a command skill imports only the capabilities it uses. `ship-status` doesn't pull in `using-worktrees`.
- **D — Dependency Inversion.** ✓ Indirect: command skills depend on capability *names* (the Skill tool), not on implementation. Capability skills can be rewritten without touching the command.

The two principles that matter most in practice for Shipyard: **SRP** (cures the bloat → accuracy loss) and **ISP** (each skill's prompt context is exactly what it needs, nothing more).

### Action items for skill decomposition

- [~] **S-1.** Build the **14 capability skills** listed above. Each gets:
  - YAML frontmatter with `disable-model-invocation: true` so it never appears in the slash-command picker.
  - Tightly scoped `description` (≤2 lines, says exactly when to use it).
  - Imperative-form body (~100–250 lines).
  - Optional `references/` dir for very long methodology refs (rare; keep body self-contained where possible).
  - Per-skill progress (each commits independently):
    - [x] verifying-completion
    - [x] tdd-cycle
    - [x] running-acceptance-probe
    - [x] anti-stub-scan
    - [x] dispatching-task-loop
    - [ ] dispatching-spec-review
    - [ ] dispatching-code-review
    - [ ] dispatching-research-task
    - [ ] dispatching-operational-task
    - [ ] using-worktrees
    - [x] acquiring-skill-lock
    - [ ] discovering-edge-cases
    - [ ] extracting-acceptance-criteria
    - [x] authoring-acceptance-probe
- [ ] **S-2.** **Decomposition order matters.** Build the most-reused skills first — they unblock the most command-skill simplification:
  - **Wave 1:** `verifying-completion`, `tdd-cycle`, `dispatching-task-loop`, `acquiring-skill-lock`. Unblocks ship-execute slim and ship-quick/ship-bug rewires.
  - **Wave 2:** `using-worktrees`, `running-acceptance-probe`, `anti-stub-scan`, `authoring-acceptance-probe`. Unblocks ship-review and ship-sprint.
  - **Wave 3:** Discovery skills (`discovering-edge-cases`, `extracting-acceptance-criteria`) and the remaining dispatch skills.
- [ ] **S-3.** **Update each command skill to invoke capability skills via the Skill tool.** Mechanical edit, but every dispatch site needs to be rewritten. Add eval assertions that command skills don't duplicate capability content.
- [ ] **S-4.** **Maintain a capability registry** in `references/` or in skill front-matter cross-links. Each command skill's body says explicitly which capability skills it uses ("Capabilities used: `dispatching-task-loop`, `wave-boundary`, …"). Helps reviewers see the dependency graph.
- [ ] **S-5.** **Eval coverage for the capability layer.** Each capability skill needs its own assertion file. Add a CI check that every command skill's referenced capabilities exist.
- [ ] **S-6.** **Anti-overdecomposition guard.** Add a CI/eval check that flags any capability skill used by exactly one command skill — that's a candidate to inline back. Run it quarterly.
- [ ] **S-7.** **Discoverability.** Update `/ship-help` to surface the 12 commands as the user-facing surface. Optionally add a `/ship-help --capabilities` flag that lists internal capabilities for plugin authors / advanced users.
- [ ] **S-8.** **Naming convention.** Capability skills use **gerund or imperative verb phrases** (`verifying-completion`, `dispatching-task-loop`, `using-worktrees`) — they're operations, not commands. Command skills keep the `ship-` prefix; capability skills don't (avoid implying they're user-invocable).

### How this folds into the existing sprint sequence

Capability extraction happens **alongside** the sprint work, not as a separate sprint:

- **Sprint 1 (de-globalize):** Build `dispatching-task-loop`, `acquiring-skill-lock`, `verifying-completion` first. The agent-removal rewires (F-26) target the new dispatch capability skill, not raw `general-purpose` calls. So the prompt template in F-25 actually lives inside `dispatching-task-loop`'s body.
- **Sprint 2 (Ralph-without-bloat):** R-1 and R-2 land *as* `dispatching-task-loop` and the Iron-Law content of `verifying-completion` — they're the same work. Add `running-acceptance-probe`, `anti-stub-scan`.
- **Sprint 3 (data layer):** Build `acquiring-skill-lock` if not done in Sprint 1. Lock implementation is a capability skill calling `shipyard-data with-lock`, but with the session-id pattern from CC-7 baked in.
- **Sprint 4 (slim ship-execute):** This is where the command-skill thinning happens. By now, capability skills exist; ship-execute reduces to orchestration calls.
- **Sprint 5 (polish, discuss/sprint decomposition):** Build the discovery capability skills. Slim ship-discuss and ship-sprint by extracting them.

Net: capability skills get built in parallel with the surface-area cleanup, not as a separate phase. They're *how* the cleanup happens.

### Risks

1. **Skill invocation reliability.** If a command skill says "now use `dispatching-task-loop`" and the model skips the invocation, you get worse behavior than today's monolith. Mitigation: phrase invocations imperatively with the same Iron-Law cadence as Superpowers uses internally — e.g., "**You MUST use the `shipyard:dispatching-task-loop` skill** to dispatch this task. Do not inline the dispatch logic. Skipping this skill = unreliable execution."
2. **Discovery / DX.** 12 commands → 12 commands + 14 hidden capabilities. With `disable-model-invocation: true`, capabilities don't pollute the slash picker. But plugin authors editing capability skills need clear docs on the layer split. Add `docs/skill-architecture.md`.
3. **Invocation depth.** Skill A → Skill B → Skill C → Skill D might confuse the model (each invocation adds prompt-load overhead). Hold to **at most 2 levels**: command skill → capability skill. Capabilities don't invoke other capabilities. If they need shared logic, factor into a `references/` file both can `Read`.
4. **Versioning across capabilities.** A breaking change to `dispatching-task-loop` affects every command using it. Add CI check that command skills haven't drifted from their stated capability dependencies.
5. **Token cost of multi-skill loads.** Loading 4 capability skills in one execute run costs more than one monolith. But: each is loaded *only when needed*, and the savings from accuracy (fewer false completions, fewer redispatches, no orchestrator-side context bloat) more than compensate. Measure on real sprints; revisit if cost dominates.
6. **Eval drift.** With more skills, asserting their specific behaviors gets harder. Mitigation: every capability skill comes with a small unit-style eval that exercises only that skill — easier to write than testing the full ship-execute end-to-end.

---

## Quick-glance metrics

| Surface | Today | After Sprint 1 | After Sprint 4 |
|---|---|---|---|
| Registered agents | 14 | 0 | 0 |
| Hook scripts | 12 | 3 | 3 |
| Hook configurations | 9 | 3 | 3 |
| Project-injected rule files | 7 | 0 | 0 |
| `bin/` total lines | 3,820 | 3,820 | ~1,200 |
| `ship-execute/SKILL.md` lines | 777 | 777 | ~350 |
| Total registered surface (agents + rules in project) | 21 | 0 | 0 |
| CLI subcommands across all CLIs | ~25 | ~25 | ~6 |
| Total skill files | 12 | 12 | 26 (12 command + 14 capability) |
| Largest command skill (lines) | 844 | 844 | ~300 |
| Avg lines loaded per skill invocation | ~600 | ~600 | ~200 (only relevant capabilities load) |



