use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;
use url::Url;

use crate::mihomo::config_gen::{try_generate_app_config, NameServerPolicy, RuleGroup};
use crate::mihomo::uri_parser::Node;
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
    pub phase: String,
    pub routing_revision: u64,
    pub active_node_name: Option<String>,
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
    /// Present only for a unique generation directory created by this app.
    /// Lifecycle transfers this explicit ownership to the process that uses it;
    /// preview and persisted/user paths are never inferred from `config_path`.
    pub owned_runtime_dir: Option<PathBuf>,
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
    let node = if config.proxy_chain.enabled {
        let (_, exit) = crate::chain::pair(config, &config.proxy_chain)?;
        Node {
            id: "__chain__".into(),
            name: format!("Chain → {}", exit["name"].as_str().unwrap_or("exit")),
            ..Default::default()
        }
    } else if let Some(selected) = config.strategy_selections.get("Pingu Proxy") {
        config
            .nodes
            .iter()
            .find(|n| format!("{} [{}]", n.name, n.id) == *selected)
            .cloned()
            .unwrap_or_else(|| Node {
                id: "__subscriptions__".into(),
                name: selected.clone(),
                ..Default::default()
            })
    } else {
        config
            .active_node_id
            .as_ref()
            .and_then(|id| config.nodes.iter().find(|n| &n.id == id))
            .cloned()
            .or_else(|| {
                config
                    .subscriptions
                    .iter()
                    .any(|s| s.enabled)
                    .then(|| Node {
                        id: "__subscriptions__".into(),
                        name: "Subscriptions".into(),
                        ..Default::default()
                    })
            })
            .ok_or("Select a manual node or enable a subscription")?
    };
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
    prepare_runtime_generation_in_dir_with_port(
        config,
        generation,
        listen_port,
        app_config_dir()?.join("mihomo"),
    )
}

fn prepare_runtime_generation_in_dir_with_port(
    config: &AppConfig,
    generation: Option<u64>,
    listen_port: u16,
    mihomo_dir: PathBuf,
) -> Result<PreparedRuntime, String> {
    let selection = resolve_runtime_selection(config)?;
    let clash_api_port = find_available_port(9090)?;

    let config_dir = mihomo_dir.join(match generation {
        Some(generation) => format!("runtime-{generation}-{}", uuid::Uuid::new_v4()),
        None => "preview".to_string(),
    });
    let owned_runtime_dir = generation.map(|_| config_dir.clone());
    let result = (|| {
        std::fs::create_dir_all(&config_dir)
            .map_err(|_| "Cannot create Mihomo runtime directory")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&config_dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "Cannot protect runtime directory")?;
        }
        let cache_path = config_dir.join("cache.db");
        let config_path = config_dir.join("config.json");
        let host_overrides = resolve_runtime_host_overrides(config, &selection.rule_group);
        let sb_config = try_generate_app_config(
            config,
            &selection.rule_group,
            &host_overrides,
            clash_api_port,
            listen_port,
        )
        .map_err(|e| format!("Cannot start proxy: {e}"))?;
        let config_str = serde_json::to_string_pretty(&sb_config).map_err(|e| e.to_string())?;
        crate::mihomo::private_write(&config_path, config_str.as_bytes())?;

        Ok(PreparedRuntime {
            config_dir,
            owned_runtime_dir: owned_runtime_dir.clone(),
            config_path,
            cache_path,
            node: selection.node,
            rule_group: selection.rule_group,
            clash_api_port,
            listen_port,
        })
    })();

    // Only a UUID generation directory is app-owned and safe to remove here.
    // Preview/persisted/user paths deliberately have no ownership token.
    if result.is_err() {
        if let Some(path) = &owned_runtime_dir {
            let _ = std::fs::remove_dir_all(path);
        }
    }
    result
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
            phase: "disconnected".into(),
            routing_revision: 0,
            active_node_name: None,
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
        phase: "connected".into(),
        routing_revision: 0,
        active_node_name: resolve_runtime_selection(config).ok().map(|s| s.node.name),
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
/// local mihomo listener. This intentionally does not depend on macOS
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
    verify_proxy_content_with_timeout(listen_port, Duration::from_secs(8))
}

/// Mihomo opens its listener before asynchronous provider initialization is
/// complete. Keep the candidate isolated until real content checks succeed.
pub fn verify_startup_proxy_content(listen_port: u16) -> Result<Vec<NetworkContentCheck>, String> {
    retry_startup_check(
        Duration::from_secs(30),
        Duration::from_millis(500),
        |remaining| {
            verify_proxy_content_with_timeout(listen_port, remaining.min(Duration::from_secs(8)))
        },
    )
}

fn retry_startup_check<T>(
    timeout: Duration,
    interval: Duration,
    mut check: impl FnMut(Duration) -> Result<T, String>,
) -> Result<T, String> {
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Proxy startup verification timed out".into());
        }
        match check(remaining) {
            Ok(value) => return Ok(value),
            Err(error) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining <= interval {
                    return Err(error);
                }
                std::thread::sleep(interval);
            }
        }
    }
}

fn verify_proxy_content_with_timeout(
    listen_port: u16,
    timeout: Duration,
) -> Result<Vec<NetworkContentCheck>, String> {
    let agent = proxy_probe_agent_with_timeout(listen_port, timeout)?;

    // The three probes target independent endpoints and each carries its own
    // 8s deadline, so they run concurrently. Every task is joined before
    // validation, which stays sequential to preserve error precedence.
    let (egress, cloudflare, google) = run_parallel_checks(
        || fetch_egress_ip(&agent),
        || fetch_cloudflare_trace_ip(&agent),
        || fetch_google_content_status(&agent),
    );

    finalize_content_checks(egress, cloudflare, google)
}

/// Run three independent checks on scoped threads and join every task. A
/// panicked check is reported as an `Err` instead of unwinding the caller.
fn run_parallel_checks<A, B, C, RA, RB, RC>(
    check_a: A,
    check_b: B,
    check_c: C,
) -> (Result<RA, String>, Result<RB, String>, Result<RC, String>)
where
    A: FnOnce() -> Result<RA, String> + Send,
    B: FnOnce() -> Result<RB, String> + Send,
    C: FnOnce() -> Result<RC, String> + Send,
    RA: Send,
    RB: Send,
    RC: Send,
{
    std::thread::scope(|scope| {
        let handle_a = scope.spawn(check_a);
        let handle_b = scope.spawn(check_b);
        let handle_c = scope.spawn(check_c);

        (
            handle_a
                .join()
                .unwrap_or_else(|panic| Err(check_panic_message(panic))),
            handle_b
                .join()
                .unwrap_or_else(|panic| Err(check_panic_message(panic))),
            handle_c
                .join()
                .unwrap_or_else(|panic| Err(check_panic_message(panic))),
        )
    })
}

fn check_panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    let message = if let Some(message) = payload.downcast_ref::<&'static str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "unknown panic".to_string()
    };
    format!("Proxy content check panicked: {message}")
}

fn fetch_egress_ip(agent: &ureq::Agent) -> Result<String, String> {
    let response = agent
        .get(EGRESS_PROBE_URL)
        .call()
        .map_err(|error| format!("Failed to verify proxy egress: {error}"))?
        .into_string()
        .map_err(|error| format!("Failed to read proxy egress: {error}"))?;
    parse_egress_ip(&response)
}

fn fetch_cloudflare_trace_ip(agent: &ureq::Agent) -> Result<String, String> {
    let trace = agent
        .get(CLOUDFLARE_TRACE_URL)
        .call()
        .map_err(|error| format!("Cloudflare trace request failed: {error}"))?
        .into_string()
        .map_err(|error| format!("Failed to read Cloudflare trace: {error}"))?;
    let trace_ip = trace
        .lines()
        .find_map(|line| line.strip_prefix("ip="))
        .map(str::trim)
        .ok_or("Cloudflare trace did not return an IP address")?;
    parse_egress_ip(trace_ip)
}

fn fetch_google_content_status(agent: &ureq::Agent) -> Result<u16, String> {
    agent
        .get(GOOGLE_CONTENT_PROBE_URL)
        .call()
        .map(|response| response.status())
        .map_err(|error| format!("Google content check failed: {error}"))
}

/// Validate the joined probe results. Kept free of network access so the
/// egress-equality and Google all-or-nothing rules are deterministically
/// testable.
fn finalize_content_checks(
    egress: Result<String, String>,
    cloudflare: Result<String, String>,
    google: Result<u16, String>,
) -> Result<Vec<NetworkContentCheck>, String> {
    let egress_ip = egress?;
    let cloudflare_ip = cloudflare?;
    // Different domain policies may legitimately use different exits.

    let google_status = google?;
    if google_status != 204 {
        return Err(format!(
            "Google content check returned HTTP {google_status} instead of 204"
        ));
    }

    let mut checks = content_checks_for_egress(egress_ip);
    checks[1].observed_ip = Some(cloudflare_ip);
    Ok(checks)
}

fn proxy_probe_agent(listen_port: u16) -> Result<ureq::Agent, String> {
    proxy_probe_agent_with_timeout(listen_port, Duration::from_secs(8))
}

fn proxy_probe_agent_with_timeout(
    listen_port: u16,
    timeout: Duration,
) -> Result<ureq::Agent, String> {
    let proxy = ureq::Proxy::new(&format!("http://127.0.0.1:{listen_port}"))
        .map_err(|error| format!("Failed to configure egress probe: {error}"))?;
    Ok(ureq::AgentBuilder::new()
        .proxy(proxy)
        .timeout(timeout)
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
    if config.subscriptions.iter().any(|s| s.enabled) {
        return Ok(AiServicePreflight {
            egress_ip,
            network_checks,
            routes: AI_SERVICE_TARGETS
                .iter()
                .map(|(service, host)| AiServiceRoute {
                    service: (*service).into(),
                    host: (*host).into(),
                    outbound: "runtime".into(),
                    matched_by: "Subscription routing; inspect live connections".into(),
                })
                .collect(),
            ready: false,
        });
    }
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
        if matches!(rule.rule_type.as_str(), "geosite" | "geoip" | "ip_cidr") {
            // Dataset membership and destination IPs are resolved by Mihomo.
            // Falling through to MATCH would falsely report GFW-routed AI
            // services as direct under the direct-by-default template.
            return (
                "runtime".into(),
                "Rule-set/IP routing; inspect live connections".into(),
            );
        }
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
    crate::mihomo::process::MihomoProcess::new()
        .check(config_path.to_str().ok_or("Invalid config path")?)
        .map_err(|error| error.finish_owned_cleanup(None))
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
mod tests;
