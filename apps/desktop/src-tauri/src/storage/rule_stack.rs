use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::app_config::AppConfig;
use crate::mihomo::config_gen::{Rule, RuleGroup};

pub const STACK_ID: &str = "__rule_stack__";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleStack {
    pub enabled_group_ids: Vec<String>,
    pub default_strategy: String,
}

fn rule_key(rule: &Rule) -> (String, String, String) {
    let value = &rule.match_value;
    (
        rule.rule_type.clone(),
        value.to_string(),
        rule.outbound.clone(),
    )
}

fn builtin_direct(rule: &Rule) -> bool {
    rule.rule_type == "ip_cidr"
        && rule.outbound == "direct"
        && matches!(
            rule.match_value.as_str(),
            "127.0.0.0/8" | "10.0.0.0/8" | "172.16.0.0/12" | "192.168.0.0/16"
                | "::1/128" | "fc00::/7" | "fe80::/10"
        )
}

impl AppConfig {
    /// Replace only the explicitly addressed group. Draft validation happens
    /// before mutation, and neither editor selection nor the routing stack moves.
    pub fn update_rule_group(&mut self, mut group: RuleGroup) -> Result<RuleGroup, String> {
        let index = self
            .rule_groups
            .iter()
            .position(|entry| entry.id == group.id)
            .ok_or("Rule group not found")?;
        group.name = group.name.trim().to_string();
        if group.name.is_empty() {
            return Err("Rule group name cannot be empty".into());
        }
        let mut ids = HashSet::new();
        for rule in &mut group.rules {
            if rule.id.is_empty() {
                rule.id = uuid::Uuid::new_v4().to_string();
            }
            if !ids.insert(rule.id.clone()) {
                return Err("Duplicate rule ID".into());
            }
            rule.match_value = rule.match_value.trim().to_string();
            if !matches!(rule.outbound.as_str(), "direct" | "proxy" | "block") {
                return Err("Unsupported rule outbound".into());
            }
            if rule.match_value.is_empty()
                || rule
                    .match_value
                    .chars()
                    .any(|c| c == ',' || c.is_whitespace())
            {
                return Err("Rule match cannot be empty or contain commas/whitespace".into());
            }
            match rule.rule_type.as_str() {
                "domain" | "domain_suffix" => {}
                "geosite" | "geoip" => {
                    if !rule
                        .match_value
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '!')
                    {
                        return Err("Invalid rule-set name".into());
                    }
                }
                "ip_cidr" => {
                    let valid = rule
                        .match_value
                        .split_once('/')
                        .and_then(|(ip, prefix)| {
                            let ip: std::net::IpAddr = ip.parse().ok()?;
                            let prefix: u8 = prefix.parse().ok()?;
                            Some(prefix <= if ip.is_ipv4() { 32 } else { 128 })
                        })
                        .unwrap_or(false);
                    if !valid {
                        return Err("Invalid IP CIDR".into());
                    }
                }
                "ip_is_private" if rule.match_value == "true" && rule.outbound == "direct" => {}
                _ => return Err("Unsupported rule type".into()),
            }
        }
        let mut suffixes = HashSet::new();
        for policy in &mut group.nameserver_policy {
            policy.domain_suffix = policy.domain_suffix.trim().to_string();
            let suffix = policy
                .domain_suffix
                .trim_start_matches("+.")
                .trim_start_matches('.')
                .to_ascii_lowercase();
            if suffix.is_empty() || suffix.chars().any(|c| c == ',' || c.is_whitespace()) {
                return Err("Invalid DNS domain suffix".into());
            }
            if !suffixes.insert(suffix) {
                return Err("Duplicate DNS domain suffix".into());
            }
            let servers = policy.normalized_servers();
            if servers.is_empty() {
                return Err("DNS policy requires a resolver".into());
            }
            policy.server = servers[0].clone();
            policy.servers = servers;
        }
        group.fake_ip_filter = group
            .fake_ip_filter
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect();
        // The old per-group default is retained for compatibility, not editable
        // here: global fallback belongs to the ordered stack.
        group.default_strategy = self.rule_groups[index].default_strategy.clone();
        self.rule_groups[index] = group.clone();
        Ok(group)
    }

    pub fn routing_stack(&self) -> RuleStack {
        self.rule_stack.clone().unwrap_or_else(|| RuleStack {
            enabled_group_ids: vec![self.active_group_id.clone()],
            default_strategy: self
                .active_rule_group()
                .map(|group| group.default_strategy.clone())
                .unwrap_or_else(|_| "proxy".into()),
        })
    }

    /// One-time migration keeps the selected policy. Empty legacy mode presets
    /// become the global fallback instead of masquerading as matchable groups.
    pub fn migrate_rule_stack(&mut self) -> bool {
        if self.rule_stack.is_some() {
            return false;
        }
        let mut stack = self.routing_stack();
        self.rule_groups.retain(|group| {
            !(matches!(group.name.as_str(), "Full Proxy" | "Direct Only")
                && group.rules.is_empty()
                && group.nameserver_policy.is_empty()
                && group.fake_ip_filter.is_empty())
        });
        stack
            .enabled_group_ids
            .retain(|id| self.rule_groups.iter().any(|group| &group.id == id));
        if !self
            .rule_groups
            .iter()
            .any(|group| group.id == self.active_group_id)
        {
            if let Some(group) = self.rule_groups.first() {
                self.active_group_id = group.id.clone();
            }
        }
        self.rule_stack = Some(stack);
        self.deduplicate_rules();
        true
    }

    pub fn set_rule_stack(&mut self, stack: RuleStack) -> Result<(), String> {
        if !matches!(stack.default_strategy.as_str(), "direct" | "proxy") {
            return Err("Strategy must be 'proxy' or 'direct'".into());
        }
        let mut seen = HashSet::new();
        for id in &stack.enabled_group_ids {
            if !self.rule_groups.iter().any(|group| &group.id == id) {
                return Err("Rule group not found".into());
            }
            if !seen.insert(id) {
                return Err("A rule group may only appear once".into());
            }
        }
        self.rule_stack = Some(stack);
        Ok(())
    }

    pub fn toggle_rule_group(&mut self, id: &str) -> Result<(), String> {
        let mut stack = self.routing_stack();
        if stack.enabled_group_ids.iter().any(|entry| entry == id) {
            stack.enabled_group_ids.retain(|entry| entry != id);
        } else {
            stack.enabled_group_ids.push(id.into());
        }
        self.set_rule_stack(stack)
    }

    /// Saved groups remain independent: deleting a duplicate from a different
    /// group would change behavior when that other group is later disabled.
    pub fn deduplicate_rules(&mut self) -> usize {
        let mut removed = 0;
        for group in &mut self.rule_groups {
            let mut seen = HashSet::new();
            group.rules.retain(|rule| {
                let keep = !builtin_direct(rule) && seen.insert(rule_key(rule));
                if !keep {
                    removed += 1;
                }
                keep
            });
        }
        removed
    }

    pub fn effective_rule_group(&self) -> Result<RuleGroup, String> {
        let Some(stack) = self.rule_stack.as_ref() else {
            return self.active_rule_group().cloned();
        };
        let mut combined = RuleGroup {
            id: STACK_ID.into(),
            name: String::new(),
            rules: vec![],
            default_strategy: stack.default_strategy.clone(),
            nameserver_policy: vec![],
            fake_ip_filter: vec![],
        };
        let mut names = Vec::new();
        let mut rules = HashSet::new();
        let mut dns = HashSet::new();
        let mut filters = HashSet::new();
        for id in &stack.enabled_group_ids {
            let group = self
                .rule_groups
                .iter()
                .find(|group| &group.id == id)
                .ok_or("Enabled rule group not found")?;
            names.push(group.name.clone());
            for rule in &group.rules {
                if !builtin_direct(rule) && rules.insert(rule_key(rule)) {
                    combined.rules.push(rule.clone());
                }
            }
            for policy in &group.nameserver_policy {
                let suffix = policy
                    .domain_suffix
                    .trim()
                    .trim_start_matches("+.")
                    .trim_start_matches('.')
                    .to_ascii_lowercase();
                if !suffix.is_empty() && dns.insert(suffix.clone()) {
                    let mut policy = policy.clone();
                    policy.domain_suffix = suffix;
                    combined.nameserver_policy.push(policy);
                }
            }
            for filter in &group.fake_ip_filter {
                if filters.insert(filter.clone()) {
                    combined.fake_ip_filter.push(filter.clone());
                }
            }
        }
        combined.name = if names.is_empty() {
            match (self.language.as_str(), stack.default_strategy.as_str()) {
                ("zh", "direct") => "兜底直连",
                ("zh", _) => "兜底代理",
                (_, "direct") => "Fallback: direct",
                _ => "Fallback: proxy",
            }
            .into()
        } else {
            names.join(" → ")
        };
        Ok(combined)
    }
}

#[cfg(test)]
mod tests;
