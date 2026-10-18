import { confirmAction } from "../../lib/confirm-action";
import { useState } from "react";
import type { RuleGroup } from "../../lib/types";
import { t } from "../../lib/i18n";

interface RuleGroupsBarProps {
  groups: RuleGroup[];
  enabledGroupIds: string[];
  onSetEnabledGroups: (ids: string[]) => Promise<void>;
  onEditGroup: (id: string) => void;
  onCreateGroup: (name: string) => Promise<void>;
  onDeleteGroup: (id: string) => Promise<void>;
}

export function RuleGroupsBar({ groups, enabledGroupIds, onSetEnabledGroups,
  onEditGroup, onCreateGroup, onDeleteGroup }: RuleGroupsBarProps) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const ordered = [
    ...enabledGroupIds.flatMap(id => groups.filter(group => group.id === id)),
    ...groups.filter(group => !enabledGroupIds.includes(group.id)),
  ];
  const invoke = (action: Promise<void>) => { void action.catch(() => undefined); };
  const toggle = (id: string) => onSetEnabledGroups(enabledGroupIds.includes(id)
    ? enabledGroupIds.filter(entry => entry !== id) : [...enabledGroupIds, id]);
  const move = (index: number, offset: number) => {
    const ids = [...enabledGroupIds];
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    return onSetEnabledGroups(ids);
  };
  const saveName = async () => {
    if (!name.trim()) return;
    await onCreateGroup(name.trim());
    setCreating(false); setName("");
  };

  return <div className="rule-stack">
    <p className="rule-stack-description">{t("rules.stack_description")}</p>
    <div className="rule-stack-scroll surface">
      <table className="rule-stack-table">
        <thead><tr>
          <th>{t("rules.enabled")}</th><th>{t("rules.priority")}</th>
          <th>{t("rules.group")}</th><th>{t("rules.contents")}</th><th>{t("rules.actions")}</th>
        </tr></thead>
        <tbody>{ordered.map(group => {
          const priority = enabledGroupIds.indexOf(group.id);
          return <tr key={group.id}>
            <td><input type="checkbox" checked={priority >= 0}
              aria-label={`${t("rules.enabled")} ${group.name}`} onChange={() => invoke(toggle(group.id))} /></td>
            <td><div className="rule-stack-priority"><span>{priority >= 0 ? priority + 1 : "—"}</span>
              <button type="button" disabled={priority <= 0} aria-label={`${t("rules.move_up")} ${group.name}`}
                onClick={() => invoke(move(priority, -1))}>↑</button>
              <button type="button" disabled={priority < 0 || priority === enabledGroupIds.length - 1}
                aria-label={`${t("rules.move_down")} ${group.name}`} onClick={() => invoke(move(priority, 1))}>↓</button>
            </div></td>
            <td><strong className="rule-stack-group">{group.name}</strong></td>
            <td className="rule-stack-count">{group.rules.length} {t("rules.rule_count")} · {group.nameserver_policy?.length ?? 0} DNS</td>
            <td><div className="rule-stack-actions">
              <button type="button" aria-label={`${t("rules.edit_group")} ${group.name}`}
                onClick={() => onEditGroup(group.id)}>{t("rules.edit")}</button>
              <button type="button" disabled={groups.length <= 1} aria-label={`${t("rules.delete_group")} ${group.name}`}
                onClick={() => { void (async () => {
                  if (await confirmAction(t("rules.delete_group_confirm"))) await onDeleteGroup(group.id);
                })().catch(() => undefined); }}>{t("rules.delete_group")}</button>
            </div></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {creating ? <form className="rule-stack-form" onSubmit={event => { event.preventDefault(); invoke(saveName()); }}>
      <input autoFocus value={name} onChange={event => setName(event.target.value)}
        aria-label={t("rules.group_name_placeholder")} placeholder={t("rules.group_name_placeholder")} className="rule-group-input" />
      <button className="action-primary" type="submit" disabled={!name.trim()}>{t("rules.create")}</button>
      <button type="button" onClick={() => { setCreating(false); setName(""); }}>{t("nodes.cancel")}</button>
    </form> : <button type="button" className="rule-group-add" onClick={() => { setCreating(true); setName(""); }}>+ {t("rules.new_group")}</button>}
  </div>;
}
