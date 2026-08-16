use serde::{Deserialize, Serialize};
use std::io;
use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use url::Url;

use crate::storage::gate_config::GateConfig;

static GATE_OPERATION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GateLease {
    pub ok: bool,
    pub ip: String,
    pub ttl_seconds: u64,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GateSettings {
    pub enabled: bool,
    pub configured: bool,
    pub endpoint: String,
    pub last_ip: Option<String>,
    pub lease_expires_at: Option<String>,
    pub last_error: Option<String>,
}

impl From<&GateConfig> for GateSettings {
    fn from(config: &GateConfig) -> Self {
        Self {
            enabled: config.enabled,
            configured: config.configured(),
            endpoint: config.endpoint.clone(),
            last_ip: config.last_ip.clone(),
            lease_expires_at: config.lease_expires_at.clone(),
            last_error: config.last_error.clone(),
        }
    }
}

pub fn get_settings() -> Result<GateSettings, String> {
    let config = GateConfig::load()?;
    Ok(GateSettings::from(&config))
}

pub fn configure(access_link: &str) -> Result<GateSettings, String> {
    let _guard = operation_lock()?;
    let (endpoint, token) = parse_access_link(access_link)?;
    let mut config = GateConfig::load()?;
    config.enabled = true;
    config.endpoint = endpoint;
    config.token = token;
    config.last_error = None;
    config.save()?;

    match request_lease(&config) {
        Ok(lease) => {
            record_lease(&mut config, &lease);
            config.save()?;
            Ok(GateSettings::from(&config))
        }
        Err(error) => {
            config.last_error = Some(error.clone());
            config.save()?;
            Err(error)
        }
    }
}

pub fn set_enabled(enabled: bool) -> Result<GateSettings, String> {
    let _guard = operation_lock()?;
    let mut config = GateConfig::load()?;
    if enabled && !config.configured() {
        return Err("Paste a Gate access link before enabling automatic access".to_string());
    }
    config.enabled = enabled;
    config.last_error = None;
    config.save()?;
    Ok(GateSettings::from(&config))
}

pub fn renew() -> Result<GateLease, String> {
    let _guard = operation_lock()?;
    let mut config = GateConfig::load()?;
    if !config.enabled {
        return Err("Automatic Gate access is disabled".to_string());
    }
    if !config.configured() {
        return Err("Gate access link is not configured".to_string());
    }

    match request_lease(&config) {
        Ok(lease) => {
            record_lease(&mut config, &lease);
            config.save()?;
            Ok(lease)
        }
        Err(error) => {
            config.last_error = Some(error.clone());
            config.save()?;
            Err(error)
        }
    }
}

pub fn renew_if_enabled() -> Result<Option<GateLease>, String> {
    let config = GateConfig::load()?;
    if !config.enabled {
        return Ok(None);
    }
    renew().map(Some)
}

fn operation_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    GATE_OPERATION_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|error| format!("Gate operation lock failed: {}", error))
}

fn parse_access_link(access_link: &str) -> Result<(String, String), String> {
    let mut url = Url::parse(access_link.trim())
        .map_err(|_| "Gate access link is not a valid URL".to_string())?;
    if url.scheme() != "https" {
        return Err("Gate access link must use HTTPS".to_string());
    }

    let token = url
        .query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.into_owned())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Gate access link is missing its token".to_string())?;

    let trimmed_path = url.path().trim_end_matches('/');
    let base_path = for_suffix(trimmed_path, &["/allow", "/subscription", "/sub", "/lease"])
        .unwrap_or(trimmed_path);
    let lease_path = format!("{}/lease", base_path.trim_end_matches('/'));
    url.set_path(&lease_path);
    url.set_query(None);
    url.set_fragment(None);

    Ok((url.to_string(), token))
}

fn for_suffix<'a>(value: &'a str, suffixes: &[&str]) -> Option<&'a str> {
    suffixes
        .iter()
        .find_map(|suffix| value.strip_suffix(suffix))
}

fn request_lease(config: &GateConfig) -> Result<GateLease, String> {
    let agent = ureq::AgentBuilder::new()
        // The active Reality node uses the VPS IPv4 address. Request the Gate
        // lease over IPv4 as well, otherwise a dual-stack client may only add
        // its IPv6 address to `reality_allow6` while its IPv4 Reality traffic
        // is still dropped by `reality_allow4`.
        .resolver(resolve_ipv4)
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(8))
        .timeout_write(Duration::from_secs(8))
        .build();
    let authorization = format!("Bearer {}", config.token);
    let response = agent
        .post(&config.endpoint)
        .set("Authorization", &authorization)
        .set("Accept", "application/json")
        .call()
        .map_err(map_request_error)?;
    let lease: GateLease = response
        .into_json()
        .map_err(|_| "Gate returned an invalid lease response".to_string())?;
    if !lease.ok || lease.ip.trim().is_empty() || lease.ttl_seconds < 60 {
        return Err("Gate returned an incomplete lease".to_string());
    }
    Ok(lease)
}

fn resolve_ipv4(netloc: &str) -> io::Result<Vec<SocketAddr>> {
    let addresses = ToSocketAddrs::to_socket_addrs(netloc)?;
    let ipv4 = addresses.filter(SocketAddr::is_ipv4).collect::<Vec<_>>();
    if ipv4.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::AddrNotAvailable,
            format!("No IPv4 address available for {netloc}"),
        ));
    }
    Ok(ipv4)
}

fn map_request_error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(401, _) | ureq::Error::Status(403, _) => {
            "Gate access link was rejected".to_string()
        }
        ureq::Error::Status(status, _) => format!("Gate returned HTTP {}", status),
        ureq::Error::Transport(_) => {
            "Gate is unreachable; check the network and try again".to_string()
        }
    }
}

fn record_lease(config: &mut GateConfig, lease: &GateLease) {
    config.last_ip = Some(lease.ip.clone());
    config.lease_expires_at = Some(lease.expires_at.clone());
    config.last_error = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn access_link_is_normalized_to_secret_free_lease_endpoint() {
        let (endpoint, token) = parse_access_link(
            "https://cksheuen.site/__pingu_gate__/allow?token=secret-value&ttl=7d",
        )
        .unwrap();

        assert_eq!(endpoint, "https://cksheuen.site/__pingu_gate__/lease");
        assert_eq!(token, "secret-value");
        assert!(!endpoint.contains("secret-value"));
    }

    #[test]
    fn base_access_link_is_normalized_to_lease_endpoint() {
        let (endpoint, _) =
            parse_access_link("https://cksheuen.site/__pingu_gate__/?token=secret-value").unwrap();

        assert_eq!(endpoint, "https://cksheuen.site/__pingu_gate__/lease");
    }

    #[test]
    fn insecure_or_tokenless_links_are_rejected() {
        assert!(parse_access_link("http://example.com/gate?token=secret").is_err());
        assert!(parse_access_link("https://example.com/gate").is_err());
    }

    #[test]
    fn settings_contract_does_not_expose_token() {
        let config = GateConfig {
            enabled: true,
            endpoint: "https://example.com/lease".to_string(),
            token: "never-return-this".to_string(),
            last_ip: Some("198.51.100.10".to_string()),
            lease_expires_at: Some("2026-08-10T15:30:00+00:00".to_string()),
            last_error: None,
        };

        let serialized = serde_json::to_string(&GateSettings::from(&config)).unwrap();
        assert!(!serialized.contains("never-return-this"));
    }

    #[test]
    fn gate_lease_resolver_keeps_only_ipv4_addresses() {
        let addresses = vec![
            "[2001:db8::1]:443".parse::<SocketAddr>().unwrap(),
            "198.51.100.27:443".parse::<SocketAddr>().unwrap(),
        ];

        let ipv4 = addresses
            .into_iter()
            .filter(SocketAddr::is_ipv4)
            .collect::<Vec<_>>();

        assert_eq!(ipv4, vec!["198.51.100.27:443".parse().unwrap()]);
    }
}
