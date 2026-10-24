import test from "node:test";
import assert from "node:assert/strict";
import { createLatest, runOptimistic } from "../src/lib/optimistic.js";

test("applies synchronously before commit and returns the committed result", async () => {
  const order: string[] = [];
  const pending = runOptimistic({
    apply: () => { order.push("apply"); },
    commit: async () => { order.push("commit"); return 42; },
    rollback: () => { order.push("rollback"); },
  });
  assert.deepEqual(order, ["apply", "commit"]);
  assert.equal(await pending, 42);
  assert.deepEqual(order, ["apply", "commit"]);
});

test("rolls state back on rejection and rethrows the original error", async () => {
  let state = "before";
  const error = new Error("commit failed");
  let rollbacks = 0;
  const pending = runOptimistic({
    apply: () => { state = "optimistic"; },
    commit: async () => { throw error; },
    rollback: () => { state = "before"; rollbacks++; },
  });
  assert.equal(state, "optimistic");
  await assert.rejects(pending, (caught: unknown) => caught === error);
  assert.equal(state, "before");
  assert.equal(rollbacks, 1);
});

test("a synchronous commit failure also rolls back", async () => {
  let rolledBack = false;
  await assert.rejects(runOptimistic({
    apply: () => {},
    commit: () => { throw new Error("sync failure"); },
    rollback: () => { rolledBack = true; },
  }), /sync failure/);
  assert.equal(rolledBack, true);
});

test("a stale rejection cannot roll back a newer optimistic state", async () => {
  const next = createLatest();
  let state = "before";
  let rejectOld!: (reason: Error) => void;
  const isOldLatest = next();
  const old = runOptimistic({
    apply: () => { state = "old"; },
    commit: () => new Promise<void>((_, reject) => { rejectOld = reject; }),
    rollback: () => { if (isOldLatest()) state = "before"; },
  });
  const isNewLatest = next();
  await runOptimistic({
    apply: () => { state = "new"; },
    commit: async () => {},
    rollback: () => { if (isNewLatest()) state = "old"; },
  });
  rejectOld(new Error("late failure"));
  await assert.rejects(old, /late failure/);
  assert.equal(state, "new");
  assert.equal(isOldLatest(), false);
  assert.equal(isNewLatest(), true);
});

test("a stale success cannot overwrite a newer result", async () => {
  const next = createLatest();
  let state = "before";
  let resolveOld!: (value: string) => void;
  const isLatest = next();
  const old = runOptimistic({
    apply: () => { state = "old"; },
    commit: () => new Promise<string>(resolve => { resolveOld = resolve; }),
    rollback: () => { if (isLatest()) state = "before"; },
  }).then(value => { if (isLatest()) state = value; });
  next();
  state = "new";
  resolveOld("stale server result");
  await old;
  assert.equal(state, "new");
});
