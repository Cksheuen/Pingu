import { create } from "zustand";

const commands = new Set([
  "connect", "disconnect", "reload_proxy", "set_active_node", "delete_node", "import_node",
  "set_active_group", "set_default_strategy", "add_rule", "delete_rule", "create_rule_group",
  "delete_rule_group", "rename_rule_group", "select_strategy_proxy", "save_proxy_chain", "auto_select_chain",
  "import_subscription", "refresh_subscription", "update_subscription", "delete_subscription",
  "create_host_override", "update_host_override", "delete_host_override", "toggle_host_override", "reset_host_overrides",
]);
export const useRuntimeOperation = create<{ command: string | null; revision: number }>(() => ({ command: null, revision: 0 }));

export async function runtimeOperation<T>(command: string, action: () => Promise<T>): Promise<T> {
  if (!commands.has(command)) return action();
  if (useRuntimeOperation.getState().command) throw new Error("Another connection or routing change is still in progress.");
  useRuntimeOperation.setState({ command });
  try { return await action(); }
  finally { useRuntimeOperation.setState(s => ({ command: null, revision: s.revision + 1 })); }
}
