import { t } from "../../lib/i18n";

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function PowerIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
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
  onClearError: () => void;
  onToggleConnection: () => Promise<void>;
}

export function ConnectionHero({
  connected,
  elapsed,
  loading,
  error,
  onClearError,
  onToggleConnection,
}: ConnectionHeroProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6">
      <button
        onClick={onToggleConnection}
        disabled={loading}
        aria-label={connected ? "Disconnect" : "Connect"}
        className="relative flex items-center justify-center rounded-full cursor-pointer transition-all duration-200 hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
        style={{
          width: "120px",
          height: "120px",
          border: "2px solid #22D3EE",
          background: "radial-gradient(circle, rgba(34,211,238,0.15) 0%, transparent 70%)",
          color: "#22D3EE",
        }}
      >
        <PowerIcon />
      </button>

      {error && (
        <span
          className="font-mono cursor-pointer"
          style={{ fontSize: "13px", color: "#f87171" }}
          onClick={onClearError}
        >
          {error}
        </span>
      )}

      <span
        className="font-mono font-bold text-text-primary tracking-[2px] uppercase"
        style={{ fontSize: "24px" }}
      >
        {connected ? t("home.connected_status") : t("home.disconnected_status")}
      </span>

      <span className="font-mono font-bold" style={{ fontSize: "32px", color: "#22D3EE" }}>
        {formatTime(elapsed)}
      </span>
    </div>
  );
}
