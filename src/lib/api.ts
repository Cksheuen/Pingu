import { invoke } from "@tauri-apps/api/core";
import type { Node, Rule, RuleGroup, ProxyStatus, ProxyInfo, LogEntry } from "./types";

export async function listNodes(): Promise<Node[]> {
  try {
    return await invoke("list_nodes");
  } catch (e) {
    console.warn("listNodes failed:", e);
    return [];
  }
}

export async function importNode(uri: string): Promise<Node> {
  return await invoke("import_node", { vlessUri: uri });
}

export async function deleteNode(id: string): Promise<void> {
  return await invoke("delete_node", { id });
}

export async function setActiveNode(id: string): Promise<void> {
  return await invoke("set_active_node", { id });
}

export async function connect(): Promise<void> {
  return await invoke("connect");
}

export async function disconnect(): Promise<void> {
  return await invoke("disconnect");
}

export async function getStatus(): Promise<ProxyStatus> {
  try {
    return await invoke("get_status");
  } catch (e) {
    console.warn("getStatus failed:", e);
    return { connected: false, active_node_id: null, uptime_seconds: 0 };
  }
}

export async function listRules(): Promise<Rule[]> {
  try {
    return await invoke("list_rules");
  } catch (e) {
    console.warn("listRules failed:", e);
    return [];
  }
}

export async function addRule(rule: Omit<Rule, "id">): Promise<void> {
  return await invoke("add_rule", { rule });
}

export async function deleteRule(id: string): Promise<void> {
  return await invoke("delete_rule", { id });
}

export async function setDefaultStrategy(strategy: string): Promise<void> {
  return await invoke("set_default_strategy", { strategy });
}

export async function listRuleGroups(): Promise<RuleGroup[]> {
  try { return await invoke("list_rule_groups"); } catch (e) { console.warn("listRuleGroups failed:", e); return []; }
}
export async function getActiveGroupId(): Promise<string> {
  try { return await invoke("get_active_group_id"); } catch (e) { console.warn("getActiveGroupId failed:", e); return ""; }
}
export async function setActiveGroup(id: string): Promise<void> {
  return await invoke("set_active_group", { id });
}
export async function createRuleGroup(name: string): Promise<RuleGroup> {
  return await invoke("create_rule_group", { name });
}
export async function deleteRuleGroup(id: string): Promise<void> {
  return await invoke("delete_rule_group", { id });
}
export async function renameRuleGroup(id: string, name: string): Promise<void> {
  return await invoke("rename_rule_group", { id, name });
}

export async function getProxyInfo(): Promise<ProxyInfo> {
  try {
    return await invoke("get_proxy_info");
  } catch (e) {
    console.warn("getProxyInfo failed:", e);
    return {
      listen_host: "127.0.0.1",
      listen_port: 2080,
      http_proxy: "http://127.0.0.1:2080",
      socks_proxy: "socks5://127.0.0.1:2080",
      terminal_commands: [
        "export http_proxy=http://127.0.0.1:2080",
        "export https_proxy=http://127.0.0.1:2080",
        "export all_proxy=socks5://127.0.0.1:2080",
      ],
      unset_commands: ["unset http_proxy https_proxy all_proxy"],
    };
  }
}

export async function getLogs(): Promise<LogEntry[]> {
  try {
    return await invoke("get_logs");
  } catch (e) {
    console.warn("getLogs failed:", e);
    return [];
  }
}

export async function clearLogs(): Promise<void> {
  return await invoke("clear_logs");
}

export async function getLogFilePath(): Promise<string> {
  try {
    return await invoke("get_log_file_path");
  } catch (e) {
    console.warn("getLogFilePath failed:", e);
    return "~/.config/sing-proxy/logs/";
  }
}
