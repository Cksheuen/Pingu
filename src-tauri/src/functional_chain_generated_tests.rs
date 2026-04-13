use crate::proxy_runtime::{build_proxy_status, proxy_info, resolve_runtime_selection};
use crate::singbox::config_gen::{Rule, RuleGroup};
use crate::singbox::process::SingBoxProcess;
use crate::singbox::uri_parser::Node;
use crate::storage::app_config::AppConfig;

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

fn sample_group(id: &str, name: &str, default_strategy: &str) -> RuleGroup {
    RuleGroup {
        id: id.to_string(),
        name: name.to_string(),
        rules: vec![],
        default_strategy: default_strategy.to_string(),
        fake_ip_filter: vec![],
        nameserver_policy: vec![],
    }
}

fn sample_rule(id: &str, rule_type: &str, match_value: &str, outbound: &str) -> Rule {
    Rule {
        id: id.to_string(),
        rule_type: rule_type.to_string(),
        match_value: match_value.to_string(),
        outbound: outbound.to_string(),
    }
}

#[test]
fn generated_mc01_full_stability_chain_covers_runtime_lifecycle() {
    let default_group = sample_group("group-default", "Default", "proxy");
    let mut config = AppConfig {
        nodes: vec![],
        active_node_id: None,
        rule_groups: vec![default_group],
        active_group_id: "group-default".to_string(),
        host_overrides: vec![],
    };

    // SC-01: 空态启动
    assert!(config.nodes.is_empty());
    assert!(config.active_node_id.is_none());
    let disconnected = build_proxy_status(
        &config,
        false,
        99,
        Some("stale-node".to_string()),
        Some("stale-group".to_string()),
    );
    assert!(!disconnected.connected);
    assert_eq!(disconnected.uptime_seconds, 0);
    assert!(disconnected.active_node_id.is_none());
    assert!(disconnected.active_group_id.is_none());

    // SC-02: 节点接入
    let node_1 = config.add_node(sample_node("node-1", "Node 1"));
    assert_eq!(config.active_node_id.as_deref(), Some(node_1.id.as_str()));
    assert_eq!(config.nodes.len(), 1);

    // SC-03 + SC-04: 创建规则组并补基础规则
    let work_group = config.create_rule_group("Work".to_string());
    config.set_active_group(&work_group.id).unwrap();
    config
        .add_rule_to_active_group(sample_rule("", "geosite", "geolocation-cn", "direct"))
        .unwrap();
    config
        .add_rule_to_active_group(sample_rule("", "domain_suffix", "example.com", "proxy"))
        .unwrap();
    config
        .add_rule_to_active_group(sample_rule("", "ip_is_private", "true", "direct"))
        .unwrap();
    config.set_active_group_default_strategy("direct").unwrap();

    let selection = resolve_runtime_selection(&config).unwrap();
    assert_eq!(selection.node.id, "node-1");
    assert_eq!(selection.rule_group.id, work_group.id);
    assert_eq!(selection.rule_group.default_strategy, "direct");
    assert_eq!(selection.rule_group.rules.len(), 3);

    // SC-05: 首次连接后的 contract
    let connected = build_proxy_status(
        &config,
        true,
        42,
        config.active_node_id.clone(),
        Some(config.active_group_id.clone()),
    );
    assert!(connected.connected);
    assert_eq!(connected.active_node_id.as_deref(), Some("node-1"));
    assert_eq!(
        connected.active_group_id.as_deref(),
        Some(work_group.id.as_str())
    );
    assert_eq!(connected.active_group_name.as_deref(), Some("Work"));
    assert_eq!(connected.uptime_seconds, 42);

    let info = proxy_info();
    assert_eq!(info.listen_host, "127.0.0.1");
    assert_eq!(info.listen_port, 2080);
    assert_eq!(info.http_proxy, "http://127.0.0.1:2080");
    assert_eq!(info.socks_proxy, "socks5://127.0.0.1:2080");
    assert_eq!(info.terminal_commands.len(), 3);

    // SC-10: 日志运维
    let process = SingBoxProcess::new();
    process.add_log("info", "connected");
    process.add_log("warn", "reloading");
    assert_eq!(process.get_logs().len(), 2);
    process.clear_logs();
    assert!(process.get_logs().is_empty());

    // SC-06: 在线切换节点
    config.add_node(sample_node("node-2", "Node 2"));
    config.set_active_node("node-2").unwrap();
    let switched_node = resolve_runtime_selection(&config).unwrap();
    assert_eq!(switched_node.node.id, "node-2");
    let connected_after_node_switch = build_proxy_status(
        &config,
        true,
        84,
        config.active_node_id.clone(),
        Some(config.active_group_id.clone()),
    );
    assert_eq!(
        connected_after_node_switch.active_node_id.as_deref(),
        Some("node-2")
    );
    assert_eq!(
        connected_after_node_switch.active_group_name.as_deref(),
        Some("Work")
    );

    // SC-07 + SC-08 + SC-09: 在线切换规则组、增删规则、改默认策略
    let travel_group = config.create_rule_group("Travel".to_string());
    config.set_active_group(&travel_group.id).unwrap();
    config
        .add_rule_to_active_group(sample_rule("", "domain", "api.example.com", "proxy"))
        .unwrap();
    let temp_rule = config
        .add_rule_to_active_group(sample_rule("", "geoip", "cn", "direct"))
        .unwrap();
    config.delete_rule_from_active_group(&temp_rule.id).unwrap();
    config.set_active_group_default_strategy("proxy").unwrap();

    let switched_group = resolve_runtime_selection(&config).unwrap();
    assert_eq!(switched_group.rule_group.id, travel_group.id);
    assert_eq!(switched_group.rule_group.name, "Travel");
    assert_eq!(switched_group.rule_group.default_strategy, "proxy");
    assert_eq!(switched_group.rule_group.rules.len(), 1);

    // SC-11: 断开回收
    let disconnected_again = build_proxy_status(
        &config,
        false,
        123,
        config.active_node_id.clone(),
        Some(config.active_group_id.clone()),
    );
    assert!(!disconnected_again.connected);
    assert!(disconnected_again.active_group_id.is_none());
    assert!(disconnected_again.active_node_id.is_none());

    // SC-12: 重启恢复
    let reopened = config.clone();
    assert_eq!(reopened.active_node_id.as_deref(), Some("node-2"));
    assert_eq!(reopened.active_group_id, travel_group.id);
    let reopened_selection = resolve_runtime_selection(&reopened).unwrap();
    assert_eq!(reopened_selection.node.id, "node-2");
    assert_eq!(reopened_selection.rule_group.name, "Travel");
}

#[test]
fn generated_mc02_recovery_chain_recovers_after_invalid_inputs_and_missing_prerequisites() {
    let mut empty_config = AppConfig {
        nodes: vec![],
        active_node_id: None,
        rule_groups: vec![sample_group("group-default", "Default", "proxy")],
        active_group_id: "group-default".to_string(),
        host_overrides: vec![],
    };

    // U-030: 缺失 active node
    let no_node_error = resolve_runtime_selection(&empty_config).unwrap_err();
    assert_eq!(no_node_error, "No active node selected");

    // U-004: 非法 URI
    assert!(empty_config.import_node_uri("not-a-vless-uri").is_err());

    // U-003 + U-006: 修正节点配置
    empty_config.add_node(sample_node("node-1", "Recovered Node"));
    empty_config.set_active_node("node-1").unwrap();

    // U-031: 缺失 active group
    let mut no_group_config = AppConfig {
        nodes: empty_config.nodes.clone(),
        active_node_id: empty_config.active_node_id.clone(),
        rule_groups: vec![],
        active_group_id: String::new(),
        host_overrides: vec![],
    };
    let no_group_error = resolve_runtime_selection(&no_group_config).unwrap_err();
    assert_eq!(no_group_error, "Active group not found");

    // SC-03 + SC-04 + U-044: 修正规则组并恢复连接
    let recovered_group = no_group_config.create_rule_group("Recovered".to_string());
    no_group_config
        .set_active_group(&recovered_group.id)
        .unwrap();
    no_group_config
        .add_rule_to_active_group(sample_rule("", "geosite", "geolocation-cn", "direct"))
        .unwrap();
    no_group_config
        .add_rule_to_active_group(sample_rule("", "domain_suffix", "example.com", "proxy"))
        .unwrap();
    no_group_config
        .add_rule_to_active_group(sample_rule("", "ip_is_private", "true", "direct"))
        .unwrap();
    no_group_config
        .set_active_group_default_strategy("direct")
        .unwrap();

    let selection = resolve_runtime_selection(&no_group_config).unwrap();
    assert_eq!(selection.node.id, "node-1");
    assert_eq!(selection.rule_group.name, "Recovered");

    let recovered_status = build_proxy_status(
        &no_group_config,
        true,
        7,
        no_group_config.active_node_id.clone(),
        Some(no_group_config.active_group_id.clone()),
    );
    assert!(recovered_status.connected);
    assert_eq!(
        recovered_status.active_group_name.as_deref(),
        Some("Recovered")
    );

    let process = SingBoxProcess::new();
    process.add_log("info", "recovered");
    assert_eq!(process.get_logs().len(), 1);
    process.clear_logs();
    assert!(process.get_logs().is_empty());

    let final_status = build_proxy_status(
        &no_group_config,
        false,
        8,
        no_group_config.active_node_id.clone(),
        Some(no_group_config.active_group_id.clone()),
    );
    assert!(!final_status.connected);
}

#[test]
fn generated_mc03_incremental_configuration_chain_handles_active_resource_reassignment() {
    let mut config = AppConfig {
        nodes: vec![],
        active_node_id: None,
        rule_groups: vec![
            sample_group("group-default", "Default", "proxy"),
            sample_group("group-direct", "Direct Only", "direct"),
        ],
        active_group_id: "group-default".to_string(),
        host_overrides: vec![],
    };

    // SC-02 + 增量节点扩展
    config.add_node(sample_node("node-1", "Node 1"));
    config.add_node(sample_node("node-2", "Node 2"));
    config.set_active_node("node-2").unwrap();
    assert_eq!(config.active_node_id.as_deref(), Some("node-2"));

    // SC-03 + 多规则组扩展
    let work_group = config.create_rule_group("Work".to_string());
    let travel_group = config.create_rule_group("Travel".to_string());
    config.set_active_group(&travel_group.id).unwrap();

    // MC-03: 多规则类型和策略
    config
        .add_rule_to_active_group(sample_rule("", "geosite", "geolocation-cn", "direct"))
        .unwrap();
    config
        .add_rule_to_active_group(sample_rule("", "geoip", "cn", "direct"))
        .unwrap();
    config
        .add_rule_to_active_group(sample_rule("", "domain", "api.example.com", "proxy"))
        .unwrap();
    let cidr_rule = config
        .add_rule_to_active_group(sample_rule("", "ip_cidr", "10.0.0.0/8", "proxy"))
        .unwrap();
    config.set_active_group_default_strategy("proxy").unwrap();

    let initial_selection = resolve_runtime_selection(&config).unwrap();
    assert_eq!(initial_selection.node.id, "node-2");
    assert_eq!(initial_selection.rule_group.id, travel_group.id);
    assert_eq!(initial_selection.rule_group.rules.len(), 4);

    // 在线切换节点和规则组
    config.set_active_node("node-1").unwrap();
    config.set_active_group(&work_group.id).unwrap();
    config
        .add_rule_to_active_group(sample_rule(
            "",
            "domain_suffix",
            "corp.example.com",
            "proxy",
        ))
        .unwrap();
    config.set_active_group_default_strategy("direct").unwrap();

    let switched_selection = resolve_runtime_selection(&config).unwrap();
    assert_eq!(switched_selection.node.id, "node-1");
    assert_eq!(switched_selection.rule_group.id, work_group.id);
    assert_eq!(switched_selection.rule_group.default_strategy, "direct");

    let connected_status = build_proxy_status(
        &config,
        true,
        21,
        config.active_node_id.clone(),
        Some(config.active_group_id.clone()),
    );
    assert!(connected_status.connected);
    assert_eq!(connected_status.active_node_id.as_deref(), Some("node-1"));
    assert_eq!(connected_status.active_group_name.as_deref(), Some("Work"));

    // 删除规则、active group、active node，验证回退
    config.set_active_group(&travel_group.id).unwrap();
    config.delete_rule_from_active_group(&cidr_rule.id).unwrap();
    assert_eq!(config.list_rules().unwrap().len(), 3);

    config.delete_rule_group(&travel_group.id).unwrap();
    assert_ne!(config.active_group_id, travel_group.id);
    assert!(config
        .rule_groups
        .iter()
        .all(|group| group.id != travel_group.id));

    config.delete_node("node-1");
    assert_eq!(config.active_node_id.as_deref(), Some("node-2"));
    assert_eq!(config.nodes.len(), 1);

    // 重启恢复
    let reopened = config.clone();
    assert_eq!(reopened.active_node_id.as_deref(), Some("node-2"));
    let reopened_selection = resolve_runtime_selection(&reopened).unwrap();
    assert_eq!(reopened_selection.node.id, "node-2");
    assert_ne!(reopened_selection.rule_group.id, travel_group.id);
}
