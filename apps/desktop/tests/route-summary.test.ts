import test from "node:test";
import assert from "node:assert/strict";
import { buildRouteSteps, type RouteSummaryInput } from "../src/lib/route-summary.js";
import type { ChainSnapshot, ChainRuntime } from "../src/lib/chain-api.js";
import type { EgressState } from "../src/lib/egress-api.js";

const chain: ChainSnapshot = {
  settings: { enabled: true, entry: { kind: "manual", node_id: "entry" },
    exit: { kind: "subscription", subscription_id: "source", proxy_name: "Exit" } },
  choices: [{ reference: { kind: "manual", node_id: "entry" }, name: "Entry",
    source: "Manual", protocol: "vless", unavailable_reason: null }],
};
const egress: EgressState = {
  management: { target: "vps", proxy_server: "vps.example", ssh_config: "" },
  selected: "direct", selected_proxy: null, eligible_proxy: "VPS", installed: true, exits: [], error: null,
  magpie: { available: false, providers: [], references: {}, web_url: null, error: null },
};
const input = (overrides: Partial<RouteSummaryInput> = {}): RouteSummaryInput => ({
  status: { connected: true, phase: "connected", network_mode: "system", routing_revision: 1,
    active_node_id: "one", active_node_name: "Single", active_group_id: null, active_group_name: null,
    uptime_seconds: 0 },
  chain: { settings: { enabled: false, entry: null, exit: null }, choices: [] },
  runtime: { route: "chain", checked_at: null }, egress, activeNodeName: "Saved node", ...overrides,
});

test("single node route uses the runtime node name and VPS direct exit", () => {
  const result = buildRouteSteps(input());
  assert.deepEqual(result.steps.map(step => step.id), ["mac", "node", "egress", "internet"]);
  assert.equal(result.steps[1].label, "Single");
  assert.equal(result.steps[1].path, "/route#chain");
  assert.equal(result.steps[2].labelKey, "egress.direct");
  assert.equal(result.fallback, false);
});

test("disconnected configuration does not claim runtime fallback", () => {
  const options = input({ chain, runtime: { route: "entry", checked_at: null } });
  options.status = { ...options.status, connected: false, phase: "disconnected", active_node_name: null };
  const result = buildRouteSteps(options);
  assert.equal(result.fallback, false);
  assert.equal(result.steps.some(step => step.skipped), false);
  assert.equal(result.steps[1].label, "Entry");
});

test("chain resolves manual and subscription references and marks either skipped hop", () => {
  for (const route of ["chain", "entry", "exit"] as ChainRuntime["route"][]) {
    const result = buildRouteSteps(input({ chain, runtime: { route, checked_at: null } }));
    assert.deepEqual(result.steps.map(step => step.id), ["mac", "entry", "exit", "egress", "internet"]);
    assert.equal(result.steps[1].label, "Entry");
    assert.equal(result.steps[2].label, "Exit");
    assert.equal(result.fallback, route !== "chain");
    assert.equal(result.steps[1].skipped, route === "exit");
    assert.equal(result.steps[2].skipped, route === "entry");
  }
});

test("subscription mode shows the strategy hop even with a configured chain", () => {
  const options = input({ chain, activeNodeName: null });
  options.status = { ...options.status, active_node_id: "__subscriptions__", active_node_name: null };
  const result = buildRouteSteps(options);
  assert.equal(result.steps[1].labelKey, "home.subscription_route");
  assert.equal(result.steps[1].captionKey, "route.strategy");
  assert.equal(result.steps.some(step => step.id === "entry"), false);
});

test("selected Cloudflare exit is matched by id and includes its public IP", () => {
  const result = buildRouteSteps(input({ egress: { ...egress, selected: "cf", exits: [{
    id: "cf", name: "West", ip: "203.0.113.1", ready: true, phase: "ready", location: null,
    checked_at: null, created_at: null, error: null,
  }] } }));
  assert.equal(result.steps[2].label, "West · 203.0.113.1");
  assert.equal(result.steps[2].path, "/route#egress");
});

test("unknown egress does not invent a direct route", () => {
  for (const state of [{ ...egress, selected: "missing" }, { ...egress, management: null }]) {
    const result = buildRouteSteps(input({ egress: state }));
    assert.equal(result.steps[2].labelKey, "route.unknown");
    assert.equal(result.steps[2].loading, false);
  }
});

test("first load produces skeleton flags; missing references become unknown after loading", () => {
  const options = input({ chain: null, runtime: null, egress: null, activeNodeName: null });
  options.status = { ...options.status, active_node_id: null, active_node_name: null, connected: false };
  assert.deepEqual(buildRouteSteps(options).steps.filter(step => step.loading).map(step => step.id),
    ["node", "egress"]);
  options.status.active_node_id = "__chain__";
  assert.deepEqual(buildRouteSteps(options).steps.filter(step => step.loading).map(step => step.id),
    ["entry", "exit", "egress"]);
  const missing = buildRouteSteps(input({ chain: { ...chain, choices: [] } }));
  assert.equal(missing.steps[1].labelKey, "route.unknown");
});

test("single node uses saved name when status omits it and shows no-node when neither is known", () => {
  const options = input();
  options.status.active_node_name = null;
  assert.equal(buildRouteSteps(options).steps[1].label, "Saved node");
  options.activeNodeName = null;
  assert.equal(buildRouteSteps(options).steps[1].labelKey, "home.no_node");
});
