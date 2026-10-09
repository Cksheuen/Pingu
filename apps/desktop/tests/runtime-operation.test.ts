import test from "node:test";
import assert from "node:assert/strict";
import { runtimeOperation, useRuntimeOperation } from "../src/lib/runtime-operation.js";

test("a pending connect survives navigation and rejects a conflicting rule or node change", async () => {
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const connect = runtimeOperation("connect", () => wait);
  assert.equal(useRuntimeOperation.getState().command, "connect");
  let invoked = false;
  await assert.rejects(runtimeOperation("set_active_group", async () => { invoked = true; }), /in progress/);
  await assert.rejects(runtimeOperation("select_strategy_proxy", async () => { invoked = true; }), /in progress/);
  assert.equal(invoked, false);
  assert.equal(await runtimeOperation("get_status", async () => "verifying"), "verifying");
  finish(); await connect;
  assert.equal(useRuntimeOperation.getState().command, null);
});

test("failed changes release the operation and request canonical readback", async () => {
  const before = useRuntimeOperation.getState().revision;
  await assert.rejects(runtimeOperation("set_default_strategy", async () => { throw new Error("candidate rejected"); }), /candidate rejected/);
  assert.equal(useRuntimeOperation.getState().command, null);
  assert.equal(useRuntimeOperation.getState().revision, before + 1);
  assert.equal(await runtimeOperation("set_active_node", async () => "recovered"), "recovered");
});
