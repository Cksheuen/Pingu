import type { ChainSnapshot, ChainRuntime, ChainNodeRef } from "./chain-api.js";
import type { EgressState } from "./egress-api.js";
import type { ProxyStatus } from "./types.js";

export interface RouteStep {
  id: "mac" | "node" | "entry" | "exit" | "egress" | "internet";
  label: string | null;
  labelKey?: string;
  captionKey?: string;
  path?: string;
  loading?: boolean;
  skipped?: boolean;
}
export interface RouteSummaryInput {
  status: ProxyStatus;
  chain: ChainSnapshot | null;
  runtime: ChainRuntime | null;
  egress: EgressState | null;
  activeNodeName: string | null;
}

function sameReference(left: ChainNodeRef, right: ChainNodeRef): boolean {
  return left.kind === "manual" && right.kind === "manual" ? left.node_id === right.node_id
    : left.kind === "subscription" && right.kind === "subscription"
      && left.subscription_id === right.subscription_id && left.proxy_name === right.proxy_name;
}

export function buildRouteSteps({ status, chain, runtime, egress, activeNodeName }: RouteSummaryInput): {
  steps: RouteStep[]; fallback: boolean;
} {
  const steps: RouteStep[] = [{ id: "mac", label: null, labelKey: "route.this_mac" }];
  const subscription = status.active_node_id === "__subscriptions__";
  const chained = !subscription && (status.active_node_id === "__chain__" || !!chain?.settings.enabled);
  const fallback = status.connected && chained && (runtime?.route === "entry" || runtime?.route === "exit");
  if (chained) {
    for (const id of ["entry", "exit"] as const) {
      const ref = chain?.settings[id];
      const name = ref ? chain?.choices.find(choice => sameReference(choice.reference, ref))?.name
        ?? (ref.kind === "subscription" ? ref.proxy_name : null) : null;
      steps.push({
        id, label: name ?? null, labelKey: name ? undefined : "route.unknown",
        captionKey: `chain.${id}`, path: "/route#chain",
        loading: !chain || (status.connected && !runtime),
        skipped: !!fallback && runtime?.route !== id,
      });
    }
  } else {
    const name = status.active_node_name ?? activeNodeName;
    steps.push({
      id: "node", label: name, labelKey: name ? undefined
        : subscription ? "home.subscription_route" : "home.no_node",
      captionKey: subscription ? "route.strategy" : "route.node", path: "/route#chain",
      loading: !chain && !name && !subscription,
    });
  }
  const selected = egress?.exits.find(exit => exit.id === egress.selected);
  steps.push({
    id: "egress", label: selected ? [selected.name, selected.ip].filter(Boolean).join(" · ") : null,
    labelKey: !egress || !egress.management || (egress.selected !== "direct" && !selected)
      ? "route.unknown" : egress.selected === "direct" ? "egress.direct" : undefined,
    captionKey: "chain.egress", path: "/route#egress", loading: !egress,
  });
  steps.push({ id: "internet", label: null, labelKey: "route.internet" });
  return { steps, fallback };
}
