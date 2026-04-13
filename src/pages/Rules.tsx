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

export default function Rules() {
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
    <div className="flex-1 flex flex-col overflow-hidden" style={{ padding: "32px 40px", gap: "24px" }}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-text-muted tracking-[2px] uppercase" style={{ fontSize: "11px" }}>
          {t("rules.title")}
        </span>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 rounded-md font-mono font-medium transition-colors hover:opacity-90"
          style={{
            backgroundColor: "#22D3EE",
            color: "#0A0F1C",
            fontSize: "13px",
            padding: "8px 14px",
          }}
        >
          <PlusIcon />
          {t("rules.add")}
        </button>
      </div>

      <RuleGroupsBar
        groups={groups}
        activeGroupId={activeGroupId}
        onSwitchGroup={switchGroup}
        onCreateGroup={createGroup}
        onRenameGroup={renameGroup}
        onDeleteGroup={deleteGroup}
      />

      <RuleStrategyCard strategy={strategy} onChangeStrategy={changeStrategy} />

      {/* Built-in info bar */}
      <div className="flex items-center" style={{ gap: "6px" }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted" style={{ flexShrink: 0 }}>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <span className="font-sans text-text-muted" style={{ fontSize: "11px" }}>
          {t("rules.builtin_info")}
        </span>
        <Tooltip text={t("tooltip.dns_split")} />
      </div>

      <RulesTable rules={rules} onDeleteRule={handleDelete} />

      {showAdd && (
        <AddRuleDialog onClose={() => setShowAdd(false)} onAdd={handleAddRule} />
      )}
    </div>
  );
}
