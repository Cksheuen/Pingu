import { tauriInvoke } from "./tauri-invoke.js";
export type ChainNodeRef = { kind: "manual"; node_id: string } | { kind: "subscription"; subscription_id: string; proxy_name: string };
export interface ChainSettings { enabled: boolean; entry: ChainNodeRef | null; exit: ChainNodeRef | null }
export interface ChainChoice { reference: ChainNodeRef; name: string; source: string; protocol: string; unavailable_reason: string | null }
export interface ChainSnapshot { settings: ChainSettings; choices: ChainChoice[] }
export interface TargetMeasurement { name: string; url: string; response_ms: number[]; error: string | null }
export interface RouteMeasurement { route: "direct_exit" | "chain"; targets: TargetMeasurement[]; egress_ip: string | null; error: string | null }
export interface ChainComparison { settings: ChainSettings; measured_at: string; routes: RouteMeasurement[]; cancelled: boolean; same_exit: boolean; gain_percent: number | null; eligible: boolean }
export interface ChainCandidate { reference: ChainNodeRef; name: string; source: string; comparison: ChainComparison | null; error: string | null }
export interface ChainSelection { outcome: "selected" | "no_gain" | "inconclusive" | "cancelled"; measured_at: string; baseline: RouteMeasurement; candidates: ChainCandidate[]; selected: ChainNodeRef | null; gain_percent: number | null; applied: boolean }
export interface ChainProgress { completed: number; total: number; running: boolean; applying: boolean }
export const getProxyChain = () => tauriInvoke<ChainSnapshot>("get_proxy_chain");
export interface ChainRuntime { route: "chain" | "entry" | "exit" | "unavailable" | "checking"; checked_at: string | null }
export const getChainRuntime = () => tauriInvoke<ChainRuntime>("get_chain_runtime");
export const saveProxyChain = (settings: ChainSettings, singleExit = false) => tauriInvoke<void>("save_proxy_chain", { settings, singleExit });
export const compareProxyChain = (settings: ChainSettings) => tauriInvoke<ChainComparison>("compare_proxy_chain", { settings });
export const autoSelectChain = (exit: ChainNodeRef) => tauriInvoke<ChainSelection>("auto_select_chain", { exit });
export const getChainProgress = () => tauriInvoke<ChainProgress>("get_chain_probe_progress");
export const cancelChainComparison = () => tauriInvoke<boolean>("cancel_chain_comparison");
export function nodeKey(ref: ChainNodeRef | null): string {
  if (!ref) return "";
  return ref.kind === "manual" ? JSON.stringify(["manual", ref.node_id]) : JSON.stringify(["subscription", ref.subscription_id, ref.proxy_name]);
}
export function median(values: number[]): number | null {
  const sorted = values.filter(n => Number.isFinite(n) && n > 0).sort((a,b) => a-b);
  if (!sorted.length) return null;
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i-1] + sorted[i]) / 2;
}
export function comparisonGain(result: ChainComparison): number | null {
  if (result.cancelled || !result.same_exit || result.routes.length !== 2) return null;
  if (result.routes.some(r => r.error || r.targets.length !== 2 || r.targets.some(t => t.error || t.response_ms.length !== 3 || t.response_ms.some(n => !Number.isFinite(n) || n <= 0)))) return null;
  return result.gain_percent !== null && Number.isFinite(result.gain_percent) ? result.gain_percent : null;
}
