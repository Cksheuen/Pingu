import { useState } from "react";
import { Modal } from "../Modal";
import Select from "../Select";
import { t } from "../../lib/i18n";
import { errorMessage } from "../../lib/network-view";
import type { Outbound, Rule, RuleGroup, RuleType } from "../../lib/types";

type Draft = {
  group: RuleGroup;
  dns: { suffix: string; servers: string }[];
  fakeIp: string;
};
const copy = (group: RuleGroup): Draft => ({
  group: { ...group, rules: group.rules.map(rule => ({ ...rule })) },
  dns: (group.nameserver_policy ?? []).map(policy => ({ suffix: policy.domain_suffix,
    servers: [...new Set([...(policy.servers ?? []), policy.server ?? ""].filter(Boolean))].join(", ") })),
  fakeIp: (group.fake_ip_filter ?? []).join("\n"),
});
const types = ["domain_suffix", "domain", "geosite", "geoip", "ip_cidr"] as const;
const labels = { domain_suffix: "Domain Suffix", domain: "Domain", geosite: "GeoSite", geoip: "GeoIP", ip_cidr: "IP CIDR" };

interface Props {
  groups: RuleGroup[];
  initialGroupId: string;
  onSave: (group: RuleGroup) => Promise<RuleGroup>;
  onClose: () => void;
}

export function RuleGroupEditor({ groups, initialGroupId, onSave, onClose }: Props) {
  const [original, setOriginal] = useState(() => copy(groups.find(group => group.id === initialGroupId) ?? groups[0]));
  const [draft, setDraft] = useState(original);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
  const rules = draft.group.rules;
  const changeRules = (next: Rule[]) => setDraft(current => ({ ...current, group: { ...current.group, rules: next } }));
  const changeRule = (index: number, changes: Partial<Rule>) => changeRules(rules.map((rule, i) => i === index ? { ...rule, ...changes } : rule));
  const move = (index: number, offset: number) => {
    const next = [...rules];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    changeRules(next);
  };
  const selectGroup = (id: string) => {
    const group = groups.find(entry => entry.id === id);
    if (!group) return;
    const next = copy(group);
    setOriginal(next); setDraft(next); setError(null); setSaved(false);
  };
  const save = async () => {
    setSaving(true); setError(null); setSaved(false);
    try {
      const group = await onSave({ ...draft.group,
        nameserver_policy: draft.dns.map(policy => {
          const servers = policy.servers.split(/[,\n]/).map(value => value.trim()).filter(Boolean);
          return { domain_suffix: policy.suffix, server: servers[0] ?? "", servers };
        }),
        fake_ip_filter: draft.fakeIp.split("\n").map(value => value.trim()).filter(Boolean),
      });
      const next = copy(group); setOriginal(next); setDraft(next); setSaved(true);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  };

  return <Modal title={t("rules.edit_group")} wide onClose={() => { if (!saving) onClose(); }}>
    <div className="rule-group-editor">
      <div className="rule-group-editor-heading">
        <label className="dialog-field-group"><span className="dialog-field-label">{t("rules.display_group")}</span>
          <Select label={t("rules.display_group")} value={draft.group.id} disabled={saving || dirty}
            options={groups.map(group => ({ value: group.id, label: group.name }))} onChange={selectGroup} />
        </label>
        <label className="dialog-field-group"><span className="dialog-field-label">{t("rules.group_name_placeholder")}</span>
          <input className="dialog-field" aria-label={t("rules.group_name_placeholder")} disabled={saving}
            value={draft.group.name} onChange={event => setDraft(current => ({ ...current, group: { ...current.group, name: event.target.value } }))} />
        </label>
      </div>
      <div className="rule-group-editor-body">
        <fieldset disabled={saving} className="rule-group-editor-fields">
          <div className="rule-group-editor-section">
            <strong>{t("rules.route_rules")} · {rules.length}</strong>
            <button type="button" className="action-secondary" onClick={() => changeRules([...rules,
              { id: crypto.randomUUID(), rule_type: "domain_suffix", match_value: "", outbound: "direct" },
            ])}>+ {t("rules.add")}</button>
          </div>
          <div className="rule-group-editor-scroll">
            <div className="rule-group-editor-grid rule-group-editor-labels">
              <span>{t("rules.priority")}</span><span>{t("rules.type")}</span><span>{t("rules.match")}</span>
              <span>{t("rules.outbound")}</span><span>{t("rules.actions")}</span>
            </div>
            {rules.map((rule, index) => <div key={rule.id} className="rule-group-editor-grid">
              <span className="rule-group-editor-index">{index + 1}</span>
              <Select label={`${t("rules.rule")} ${index + 1} ${t("rules.type")}`} value={rule.rule_type} disabled={saving}
                options={[...types.map(type => ({ value: type, label: labels[type] })),
                  ...(rule.rule_type === "ip_is_private" ? [{ value: "ip_is_private", label: "IP Private" }] : [])]}
                onChange={value => changeRule(index, { rule_type: value as RuleType })} />
              <input aria-label={`${t("rules.rule")} ${index + 1} ${t("rules.match_label")}`} className="dialog-field"
                value={rule.match_value} onChange={event => changeRule(index, { match_value: event.target.value })} />
              <Select label={`${t("rules.rule")} ${index + 1} ${t("rules.outbound")}`} value={rule.outbound} disabled={saving}
                options={(["direct", "proxy", "block"] as const).map(value => ({ value, label: t(`rules.${value}`) }))}
                onChange={value => changeRule(index, { outbound: value as Outbound })} />
              <div className="rule-group-editor-actions">
                <button type="button" disabled={index === 0} aria-label={`${t("rules.move_up")} ${index + 1}`} onClick={() => move(index, -1)}>↑</button>
                <button type="button" disabled={index === rules.length - 1} aria-label={`${t("rules.move_down")} ${index + 1}`} onClick={() => move(index, 1)}>↓</button>
                <button type="button" aria-label={`${t("rules.remove_rule")} ${index + 1}`} onClick={() => changeRules(rules.filter((_, i) => i !== index))}>×</button>
              </div>
            </div>)}
            {!rules.length && <p className="rule-group-editor-empty">{t("rules.empty")}</p>}
          </div>
          <details className="rule-group-editor-details">
            <summary>{t("rules.dns_policies")} · {draft.dns.length}</summary>
            {draft.dns.map((policy, index) => <div key={index} className="rule-group-editor-dns">
              <input className="dialog-field" placeholder="+.example.com" aria-label={`DNS ${index + 1} ${t("rules.domain_suffix")}`}
                value={policy.suffix} onChange={event => setDraft(current => ({ ...current, dns: current.dns.map((row, i) => i === index ? { ...row, suffix: event.target.value } : row) }))} />
              <input className="dialog-field" placeholder={t("rules.resolver_placeholder")} aria-label={`DNS ${index + 1} ${t("rules.resolvers")}`}
                value={policy.servers} onChange={event => setDraft(current => ({ ...current, dns: current.dns.map((row, i) => i === index ? { ...row, servers: event.target.value } : row) }))} />
              <button type="button" aria-label={`${t("rules.remove_dns")} ${index + 1}`} onClick={() => setDraft(current => ({ ...current, dns: current.dns.filter((_, i) => i !== index) }))}>×</button>
            </div>)}
            <button type="button" className="action-secondary" onClick={() => setDraft(current => ({ ...current, dns: [...current.dns, { suffix: "", servers: "" }] }))}>+ {t("rules.add_dns")}</button>
          </details>
          <details className="rule-group-editor-details">
            <summary>{t("rules.fake_ip_exceptions")}</summary>
            <textarea className="dialog-field" rows={4} aria-label={t("rules.fake_ip_exceptions")} placeholder={t("rules.one_per_line")}
              value={draft.fakeIp} onChange={event => setDraft(current => ({ ...current, fakeIp: event.target.value }))} />
          </details>
        </fieldset>
      </div>
      {error && <p role="alert" className="dialog-error">{error}</p>}
      <div className="rule-group-editor-footer">
        <p role="status">{dirty ? t("rules.unsaved_group") : saved ? t("rules.group_saved") : t("rules.editor_hint")}</p>
        <div className="dialog-actions">
          <button type="button" className="action-secondary" disabled={saving} onClick={onClose}>{t("rules.close")}</button>
          {dirty && <button type="button" className="action-secondary" disabled={saving} onClick={() => { setDraft(original); setError(null); }}>{t("rules.reset_draft")}</button>}
          <button type="button" className="action-primary" disabled={saving || !dirty || !draft.group.name.trim()}
            onClick={() => void save()}>{saving ? t("rules.saving") : t("rules.save_group")}</button>
        </div>
      </div>
    </div>
  </Modal>;
}
