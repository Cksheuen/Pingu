use super::*;

fn fixture() -> AppConfig {
    let mut config = AppConfig::default_config();
    let mut subscription: crate::mihomo::profiles::Subscription = serde_json::from_value(json!({
        "id":"source-a", "name":"Personal", "input":"", "enabled":true, "nodes_only":true,
        "updated_at":"", "last_error":null, "warnings":[],
        "fragment":{"proxies":[{"name":"VPS", "type":"vless", "server":"vps.example.com", "port":443,
            "uuid":"45ce0a2f-3a3a-4e9d-a20e-caa9ac1c5204", "tls":true,"network":"ws",
            "ws-opts":{"path":"/device-secret"}}]}
    })).unwrap();
    subscription.nodes_only = true;
    config.subscriptions.push(subscription);
    config
        .strategy_selections
        .insert("Pingu Proxy".into(), "Personal [source-a] / VPS".into());
    config
}

fn selected() -> SelectedEgress {
    SelectedEgress {
        id: "8befbc41-388b-46c4-926c-7bbc2deff693".into(),
        proxy_name: "Personal [source-a] / VPS".into(),
        server: "vps.example.com".into(),
        uuid: "2b3f1792-7a14-4637-8b54-44f20d99e273".into(),
    }
}

#[test]
fn selected_exit_changes_only_its_vless_identity_and_keeps_fixed_listener() {
    let mut config = fixture();
    let original = crate::mihomo::config_gen::try_generate_app_config(
        &config,
        config.active_rule_group().unwrap(),
        &[],
        19090,
        2080,
    )
    .unwrap();
    config.vps_egress.selected = Some(selected());
    let changed = crate::mihomo::config_gen::try_generate_app_config(
        &config,
        config.active_rule_group().unwrap(),
        &[],
        19090,
        2080,
    )
    .unwrap();
    let mut expected = original.clone();
    expected["proxies"][0]["uuid"] = json!(selected().uuid);
    expected["pingu-vps-egress"] = json!("cloudflare");
    assert_eq!(changed, expected);
    assert_eq!(
        selected_proxy(&config).unwrap(),
        (selected().proxy_name, selected().server)
    );
    config.vps_egress.selected = None;
    assert_eq!(
        crate::mihomo::config_gen::try_generate_app_config(
            &config,
            config.active_rule_group().unwrap(),
            &[],
            19090,
            2080
        )
        .unwrap(),
        original
    );
}

#[test]
fn changing_to_another_server_cannot_reuse_the_cloudflare_credential() {
    let mut config = fixture();
    config.vps_egress.selected = Some(selected());
    config.subscriptions[0].fragment["proxies"][0]["server"] = json!("other.example.com");
    assert!(crate::mihomo::config_gen::try_generate_app_config(
        &config,
        config.active_rule_group().unwrap(),
        &[],
        19090,
        2080
    )
    .unwrap_err()
    .contains("direct exit"));
    config
        .strategy_selections
        .insert("Pingu Proxy".into(), "Pingu Auto".into());
    assert!(selected_proxy(&config).is_err());
}

#[test]
fn ssh_target_cannot_inject_flags_or_remote_commands() {
    let mut management = Management {
        target: "root@203.0.113.10".into(),
        ssh_config: "".into(),
        proxy_server: "vps.example.com".into(),
    };
    assert!(management.validate().is_ok());
    assert_eq!(
        ssh_arguments(&management).last().unwrap(),
        "/usr/local/sbin/pingu-egress --json"
    );
    for target in [
        "-oProxyCommand=anything",
        "root@host command",
        "host;command",
        "host\nother",
    ] {
        management.target = target.into();
        assert!(management.validate().is_err());
    }
}

#[test]
fn management_response_does_not_expose_credentials_to_the_webview() {
    let reply = parse_reply(
        serde_json::to_string(&json!({"ok":true,"version":2,"installed":true,"exits":[{
            "id":selected().id,
            "name":"Cloudflare", "uuid":selected().uuid, "phase":"ready", "ready":true,
            "ip":"192.0.2.2", "error":null
        }]}))
        .unwrap()
        .as_bytes(),
        true,
    )
    .unwrap();
    let exit = reply.exits.into_iter().next().unwrap();
    assert_eq!(exit.uuid, selected().uuid);
    assert!(serde_json::to_value(exit).unwrap().get("uuid").is_none());
    assert!(
        parse_reply(br#"{"ok":false,"error":"ownership changed"}"#, false)
            .unwrap_err()
            .contains("ownership")
    );
}

#[test]
fn exit_ids_survive_selection_and_legacy_configs_keep_their_identity() {
    let mut config = fixture();
    config.vps_egress.selected = Some(selected());
    assert_eq!(state(&config, false).selected, selected().id);
    let mut old = serde_json::to_value(selected()).unwrap();
    old.as_object_mut().unwrap().remove("id");
    let migrated: SelectedEgress = serde_json::from_value(old).unwrap();
    assert_eq!(migrated.id, "legacy");
    assert_eq!(migrated.uuid, selected().uuid);
    assert!(parse_reply(br#"{"ok":true,"installed":true,"cloudflare":null}"#, true).is_err());
}

#[test]
fn older_config_has_no_implicit_remote_management_or_route_change() {
    let config = fixture();
    let mut stored = serde_json::to_value(config).unwrap();
    stored.as_object_mut().unwrap().remove("vps_egress");
    let restored: AppConfig = serde_json::from_value(stored).unwrap();
    assert!(restored.vps_egress.management.is_none());
    assert!(restored.vps_egress.selected.is_none());
}

#[test]
fn reachable_ip_alone_does_not_pass_cloudflare_exit_verification() {
    assert!(verify_trace("ip=192.0.2.10\nwarp=off\n").is_err());
    assert!(verify_trace("ip=not-an-ip\nwarp=on\n").is_err());
    assert!(verify_trace("ip=192.0.2.22\nwarp=on\n").is_ok());
}
