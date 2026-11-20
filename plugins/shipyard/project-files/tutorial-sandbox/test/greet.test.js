import { test } from "node:test";
import assert from "node:assert/strict";
import { greet } from "../src/greet.js";

test("greets a person by name", () => {
  assert.equal(greet("Ada"), "Hello, Ada!");
});

test("greets without a name", () => {
  assert.equal(greet(), "Hello, there!");
  assert.equal(greet("   "), "Hello, there!");
});
