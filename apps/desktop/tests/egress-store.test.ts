import test from "node:test";
import assert from "node:assert/strict";
import { useEgressStore } from "../src/lib/egress-store.js";
import { runtimeOperation } from "../src/lib/runtime-operation.js";
import type { EgressState } from "../src/lib/egress-api.js";

const state = (selected: string): EgressState => ({
  management: { target: "test", ssh_config: "", proxy_server: "vps.example.com" },
  selected, selected_proxy: null, eligible_proxy: "VPS", installed: true, exits: [], error: null,
  magpie: { available: true, providers: [], references: {}, web_url: null, error: null },
});

test("a late status response cannot undo a completed exit selection", async () => {
  let finish!: (s: EgressState) => void;
  globalThis.__PINGU_TEST_INVOKE__ = <T>() => new Promise<T>(resolve => { finish = value => resolve(value as T); });
  const pending = useEgressStore.getState().refresh();
  await useEgressStore.getState().execute(async () => state("cloudflare"));
  finish(state("direct")); await pending;
  assert.equal(useEgressStore.getState().data?.selected, "cloudflare");
});

test("failed remote deletion reads back the successful local direct fallback", async () => {
  useEgressStore.setState({ data: state("cloudflare") });
  globalThis.__PINGU_TEST_INVOKE__ = async <T>() => state("direct") as T;
  const ok = await useEgressStore.getState().execute(async () => { throw new Error("remote cleanup failed"); });
  assert.equal(ok, false);
  assert.equal(useEgressStore.getState().data?.selected, "direct");
  assert.equal(useEgressStore.getState().error, "remote cleanup failed");
  assert.equal(useEgressStore.getState().busy, false);
});

test("exit creation serializes with connection and routing changes", async () => {
  let finish!: () => void;
  const pending = runtimeOperation("create_cloudflare_egress", () => new Promise<void>(resolve => { finish = resolve; }));
  let changed = false;
  await assert.rejects(runtimeOperation("select_strategy_proxy", async () => { changed = true; }), /in progress/);
  await assert.rejects(runtimeOperation("delete_cloudflare_egress", async () => { changed = true; }), /in progress/);
  assert.equal(changed, false);
  finish(); await pending;
});
