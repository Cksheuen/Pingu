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
    assert_eq!(config.language, "en");
    config.autostart = true;
    config.language = "zh".into();
    let restored: AppConfig =
        serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
    assert!(restored.autostart);
    assert_eq!(restored.language, "zh");
}

#[test]
fn normalization_preserves_user_rules_and_does_not_inject_network_presets() {
    let mut config = AppConfig::default_config();
    config.rule_groups.truncate(1);
    config.rule_groups[0].rules = vec![sample_rule("custom", "direct")];
    config.rule_groups[0].default_strategy = "direct".into();
    let before = serde_json::to_value(&config.rule_groups).unwrap();
    assert!(!config.normalize_rule_groups());
    config.migrate_rule_stack();
    assert_eq!(serde_json::to_value(&config.rule_groups).unwrap(), before);
    assert_eq!(config.routing_stack().default_strategy, "direct");
    let restored: AppConfig = serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
    assert_eq!(restored.effective_rule_group().unwrap().rules[0].id, "custom");
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

    config.set_global_default_strategy("direct").unwrap();
    assert_eq!(
        config.effective_rule_group().unwrap().default_strategy,
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
fn normalize_rule_groups_keeps_custom_dns_without_adding_domains_or_groups() {
    let mut config = AppConfig::default_config();
    config.rule_groups[0].nameserver_policy = vec![crate::mihomo::config_gen::NameServerPolicy {
        domain_suffix: "+.private.example".into(),
        server: "192.0.2.53".into(),
        servers: vec![],
    }];
    let before_count = config.rule_groups.len();
    assert!(config.normalize_rule_groups());
    assert!(!config.normalize_rule_groups());
    assert_eq!(config.rule_groups.len(), before_count);
    let group = &config.rule_groups[0];
    assert!(group.rules.is_empty());
    assert_eq!(group.nameserver_policy.len(), 1);
    assert_eq!(group.nameserver_policy[0].domain_suffix, "+.private.example");
    assert_eq!(group.nameserver_policy[0].servers, ["192.0.2.53"]);
}

#[test]
fn host_override_crud_normalizes_and_updates_timestamp() {
    let mut config = AppConfig::default_config();

    let created = config
        .create_host_override(
            "HTTPS://REGISTRY.PRIVATE.EXAMPLE/",
            Some("system-dns"),
            Some("direct"),
            Some(true),
            Some("manual"),
            Some("Force direct/system dns"),
        )
        .unwrap();

    assert_eq!(created.host, "registry.private.example");
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
        .create_host_override("registry.private.example", Some("system-dns"), None, None, None, None)
        .unwrap();

    let error = config
        .create_host_override(
            "https://registry.private.example/",
            Some("remote-dns"),
            None,
            None,
            None,
            None,
        )
        .unwrap_err();

    assert_eq!(error, "Host override already exists");
}
