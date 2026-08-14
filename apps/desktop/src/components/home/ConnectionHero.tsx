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
  elapsed: number;
  loading: boolean;
  error: string | null;
  activeNodeName?: string | null;
  onClearError: () => void;
  onToggleConnection: () => Promise<void>;
}

export function ConnectionHero({
  connected,
  elapsed,
  loading,
  error,
  activeNodeName,
  onClearError,
  onToggleConnection,
}: ConnectionHeroProps) {
  const action = connected ? t("home.disconnect_action") : t("home.connect_action");

  return (
    <section className="surface connection-console" data-state={connected ? "active" : "idle"}>
      <div className="connection-console-head">
        <span className="section-label">{t("home.link_control")}</span>
      </div>

      <div className="connection-console-body">
        <button
          type="button"
          onClick={() => void onToggleConnection()}
          disabled={loading}
          aria-label={action}
          aria-pressed={connected}
          className="power-control"
        >
          <span className="power-control-ring" aria-hidden="true" />
          <PowerIcon />
        </button>

        <div className="connection-state">
          <p className="connection-state-name" aria-live="polite">
            {loading
              ? t("home.connecting_status")
              : connected
                ? t("home.connected_status")
                : t("home.disconnected_status")}
          </p>
          <p className="connection-action-hint">{action}</p>
          {connected && activeNodeName && (
            <p className="connection-node">{activeNodeName}</p>
          )}
        </div>
      </div>

      {error && (
        <button type="button" className="connection-error" onClick={onClearError}>
          {error}
          <span className="connection-error-close" aria-hidden="true">×</span>
        </button>
      )}

      <div className="connection-console-foot">
        <div>
          <span className="section-label">{t("home.uptime")}</span>
          <strong className="connection-time">{formatTime(elapsed)}</strong>
        </div>
        <span className="connection-signal" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
    </section>
  );
}
