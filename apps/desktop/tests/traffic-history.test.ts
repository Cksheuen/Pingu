import test from "node:test";
import assert from "node:assert/strict";
import { pushSample, sparklinePath } from "../src/lib/traffic-history.js";

test("history retains the newest 60 samples without mutating prior snapshots", () => {
  let history: number[] = [];
  for (let n = 0; n < 80; n++) history = pushSample(history, n);
  assert.equal(history.length, 60);
  assert.equal(history[0], 20);
  const previous = history.slice();
  assert.deepEqual(pushSample(history, 80, 3), [78, 79, 80]);
  assert.deepEqual(history, previous);
  assert.deepEqual(pushSample(history, 81, 1), [81]);
  assert.deepEqual(pushSample(history, 81, 0), []);
});

test("sparkline handles empty, single-value and zero histories", () => {
  assert.equal(sparklinePath([], 100, 20), "");
  assert.equal(sparklinePath([10], 100, 20), "M0,0 L100,0");
  assert.equal(sparklinePath([0], 100, 20), "M0,20 L100,20");
  assert.equal(sparklinePath([0, 0, 0], 100, 20), "M0,20 L50,20 L100,20");
});

test("sparkline scales samples into the viewport and sanitizes invalid traffic", () => {
  assert.equal(sparklinePath([0, 5, 10], 100, 20), "M0,20 L50,10 L100,0");
  assert.equal(sparklinePath([NaN, -5, Infinity, 10], 90, 20), "M0,20 L30,20 L60,20 L90,0");
  assert.equal(sparklinePath([10], 0, 20), "");
});
