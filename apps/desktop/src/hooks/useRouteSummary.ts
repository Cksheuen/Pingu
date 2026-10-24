import { useEffect, useState } from "react";
import { create } from "zustand";
import { getProxyChain, getChainRuntime, type ChainSnapshot, type ChainRuntime } from "../lib/chain-api";
import { buildRouteSteps } from "../lib/route-summary";
import { useConnectionStore } from "../lib/connection-store";
import { useRuntimeOperation } from "../lib/runtime-operation";
import { useEgressStore } from "../lib/egress-store";

const useRouteChange = create<{ key: string }>(() => ({ key: "" }));
export const publishChainRoute = (key: string) => {
  if (useRouteChange.getState().key !== key) useRouteChange.setState({ key });
};

export function useRouteSummary(activeNodeName: string | null) {
  const status = useConnectionStore(state => state.status);
  const revision = useRuntimeOperation(state => state.revision);
  const changedRoute = useRouteChange(state => state.key);
  const egress = useEgressStore(state => state.data);
  const refreshEgress = useEgressStore(state => state.refresh);
  const [chain, setChain] = useState<ChainSnapshot | null>(null);
  const [runtime, setRuntime] = useState<ChainRuntime | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    void refreshEgress();
  }, [status.routing_revision, revision, refreshEgress]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const [nextChain, nextRuntime] = await Promise.allSettled([getProxyChain(), getChainRuntime()]);
      if (stopped) return;
      setError(nextChain.status === "rejected" || (status.connected
        && nextChain.value.settings.enabled && nextRuntime.status === "rejected"));
      setChain(nextChain.status === "fulfilled" ? nextChain.value : null);
      setRuntime(nextRuntime.status === "fulfilled" ? nextRuntime.value : null);
      if (status.connected) timer = setTimeout(() => void refresh(), 5_000);
    };
    void refresh();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [status.connected, status.routing_revision, revision, changedRoute]);

  const summary = buildRouteSteps({ status, chain, runtime, egress, activeNodeName });
  const egressError = useEgressStore(state => state.error);
  const steps = summary.steps.map(step => {
    const failed = error && ["node", "entry", "exit"].includes(step.id)
      || egressError && step.id === "egress";
    return failed ? { ...step, loading: false, label: null, labelKey: "route.unknown" } : step;
  });
  return {
    ...summary,
    steps,
    // Null while a hop is still resolving: one settled route yields one key,
    // so a connect does not trigger a verification per intermediate state.
    routeKey: steps.some(step => step.loading) ? null : JSON.stringify([status.routing_revision,
      status.active_node_id, changedRoute, chain?.settings, runtime?.route, egress?.selected]),
  };
}
