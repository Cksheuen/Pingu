import { useEgressStatus } from "../../hooks/useEgressStatus";
import { t } from "../../lib/i18n";

interface EgressCardProps {
  connected: boolean;
}

export function EgressCard({ connected }: EgressCardProps) {
  const { ip, checking, error, check } = useEgressStatus(connected);

  return (
    <section className="surface readout-card egress-readout">
      <div className="readout-card-head">
        <span className="section-label">{t("home.egress")}</span>
      </div>
      <div className="egress-value-row">
        <strong>{connected ? ip ?? (checking ? t("home.egress_checking") : "—") : "—"}</strong>
        <button className="readout-action" type="button" onClick={() => void check()} disabled={!connected || checking}>
          {checking ? t("home.egress_checking") : t("home.egress_recheck")}
        </button>
      </div>
      <p className={error ? "egress-note egress-note-error" : "egress-note"}>
        {error ?? t("home.egress_desc")}
      </p>
    </section>
  );
}
