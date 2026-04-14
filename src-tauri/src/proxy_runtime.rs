use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use url::Url;

use crate::singbox::config_gen::{
    generate_config_with_host_overrides, NameServerPolicy, RuleGroup,
};
use crate::singbox::uri_parser::Node;
use crate::storage::app_config::{AppConfig, HostOverride};

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
    let selection = resolve_runtime_selection(config)?;
    let clash_api_port = find_available_port(9090)?;

    let config_dir = app_config_dir()?;
    let cache_path = config_dir.join("cache.db");
    let config_path = config_dir.join("sing-box-config.json");
    let host_overrides = resolve_runtime_host_overrides(config, &selection.rule_group);
    let sb_config = generate_config_with_host_overrides(
        &selection.node,
        &selection.rule_group,
        cache_path.to_str().ok_or("Invalid cache path")?,
        &host_overrides,
        clash_api_port,
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

pub fn proxy_info() -> ProxyInfo {
    ProxyInfo {
        listen_host: "127.0.0.1".to_string(),
        listen_port: 2080,
        http_proxy: "http://127.0.0.1:2080".to_string(),
        socks_proxy: "socks5://127.0.0.1:2080".to_string(),
        terminal_commands: vec![
            "export http_proxy=http://127.0.0.1:2080".to_string(),
            "export https_proxy=http://127.0.0.1:2080".to_string(),
            "export all_proxy=socks5://127.0.0.1:2080".to_string(),
        ],
        unset_commands: vec!["unset http_proxy https_proxy all_proxy".to_string()],
    }
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
