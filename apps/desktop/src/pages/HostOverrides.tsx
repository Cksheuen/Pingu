import { Menu } from "../components/Menu";
import { NetworkLoading } from "../components/network/NetworkState";
import { confirmAction } from "../lib/confirm-action";
import { SectionHeader } from "../components/SectionHeader";
import { useMemo, useState } from "react";
import { PlusIcon } from "../components/host-overrides/Icons";
import { OverrideCard } from "../components/host-overrides/OverrideCard";
import { OverrideForm } from "../components/host-overrides/OverrideForm";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useHostOverridesPageModel } from "../hooks/useHostOverridesPageModel";
import { t } from "../lib/i18n";
import type { HostOverride, HostOverrideDraft } from "../lib/types";

const defaultDraft: HostOverrideDraft = { host: "", resolver: "inherit", outbound: "inherit", enabled: true, reason: "" };

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
    resetOverrides
  } =
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
    setDraft(
      {
        host: override.host,
        resolver: override.resolver,
        outbound: override.outbound,
        enabled: override.enabled,
        reason: override.reason,
      }
    );
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
    <div className="workspace-section">
      <SectionHeader title={t("host_overrides.title")}>
        <div className="page-header-actions flex items-center gap-2">
          <Menu label={t("lists.actions")} items={[
            { label: t("host_overrides.refresh"), disabled: loading || saving, onSelect: () => { void refresh(); } },
            ...(resetSupported ? [{ label: t("host_overrides.reset"), tone: "danger" as const,
              disabled: saving, onSelect: () => {
                void (async () => {
                  if (await confirmAction(t("host_overrides.reset_confirm"))) await resetOverrides();
                })().catch(() => undefined);
              } }] : []),
          ]} />
          <button
            onClick={openCreate}
            className="btn btn-primary"
          >
            <PlusIcon />
            {t("host_overrides.add")}
          </button>
        </div>
      </SectionHeader>
      {showCreate
        && <OverrideForm
          draft={draft}
          onChange={setDraft}
          onCancel={closeForm}
          onSubmit={() => void handleSubmit().catch(() => undefined)}
          saving={saving}
          editing={Boolean(editing)}
        />}
      {error
        && (
          <div
            className="surface"
            style={{
              backgroundColor: "var(--danger-soft)",
              color: "var(--color-danger)",
              padding: "12px 14px",
              fontSize: "13px"
            }}
          >
            {error}
          </div>
        )}
      <div className="override-list flex flex-col gap-3">
        {!loading && overrides.length === 0 && <div className="empty-state">
          <p>{t("host_overrides.empty")}</p>
          <button className="btn" onClick={openCreate}>{t("host_overrides.add")}</button>
        </div>}
        {loading && overrides.length === 0 && <NetworkLoading />}
        {overrides.map(
            (override) =>
            (
              <OverrideCard
                key={override.id}
                override={override}
                saving={saving}
                onEdit={openEdit}
                onDelete={async (id) => {
                  if (!await confirmAction(t("host_overrides.delete_confirm"))) return;
                  void deleteOverrideById(id).catch(() => undefined);
                }}
                onToggle={(id) => void toggleOverrideEnabled(id).catch(() => undefined)}
              />
            )
          )}
      </div>
    </div>
  );
}
