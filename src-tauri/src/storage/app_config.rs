use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::singbox::config_gen::{Rule, RuleGroup};
use crate::singbox::uri_parser::Node;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub nodes: Vec<Node>,
    pub active_node_id: Option<String>,
    pub rule_groups: Vec<RuleGroup>,
    pub active_group_id: String,
}

/// Old format for migration from pre-RuleGroup configs
#[derive(Deserialize)]
struct OldAppConfig {
    nodes: Vec<Node>,
    active_node_id: Option<String>,
    rules: Vec<Rule>,
    default_strategy: String,
}

impl AppConfig {
    fn config_path() -> Result<PathBuf, String> {
        let config_dir = dirs::config_dir()
            .ok_or("Cannot find config directory".to_string())?
            .join("sing-proxy");
        Ok(config_dir.join("config.json"))
    }

    pub fn load() -> Self {
        let path = match Self::config_path() {
            Ok(path) => path,
            Err(_) => return Self::default_config(),
        };
        match fs::read_to_string(&path) {
            Ok(content) => {
                // Try new format first
                if let Ok(mut config) = serde_json::from_str::<AppConfig>(&content) {
                    let mut changed = config.normalize_legacy_split_proxy_default();
                    changed = config.backfill_node_security() || changed;
                    if changed {
                        config.save().ok();
                    }
                    return config;
                }
                // Try old format migration
                if let Ok(old) = serde_json::from_str::<OldAppConfig>(&content) {
                    let group = RuleGroup {
                        id: uuid::Uuid::new_v4().to_string(),
                        name: "Default".into(),
                        rules: old.rules,
                        default_strategy: old.default_strategy,
                        fake_ip_filter: vec![],
                        nameserver_policy: vec![],
                    };
                    let active_id = group.id.clone();
                    let config = Self {
                        nodes: old.nodes,
                        active_node_id: old.active_node_id,
                        rule_groups: vec![group],
                        active_group_id: active_id,
                    };
                    let mut config = config;
                    let _ = config.normalize_legacy_split_proxy_default();
                    config.save().ok();
                    return config;
                }
                Self::default_config()
            }
            Err(_) => Self::default_config(),
        }
    }

    fn normalize_legacy_split_proxy_default(&mut self) -> bool {
        if self.rule_groups.len() != 1 {
            return false;
        }

        let group = &mut self.rule_groups[0];
        if group.default_strategy != "direct" || group.name != "Default" {
            return false;
        }

        let has_geosite_cn = group.rules.iter().any(|rule| {
            rule.rule_type == "geosite"
                && (rule.match_value == "cn" || rule.match_value == "geolocation-cn")
                && rule.outbound == "direct"
        });
        let has_geoip_cn = group.rules.iter().any(|rule| {
            rule.rule_type == "geoip" && rule.match_value == "cn" && rule.outbound == "direct"
        });

        if has_geosite_cn && has_geoip_cn {
            group.default_strategy = "proxy".into();
            return true;
        }

        false
    }

    fn backfill_node_security(&mut self) -> bool {
        let mut changed = false;
        for node in &mut self.nodes {
            if node.security.is_empty() {
                if !node.public_key.is_empty() {
                    node.security = "reality".into();
                    changed = true;
                } else if !node.sni.is_empty() {
                    node.security = "tls".into();
                    changed = true;
                }
            }
        }
        changed
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config directory: {}", e))?;
        }
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&path, content).map_err(|e| format!("Failed to write config: {}", e))?;
        Ok(())
    }

    pub fn default_config() -> Self {
        let default_group = RuleGroup {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Default".into(),
            rules: vec![
                Rule {
                    id: uuid::Uuid::new_v4().to_string(),
                    rule_type: "geosite".into(),
                    match_value: "geolocation-cn".into(),
                    outbound: "direct".into(),
                },
                Rule {
                    id: uuid::Uuid::new_v4().to_string(),
                    rule_type: "geoip".into(),
                    match_value: "cn".into(),
                    outbound: "direct".into(),
                },
            ],
            default_strategy: "proxy".into(),
            fake_ip_filter: vec![],
            nameserver_policy: vec![],
        };
        let full_proxy = RuleGroup {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Full Proxy".into(),
            rules: vec![],
            default_strategy: "proxy".into(),
            fake_ip_filter: vec![],
            nameserver_policy: vec![],
        };
        let direct_only = RuleGroup {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Direct Only".into(),
            rules: vec![],
            default_strategy: "direct".into(),
            fake_ip_filter: vec![],
            nameserver_policy: vec![],
        };
        let active_id = default_group.id.clone();
        Self {
            nodes: Vec::new(),
            active_node_id: None,
            rule_groups: vec![default_group, full_proxy, direct_only],
            active_group_id: active_id,
        }
    }
}
