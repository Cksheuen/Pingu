import test from "node:test";
import assert from "node:assert/strict";
import { visibleRange } from "../src/lib/virtual-rows.js";

const base = { scrollTop: 0, viewportHeight: 100, rowHeight: 20, count: 100, overscan: 0 };
test("top renders only the viewport", () => {
  assert.deepEqual(visibleRange(base), { start: 0, end: 5, offsetTop: 0, totalHeight: 2000 });
});
test("middle includes partially visible rows", () => {
  assert.deepEqual(visibleRange({ ...base, scrollTop: 205 }),
    { start: 10, end: 16, offsetTop: 200, totalHeight: 2000 });
});
test("bottom clamps after count shrinks", () => {
  assert.deepEqual(visibleRange({ ...base, scrollTop: 9000 }),
    { start: 95, end: 100, offsetTop: 1900, totalHeight: 2000 });
});
test("empty list has no spacer", () => {
  assert.deepEqual(visibleRange({ ...base, count: 0 }),
    { start: 0, end: 0, offsetTop: 0, totalHeight: 0 });
});
test("overscan expands both sides and clamps at boundaries", () => {
  assert.deepEqual(visibleRange({ ...base, scrollTop: 200, overscan: 3 }),
    { start: 7, end: 18, offsetTop: 140, totalHeight: 2000 });
  assert.equal(visibleRange({ ...base, overscan: 3 }).start, 0);
  assert.equal(visibleRange({ ...base, scrollTop: 1900, overscan: 3 }).end, 100);
});
