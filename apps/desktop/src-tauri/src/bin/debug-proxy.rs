use std::net::{SocketAddr, TcpStream};
use std::process::Command;
use std::time::{Duration, Instant};

use pingu_lib::proxy_runtime::{
    check_generated_config, find_available_port, prepare_runtime,
    prepare_runtime_generation_with_port, verify_proxy_content,
};
use pingu_lib::singbox::process::SingBoxProcess;
use pingu_lib::storage::app_config::AppConfig;

fn print_usage() {
    eprintln!("用法:");
    eprintln!("  cargo run --manifest-path src-tauri/Cargo.toml --bin debug-proxy -- status");
    eprintln!("  cargo run --manifest-path src-tauri/Cargo.toml --bin debug-proxy -- prepare");
    eprintln!("  cargo run --manifest-path src-tauri/Cargo.toml --bin debug-proxy -- start");
    eprintln!("  cargo run --manifest-path src-tauri/Cargo.toml --bin debug-proxy -- verify");
    eprintln!("  cargo run --manifest-path src-tauri/Cargo.toml --bin debug-proxy -- reputation");
}

/// Validate a generated runtime through an explicit local listener. This never
/// invokes macOS system-proxy commands, so it is safe to use while another
/// application depends on the normal system proxy path.
fn verify_without_system_proxy(config: &AppConfig) -> Result<(), String> {
    with_explicit_proxy(config, |listen_port| {
        print_content_checks(listen_port)?;
        Ok(())
    })
}

/// Request the three reputation pages exactly once through the temporary local
/// proxy. It only reports ordinary HTTP responses; a Cloudflare challenge is
/// reported as blocked rather than being solved or bypassed.
fn reputation_without_system_proxy(config: &AppConfig) -> Result<(), String> {
    with_explicit_proxy(config, |listen_port| {
        let egress_ip = print_content_checks(listen_port)?;
        let proxy = ureq::Proxy::new(&format!("http://127.0.0.1:{listen_port}"))
            .map_err(|error| format!("Failed to configure reputation probe: {error}"))?;
        let agent = ureq::AgentBuilder::new()
            .proxy(proxy)
            .timeout(Duration::from_secs(12))
            .build();
        for (name, url) in [
            (
                "Scamalytics",
                format!("https://scamalytics.com/ip/{egress_ip}"),
            ),
            ("ping0.cc", "https://ping0.cc".to_string()),
            (
                "IPQualityScore",
                format!(
                    "https://www.ipqualityscore.com/free-ip-lookup-proxy-vpn-test/lookup/{egress_ip}"
                ),
            ),
        ] {
            print_reputation_response(name, &url, &agent);
        }
        Ok(())
    })
}

fn with_explicit_proxy<T>(
    config: &AppConfig,
    operation: impl FnOnce(u16) -> Result<T, String>,
) -> Result<T, String> {
    pingu_lib::gate::renew_if_enabled()
        .map_err(|error| format!("Automatic network access failed: {error}"))?;

    let listen_port = find_available_port(2100)?;
    let generation = chrono::Utc::now().timestamp_millis().unsigned_abs();
    let prepared = prepare_runtime_generation_with_port(config, Some(generation), listen_port)?;
    check_generated_config(&prepared.config_path)?;

    let process = SingBoxProcess::new();
    process.start(prepared.config_path.to_str().ok_or("Invalid config path")?)?;
    let result = (|| {
        wait_for_listener(&process, listen_port)?;
        operation(listen_port)
    })();

    let stop_result = process.stop();
    let _ = std::fs::remove_file(&prepared.config_path);
    let value = result?;
    stop_result?;
    Ok(value)
}

fn print_content_checks(listen_port: u16) -> Result<String, String> {
    let checks = verify_proxy_content(listen_port)?;
    let egress_ip = checks
        .iter()
        .find(|check| check.id == "egress_ip")
        .and_then(|check| check.observed_ip.clone())
        .ok_or("Network verification did not return an egress IP")?;
    for check in checks {
        let observed = check.observed_ip.as_deref().unwrap_or("passed");
        println!("{}: {}", check.id, observed);
    }
    Ok(egress_ip)
}

fn print_reputation_response(name: &str, url: &str, agent: &ureq::Agent) {
    let result = match agent.get(url).call() {
        Ok(response) => response_to_summary(name, response.status(), response.into_string().ok()),
        Err(ureq::Error::Status(status, response)) => {
            response_to_summary(name, status, response.into_string().ok())
        }
        Err(error) => format!("request error: {error}"),
    };
    println!("{name}: {result}");
}

fn response_to_summary(name: &str, status: u16, body: Option<String>) -> String {
    let title = body
        .as_deref()
        .and_then(extract_html_title)
        .map(|title| format!("; page title: {title}"))
        .unwrap_or_default();
    let cloudflare_challenge = body
        .as_deref()
        .map(|body| body.contains("cf-mitigated") || body.contains("Just a moment"))
        .unwrap_or(false);
    if cloudflare_challenge {
        format!("HTTP {status}; Cloudflare challenge (not bypassed){title}")
    } else {
        let metric = body
            .as_deref()
            .and_then(|body| extract_metric_context(name, body))
            .map(|context| format!("; metric context: {context}"))
            .unwrap_or_default();
        format!("HTTP {status}{title}{metric}")
    }
}

fn extract_html_title(body: &str) -> Option<&str> {
    let start = body.find("<title>")? + "<title>".len();
    let end = body[start..].find("</title>")? + start;
    Some(body[start..end].trim())
}

fn extract_metric_context(name: &str, body: &str) -> Option<String> {
    let anchor = match name {
        "Scamalytics" => body.find("Fraud Score").map(|_| "Fraud Score")?,
        "IPQualityScore" => {
            if body.contains("Risk Score") {
                "Risk Score"
            } else {
                "<form"
            }
        }
        "ping0.cc" => return Some("no risk label in this HTTP response".to_string()),
        _ => return None,
    };
    let start = body.find(anchor)?;
    let raw = &body[start..body.len().min(start + 300)];
    Some(
        raw.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(300)
            .collect(),
    )
}

fn wait_for_listener(process: &SingBoxProcess, listen_port: u16) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], listen_port));
    let started_at = Instant::now();
    let poll_interval = Duration::from_millis(100);
    let timeout = Duration::from_secs(5);

    loop {
        if TcpStream::connect_timeout(&address, poll_interval).is_ok() {
            return Ok(());
        }
        if !process.is_running() {
            return Err("sing-box exited during diagnostic startup".to_string());
        }
        if started_at.elapsed() >= timeout {
            return Err(format!(
                "Timed out waiting for diagnostic listener on 127.0.0.1:{listen_port}"
            ));
        }
        std::thread::sleep(poll_interval);
    }
}

fn print_status(config: &AppConfig) {
    println!("nodes: {}", config.nodes.len());
    println!(
        "active_node_id: {}",
        config.active_node_id.as_deref().unwrap_or("<none>")
    );
    println!("rule_groups: {}", config.rule_groups.len());
    println!("active_group_id: {}", config.active_group_id);

    if let Some(active_id) = &config.active_node_id {
        if let Some(node) = config.nodes.iter().find(|node| &node.id == active_id) {
            println!("active_node_name: {}", node.name);
            println!("active_node_server: {}:{}", node.address, node.port);
        }
    }

    if let Some(group) = config
        .rule_groups
        .iter()
        .find(|group| group.id == config.active_group_id)
    {
        println!("active_group_name: {}", group.name);
        println!("active_group_default_strategy: {}", group.default_strategy);
        println!("active_group_rules: {}", group.rules.len());
    }
}

fn main() -> Result<(), String> {
    let action = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "status".to_string());
    let config = AppConfig::load();

    match action.as_str() {
        "status" => {
            print_status(&config);
            Ok(())
        }
        "prepare" => {
            print_status(&config);
            let prepared = prepare_runtime(&config)?;
            check_generated_config(&prepared.config_path)?;
            println!("config_dir: {}", prepared.config_dir.display());
            println!("cache_path: {}", prepared.cache_path.display());
            println!("config_path: {}", prepared.config_path.display());
            println!("prepared_node: {}", prepared.node.name);
            println!("prepared_group: {}", prepared.rule_group.name);
            println!("sing-box config check: ok");
            Ok(())
        }
        "start" => {
            print_status(&config);
            let prepared = prepare_runtime(&config)?;
            check_generated_config(&prepared.config_path)?;
            println!("starting sing-box with: {}", prepared.config_path.display());
            println!("listen: http://127.0.0.1:2080");
            let status = Command::new("sing-box")
                .args([
                    "run",
                    "-c",
                    prepared.config_path.to_str().ok_or("Invalid config path")?,
                ])
                .status()
                .map_err(|e| format!("Failed to start sing-box: {}", e))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("sing-box exited with status: {}", status))
            }
        }
        "verify" => {
            print_status(&config);
            verify_without_system_proxy(&config)?;
            println!("system proxy: unchanged");
            Ok(())
        }
        "reputation" => {
            print_status(&config);
            reputation_without_system_proxy(&config)?;
            println!("system proxy: unchanged");
            Ok(())
        }
        _ => {
            print_usage();
            Err(format!("Unknown action: {}", action))
        }
    }
}
