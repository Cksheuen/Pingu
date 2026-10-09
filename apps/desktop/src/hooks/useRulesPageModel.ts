import { useCallback, useEffect, useRef, useState } from "react";
import { addRule, createRuleGroup, deleteRule, deleteRuleGroup, getActiveGroupId,
  listRuleGroups, listRules, renameRuleGroup, setActiveGroup, setDefaultStrategy } from "../lib/rules-api";
import { useConnectionStore } from "../lib/connection-store";
import { useRuntimeOperation } from "../lib/runtime-operation";
import { errorMessage } from "../lib/network-view";
import type { Rule, RuleGroup, Strategy } from "../lib/types";

export function useRulesPageModel() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [strategy, setStrategy] = useState<Strategy>("proxy");
  const [activeGroupId, setActiveGroupId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const request = useRef(0);
  const operation = useRuntimeOperation(s => s.command);

  const refresh = useCallback(async () => {
    const revision = ++request.current;
    const [nextGroups, nextActiveGroupId, nextRules] = await Promise.all([listRuleGroups(), getActiveGroupId(), listRules()]);
    if (revision !== request.current) return;
    setGroups(nextGroups); setActiveGroupId(nextActiveGroupId); setRules(nextRules);
    const group = nextGroups.find(g => g.id === nextActiveGroupId);
    if (group) setStrategy(group.default_strategy);
  }, []);
  useEffect(() => { void refresh().catch(e => setError(errorMessage(e))); }, [refresh]);

  // Publish only canonical readback. Failures remain visible and do not close
  // dialogs that still contain the user's unapplied input.
  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (busy.current || useRuntimeOperation.getState().command) throw new Error("A routing change is still in progress.");
    busy.current = true; setPending(true); setError(null); ++request.current;
    try { await action(); await refresh(); }
    catch (cause) {
      setError(errorMessage(cause));
      await refresh().catch(() => undefined);
      throw cause;
    } finally {
      await useConnectionStore.getState().refreshAll().catch(() => undefined);
      busy.current = false; setPending(false);
    }
  }, [refresh]);
  return {
    rules, groups, strategy, activeGroupId, error, pending: pending || !!operation,
    switchGroup: (id: string) => run(() => setActiveGroup(id)),
    createGroup: (name: string) => run(async () => {
      if (!name.trim()) return;
      const group = await createRuleGroup(name.trim()); await setActiveGroup(group.id);
    }),
    renameGroup: (id: string, name: string) => run(() => renameRuleGroup(id, name.trim())),
    deleteGroup: (id: string) => run(() => deleteRuleGroup(id)),
    changeStrategy: (next: Strategy) => run(() => setDefaultStrategy(next)),
    addRuleToActiveGroup: (rule: Omit<Rule, "id">) => run(() => addRule(rule)),
    deleteRuleFromActiveGroup: (id: string) => run(() => deleteRule(id)),
  };
}
