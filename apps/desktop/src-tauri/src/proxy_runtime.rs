use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use url::Url;

use crate::singbox::config_gen::{
    generate_config_with_host_overrides_and_port, NameServerPolicy, RuleGroup,
};
use crate::singbox::uri_parser::Node;
use crate::storage::app_config::{AppConfig, HostOverride};

const EGRESS_PROBE_URL: &str = "https://api.ipify.org/";
const CLOUDFLARE_TRACE_URL: &str = "https://www.cloudflare.com/cdn-cgi/trace";
const GOOGLE_CONTENT_PROBE_URL: &str = "https://www.google.com/generate_204";
const AI_SERVICE_TARGETS: [(&str, &str); 4] = [
    ("Claude API", "api.anthropic.com"),
    ("Claude Web", "claude.ai"),
    ("OpenAI API", "api.openai.com"),
    ("ChatGPT", "chatgpt.com"),
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProxyStatus {
    pub connected: bool,
    pub active_node_id: Option<String>,
    pub active_group_id: Option<String>,
    pub active_group_name: Option<String>,
    pub uptime_seconds: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProxyInfo {
    pub listen_host: String,
    pub listen_port: u16,
    pub http_proxy: String,
    pub socks_proxy: String,
    pub terminal_commands: Vec<String>,
    pub unset_commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AiServiceRoute {
    pub service: String,
    pub host: String,
    pub outbound: String,
    pub matched_by: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NetworkContentCheck {
    pub id: String,
    pub observed_ip: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AiServicePreflight {
    pub egress_ip: String,
    pub network_checks: Vec<NetworkContentCheck>,
    pub routes: Vec<AiServiceRoute>,
    pub ready: bool,
}

#[derive(Debug, Clone)]
pub struct RuntimeSelection {
    pub node: Node,
    pub rule_group: RuleGroup,
}

pub struct PreparedRuntime {
    pub config_dir: PathBuf,
    pub config_path: PathBuf,
    pub cache_path: PathBuf,
    pub node: Node,
    pub rule_group: RuleGroup,
    pub clash_api_port: u16,
    pub listen_port: u16,
}

pub fn find_available_port(start: u16) -> Result<u16, String> {
    for port in start..=start.saturating_add(100) {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    Err(format!(
        "No available port found in range {}-{}",
        start,
        start.saturating_add(100)
    ))
}

pub fn app_config_dir() -> Result<PathBuf, String> {
    let config_dir = dirs::config_dir()
        .ok_or("Cannot find config directory")?
        .join("sing-proxy");
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    Ok(config_dir)
}

pub fn resolve_runtime_selection(config: &AppConfig) -> Result<RuntimeSelection, String> {
    let active_node_id = config
        .active_node_id
        .as_ref()
        .ok_or("No active node selected")?;
    let node = config
        .nodes
        .iter()
        .find(|node| &node.id == active_node_id)
        .cloned()
        .ok_or("Active node not found")?;
    let rule_group = config.active_rule_group()?.clone();

    Ok(RuntimeSelection { node, rule_group })
}

pub fn prepare_runtime(config: &AppConfig) -> Result<PreparedRuntime, String> {
    prepare_runtime_generation(config, None)
}

pub fn prepare_runtime_generation(
    config: &AppConfig,
    generation: Option<u64>,
) -> Result<PreparedRuntime, String> {
    prepare_runtime_generation_with_port(config, generation, 2080)
}

pub fn prepare_runtime_generation_with_port(
    config: &AppConfig,
    generation: Option<u64>,
    listen_port: u16,
) -> Result<PreparedRuntime, String> {
    let selection = resolve_runtime_selection(config)?;
    let clash_api_port = find_available_port(9090)?;

    let config_dir = app_config_dir()?;
    let cache_path = config_dir.join("cache.db");
    let config_path = match generation {
        Some(generation) => config_dir.join(format!("sing-box-config-{generation}.json")),
        None => config_dir.join("sing-box-config.json"),
    };
    let host_overrides = resolve_runtime_host_overrides(config, &selection.rule_group);
    let sb_config = generate_config_with_host_overrides_and_port(
        &selection.node,
        &selection.rule_group,
        cache_path.to_str().ok_or("Invalid cache path")?,
        &host_overrides,
        clash_api_port,
        listen_port,
    );
    let config_str = serde_json::to_string_pretty(&sb_config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, config_str).map_err(|e| e.to_string())?;

    Ok(PreparedRuntime {
        config_dir,
        config_path,
        cache_path,
        node: selection.node,
        rule_group: selection.rule_group,
        clash_api_port,
        listen_port,
    })
}

pub fn build_proxy_status(
    config: &AppConfig,
    connected: bool,
    uptime_seconds: u64,
    active_node_id: Option<String>,
    active_group_id: Option<String>,
) -> ProxyStatus {
    if !connected {
        return ProxyStatus {
            connected: false,
            active_node_id: None,
            active_group_id: None,
            active_group_name: None,
            uptime_seconds: 0,
        };
    }

    let active_group_name = active_group_id
        .as_deref()
        .and_then(|id| config.find_rule_group_name(id));

    ProxyStatus {
        connected: true,
        active_node_id,
        active_group_id,
        active_group_name,
        uptime_seconds,
    }
}

pub fn proxy_info(listen_port: u16) -> ProxyInfo {
    let http_proxy = format!("http://127.0.0.1:{listen_port}");
    let socks_proxy = format!("socks5://127.0.0.1:{listen_port}");
    ProxyInfo {
        listen_host: "127.0.0.1".to_string(),
        listen_port,
        http_proxy: http_proxy.clone(),
        socks_proxy: socks_proxy.clone(),
        terminal_commands: vec![
            format!("export http_proxy={http_proxy}"),
            format!("export https_proxy={http_proxy}"),
            format!("export all_proxy={socks_proxy}"),
        ],
        unset_commands: vec!["unset http_proxy https_proxy all_proxy".to_string()],
    }
}

/// Query the IP address seen by a request that is explicitly sent through the
/// local sing-box listener. This intentionally does not depend on macOS
/// system-proxy settings, so it is safe to use while validating a connection.
pub fn probe_proxy_egress(listen_port: u16) -> Result<String, String> {
    let response = proxy_probe_agent(listen_port)?
        // ping0.cc serves a browser-oriented HTML page, rather than a plain IP
        // response. api.ipify.org is deliberately used here because this API
        // returns only the observed address (with an optional trailing newline).
        .get(EGRESS_PROBE_URL)
        .call()
        .map_err(|error| format!("Failed to verify proxy egress: {error}"))?
        .into_string()
        .map_err(|error| format!("Failed to read proxy egress: {error}"))?;
    parse_egress_ip(&response)
}

/// Verify actual response content through the local proxy. These checks answer
/// different questions: the observed egress address, Cloudflare's trace view
/// of that address, and a real Google HTTP response. They deliberately do not
/// claim that an IP is "clean" or that a Cloudflare challenge is passable.
pub fn verify_proxy_content(listen_port: u16) -> Result<Vec<NetworkContentCheck>, String> {
    let agent = proxy_probe_agent(listen_port)?;
    let egress_ip = agent
        .get(EGRESS_PROBE_URL)
        .call()
        .map_err(|error| format!("Failed to verify proxy egress: {error}"))?
        .into_string()
        .map_err(|error| format!("Failed to read proxy egress: {error}"))
        .and_then(|response| parse_egress_ip(&response))?;

    let cloudflare_trace = agent
        .get(CLOUDFLARE_TRACE_URL)
        .call()
        .map_err(|error| format!("Cloudflare trace request failed: {error}"))?
        .into_string()
        .map_err(|error| format!("Failed to read Cloudflare trace: {error}"))?;
    let cloudflare_ip = cloudflare_trace
        .lines()
        .find_map(|line| line.strip_prefix("ip="))
        .map(str::trim)
        .ok_or("Cloudflare trace did not return an IP address")?;
    let cloudflare_ip = parse_egress_ip(cloudflare_ip)?;
    if cloudflare_ip != egress_ip {
        return Err(format!(
            "Egress mismatch: IP service returned {egress_ip}, Cloudflare trace returned {cloudflare_ip}"
        ));
    }

    let google_response = agent
        .get(GOOGLE_CONTENT_PROBE_URL)
        .call()
        .map_err(|error| format!("Google content check failed: {error}"))?;
    if google_response.status() != 204 {
        return Err(format!(
            "Google content check returned HTTP {} instead of 204",
            google_response.status()
        ));
    }

    Ok(content_checks_for_egress(egress_ip))
}

fn proxy_probe_agent(listen_port: u16) -> Result<ureq::Agent, String> {
    let proxy = ureq::Proxy::new(&format!("http://127.0.0.1:{listen_port}"))
        .map_err(|error| format!("Failed to configure egress probe: {error}"))?;
    Ok(ureq::AgentBuilder::new()
        .proxy(proxy)
        .timeout(Duration::from_secs(8))
        .build())
}

pub fn content_checks_for_egress(egress_ip: String) -> Vec<NetworkContentCheck> {
    vec![
        NetworkContentCheck {
            id: "egress_ip".to_string(),
            observed_ip: Some(egress_ip.clone()),
        },
        NetworkContentCheck {
            id: "cloudflare_trace".to_string(),
            observed_ip: Some(egress_ip),
        },
        NetworkContentCheck {
            id: "google_content".to_string(),
            observed_ip: None,
        },
    ]
}

/// Build a deterministic, configuration-level readiness report for the AI
/// services Pingu documents. The observed egress is supplied by the explicit
/// local-proxy probe; this function never infers it from the selected node.
pub fn build_ai_service_preflight(
    config: &AppConfig,
    egress_ip: String,
    network_checks: Vec<NetworkContentCheck>,
) -> Result<AiServicePreflight, String> {
    let rule_group = config.active_rule_group()?;
    let routes = AI_SERVICE_TARGETS
        .iter()
        .map(|(service, host)| {
            let (outbound, matched_by) = configured_outbound_for_host(config, rule_group, host);
            AiServiceRoute {
                service: (*service).to_string(),
                host: (*host).to_string(),
                outbound,
                matched_by,
            }
        })
        .collect::<Vec<_>>();
    let ready = routes.iter().all(|route| route.outbound == "proxy");

    Ok(AiServicePreflight {
        egress_ip,
        network_checks,
        routes,
        ready,
    })
}

fn parse_egress_ip(response: &str) -> Result<String, String> {
    let ip = response.trim();
    ip.parse::<std::net::IpAddr>()
        .map(|address| address.to_string())
        .map_err(|_| "Egress probe returned an invalid IP address".to_string())
}

fn configured_outbound_for_host(
    config: &AppConfig,
    rule_group: &RuleGroup,
    host: &str,
) -> (String, String) {
    for override_item in config.host_overrides.iter().filter(|item| item.enabled) {
        if normalize_policy_suffix(&override_item.host) == host
            && override_item.outbound_mode != "inherit"
        {
            return (
                override_item.outbound_mode.clone(),
                format!("host override: {}", override_item.host),
            );
        }
    }

    for rule in &rule_group.rules {
        let matched = match rule.rule_type.as_str() {
            "domain" => normalize_policy_suffix(&rule.match_value) == host,
            "domain_suffix" => {
                let suffix = normalize_policy_suffix(&rule.match_value);
                !suffix.is_empty() && (host == suffix || host.ends_with(&format!(".{suffix}")))
            }
            _ => false,
        };
        if matched {
            return (
                rule.outbound.clone(),
                format!("{}: {}", rule.rule_type, rule.match_value),
            );
        }
    }

    (
        rule_group.default_strategy.clone(),
        "rule group default".to_string(),
    )
}

pub fn check_generated_config(config_path: &Path) -> Result<(), String> {
    let output = Command::new(crate::resolve_sing_box_path())
        .args([
            "check",
            "-c",
            config_path.to_str().ok_or("Invalid config path")?,
        ])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                crate::missing_sing_box_message()
            } else {
                format!("Failed to run sing-box check: {}", e)
            }
        })?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let message = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "sing-box check failed".to_string()
    };
    Err(message)
}

fn resolve_runtime_host_overrides(config: &AppConfig, rule_group: &RuleGroup) -> Vec<HostOverride> {
    let mut overrides: Vec<HostOverride> = config
        .host_overrides
        .iter()
        .filter(|item| item.enabled)
        .cloned()
        .collect();

    let known_hosts: std::collections::HashSet<String> = config
        .host_overrides
        .iter()
        .map(|item| item.host.clone())
        .collect();

    if let Some(item) = discover_runtime_host_override(rule_group, &known_hosts) {
        overrides.push(item);
    }

    overrides
}

fn discover_runtime_host_override(
    rule_group: &RuleGroup,
    known_hosts: &std::collections::HashSet<String>,
) -> Option<HostOverride> {
    let host = current_npm_registry_host()?;
    if known_hosts.contains(&host)
        || !nameserver_policy_matches_host(&rule_group.nameserver_policy, &host)
    {
        return None;
    }

    Some(HostOverride {
        id: format!("runtime-fallback-{}", host),
        host,
        resolver_mode: "system-dns".to_string(),
        outbound_mode: "inherit".to_string(),
        enabled: true,
        source: "runtime_fallback".to_string(),
        reason: "Current npm registry matched nameserver policy".to_string(),
        updated_at: current_runtime_timestamp(),
    })
}

fn current_npm_registry_host() -> Option<String> {
    std::env::var("NPM_CONFIG_REGISTRY")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(read_npm_registry_from_command)
        .and_then(|registry| parse_registry_host(&registry))
}

fn read_npm_registry_from_command() -> Option<String> {
    let output = Command::new("npm")
        .args(["config", "get", "registry"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let registry = String::from_utf8(output.stdout).ok()?;
    let trimmed = registry.trim();
    if trimmed.is_empty() || trimmed == "undefined" {
        return None;
    }

    Some(trimmed.to_string())
}

fn parse_registry_host(registry: &str) -> Option<String> {
    let url = Url::parse(registry.trim()).ok()?;
    url.host_str().map(|host| host.to_string())
}

fn nameserver_policy_matches_host(policies: &[NameServerPolicy], host: &str) -> bool {
    policies.iter().any(|policy| {
        let suffix = normalize_policy_suffix(&policy.domain_suffix);
        !suffix.is_empty() && (host == suffix || host.ends_with(&format!(".{}", suffix)))
    })
}

fn normalize_policy_suffix(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("+.")
        .trim_start_matches('.')
        .to_ascii_lowercase()
}

fn current_runtime_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::singbox::config_gen::{Rule, RuleGroup};

    fn sample_node(id: &str) -> Node {
        Node {
            id: id.to_string(),
            name: "Node".to_string(),
            address: "example.com".to_string(),
            port: 443,
            uuid: "123e4567-e89b-12d3-a456-426614174000".to_string(),
            flow: String::new(),
            security: "tls".to_string(),
            sni: "example.com".to_string(),
            fingerprint: String::new(),
            public_key: String::new(),
            short_id: String::new(),
            transport: "tcp".to_string(),
        }
    }

    fn sample_group(id: &str, name: &str) -> RuleGroup {
        RuleGroup {
            id: id.to_string(),
            name: name.to_string(),
            rules: vec![Rule {
                id: "rule-1".to_string(),
                rule_type: "domain_suffix".to_string(),
                match_value: "example.com".to_string(),
                outbound: "proxy".to_string(),
            }],
            default_strategy: "proxy".to_string(),
            fake_ip_filter: vec![],
            nameserver_policy: vec![],
        }
    }

    fn sample_config() -> AppConfig {
        AppConfig {
            nodes: vec![sample_node("node-1")],
            active_node_id: Some("node-1".to_string()),
            rule_groups: vec![sample_group("group-1", "Default")],
            active_group_id: "group-1".to_string(),
            host_overrides: vec![],
            autostart: false,
            language: "zh".to_string(),
        }
    }

    #[test]
    fn resolve_runtime_selection_returns_active_node_and_group() {
        let selection = resolve_runtime_selection(&sample_config()).unwrap();

        assert_eq!(selection.node.id, "node-1");
        assert_eq!(selection.rule_group.id, "group-1");
    }

    #[test]
    fn build_proxy_status_returns_group_name_from_config() {
        let status = build_proxy_status(
            &sample_config(),
            true,
            42,
            Some("node-1".to_string()),
            Some("group-1".to_string()),
        );

        assert_eq!(
            status,
            ProxyStatus {
                connected: true,
                active_node_id: Some("node-1".to_string()),
                active_group_id: Some("group-1".to_string()),
                active_group_name: Some("Default".to_string()),
                uptime_seconds: 42,
            }
        );
    }

    #[test]
    fn build_proxy_status_resets_snapshot_when_disconnected() {
        let status = build_proxy_status(
            &sample_config(),
            false,
            99,
            Some("node-1".to_string()),
            Some("group-1".to_string()),
        );

        assert_eq!(
            status,
            ProxyStatus {
                connected: false,
                active_node_id: None,
                active_group_id: None,
                active_group_name: None,
                uptime_seconds: 0,
            }
        );
    }

    #[test]
    fn parse_egress_ip_accepts_a_plain_text_ip_response() {
        assert_eq!(parse_egress_ip("154.26.187.44\n").unwrap(), "154.26.187.44");
        assert_eq!(parse_egress_ip("2001:db8::1").unwrap(), "2001:db8::1");
    }

    #[test]
    fn parse_egress_ip_rejects_an_html_page() {
        assert!(parse_egress_ip("<html><body>154.26.187.44</body></html>").is_err());
    }

    #[test]
    fn content_checks_report_one_consistent_observed_egress() {
        let checks = content_checks_for_egress("154.26.187.44".to_string());

        assert_eq!(checks.len(), 3);
        assert_eq!(checks[0].id, "egress_ip");
        assert_eq!(checks[0].observed_ip.as_deref(), Some("154.26.187.44"));
        assert_eq!(checks[1].id, "cloudflare_trace");
        assert_eq!(checks[1].observed_ip.as_deref(), Some("154.26.187.44"));
        assert_eq!(checks[2].id, "google_content");
        assert_eq!(checks[2].observed_ip, None);
    }

    #[test]
    fn ai_preflight_reports_the_effective_route_for_each_service() {
        let mut config = sample_config();
        config.rule_groups[0].default_strategy = "direct".to_string();
        config.rule_groups[0].rules.push(Rule {
            id: "claude-proxy".to_string(),
            rule_type: "domain_suffix".to_string(),
            match_value: "anthropic.com".to_string(),
            outbound: "proxy".to_string(),
        });

        let report = build_ai_service_preflight(
            &config,
            "154.26.187.44".to_string(),
            content_checks_for_egress("154.26.187.44".to_string()),
        )
        .unwrap();
        assert_eq!(report.egress_ip, "154.26.187.44");
        assert!(!report.ready);
        assert_eq!(report.routes[0].outbound, "proxy");
        assert_eq!(report.routes[1].outbound, "direct");

        config.rule_groups[0].default_strategy = "proxy".to_string();
        config.rule_groups[0].rules.push(Rule {
            id: "chatgpt-direct".to_string(),
            rule_type: "domain".to_string(),
            match_value: "chatgpt.com".to_string(),
            outbound: "direct".to_string(),
        });
        let report = build_ai_service_preflight(
            &config,
            "154.26.187.44".to_string(),
            content_checks_for_egress("154.26.187.44".to_string()),
        )
        .unwrap();
        assert!(!report.ready);
        assert_eq!(report.routes[3].outbound, "direct");
        assert_eq!(report.routes[3].matched_by, "domain: chatgpt.com");
    }

    #[test]
    fn discover_runtime_host_override_adds_system_dns_for_matching_npm_registry() {
        std::env::set_var("NPM_CONFIG_REGISTRY", "https://bnpm.byted.org/");
        let group = RuleGroup {
            id: "group-1".to_string(),
            name: "Default".to_string(),
            rules: vec![],
            default_strategy: "proxy".to_string(),
            fake_ip_filter: vec![],
            nameserver_policy: vec![NameServerPolicy {
                domain_suffix: "+.byted.org".to_string(),
                server: "100.82.0.1".to_string(),
                servers: vec![],
            }],
        };

        let item = discover_runtime_host_override(&group, &std::collections::HashSet::new())
            .expect("runtime fallback override");

        assert_eq!(item.id, "runtime-fallback-bnpm.byted.org");
        assert_eq!(item.host, "bnpm.byted.org");
        assert_eq!(item.resolver_mode, "system-dns");
        assert_eq!(item.outbound_mode, "inherit");
        assert!(item.enabled);
        assert_eq!(item.source, "runtime_fallback");
        assert_eq!(
            item.reason,
            "Current npm registry matched nameserver policy"
        );
        assert!(!item.updated_at.is_empty());

        std::env::remove_var("NPM_CONFIG_REGISTRY");
    }

    #[test]
    fn resolve_runtime_host_overrides_prefers_persisted_host_override() {
        std::env::set_var("NPM_CONFIG_REGISTRY", "https://bnpm.byted.org/");
        let mut config = sample_config();
        config.host_overrides.push(HostOverride {
            id: "manual-1".to_string(),
            host: "bnpm.byted.org".to_string(),
            resolver_mode: "remote-dns".to_string(),
            outbound_mode: "direct".to_string(),
            enabled: true,
            source: "manual".to_string(),
            reason: "manual override".to_string(),
            updated_at: "1".to_string(),
        });
        config.rule_groups[0].nameserver_policy = vec![NameServerPolicy {
            domain_suffix: "+.byted.org".to_string(),
            server: "100.82.0.1".to_string(),
            servers: vec![],
        }];

        let overrides = resolve_runtime_host_overrides(&config, &config.rule_groups[0]);

        assert_eq!(overrides.len(), 1);
        assert_eq!(overrides[0].id, "manual-1");
        assert_eq!(overrides[0].resolver_mode, "remote-dns");
        assert_eq!(overrides[0].outbound_mode, "direct");

        std::env::remove_var("NPM_CONFIG_REGISTRY");
    }
}
