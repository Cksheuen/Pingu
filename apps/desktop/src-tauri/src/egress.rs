//! VPS exit selection is local to this client. Management uses the user's
//! existing SSH trust/identity instead of exposing a privileged HTTP API.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::storage::app_config::AppConfig;

pub static MANAGEMENT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EgressSettings {
    pub management: Option<Management>,
    pub selected: Option<SelectedEgress>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Management {
    pub target: String,
    #[serde(default)]
    pub ssh_config: String,
    pub proxy_server: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SelectedEgress {
    #[serde(default = "legacy_id")]
    pub id: String,
    pub proxy_name: String,
    pub server: String,
    pub uuid: String,
}

fn legacy_id() -> String {
    "legacy".into()
}

impl std::fmt::Debug for SelectedEgress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SelectedEgress")
            .field("proxy_name", &self.proxy_name)
            .field("server", &self.server)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudflareExit {
    pub id: String,
    pub name: String,
    pub phase: String,
    pub ready: bool,
    pub ip: Option<String>,
    pub location: Option<String>,
    pub checked_at: Option<String>,
    pub created_at: Option<String>,
    pub error: Option<String>,
    // Never send the routing credential to the webview.
    #[serde(skip_serializing)]
    pub uuid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MagpieState {
    pub available: bool,
    #[serde(default)]
    pub providers: Vec<MagpieProvider>,
    #[serde(default)]
    pub references: std::collections::HashMap<String, usize>,
    pub web_url: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MagpieProvider {
    pub id: String,
    pub name: String,
    pub revision: String,
    pub targets: Vec<MagpieTarget>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MagpieTarget {
    pub r#ref: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub selection: String,
    pub effective_exit: Option<String>,
    pub effective_direct: bool,
}

#[derive(Debug, Deserialize)]
pub struct RemoteReply {
    ok: bool,
    #[serde(default)]
    version: u32,
    #[serde(default)]
    pub installed: bool,
    #[serde(default)]
    pub exits: Vec<CloudflareExit>,
    #[serde(default)]
    pub magpie: MagpieState,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct EgressState {
    pub management: Option<Management>,
    pub selected: String,
    pub selected_proxy: Option<String>,
    pub eligible_proxy: Option<String>,
    pub installed: bool,
    pub exits: Vec<CloudflareExit>,
    pub magpie: MagpieState,
    pub error: Option<String>,
}

impl Management {
    pub fn validate(&self) -> Result<(), String> {
        if self.target.is_empty()
            || self.target.len() > 200
            || self.target.starts_with('-')
            || !self
                .target
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-._@:[]".contains(c))
        {
            return Err("Use an SSH host alias or user@host without command arguments.".into());
        }
        if !self.ssh_config.is_empty()
            && (!std::path::Path::new(&self.ssh_config).is_absolute()
                || self.ssh_config.chars().any(char::is_control)
                || !std::path::Path::new(&self.ssh_config).is_file())
        {
            return Err("The SSH configuration must be an existing absolute file path.".into());
        }
        if self.proxy_server.is_empty()
            || self.proxy_server.len() > 253
            || !self
                .proxy_server
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-.:[]".contains(c))
        {
            return Err(
                "Enter the exact server hostname or IP used by your VPS proxy node.".into(),
            );
        }
        Ok(())
    }
}

fn ssh_arguments(management: &Management) -> Vec<String> {
    let mut args = vec![
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=6",
        "-o",
        "ServerAliveInterval=10",
        "-o",
        "ServerAliveCountMax=3",
    ]
    .into_iter()
    .map(String::from)
    .collect::<Vec<_>>();
    if !management.ssh_config.is_empty() {
        args.extend(["-F".into(), management.ssh_config.clone()]);
    }
    args.extend([
        "--".into(),
        management.target.clone(),
        "/usr/local/sbin/pingu-egress --json".into(),
    ]);
    args
}

pub fn request(management: &Management, payload: Value) -> Result<RemoteReply, String> {
    management.validate()?;
    let action = payload.get("action").and_then(Value::as_str).unwrap_or("");
    if !matches!(
        action,
        "status" | "create" | "delete" | "rename" | "magpie_bind"
    ) {
        return Err("Unsupported egress operation.".into());
    }
    let input = serde_json::to_vec(&payload).map_err(|_| "Cannot encode egress request")?;
    if input.len() > 8192 {
        return Err("Egress request is too large".into());
    }
    let mut child = Command::new("/usr/bin/ssh")
        .args(ssh_arguments(management))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Cannot start SSH")?;
    let write = child
        .stdin
        .take()
        .ok_or("SSH input unavailable")?
        .write_all(&input);
    if write.is_err() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("Cannot send the egress request over SSH.".into());
    }
    let stdout = child.stdout.take().ok_or("SSH output unavailable")?;
    let stderr = child.stderr.take().ok_or("SSH diagnostics unavailable")?;
    let output = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.take(524_289).read_to_end(&mut bytes);
        bytes
    });
    let diagnostics = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.take(8193).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(if action == "create" { 240 } else { 180 });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let bytes = output.join().unwrap_or_default();
    let _ = diagnostics.join();
    if status.is_none() {
        return Err("The VPS operation timed out. Refresh its status before retrying; it may still be running.".into());
    }
    parse_reply(&bytes, status.is_some_and(|status| status.success()))
}

fn parse_reply(bytes: &[u8], success: bool) -> Result<RemoteReply, String> {
    if bytes.len() > 524_288 {
        return Err("The VPS returned an oversized response.".into());
    }
    let reply: RemoteReply = serde_json::from_slice(bytes).map_err(|_| {
        "Cannot read the VPS manager. Check SSH access and install pingu-egress on the server."
    })?;
    if !success || !reply.ok {
        return Err(reply
            .error
            .filter(|s| s.len() < 500 && !s.chars().any(char::is_control))
            .unwrap_or_else(|| "The VPS egress operation failed.".into()));
    }
    if reply.version != 2 {
        return Err("Update pingu-egress on the VPS to the shared exit pool version first.".into());
    }
    let mut ids = std::collections::HashSet::new();
    for exit in &reply.exits {
        if exit.id != "legacy" && uuid::Uuid::parse_str(&exit.id).is_err()
            || !ids.insert(exit.id.clone())
        {
            return Err("The VPS returned an invalid or duplicate exit ID".into());
        }
        uuid::Uuid::parse_str(&exit.uuid)
            .map_err(|_| "The VPS returned an invalid egress credential")?;
        if !matches!(exit.phase.as_str(), "creating" | "ready" | "deleting") {
            return Err("The VPS returned an unknown egress state.".into());
        }
    }
    Ok(reply)
}

/// Find the explicitly selected, single VLESS proxy. Automatic pools and chains
/// must not silently send some connections through an unselected egress.
pub fn selected_proxy(config: &AppConfig) -> Result<(String, String), String> {
    if config.proxy_chain.enabled {
        return Err("Disable the proxy chain before selecting a VPS exit.".into());
    }
    let mut plain = config.clone();
    plain.vps_egress.selected = None;
    let group = plain.active_rule_group()?;
    let generated = crate::mihomo::config_gen::try_generate_app_config(
        &plain,
        group,
        &plain.host_overrides,
        0,
        0,
    )?;
    let (name, proxy) = selected_value(&generated)?;
    Ok((
        name.to_string(),
        proxy["server"]
            .as_str()
            .ok_or("Selected proxy has no server")?
            .to_string(),
    ))
}

fn selected_value(value: &Value) -> Result<(&str, &Value), String> {
    let group = value["proxy-groups"]
        .as_array()
        .and_then(|groups| groups.iter().find(|g| g["name"] == "Pingu Proxy"))
        .ok_or("Primary proxy selector is unavailable")?;
    let name = group["default-selected"]
        .as_str()
        .ok_or("Select your VPS node before choosing its exit.")?;
    let proxy = value["proxies"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|p| p["name"] == name && p["type"] == "vless")
        })
        .ok_or("Select a single VLESS VPS node; automatic groups cannot choose a VPS exit.")?;
    Ok((name, proxy))
}

pub fn apply(config: &AppConfig, value: &mut Value) -> Result<(), String> {
    let Some(exit) = &config.vps_egress.selected else {
        return Ok(());
    };
    if config.proxy_chain.enabled {
        return Err("Switch back to the VPS direct exit before enabling a proxy chain.".into());
    }
    uuid::Uuid::parse_str(&exit.uuid).map_err(|_| "Invalid saved Cloudflare egress credential")?;
    let (name, proxy) = selected_value(value)?;
    if name != exit.proxy_name || proxy["server"].as_str() != Some(exit.server.as_str()) {
        return Err("Switch back to the VPS direct exit before changing the proxy node.".into());
    }
    let proxy = value["proxies"]
        .as_array_mut()
        .and_then(|items| items.iter_mut().find(|p| p["name"] == exit.proxy_name))
        .ok_or("Selected VPS node is missing")?;
    proxy["uuid"] = json!(exit.uuid);
    value["pingu-vps-egress"] = json!("cloudflare");
    // Only our UUID changes. TLS, WS device authentication, DNS, rules and the
    // fixed local listener are preserved. The server rejects UDP for this exit.
    Ok(())
}

pub fn verify_runtime(value: &Value, listen_port: u16) -> Result<(), String> {
    if value["pingu-vps-egress"] != "cloudflare" {
        return Ok(());
    }
    let proxy = ureq::Proxy::new(&format!("http://127.0.0.1:{listen_port}"))
        .map_err(|_| "Invalid local proxy")?;
    let agent = ureq::AgentBuilder::new()
        .try_proxy_from_env(false)
        .redirects(0)
        .proxy(proxy)
        .timeout(Duration::from_secs(8))
        .build();
    let response = agent
        .get("https://www.cloudflare.com/cdn-cgi/trace")
        .call()
        .map_err(|_| "Cloudflare exit verification failed; previous routing will be retained.")?;
    let mut body = String::new();
    response
        .into_reader()
        .take(16_385)
        .read_to_string(&mut body)
        .map_err(|_| "Cannot read the Cloudflare exit check")?;
    verify_trace(&body)
}

fn verify_trace(body: &str) -> Result<(), String> {
    if body.len() > 16_384 {
        return Err("Cloudflare exit check exceeded its response limit.".into());
    }
    let fields: std::collections::HashMap<_, _> = body
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect();
    if fields.get("warp") != Some(&"on")
        || fields
            .get("ip")
            .and_then(|ip| ip.parse::<std::net::IpAddr>().ok())
            .is_none()
    {
        return Err("The route did not exit through Cloudflare WARP. Check VPS routing and ensure www.cloudflare.com is not configured as direct.".into());
    }
    Ok(())
}

pub fn state(config: &AppConfig, refresh: bool) -> EgressState {
    let management = config.vps_egress.management.clone();
    let eligible_proxy = selected_proxy(config).ok().and_then(|(name, server)| {
        management
            .as_ref()
            .filter(|m| m.proxy_server == server)
            .map(|_| name)
    });
    let mut result = EgressState {
        management: management.clone(),
        selected: config
            .vps_egress
            .selected
            .as_ref()
            .map(|e| e.id.clone())
            .unwrap_or_else(|| "direct".into()),
        selected_proxy: config
            .vps_egress
            .selected
            .as_ref()
            .map(|x| x.proxy_name.clone()),
        eligible_proxy,
        installed: false,
        exits: Vec::new(),
        magpie: MagpieState::default(),
        error: None,
    };
    if refresh {
        if let Some(management) = &management {
            match request(management, json!({"action":"status"})) {
                Ok(remote) => {
                    result.installed = remote.installed;
                    result.exits = remote.exits;
                    result.magpie = remote.magpie;
                }
                Err(error) => result.error = Some(error),
            }
        }
    }
    result
}

#[cfg(test)]
mod tests;
