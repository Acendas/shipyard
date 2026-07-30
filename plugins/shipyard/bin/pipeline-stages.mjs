/**
 * pipeline-stages — the machine-readable stage graph for the ship-execute
 * and ship-review pipeline cursors.
 *
 * Single source of truth for what stages exist and which transitions are
 * legal. Consumed by:
 *   - `shipyard-data cursor advance` (bin/cursor-cli.mjs) — validates every
 *     transition before writing the cursor.
 *   - terminal-gate.mjs / tests — terminal-stage classification.
 *
 * Before v2.9.0 this graph lived as prose tables in
 * skills/ship-execute/references/pipeline-cursor.md and the ship-review
 * twin. The model wrote cursor files freeform and a PreToolUse hook
 * retroactively policed the terminal writes. Extracting the graph here lets
 * the CLI validate *every* transition at write time instead — the prose
 * tables remain as documentation, but this file is what executes.
 *
 * Stage names are parameterized: `wave_3_dispatch`, `code_review_iter_2`,
 * `wave_1_tests_fix_iter_1`. `normalizeStage()` maps a concrete name to a
 * generic key (`wave_dispatch`, `code_review_iter`, `wave_tests_fix_iter`)
 * plus extracted `wave` / `iter` numbers. The graph is expressed over the
 * generic keys; wave arithmetic (same-wave vs gate→next-wave) is enforced
 * separately in `validateTransition`.
 */

/**
 * Ordered pattern table. First match wins. Each entry:
 *   re    — matcher with optional named groups `wave` and `iter`
 *   key   — normalized stage key
 */
const STAGE_PATTERNS = {
  "ship-execute": [
    { re: /^preflight$/, key: "preflight" },
    { re: /^salvage$/, key: "salvage" },
    { re: /^load$/, key: "load" },
    { re: /^readiness$/, key: "readiness" },
    { re: /^wave_(?<wave>\d+)_dispatch$/, key: "wave_dispatch" },
    { re: /^wave_(?<wave>\d+)_waiting$/, key: "wave_waiting" },
    { re: /^wave_(?<wave>\d+)_recovery$/, key: "wave_recovery" },
    { re: /^wave_(?<wave>\d+)_redispatch_iter_(?<iter>\d+)$/, key: "wave_redispatch_iter" },
    { re: /^wave_(?<wave>\d+)_boundary$/, key: "wave_boundary" },
    { re: /^wave_(?<wave>\d+)_build_fix_iter_(?<iter>\d+)$/, key: "wave_build_fix_iter" },
    { re: /^wave_(?<wave>\d+)_build$/, key: "wave_build" },
    { re: /^wave_(?<wave>\d+)_refactor$/, key: "wave_refactor" },
    { re: /^wave_(?<wave>\d+)_tests_fix_iter_(?<iter>\d+)$/, key: "wave_tests_fix_iter" },
    { re: /^wave_(?<wave>\d+)_tests$/, key: "wave_tests" },
    { re: /^wave_(?<wave>\d+)_verify$/, key: "wave_verify" },
    { re: /^wave_(?<wave>\d+)_gate$/, key: "wave_gate" },
    { re: /^sprint_full_build$/, key: "sprint_full_build" },
    { re: /^sprint_tests_fix_iter_(?<iter>\d+)$/, key: "sprint_tests_fix_iter" },
    { re: /^sprint_full_tests$/, key: "sprint_full_tests" },
    { re: /^sprint_demo_probes$/, key: "sprint_demo_probes" },
    { re: /^sprint_complete_gate$/, key: "sprint_complete_gate" },
    { re: /^terminal_handoff_to_review$/, key: "terminal_handoff_to_review" },
    { re: /^hotfix$/, key: "hotfix" },
    { re: /^single_task$/, key: "single_task" },
    { re: /^terminal_hotfix$/, key: "terminal_hotfix" },
    { re: /^terminal_single_task$/, key: "terminal_single_task" },
  ],
  "ship-review": [
    { re: /^preflight$/, key: "preflight" },
    { re: /^code_review_iter_(?<iter>\d+)$/, key: "code_review_iter" },
    { re: /^simplify$/, key: "simplify" },
    { re: /^tests$/, key: "tests" },
    { re: /^spec_review$/, key: "spec_review" },
    { re: /^quality_gates$/, key: "quality_gates" },
    { re: /^visual$/, key: "visual" },
    { re: /^goal_verify$/, key: "goal_verify" },
    { re: /^gap_analysis$/, key: "gap_analysis" },
    { re: /^critic$/, key: "critic" },
    { re: /^final_pass$/, key: "final_pass" },
    { re: /^verdict$/, key: "verdict" },
    { re: /^demo_probe$/, key: "demo_probe" },
    { re: /^demo_user$/, key: "demo_user" },
    { re: /^process_approved$/, key: "process_approved" },
    { re: /^process_issues$/, key: "process_issues" },
    { re: /^process_changes$/, key: "process_changes" },
    { re: /^retro_decision$/, key: "retro_decision" },
    { re: /^retro_step_(?<iter>[1-4])$/, key: "retro_step" },
    { re: /^release_step_(?<iter>[1-3])$/, key: "release_step" },
    { re: /^archive$/, key: "archive" },
    { re: /^terminal$/, key: "terminal" },
    { re: /^terminal_issues$/, key: "terminal_issues" },
    { re: /^terminal_changes$/, key: "terminal_changes" },
  ],
};

/**
 * Adjacency over normalized keys. `entry: true` stages may be the first
 * cursor write of a pipeline run (no prior cursor). `terminal: true`
 * stages end the run. `selfLoop: true` allows key → same key (iteration
 * counters advance; the wave rule still requires same wave).
 *
 * Sourced from the stage-map tables in the pipeline-cursor references —
 * keep the prose tables and this graph in sync (test_pipeline_stages
 * cross-checks the terminal + entry sets).
 */
const GRAPH = {
  "ship-execute": {
    preflight: { entry: true, next: ["salvage"] },
    salvage: { next: ["load"] },
    load: { next: ["readiness", "wave_dispatch"] },
    readiness: { next: ["wave_dispatch"] },
    wave_dispatch: {
      next: ["wave_waiting", "wave_boundary", "wave_redispatch_iter"],
    },
    wave_waiting: { selfLoop: true, next: ["wave_recovery"] },
    wave_recovery: { next: ["wave_boundary", "wave_redispatch_iter"] },
    wave_redispatch_iter: { selfLoop: true, next: ["wave_boundary"] },
    wave_boundary: { next: ["wave_build"] },
    wave_build: { next: ["wave_refactor", "wave_build_fix_iter"] },
    wave_build_fix_iter: { selfLoop: true, next: ["wave_build", "wave_refactor"] },
    wave_refactor: { next: ["wave_tests"] },
    wave_tests: { next: ["wave_verify", "wave_tests_fix_iter"] },
    wave_tests_fix_iter: { selfLoop: true, next: ["wave_tests", "wave_verify"] },
    wave_verify: { next: ["wave_gate", "wave_redispatch_iter"] },
    // gate → next wave's dispatch (wave+1) or into sprint completion
    wave_gate: { next: ["wave_dispatch", "sprint_full_build"], waveAdvance: ["wave_dispatch"] },
    sprint_full_build: { next: ["sprint_full_tests"] },
    sprint_full_tests: { next: ["sprint_demo_probes", "sprint_tests_fix_iter"] },
    sprint_tests_fix_iter: { selfLoop: true, next: ["sprint_full_tests", "sprint_demo_probes"] },
    sprint_demo_probes: { next: ["sprint_complete_gate"] },
    sprint_complete_gate: { next: ["terminal_handoff_to_review"] },
    terminal_handoff_to_review: { terminal: true, next: [] },
    hotfix: { entry: true, next: ["terminal_hotfix"] },
    single_task: { entry: true, next: ["terminal_single_task"] },
    terminal_hotfix: { terminal: true, next: [] },
    terminal_single_task: { terminal: true, next: [] },
  },
  "ship-review": {
    // preflight → code review, straight to tests (--skip-code-review),
    // or retro (--retro-only). process_approved asks whether to run retro.
    preflight: { entry: true, next: ["code_review_iter", "tests", "retro_step"] },
    code_review_iter: { selfLoop: true, next: ["simplify"] },
    simplify: { next: ["tests"] },
    tests: { selfLoop: true, next: ["spec_review"] },
    // Stage 1.5 quality_gates sits between spec_review and visual/goal_verify;
    // spec_review may also route straight past it when no standing gates are
    // configured (the old ref omitted this stage — a skill↔ref drift the
    // graph extraction surfaced).
    spec_review: { next: ["quality_gates", "visual", "goal_verify"] },
    quality_gates: { next: ["visual", "goal_verify"] },
    visual: { next: ["goal_verify"] },
    goal_verify: { next: ["gap_analysis"] },
    gap_analysis: { selfLoop: true, next: ["critic"] },
    critic: { next: ["final_pass"] },
    final_pass: { next: ["verdict"] },
    verdict: { next: ["demo_probe"] },
    demo_probe: { next: ["demo_user"] },
    demo_user: { next: ["process_approved", "process_issues", "process_changes"] },
    process_approved: { next: ["retro_decision", "retro_step", "release_step"] },
    process_issues: { next: ["terminal_issues"] },
    process_changes: { next: ["terminal_changes"] },
    retro_decision: { next: ["retro_step", "release_step"] },
    retro_step: { selfLoop: true, next: ["release_step"] },
    release_step: { selfLoop: true, next: ["archive", "terminal"] },
    archive: { next: ["terminal"] },
    terminal: { terminal: true, next: [] },
    terminal_issues: { terminal: true, next: [] },
    terminal_changes: { terminal: true, next: [] },
  },
};

export const PIPELINES = Object.keys(GRAPH);

/** Map a CLI alias (`execute`, `review`) to the canonical pipeline name. */
export function canonicalPipeline(name) {
  const n = (name || "").trim().toLowerCase();
  if (n === "execute" || n === "ship-execute") return "ship-execute";
  if (n === "review" || n === "ship-review") return "ship-review";
  return null;
}

/**
 * Normalize a concrete stage name. Returns
 * `{ stage, key, wave, iter, terminal, entry, selfLoop }` or null when the
 * stage isn't in the pipeline's vocabulary.
 */
export function normalizeStage(pipeline, stage) {
  const patterns = STAGE_PATTERNS[pipeline];
  if (!patterns || typeof stage !== "string") return null;
  for (const { re, key } of patterns) {
    const m = stage.match(re);
    if (!m) continue;
    const node = GRAPH[pipeline][key];
    return {
      stage,
      key,
      wave: m.groups?.wave ? parseInt(m.groups.wave, 10) : null,
      iter: m.groups?.iter ? parseInt(m.groups.iter, 10) : null,
      terminal: !!node.terminal,
      entry: !!node.entry,
      selfLoop: !!node.selfLoop,
    };
  }
  return null;
}

export function isTerminalStage(pipeline, stage) {
  return !!normalizeStage(pipeline, stage)?.terminal;
}

export function knownStages(pipeline) {
  return Object.keys(GRAPH[pipeline] || {});
}

/**
 * Validate the transition `from → to` for a pipeline.
 *
 * `from` may be null (no cursor yet) — then `to` must be an entry stage.
 * Returns `{ ok: true }` or `{ ok: false, reason }`.
 *
 * Wave rule: when both sides carry wave numbers the wave must match,
 * except on edges listed in the from-node's `waveAdvance` (gate → next
 * wave's dispatch), where to.wave must be from.wave + 1. When only `to`
 * carries a wave (`load → wave_N_dispatch` resume) any wave is accepted.
 */
export function validateTransition(pipeline, from, to) {
  const graph = GRAPH[pipeline];
  if (!graph) return { ok: false, reason: `unknown pipeline "${pipeline}"` };

  const toN = normalizeStage(pipeline, to);
  if (!toN) {
    return {
      ok: false,
      reason: `unknown stage "${to}" for ${pipeline} — known stage families: ${knownStages(pipeline).join(", ")}`,
    };
  }

  if (from == null || from === "") {
    if (!toN.entry) {
      return {
        ok: false,
        reason: `no existing cursor — first stage must be an entry stage (${Object.entries(graph)
          .filter(([, v]) => v.entry)
          .map(([k]) => k)
          .join(", ")}), got "${to}"`,
      };
    }
    return { ok: true };
  }

  const fromN = normalizeStage(pipeline, from);
  if (!fromN) {
    // Existing cursor carries a stage we don't recognize (older plugin
    // version / hand edit). Refuse rather than guess — --force exists.
    return { ok: false, reason: `current cursor stage "${from}" is not a known ${pipeline} stage` };
  }

  const fromNode = graph[fromN.key];
  const isSelf = fromN.key === toN.key;
  if (isSelf && !fromNode.selfLoop) {
    return { ok: false, reason: `stage "${from}" does not self-loop` };
  }
  if (!isSelf && !fromNode.next.includes(toN.key)) {
    return {
      ok: false,
      reason: `illegal transition ${from} → ${to} (from ${fromN.key}, allowed next: ${fromNode.next.join(", ") || "(terminal)"})`,
    };
  }

  // Wave arithmetic.
  if (fromN.wave != null && toN.wave != null) {
    const advances = (fromNode.waveAdvance || []).includes(toN.key);
    if (advances) {
      if (toN.wave !== fromN.wave + 1) {
        return {
          ok: false,
          reason: `wave must advance by exactly 1 on ${fromN.key} → ${toN.key} (got wave ${fromN.wave} → ${toN.wave})`,
        };
      }
    } else if (toN.wave !== fromN.wave) {
      return {
        ok: false,
        reason: `wave number must stay at ${fromN.wave} on ${fromN.key} → ${toN.key} (got ${toN.wave})`,
      };
    }
  }

  return { ok: true };
}
