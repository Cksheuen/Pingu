import { ConnectionHero } from "../components/home/ConnectionHero";
import { ConnectionStatusHeader } from "../components/home/ConnectionStatusHeader";
import { CurrentNodeCard } from "../components/home/CurrentNodeCard";
import { TerminalProxyCard } from "../components/home/TerminalProxyCard";
import { TrafficCard } from "../components/home/TrafficCard";
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
    <div className="flex-1 flex flex-col overflow-y-auto" style={{ padding: "32px 40px", gap: "32px" }}>
      <ConnectionStatusHeader connected={status.connected} />

      <ConnectionHero
        connected={status.connected}
        elapsed={elapsed}
        loading={loading}
        error={error}
        onClearError={clearError}
        onToggleConnection={toggleConnection}
      />

      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <CurrentNodeCard
            activeNode={activeNode}
            connected={status.connected}
            activeRuleGroupId={activeRuleGroupId}
            activeRuleGroupName={activeRuleGroupName}
            hasRuleGroup={hasRuleGroup}
          />
          <TrafficCard />
        </div>

        <TerminalProxyCard connected={status.connected} proxyInfo={proxyInfo} />
      </div>
    </div>
  );
}
