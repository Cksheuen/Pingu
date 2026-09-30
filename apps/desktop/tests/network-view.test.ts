import test from "node:test";
import assert from "node:assert/strict";
import type { LiveConnection } from "../src/lib/mihomo-api.js";
import { filterConnections, strategyKind } from "../src/lib/network-view.js";

const connection = (id: string, values: Partial<LiveConnection> = {}): LiveConnection => ({
  id, host: "example.org", destination_ip: "203.0.113.4", destination_port: "443", source_ip: "127.0.0.1",
  network: "tcp", type: "HTTP", process: "Safari", chains: ["Personal / Tokyo", "AUTO"], rule: "DomainSuffix",
  rule_payload: "example.org", upload: 100, download: 1000, start: "2026-09-24T10:00:00Z", ...values,
});

test("connection search combines app, rule, and route terms with network filtering", () => {
  const rows = [connection("browser"), connection("udp", { network: "udp", process: "Music" }), connection("direct", { chains: ["DIRECT"] })];
  assert.deepEqual(filterConnections(rows, "  SAFARI tokyo DomainSuffix  ", "tcp", "traffic").map((row) => row.id), ["browser"]);
  assert.deepEqual(filterConnections(rows, "203.0.113.4", "udp", "traffic").map((row) => row.id), ["udp"]);
  assert.deepEqual(filterConnections(rows, "missing app", "all", "traffic"), []);
});

test("connection sorting follows transferred bytes or start time without reordering the live snapshot", () => {
  const rows = [connection("older", { upload: 9000 }), connection("newer", { start: "2026-09-24T11:00:00Z" })];
  assert.deepEqual(filterConnections(rows, "", "all", "traffic").map((row) => row.id), ["older", "newer"]);
  assert.deepEqual(filterConnections(rows, "", "all", "recent").map((row) => row.id), ["newer", "older"]);
  assert.deepEqual(rows.map((row) => row.id), ["older", "newer"]);
});

test("automatic and unknown strategy groups never expose manual selection controls", () => {
  assert.equal(strategyKind("Selector"), "manual");
  for (const type of ["URLTest", "url-test", "Fallback", "LoadBalance", "NewFutureGroup"]) {
    assert.notEqual(strategyKind(type), "manual");
  }
});
