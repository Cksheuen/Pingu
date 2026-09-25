import { ConnectionHero } from "../components/home/ConnectionHero";
import { ConnectionStatusHeader } from "../components/home/ConnectionStatusHeader";
import { CurrentNodeCard } from "../components/home/CurrentNodeCard";
import { TerminalProxyCard } from "../components/home/TerminalProxyCard";
import { TrafficCard } from "../components/home/TrafficCard";
import { NetworkLeaseCard } from "../components/home/NetworkLeaseCard";
import { AiPreflightCard } from "../components/home/AiPreflightCard";
import { useHomeConnection } from "../hooks/useHomeConnection";
import { useAiServicePreflight } from "../hooks/useAiServicePreflight";
import { useSubscriptionStore } from "../lib/subscription-store";
import { t } from "../lib/i18n";
import { Link } from "react-router-dom";
import { useI18nRerender } from "../hooks/useI18nRerender";

export default function Home() {
  const {
    status,
    proxyInfo,
    activeNode,
    activeRuleGroupId,
    activeRuleGroupName,
    hasRuleGroup,
    loading,
    error,
    clearError,
    toggleConnection,
  } = useHomeConnection();
  const preflight = useAiServicePreflight(status.connected, activeRuleGroupId);
  useI18nRerender();
  const subscriptions = useSubscriptionStore((state) => state.subscriptions);
  const subscriptionMode = status.active_node_id === "__subscriptions__" || (!activeNode && subscriptions.some((source) => source.enabled));

  return (
    <div className="page-shell home-page">
      <ConnectionStatusHeader connected={status.connected} />

      <div className="home-dashboard">
        <ConnectionHero
          connected={status.connected}
          uptimeSeconds={status.uptime_seconds}
          loading={loading}
          error={error}
          activeNodeName={subscriptionMode ? t("home.subscription_route") : activeNode?.name ?? null}
          onClearError={clearError}
          onToggleConnection={toggleConnection}
        />

        <div className="home-readouts">
          <CurrentNodeCard
            activeNode={activeNode}
            subscriptionMode={subscriptionMode}
            connected={status.connected}
            activeRuleGroupId={activeRuleGroupId}
            activeRuleGroupName={activeRuleGroupName}
            hasRuleGroup={hasRuleGroup}
          />
          <NetworkLeaseCard connected={status.connected} />
          <AiPreflightCard connected={status.connected} proxyInfo={proxyInfo} preflight={preflight} />
          <TrafficCard />
        </div>
      </div>

      <div className="home-network-links"><Link to="/subscriptions">{t("nav.subscriptions")} <span>→</span></Link><Link to="/strategies">{t("nav.strategies")} <span>→</span></Link><Link to="/connections">{t("nav.connections")} <span>→</span></Link></div>
      <TerminalProxyCard connected={status.connected} proxyInfo={proxyInfo} />
    </div>
  );
}
