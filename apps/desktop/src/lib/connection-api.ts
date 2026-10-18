import type { ProxyStatus } from "./types.js";
import { tauriInvoke } from "./tauri-invoke.js";

export async function connect(): Promise<void> {
  return await tauriInvoke("connect");
}

export async function disconnect(): Promise<void> {
  return await tauriInvoke("disconnect");
}

export async function getStatus(): Promise<ProxyStatus> {
  return await tauriInvoke("get_status");
}

export async function setNetworkMode(mode: "system" | "tun"): Promise<void> {
  return await tauriInvoke("set_network_mode", { mode });
}
