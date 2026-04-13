import { useEffect, useState } from "react";
import { connect, disconnect } from "../lib/connection-api";
import { useConnectionStore } from "../lib/connection-store";
import type { Node } from "../lib/types";

interface HomeConnectionModel {
  status: ReturnType<typeof useConnectionStore.getState>["status"];
  proxyInfo: ReturnType<typeof useConnectionStore.getState>["proxyInfo"];
  activeNode: Node | null;
  activeRuleGroupId: string | null;
  activeRuleGroupName: string | null;
  hasRuleGroup: boolean;
  elapsed: number;
  loading: boolean;
  error: string | null;
  clearError: () => void;
  toggleConnection: () => Promise<void>;
}

export function useHomeConnection(): HomeConnectionModel {
  const { status, nodes, proxyInfo, refreshStatus } = useConnectionStore();
  const [elapsed, setElapsed] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const id = setInterval(() => setElapsed((current) => current + 1), 1000);
    return () => clearInterval(id);
  }, [status.connected, status.uptime_seconds]);

  const activeNode = nodes.find((node) => node.id === status.active_node_id) ?? null;
  const activeRuleGroupName = status.active_group_name;
  const activeRuleGroupId = status.active_group_id;
  const hasRuleGroup = Boolean(activeRuleGroupName || activeRuleGroupId);

  const toggleConnection = async () => {
    setLoading(true);
    try {
      if (status.connected) {
        await disconnect();
      } else {
        await connect();
      }
    } catch (cause) {
      setError(typeof cause === "string" ? cause : "Connection failed");
    } finally {
      await refreshStatus().catch(() => undefined);
      setLoading(false);
    }
  };

  return {
    status,
    proxyInfo,
    activeNode,
    activeRuleGroupId,
    activeRuleGroupName,
    hasRuleGroup,
    elapsed,
    loading,
    error,
    clearError: () => setError(null),
    toggleConnection,
  };
}
