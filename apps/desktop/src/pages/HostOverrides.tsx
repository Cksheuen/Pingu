import { SectionHeader } from "../components/SectionHeader";
import { useMemo, useState } from "react";
import { EmptyState, PlusIcon, RefreshIcon } from "../components/host-overrides/Icons";
import { OverrideCard } from "../components/host-overrides/OverrideCard";
import { OverrideForm } from "../components/host-overrides/OverrideForm";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useHostOverridesPageModel } from "../hooks/useHostOverridesPageModel";
import { t } from "../lib/i18n";
import type { HostOverride, HostOverrideDraft } from "../lib/types";

const defaultDraft: HostOverrideDraft = { host: "", resolver: "inherit", outbound: "inherit", enabled: true, reason: "" };

export default function HostOverrides({ embedded = false }: { embedded?: boolean }) {
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
    <div className={embedded ? "workspace-section" : "page-shell"}>
      <SectionHeader title={t("host_overrides.title")} embedded={embedded}>
        <div className="page-header-actions flex items-center gap-2"><button
          onClick={() => void refresh()}
          disabled={loading || saving}
          className="text-action-button"
        >
          {loading ? t("host_overrides.loading") : t("host_overrides.refresh")}
        </button>
          {resetSupported && (
            <button
              onClick={() => void resetOverrides()}
              disabled={saving}
              className="action-secondary"
            >
              <RefreshIcon />
              {t("host_overrides.reset")}
            </button>
          )}
          <button
            onClick={openCreate}
            className="action-primary"
          >
            <PlusIcon />
            {t("host_overrides.add")}
          </button>
        </div>
      </SectionHeader>
      {showCreate && <OverrideForm draft={draft} onChange={setDraft} onCancel={closeForm} onSubmit={() => void handleSubmit()} saving={saving} editing={Boolean(editing)} />}
      {error && (
        <div className="surface" style={{ backgroundColor: "var(--danger-soft)", color: "var(--color-danger)", padding: "12px 14px", fontSize: "13px" }}>
          {error}
        </div>
      )}
      <div className="override-list flex flex-col gap-3">
        {!loading && overrides.length === 0 && <EmptyState />}
        {loading && (
          <div className="surface flex items-center justify-center" style={{ minHeight: "220px", padding: "24px" }}>
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
              onDelete={(id) => {
                if (!window.confirm(t("host_overrides.delete_confirm"))) return;
                void deleteOverrideById(id);
              }}
              onToggle={(id) => void toggleOverrideEnabled(id)}
            />
          ))}
      </div>
    </div>
  );
}
