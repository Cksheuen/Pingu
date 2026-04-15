import { useMemo, useState } from "react";
import { EmptyState, PlusIcon, RefreshIcon } from "../components/host-overrides/Icons";
import { OverrideCard } from "../components/host-overrides/OverrideCard";
import { OverrideForm } from "../components/host-overrides/OverrideForm";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useHostOverridesPageModel } from "../hooks/useHostOverridesPageModel";
import { t } from "../lib/i18n";
import type { HostOverride, HostOverrideDraft } from "../lib/types";

const defaultDraft: HostOverrideDraft = { host: "", resolver: "inherit", outbound: "inherit", enabled: true, reason: "" };

export default function HostOverrides() {
  const { overrides, loading, saving, error, resetSupported, refresh, createOverride, updateOverrideById, deleteOverrideById, toggleOverrideEnabled, resetOverrides } =
    useHostOverridesPageModel();
  const [showCreate, setShowCreate] = useState(false);
  const [draft, setDraft] = useState<HostOverrideDraft>(defaultDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  useI18nRerender();

  const editing = useMemo(() => overrides.find((item) => item.id === editingId) ?? null, [editingId, overrides]);

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
      {showCreate && <OverrideForm draft={draft} onChange={setDraft} onCancel={closeForm} onSubmit={() => void handleSubmit()} saving={saving} editing={Boolean(editing)} />}
      {error && (
        <div className="rounded-xl" style={{ backgroundColor: "rgba(239, 68, 68, 0.12)", color: "#FCA5A5", padding: "12px 14px", fontSize: "13px" }}>
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
