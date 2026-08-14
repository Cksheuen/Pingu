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
    <div className="page-shell">
      <header className="page-header">
        <div>
          <p className="page-kicker">{t("rules.kicker")}</p>
          <h1 className="page-title">{t("rules.title")}</h1>
          <p className="page-description">{t("rules.desc")}</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="action-primary"
        >
          <PlusIcon />
          {t("rules.add")}
        </button>
      </header>

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
      <div className="rules-builtin-bar">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <span>{t("rules.builtin_info")}</span>
        <Tooltip text={t("tooltip.dns_split")} />
      </div>

      <RulesTable rules={rules} onDeleteRule={handleDelete} />

      {showAdd && (
        <AddRuleDialog onClose={() => setShowAdd(false)} onAdd={handleAddRule} />
      )}
    </div>
  );
}
