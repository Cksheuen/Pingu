import type { ProxyInfo } from "./types.js";
import { tauriInvoke } from "./tauri-invoke.js";

export async function getProxyInfo(): Promise<ProxyInfo> {
  try {
    return await tauriInvoke("get_proxy_info");
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
