/**
 * vocab — the ONE table for Shipyard's v4 vocabulary (F022; contract:
 * docs/references/shipyard/terminology-v4.md in the workspace).
 *
 *   idea  IDEA-###  spec/ideas/      raw, undecided
 *   epic  E###      spec/epics/      decided; membership derived from children
 *   story S###      spec/stories/    the deliverable; `type: feature | bug`
 *   task  T###      spec/tasks/      enabling work (spike, unblocker, study, debug, chore)
 *   step  P###      spec/steps/      hidden TDD builder unit created by ship-sprint
 *
 * Readers accept old and new; writers emit new. Legacy records stay where
 * they are and resolve through this table:
 *   F###  spec/features/   -> story `type: feature`
 *   B###  spec/bugs/       -> story `type: bug`
 *   B-HOT-### spec/bugs/   -> story `type: bug`, `lane: hotfix`
 *   T### builder records in spec/tasks/ (type task, kind feature|operational|
 *         research) -> step; migrate renames them to P### with `aliases:`
 *   Q-### spec/tasks/      -> task (ship-quick records)
 *
 * Leaf module: node built-ins only. Every other CLI imports from here instead
 * of spelling a directory, prefix or regex itself (parallel builders drifted
 * on exactly these spellings before — see the workspace memory note).
 */

export const STORY_ID_RE = /^S\d{3,}[a-z]?$/;
export const LEGACY_FEATURE_ID_RE = /^F\d{3,}[a-z]?$/;
export const LEGACY_BUG_ID_RE = /^B-?\d{3,}$/; // B003 or the older B-003 spelling
export const HOTFIX_ID_RE = /^B-HOT-\d+$/;
export const STEP_ID_RE = /^P\d{3,}$/;
export const TASK_ID_RE = /^T\d{3,}$/;
export const QUICK_ID_RE = /^Q-\d+$/;
export const IDEA_ID_RE = /^IDEA-\d{3,}$/;
export const EPIC_ID_RE = /^E\d{3,}$/;

/** Kinds a NEW task (enabling work) may carry. Anything else on a `type: task` record is a legacy builder unit. */
export const TASK_KINDS = Object.freeze(["spike", "unblocker", "study", "debug", "chore"]);
/** Kinds a builder unit (step, or legacy builder task) carries. */
export const STEP_KINDS = Object.freeze(["feature", "operational", "research"]);

/**
 * Entity table. `dir` is where NEW records are written; `legacy` lists where
 * old records are still read from (with the id shape that lives there).
 * `verbs` are the CLI entity words accepted for this entity (first = canonical).
 * `nextIdKinds` are the `next-id <kind>` spellings (first = canonical).
 */
export const ENTITIES = Object.freeze({
  story: Object.freeze({
    dir: Object.freeze(["spec", "stories"]),
    prefix: "S",
    idRe: STORY_ID_RE,
    legacy: Object.freeze([
      Object.freeze({ dir: Object.freeze(["spec", "features"]), idRe: LEGACY_FEATURE_ID_RE, type: "feature" }),
      Object.freeze({ dir: Object.freeze(["spec", "bugs"]), idRe: LEGACY_BUG_ID_RE, type: "bug" }),
      Object.freeze({ dir: Object.freeze(["spec", "bugs"]), idRe: HOTFIX_ID_RE, type: "bug", lane: "hotfix" }),
    ]),
    verbs: Object.freeze(["story", "feature", "bug"]),
    nextIdKinds: Object.freeze(["stories", "features", "bugs"]),
    eventPrefix: "story",
    legacyEventPrefixes: Object.freeze(["feature", "bug"]),
  }),
  step: Object.freeze({
    dir: Object.freeze(["spec", "steps"]),
    prefix: "P",
    idRe: STEP_ID_RE,
    legacy: Object.freeze([Object.freeze({ dir: Object.freeze(["spec", "tasks"]), idRe: TASK_ID_RE, builderOnly: true })]),
    verbs: Object.freeze(["step"]),
    nextIdKinds: Object.freeze(["steps"]),
    eventPrefix: "step",
    legacyEventPrefixes: Object.freeze(["task"]),
  }),
  task: Object.freeze({
    dir: Object.freeze(["spec", "tasks"]),
    prefix: "T",
    idRe: TASK_ID_RE,
    legacy: Object.freeze([Object.freeze({ dir: Object.freeze(["spec", "tasks"]), idRe: QUICK_ID_RE, type: "quick" })]),
    verbs: Object.freeze(["task"]),
    nextIdKinds: Object.freeze(["tasks"]),
    eventPrefix: "task",
    legacyEventPrefixes: Object.freeze(["quick"]),
  }),
  idea: Object.freeze({
    dir: Object.freeze(["spec", "ideas"]),
    prefix: "IDEA-",
    idRe: IDEA_ID_RE,
    legacy: Object.freeze([]),
    verbs: Object.freeze(["idea"]),
    nextIdKinds: Object.freeze(["ideas"]),
    eventPrefix: "idea",
    legacyEventPrefixes: Object.freeze([]),
  }),
  epic: Object.freeze({
    dir: Object.freeze(["spec", "epics"]),
    prefix: "E",
    idRe: EPIC_ID_RE,
    legacy: Object.freeze([]),
    verbs: Object.freeze(["epic"]),
    nextIdKinds: Object.freeze(["epics"]),
    eventPrefix: "epic",
    legacyEventPrefixes: Object.freeze([]),
  }),
});

/** CLI entity word (old or new) -> canonical entity name, or null. */
export function entityForVerb(word) {
  for (const [name, e] of Object.entries(ENTITIES)) if (e.verbs.includes(word)) return name;
  return null;
}

/** `next-id <kind>` word (old or new) -> canonical entity name, or null. */
export function entityForNextIdKind(kind) {
  for (const [name, e] of Object.entries(ENTITIES)) if (e.nextIdKinds.includes(kind)) return name;
  return null;
}

/**
 * Classify an id string. `T###` is ambiguous between a legacy builder unit and a
 * new task until the record is read, so it returns "tasklike"; callers resolve
 * it with isBuilderRecord(frontmatter).
 */
/** Story in any accepted spelling: S### (new), legacy F###/B###, hotfix B-HOT-###. One definition for every CLI. */
export function isStoryId(id) {
  return entityOfId(id) === "story";
}

/**
 * A wave unit as SPRINT.md names it: a step P### or a builder task T### / T-P### / T-HOT1.
 * `WAVE_UNIT_ID_SRC` is the unanchored source for parsers that match it inside a line.
 */
export const WAVE_UNIT_ID_SRC = "P\\d+|T-?[A-Za-z]{0,3}\\d+";
export const WAVE_UNIT_ID_RE = new RegExp(`^(?:${WAVE_UNIT_ID_SRC})$`);

export function entityOfId(id) {
  const s = String(id ?? "");
  if (STORY_ID_RE.test(s) || LEGACY_FEATURE_ID_RE.test(s) || LEGACY_BUG_ID_RE.test(s) || HOTFIX_ID_RE.test(s)) return "story";
  if (STEP_ID_RE.test(s)) return "step";
  if (TASK_ID_RE.test(s)) return "tasklike";
  if (QUICK_ID_RE.test(s)) return "task";
  if (IDEA_ID_RE.test(s)) return "idea";
  if (EPIC_ID_RE.test(s)) return "epic";
  return null;
}

/** A record (frontmatter object) is a builder unit: a step, or a legacy builder task. */
export function isBuilderRecord(fm) {
  if (!fm || typeof fm !== "object") return false;
  const type = String(fm.type ?? "").trim();
  const kind = String(fm.kind ?? "").trim();
  if (type === "step") return true;
  if (type !== "task" && type !== "") return false;
  if (STEP_KINDS.includes(kind)) return true;
  if (TASK_KINDS.includes(kind)) return false;
  // Pre-v4 builder files always carry `feature:`; a new task carries `parent:` (optional).
  return typeof fm.feature === "string" && fm.feature.trim() !== "";
}

/**
 * Event-name aliases: retired name -> emitted name. Only names whose old word
 * was retired by terminology-v4 (A-01, A-02, A-04). Builder lifecycle events
 * (task_dispatch_returned, task_blocked, task_loop_iteration,
 * task_commit_anchored, task_return_recorded) keep their names: A-02 renames
 * only patch_task_created. Historical events are NEVER rewritten; readers
 * compare through canonicalEventType().
 */
export const EVENT_ALIASES = Object.freeze({
  patch_task_created: "patch_step_created",
  feature_status_changed: "story_status_changed",
  feature_field_set: "story_field_set",
  feature_ref_added: "story_ref_added",
  feature_external_ref_added: "story_external_ref_added",
  feature_dep_added: "story_dep_added",
  feature_dep_removed: "story_dep_removed",
  feature_tasks_set: "story_steps_set",
  feature_tasks_cleared: "story_steps_cleared",
  feature_ac_ids_assigned: "story_ac_ids_assigned",
  feature_reviewed: "story_reviewed",
  bug_created: "story_created",
});

const EVENT_ALIASES_REVERSE = Object.freeze(Object.fromEntries(Object.entries(EVENT_ALIASES).map(([o, n]) => [n, o])));

/** Emitted (new) name for any event type. */
export function canonicalEventType(type) {
  const t = String(type ?? "");
  return EVENT_ALIASES[t] ?? t;
}

/** Every spelling (old and new) a reader must accept for `type`. */
export function eventTypeAliases(type) {
  const c = canonicalEventType(type);
  const old = EVENT_ALIASES_REVERSE[c];
  return old ? [c, old] : [c];
}

/** True when the event's type is `name` under either spelling. */
export function eventMatches(ev, ...names) {
  const c = canonicalEventType(ev?.type);
  return names.some((n) => canonicalEventType(n) === c);
}

/**
 * Terms a SHIPPED skill or agent may no longer use (tests/test_retired_terms.mjs).
 * Each entry: a regex and the replacement a reader should reach for.
 */
export const RETIRED_TERMS = Object.freeze([
  Object.freeze({ re: /spec\/features\//, use: "spec/stories/ (legacy spec/features/ is read, never written)" }),
  Object.freeze({ re: /spec\/bugs\//, use: "spec/stories/ with type: bug" }),
  Object.freeze({ re: /\bshipyard-data feature (set-status|set|add-ref|add-external-ref|add-dep|remove-dep|set-tasks|clear-tasks|record-proof|check-probes|assign-ac-ids)\b/, use: "shipyard-data story <verb>" }),
  Object.freeze({ re: /\bshipyard-data bug set-status\b/, use: "shipyard-data story set-status" }),
  Object.freeze({ re: /\bnext-id (features|bugs)\b/, use: "next-id stories" }),
  Object.freeze({ re: /\bship-bug\b/, use: "ship-discuss (bug refinement / hotfix lane)" }),
  Object.freeze({ re: /\bQ-(NNN|\d{3})\b/, use: "T### task ids" }),
  Object.freeze({ re: /\bB-HOT-?(NNN|\d{3})?\b/, use: "S### story ids with lane: hotfix" }),
  Object.freeze({ re: /\bpatch_task_created\b/, use: "patch_step_created" }),
  Object.freeze({ re: /\bquick-tasks?\b/, use: "tasks" }),
]);

/**
 * Does this event open (or belong to) a sprint's work window? (4.17.2)
 * A sprint drafted ahead is queued and promoted while the previous sprint is
 * still being reviewed, and those two events carry the NEXT sprint's id. Read
 * as the window's start they put the previous sprint's review inside the next
 * sprint's clock (sprint-012: 14 extra minutes, 5.71 points per hour instead
 * of 6.9).
 */
export const PRE_SPRINT_EVENTS = Object.freeze(new Set(["next_sprint_queued", "next_sprint_promoted"]));
export function inSprintWindow(e, sprintId) {
  return Boolean(e) && e.sprint === sprintId && !PRE_SPRINT_EVENTS.has(e.type);
}

/** A builder run started without the queue (a sprint built in place spawns `builder-<step>` directly). */
export function isStepSpawn(e) {
  return Boolean(e) && e.type === "agent_spawned" && typeof e.step === "string" && e.step.trim() !== "";
}

