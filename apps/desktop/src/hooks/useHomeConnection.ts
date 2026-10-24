import { useCallback, useEffect } from "react";
import { useRuntimeOperation } from "../lib/runtime-operation";
import { connect, disconnect } from "../lib/connection-api";
import { useConnectionStore } from "../lib/connection-store";
import { create } from "zustand";
import { useNavigate } from "react-router-dom";
import { useSubscriptionStore } from "../lib/subscription-store";
import { t } from "../lib/i18n";
import type { Node } from "../lib/types";

const useConnectionError = create<{ error: string | null }>(() => ({ error: null }));
const clearError = () => useConnectionError.setState({ error: null });

interface HomeConnectionModel {
  needsSource: boolean;
  status: ReturnType<typeof useConnectionStore.getState>["status"];
  phase: ReturnType<typeof useConnectionStore.getState>["status"]["phase"];
  proxyInfo: ReturnType<typeof useConnectionStore.getState>["proxyInfo"];
  activeNode: Node | null;
  activeRuleGroupId: string | null;
  activeRuleGroupName: string | null;
  hasRuleGroup: boolean;
  loading: boolean;
  error: string | null;
  clearError: () => void;
  toggleConnection: () => Promise<void>;
}

export function useHomeConnection(): HomeConnectionModel {
  const status = useConnectionStore((state) => state.status);
  const nodes = useConnectionStore((state) => state.nodes);
  const proxyInfo = useConnectionStore((state) => state.proxyInfo);
  const refreshStatus = useConnectionStore((state) => state.refreshStatus);
  const operation = useRuntimeOperation(s => s.command);
  const loaded = useConnectionStore(state => state.loaded);
  const loading = !loaded || !!operation
    || !!status.phase && !["connected", "disconnected"].includes(status.phase);
  // The backend phase arrives with the next status read; show the requested
  // transition at once so the control never looks idle while it works.
  const settled = status.phase === "connected" || status.phase === "disconnected";
  const phase = settled && operation === "connect" ? "connecting"
    : settled && operation === "disconnect" ? "disconnecting" : status.phase;
  const error = useConnectionError(state => state.error);
  const subscriptions = useSubscriptionStore(state => state.subscriptions);
  const navigate = useNavigate();
  const needsSource = !status.connected && nodes.length === 0
    && !subscriptions.some(source => source.enabled);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(clearError, 5_000);
    return () => clearTimeout(timer);
  }, [error]);

  const activeNode = nodes.find((node) => node.id === status.active_node_id) ?? null;
  const activeRuleGroupName = status.active_group_name;
  const activeRuleGroupId = status.active_group_id;
  const hasRuleGroup = Boolean(activeRuleGroupName || activeRuleGroupId);

  const toggleConnection = useCallback(async () => {
    if (loading) return;
    if (needsSource) { navigate("/sources"); return; }
    clearError();
    try {
      if (status.connected) {
        await disconnect();
      } else {
        await connect();
      }
    } catch (cause) {
      useConnectionError.setState({ error: typeof cause === "string" ? cause
        : cause instanceof Error ? cause.message : t("home.connection_failed") });
    } finally {
      await refreshStatus().catch(() => undefined);
    }
  }, [refreshStatus, status.connected, loading, needsSource, navigate]);

  return {
    needsSource,
    status,
    phase,
    proxyInfo,
    activeNode,
    activeRuleGroupId,
    activeRuleGroupName,
    hasRuleGroup,
    loading,
    error,
    clearError,
    toggleConnection,
  };
}
