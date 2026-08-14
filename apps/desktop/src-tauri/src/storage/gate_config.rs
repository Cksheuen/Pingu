use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct GateConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub last_ip: Option<String>,
    #[serde(default)]
    pub lease_expires_at: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
}

impl GateConfig {
    pub fn load() -> Result<Self, String> {
        let path = Self::config_path()?;
        match fs::read_to_string(&path) {
            Ok(content) => serde_json::from_str(&content)
                .map_err(|error| format!("Invalid Gate settings: {}", error)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(format!("Failed to read Gate settings: {}", error)),
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path()?;
        let parent = path
            .parent()
            .ok_or_else(|| "Invalid Gate settings path".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create Gate settings directory: {}", error))?;
        let temporary = path.with_extension("json.tmp");
        let content = serde_json::to_string_pretty(self)
            .map_err(|error| format!("Failed to serialize Gate settings: {}", error))?;
        fs::write(&temporary, content)
            .map_err(|error| format!("Failed to write Gate settings: {}", error))?;
        restrict_permissions(&temporary)?;
        fs::rename(&temporary, &path)
            .map_err(|error| format!("Failed to replace Gate settings: {}", error))?;
        restrict_permissions(&path)
    }

    pub fn configured(&self) -> bool {
        !self.endpoint.trim().is_empty() && !self.token.trim().is_empty()
    }

    fn config_path() -> Result<PathBuf, String> {
        Ok(dirs::config_dir()
            .ok_or_else(|| "Cannot find config directory".to_string())?
            .join("sing-proxy")
            .join("gate.json"))
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Failed to secure Gate settings: {}", error))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_gate_config_is_disabled_and_unconfigured() {
        let config = GateConfig::default();

        assert!(!config.enabled);
        assert!(!config.configured());
    }

    #[test]
    fn serde_defaults_keep_partial_gate_config_compatible() {
        let config: GateConfig =
            serde_json::from_str(r#"{"endpoint":"https://example.com/lease"}"#).unwrap();

        assert!(!config.enabled);
        assert!(!config.configured());
        assert!(config.last_error.is_none());
    }
}
