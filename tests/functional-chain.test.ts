import test from "node:test";
import assert from "node:assert/strict";

import { connect, disconnect, getStatus } from "../src/lib/connection-api.js";
import { useConnectionStore } from "../src/lib/connection-store.js";
import { clearLogs, getLogs, getLogFilePath } from "../src/lib/logs-api.js";
import { deleteNode, importNode, listNodes, setActiveNode } from "../src/lib/nodes-api.js";
import { getProxyInfo } from "../src/lib/proxy-api.js";
import {
  addRule,
  createRuleGroup,
  deleteRule,
  deleteRuleGroup,
  getActiveGroupId,
  listRuleGroups,
  listRules,
  renameRuleGroup,
  setActiveGroup,
  setDefaultStrategy,
} from "../src/lib/rules-api.js";
import { withRustInvokeHarness } from "./support/rustInvokeHarness.js";

const VALID_NODE_1 =
  "vless://123e4567-e89b-12d3-a456-426614174000@example.com:443?flow=xtls-rprx-vision&security=reality&sni=www.example.com&fp=chrome&pbk=AAAA&sid=1234&type=tcp#My%20Node";
const VALID_NODE_2 =
  "vless://123e4567-e89b-12d3-a456-426614174001@example.net:8443?security=tls&sni=cdn.example.net&type=tcp#Backup%20Node";
const VALID_NODE_3 =
  "vless://123e4567-e89b-12d3-a456-426614174002@edge.example.org:2053?security=tls&sni=edge.example.org&type=tcp#Ops%20Node";

type RuleInput = Parameters<typeof addRule>[0];

function ruleSignature(rule: RuleInput) {
  return `${rule.rule_type}:${rule.match_value}:${rule.outbound}`;
}

async function expectStatus(params: {
  connected: boolean;
  nodeId: string | null;
  groupId: string | null;
  groupName: string | null;
}) {
  const status = await getStatus();
  assert.equal(status.connected, params.connected);
  assert.equal(status.active_node_id, params.nodeId);
  assert.equal(status.active_group_id, params.groupId);
  assert.equal(status.active_group_name, params.groupName);
}

async function createGroupWithRules(name: string, strategy: "direct" | "proxy", rules: RuleInput[]) {
  const group = await createRuleGroup(name);
  await setActiveGroup(group.id);
  for (const rule of rules) {
    await addRule(rule);
  }
  await setDefaultStrategy(strategy);
  return group;
}

async function expectActiveRules(expectedRules: RuleInput[]) {
  const currentRules = await listRules();
  assert.deepEqual(
    currentRules.map(ruleSignature).sort(),
    expectedRules.map(ruleSignature).sort(),
  );
}

function resetConnectionStore() {
  useConnectionStore.setState({
    status: {
      connected: false,
      active_node_id: null,
      active_group_id: null,
      active_group_name: null,
      uptime_seconds: 0,
    },
    nodes: [],
    proxyInfo: null,
    loaded: false,
    loading: false,
  });
}

test("MC-01 前端 API 调用链可以走完整个稳定性闭环", async () => {
  await withRustInvokeHarness(async () => {
    resetConnectionStore();

    await useConnectionStore.getState().refreshAll();
    assert.equal(useConnectionStore.getState().status.connected, false);
    assert.deepEqual(useConnectionStore.getState().nodes, []);

    const imported = await importNode(VALID_NODE_1);
    assert.equal(imported.name, "My Node");

    const groupsBefore = await listRuleGroups();
    assert.ok(groupsBefore.length >= 1);

    const workGroup = await createRuleGroup("Work");
    await setActiveGroup(workGroup.id);
    await addRule({ rule_type: "geosite", match_value: "geolocation-cn", outbound: "direct" });
    await addRule({ rule_type: "domain_suffix", match_value: "example.com", outbound: "proxy" });
    await addRule({ rule_type: "ip_is_private", match_value: "true", outbound: "direct" });
    await setDefaultStrategy("direct");

    await connect();
    await useConnectionStore.getState().refreshAll();

    const connectedState = useConnectionStore.getState();
    assert.equal(connectedState.status.connected, true);
    assert.equal(connectedState.status.active_node_id, imported.id);
    assert.equal(connectedState.status.active_group_id, workGroup.id);
    assert.equal(connectedState.status.active_group_name, "Work");
    assert.ok((connectedState.proxyInfo?.terminal_commands.length ?? 0) > 0);

    const logsAfterConnect = await getLogs();
    assert.ok(logsAfterConnect.length >= 1);
    assert.match(logsAfterConnect[0].message, /Connected to/);

    const secondNode = await importNode(VALID_NODE_2);
    await setActiveNode(secondNode.id);
    const travelGroup = await createRuleGroup("Travel");
    await renameRuleGroup(travelGroup.id, "Travel Renamed");
    await setActiveGroup(travelGroup.id);
    await addRule({ rule_type: "domain", match_value: "api.example.com", outbound: "proxy" });

    const rulesBeforeDelete = await listRules();
    assert.equal(rulesBeforeDelete.length, 1);
    await deleteRule(rulesBeforeDelete[0].id);
    await setDefaultStrategy("proxy");

    const statusAfterReloads = await getStatus();
    assert.equal(statusAfterReloads.connected, true);
    assert.equal(statusAfterReloads.active_node_id, secondNode.id);
    assert.equal(statusAfterReloads.active_group_name, "Travel Renamed");

    const proxyInfo = await getProxyInfo();
    assert.equal(proxyInfo.listen_port, 2080);

    const logPath = await getLogFilePath();
    assert.match(logPath, /sing-proxy/);

    await clearLogs();
    assert.deepEqual(await getLogs(), []);

    await disconnect();
    await useConnectionStore.getState().refreshAll();
    assert.equal(useConnectionStore.getState().status.connected, false);
  });
}, { concurrency: false });

test("MC-02 前端 API 调用链可以覆盖失败后修正恢复", async () => {
  await withRustInvokeHarness(async () => {
    resetConnectionStore();

    await assert.rejects(() => connect(), /No active node selected/);
    await assert.rejects(() => importNode("not-a-vless-uri"), /Invalid|vless/i);

    const recoveredNode = await importNode(VALID_NODE_1);
    assert.equal(recoveredNode.name, "My Node");
    await assert.rejects(() => setActiveNode("missing-node"), /Node not found/);
    await assert.rejects(() => setActiveGroup("missing-group"), /Group not found/);

    const recoveredGroup = await createRuleGroup("Recovered");
    await setActiveGroup(recoveredGroup.id);
    await addRule({ rule_type: "geosite", match_value: "geolocation-cn", outbound: "direct" });
    await addRule({ rule_type: "domain_suffix", match_value: "example.com", outbound: "proxy" });
    await setDefaultStrategy("direct");

    await connect();
    const status = await getStatus();
    assert.equal(status.connected, true);
    assert.equal(status.active_node_id, recoveredNode.id);
    assert.equal(status.active_group_name, "Recovered");

    await clearLogs();
    assert.deepEqual(await getLogs(), []);

    await disconnect();
    assert.equal((await getStatus()).connected, false);
  });
}, { concurrency: false });

test("MC-03 前端 API 调用链可以覆盖增量配置、回收与回退", async () => {
  await withRustInvokeHarness(async () => {
    resetConnectionStore();

    const node1 = await importNode(VALID_NODE_1);
    const node2 = await importNode(VALID_NODE_2);
    await setActiveNode(node2.id);

    const workGroup = await createRuleGroup("Work");
    const travelGroup = await createRuleGroup("Travel");
    await setActiveGroup(travelGroup.id);
    await addRule({ rule_type: "geosite", match_value: "geolocation-cn", outbound: "direct" });
    await addRule({ rule_type: "geoip", match_value: "cn", outbound: "direct" });
    await addRule({ rule_type: "domain", match_value: "api.example.com", outbound: "proxy" });
    await addRule({ rule_type: "ip_cidr", match_value: "10.0.0.0/8", outbound: "proxy" });
    await setDefaultStrategy("proxy");

    await connect();
    assert.equal((await getStatus()).active_node_id, node2.id);

    await setActiveNode(node1.id);
    await setActiveGroup(workGroup.id);
    await addRule({ rule_type: "domain_suffix", match_value: "corp.example.com", outbound: "proxy" });
    await setDefaultStrategy("direct");

    const activeGroupId = await getActiveGroupId();
    assert.equal(activeGroupId, workGroup.id);
    assert.equal((await getStatus()).active_group_id, workGroup.id);

    await disconnect();

    await setActiveGroup(travelGroup.id);
    const travelRules = await listRules();
    assert.equal(travelRules.length, 4);
    await deleteRule(travelRules[0].id);
    await deleteRuleGroup(travelGroup.id);
    await deleteNode(node1.id);

    const nodesAfterDelete = await listNodes();
    assert.equal(nodesAfterDelete.length, 1);
    assert.equal(nodesAfterDelete[0].id, node2.id);

    const groupsAfterDelete = await listRuleGroups();
    assert.ok(groupsAfterDelete.every((group) => group.id !== travelGroup.id));

    await connect();
    const recoveredStatus = await getStatus();
    assert.equal(recoveredStatus.connected, true);
    assert.equal(recoveredStatus.active_node_id, node2.id);
    assert.notEqual(recoveredStatus.active_group_id, travelGroup.id);
  });
}, { concurrency: false });

test("MC-04 前端 API 调用链可以覆盖多节点多规则组排列组合与在线回退", async () => {
  await withRustInvokeHarness(async () => {
    resetConnectionStore();

    const defaultGroups = await listRuleGroups();
    assert.ok(defaultGroups.length >= 1);

    const node1 = await importNode(VALID_NODE_1);
    const node2 = await importNode(VALID_NODE_2);
    const node3 = await importNode(VALID_NODE_3);

    const workRules: RuleInput[] = [
      { rule_type: "geosite", match_value: "geolocation-cn", outbound: "direct" },
      { rule_type: "geoip", match_value: "cn", outbound: "direct" },
      { rule_type: "domain_suffix", match_value: "corp.example.com", outbound: "proxy" },
      { rule_type: "ip_is_private", match_value: "true", outbound: "direct" },
    ];
    const travelRules: RuleInput[] = [
      { rule_type: "domain", match_value: "api.example.com", outbound: "proxy" },
      { rule_type: "ip_cidr", match_value: "10.0.0.0/8", outbound: "proxy" },
    ];
    const emergencyRules: RuleInput[] = [
      { rule_type: "domain_suffix", match_value: "internal.example.org", outbound: "direct" },
      { rule_type: "domain", match_value: "blocked.example.org", outbound: "proxy" },
      { rule_type: "geoip", match_value: "private", outbound: "direct" },
    ];

    const workGroup = await createGroupWithRules("Work Matrix", "direct", workRules);
    const travelGroup = await createGroupWithRules("Travel Matrix", "proxy", travelRules);
    const emergencyGroup = await createGroupWithRules("Emergency Matrix", "direct", emergencyRules);

    await setActiveNode(node1.id);
    await setActiveGroup(workGroup.id);
    await connect();
    await expectStatus({
      connected: true,
      nodeId: node1.id,
      groupId: workGroup.id,
      groupName: "Work Matrix",
    });
    await expectActiveRules(workRules);

    const matrix = [
      { nodeId: node2.id, groupId: travelGroup.id, groupName: "Travel Matrix", rules: travelRules },
      { nodeId: node3.id, groupId: emergencyGroup.id, groupName: "Emergency Matrix", rules: emergencyRules },
      { nodeId: node1.id, groupId: emergencyGroup.id, groupName: "Emergency Matrix", rules: emergencyRules },
      { nodeId: node3.id, groupId: workGroup.id, groupName: "Work Matrix", rules: workRules },
    ];

    let previousLogCount = (await getLogs()).length;
    for (const step of matrix) {
      await setActiveNode(step.nodeId);
      await setActiveGroup(step.groupId);
      await expectStatus({
        connected: true,
        nodeId: step.nodeId,
        groupId: step.groupId,
        groupName: step.groupName,
      });
      await expectActiveRules(step.rules);

      const logs = await getLogs();
      assert.ok(logs.length >= previousLogCount + 2);
      previousLogCount = logs.length;
    }

    await deleteNode(node3.id);
    await expectStatus({
      connected: true,
      nodeId: node1.id,
      groupId: workGroup.id,
      groupName: "Work Matrix",
    });

    const groupsBeforeEmergencyDelete = await listRuleGroups();
    const expectedFallbackGroup = groupsBeforeEmergencyDelete.find((group) => group.id !== emergencyGroup.id);
    if (!expectedFallbackGroup) {
      throw new Error("expected a fallback group before deleting the active group");
    }

    await setActiveGroup(emergencyGroup.id);
    await deleteRuleGroup(emergencyGroup.id);
    await expectStatus({
      connected: true,
      nodeId: node1.id,
      groupId: expectedFallbackGroup.id,
      groupName: expectedFallbackGroup.name,
    });

    await assert.rejects(() => setActiveGroup(emergencyGroup.id), /Group not found/);

    await useConnectionStore.getState().refreshAll();
    const storeState = useConnectionStore.getState();
    assert.equal(storeState.status.active_node_id, node1.id);
    assert.equal(storeState.status.active_group_id, expectedFallbackGroup.id);
    assert.equal(storeState.nodes.length, 2);
    assert.equal(storeState.status.connected, true);

    const remainingGroups = await listRuleGroups();
    assert.ok(remainingGroups.some((group) => group.id === workGroup.id));
    assert.ok(remainingGroups.some((group) => group.id === travelGroup.id));
    assert.ok(remainingGroups.every((group) => group.id !== emergencyGroup.id));

    await disconnect();
    await expectStatus({
      connected: false,
      nodeId: null,
      groupId: null,
      groupName: null,
    });
  });
}, { concurrency: false });
