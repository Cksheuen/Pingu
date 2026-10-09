import { useEffect, useState } from "react";
import { t } from "../../lib/i18n";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((value) => String(value).padStart(2, "0")).join(":");
}

function PowerIcon() {
  return (
    <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

interface ConnectionHeroProps {
  connected: boolean;
  connectLabel?: string;
  uptimeSeconds: number;
  loading: boolean;
  error: string | null;
  activeNodeName?: string | null;
  onClearError: () => void;
  onToggleConnection: () => Promise<void>;
}

export function ConnectionHero({
  connected,
  connectLabel,
  uptimeSeconds,
  loading,
  error,
  activeNodeName,
  onClearError,
  onToggleConnection,
}: ConnectionHeroProps) {
  const [elapsed, setElapsed] = useState(uptimeSeconds);

  useEffect(() => {
    setElapsed(uptimeSeconds);
    if (!connected) return;

    const timer = setInterval(() => setElapsed((current) => current + 1), 1_000);
    return () => clearInterval(timer);
  }, [connected, uptimeSeconds]);

  const action = connected ? t("home.disconnect_action") : connectLabel ?? t("home.connect_action");

  return (
    <section className="surface connection-bar" data-state={connected ? "active" : "idle"}>
      <span className="connection-indicator" aria-hidden="true" />
      <div className="connection-summary">
        <strong aria-live="polite">{loading ? t("home.connecting_status") : connected ? t("home.connected") : t("home.disconnected")}</strong>
        <span>{activeNodeName ?? t("home.no_node")}</span>
      </div>
      <span className="connection-elapsed" title={t("home.uptime")}>{connected ? formatTime(elapsed) : "—"}</span>
      <button type="button" className={connected ? "action-secondary" : "action-primary"} disabled={loading}
        onClick={() => void onToggleConnection()} aria-pressed={connectLabel ? undefined : connected}>
        <PowerIcon />{action}
      </button>
      {error && <button className="connection-error" role="alert" onClick={onClearError}>{error} ×</button>}
    </section>
  );
}
