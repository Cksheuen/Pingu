import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useSubscriptionStore } from "../src/lib/subscription-store.js";
import type { SubscriptionSummary } from "../src/lib/mihomo-api.js";

const source: SubscriptionSummary = { id: "source-1", name: "Personal", source_kind: "url", source_host: "example.org", enabled: true, proxy_count: 2, group_count: 1, rule_count: 0, updated_at: "2026-09-24T10:00:00Z", last_error: null, warnings: [] };
let previousInvoke: typeof globalThis.__PINGU_TEST_INVOKE__;
beforeEach(() => {
  previousInvoke = globalThis.__PINGU_TEST_INVOKE__;
  useSubscriptionStore.setState({ subscriptions: [source], loading: false, loaded: true, error: null });
});
afterEach(() => { globalThis.__PINGU_TEST_INVOKE__ = previousInvoke; });

test("a failed subscription refresh keeps visible sources and exposes failure, then retries", async () => {
  let calls = 0;
  globalThis.__PINGU_TEST_INVOKE__ = async <T>(command: string) => {
    assert.equal(command, "list_subscriptions");
    if (++calls === 1) throw new Error("Subscription storage unavailable");
    return [{ ...source, proxy_count: 5 }] as T;
  };
  await assert.rejects(useSubscriptionStore.getState().refresh(), /storage unavailable/);
  assert.deepEqual(useSubscriptionStore.getState().subscriptions, [source]);
  assert.equal(useSubscriptionStore.getState().error, "Subscription storage unavailable");
  assert.equal(useSubscriptionStore.getState().loading, false);
  await useSubscriptionStore.getState().refresh();
  assert.equal(useSubscriptionStore.getState().subscriptions[0].proxy_count, 5);
  assert.equal(useSubscriptionStore.getState().error, null);
});

test("home and subscription page share an in-flight read without replacing sources while pending", async () => {
  let resolve!: (sources: SubscriptionSummary[]) => void;
  const pending = new Promise<SubscriptionSummary[]>((done) => { resolve = done; });
  let calls = 0;
  globalThis.__PINGU_TEST_INVOKE__ = async <T>() => { calls++; return await pending as T; };
  const home = useSubscriptionStore.getState().refresh();
  const page = useSubscriptionStore.getState().refresh();
  assert.equal(calls, 1);
  assert.deepEqual(useSubscriptionStore.getState().subscriptions, [source]);
  resolve([]);
  await Promise.all([home, page]);
  assert.deepEqual(useSubscriptionStore.getState().subscriptions, []);
  assert.equal(useSubscriptionStore.getState().loaded, true);
});
