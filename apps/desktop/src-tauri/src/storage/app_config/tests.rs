use super::*;
use crate::storage::byted_internal::{BYTED_INTERNAL_PRIMARY_DNS, BYTED_INTERNAL_SECONDARY_DNS};

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
        ..Default::default()
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
fn settings_load_from_old_config_and_survive_serialization() {
    let mut config: AppConfig = serde_json::from_str(
        r#"{
        "nodes": [], "active_node_id": null,
        "rule_groups": [{"id":"g1","name":"G1","rules":[],"default_strategy":"proxy"}],
        "active_group_id": "g1", "host_overrides": []
    }"#,
    )
    .unwrap();
    assert!(!config.autostart);
    assert_eq!(config.language, "zh");
    config.autostart = true;
    config.language = "en".into();
    let restored: AppConfig =
        serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
    assert!(restored.autostart);
    assert_eq!(restored.language, "en");
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
fn set_active_node_clears_only_the_device_selector() {
    let mut config = AppConfig::default_config();
    config.add_node(sample_node("node-1", "Node 1"));
    config.add_node(sample_node("node-2", "Node 2"));
    config
        .strategy_selections
        .insert("Pingu Proxy".into(), "Node 1 [node-1]".into());
    config.strategy_selections.insert(
        "Source A [aaaaaaaa] / Choice".into(),
        "Source A [aaaaaaaa] / US-1".into(),
    );

    config.set_active_node("node-2").unwrap();

    assert_eq!(config.active_node_id.as_deref(), Some("node-2"));
    assert!(!config.strategy_selections.contains_key("Pingu Proxy"));
    assert_eq!(
        config
            .strategy_selections
            .get("Source A [aaaaaaaa] / Choice")
            .map(String::as_str),
        Some("Source A [aaaaaaaa] / US-1")
    );
}

#[test]
fn invalid_active_node_leaves_all_selection_state_untouched() {
    let mut config = AppConfig::default_config();
    config.add_node(sample_node("node-1", "Node 1"));
    config
        .strategy_selections
        .insert("Pingu Proxy".into(), "Node 1 [node-1]".into());
    config.strategy_selections.insert(
        "Source A [aaaaaaaa] / Choice".into(),
        "Source A [aaaaaaaa] / US-1".into(),
    );
    let active_before = config.active_node_id.clone();
    let selections_before = config.strategy_selections.clone();

    let error = config.set_active_node("missing").unwrap_err();

    assert_eq!(error, "Node not found");
    assert_eq!(config.active_node_id, active_before);
    assert_eq!(config.strategy_selections, selections_before);
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

    for id in ids.iter().take(ids.len() - 1) {
        config.delete_rule_group(id).unwrap();
    }
    let last_id = config.rule_groups[0].id.clone();
    let error = config.delete_rule_group(&last_id).unwrap_err();

    assert_eq!(error, "Cannot delete the last group");
}

#[test]
fn default_config_contains_strengthened_byted_internal_dns_group() {
    let config = AppConfig::default_config();
    let group = config
        .rule_groups
        .iter()
        .find(|group| group.name == BYTED_INTERNAL_DNS_GROUP_NAME)
        .expect("Byted Internal DNS group");

    assert_eq!(group.default_strategy, "proxy");
    assert!(group.rules.iter().any(|rule| {
        rule.rule_type == "domain_suffix"
            && rule.match_value == "tiktok-row.net"
            && rule.outbound == "direct"
    }));
    assert!(group.rules.iter().any(|rule| {
        rule.rule_type == "ip_cidr" && rule.match_value == "10.0.0.0/8" && rule.outbound == "direct"
    }));

    let policy = group
        .nameserver_policy
        .iter()
        .find(|policy| policy.domain_suffix == "+.tiktok-row.org")
        .expect("tiktok-row.org policy");
    assert_eq!(policy.server, BYTED_INTERNAL_PRIMARY_DNS);
    assert_eq!(
        policy.servers,
        vec![
            BYTED_INTERNAL_PRIMARY_DNS.to_string(),
            BYTED_INTERNAL_SECONDARY_DNS.to_string()
        ]
    );
}

#[test]
fn normalize_rule_groups_backfills_existing_byted_internal_group() {
    let mut config = AppConfig {
        subscriptions: vec![],
        strategy_selections: Default::default(),
        nodes: vec![],
        active_node_id: None,
        rule_groups: vec![RuleGroup {
            id: "group-1".to_string(),
            name: BYTED_INTERNAL_DNS_GROUP_NAME.to_string(),
            rules: vec![],
            default_strategy: "direct".to_string(),
            fake_ip_filter: vec![],
            nameserver_policy: vec![crate::mihomo::config_gen::NameServerPolicy {
                domain_suffix: "+.byted.org".to_string(),
                server: BYTED_INTERNAL_SECONDARY_DNS.to_string(),
                servers: vec![],
            }],
        }],
        active_group_id: "group-1".to_string(),
        host_overrides: vec![],
        autostart: false,
        language: "zh".to_string(),
    };

    assert!(config.normalize_rule_groups());

    let group = &config.rule_groups[0];
    assert_eq!(group.default_strategy, "proxy");
    assert!(group.rules.iter().any(|rule| {
        rule.rule_type == "domain_suffix"
            && rule.match_value == "byted.org"
            && rule.outbound == "direct"
    }));
    assert!(group.rules.iter().any(|rule| {
        rule.rule_type == "domain_suffix"
            && rule.match_value == "tiktok-row.org"
            && rule.outbound == "direct"
    }));
    assert!(group.rules.iter().any(|rule| {
        rule.rule_type == "ip_cidr" && rule.match_value == "10.0.0.0/8" && rule.outbound == "direct"
    }));

    let policy = group
        .nameserver_policy
        .iter()
        .find(|policy| policy.domain_suffix == "+.byted.org")
        .expect("byted.org policy");
    assert_eq!(policy.server, BYTED_INTERNAL_PRIMARY_DNS);
    assert_eq!(policy.servers.len(), 2);
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
