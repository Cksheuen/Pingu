import { useCallback, useEffect, useState } from "react";
import {
  addRule,
  createRuleGroup,
  deleteRule,
  deleteRuleGroup,
  getActiveGroupId,
  listRuleGroups,
  listRules,
  renameRuleGroup,
  setActiveGroup,
  setDefaultStrategy,
} from "../lib/rules-api";
import type { Rule, RuleGroup, Strategy } from "../lib/types";

interface RulesPageModel {
  rules: Rule[];
  groups: RuleGroup[];
  strategy: Strategy;
  activeGroupId: string;
  switchGroup: (id: string) => Promise<void>;
  createGroup: (name: string) => Promise<void>;
  renameGroup: (id: string, name: string) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  changeStrategy: (strategy: Strategy) => Promise<void>;
  addRuleToActiveGroup: (rule: Omit<Rule, "id">) => Promise<void>;
  deleteRuleFromActiveGroup: (id: string) => Promise<void>;
}

export function useRulesPageModel(): RulesPageModel {
  const [rules, setRules] = useState<Rule[]>([]);
  const [groups, setGroups] = useState<RuleGroup[]>([]);
  const [strategy, setStrategy] = useState<Strategy>("proxy");
  const [activeGroupId, setActiveGroupId] = useState("");

  const refreshGroupsAndRules = useCallback(async () => {
    const [nextGroups, nextActiveGroupId] = await Promise.all([listRuleGroups(), getActiveGroupId()]);
    const nextRules = await listRules();

    setGroups(nextGroups);
    setActiveGroupId(nextActiveGroupId);
    setRules(nextRules);

    const activeGroup = nextGroups.find((group) => group.id === nextActiveGroupId);
    if (activeGroup) {
      setStrategy(activeGroup.default_strategy);
    }
  }, []);

  useEffect(() => {
    void refreshGroupsAndRules();
  }, [refreshGroupsAndRules]);

  const switchGroup = useCallback(async (id: string) => {
    await setActiveGroup(id);
    setActiveGroupId(id);

    const [nextRules, nextGroups] = await Promise.all([listRules(), listRuleGroups()]);
    setRules(nextRules);
    setGroups(nextGroups);

    const activeGroup = nextGroups.find((group) => group.id === id);
    if (activeGroup) {
      setStrategy(activeGroup.default_strategy);
    }
  }, []);

  const createGroup = useCallback(
    async (name: string) => {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return;
      }

      const nextGroup = await createRuleGroup(trimmedName);
      await switchGroup(nextGroup.id);
    },
    [switchGroup]
  );

  const renameGroupById = useCallback(async (id: string, name: string) => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    await renameRuleGroup(id, trimmedName);
    const nextGroups = await listRuleGroups();
    setGroups(nextGroups);
  }, []);

  const deleteGroupById = useCallback(
    async (id: string) => {
      await deleteRuleGroup(id);
      await refreshGroupsAndRules();
    },
    [refreshGroupsAndRules]
  );

  const changeStrategy = useCallback(async (nextStrategy: Strategy) => {
    setStrategy(nextStrategy);

    try {
      await setDefaultStrategy(nextStrategy);
      const nextGroups = await listRuleGroups();
      setGroups(nextGroups);
    } catch {
      // Keep existing behavior: optimistic update stays even when request fails.
    }
  }, []);

  const addRuleToActiveGroup = useCallback(async (rule: Omit<Rule, "id">) => {
    await addRule(rule);
    const [nextRules, nextGroups] = await Promise.all([listRules(), listRuleGroups()]);
    setRules(nextRules);
    setGroups(nextGroups);
  }, []);

  const deleteRuleFromActiveGroup = useCallback(async (id: string) => {
    try {
      await deleteRule(id);
      setRules((prevRules) => prevRules.filter((rule) => rule.id !== id));
    } catch {
      // Keep existing behavior: ignore failed delete.
    }
  }, []);

  return {
    rules,
    groups,
    strategy,
    activeGroupId,
    switchGroup,
    createGroup,
    renameGroup: renameGroupById,
    deleteGroup: deleteGroupById,
    changeStrategy,
    addRuleToActiveGroup,
    deleteRuleFromActiveGroup,
  };
}
