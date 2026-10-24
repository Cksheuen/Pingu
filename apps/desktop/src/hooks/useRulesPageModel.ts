import { runOptimistic } from "../lib/optimistic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createRuleGroup,
  deleteRuleGroup,
  listRuleGroups,
  setDefaultStrategy,
  getRuleStack,
  setRuleStack,
  updateRuleGroup,
  deduplicateRules,
  type RuleStack
} from "../lib/rules-api";
import { useConnectionStore } from "../lib/connection-store";
import { useRuntimeOperation } from "../lib/runtime-operation";
import { errorMessage } from "../lib/network-view";
import type { RuleGroup, Strategy } from "../lib/types";

export function useRulesPageModel() {
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [stack, setStack] = useState<RuleStack>({ enabled_group_ids: [], default_strategy: "proxy" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const request = useRef(0);
  const operation = useRuntimeOperation(s => s.command);

  const refresh = useCallback(
    async () => {
      const revision = ++request.current;
      const [nextGroups, nextStack] = await Promise.all([listRuleGroups(), getRuleStack()]);
      if (revision !== request.current) return;
      setGroups(nextGroups);
      setStack(nextStack);
    },
    []
  );
  useEffect(() => { void refresh().catch(e => setError(errorMessage(e))).finally(() => setLoading(false)); }, [refresh]);

  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      if (busy.current || useRuntimeOperation.getState().command) throw new Error("A routing change is still in progress.");
      busy.current = true;
      setPending(true);
      setError(null);
      ++request.current;
      try {
        const result = await action();
        await refresh();
        return result;
      }
      catch (cause) {
        setError(errorMessage(cause));
        await refresh().catch(() => undefined);
        throw cause;
      } finally {
        await useConnectionStore.getState().refreshAll().catch(() => undefined);
        busy.current = false;
        setPending(false);
      }
    },
    [refresh]
  );
  return {
    loading,
    groups,
    stack,
    strategy: stack.default_strategy,
    error,
    pending: pending || !!operation,
    setEnabledGroups: (ids: string[]) => run(() => runOptimistic({
      apply: () => setStack({ ...stack, enabled_group_ids: ids }),
      commit: () => setRuleStack({ ...stack, enabled_group_ids: ids }),
      rollback: () => setStack(stack),
    })),
    deduplicate: () => run(deduplicateRules),
    createGroup: (name: string) => run(() => createRuleGroup(name.trim())),
    updateGroup: (group: RuleGroup) => run(() => updateRuleGroup(group)),
    deleteGroup: (id: string) => run(() => deleteRuleGroup(id)),
    changeStrategy: (next: Strategy) => run(() => setDefaultStrategy(next)),
  };
}
