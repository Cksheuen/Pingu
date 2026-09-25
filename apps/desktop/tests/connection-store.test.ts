import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { useConnectionStore } from "../src/lib/connection-store.js";
import type { ProxyStatus } from "../src/lib/types.js";

const connected: ProxyStatus = {
  connected: true, active_node_id: "node-1", active_group_id: "group-1",
  active_group_name: "Work", uptime_seconds: 10,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let previousInvoke: typeof globalThis.__PINGU_TEST_INVOKE__;
beforeEach(() => {
  previousInvoke = globalThis.__PINGU_TEST_INVOKE__;
  useConnectionStore.setState({
    status: { ...connected }, nodes: [], proxyInfo: null, loaded: true, loading: false,
  });
});
afterEach(() => { globalThis.__PINGU_TEST_INVOKE__ = previousInvoke; });

function respond(handler: (command: string) => Promise<unknown>) {
  globalThis.__PINGU_TEST_INVOKE__ = async <T>(command: string) => await handler(command) as T;
}

test("concurrent status refreshes share one request and keep the last snapshot while pending", async () => {
  const response = deferred<ProxyStatus>();
  let calls = 0;
  respond(async (command) => { assert.equal(command, "get_status"); calls++; return response.promise; });
  const first = useConnectionStore.getState().refreshStatus();
  const second = useConnectionStore.getState().refreshStatus();
  assert.equal(calls, 1);
  assert.equal(useConnectionStore.getState().status.uptime_seconds, 10);
  const next = { ...connected, uptime_seconds: 11 };
  response.resolve(next);
  assert.deepEqual(await Promise.all([first, second]), [next, next]);
  assert.deepEqual(useConnectionStore.getState().status, next);
});

test("unchanged polling does not notify subscribers; a changed status does", async () => {
  let next = { ...connected };
  respond(async () => ({ ...next }));
  let notifications = 0;
  const unsubscribe = useConnectionStore.subscribe(() => notifications++);
  try {
    await useConnectionStore.getState().refreshStatus();
    assert.equal(notifications, 0);
    next = { ...next, active_node_id: "node-2" };
    await useConnectionStore.getState().refreshStatus();
    assert.equal(notifications, 1);
    assert.equal(useConnectionStore.getState().status.active_node_id, "node-2");
  } finally { unsubscribe(); }
});

test("failed status polling clears loading, preserves the last status, and allows retry", async () => {
  useConnectionStore.setState({ loaded: false, loading: true });
  let calls = 0;
  respond(async () => {
    if (++calls === 1) throw new Error("IPC unavailable");
    return { ...connected, uptime_seconds: 12 };
  });
  await assert.rejects(useConnectionStore.getState().refreshStatus(), /IPC unavailable/);
  assert.deepEqual(useConnectionStore.getState().status, connected);
  assert.equal(useConnectionStore.getState().loading, false);
  await useConnectionStore.getState().refreshStatus();
  assert.equal(calls, 2);
  assert.equal(useConnectionStore.getState().status.uptime_seconds, 12);
});

test("refreshAll starts independent requests together and publishes a complete snapshot", async () => {
  const status = deferred<unknown>();
  const nodes = deferred<unknown>();
  const proxy = deferred<unknown>();
  const pending: Record<string, Promise<unknown>> = {
    get_status: status.promise, list_nodes: nodes.promise, get_proxy_info: proxy.promise,
  };
  const calls: string[] = [];
  respond(async (command) => { calls.push(command); return pending[command]; });
  let notifications = 0;
  const unsubscribe = useConnectionStore.subscribe(() => notifications++);
  try {
    const refresh = useConnectionStore.getState().refreshAll();
    assert.deepEqual(calls.sort(), Object.keys(pending).sort());
    status.resolve({ ...connected, uptime_seconds: 20 });
    nodes.resolve([{ id: "node-1" }]);
    await Promise.resolve();
    assert.equal(notifications, 0);
    proxy.resolve({ listen_port: 2080 });
    await refresh;
    const snapshot = useConnectionStore.getState();
    assert.equal(notifications, 1);
    assert.equal(snapshot.status.uptime_seconds, 20);
    assert.equal(snapshot.nodes[0].id, "node-1");
    assert.equal(snapshot.proxyInfo?.listen_port, 2080);
  } finally { unsubscribe(); }
});

test("a failed status request in refreshAll leaves the previously published snapshot intact", async () => {
  const before = useConnectionStore.getState();
  respond(async (command) => {
    if (command === "get_status") throw new Error("status read failed");
    return command === "list_nodes" ? [] : { listen_port: 2081 };
  });
  await assert.rejects(useConnectionStore.getState().refreshAll(), /status read failed/);
  assert.equal(useConnectionStore.getState(), before);
});
