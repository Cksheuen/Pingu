import { useState } from "react";
import type { ProxyInfo } from "../../lib/types";
import { t } from "../../lib/i18n";
import Tooltip from "../Tooltip";

interface TerminalProxyCardProps {
  connected: boolean;
  proxyInfo: ProxyInfo | null;
}

export function TerminalProxyCard({ connected, proxyInfo }: TerminalProxyCardProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!proxyInfo) return;

    try {
      await navigator.clipboard.writeText(proxyInfo.terminal_commands.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.warn("Clipboard write failed:", error);
    }
  }

  return (
    <div className="bg-card rounded-xl" style={{ padding: "16px" }}>
      <div className="flex items-center justify-between mb-3">
        <span className="flex items-center">
          <p className="font-mono text-text-muted tracking-[2px] uppercase" style={{ fontSize: "10px" }}>
            {t("home.terminal_proxy")}
          </p>
          <Tooltip text={t("tooltip.terminal_proxy")} />
        </span>
        {connected && proxyInfo && (
          <button
            onClick={() => void handleCopy()}
            className="font-mono text-accent hover:bg-accent/10 rounded-md cursor-pointer transition-colors"
            style={{ fontSize: "11px", padding: "4px 12px" }}
          >
            {copied ? t("home.copied") : t("home.copy")}
          </button>
        )}
      </div>
      {connected && proxyInfo ? (
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
  );
}
