import { useMemo, useState } from "react";
import { t } from "../lib/i18n";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useHostOverridesPageModel } from "../hooks/useHostOverridesPageModel";
import type {
  HostOverride,
  HostOverrideDraft,
  HostOverrideOutbound,
  HostOverrideResolver,
} from "../lib/types";

const defaultDraft: HostOverrideDraft = {
  host: "",
  resolver: "inherit",
  outbound: "inherit",
  enabled: true,
  reason: "",
};

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10" />
      <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function EmptyState() {
  return (
    <div className="bg-card rounded-2xl flex items-center justify-center text-center" style={{ minHeight: "220px", padding: "24px" }}>
      <p className="font-mono text-text-muted" style={{ fontSize: "13px" }}>
        {t("host_overrides.empty")}
      </p>
    </div>
  );
}

function formatVerified(value: string | null) {
  if (!value) {
    return t("host_overrides.never_verified");
  }

  const timestamp = Number(value);
  const date = Number.isFinite(timestamp)
    ? new Date(timestamp * 1000)
    : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function OverrideForm({
  draft,
  onChange,
  onCancel,
  onSubmit,
  saving,
  editing,
}: {
  draft: HostOverrideDraft;
  onChange: (next: HostOverrideDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
  saving: boolean;
  editing: boolean;
}) {
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
    "w-full rounded-xl bg-inset text-text-primary outline-none border border-transparent focus:border-accent";
  const labelClass = "font-mono uppercase tracking-[1.5px] text-text-muted";

  return (
    <div className="bg-card rounded-2xl" style={{ padding: "20px" }}>
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
          <select
            value={draft.resolver}
            onChange={(event) =>
              onChange({
                ...draft,
                resolver: event.target.value as HostOverrideResolver,
              })
            }
            className={inputClass}
            style={{ padding: "11px 12px", fontSize: "14px" }}
          >
            {resolverOptions.map((option) => (
              <option key={option} value={option}>
                {t(`host_overrides.resolver_value.${option}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col" style={{ gap: "6px" }}>
          <span className={labelClass} style={{ fontSize: "11px" }}>
            {t("host_overrides.outbound")}
          </span>
          <select
            value={draft.outbound}
            onChange={(event) =>
              onChange({
                ...draft,
                outbound: event.target.value as HostOverrideOutbound,
              })
            }
            className={inputClass}
            style={{ padding: "11px 12px", fontSize: "14px" }}
          >
            {outboundOptions.map((option) => (
              <option key={option} value={option}>
                {t(`host_overrides.outbound_value.${option}`)}
              </option>
            ))}
          </select>
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
          className="rounded-lg font-mono transition-colors hover:text-text-primary text-text-muted"
          style={{ fontSize: "12px", padding: "10px 14px" }}
        >
          {t("host_overrides.cancel")}
        </button>
        <button
          onClick={onSubmit}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg font-mono font-medium transition-colors hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: "#22D3EE", color: "#0A0F1C", fontSize: "13px", padding: "10px 14px" }}
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

function OverrideCard({
  override,
  onEdit,
  onDelete,
  onToggle,
}: {
  override: HostOverride;
  onEdit: (override: HostOverride) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const sourceKey =
    override.source === "runtime_learned"
      ? "host_overrides.source.runtime_learned"
      : override.source === "runtime_fallback"
        ? "host_overrides.source.runtime_fallback"
        : "host_overrides.source.manual";

  return (
    <div
      className="bg-card rounded-2xl"
      style={{
        padding: "18px",
        border: override.enabled ? "1px solid rgba(34, 211, 238, 0.2)" : "1px solid transparent",
        opacity: override.enabled ? 1 : 0.72,
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-sans font-semibold text-text-primary break-all" style={{ fontSize: "15px" }}>
              {override.host}
            </span>
            <span
              className="font-mono uppercase rounded-full"
              style={{
                fontSize: "10px",
                padding: "3px 8px",
                color: override.enabled ? "#22D3EE" : "#94A3B8",
                backgroundColor: override.enabled ? "rgba(34, 211, 238, 0.12)" : "rgba(148, 163, 184, 0.12)",
              }}
            >
              {override.enabled ? t("host_overrides.enabled") : t("host_overrides.disabled")}
            </span>
            <span className="font-mono uppercase text-text-muted" style={{ fontSize: "10px" }}>
              {t(sourceKey)}
            </span>
          </div>
          <div className="flex flex-wrap gap-2" style={{ marginTop: "10px" }}>
            <span className="font-mono text-text-secondary" style={{ fontSize: "11px" }}>
              {t("host_overrides.resolver")}: {t(`host_overrides.resolver_value.${override.resolver}`)}
            </span>
            <span className="font-mono text-text-secondary" style={{ fontSize: "11px" }}>
              {t("host_overrides.outbound")}: {t(`host_overrides.outbound_value.${override.outbound}`)}
            </span>
            <span className="font-mono text-text-secondary" style={{ fontSize: "11px" }}>
              {t("host_overrides.last_verified")}: {formatVerified(override.last_verified_at)}
            </span>
          </div>
          <p className="text-text-secondary" style={{ fontSize: "13px", marginTop: "12px" }}>
            {override.reason || t("host_overrides.no_reason")}
          </p>
          {override.last_verified_result && (
            <p className="font-mono text-text-muted break-all" style={{ fontSize: "11px", marginTop: "8px" }}>
              {override.last_verified_result}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => onToggle(override.id)}
            className="rounded-lg font-mono transition-colors hover:text-text-primary text-text-muted"
            style={{ fontSize: "11px", padding: "8px 10px" }}
          >
            {override.enabled ? t("host_overrides.disable") : t("host_overrides.enable")}
          </button>
          <button
            onClick={() => onEdit(override)}
            className="rounded-lg text-text-muted hover:text-text-primary transition-colors"
            aria-label={t("host_overrides.edit")}
            style={{ padding: "8px" }}
          >
            <PencilIcon />
          </button>
          <button
            onClick={() => onDelete(override.id)}
            className="rounded-lg text-text-muted hover:text-red-400 transition-colors"
            aria-label={t("host_overrides.delete")}
            style={{ padding: "8px" }}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function HostOverrides() {
  const {
    overrides,
    loading,
    saving,
    error,
    resetSupported,
    refresh,
    createOverride,
    updateOverrideById,
    deleteOverrideById,
    toggleOverrideEnabled,
    resetOverrides,
  } = useHostOverridesPageModel();
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState<HostOverrideDraft>(defaultDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  useI18nRerender();

  const editing = useMemo(
    () => overrides.find((item) => item.id === editingId) ?? null,
    [editingId, overrides]
  );

  const openCreate = () => {
    setEditingId(null);
    setDraft(defaultDraft);
    setShowCreate(true);
  };

  const openEdit = (override: HostOverride) => {
    setEditingId(override.id);
    setDraft({
      host: override.host,
      resolver: override.resolver,
      outbound: override.outbound,
      enabled: override.enabled,
      reason: override.reason,
    });
    setShowCreate(true);
  };

  const closeForm = () => {
    setShowCreate(false);
    setEditingId(null);
    setDraft(defaultDraft);
  };

  const handleSubmit = async () => {
    const normalizedDraft = {
      ...draft,
      host: draft.host.trim(),
      reason: draft.reason.trim(),
    };

    if (!normalizedDraft.host) {
      return;
    }

    if (editingId) {
      await updateOverrideById(editingId, normalizedDraft);
    } else {
      await createOverride(normalizedDraft);
    }
    closeForm();
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ padding: "32px 40px", gap: "24px" }}>
      <div className="flex items-center justify-between">
        <div>
          <span className="font-mono text-text-muted tracking-[2px] uppercase" style={{ fontSize: "11px" }}>
            {t("host_overrides.title")}
          </span>
          <p className="text-text-secondary" style={{ fontSize: "13px", marginTop: "8px" }}>
            {t("host_overrides.subtitle")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {resetSupported && (
            <button
              onClick={() => void resetOverrides()}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg font-mono transition-colors hover:text-text-primary text-text-muted disabled:opacity-50"
              style={{ fontSize: "12px", padding: "10px 12px" }}
            >
              <RefreshIcon />
              {t("host_overrides.reset")}
            </button>
          )}
          <button
            onClick={openCreate}
            className="flex items-center gap-1.5 rounded-md font-mono font-medium transition-colors hover:opacity-90"
            style={{ backgroundColor: "#22D3EE", color: "#0A0F1C", fontSize: "13px", padding: "8px 14px" }}
          >
            <PlusIcon />
            {t("host_overrides.add")}
          </button>
        </div>
      </div>

      {showCreate && (
        <OverrideForm
          draft={draft}
          onChange={setDraft}
          onCancel={closeForm}
          onSubmit={() => void handleSubmit()}
          saving={saving}
          editing={Boolean(editing)}
        />
      )}

      {error && (
        <div
          className="rounded-xl"
          style={{
            backgroundColor: "rgba(239, 68, 68, 0.12)",
            color: "#FCA5A5",
            padding: "12px 14px",
            fontSize: "13px",
          }}
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="font-mono text-text-muted tracking-[1.5px] uppercase" style={{ fontSize: "11px" }}>
          {t("host_overrides.list")}
        </span>
        <button
          onClick={() => void refresh()}
          disabled={loading || saving}
          className="font-mono text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
          style={{ fontSize: "12px" }}
        >
          {loading ? t("host_overrides.loading") : t("host_overrides.refresh")}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col gap-3">
        {!loading && overrides.length === 0 && <EmptyState />}
        {loading && (
          <div className="bg-card rounded-2xl flex items-center justify-center" style={{ minHeight: "220px", padding: "24px" }}>
            <p className="font-mono text-text-muted" style={{ fontSize: "13px" }}>
              {t("host_overrides.loading")}
            </p>
          </div>
        )}
        {!loading &&
          overrides.map((override) => (
            <OverrideCard
              key={override.id}
              override={override}
              onEdit={openEdit}
              onDelete={(id) => void deleteOverrideById(id)}
              onToggle={(id) => void toggleOverrideEnabled(id)}
            />
          ))}
      </div>
    </div>
  );
}
