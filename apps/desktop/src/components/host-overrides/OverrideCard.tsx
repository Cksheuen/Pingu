import { Menu } from "../Menu";
import { t } from "../../lib/i18n";
import type { HostOverride } from "../../lib/types";
import { formatVerified } from "./Icons";

type OverrideCardProps = {
  override: HostOverride;
  saving: boolean;
  onEdit: (override: HostOverride) => void;
  onDelete: (id: string) => void;
  onToggle: (id: string) => void;
};

export function OverrideCard({
  override,
  saving,
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
      className="row override-row"
      style={{
        padding: "14px",
        borderColor: "var(--line)",
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
              className={`pill ${override.enabled ? "pill-accent" : "pill-muted"}`}
            >
              {override.enabled ? t("host_overrides.enabled") : t("host_overrides.disabled")}
            </span>
            <span className="pill pill-muted">
              {t(sourceKey)}
            </span>
          </div>
          <dl className="override-meta">
            <div>
              <dt>{t("host_overrides.resolver")}</dt>
              <dd>{t(`host_overrides.resolver_value.${override.resolver}`)}</dd>
            </div>
            <div>
              <dt>{t("host_overrides.outbound")}</dt>
              <dd>{t(`host_overrides.outbound_value.${override.outbound}`)}</dd>
            </div>
            <div>
              <dt>{t("host_overrides.last_verified")}</dt>
              <dd className="font-mono">{formatVerified(override.last_verified_at)}</dd>
            </div>
          </dl>
          {override.reason
            && (
              <p className="text-text-secondary" style={{ fontSize: "12px", marginTop: "8px" }}>{override.reason}</p>
            )}
          {override.last_verified_result
            && (
              <p className="text-text-muted break-all" style={{ fontSize: "var(--text-xs)", marginTop: "8px" }}>
                {override.last_verified_result}
              </p>
            )}
        </div>
        <div className="override-actions">
          <button type="button" className="switch" role="switch"
            aria-checked={override.enabled} aria-label={`${t("host_overrides.enable")} ${override.host}`}
            disabled={saving} onClick={() => onToggle(override.id)} />
          <div className="row-actions">
            <Menu label={`${t("lists.actions")} ${override.host}`} items={[
              { label: t("host_overrides.edit"), disabled: saving, onSelect: () => onEdit(override) },
              { label: t("host_overrides.delete"), tone: "danger", disabled: saving,
                onSelect: () => onDelete(override.id) },
            ]} />
          </div>
        </div>
      </div>
    </div>
  );
}
