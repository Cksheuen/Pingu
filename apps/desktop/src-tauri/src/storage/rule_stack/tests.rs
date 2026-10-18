use super::*;
use crate::mihomo::config_gen::NameServerPolicy;

fn rule(id: &str, kind: &str, value: &str, outbound: &str) -> Rule {
    Rule {
        id: id.into(),
        rule_type: kind.into(),
        match_value: value.into(),
        outbound: outbound.into(),
    }
}

fn fixture() -> AppConfig {
    let mut config = AppConfig::default_config();
    config.rule_groups = vec![
        RuleGroup {
            id: "first".into(),
            name: "First".into(),
            rules: vec![rule("a", "domain", "example.com", "direct")],
            default_strategy: "direct".into(),
            fake_ip_filter: vec!["+.example.com".into()],
            nameserver_policy: vec![NameServerPolicy {
                domain_suffix: "+.example.com".into(),
                server: "1.1.1.1".into(),
                servers: vec![],
            }],
        },
        RuleGroup {
            id: "second".into(),
            name: "Second".into(),
            rules: vec![
                rule("b", "domain", "example.com", "proxy"),
                rule("c", "domain", "other.test", "block"),
            ],
            default_strategy: "proxy".into(),
            fake_ip_filter: vec!["+.example.com".into()],
            nameserver_policy: vec![NameServerPolicy {
                domain_suffix: "example.com".into(),
                server: "8.8.8.8".into(),
                servers: vec![],
            }],
        },
    ];
    config.active_group_id = "first".into();
    config
}

#[test]
fn editing_explicit_group_preserves_stack_selection_and_other_groups() {
    let mut config = fixture();
    config.migrate_rule_stack();
    let stack = config.routing_stack();
    let first = serde_json::to_value(&config.rule_groups[0]).unwrap();
    let mut edited = config.rule_groups[1].clone();
    edited.name = " Renamed group ".into();
    edited.default_strategy = "direct".into();
    edited.rules.swap(0, 1);
    edited.rules[0].match_value = "updated.test".into();
    edited.rules[0].outbound = "direct".into();
    let saved = config.update_rule_group(edited).unwrap();
    assert_eq!(saved.name, "Renamed group");
    assert_eq!(saved.rules[0].id, "c");
    assert_eq!(saved.rules[0].match_value, "updated.test");
    assert_eq!(saved.rules[0].outbound, "direct");
    assert_eq!(saved.default_strategy, "proxy");
    assert_eq!(
        saved.nameserver_policy[0].primary_server().as_deref(),
        Some("8.8.8.8")
    );
    assert_eq!(serde_json::to_value(&config.rule_groups[0]).unwrap(), first);
    assert_eq!(config.routing_stack(), stack);
    assert_eq!(config.active_group_id, "first");
    let restored: AppConfig =
        serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
    assert_eq!(restored.rule_groups[1].rules[0].match_value, "updated.test");
    assert_eq!(restored.effective_rule_group().unwrap().rules[0].id, "a");
}

#[test]
fn invalid_group_drafts_cannot_partially_replace_saved_rules_or_dns() {
    let mut config = fixture();
    config.migrate_rule_stack();
    let before = serde_json::to_value(&config).unwrap();
    let mut invalid = config.rule_groups[0].clone();
    invalid.name = "Should not save".into();
    invalid.rules[0].match_value = "example.com,REJECT".into();
    assert!(config.update_rule_group(invalid).is_err());
    assert_eq!(serde_json::to_value(&config).unwrap(), before);
    let mut invalid = config.rule_groups[0].clone();
    invalid.nameserver_policy[0].server.clear();
    invalid.nameserver_policy[0].servers.clear();
    assert!(config.update_rule_group(invalid).is_err());
    assert_eq!(serde_json::to_value(&config).unwrap(), before);
    let mut invalid = config.rule_groups[0].clone();
    invalid.rules.push(invalid.rules[0].clone());
    assert!(config.update_rule_group(invalid).is_err());
    assert_eq!(serde_json::to_value(&config).unwrap(), before);
}

#[test]
fn ordering_controls_rules_and_same_suffix_dns_and_survives_reload() {
    let mut config = fixture();
    config
        .set_rule_stack(RuleStack {
            enabled_group_ids: vec!["second".into(), "first".into()],
            default_strategy: "direct".into(),
        })
        .unwrap();
    let restored: AppConfig =
        serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
    let effective = restored.effective_rule_group().unwrap();
    assert_eq!(
        effective
            .rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect::<Vec<_>>(),
        ["b", "c", "a"]
    );
    assert_eq!(effective.nameserver_policy.len(), 1);
    assert_eq!(
        effective.nameserver_policy[0].primary_server().as_deref(),
        Some("8.8.8.8")
    );
    assert_eq!(effective.fake_ip_filter, ["+.example.com"]);
    config.toggle_rule_group("second").unwrap();
    let effective = config.effective_rule_group().unwrap();
    assert_eq!(effective.rules.len(), 1);
    assert_eq!(
        effective.nameserver_policy[0].primary_server().as_deref(),
        Some("1.1.1.1")
    );
}

#[test]
fn editor_selection_and_group_defaults_cannot_change_active_stack() {
    let mut config = fixture();
    config.migrate_rule_stack();
    config.set_active_group("second").unwrap();
    assert_eq!(config.effective_rule_group().unwrap().rules[0].id, "a");
    config.set_global_default_strategy("proxy").unwrap();
    assert_eq!(
        config.effective_rule_group().unwrap().default_strategy,
        "proxy"
    );
    assert_eq!(config.rule_groups[0].default_strategy, "direct");
    config.delete_rule_group("first").unwrap();
    assert!(config.effective_rule_group().unwrap().rules.is_empty());
    assert_eq!(
        config.effective_rule_group().unwrap().default_strategy,
        "proxy"
    );
}

#[test]
fn invalid_stack_does_not_replace_saved_policy_and_empty_stack_is_valid() {
    let mut config = fixture();
    config.migrate_rule_stack();
    let before = config.routing_stack();
    for ids in [vec!["missing".into()], vec!["first".into(), "first".into()]] {
        assert!(config
            .set_rule_stack(RuleStack {
                enabled_group_ids: ids,
                default_strategy: "proxy".into()
            })
            .is_err());
        assert_eq!(config.routing_stack(), before);
    }
    config
        .set_rule_stack(RuleStack {
            enabled_group_ids: vec![],
            default_strategy: "direct".into(),
        })
        .unwrap();
    assert!(config.effective_rule_group().unwrap().rules.is_empty());
    assert!(config
        .effective_rule_group()
        .unwrap()
        .nameserver_policy
        .is_empty());
}

#[test]
fn cleanup_removes_exact_duplicates_and_builtin_private_rules_without_deleting_other_groups() {
    let mut config = fixture();
    config.rule_groups[0].rules.extend([
        rule("same", "domain", "example.com", "direct"),
        rule("different", "domain", "example.com", "proxy"),
        rule("private", "ip_cidr", "10.0.0.0/8", "direct"),
        rule("private-v6", "ip_cidr", "fc00::/7", "direct"),
    ]);
    config.rule_groups[1]
        .rules
        .push(rule("shared", "domain", "example.com", "direct"));
    assert_eq!(config.deduplicate_rules(), 3);
    assert_eq!(config.rule_groups[0].rules.len(), 2);
    assert_eq!(config.rule_groups[1].rules.len(), 3);
    config
        .set_rule_stack(RuleStack {
            enabled_group_ids: vec!["first".into(), "second".into()],
            default_strategy: "proxy".into(),
        })
        .unwrap();
    assert_eq!(config.effective_rule_group().unwrap().rules.len(), 3);
    config.toggle_rule_group("first").unwrap();
    assert_eq!(config.effective_rule_group().unwrap().rules.len(), 3);
}

#[test]
fn legacy_empty_mode_migrates_to_one_global_fallback_and_is_idempotent() {
    let mut config = AppConfig::default_config();
    config.active_group_id = config
        .rule_groups
        .iter()
        .find(|group| group.name == "Direct Only")
        .unwrap()
        .id
        .clone();
    assert!(config.migrate_rule_stack());
    assert!(config.routing_stack().enabled_group_ids.is_empty());
    assert_eq!(config.routing_stack().default_strategy, "direct");
    assert!(!config
        .rule_groups
        .iter()
        .any(|group| group.name == "Full Proxy" || group.name == "Direct Only"));
    let before = serde_json::to_value(&config).unwrap();
    assert!(!config.migrate_rule_stack());
    assert_eq!(serde_json::to_value(&config).unwrap(), before);
}
