use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use url::Url;

use crate::singbox::config_gen::{Rule, RuleGroup};
use crate::singbox::uri_parser::{parse_vless_uri, Node};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub nodes: Vec<Node>,
    pub active_node_id: Option<String>,
    pub rule_groups: Vec<RuleGroup>,
    pub active_group_id: String,
    #[serde(default)]
    pub host_overrides: Vec<HostOverride>,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default = "default_language")]
    pub language: String,
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
                    changed = config.normalize_host_overrides() || changed;
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
                        host_overrides: vec![],
                        autostart: false,
                        language: default_language(),
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

    fn normalize_host_overrides(&mut self) -> bool {
        let mut changed = false;
        let mut normalized = Vec::with_capacity(self.host_overrides.len());

        for mut item in self.host_overrides.clone() {
            let original = item.clone();

            if item.id.trim().is_empty() {
                item.id = uuid::Uuid::new_v4().to_string();
            }

            match normalize_host(&item.host) {
                Ok(host) => item.host = host,
                Err(_) => {
                    changed = true;
                    continue;
                }
            }

            item.resolver_mode = match normalize_resolver_mode(Some(item.resolver_mode.as_str())) {
                Ok(value) => value,
                Err(_) => {
                    changed = true;
                    continue;
                }
            };
            item.outbound_mode = match normalize_outbound_mode(Some(item.outbound_mode.as_str())) {
                Ok(value) => value,
                Err(_) => {
                    changed = true;
                    continue;
                }
            };
            item.source = normalize_host_override_source(Some(item.source.as_str()));
            item.reason = item.reason.trim().to_string();
            if item.updated_at.trim().is_empty() {
                item.updated_at = current_timestamp_string();
            }

            if item != original {
                changed = true;
            }
            normalized.push(item);
        }

        if normalized.len() != self.host_overrides.len() {
            changed = true;
        }

        self.host_overrides = normalized;
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
            host_overrides: vec![],
            autostart: false,
            language: default_language(),
        }
    }

    pub fn import_node_uri(&mut self, vless_uri: &str) -> Result<Node, String> {
        let node = parse_vless_uri(vless_uri)?;
        Ok(self.add_node(node))
    }

    pub fn add_node(&mut self, node: Node) -> Node {
        self.nodes.push(node.clone());
        if self.active_node_id.is_none() {
            self.active_node_id = Some(node.id.clone());
        }
        node
    }

    pub fn delete_node(&mut self, id: &str) {
        self.nodes.retain(|node| node.id != id);
        if self.active_node_id.as_deref() == Some(id) {
            self.active_node_id = self.nodes.first().map(|node| node.id.clone());
        }
    }

    pub fn set_active_node(&mut self, id: &str) -> Result<(), String> {
        if !self.nodes.iter().any(|node| node.id == id) {
            return Err("Node not found".to_string());
        }

        self.active_node_id = Some(id.to_string());
        Ok(())
    }

    pub fn list_rules(&self) -> Result<Vec<Rule>, String> {
        Ok(self.active_rule_group()?.rules.clone())
    }

    pub fn set_active_group(&mut self, id: &str) -> Result<(), String> {
        if !self.rule_groups.iter().any(|group| group.id == id) {
            return Err("Group not found".to_string());
        }

        self.active_group_id = id.to_string();
        Ok(())
    }

    pub fn create_rule_group(&mut self, name: String) -> RuleGroup {
        let group = RuleGroup {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            rules: vec![],
            default_strategy: "proxy".into(),
            fake_ip_filter: vec![],
            nameserver_policy: vec![],
        };
        self.rule_groups.push(group.clone());
        group
    }

    pub fn delete_rule_group(&mut self, id: &str) -> Result<(), String> {
        if self.rule_groups.len() <= 1 {
            return Err("Cannot delete the last group".to_string());
        }

        self.rule_groups.retain(|group| group.id != id);
        if self.active_group_id == id {
            self.active_group_id = self.rule_groups[0].id.clone();
        }
        Ok(())
    }

    pub fn rename_rule_group(&mut self, id: &str, name: String) -> Result<(), String> {
        let group = self
            .rule_groups
            .iter_mut()
            .find(|group| group.id == id)
            .ok_or("Group not found")?;
        group.name = name;
        Ok(())
    }

    pub fn add_rule_to_active_group(&mut self, rule: Rule) -> Result<Rule, String> {
        let rule = if rule.id.is_empty() {
            Rule {
                id: uuid::Uuid::new_v4().to_string(),
                ..rule
            }
        } else {
            rule
        };

        self.active_rule_group_mut()?.rules.push(rule.clone());
        Ok(rule)
    }

    pub fn delete_rule_from_active_group(&mut self, id: &str) -> Result<(), String> {
        self.active_rule_group_mut()?
            .rules
            .retain(|rule| rule.id != id);
        Ok(())
    }

    pub fn set_active_group_default_strategy(&mut self, strategy: &str) -> Result<(), String> {
        if strategy != "proxy" && strategy != "direct" {
            return Err("Strategy must be 'proxy' or 'direct'".to_string());
        }

        self.active_rule_group_mut()?.default_strategy = strategy.to_string();
        Ok(())
    }

    pub fn active_rule_group(&self) -> Result<&RuleGroup, String> {
        self.rule_groups
            .iter()
            .find(|group| group.id == self.active_group_id)
            .ok_or("Active group not found".to_string())
    }

    pub fn active_rule_group_mut(&mut self) -> Result<&mut RuleGroup, String> {
        let active_group_id = self.active_group_id.clone();
        self.rule_groups
            .iter_mut()
            .find(|group| group.id == active_group_id)
            .ok_or("Active group not found".to_string())
    }

    pub fn find_rule_group_name(&self, id: &str) -> Option<String> {
        self.rule_groups
            .iter()
            .find(|group| group.id == id)
            .map(|group| group.name.clone())
    }

    pub fn list_host_overrides(&self) -> Vec<HostOverride> {
        self.host_overrides.clone()
    }

    pub fn create_host_override(
        &mut self,
        host: &str,
        resolver_mode: Option<&str>,
        outbound_mode: Option<&str>,
        enabled: Option<bool>,
        source: Option<&str>,
        reason: Option<&str>,
    ) -> Result<HostOverride, String> {
        let normalized_host = normalize_host(host)?;
        if self
            .host_overrides
            .iter()
            .any(|item| item.host == normalized_host)
        {
            return Err("Host override already exists".to_string());
        }

        let item = HostOverride {
            id: uuid::Uuid::new_v4().to_string(),
            host: normalized_host,
            resolver_mode: normalize_resolver_mode(resolver_mode)?,
            outbound_mode: normalize_outbound_mode(outbound_mode)?,
            enabled: enabled.unwrap_or(true),
            source: normalize_host_override_source(source),
            reason: normalize_reason(reason),
            updated_at: current_timestamp_string(),
        };
        self.host_overrides.push(item.clone());
        Ok(item)
    }

    pub fn update_host_override(
        &mut self,
        id: &str,
        host: Option<&str>,
        resolver_mode: Option<&str>,
        outbound_mode: Option<&str>,
        enabled: Option<bool>,
        source: Option<&str>,
        reason: Option<&str>,
    ) -> Result<HostOverride, String> {
        let index = self
            .host_overrides
            .iter()
            .position(|item| item.id == id)
            .ok_or("Host override not found")?;

        let next_host = match host {
            Some(value) => normalize_host(value)?,
            None => self.host_overrides[index].host.clone(),
        };
        if self
            .host_overrides
            .iter()
            .enumerate()
            .any(|(current, item)| current != index && item.host == next_host)
        {
            return Err("Host override already exists".to_string());
        }

        let item = &mut self.host_overrides[index];
        item.host = next_host;
        if let Some(value) = resolver_mode {
            item.resolver_mode = normalize_resolver_mode(Some(value))?;
        }
        if let Some(value) = outbound_mode {
            item.outbound_mode = normalize_outbound_mode(Some(value))?;
        }
        if let Some(value) = enabled {
            item.enabled = value;
        }
        if let Some(value) = source {
            item.source = normalize_host_override_source(Some(value));
        }
        if let Some(value) = reason {
            item.reason = normalize_reason(Some(value));
        }
        item.updated_at = current_timestamp_string();
        Ok(item.clone())
    }

    pub fn delete_host_override(&mut self, id: &str) -> Result<(), String> {
        let before = self.host_overrides.len();
        self.host_overrides.retain(|item| item.id != id);
        if self.host_overrides.len() == before {
            return Err("Host override not found".to_string());
        }
        Ok(())
    }

    pub fn toggle_host_override(&mut self, id: &str) -> Result<HostOverride, String> {
        let item = self
            .host_overrides
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or("Host override not found")?;
        item.enabled = !item.enabled;
        item.updated_at = current_timestamp_string();
        Ok(item.clone())
    }

    pub fn reset_host_overrides(&mut self) {
        self.host_overrides.clear();
    }
}

fn default_language() -> String {
    "zh".to_string()
}

fn default_resolver_mode() -> String {
    "inherit".to_string()
}

fn default_outbound_mode() -> String {
    "inherit".to_string()
}

fn default_host_override_enabled() -> bool {
    true
}

fn default_host_override_source() -> String {
    "manual".to_string()
}

fn current_timestamp_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn normalize_host(value: &str) -> Result<String, String> {
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

fn normalize_resolver_mode(value: Option<&str>) -> Result<String, String> {
    let normalized = value.unwrap_or("inherit").trim();
    if normalized.is_empty() {
        return Ok(default_resolver_mode());
    }

    match normalized {
        "inherit" | "system-dns" | "local-dns" | "remote-dns" => Ok(normalized.to_string()),
        _ => Ok(normalized.to_string()),
    }
}

fn normalize_outbound_mode(value: Option<&str>) -> Result<String, String> {
    let normalized = value.unwrap_or("inherit").trim();
    if normalized.is_empty() {
        return Ok(default_outbound_mode());
    }

    match normalized {
        "inherit" | "direct" | "proxy" | "block" => Ok(normalized.to_string()),
        _ => Err("Outbound mode must be inherit, direct, proxy, or block".to_string()),
    }
}

fn normalize_host_override_source(value: Option<&str>) -> String {
    let normalized = value.unwrap_or("manual").trim();
    if normalized.is_empty() {
        return default_host_override_source();
    }
    normalized.to_string()
}

fn normalize_reason(value: Option<&str>) -> String {
    value.unwrap_or_default().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_node(id: &str, name: &str) -> Node {
        Node {
            id: id.to_string(),
            name: name.to_string(),
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

    fn sample_rule(id: &str, outbound: &str) -> Rule {
        Rule {
            id: id.to_string(),
            rule_type: "domain_suffix".to_string(),
            match_value: "example.com".to_string(),
            outbound: outbound.to_string(),
        }
    }

    #[test]
    fn import_first_node_sets_active_node() {
        let mut config = AppConfig::default_config();

        let node = config.add_node(sample_node("node-1", "Node 1"));

        assert_eq!(config.nodes.len(), 1);
        assert_eq!(config.active_node_id.as_deref(), Some(node.id.as_str()));
    }

    #[test]
    fn deleting_active_node_falls_back_to_first_remaining_node() {
        let mut config = AppConfig::default_config();
        config.add_node(sample_node("node-1", "Node 1"));
        config.add_node(sample_node("node-2", "Node 2"));
        config.active_node_id = Some("node-2".to_string());

        config.delete_node("node-2");

        assert_eq!(config.nodes.len(), 1);
        assert_eq!(config.active_node_id.as_deref(), Some("node-1"));
    }

    #[test]
    fn set_active_node_rejects_missing_node() {
        let mut config = AppConfig::default_config();

        let error = config.set_active_node("missing").unwrap_err();

        assert_eq!(error, "Node not found");
    }

    #[test]
    fn rule_group_crud_and_strategy_updates_stay_inside_app_config() {
        let mut config = AppConfig::default_config();
        let created = config.create_rule_group("Work".to_string());
        config.set_active_group(&created.id).unwrap();

        let inserted = config
            .add_rule_to_active_group(sample_rule("", "proxy"))
            .unwrap();
        assert!(!inserted.id.is_empty());
        assert_eq!(config.list_rules().unwrap().len(), 1);

        config.set_active_group_default_strategy("direct").unwrap();
        assert_eq!(
            config.active_rule_group().unwrap().default_strategy,
            "direct"
        );

        config
            .rename_rule_group(&created.id, "Renamed".to_string())
            .unwrap();
        assert_eq!(
            config.find_rule_group_name(&created.id).as_deref(),
            Some("Renamed")
        );

        config.delete_rule_from_active_group(&inserted.id).unwrap();
        assert!(config.list_rules().unwrap().is_empty());
    }

    #[test]
    fn deleting_last_group_is_rejected() {
        let mut config = AppConfig::default_config();
        let ids: Vec<String> = config
            .rule_groups
            .iter()
            .map(|group| group.id.clone())
            .collect();

        config.delete_rule_group(&ids[0]).unwrap();
        config.delete_rule_group(&ids[1]).unwrap();
        let error = config.delete_rule_group(&ids[2]).unwrap_err();

        assert_eq!(error, "Cannot delete the last group");
    }

    #[test]
    fn host_override_crud_normalizes_and_updates_timestamp() {
        let mut config = AppConfig::default_config();

        let created = config
            .create_host_override(
                "HTTPS://BNPM.BYTED.ORG/",
                Some("system-dns"),
                Some("direct"),
                Some(true),
                Some("manual"),
                Some("Force direct/system dns"),
            )
            .unwrap();

        assert_eq!(created.host, "bnpm.byted.org");
        assert_eq!(created.resolver_mode, "system-dns");
        assert_eq!(created.outbound_mode, "direct");
        assert_eq!(created.source, "manual");
        assert_eq!(created.reason, "Force direct/system dns");
        assert!(created.enabled);

        let updated = config
            .update_host_override(
                &created.id,
                Some("registry.npmjs.org"),
                Some("remote-dns"),
                Some("proxy"),
                Some(false),
                None,
                Some("Use proxy"),
            )
            .unwrap();

        assert_eq!(updated.host, "registry.npmjs.org");
        assert_eq!(updated.resolver_mode, "remote-dns");
        assert_eq!(updated.outbound_mode, "proxy");
        assert!(!updated.enabled);
        assert_eq!(updated.reason, "Use proxy");

        let toggled = config.toggle_host_override(&created.id).unwrap();
        assert!(toggled.enabled);

        config.delete_host_override(&created.id).unwrap();
        assert!(config.host_overrides.is_empty());
    }

    #[test]
    fn duplicate_host_override_is_rejected_after_normalization() {
        let mut config = AppConfig::default_config();
        config
            .create_host_override("bnpm.byted.org", Some("system-dns"), None, None, None, None)
            .unwrap();

        let error = config
            .create_host_override(
                "https://bnpm.byted.org/",
                Some("remote-dns"),
                None,
                None,
                None,
                None,
            )
            .unwrap_err();

        assert_eq!(error, "Host override already exists");
    }
}
