import { NavLink } from "react-router-dom";
import { useGateLeaseStatus } from "../../hooks/useGateLeaseStatus";
import { t } from "../../lib/i18n";

interface NetworkLeaseCardProps {
  connected: boolean;
}

function formatExpiry(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function NetworkLeaseCard({ connected }: NetworkLeaseCardProps) {
  const gate = useGateLeaseStatus(connected);
  const active = Boolean(
    gate.settings?.configured &&
      gate.settings.enabled &&
      gate.settings.last_ip &&
      !gate.settings.last_error,
  );
  const state = gate.error || gate.settings?.last_error ? "attention" : active ? "active" : "idle";

  return (
    <section className="surface readout-card lease-readout">
      <div className="readout-card-head">
        <span className="section-label">{t("home.network_access")}</span>
      </div>

      <div className="lease-status-row">
        <div className="status-chip" data-state={state}>
          <span className="status-dot" />
          <span>
            {gate.loading
              ? t("home.lease_pending")
              : active
                ? t("home.lease_active")
                : t("home.lease_missing")}
          </span>
        </div>
        <span className="lease-ip">{gate.settings?.last_ip ?? "—"}</span>
      </div>

      <p className="lease-description">{t("home.lease_desc")}</p>

      <div className="lease-foot">
        <span>
          {t("home.lease_until")} · {formatExpiry(gate.settings?.lease_expires_at ?? null)}
        </span>
        <div>
          <button
            type="button"
            className="readout-action"
            onClick={() => void gate.renew()}
            disabled={gate.renewing || !gate.settings?.enabled}
          >
            {gate.renewing ? t("home.lease_renewing") : t("home.lease_renew")}
          </button>
          <NavLink className="readout-action" to="/settings">{t("home.lease_manage")}</NavLink>
        </div>
      </div>

      {(gate.error || gate.settings?.last_error) && (
        <p className="lease-error">{gate.error || gate.settings?.last_error}</p>
      )}
    </section>
  );
}
