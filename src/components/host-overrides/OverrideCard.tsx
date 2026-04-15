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
