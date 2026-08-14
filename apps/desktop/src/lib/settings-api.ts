import type { GateLease, GateSettings } from "./types.js";
import { tauriInvoke } from "./tauri-invoke.js";

export async function getAutostart(): Promise<boolean> {
  return tauriInvoke("get_autostart");
}

export async function setAutostart(enabled: boolean): Promise<void> {
  return tauriInvoke("set_autostart", { enabled });
}

export async function getLanguage(): Promise<string> {
  return tauriInvoke("get_language");
}

export async function setLanguage(language: string): Promise<void> {
  return tauriInvoke("set_language", { language });
}

export async function getGateSettings(): Promise<GateSettings> {
  return tauriInvoke("get_gate_settings");
}

export async function configureGate(accessLink: string): Promise<GateSettings> {
  return tauriInvoke("configure_gate", { accessLink });
}

export async function setGateEnabled(enabled: boolean): Promise<GateSettings> {
  return tauriInvoke("set_gate_enabled", { enabled });
}

export async function renewGateLease(): Promise<GateLease> {
  return tauriInvoke("renew_gate_lease");
}
