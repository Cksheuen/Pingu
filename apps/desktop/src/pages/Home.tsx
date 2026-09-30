import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ConnectionHero } from "../components/home/ConnectionHero";
import { TerminalProxyCard } from "../components/home/TerminalProxyCard";
import { TrafficCard } from "../components/home/TrafficCard";
import { AiPreflightCard } from "../components/home/AiPreflightCard";
import { SectionHeader } from "../components/SectionHeader";
import { useHomeConnection } from "../hooks/useHomeConnection";
import { useAiServicePreflight } from "../hooks/useAiServicePreflight";
import { useSubscriptionStore } from "../lib/subscription-store";
import { t } from "../lib/i18n";
import { useI18nRerender } from "../hooks/useI18nRerender";
import { useConnectionStore } from "../lib/connection-store";
import Chain from "./Chain";
import Strategies from "./Strategies";

export default function Home() {
  const { status, proxyInfo, activeNode, activeRuleGroupId, activeRuleGroupName,
    loading, error, clearError, toggleConnection } = useHomeConnection();
  const [chainRoute, setChainRoute] = useState("");
  const preflight = useAiServicePreflight(status.connected, activeRuleGroupId, `${status.active_node_id}:${chainRoute}`);
  useI18nRerender();
  const { hash } = useLocation();
  const [strategiesOpen, setStrategiesOpen] = useState(hash === "#strategies");
  const [terminalOpen, setTerminalOpen] = useState(false);
  useEffect(() => { if (hash === "#strategies") setStrategiesOpen(true); }, [hash]);
  const navigate = useNavigate();
  const nodeCount = useConnectionStore(state => state.nodes.length);
  const subscriptions = useSubscriptionStore((state) => state.subscriptions);
  const needsSource = !status.connected && nodeCount === 0 && !subscriptions.some(source => source.enabled);
  const chainMode = status.active_node_id === "__chain__";
  const subscriptionMode = status.active_node_id === "__subscriptions__" || (!activeNode && subscriptions.some((source) => source.enabled));
  return <div className="page-shell home-page">
    <SectionHeader title={t("workspace.connection")}>
      <Link className="route-rule-link" to="/routing">{t("workspace.routing")} · {activeRuleGroupName ?? activeRuleGroupId ?? "—"} <span aria-hidden="true">↗</span></Link>
    </SectionHeader>
    <ConnectionHero connected={status.connected} uptimeSeconds={status.uptime_seconds} loading={loading} error={error}
      activeNodeName={chainMode ? t("nav.chain") : subscriptionMode ? t("home.subscription_route") : activeNode?.name ?? null}
      connectLabel={needsSource ? t("workspace.add_source") : undefined} onClearError={clearError} onToggleConnection={needsSource ? async () => navigate("/sources") : toggleConnection} />
    <div className="connection-metrics"><TrafficCard /><AiPreflightCard connected={status.connected} proxyInfo={proxyInfo} preflight={preflight} /></div>
    <div id="chain"><Chain embedded onRouteChange={setChainRoute} /></div>
    <div className="home-tools"><details className="surface workspace-disclosure" id="strategies" open={strategiesOpen} onToggle={event => setStrategiesOpen(event.currentTarget.open)}>
      <summary>{t("nav.strategies")}</summary>{strategiesOpen && <Strategies embedded />}
    </details>
    <details className="surface workspace-disclosure" open={terminalOpen} onToggle={event => setTerminalOpen(event.currentTarget.open)}><summary>{t("home.terminal_proxy")}</summary>{terminalOpen && <TerminalProxyCard connected={status.connected} proxyInfo={proxyInfo} />}</details></div>
  </div>;
}
