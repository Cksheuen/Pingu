import { Menu } from "../components/Menu";
import { NetworkLoading } from "../components/network/NetworkState";
import { useState } from "react";
import { SectionHeader } from "../components/SectionHeader";
import { t } from "../lib/i18n";
import Tooltip from "../components/Tooltip";
import { RuleGroupEditor } from "../components/rules/RuleGroupEditor";
import { RuleGroupsBar } from "../components/rules/RuleGroupsBar";
import { RuleStrategyCard } from "../components/rules/RuleStrategyCard";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useRulesPageModel } from "../hooks/useRulesPageModel";

export default function Rules() {
  const {
    groups,
    loading,
    stack,
    strategy,
    error,
    pending,
    setEnabledGroups,
    deduplicate,
    createGroup,
    updateGroup,
    deleteGroup,
    changeStrategy
  } = useRulesPageModel();
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  useI18nRerender();

  return (
    <div className="workspace-section">
      <SectionHeader title={t("workspace.rule_groups")}>
        <Tooltip text={`${t("rules.builtin_info")} ${t("tooltip.dns_split")}`} />
        <Menu label={t("rules.actions")} items={[
          { label: t("rules.deduplicate"), disabled: pending || loading,
            onSelect: () => { void deduplicate().catch(() => undefined); } },
        ]} />
        {stack.enabled_group_ids.length > 0 &&
        <button
          type="button"
          disabled={pending || !groups.length}
          className="btn btn-primary"
          onClick={() => setEditingGroupId(stack.enabled_group_ids[0] ?? groups[0]?.id ?? null)}
        >
          {t("rules.edit_group")}
        </button>}
      </SectionHeader>
      {error && <p role="alert" className="network-error">{error}</p>}
      {loading && <NetworkLoading />}
      <fieldset hidden={loading} disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <RuleGroupsBar
          groups={groups}
          enabledGroupIds={stack.enabled_group_ids}
          onSetEnabledGroups={setEnabledGroups}
          onEditGroup={setEditingGroupId}
          onCreateGroup={async name => {
            const group = await createGroup(name);
            setEditingGroupId(group.id);
          }}
          onDeleteGroup={deleteGroup}
        />
        <RuleStrategyCard strategy={strategy} onChangeStrategy={changeStrategy} />
      </fieldset>
      {editingGroupId
        && <RuleGroupEditor
          groups={groups}
          initialGroupId={editingGroupId}
          onSave={updateGroup}
          onClose={() => setEditingGroupId(null)}
        />}
    </div>
  );
}
