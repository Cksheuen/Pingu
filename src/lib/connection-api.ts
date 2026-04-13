import type { ProxyStatus } from "./types.js";
import { tauriInvoke } from "./tauri-invoke.js";

export async function connect(): Promise<void> {
  return await tauriInvoke("connect");
}

export async function disconnect(): Promise<void> {
  return await tauriInvoke("disconnect");
}

export async function getStatus(): Promise<ProxyStatus> {
  try {
    return await tauriInvoke("get_status");
  } catch (e) {
    console.warn("getStatus failed:", e);
    return {
      connected: false,
      active_node_id: null,
      active_group_id: null,
      active_group_name: null,
      uptime_seconds: 0,
    };
  }
}
