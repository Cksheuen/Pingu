use std::path::{Path, PathBuf};
use std::process::Command;

use crate::singbox::config_gen::{generate_config, RuleGroup};
use crate::singbox::uri_parser::Node;
use crate::storage::app_config::AppConfig;

pub struct PreparedRuntime {
    pub config_dir: PathBuf,
    pub config_path: PathBuf,
    pub cache_path: PathBuf,
    pub node: Node,
    pub rule_group: RuleGroup,
}

pub fn app_config_dir() -> Result<PathBuf, String> {
    let config_dir = dirs::config_dir()
        .ok_or("Cannot find config directory")?
        .join("sing-proxy");
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    Ok(config_dir)
}

pub fn prepare_runtime(config: &AppConfig) -> Result<PreparedRuntime, String> {
    let active_id = config
        .active_node_id
        .as_ref()
        .ok_or("No active node selected")?;
    let node = config
        .nodes
        .iter()
        .find(|n| &n.id == active_id)
        .cloned()
        .ok_or("Active node not found")?;
    let rule_group = config
        .rule_groups
        .iter()
        .find(|g| g.id == config.active_group_id)
        .cloned()
        .ok_or("Active rule group not found")?;

    let config_dir = app_config_dir()?;
    let cache_path = config_dir.join("cache.db");
    let config_path = config_dir.join("sing-box-config.json");
    let sb_config = generate_config(
        &node,
        &rule_group,
        cache_path.to_str().ok_or("Invalid cache path")?,
    );
    let config_str = serde_json::to_string_pretty(&sb_config).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, config_str).map_err(|e| e.to_string())?;

    Ok(PreparedRuntime {
        config_dir,
        config_path,
        cache_path,
        node,
        rule_group,
    })
}

pub fn check_generated_config(config_path: &Path) -> Result<(), String> {
    let output = Command::new("sing-box")
        .args([
            "check",
            "-c",
            config_path.to_str().ok_or("Invalid config path")?,
        ])
        .output()
        .map_err(|e| format!("Failed to run sing-box check: {}", e))?;

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
