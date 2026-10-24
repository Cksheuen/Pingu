import { tauriInvoke } from "./tauri-invoke.js";

export interface EgressManagement {
  target: string;
  ssh_config: string;
  proxy_server: string;
}
export interface CloudflareExit {
  id: string;
  name: string;
  phase: "creating" | "ready" | "deleting";
  ready: boolean;
  ip: string | null;
  location: string | null;
  checked_at: string | null;
  created_at: string | null;
  error: string | null;
}
export interface MagpieTarget {
  ref: string;
  name: string;
  kind: "account" | "key";
  enabled: boolean;
  selection: string;
  effective_exit: string | null;
  effective_direct: boolean;
}
export interface MagpieProvider {
  id: string;
  name: string;
  revision: string;
  targets: MagpieTarget[];
  warning: string | null;
}
export interface MagpieState {
  available: boolean;
  providers: MagpieProvider[];
  references: Record<string, number>;
  web_url: string | null;
  error: string | null;
}
export interface EgressState {
  management: EgressManagement | null;
  selected: string;
  selected_proxy: string | null;
  eligible_proxy: string | null;
  installed: boolean;
  exits: CloudflareExit[];
  magpie: MagpieState;
  error: string | null;
}
export const getVpsEgress = (refresh = true) => tauriInvoke<EgressState>("get_vps_egress", { refresh });
export const configureVpsEgress = (management: EgressManagement) => tauriInvoke<EgressState>("configure_vps_egress", { management });
export const createCloudflareEgress = (name: string, id?: string) =>
  tauriInvoke<EgressState>("create_cloudflare_egress", { name, id: id ?? null });
export const selectVpsEgress = (mode: string) => tauriInvoke<EgressState>("select_vps_egress", { mode });
export const deleteCloudflareEgress = (id: string) => tauriInvoke<EgressState>("delete_cloudflare_egress", { id });
export const renameCloudflareEgress = (id: string, name: string) => tauriInvoke<EgressState>("rename_cloudflare_egress", { id, name });
export const bindMagpieEgress = (provider: string, accountRef: string, selection: string, revision: string) =>
  tauriInvoke<EgressState>("bind_magpie_egress", { provider, accountRef, selection, revision });
