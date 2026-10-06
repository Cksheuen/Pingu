use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use super::byted_internal::{
    make_byted_internal_dns_group, normalize_nameserver_policy,
    strengthen_byted_internal_dns_group, BYTED_INTERNAL_DNS_GROUP_NAME,
};
pub use super::host_overrides::HostOverride;
use super::host_overrides::{
    current_timestamp_string, normalize_host, normalize_host_override_source,
    normalize_outbound_mode, normalize_reason, normalize_resolver_mode,
};
use crate::mihomo::config_gen::{Rule, RuleGroup};
use crate::mihomo::uri_parser::{parse_vless_uri, Node};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub mesh: crate::mesh::MeshSettings,
    #[serde(skip)]
    pub mesh_runtime: Option<crate::mesh::MeshRoute>,
    #[serde(default)]
    pub proxy_chain: crate::chain::ChainSettings,
    #[serde(default)]
    pub subscriptions: Vec<crate::mihomo::profiles::Subscription>,
    #[serde(default)]
    pub strategy_selections: std::collections::HashMap<String, String>,
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
                    let mut changed = config.normalize_legacy_default_rule_group();
                    changed = config.backfill_node_security() || changed;
                    changed = config.normalize_host_overrides() || changed;
                    changed = config.normalize_rule_groups() || changed;
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
                        mesh: Default::default(),
            mesh_runtime: None,
            proxy_chain: Default::default(),
                        subscriptions: vec![],
                        strategy_selections: Default::default(),
                        nodes: old.nodes,
                        active_node_id: old.active_node_id,
                        rule_groups: vec![group],
                        active_group_id: active_id,
                        host_overrides: vec![],
                        autostart: false,
                        language: default_language(),
                    };
                    let mut config = config;
                    let _ = config.normalize_legacy_default_rule_group();
                    let _ = config.normalize_rule_groups();
                    config.save().ok();
                    return config;
                }
                Self::default_config()
            }
            Err(_) => Self::default_config(),
        }
    }

    fn normalize_legacy_default_rule_group(&mut self) -> bool {
        let mut changed = false;
        for group in &mut self.rule_groups {
            // Only migrate the unmodified shipped template. The added GFW rule
            // also makes this idempotent without resetting later user choices.
            if group.name != "Default" || group.rules.len() != 2 {
                continue;
            }
            let has_geosite_cn = group.rules.iter().any(|rule| {
                rule.rule_type == "geosite"
                    && matches!(rule.match_value.as_str(), "cn" | "geolocation-cn")
                    && rule.outbound == "direct"
            });
            let geoip_index = group.rules.iter().position(|rule| {
                rule.rule_type == "geoip" && rule.match_value == "cn" && rule.outbound == "direct"
            });
            if let Some(index) = geoip_index.filter(|_| has_geosite_cn) {
                // Match blocked domains before any IP lookup, which could be
                // poisoned or unavailable on the direct network.
                group.rules.insert(index, Self::blocked_domains_rule());
                group.default_strategy = "direct".into();
                changed = true;
            }
        }
        changed
    }

    fn blocked_domains_rule() -> Rule {
        Rule {
            id: uuid::Uuid::new_v4().to_string(),
            rule_type: "geosite".into(),
            match_value: "gfw".into(),
            outbound: "proxy".into(),
        }
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

    fn normalize_rule_groups(&mut self) -> bool {
        let mut changed = false;
        for group in &mut self.rule_groups {
            for policy in &mut group.nameserver_policy {
                changed = normalize_nameserver_policy(policy) || changed;
            }
        }

        changed = self.ensure_byted_internal_dns_group() || changed;
        changed
    }

    fn ensure_byted_internal_dns_group(&mut self) -> bool {
        if let Some(group) = self
            .rule_groups
            .iter_mut()
            .find(|group| group.name == BYTED_INTERNAL_DNS_GROUP_NAME)
        {
            return strengthen_byted_internal_dns_group(group);
        }

        self.rule_groups.push(make_byted_internal_dns_group());
        true
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config directory: {}", e))?;
        }
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        crate::mihomo::private_write(&path, content.as_bytes())?;
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
                Self::blocked_domains_rule(),
                Rule {
                    id: uuid::Uuid::new_v4().to_string(),
                    rule_type: "geoip".into(),
                    match_value: "cn".into(),
                    outbound: "direct".into(),
                },
            ],
            default_strategy: "direct".into(),
            fake_ip_filter: vec![],
            nameserver_policy: vec![],
        };
        let byted_internal_dns = make_byted_internal_dns_group();
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
            mesh: Default::default(),
            mesh_runtime: None,
            proxy_chain: Default::default(),
            subscriptions: vec![],
            strategy_selections: Default::default(),
            nodes: Vec::new(),
            active_node_id: None,
            rule_groups: vec![default_group, byted_internal_dns, full_proxy, direct_only],
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
        // `Pingu Proxy` is generated from the node list, so its saved selection can name a
        // node this change just replaced. Only that group belongs to the node picker;
        // subscription-owned groups keep their own selections.
        self.strategy_selections.remove("Pingu Proxy");
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

#[cfg(test)]
mod tests;
