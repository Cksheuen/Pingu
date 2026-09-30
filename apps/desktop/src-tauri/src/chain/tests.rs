use super::*;
fn fixture() -> AppConfig {
    let mut c = AppConfig::default_config();
    c.nodes.push(crate::mihomo::uri_parser::Node {
        id: "own".into(),
        name: "VPS".into(),
        address: "192.0.2.10".into(),
        port: 8443,
        uuid: "example-only".into(),
        security: "reality".into(),
        transport: "tcp".into(),
        ..Default::default()
    });
    c.active_node_id = Some("own".into());
    c.subscriptions.push(crate::mihomo::profiles::Subscription { nodes_only: false, id:"source".into(), name:"Airport".into(), input:"private".into(), enabled:true, updated_at:"".into(), last_error:None, warnings:vec![], fragment:json!({"proxies":[{"name":"Taiwan","type":"ss","server":"192.0.2.20","port":443,"cipher":"aes-128-gcm","password":"example-only","udp":true}]}) });
    c.proxy_chain = ChainSettings {
        enabled: true,
        entry: Some(NodeRef::Subscription {
            subscription_id: "source".into(),
            proxy_name: "Taiwan".into(),
        }),
        exit: Some(NodeRef::Manual {
            node_id: "own".into(),
        }),
    };
    c
}
#[test]
fn chain_order_is_encoded_on_exit_and_sources_remain_unchanged() {
    let c = fixture();
    let before = c.subscriptions[0].fragment.clone();
    let mut v = json!({"proxies":[{"name":"original"}],"proxy-groups":[{"name":"Pingu Proxy"}],"rules":["DOMAIN,example.com,Pingu Proxy","IP-CIDR,10.0.0.0/8,DIRECT,no-resolve","DOMAIN,ads.example,REJECT","MATCH,Pingu Proxy"]});
    apply(&c, &mut v).unwrap();
    assert_eq!(v["proxies"][1]["server"], "192.0.2.20");
    assert_eq!(v["proxies"][2]["server"], "192.0.2.10");
    assert_eq!(v["proxies"][2]["dialer-proxy"], ENTRY);
    assert!(v["proxies"][1].get("dialer-proxy").is_none());
    assert_eq!(
        v["rules"],
        json!([
            "DOMAIN,example.com,Pingu Chain Route",
            "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
            "DOMAIN,ads.example,REJECT",
            "MATCH,Pingu Chain Route"
        ])
    );
    assert_eq!(before, c.subscriptions[0].fragment);
}
#[test]
fn missing_disabled_and_recursive_choices_fail_closed() {
    let mut c = fixture();
    c.subscriptions[0].enabled = false;
    assert!(pair(&c, &c.proxy_chain).is_err());
    c.subscriptions[0].enabled = true;
    c.subscriptions[0].fragment["proxies"][0]["dialer-proxy"] = json!("already-chained");
    assert!(pair(&c, &c.proxy_chain).is_err());
    c.proxy_chain.entry = c.proxy_chain.exit.clone();
    assert!(pair(&c, &c.proxy_chain).is_err());
}
#[test]
fn rename_source_keeps_reference_and_refresh_removal_is_detected() {
    let mut c = fixture();
    c.subscriptions[0].name = "Renamed".into();
    assert!(pair(&c, &c.proxy_chain).is_ok());
    c.subscriptions[0].fragment["proxies"] = json!([]);
    assert!(pair(&c, &c.proxy_chain).is_err());
}
#[test]
fn udp_exit_requires_capable_entry() {
    let mut c = fixture();
    c.subscriptions[0].fragment["proxies"][0]["type"] = json!("hysteria2");
    std::mem::swap(&mut c.proxy_chain.entry, &mut c.proxy_chain.exit);
    // A VLESS entry with UDP enabled can carry a QUIC exit.
    assert!(pair(&c, &c.proxy_chain).is_ok());
    let (mut a, b) = pair(&c, &c.proxy_chain).unwrap();
    a["type"] = json!("http");
    a["name"] = json!("HTTP");
    c.subscriptions[0].fragment["proxies"]
        .as_array_mut()
        .unwrap()
        .push(a);
    c.proxy_chain.entry = Some(NodeRef::Subscription {
        subscription_id: "source".into(),
        proxy_name: "HTTP".into(),
    });
    assert_eq!(b["type"], "hysteria2");
    assert!(pair(&c, &c.proxy_chain).is_err());
}
#[test]
fn only_personal_reality_exit_requests_gate() {
    let mut c = fixture();
    assert!(exit_needs_gate(&c, &c.proxy_chain));
    std::mem::swap(&mut c.proxy_chain.entry, &mut c.proxy_chain.exit);
    assert!(!exit_needs_gate(&c, &c.proxy_chain));
}
#[test]
fn full_generated_configuration_routes_proxy_rules_through_chain() {
    let c = fixture();
    let mut group = c.active_rule_group().unwrap().clone();
    group.rules.clear();
    let v = crate::mihomo::config_gen::try_generate_app_config(&c, &group, &[], 0, 0).unwrap();
    assert_eq!(
        v["rules"].as_array().unwrap().last().unwrap(),
        "MATCH,Pingu Chain Route"
    );
    assert_eq!(
        v["proxies"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["name"] == EXIT)
            .count(),
        1
    );
}
#[test]
fn node_only_subscription_does_not_take_over_single_hop_routing_or_dns() {
    let mut c = fixture();
    c.proxy_chain.enabled = false;
    c.subscriptions[0].nodes_only = true;
    c.subscriptions[0].fragment["rules"] = json!(["MATCH,Taiwan"]);
    c.subscriptions[0].fragment["dns"] = json!({"nameserver":["192.0.2.1"]});
    let mut group = c.active_rule_group().unwrap().clone();
    group.rules.clear();
    let v = crate::mihomo::config_gen::try_generate_app_config(&c, &group, &[], 0, 0).unwrap();
    assert_eq!(
        v["rules"].as_array().unwrap().last().unwrap(),
        "MATCH,Pingu Proxy"
    );
    assert_ne!(v["dns"]["nameserver"], json!(["192.0.2.1"]));
    assert_eq!(
        c.subscriptions[0].fragment["rules"],
        json!(["MATCH,Taiwan"])
    );
}

#[test]
fn fallback_has_independent_nodes_and_never_falls_through_to_direct() {
    let c = fixture();
    let mut v = json!({"proxies":[], "proxy-groups":[], "rules":[], "rule-providers":{"geo":{"proxy":"Pingu Proxy"}}});
    v["proxy-groups"] = json!([{"name":"Pingu Proxy"}]);
    apply(&c, &mut v).unwrap();
    let group = v["proxy-groups"].as_array().unwrap().last().unwrap();
    assert_eq!(group["proxies"], json!([EXIT, SINGLE_EXIT, ENTRY]));
    assert_eq!(group["lazy"], false);
    assert_eq!(v["proxies"][2]["server"], "192.0.2.10");
    assert!(v["proxies"][2].get("dialer-proxy").is_none());
    assert_eq!(v["rule-providers"]["geo"]["proxy"], ROUTE);
}
#[test]
fn runtime_distinguishes_health_pending_fallback_and_all_dead() {
    let mut body = json!({"proxies":{ROUTE:{"now":EXIT}, EXIT:{"alive":true}}});
    assert_eq!(runtime_route(&body).route, "checking");
    for (name, route) in [(EXIT, "chain"), (SINGLE_EXIT, "exit"), (ENTRY, "entry")] {
        body["proxies"][ROUTE]["now"] = json!(name);
        body["proxies"][name] = json!({"extra":{HEALTH_URL:{"alive":true,"history":[{"time":"2026-09-26T12:00:00Z","delay":50}]}}});
        assert_eq!(runtime_route(&body).route, route);
    }
    body["proxies"][ROUTE]["now"] = json!(EXIT);
    body["proxies"][EXIT]["extra"][HEALTH_URL]["alive"] = json!(false);
    assert_eq!(runtime_route(&body).route, "unavailable");
}

#[test]
fn no_gain_clears_entry_and_selects_the_exact_standalone_exit() {
    let mut c = fixture();
    let exit = c.proxy_chain.exit.clone().unwrap();
    use_single_exit(&mut c, exit).unwrap();
    assert!(!c.proxy_chain.enabled);
    assert!(c.proxy_chain.entry.is_none());
    let group = c.active_rule_group().unwrap();
    let v = crate::mihomo::config_gen::try_generate_app_config(&c, group, &[], 0, 0).unwrap();
    let selector = v["proxy-groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == "Pingu Proxy")
        .unwrap();
    assert_eq!(selector["default-selected"], "VPS [own]");
    let exit = NodeRef::Subscription {
        subscription_id: "source".into(),
        proxy_name: "Taiwan".into(),
    };
    use_single_exit(&mut c, exit).unwrap();
    let v = crate::mihomo::config_gen::try_generate_app_config(
        &c,
        c.active_rule_group().unwrap(),
        &[],
        0,
        0,
    )
    .unwrap();
    let selector = v["proxy-groups"]
        .as_array()
        .unwrap()
        .iter()
        .find(|g| g["name"] == "Pingu Proxy")
        .unwrap();
    assert!(selector["proxies"]
        .as_array()
        .unwrap()
        .contains(&selector["default-selected"]));
    assert_eq!(selector["default-selected"], "Airport [source] / Taiwan");
}
