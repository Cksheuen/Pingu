import { ConnectionHero } from "../components/home/ConnectionHero";
import { NetworkModeCard } from "../components/home/NetworkModeCard";
import { TerminalProxyCard } from "../components/home/TerminalProxyCard";
import { TrafficCard } from "../components/home/TrafficCard";
import { AiPreflightCard } from "../components/home/AiPreflightCard";
import { RouteStrip } from "../components/home/RouteStrip";
import { useHomeConnection } from "../hooks/useHomeConnection";
import { useAiServicePreflight } from "../hooks/useAiServicePreflight";
import { useRouteSummary } from "../hooks/useRouteSummary";
import { t } from "../lib/i18n";
import { useI18nRerender } from "../hooks/useI18nRerender";

export default function Home() {
  useI18nRerender();
  const {
    status, phase, proxyInfo, activeNode, activeRuleGroupId, activeRuleGroupName,
    loading, error, clearError, toggleConnection, needsSource,
  } = useHomeConnection();
  const route = useRouteSummary(activeNode?.name ?? null);
  const preflight = useAiServicePreflight(status.connected, activeRuleGroupId, route.routeKey);
  const name = status.active_node_name ?? (status.active_node_id === "__chain__" ? t("nav.chain")
    : status.active_node_id === "__subscriptions__"
      ? t("home.subscription_route") : activeNode?.name ?? null);
  return (
    <div className="page-shell home-page">
      <header className="page-header">
        <h1 className="page-title">{t("workspace.connection")}</h1>
        <NetworkModeCard />
      </header>
      <ConnectionHero
        connected={status.connected}
        phase={phase}
        uptimeSeconds={status.uptime_seconds}
        loading={loading}
        error={error}
        activeNodeName={name}
        connectLabel={needsSource ? t("workspace.add_source") : undefined}
        onClearError={clearError}
        onToggleConnection={toggleConnection}
      >
        <RouteStrip steps={route.steps} ruleGroup={activeRuleGroupName ?? activeRuleGroupId} />
      </ConnectionHero>
      <div className="connection-metrics">
        <TrafficCard />
        <AiPreflightCard
          connected={status.connected}
          proxyInfo={status.network_mode === "tun" ? null : proxyInfo}
          preflight={preflight}
        />
      </div>
      <TerminalProxyCard
        connected={status.connected}
        proxyInfo={proxyInfo}
        tun={status.network_mode === "tun"}
      />
    </div>
  );
}
