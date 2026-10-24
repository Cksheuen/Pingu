import { useState } from "react";
import type { ProxyInfo } from "../../lib/types";
import { t } from "../../lib/i18n";
import Tooltip from "../Tooltip";

interface TerminalProxyCardProps {
  connected: boolean;
  tun?: boolean;
  proxyInfo: ProxyInfo | null;
}

type CopyState = "idle" | "copied" | "failed";

export function TerminalProxyCard({ connected, proxyInfo, tun = false }: TerminalProxyCardProps) {
  const [copied, setCopied] = useState<CopyState>("idle");

  async function handleCopy() {
    if (!proxyInfo) return;
    try {
      await navigator.clipboard.writeText(proxyInfo.terminal_commands.join("\n"));
      setCopied("copied");
      setTimeout(() => setCopied("idle"), 1500);
    } catch (error) {
      console.warn("Clipboard write failed:", error);
      setCopied("failed");
      setTimeout(() => setCopied("idle"), 1500);
    }
  }

  return (
    <section className="surface terminal-strip">
      <div className="terminal-strip-meta">
        <span>{t("home.terminal_proxy")}</span>
      </div>
      <div className="terminal-content">
        {tun ? <p>{t("tun.terminal_hint")}</p> : connected && proxyInfo ? (
          <pre title={proxyInfo.terminal_commands.join("; ")}>{proxyInfo.terminal_commands.join("; ")}</pre>
        ) : (
          <p>{t("home.connect_for_commands")}</p>
        )}
      </div>
      <div className="terminal-action">
        <Tooltip text={t("tooltip.terminal_proxy")} />
        {!tun && connected && proxyInfo && (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => void handleCopy()}>
            {copied === "copied"
              ? t("home.copied")
              : copied === "failed"
                ? t("home.copy_failed")
                : t("home.copy")}
          </button>
        )}
      </div>
    </section>
  );
}
