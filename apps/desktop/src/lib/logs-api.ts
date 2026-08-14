import type { LogEntry } from "./types.js";
import { tauriInvoke } from "./tauri-invoke.js";

export async function getLogs(): Promise<LogEntry[]> {
  try {
    return await tauriInvoke("get_logs");
  } catch (e) {
    console.warn("getLogs failed:", e);
    return [];
  }
}

export async function clearLogs(): Promise<void> {
  return await tauriInvoke("clear_logs");
}

export async function getLogFilePath(): Promise<string> {
  try {
    return await tauriInvoke("get_log_file_path");
  } catch (e) {
    console.warn("getLogFilePath failed:", e);
    return "~/.config/sing-proxy/logs/";
  }
}
