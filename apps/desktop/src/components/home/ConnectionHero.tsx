import { useEffect, useState, type ReactNode } from "react";
import type { ProxyStatus } from "../../lib/types";
import { t } from "../../lib/i18n";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((value) => String(value).padStart(2, "0")).join(":");
}

function PowerIcon() {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
      <line x1="12" y1="2" x2="12" y2="12" />
    </svg>
  );
}

interface ConnectionHeroProps {
  connected: boolean;
  phase: ProxyStatus["phase"];
  children?: ReactNode;
  connectLabel?: string;
  uptimeSeconds: number;
  loading: boolean;
  error: string | null;
  activeNodeName?: string | null;
  onClearError: () => void;
  onToggleConnection: () => Promise<void>;
}

export function ConnectionHero(
  {
    connected,
    phase,
    children,
    connectLabel,
    uptimeSeconds,
    loading,
    error,
    activeNodeName,
    onClearError,
    onToggleConnection,
  }: ConnectionHeroProps
) {
  const [elapsed, setElapsed] = useState(uptimeSeconds);

  useEffect(
    () => {
      setElapsed(uptimeSeconds);
      if (!connected) return;

      const timer = setInterval(() => setElapsed((current) => current + 1), 1_000);
      return () => clearInterval(timer);
    },
    [connected, uptimeSeconds]
  );

  const action = connected ? t("home.disconnect_action") : connectLabel ?? t("home.connect_action");

  const busy = !["connected", "disconnected"].includes(phase);
  const state = busy ? phase : error ? "error" : connected ? "connected" : "idle";
  const statusText = phase === "disconnecting" ? t("home.disconnecting_status")
    : phase === "switching" ? t("home.switching_status")
    : phase === "verifying" ? t("home.verifying_status")
    : busy ? t("home.connecting_status") : connected ? t("home.connected") : t("home.disconnected");

  return (
    <section className="surface connection-hero" data-state={state}>
      <div className="connection-hero-main">
        <button
          type="button"
          className="connection-power"
          data-state={state}
          disabled={loading}
          aria-busy={busy}
          aria-pressed={connected}
          aria-label={busy ? statusText : action}
          title={busy ? statusText : `${action} · ⌘↵`}
          onClick={() => void onToggleConnection()}
        >
          <PowerIcon />
        </button>
        <div className="connection-summary">
          <strong aria-live="polite">{statusText}</strong>
          <span title={activeNodeName ?? undefined}>{activeNodeName ?? t("home.no_node")}</span>
          {connected
            ? <span className="connection-elapsed" title={t("home.uptime")}>{formatTime(elapsed)}</span>
            : !busy && <span className="connection-hint">{action} · ⌘↵</span>}
        </div>
      </div>
      {error && <div className="connection-error" role="alert">
        <span>{error}</span>
        <button
          type="button"
          className="btn btn-icon btn-ghost btn-sm"
          aria-label={t("home.dismiss_error")}
          onClick={onClearError}
        >×</button>
      </div>}
      {children && <><div className="divider" />{children}</>}
    </section>
  );
}
