---
name: escalating-to-thinker
description: "Dispatch a think-tier consult when the pipeline is stuck."
disable-model-invocation: true
---

# Capability: Escalating To Thinker

Dispatch a one-shot consult subagent on the project's **think tier** (`models.think` from config) when the orchestrating pipeline is stuck in a way the documented recovery paths don't cover. The consult returns a structured recommendation; the orchestrator executes it. The consult never mutates anything — it reads, reasons, and recommends.

Why this exists: the orchestrating session runs a mid-tier model tuned for stage-walking and dispatch, not for hard diagnosis. When the same fix fails twice or a gate hard-stops with no covered playbook, the cheap move is to buy one round of top-tier reasoning rather than burn iterations guessing. The per-sprint cap keeps this a scalpel, not a crutch.

## When to invoke (the seven triggers — do NOT invoke outside these)

1. **Repeated fix failure** — the same task or gate has failed 2 consecutive fix iterations (`*_fix_iter` / redispatch exhausted, or two `code_review_iter` passes with an unchanged must-fix set).
2. **Integration-gate hard stop** — `shipyard-data verify-wave-integrated` exit 3 whose named branches/tasks don't match the documented remediation (rebase + ff-merge, anchor-commit) after one attempt.
3. **Uncovered blocked task** — a `BLOCKED` return whose `escalation_code` has no matching entry in the deviation rules / blocked-handling table.
4. **Critic deadlock** — review Stages 4.6/4.7 produce contradictory verdicts that a second pass does not reconcile.
5. **Recovery-path ambiguity** — the situation matches more than one documented recovery path, or matches one only partially, and picking between them (or adapting one to fit) requires judgment the shell isn't positioned to exercise. Since ship-execute now runs on Sonnet with a zero-thinking doctrine, this is the structural admission that "which documented path applies here" is itself sometimes a judgment call, not a lookup.
6. **Uninterpreted gate failure** — any CLI call exits 3 with a reason string that names a condition but no covered remediation exists for it in the skill body or references (distinct from trigger 2, which is specifically the integration gate; this covers any other gate — terminal-evidence, loop-leak, task-state CLI refusals, etc.).
7. **Deviation classification** — a discrepancy between expected and actual state (a task's diff doesn't match its spec, a probe passes but the implementation looks wrong, a wave's evidence is technically complete but suspicious) needs a bug-vs-structural-deviation call: is this a defect to fix, or a legitimate divergence from the plan that the Deviation Rules should log and proceed past? The shell does not make this call itself.

If the situation matches a documented recovery path, follow that path — do not escalate. If it needs the *user* (scope change, destructive action, product decision), use AskUserQuestion — escalation is for reasoning gaps, not authority gaps.

## Preconditions

Read from `<SHIPYARD_DATA>/config.md`:

- `escalation.enabled` — if `false`, skip escalation entirely and fall back to AskUserQuestion.
- `escalation.max_consults_per_sprint` (default 6) — count prior `escalation_consult_dispatched` events for this sprint via `shipyard-context scan-events --tail 200 escalation_consult_dispatched`. If the cap is reached, do NOT dispatch; surface to the user via AskUserQuestion with the consult history summarized.
- `models.think` — the consult model. If empty/absent, omit the `model:` field (the consult inherits the session model; still worth it — the value is the fresh, focused context).

## Protocol

1. **Emit the dispatch event first** (auditability — a consult that leaves no trace can't be capped):

   ```
   shipyard-data events emit escalation_consult_dispatched pipeline=<ship-execute|ship-review> sprint=<id> trigger=<repeated_fix_failure|integration_gate|uncovered_blocked|critic_deadlock|recovery_path_ambiguity|uninterpreted_gate_failure|deviation_classification> subject=<task-or-stage-id>
   ```

2. **Dispatch the consult** — `Agent(subagent_type: "general-purpose", model: <models.think — omit if empty>)` with this prompt template, fully substituted (no placeholders left):

   ```
   You are a one-shot escalation consultant for a stuck Shipyard pipeline. You are
   READ-ONLY: read code, state files, and logs; run read-only git commands; do NOT
   edit files, commit, or mutate any state.

   STUCK SITUATION
   - Pipeline: {{pipeline}} at stage {{stage}}, sprint {{sprint}}
   - Trigger: {{trigger}}
   - Subject: {{task_or_gate_id}}
   - What was attempted, in order, and how each attempt failed:
   {{attempt_history — concrete: commands, exit codes, error tails, diffs tried}}
   - Relevant state: {{paths — task file, failing test output capture, event-log tail,
     verify-wave-integrated stderr, code-review findings}}

   YOUR JOB
   Diagnose WHY the attempts failed (not just that they failed), then recommend ONE
   primary course of action the orchestrator can execute, plus at most one fallback.
   Prefer recommendations that use existing Shipyard paths (redispatch with a changed
   task brief, a targeted manual fix task, anchor-commit + manual integration, spec
   correction, or "surface to user with this specific question").

   RETURN (this exact structure, nothing after it):
   DIAGNOSIS: <2-4 sentences — the root cause, with the evidence that supports it>
   RECOMMENDATION: <the single action to take, concrete enough to execute verbatim>
   FALLBACK: <one alternative if the recommendation fails, or "none">
   CONFIDENCE: <high|medium|low>
   ```

3. **Emit the return event**:

   ```
   shipyard-data events emit escalation_consult_returned pipeline=<p> sprint=<id> subject=<id> confidence=<high|medium|low>
   ```

4. **Execute the recommendation** through normal Shipyard paths (redispatch via `dispatching-task-loop`, patch task creation, `cursor escalate`, AskUserQuestion — whatever it names). Do not treat the consult as authority to bypass gates: if the recommendation conflicts with a structural gate (terminal evidence, integration gate, loop-leak guard), the gate wins and the conflict itself goes to the user.

5. **Low confidence or second failure** — if the consult returns `CONFIDENCE: low`, or its recommendation also fails, stop consuming consults: surface to the user via AskUserQuestion carrying the DIAGNOSIS verbatim.

## Rules

- One consult per trigger occurrence. Never dispatch two consults for the same subject back-to-back — execute or escalate to the user first.
- The consult is read-only by contract; if its return claims to have made changes, distrust it, verify git status, and surface to the user.
- Never inline the consult's reasoning burden into the orchestrating session — the whole point is a fresh, focused context on the think tier.
