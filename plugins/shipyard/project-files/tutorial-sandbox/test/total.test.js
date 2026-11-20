import { test } from "node:test";
import assert from "node:assert/strict";
import { total } from "../src/total.js";

test("adds up prices times quantities", () => {
  assert.equal(total([{ price: 2.5, quantity: 2 }, { price: 1 }]), 6);
});

test("an empty order totals zero", () => {
  assert.equal(total([]), 0);
});

test("refuses a negative price", () => {
  assert.throws(() => total([{ price: -1 }]), RangeError);
});
