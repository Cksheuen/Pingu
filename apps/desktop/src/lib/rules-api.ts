import type { Rule, RuleGroup } from "./types.js";
import { tauriInvoke } from "./tauri-invoke.js";

export interface RuleStack {
  enabled_group_ids: string[];
  default_strategy: "direct" | "proxy";
}

export const getRuleStack = (): Promise<RuleStack> => tauriInvoke("get_rule_stack");
export const getEffectiveRules = (): Promise<RuleGroup> => tauriInvoke("get_effective_rules");
export const setRuleStack = (stack: RuleStack): Promise<void> => tauriInvoke("set_rule_stack", { stack });
export const updateRuleGroup = (group: RuleGroup): Promise<RuleGroup> => tauriInvoke("update_rule_group", { group });
export const deduplicateRules = (): Promise<void> => tauriInvoke("deduplicate_rules");

export async function listRules(): Promise<Rule[]> {
  return await tauriInvoke("list_rules");
}

export async function addRule(rule: Omit<Rule, "id">): Promise<void> {
  return await tauriInvoke("add_rule", { rule });
}

export async function deleteRule(id: string): Promise<void> {
  return await tauriInvoke("delete_rule", { id });
}

export async function setDefaultStrategy(strategy: string): Promise<void> {
  return await tauriInvoke("set_default_strategy", { strategy });
}

export async function listRuleGroups(): Promise<RuleGroup[]> {
  return await tauriInvoke("list_rule_groups");
}

export async function getActiveGroupId(): Promise<string> {
  return await tauriInvoke("get_active_group_id");
}

export async function setActiveGroup(id: string): Promise<void> {
  return await tauriInvoke("set_active_group", { id });
}

export async function createRuleGroup(name: string): Promise<RuleGroup> {
  return await tauriInvoke("create_rule_group", { name });
}

export async function deleteRuleGroup(id: string): Promise<void> {
  return await tauriInvoke("delete_rule_group", { id });
}

export async function renameRuleGroup(id: string, name: string): Promise<void> {
  return await tauriInvoke("rename_rule_group", { id, name });
}
