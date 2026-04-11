import { useState, useEffect } from "react";
import { connect, disconnect } from "../lib/api";
import { t, onLangChange } from "../lib/i18n";
import Tooltip from "../components/Tooltip";
import { useConnectionStore } from "../lib/connection-store";

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

export default function Home() {
  const { status, nodes, proxyInfo, refreshAll, refreshStatus } = useConnectionStore();
  const [elapsed, setElapsed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, rerender] = useState(0);

  useEffect(() => onLangChange(() => rerender((n) => n + 1)), []);

  useEffect(() => {
    refreshAll().catch(() => undefined);
  }, [refreshAll]);

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(id);
  }, [error]);

  useEffect(() => {
    if (!status.connected) {
      setElapsed(0);
      return;
    }
    setElapsed(status.uptime_seconds);
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [status.connected, status.uptime_seconds]);

  const handleToggle = async () => {
    setLoading(true);
    try {
      if (status.connected) {
        await disconnect();
      } else {
        await connect();
      }
    } catch (e) {
      setError(typeof e === "string" ? e : "Connection failed");
    } finally {
      await refreshStatus().catch(() => undefined);
      setLoading(false);
    }
  };

  const activeNode = nodes.find((n) => n.id === status.active_node_id) ?? null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden" style={{ padding: "32px 40px", gap: "32px" }}>
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="font-mono text-text-muted tracking-[2px] uppercase" style={{ fontSize: "11px" }}>
          {t("home.connection")}
        </span>
        <div className="flex items-center gap-2">
          <span
            className="rounded-full"
            style={{
              width: "8px",
              height: "8px",
              backgroundColor: status.connected ? "#22D3EE" : "#64748B",
            }}
          />
          <span className="font-mono text-xs" style={{ color: status.connected ? "#22D3EE" : "#64748B" }}>
            {status.connected ? t("home.connected") : t("home.disconnected")}
          </span>
        </div>
      </div>

      {/* Center area */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6">
        {/* Power circle button */}
        <button
          onClick={handleToggle}
          disabled={loading}
          aria-label={status.connected ? "Disconnect" : "Connect"}
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

        {/* Error message */}
        {error && (
          <span
            className="font-mono cursor-pointer"
            style={{ fontSize: "13px", color: "#f87171" }}
            onClick={() => setError(null)}
          >
            {error}
          </span>
        )}

        {/* Status text */}
        <span
          className="font-mono font-bold text-text-primary tracking-[2px] uppercase"
          style={{ fontSize: "24px" }}
        >
          {status.connected ? t("home.connected_status") : t("home.disconnected_status")}
        </span>

        {/* Timer */}
        <span
          className="font-mono font-bold"
          style={{ fontSize: "32px", color: "#22D3EE" }}
        >
          {formatTime(elapsed)}
        </span>
      </div>

      {/* Bottom cards */}
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          {/* Current Node card */}
          <div className="bg-card rounded-xl" style={{ padding: "16px" }}>
            <p className="font-mono text-text-muted tracking-[2px] uppercase mb-3" style={{ fontSize: "10px" }}>
              {t("home.current_node")}
            </p>
            <p className="font-sans font-semibold text-text-primary mb-2" style={{ fontSize: "15px" }}>
              {activeNode ? activeNode.name : t("home.no_node")}
            </p>
            {activeNode && (
              <>
                <span className="inline-flex items-center">
                  <span
                    className="inline-block font-mono text-accent rounded-full mb-2"
                    style={{ backgroundColor: "#0F172A", fontSize: "10px", padding: "2px 8px" }}
                  >
                    VLESS{activeNode.security ? ` + ${activeNode.security.toUpperCase()}` : ""}
                  </span>
                  {activeNode.security === "reality" && <Tooltip text={t("tooltip.reality")} />}
                </span>
                <p className="font-mono text-text-secondary" style={{ fontSize: "12px" }}>
                  {activeNode.address}:{activeNode.port}
                </p>
              </>
            )}
          </div>

          {/* Traffic card */}
          <div className="bg-card rounded-xl" style={{ padding: "16px" }}>
            <p className="font-mono text-text-muted tracking-[2px] uppercase mb-3" style={{ fontSize: "10px" }}>
              {t("home.traffic")}
            </p>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-text-secondary text-sm">↑</span>
                  <span className="font-mono text-text-secondary" style={{ fontSize: "12px" }}>{t("home.upload")}</span>
                </div>
                <span className="font-mono text-text-primary font-semibold" style={{ fontSize: "13px" }}>
                  --
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-text-secondary text-sm">↓</span>
                  <span className="font-mono text-text-secondary" style={{ fontSize: "12px" }}>{t("home.download")}</span>
                </div>
                <span className="font-mono text-text-primary font-semibold" style={{ fontSize: "13px" }}>
                  --
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Terminal Proxy card */}
        <div className="bg-card rounded-xl" style={{ padding: "16px" }}>
          <div className="flex items-center justify-between mb-3">
            <span className="flex items-center">
              <p className="font-mono text-text-muted tracking-[2px] uppercase" style={{ fontSize: "10px" }}>
                {t("home.terminal_proxy")}
              </p>
              <Tooltip text={t("tooltip.terminal_proxy")} />
            </span>
            {status.connected && proxyInfo && (
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(proxyInfo.terminal_commands.join("\n"));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch (e) {
                    console.warn("Clipboard write failed:", e);
                  }
                }}
                className="font-mono text-accent hover:bg-accent/10 rounded-md cursor-pointer transition-colors"
                style={{ fontSize: "11px", padding: "4px 12px" }}
              >
                {copied ? t("home.copied") : t("home.copy")}
              </button>
            )}
          </div>
          {status.connected && proxyInfo ? (
            <div className="bg-inset rounded-lg" style={{ padding: "12px" }}>
              <pre className="font-mono text-xs text-text-secondary whitespace-pre-wrap m-0">
                {proxyInfo.terminal_commands.join("\n")}
              </pre>
            </div>
          ) : (
            <p className="font-mono text-text-muted" style={{ fontSize: "12px" }}>
              {t("home.connect_for_commands")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
