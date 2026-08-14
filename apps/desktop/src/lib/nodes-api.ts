import type { Node } from "./types.js";
import { tauriInvoke } from "./tauri-invoke.js";

export async function listNodes(): Promise<Node[]> {
  try {
    return await tauriInvoke("list_nodes");
  } catch (e) {
    console.warn("listNodes failed:", e);
    return [];
  }
}

export async function importNode(uri: string): Promise<Node> {
  return await tauriInvoke("import_node", { vlessUri: uri });
}

export async function deleteNode(id: string): Promise<void> {
  return await tauriInvoke("delete_node", { id });
}

export async function setActiveNode(id: string): Promise<void> {
  return await tauriInvoke("set_active_node", { id });
}
