export interface Node {
  id: string;
  name: string;
  address: string;
  port: number;
  uuid: string;
  flow: string;
  sni: string;
  fingerprint: string;
  public_key: string;
  short_id: string;
  transport: string;
  security: string;
}

export type RuleType = "geosite" | "geoip" | "domain_suffix" | "domain" | "ip_cidr" | "ip_is_private";
export type Outbound = "direct" | "proxy" | "block";
export type Strategy = "direct" | "proxy";

export interface Rule {
  id: string;
  rule_type: RuleType;
  match_value: string;
  outbound: Outbound;
}

export interface ProxyStatus {
  connected: boolean;
  active_node_id: string | null;
  active_group_id: string | null;
  active_group_name: string | null;
  uptime_seconds: number;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

export interface RuleGroup {
  id: string;
  name: string;
  rules: Rule[];
  default_strategy: Strategy;
}

export interface ProxyInfo {
  listen_host: string;
  listen_port: number;
  http_proxy: string;
  socks_proxy: string;
  terminal_commands: string[];
  unset_commands: string[];
}

export type HostOverrideResolver =
  | "inherit"
  | "system-dns"
  | "local-dns"
  | "remote-dns";

export type HostOverrideOutbound = "inherit" | Outbound;

export type HostOverrideSource =
  | "manual"
  | "runtime_learned"
  | "runtime_fallback";

export interface HostOverride {
  id: string;
  host: string;
  resolver: HostOverrideResolver;
  outbound: HostOverrideOutbound;
  enabled: boolean;
  source: HostOverrideSource;
  reason: string;
  last_verified_at: string | null;
  last_verified_result: string | null;
}

export interface HostOverrideDraft {
  host: string;
  resolver: HostOverrideResolver;
  outbound: HostOverrideOutbound;
  enabled: boolean;
  reason: string;
}
