import { Link } from "react-router-dom";
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

  const dynamicRouting = report?.routes.some((route) => route.outbound === "runtime") ?? false;
  const description = error
    ? error
    : !connected
      ? t("home.preflight_connect")
      : checking && !report
        ? t("home.preflight_checking")
        : dynamicRouting
          ? t("home.preflight_dynamic")
          : report?.ready
            ? t("home.preflight_ready")
            : t("home.preflight_route_error");

  return (
    <section className="surface readout-card preflight-readout">
      <div
        className="preflight-summary"
        data-state={!connected ? "idle" : checking ? "checking" : report?.ready ? "ready" : "issue"}
      >
        <span className="readout-label">{t("home.preflight_title")}</span>
        <span className="pill preflight-status" role="status">
          <span className="status-dot" aria-hidden="true" />
          {!connected ? t("home.disconnected") : checking ? t("home.preflight_checking")
            : report?.ready ? t("home.preflight_ready_short") : t("home.preflight_issue")}
        </span>
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          onClick={() => void check()}
          disabled={!connected || checking}
          aria-busy={checking}
        >
          {t("home.preflight_recheck")}
        </button>
      </div>
      <div className="preflight-egress">
        <span>{t("home.egress_ip")}</span>
        <strong className="preflight-ip" title={report?.egress_ip}>{report?.egress_ip ?? "—"}</strong>
      </div>
      <details className="preflight-details">
        <summary>{t("home.details")}</summary>
        <p className="preflight-note">{description}</p>
        <ul className="preflight-route-list preflight-content-list">
          {report?.network_checks.map(
            (check) =>
            (
              <li key={check.id} data-outbound="proxy">
                <span>{t(`home.preflight_check_${check.id}`)}</span>
                <strong>{check.observed_ip ?? t("home.preflight_check_passed")}</strong>
              </li>
            )
          )}
        </ul>
        <ul className="preflight-route-list">
          {report?.routes.map(
            (route) =>
            (
              <li key={route.host} data-outbound={route.outbound} title={route.matched_by}>
                <span>{route.service}</span>
                <strong>{t(`home.preflight_route_${route.outbound}`)}</strong>
              </li>
            )
          )}
        </ul>
        <p className="preflight-note">{t("home.preflight_scope_note")}</p>
        <div className="preflight-actions">
          {dynamicRouting
            && <Link className="network-text-link" to="/activity">{t("nav.connections")} →</Link>}
          {report?.ready && claudeCommand
            && (
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => void copyClaudeCommand()}
              >
                {copied ? t("home.copied") : t("home.preflight_copy_claude")}
              </button>
            )}
        </div>
      </details>
    </section>
  );
}
