import { useState } from "react";
import type { ProxyInfo } from "../../lib/types";
import type { AiServicePreflightModel } from "../../hooks/useAiServicePreflight";
import { t } from "../../lib/i18n";

interface AiPreflightCardProps {
  connected: boolean;
  proxyInfo: ProxyInfo | null;
  preflight: AiServicePreflightModel;
}

export function AiPreflightCard({ connected, proxyInfo, preflight }: AiPreflightCardProps) {
  const [copied, setCopied] = useState(false);
  const { report, checking, error, check } = preflight;
  const claudeCommand = proxyInfo
    ? `HTTP_PROXY=${proxyInfo.http_proxy} HTTPS_PROXY=${proxyInfo.http_proxy} claude`
    : null;

  async function copyClaudeCommand() {
    if (!claudeCommand) return;
    try {
      await navigator.clipboard.writeText(claudeCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  const description = error
    ? error
    : !connected
      ? t("home.preflight_connect")
      : checking && !report
        ? t("home.preflight_checking")
        : report?.ready
          ? t("home.preflight_ready")
          : t("home.preflight_route_error");

  return (
    <section className="surface readout-card preflight-readout">
      <div className="readout-card-head">
        <span className="section-label">{t("home.ai_preflight")}</span>
      </div>
      <div className="egress-value-row">
        <strong>{connected ? report?.egress_ip ?? (checking ? t("home.preflight_checking") : "—") : "—"}</strong>
        <button className="readout-action" type="button" onClick={() => void check()} disabled={!connected || checking}>
          {checking ? t("home.preflight_checking") : t("home.preflight_recheck")}
        </button>
      </div>
      {report && (
        <>
          <ul className="preflight-route-list preflight-content-list">
            {report.network_checks.map((check) => (
              <li key={check.id} data-outbound="proxy">
                <span>{t(`home.preflight_check_${check.id}`)}</span>
                <strong>{check.observed_ip ?? t("home.preflight_check_passed")}</strong>
              </li>
            ))}
          </ul>
          <ul className="preflight-route-list">
            {report.routes.map((route) => (
              <li key={route.host} data-outbound={route.outbound} title={route.matched_by}>
                <span>{route.service}</span>
                <strong>{t(`home.preflight_route_${route.outbound}`)}</strong>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className={error || (report && !report.ready) ? "egress-note egress-note-error" : "egress-note"}>
        {description}
      </p>
      <div className="preflight-actions">
        {report?.ready && claudeCommand && (
          <button type="button" onClick={() => void copyClaudeCommand()}>
            {copied ? t("home.copied") : t("home.preflight_copy_claude")}
          </button>
        )}
      </div>
      <p className="egress-note">{t("home.preflight_scope_note")}</p>
    </section>
  );
}
