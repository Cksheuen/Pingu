import { t } from "../../lib/i18n";
import type { HostOverride } from "../../lib/types";
import { PencilIcon, TrashIcon, formatVerified } from "./Icons";

type OverrideCardProps = {
  override: HostOverride;
  onEdit: (override: HostOverride) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
};

export function OverrideCard({
  override,
  onEdit,
  onDelete,
  onToggle,
}: OverrideCardProps) {
  const sourceKey =
    override.source === "runtime_learned"
      ? "host_overrides.source.runtime_learned"
      : override.source === "runtime_fallback"
        ? "host_overrides.source.runtime_fallback"
        : "host_overrides.source.manual";

  return (
    <div
      className="surface"
      style={{
        padding: "18px",
        borderColor: override.enabled ? "#4c432c" : "var(--line)",
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
                color: override.enabled ? "var(--color-accent)" : "var(--color-text-secondary)",
                backgroundColor: override.enabled ? "var(--accent-soft)" : "var(--surface-soft)",
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

        <div className="override-actions">
          <button
            type="button"
            onClick={() => onToggle(override.id)}
            className="control-action-button"
          >
            {override.enabled ? t("host_overrides.disable") : t("host_overrides.enable")}
          </button>
          <button
            type="button"
            onClick={() => onEdit(override)}
            className="table-action-button"
            aria-label={t("host_overrides.edit")}
          >
            <PencilIcon />
          </button>
          <button
            type="button"
            onClick={() => onDelete(override.id)}
            className="table-action-button"
            aria-label={t("host_overrides.delete")}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
