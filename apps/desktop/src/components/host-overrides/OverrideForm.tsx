import Select from "../Select";
import { t } from "../../lib/i18n";
import type {
  HostOverrideDraft,
  HostOverrideOutbound,
  HostOverrideResolver,
} from "../../lib/types";
import { PlusIcon } from "./Icons";

type OverrideFormProps = {
  draft: HostOverrideDraft;
  onChange: (next: HostOverrideDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
  saving: boolean;
  editing: boolean;
};

export function OverrideForm({
  draft,
  onChange,
  onCancel,
  onSubmit,
  saving,
  editing,
}: OverrideFormProps) {
  const resolverOptions: HostOverrideResolver[] = [
    "inherit",
    "system-dns",
    "local-dns",
    "remote-dns",
  ];
  const outboundOptions: HostOverrideOutbound[] = [
    "inherit",
    "direct",
    "proxy",
    "block",
  ];

  const inputClass =
    "w-full rounded-md bg-inset text-text-primary outline-none border border-[var(--line-strong)] focus:border-accent";
  const labelClass = "font-mono uppercase tracking-[1.5px] text-text-muted";

  return (
    <div className="surface" style={{ padding: "20px" }}>
      <div className="flex items-center justify-between" style={{ marginBottom: "18px" }}>
        <span className="font-mono text-text-primary tracking-[1.5px] uppercase" style={{ fontSize: "12px" }}>
          {editing ? t("host_overrides.edit_title") : t("host_overrides.add_title")}
        </span>
        <button
          onClick={onCancel}
          className="font-mono text-text-muted hover:text-text-primary transition-colors"
          style={{ fontSize: "12px" }}
        >
          {t("host_overrides.cancel")}
        </button>
      </div>

      <div className="grid" style={{ gap: "14px", gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        <label className="flex flex-col" style={{ gap: "6px", gridColumn: "1 / -1" }}>
          <span className={labelClass} style={{ fontSize: "11px" }}>
            {t("host_overrides.host")}
          </span>
          <input
            value={draft.host}
            onChange={(event) => onChange({ ...draft, host: event.target.value })}
            placeholder={t("host_overrides.host_placeholder")}
            className={inputClass}
            style={{ padding: "11px 12px", fontSize: "14px" }}
          />
        </label>

        <label className="flex flex-col" style={{ gap: "6px" }}>
          <span className={labelClass} style={{ fontSize: "11px" }}>
            {t("host_overrides.resolver")}
          </span>
          <Select label={t("host_overrides.resolver")} value={draft.resolver} onChange={value => onChange({...draft, resolver: value as HostOverrideResolver})} options={resolverOptions.map(option => ({value:option,label:t(`host_overrides.resolver_value.${option}`)}))} />
        </label>

        <label className="flex flex-col" style={{ gap: "6px" }}>
          <span className={labelClass} style={{ fontSize: "11px" }}>
            {t("host_overrides.outbound")}
          </span>
          <Select label={t("host_overrides.outbound")} value={draft.outbound} onChange={value => onChange({...draft, outbound: value as HostOverrideOutbound})} options={outboundOptions.map(option => ({value:option,label:t(`host_overrides.outbound_value.${option}`)}))} />
        </label>

        <label className="flex flex-col" style={{ gap: "6px", gridColumn: "1 / -1" }}>
          <span className={labelClass} style={{ fontSize: "11px" }}>
            {t("host_overrides.reason")}
          </span>
          <textarea
            value={draft.reason}
            onChange={(event) => onChange({ ...draft, reason: event.target.value })}
            placeholder={t("host_overrides.reason_placeholder")}
            className={inputClass}
            style={{ minHeight: "84px", padding: "11px 12px", fontSize: "14px", resize: "vertical" }}
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-text-secondary" style={{ marginTop: "16px", fontSize: "13px" }}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) => onChange({ ...draft, enabled: event.target.checked })}
        />
        {t("host_overrides.enabled")}
      </label>

      <div className="flex justify-end gap-2" style={{ marginTop: "18px" }}>
        <button
          onClick={onCancel}
          className="action-secondary"
        >
          {t("host_overrides.cancel")}
        </button>
        <button
          onClick={onSubmit}
          disabled={saving}
          className="action-primary"
        >
          <PlusIcon />
          {saving
            ? t("host_overrides.saving")
            : editing
              ? t("host_overrides.save")
              : t("host_overrides.create")}
        </button>
      </div>
    </div>
  );
}
