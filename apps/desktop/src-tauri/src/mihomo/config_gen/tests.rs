use super::*;
use crate::mihomo::profiles::{parse_body, Subscription};
use crate::storage::app_config::AppConfig;
fn subscription(id: &str) -> Subscription {
    let(f,w)=parse_body("proxies: [{name: Node, type: socks5, server: 127.0.0.1, port: 1080}]\nproxy-groups: [{name: Choice, type: select, proxies: [Node, DIRECT]}]\nrules: ['DOMAIN,example.com,Choice','MATCH,Choice']\ndns: {nameserver-policy: {'+.example.com': ['1.1.1.1']}}").unwrap();
    Subscription {
        id: id.into(),
        name: "Source".into(),
        input: "inline".into(),
        enabled: true,
        updated_at: String::new(),
        last_error: None,
        fragment: f,
        warnings: w,
    }
}
#[test]
fn generates_mihomo_reality_and_preserves_device_ws_path() {
    let node=super::super::uri_parser::parse_vless_uri("vless://123e4567-e89b-12d3-a456-426614174000@example.com:443?security=reality&pbk=public&sid=abcd&type=ws&path=%2F__pingu_device__%2Fv1%2Fopaque&host=relay.example.com#Node").unwrap();
    let p = node_proxy(&node);
    assert_eq!(p["reality-opts"]["public-key"], "public");
    assert_eq!(p["ws-opts"]["path"], "/__pingu_device__/v1/opaque");
    assert_eq!(p["ws-opts"]["headers"]["Host"], "relay.example.com");
}
#[test]
fn combines_sources_without_name_collision_or_losing_rules() {
    let mut c = AppConfig::default_config();
    c.subscriptions = vec![subscription("aaaaaaaa"), subscription("bbbbbbbb")];
    let g = c.active_rule_group().unwrap();
    let out = generate_app_config(&c, g, &[], 19090, 12080);
    let p = out["proxies"].as_array().unwrap();
    assert_ne!(p[0]["name"], p[1]["name"]);
    let groups = out["proxy-groups"].as_array().unwrap();
    assert_eq!(groups[0]["proxies"][0], p[0]["name"]);
    let rules = out["rules"].as_array().unwrap();
    assert!(rules.contains(&json!("DOMAIN,example.com,Source [aaaaaaaa] / Choice")));
    assert!(rules.contains(&json!("DOMAIN,example.com,Source [bbbbbbbb] / Choice")));
    assert_eq!(rules.last().unwrap(), "MATCH,Source [aaaaaaaa] / Choice");
    assert_eq!(out["external-controller"], "127.0.0.1:19090");
    assert_eq!(out["allow-lan"], false);
    assert!(!out["secret"].as_str().unwrap().is_empty());
}
#[test]
fn rule_namespacing_preserves_match_payloads_and_options() {
    let body = "proxies: [{name: example.com, type: socks5, server: 127.0.0.1, port: 1080}]\nrule-providers: {remote: {type: http, behavior: classical, format: yaml, url: 'https://example.net/provider'}}\nproxy-groups: [{name: Choice, type: select, proxies: [example.com]}, {name: no-resolve, type: select, proxies: [example.com]}]\nrules: ['DOMAIN,example.com,Choice', 'IP-CIDR,10.0.0.0/8,Choice,src', 'AND,((DOMAIN,example.com),(NETWORK,UDP)),Choice', 'DOMAIN-REGEX,^foo\\(bar,baz$,Choice', 'DOMAIN,literal.example,no-resolve', 'RULE-SET,remote,Choice,no-resolve', 'FINAL,Choice']";
    let (fragment, warnings) = parse_body(body).unwrap();
    let mut c = AppConfig::default_config();
    c.subscriptions.push(Subscription {
        id: "aaaaaaaa".into(),
        name: "Source A".into(),
        input: "inline".into(),
        enabled: true,
        updated_at: String::new(),
        last_error: None,
        fragment,
        warnings,
    });
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    let rules = out["rules"].as_array().unwrap();
    assert!(rules.contains(&json!(
        "DOMAIN,example.com,Source A [aaaaaaaa] / Choice"
    )));
    assert!(rules.contains(&json!(
        "IP-CIDR,10.0.0.0/8,Source A [aaaaaaaa] / Choice,src"
    )));
    assert!(rules.contains(&json!(
        "AND,((DOMAIN,example.com),(NETWORK,UDP)),Source A [aaaaaaaa] / Choice"
    )));
    assert!(rules.contains(&json!(
        "DOMAIN-REGEX,^foo\\(bar,baz$,Source A [aaaaaaaa] / Choice"
    )));
    assert!(rules.contains(&json!(
        "DOMAIN,literal.example,Source A [aaaaaaaa] / no-resolve"
    )));
    assert!(rules.contains(&json!(
        "RULE-SET,Source A [aaaaaaaa] / remote,Source A [aaaaaaaa] / Choice,no-resolve"
    )));
    assert_eq!(
        rules.last().unwrap(),
        "MATCH,Source A [aaaaaaaa] / Choice"
    );
}
#[test]
fn disabled_subscription_not_in_runtime_and_host_preferences_win() {
    let mut c = AppConfig::default_config();
    c.subscriptions = vec![subscription("enabled"), subscription("disabled")];
    c.subscriptions[1].enabled = false;
    let g = c.active_rule_group().unwrap();
    let overrides = vec![HostOverride {
        id: "h".into(),
        host: "api.example.com".into(),
        resolver_mode: "system-dns".into(),
        outbound_mode: "direct".into(),
        enabled: true,
        source: "manual".into(),
        reason: String::new(),
        updated_at: String::new(),
    }];
    let out = generate_app_config(&c, g, &overrides, 19090, 12080);
    assert_eq!(out["proxies"].as_array().unwrap().len(), 1);
    assert_eq!(
        out["dns"]["nameserver-policy"]["api.example.com"][0],
        "system"
    );
    assert_eq!(out["rules"][0], "DOMAIN,api.example.com,DIRECT");
}
#[test]
fn source_dns_does_not_override_controller_or_tun() {
    let mut c = AppConfig::default_config();
    c.subscriptions = vec![subscription("source")];
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    assert!(out.get("tun").is_none());
    assert_eq!(
        out["dns"]["nameserver-policy"]["+.example.com"][0],
        "1.1.1.1"
    );
}
/// Two independent sources with homonymous nodes, each with its own include-all variant.
fn two_sources(group_a: &str, group_b: &str) -> AppConfig {
    sources(&["HK-1", "US-1"], group_a, group_b)
}
/// Same, with caller-chosen node names so anchors can be exercised meaningfully.
fn sources(nodes: &[&str], group_a: &str, group_b: &str) -> AppConfig {
    let mut c = AppConfig::default_config();
    let proxies = nodes
        .iter()
        .enumerate()
        .map(|(i, n)| {
            format!(
                "{{name: {n}, type: socks5, server: 127.0.0.1, port: {}}}",
                1080 + i
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    for (id, name, group) in [
        ("aaaaaaaa", "Source A", group_a),
        ("bbbbbbbb", "Source B", group_b),
    ] {
        let body = format!(
            "proxies: [{proxies}]\nproxy-groups: [{group}]\nrules: ['MATCH,{name} [{}] / Choice']",
            &id[..8],
            name = name
        );
        let (fragment, warnings) = parse_body(&body).unwrap();
        c.subscriptions.push(Subscription {
            id: id.into(),
            name: name.into(),
            input: "inline".into(),
            enabled: true,
            updated_at: String::new(),
            last_error: None,
            fragment,
            warnings,
        });
    }
    c
}
fn group_members(out: &serde_json::Value, name: &str) -> Vec<String> {
    group(out, name)["proxies"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect()
        })
        .unwrap_or_default()
}
fn group(out: &serde_json::Value, name: &str) -> serde_json::Value {
    out["proxy-groups"]
        .as_array()
        .unwrap_or_else(|| panic!("no proxy-groups in {out}"))
        .iter()
        .find(|g| g["name"] == name)
        .unwrap_or_else(|| panic!("no group {name} in {out}"))
        .clone()
}
/// The recorded v1.19.31 failure: Source A's include-all group also listed Source B's node.
#[test]
fn include_all_group_stays_source_local_across_sources() {
    for variant in ["include-all: true", "include-all-proxies: true"] {
        let c = two_sources(
            &format!("{{name: Choice, type: select, {variant}}}"),
            "{name: Choice, type: select, include-all: true}",
        );
        let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
        // Membership follows the core's sorted `AllProxies` order after the source's own set.
        let a = group_members(&out, "Source A [aaaaaaaa] / Choice");
        assert_eq!(
            a,
            vec![
                "Source A [aaaaaaaa] / HK-1".to_string(),
                "Source A [aaaaaaaa] / US-1".to_string()
            ],
            "{variant}"
        );
        assert!(
            !a.iter().any(|m| m.contains("Source B")),
            "{variant} leaked another source: {a:?}"
        );
        for key in super::SOURCE_SCOPED_GROUP_KEYS {
            assert!(
                group(&out, "Source A [aaaaaaaa] / Choice")
                    .get(key)
                    .is_none(),
                "{variant} kept {key} for the core to re-expand"
            );
        }
    }
}
/// An anchored filter must keep matching after the source-prefix rename.
#[test]
fn anchored_filters_match_original_node_names() {
    let c = sources(
        &["HK-1", "Node-US"],
        "{name: Choice, type: url-test, include-all-proxies: true, filter: '^HK'}",
        "{name: Choice, type: url-test, include-all-proxies: true, filter: 'US$'}",
    );
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    // Both anchors must still bite on the original names, not the namespaced ones.
    assert_eq!(
        group_members(&out, "Source A [aaaaaaaa] / Choice"),
        vec!["Source A [aaaaaaaa] / HK-1".to_string()]
    );
    assert_eq!(
        group_members(&out, "Source B [bbbbbbbb] / Choice"),
        vec!["Source B [bbbbbbbb] / Node-US".to_string()]
    );
}
/// Case sensitivity is the pattern's business: no implicit `(?i)`, and an explicit
/// `(?i)` is still honored.
#[test]
fn filters_keep_case_sensitivity_unless_requested() {
    let c = two_sources(
        "{name: Lower, type: url-test, include-all-proxies: true, filter: '^hk'}",
        "{name: Insensitive, type: url-test, include-all-proxies: true, filter: '(?i)^hk'}",
    );
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    // `^hk` does not match `HK-1`, so the group carries the empty-fallback like the core.
    assert_eq!(
        group_members(&out, "Source A [aaaaaaaa] / Lower"),
        vec!["COMPATIBLE".to_string()]
    );
    assert_eq!(
        group_members(&out, "Source B [bbbbbbbb] / Insensitive"),
        vec!["Source B [bbbbbbbb] / HK-1".to_string()]
    );
}
#[test]
fn backtick_alternatives_and_exclude_filter_keep_their_meaning() {
    let c = two_sources(
        "{name: Pick, type: url-test, include-all-proxies: true, filter: 'US$`^HK', exclude-filter: '^US'}",
        "{name: Plain, type: url-test, include-all-proxies: true}",
    );
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    // Filter segments apply in written order (US first), then the exclusion drops it.
    assert_eq!(
        group_members(&out, "Source A [aaaaaaaa] / Pick"),
        vec!["Source A [aaaaaaaa] / HK-1".to_string()]
    );
    assert_eq!(
        group_members(&out, "Source B [bbbbbbbb] / Plain"),
        vec![
            "Source B [bbbbbbbb] / HK-1".to_string(),
            "Source B [bbbbbbbb] / US-1".to_string()
        ]
    );
}
/// Explicit references come first, exactly as the pinned parser builds the group.
#[test]
fn explicit_references_precede_include_all_matches() {
    let mut c = two_sources(
        "{name: Choice, type: select, include-all-proxies: true, filter: '^HK', proxies: [US-1, DIRECT]}",
        "{name: Choice, type: select, proxies: [US-1, REJECT]}",
    );
    c.subscriptions[0].fragment["proxy-groups"][0]["include-all-proxies"] = json!(true);
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    // `US-1` (explicit) stays ahead of the include-all match `HK-1`; built-ins keep their spelling.
    assert_eq!(
        group_members(&out, "Source A [aaaaaaaa] / Choice"),
        vec![
            "Source A [aaaaaaaa] / US-1".to_string(),
            "DIRECT".to_string(),
            "Source A [aaaaaaaa] / HK-1".to_string()
        ]
    );
    assert_eq!(
        group_members(&out, "Source B [bbbbbbbb] / Choice"),
        vec![
            "Source B [bbbbbbbb] / US-1".to_string(),
            "REJECT".to_string()
        ]
    );
}
/// An exclude filter anchored on the original name must still work after the rename.
#[test]
fn exclude_filter_applies_to_explicit_references_by_original_name() {
    let c = two_sources(
        "{name: Choice, type: url-test, include-all-proxies: true, exclude-filter: '^HK', proxies: [HK-1]}",
        "{name: Choice, type: url-test, include-all-proxies: true}",
    );
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    assert_eq!(
        group_members(&out, "Source A [aaaaaaaa] / Choice"),
        vec!["Source A [aaaaaaaa] / US-1".to_string()],
        "^HK must exclude the source-local HK-1, not the namespaced name"
    );
}
#[test]
fn include_all_variants_resolve_their_own_scope_only() {
    // include-all-proxies must not pull providers; include-all-providers must not pull proxies.
    let body = "proxies: [{name: HK-1, type: socks5, server: 127.0.0.1, port: 1080}]\nproxy-providers: {remote: {type: http, url: 'https://example.com/proxies', path: 'x.cache'}}\nproxy-groups: [{name: OnlyProxies, type: url-test, include-all-proxies: true}, {name: OnlyProviders, type: url-test, include-all-providers: true}, {name: Both, type: url-test, include-all: true}, {name: ProvidersOnly, type: url-test, include-all-providers: true, proxies: [DIRECT]}]\nrules: ['MATCH,OnlyProxies']";
    let (fragment, warnings) = parse_body(body).unwrap();
    let mut c = AppConfig::default_config();
    c.subscriptions.push(Subscription {
        id: "aaaaaaaa".into(),
        name: "Source A".into(),
        input: "inline".into(),
        enabled: true,
        updated_at: String::new(),
        last_error: None,
        fragment,
        warnings,
    });
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    assert_eq!(
        group_members(&out, "Source A [aaaaaaaa] / OnlyProxies"),
        vec!["Source A [aaaaaaaa] / HK-1".to_string()]
    );
    assert!(group(&out, "Source A [aaaaaaaa] / OnlyProxies")
        .get("use")
        .is_none());
    // Provider references must land in `use` (mapped), never in `proxies`.
    assert_eq!(
        group(&out, "Source A [aaaaaaaa] / OnlyProviders")["use"],
        json!(["Source A [aaaaaaaa] / remote"])
    );
    let only_providers = group(&out, "Source A [aaaaaaaa] / OnlyProviders");
    assert!(
        only_providers.get("proxies").is_none(),
        "include-all-providers must not create a proxy reference: {only_providers}"
    );
    let both = group(&out, "Source A [aaaaaaaa] / Both");
    assert_eq!(both["proxies"], json!(["Source A [aaaaaaaa] / HK-1"]));
    assert_eq!(both["use"], json!(["Source A [aaaaaaaa] / remote"]));
    // Explicit built-ins survive next to include-all provider membership.
    let explicit = group(&out, "Source A [aaaaaaaa] / ProvidersOnly");
    assert_eq!(explicit["proxies"], json!(["DIRECT"]));
    assert_eq!(explicit["use"], json!(["Source A [aaaaaaaa] / remote"]));
    // The resolved membership replaces the include-all flags the core would re-expand.
    for name in ["OnlyProxies", "OnlyProviders", "Both", "ProvidersOnly"] {
        for key in super::SOURCE_SCOPED_GROUP_KEYS {
            assert!(
                group(&out, &format!("Source A [aaaaaaaa] / {name}"))
                    .get(key)
                    .is_none(),
                "{name} kept {key}"
            );
        }
    }
}
#[test]
fn unnamed_provider_references_are_mapped() {
    // A plain `use:` naming a provider must be namespaced, not converted to a proxy.
    let body = "proxy-providers: {remote: {type: http, url: 'https://example.com/p', path: 'x.cache'}}\nproxy-groups: [{name: Pick, type: select, use: [remote], proxies: [DIRECT]}]\nrules: ['MATCH,Pick']";
    let (fragment, warnings) = parse_body(body).unwrap();
    let mut c = AppConfig::default_config();
    c.subscriptions.push(Subscription {
        id: "aaaaaaaa".into(),
        name: "Source A".into(),
        input: "inline".into(),
        enabled: true,
        updated_at: String::new(),
        last_error: None,
        fragment,
        warnings,
    });
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    let pick = group(&out, "Source A [aaaaaaaa] / Pick");
    assert_eq!(pick["use"], json!(["Source A [aaaaaaaa] / remote"]));
    assert_eq!(pick["proxies"], json!(["DIRECT"]));
}
/// A provider override that dials through a source-local proxy is namespaced too.
#[test]
fn provider_override_dialer_proxy_is_namespaced() {
    let body = "proxies: [{name: Hop, type: socks5, server: 127.0.0.1, port: 1080}]\nproxy-providers: {remote: {type: http, url: 'https://example.com/p', path: 'x.cache', override: {dialer-proxy: Hop}}}\nproxy-groups: [{name: Pick, type: select, use: [remote]}]\nrules: ['MATCH,Pick']";
    let (fragment, warnings) = parse_body(body).unwrap();
    let mut c = AppConfig::default_config();
    c.subscriptions.push(Subscription {
        id: "aaaaaaaa".into(),
        name: "Source A".into(),
        input: "inline".into(),
        enabled: true,
        updated_at: String::new(),
        last_error: None,
        fragment,
        warnings,
    });
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    assert_eq!(
        out["proxy-providers"]["Source A [aaaaaaaa] / remote"]["override"]["dialer-proxy"],
        "Source A [aaaaaaaa] / Hop"
    );
}
/// A saved selection must reach the core as the group's native `default-selected`, not as a
/// reordered member list: the core resolves it by name, so provider nodes (never in our list)
/// work too, and membership order is left alone.
#[test]
fn saved_selection_becomes_native_default_selected() {
    let mut c = two_sources(
        "{name: Choice, type: select, default-selected: US-1, proxies: [US-1, HK-1]}",
        "{name: Choice, type: select, default-selected: US-1, proxies: [US-1, HK-1]}",
    );
    // A saved choice for an authored group wins over its `default-selected`. Selections are
    // recorded in runtime names, which is exactly what the core will resolve.
    c.strategy_selections.insert(
        "Source A [aaaaaaaa] / Choice".into(),
        "Source A [aaaaaaaa] / HK-1".into(),
    );
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    let a = group(&out, "Source A [aaaaaaaa] / Choice");
    assert_eq!(a["default-selected"], "Source A [aaaaaaaa] / HK-1");
    // Reordering is no longer the mechanism, so membership keeps its authored order.
    assert_eq!(
        group_members(&out, "Source A [aaaaaaaa] / Choice"),
        vec![
            "Source A [aaaaaaaa] / US-1".to_string(),
            "Source A [aaaaaaaa] / HK-1".to_string()
        ]
    );
    // No saved selection: the author's own `default-selected` survives namespacing.
    assert_eq!(
        group(&out, "Source B [bbbbbbbb] / Choice")["default-selected"],
        "Source B [bbbbbbbb] / US-1"
    );
}
/// A provider node name is never in `choices`, so a saved selection naming one can only
/// round-trip as `default-selected`; the core applies its own fallback for removed choices.
#[test]
fn saved_provider_selection_is_kept_verbatim() {
    let body = "proxies: [{name: HK-1, type: socks5, server: 127.0.0.1, port: 1080}]\nproxy-providers: {remote: {type: http, url: 'https://example.com/p', path: 'x.cache'}}\nproxy-groups: [{name: Pick, type: select, use: [remote], proxies: [HK-1]}]\nrules: ['MATCH,Pick']";
    let (fragment, warnings) = parse_body(body).unwrap();
    let mut c = AppConfig::default_config();
    c.subscriptions.push(Subscription {
        id: "aaaaaaaa".into(),
        name: "Source A".into(),
        input: "inline".into(),
        enabled: true,
        updated_at: String::new(),
        last_error: None,
        fragment,
        warnings,
    });
    c.strategy_selections
        .insert("Source A [aaaaaaaa] / Pick".into(), "JP-provider".into());
    c.strategy_selections
        .insert("Pingu Proxy".into(), "HK-provider".into());
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    assert_eq!(
        group(&out, "Source A [aaaaaaaa] / Pick")["default-selected"],
        "JP-provider"
    );
    // The device selector takes the saved name as-is; a node the core no longer has is its
    // own fallback, not a silent rewrite here.
    assert_eq!(
        group(&out, "Pingu Proxy")["default-selected"],
        "HK-provider"
    );
}
/// Without a saved selection the device selector defaults to the active node, so a fresh
/// install with a manually chosen node still starts on it.
#[test]
fn device_selector_defaults_to_active_node() {
    let mut c = AppConfig::default_config();
    let node = c
        .import_node_uri(
            "vless://123e4567-e89b-12d3-a456-426614174000@example.com:443?security=tls#Device",
        )
        .unwrap();
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    assert_eq!(
        group(&out, "Pingu Proxy")["default-selected"],
        format!("{} [{}]", node.name, node.id)
    );
    // A subscription-only install has no manual default and must start on automatic.
    let c = AppConfig::default_config();
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    assert!(group(&out, "Pingu Proxy").get("default-selected").is_none());
}
/// A hand-written group (no include-all) still must not have its exclude-filter evaluated by
/// the core against namespaced names: matching happens on the original names here.
#[test]
fn explicit_exclude_filter_matches_original_names() {
    let mut c = sources(
        &["US-1", "JP-1"],
        "{name: Choice, type: select, proxies: [US-1, JP-1, DIRECT], exclude-filter: 'HK'}",
        "{name: Choice, type: select, proxies: [US-1, JP-1, DIRECT], exclude-filter: '^US'}",
    );
    c.subscriptions[0].name = "HK subscription".into();
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    // `HK` does not match either node, so the display name must not make it swallow them.
    let a = group(&out, "HK subscription [aaaaaaaa] / Choice");
    assert_eq!(
        group_members(&out, "HK subscription [aaaaaaaa] / Choice"),
        vec![
            "HK subscription [aaaaaaaa] / US-1".to_string(),
            "HK subscription [aaaaaaaa] / JP-1".to_string(),
            "DIRECT".to_string()
        ],
        "the source prefix must not make `HK` match these nodes"
    );
    assert!(
        a.get("exclude-filter").is_none(),
        "the pattern is resolved here and must not be re-run by the core against prefixed names: {a}"
    );
    // An anchored pattern that genuinely matches still excludes, on the original name.
    assert_eq!(
        group_members(&out, "Source B [bbbbbbbb] / Choice"),
        vec![
            "Source B [bbbbbbbb] / JP-1".to_string(),
            "DIRECT".to_string()
        ]
    );
    assert!(group(&out, "Source B [bbbbbbbb] / Choice")
        .get("exclude-filter")
        .is_none());
}
/// Declared limit: a hand-written group mixing a static list with providers and an
/// exclude-filter cannot keep that pattern meaningful for both, so it is refused.
#[test]
fn mixed_provider_exclude_filter_is_refused_in_both_membership_branches() {
    for (branch, group) in [
        (
            "explicit list",
            "{name: Pick, type: select, use: [remote], proxies: [HK-1], exclude-filter: '^HK'}",
        ),
        (
            "include-all",
            "{name: Pick, type: url-test, include-all: true, exclude-filter: '^HK'}",
        ),
    ] {
        let body = format!(
            "proxies: [{{name: HK-1, type: socks5, server: 127.0.0.1, port: 1080}}]\nproxy-providers: {{remote: {{type: http, url: 'https://example.com/p', path: 'x.cache'}}}}\nproxy-groups: [{group}]\nrules: ['MATCH,Pick']"
        );
        let (fragment, warnings) = parse_body(&body).unwrap();
        let mut c = AppConfig::default_config();
        c.subscriptions.push(Subscription {
            id: "aaaaaaaa".into(),
            name: "Source A".into(),
            input: "inline".into(),
            enabled: true,
            updated_at: String::new(),
            last_error: None,
            fragment,
            warnings,
        });
        let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
        let error = out["error"]
            .as_str()
            .unwrap_or_else(|| panic!("expected a {branch} boundary, got {out}"));
        assert!(
            error.contains("exclude-filter") && error.contains("proxy providers"),
            "{branch}: {error}"
        );
        assert!(out.get("proxy-groups").is_none(), "{branch}: {out}");
    }
}
/// A provider-only group keeps native filtering, so its pattern must survive untouched.
#[test]
fn provider_only_exclude_filter_stays_native() {
    let body = "proxy-providers: {remote: {type: http, url: 'https://example.com/p', path: 'x.cache'}}\nproxy-groups: [{name: Pick, type: select, use: [remote], exclude-filter: '^HK'}]\nrules: ['MATCH,Pick']";
    let (fragment, warnings) = parse_body(body).unwrap();
    let mut c = AppConfig::default_config();
    c.subscriptions.push(Subscription {
        id: "aaaaaaaa".into(),
        name: "Source A".into(),
        input: "inline".into(),
        enabled: true,
        updated_at: String::new(),
        last_error: None,
        fragment,
        warnings,
    });
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    let pick = group(&out, "Source A [aaaaaaaa] / Pick");
    assert_eq!(pick["exclude-filter"], "^HK");
    assert_eq!(pick["use"], json!(["Source A [aaaaaaaa] / remote"]));
}
/// A source-local empty-fallback/default-selected must be renamed, or the core
/// cannot resolve it at load time.
#[test]
fn source_local_group_references_are_namespaced() {
    let body = "proxies: [{name: HK-1, type: socks5, server: 127.0.0.1, port: 1080}]\nproxy-groups: [{name: Fallback, type: url-test, include-all-proxies: true, empty-fallback: HK-1}, {name: Chooser, type: select, default-selected: HK-1, proxies: [HK-1]}, {name: Empty, type: url-test, include-all-proxies: true, filter: '^NOPE$'}]\nrules: ['MATCH,Fallback']";
    let (fragment, warnings) = parse_body(body).unwrap();
    let mut c = AppConfig::default_config();
    c.subscriptions.push(Subscription {
        id: "aaaaaaaa".into(),
        name: "Source A".into(),
        input: "inline".into(),
        enabled: true,
        updated_at: String::new(),
        last_error: None,
        fragment,
        warnings,
    });
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    assert_eq!(
        group(&out, "Source A [aaaaaaaa] / Fallback")["empty-fallback"],
        "Source A [aaaaaaaa] / HK-1"
    );
    assert_eq!(
        group(&out, "Source A [aaaaaaaa] / Chooser")["default-selected"],
        "Source A [aaaaaaaa] / HK-1"
    );
    // With no declared fallback, a filter miss resolves to the core's own default
    // (COMPATIBLE) exactly as the pinned parser does, and never inherits another
    // source's nodes.
    assert_eq!(
        group_members(&out, "Source A [aaaaaaaa] / Empty"),
        vec!["COMPATIBLE".to_string()],
        "filter miss must resolve to the default empty-fallback, not another source"
    );
    // A declared fallback that names a source-local node is the one that must be renamed.
    assert_eq!(
        group(&out, "Source A [aaaaaaaa] / Fallback")["proxies"],
        json!(["Source A [aaaaaaaa] / HK-1"])
    );
}
/// Unsupported patterns must surface as an actionable error, never a silent
/// membership change (lookaround is accepted by regexp2 but not by Rust's engine,
/// so this generator cannot reproduce that membership and must say so).
#[test]
fn unsupported_filter_pattern_is_reported_not_dropped() {
    for pattern in ["(?=HK)", "(?<=HK)1"] {
        let (fragment, warnings) = parse_body(&format!(
            "proxies: [{{name: HK-1, type: socks5, server: 127.0.0.1, port: 1080}}]\nproxy-groups: [{{name: Pick, type: url-test, include-all-proxies: true, filter: '{pattern}'}}]\nrules: ['MATCH,Pick']"
        ))
        .unwrap();
        let mut c = AppConfig::default_config();
        c.subscriptions.push(Subscription {
            id: "aaaaaaaa".into(),
            name: "Source A".into(),
            input: "inline".into(),
            enabled: true,
            updated_at: String::new(),
            last_error: None,
            fragment,
            warnings,
        });
        let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
        let error = out["error"].as_str().unwrap_or_else(|| {
            panic!("expected a reported boundary for {pattern}, got {out}");
        });
        assert!(
            error.contains("unsupported filter pattern") && error.contains(pattern),
            "error must name the construct: {error}"
        );
        // No partially-generated groups could be mistaken for a valid policy.
        assert!(out.get("proxy-groups").is_none());
    }
    // A construct both engines accept is still valid, even when it matches nothing.
    let (fragment, warnings) = parse_body("proxies: [{name: HK-1, type: socks5, server: 127.0.0.1, port: 1080}]\nproxy-groups: [{name: Pick, type: url-test, include-all-proxies: true, filter: '^NOPE$'}]\nrules: ['MATCH,Pick']").unwrap();
    let mut c = AppConfig::default_config();
    c.subscriptions.push(Subscription {
        id: "aaaaaaaa".into(),
        name: "Source A".into(),
        input: "inline".into(),
        enabled: true,
        updated_at: String::new(),
        last_error: None,
        fragment,
        warnings,
    });
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    assert!(out.get("error").is_none(), "{out}");
}
/// Declared compatibility limit: a group mixing include-all static proxies with
/// providers plus an exclude-filter cannot keep that pattern meaningful for both the
/// flattened static list and the natively-filtered providers, so it is refused instead
/// of silently broadening membership.
/// The same mixed shape without an exclude-filter is supported: static members are
/// resolved here, providers keep native filtering.
#[test]
fn mixed_static_and_provider_filter_is_supported() {
    let body = "proxies: [{name: HK-1, type: socks5, server: 127.0.0.1, port: 1080}, {name: US-1, type: socks5, server: 127.0.0.1, port: 1081}]\nproxy-providers: {remote: {type: http, url: 'https://example.com/p', path: 'x.cache'}}\nproxy-groups: [{name: Pick, type: url-test, include-all: true, filter: '^HK'}]\nrules: ['MATCH,Pick']";
    let (fragment, warnings) = parse_body(body).unwrap();
    let mut c = AppConfig::default_config();
    c.subscriptions.push(Subscription {
        id: "aaaaaaaa".into(),
        name: "Source A".into(),
        input: "inline".into(),
        enabled: true,
        updated_at: String::new(),
        last_error: None,
        fragment,
        warnings,
    });
    let out = generate_app_config(&c, c.active_rule_group().unwrap(), &[], 19090, 12080);
    let pick = group(&out, "Source A [aaaaaaaa] / Pick");
    // Static membership is resolved on original names; providers stay native, so the
    // pattern must survive for them.
    assert_eq!(pick["proxies"], json!(["Source A [aaaaaaaa] / HK-1"]));
    assert_eq!(pick["use"], json!(["Source A [aaaaaaaa] / remote"]));
    assert_eq!(pick["filter"], "^HK");
}
