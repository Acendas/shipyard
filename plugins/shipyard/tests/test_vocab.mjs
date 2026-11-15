// F022: the one vocabulary table. Pins the alias rows of terminology-v4 (A-01..A-08).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENTITIES, entityForVerb, entityForNextIdKind, entityOfId, isBuilderRecord,
  EVENT_ALIASES, canonicalEventType, eventTypeAliases, eventMatches, RETIRED_TERMS, TASK_KINDS, STEP_KINDS,
} from "../bin/vocab.mjs";

test("A-01/A-04: story verbs and next-id kinds accept the old words, canonical first", () => {
  assert.deepEqual([...ENTITIES.story.verbs], ["story", "feature", "bug"]);
  assert.equal(entityForVerb("feature"), "story");
  assert.equal(entityForVerb("bug"), "story");
  assert.equal(entityForVerb("story"), "story");
  assert.equal(entityForNextIdKind("features"), "story");
  assert.equal(entityForNextIdKind("bugs"), "story");
  assert.equal(entityForNextIdKind("stories"), "story");
  assert.deepEqual([...ENTITIES.story.dir], ["spec", "stories"]);
});

test("A-02/A-06: steps are the builder unit; tasks are the new entity", () => {
  assert.equal(entityForNextIdKind("steps"), "step");
  assert.equal(entityForNextIdKind("tasks"), "task");
  assert.equal(entityForVerb("step"), "step");
  assert.equal(entityForVerb("task"), "task");
  assert.equal(ENTITIES.step.prefix, "P");
  assert.equal(ENTITIES.task.prefix, "T");
  assert.equal(entityForVerb("nope"), null);
  assert.equal(entityForNextIdKind("quick-tasks"), null);
});

test("I-1..I-5: id shapes classify, T### stays ambiguous until the record is read", () => {
  assert.equal(entityOfId("S012"), "story");
  assert.equal(entityOfId("S012a"), "story");
  assert.equal(entityOfId("F071d"), "story");
  assert.equal(entityOfId("B003"), "story");
  assert.equal(entityOfId("B-HOT-004"), "story");
  assert.equal(entityOfId("P007"), "step");
  assert.equal(entityOfId("T007"), "tasklike");
  assert.equal(entityOfId("Q-12"), "task");
  assert.equal(entityOfId("IDEA-045"), "idea");
  assert.equal(entityOfId("E002"), "epic");
  assert.equal(entityOfId("x"), null);
});

test("isBuilderRecord: legacy builder tasks and steps are builder units; new tasks are not", () => {
  assert.equal(isBuilderRecord({ type: "task", kind: "feature", feature: "F001" }), true);
  assert.equal(isBuilderRecord({ type: "task", kind: "operational", feature: "F001" }), true);
  assert.equal(isBuilderRecord({ type: "task", kind: "research", feature: "" }), true);
  assert.equal(isBuilderRecord({ type: "step", kind: "feature" }), true);
  assert.equal(isBuilderRecord({ type: "task", kind: "spike" }), false);
  assert.equal(isBuilderRecord({ type: "task", kind: "spike", feature: "S001" }), false, "a new task may point at a story and is still a task");
  assert.equal(isBuilderRecord({ type: "task", feature: "F001" }), true, "pre-v4 record with no kind but a feature pointer");
  assert.equal(isBuilderRecord({ type: "task" }), false);
  assert.equal(isBuilderRecord({ type: "feature" }), false);
  assert.equal(isBuilderRecord(null), false);
  for (const k of TASK_KINDS) assert.equal(isBuilderRecord({ type: "task", kind: k }), false, k);
  for (const k of STEP_KINDS) assert.equal(isBuilderRecord({ type: "task", kind: k }), true, k);
});

test("D-3/D-7: events are never rewritten; readers accept both spellings, writers get the new one", () => {
  assert.equal(canonicalEventType("patch_task_created"), "patch_step_created");
  assert.equal(canonicalEventType("feature_status_changed"), "story_status_changed");
  assert.equal(canonicalEventType("bug_created"), "story_created");
  assert.equal(canonicalEventType("story_created"), "story_created");
  assert.equal(canonicalEventType("task_dispatch_returned"), "task_dispatch_returned", "builder lifecycle events keep their names (A-02)");
  assert.equal(canonicalEventType("task_blocked"), "task_blocked");
  assert.deepEqual(eventTypeAliases("patch_step_created").sort(), ["patch_step_created", "patch_task_created"]);
  assert.deepEqual(eventTypeAliases("pipeline_tick_completed"), ["pipeline_tick_completed"]);
  assert.equal(eventMatches({ type: "patch_task_created" }, "patch_step_created"), true);
  assert.equal(eventMatches({ type: "patch_step_created" }, "patch_task_created"), true);
  assert.equal(eventMatches({ type: "bug_created" }, "patch_step_created", "story_created"), true);
  assert.equal(eventMatches({ type: "wave_check_passed" }, "patch_step_created"), false);
  for (const [o, n] of Object.entries(EVENT_ALIASES)) assert.notEqual(o, n);
});

test("retired-term list names a replacement for every entry and does not flag kept terms", () => {
  for (const t of RETIRED_TERMS) assert.ok(t.use.length > 0);
  const flagged = (s) => RETIRED_TERMS.some((t) => t.re.test(s));
  assert.equal(flagged("shipyard-data feature set-status F001 approved"), true);
  assert.equal(flagged("Read `spec/features/F001-x.md`"), true);
  assert.equal(flagged("/ship-quick"), true);
  assert.equal(flagged("B-HOT-003"), true);
  assert.equal(flagged("shipyard-data story set-status S001 approved"), false);
  assert.equal(flagged("spec/stories/S001-x.md"), false);
  assert.equal(flagged("a feature flag"), false, "the English word feature is not retired");
  assert.equal(flagged("shipyard-data task set-status T004 done"), false, "task verbs belong to the new entity");
  assert.equal(flagged("spec/tasks/T004-x.md"), false);
});
