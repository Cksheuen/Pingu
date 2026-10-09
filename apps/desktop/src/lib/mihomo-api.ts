import { tauriInvoke } from "./tauri-invoke.js";

export interface SubscriptionSummary {
  nodes_only?: boolean;
  id: string;
  name: string;
  source_kind: "url" | "inline";
  source_host: string | null;
  enabled: boolean;
  proxy_count: number;
  group_count: number;
  rule_count: number;
  updated_at: string;
  last_error: string | null;
  warnings: string[];
}

export interface StrategyGroup {
  name: string;
  type: string;
  now: string | null;
  all: string[];
  alive: boolean;
  history: { time: string; delay: number }[];
}

export interface LiveConnection {
  id: string;
  host: string;
  destination_ip: string;
  destination_port: string;
  source_ip: string;
  network: string;
  type: string;
  process: string;
  chains: string[];
  rule: string;
  rule_payload: string;
  upload: number;
  download: number;
  start: string;
}

export interface ConnectionsSnapshot {
  upload_total: number;
  download_total: number;
  connections: LiveConnection[];
}

export const listSubscriptions = () => tauriInvoke<SubscriptionSummary[]>("list_subscriptions");
export const importSubscription = (name: string, input: string, nodesOnly = false) =>
  tauriInvoke<SubscriptionSummary>("import_subscription", { name, input, nodesOnly });
export const refreshSubscription = (id: string) =>
  tauriInvoke<SubscriptionSummary>("refresh_subscription", { id });
export const updateSubscription = (id: string, changes: { name?: string; enabled?: boolean }) =>
  tauriInvoke<SubscriptionSummary>("update_subscription", { id, ...changes });
export const deleteSubscription = (id: string) => tauriInvoke<void>("delete_subscription", { id });
export const listStrategyGroups = () => tauriInvoke<StrategyGroup[]>("list_strategy_groups");
export const selectStrategyProxy = (group: string, name: string) =>
  tauriInvoke<void>("select_strategy_proxy", { group, name });
export const testStrategyDelay = (name: string) => tauriInvoke<{ delay: number }>("test_strategy_delay", { name });
export const listConnections = () => tauriInvoke<ConnectionsSnapshot>("list_connections");
export const closeConnection = (id: string) => tauriInvoke<void>("close_connection", { id });
export const closeAllConnections = () => tauriInvoke<void>("close_all_connections");
