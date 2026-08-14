import { ConnectionHero } from "../components/home/ConnectionHero";
import { ConnectionStatusHeader } from "../components/home/ConnectionStatusHeader";
import { CurrentNodeCard } from "../components/home/CurrentNodeCard";
import { TerminalProxyCard } from "../components/home/TerminalProxyCard";
import { TrafficCard } from "../components/home/TrafficCard";
import { NetworkLeaseCard } from "../components/home/NetworkLeaseCard";
import { EgressCard } from "../components/home/EgressCard";
import { useHomeConnection } from "../hooks/useHomeConnection";
import { useI18nRerender } from "../hooks/useI18nRerender";

export default function Home() {
  const {
    status,
    proxyInfo,
    activeNode,
    activeRuleGroupId,
    activeRuleGroupName,
    hasRuleGroup,
    elapsed,
    loading,
    error,
    clearError,
    toggleConnection,
  } = useHomeConnection();
  useI18nRerender();

  return (
    <div className="page-shell home-page">
      <ConnectionStatusHeader connected={status.connected} />

      <div className="home-dashboard">
        <ConnectionHero
          connected={status.connected}
          elapsed={elapsed}
          loading={loading}
          error={error}
          activeNodeName={activeNode?.name ?? null}
          onClearError={clearError}
          onToggleConnection={toggleConnection}
        />

        <div className="home-readouts">
          <CurrentNodeCard
            activeNode={activeNode}
            connected={status.connected}
            activeRuleGroupId={activeRuleGroupId}
            activeRuleGroupName={activeRuleGroupName}
            hasRuleGroup={hasRuleGroup}
          />
          <NetworkLeaseCard connected={status.connected} />
          <EgressCard connected={status.connected} />
          <TrafficCard />
        </div>
      </div>

      <TerminalProxyCard connected={status.connected} proxyInfo={proxyInfo} />
    </div>
  );
}
