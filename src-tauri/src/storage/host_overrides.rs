use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostOverride {
    pub id: String,
    pub host: String,
    #[serde(default = "default_resolver_mode")]
    pub resolver_mode: String,
    #[serde(default = "default_outbound_mode")]
    pub outbound_mode: String,
    #[serde(default = "default_host_override_enabled")]
    pub enabled: bool,
    #[serde(default = "default_host_override_source")]
    pub source: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default = "current_timestamp_string")]
    pub updated_at: String,
}

pub(crate) fn default_resolver_mode() -> String {
    "inherit".to_string()
}

pub(crate) fn default_outbound_mode() -> String {
    "inherit".to_string()
}

pub(crate) fn default_host_override_enabled() -> bool {
    true
}

pub(crate) fn default_host_override_source() -> String {
    "manual".to_string()
}

pub(crate) fn current_timestamp_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

pub(crate) fn normalize_host(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Host is required".to_string());
    }

    let candidate = if trimmed.contains("://") {
        let parsed = Url::parse(trimmed).map_err(|_| "Host is invalid".to_string())?;
        parsed
            .host_str()
            .ok_or("Host is invalid".to_string())?
            .to_string()
    } else {
        trimmed
            .trim_matches('/')
            .trim_start_matches('.')
            .to_string()
    };

    let normalized = candidate.to_ascii_lowercase();
    if normalized.is_empty() || normalized.contains('/') || normalized.contains(char::is_whitespace)
    {
        return Err("Host is invalid".to_string());
    }

    Ok(normalized)
}

pub(crate) fn normalize_resolver_mode(value: Option<&str>) -> Result<String, String> {
    let normalized = value.unwrap_or("inherit").trim();
    if normalized.is_empty() {
        return Ok(default_resolver_mode());
    }

    match normalized {
        "inherit" | "system-dns" | "local-dns" | "remote-dns" => Ok(normalized.to_string()),
        _ => Ok(normalized.to_string()),
    }
}

pub(crate) fn normalize_outbound_mode(value: Option<&str>) -> Result<String, String> {
    let normalized = value.unwrap_or("inherit").trim();
    if normalized.is_empty() {
        return Ok(default_outbound_mode());
    }

    match normalized {
        "inherit" | "direct" | "proxy" | "block" => Ok(normalized.to_string()),
        _ => Err("Outbound mode must be inherit, direct, proxy, or block".to_string()),
    }
}

pub(crate) fn normalize_host_override_source(value: Option<&str>) -> String {
    let normalized = value.unwrap_or("manual").trim();
    if normalized.is_empty() {
        return default_host_override_source();
    }
    normalized.to_string()
}

pub(crate) fn normalize_reason(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_string()
}
