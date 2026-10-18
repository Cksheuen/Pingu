import { useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { t } from "../lib/i18n";
import Tooltip from "../components/Tooltip";
import { RuleGroupEditor } from "../components/rules/RuleGroupEditor";
import { RuleGroupsBar } from "../components/rules/RuleGroupsBar";
import { RuleStrategyCard } from "../components/rules/RuleStrategyCard";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useRulesPageModel } from "../hooks/useRulesPageModel";

export default function Rules({ embedded = false }: { embedded?: boolean }) {
  const { groups, stack, strategy, error, pending, setEnabledGroups, deduplicate,
    createGroup, updateGroup, deleteGroup, changeStrategy } = useRulesPageModel();
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  useI18nRerender();

  return <div className={embedded ? "workspace-section" : "page-shell"}>
    <SectionHeader title={t("workspace.rule_groups")} embedded={embedded}>
      <Tooltip text={`${t("rules.builtin_info")} ${t("tooltip.dns_split")}`} />
      <button type="button" disabled={pending} className="action-secondary"
        onClick={() => void deduplicate().catch(() => undefined)}>{t("rules.deduplicate")}</button>
      <button type="button" disabled={pending || !groups.length} className="action-primary"
        onClick={() => setEditingGroupId(stack.enabled_group_ids[0] ?? groups[0]?.id ?? null)}>{t("rules.edit_group")}</button>
    </SectionHeader>
    {error && <p role="alert" className="network-error">{error}</p>}
    <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <RuleGroupsBar groups={groups} enabledGroupIds={stack.enabled_group_ids}
        onSetEnabledGroups={setEnabledGroups} onEditGroup={setEditingGroupId}
        onCreateGroup={async name => { const group = await createGroup(name); setEditingGroupId(group.id); }}
        onDeleteGroup={deleteGroup} />
      <RuleStrategyCard strategy={strategy} onChangeStrategy={changeStrategy} />
    </fieldset>
    {editingGroupId && <RuleGroupEditor groups={groups} initialGroupId={editingGroupId}
      onSave={updateGroup} onClose={() => setEditingGroupId(null)} />}
  </div>;
}
