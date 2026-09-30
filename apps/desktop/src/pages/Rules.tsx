import { SectionHeader } from "../components/SectionHeader";
import { useState } from "react";
import type { Rule } from "../lib/types";
import { t } from "../lib/i18n";
import Tooltip from "../components/Tooltip";
import { AddRuleDialog } from "../components/rules/AddRuleDialog";
import { RuleGroupsBar } from "../components/rules/RuleGroupsBar";
import { RuleStrategyCard } from "../components/rules/RuleStrategyCard";
import { RulesTable } from "../components/rules/RulesTable";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useRulesPageModel } from "../hooks/useRulesPageModel";

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export default function Rules({ embedded = false }: { embedded?: boolean }) {
  const {
    rules,
    groups,
    strategy,
    activeGroupId,
    switchGroup,
    createGroup,
    renameGroup,
    deleteGroup,
    changeStrategy,
    addRuleToActiveGroup,
    deleteRuleFromActiveGroup,
  } = useRulesPageModel();
  const [showAdd, setShowAdd] = useState(false);
  useI18nRerender();

  const handleAddRule = async (rule: Omit<Rule, "id">) => {
    await addRuleToActiveGroup(rule);
  };

  const handleDelete = async (id: string) => {
    await deleteRuleFromActiveGroup(id);
  };

  return (
    <div className={embedded ? "workspace-section" : "page-shell"}>
      <SectionHeader title={t("workspace.rule_groups")} embedded={embedded}><Tooltip text={`${t("rules.builtin_info")} ${t("tooltip.dns_split")}`} />
        <button
          onClick={() => setShowAdd(true)}
          className="action-primary"
        >
          <PlusIcon />
          {t("rules.add")}
        </button>
      </SectionHeader>

      <RuleGroupsBar
        groups={groups}
        activeGroupId={activeGroupId}
        onSwitchGroup={switchGroup}
        onCreateGroup={createGroup}
        onRenameGroup={renameGroup}
        onDeleteGroup={deleteGroup}
      />

      <RuleStrategyCard strategy={strategy} onChangeStrategy={changeStrategy} />

      <RulesTable rules={rules} onDeleteRule={handleDelete} />

      {showAdd && (
        <AddRuleDialog onClose={() => setShowAdd(false)} onAdd={handleAddRule} />
      )}
    </div>
  );
}
