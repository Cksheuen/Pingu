import { invoke } from "@tauri-apps/api/core";

export async function getAutostart(): Promise<boolean> {
  return invoke("get_autostart");
}

export async function setAutostart(enabled: boolean): Promise<void> {
  return invoke("set_autostart", { enabled });
}

export async function getLanguage(): Promise<string> {
  return invoke("get_language");
}

export async function setLanguage(language: string): Promise<void> {
  return invoke("set_language", { language });
}
