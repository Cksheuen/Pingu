use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::uri_parser::Node;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    pub rule_type: String,
    pub match_value: String,
    pub outbound: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleGroup {
    pub id: String,
    pub name: String,
    pub rules: Vec<Rule>,
    pub default_strategy: String,
    #[serde(default)]
    pub fake_ip_filter: Vec<String>,
    #[serde(default)]
    pub nameserver_policy: Vec<NameServerPolicy>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NameServerPolicy {
    pub domain_suffix: String,
    pub server: String,
}

pub fn generate_config(active_node: &Node, rule_group: &RuleGroup, cache_file_path: &str) -> Value {
    let mut route_rules: Vec<Value> = Vec::new();
    let mut rule_sets: Vec<Value> = Vec::new();
    let mut seen_rule_sets = std::collections::HashSet::new();
    let mut dns_servers: Vec<Value> = vec![
        json!({
            "type": "udp",
            "tag": "remote-dns",
            "server": "8.8.8.8",
            "server_port": 53,
            "detour": "proxy"
        }),
        json!({
            "type": "udp",
            "tag": "local-dns",
            "server": "223.5.5.5",
            "server_port": 53
        }),
    ];
    let mut dns_rules: Vec<Value> = Vec::new();
    let mut dns_server_tags = std::collections::HashMap::from([
        ("8.8.8.8".to_string(), "remote-dns".to_string()),
        ("223.5.5.5".to_string(), "local-dns".to_string()),
    ]);

    // Built-in route rules (before user rules)
    route_rules.push(json!({ "protocol": "dns", "action": "hijack-dns" }));
    route_rules.push(json!({ "action": "route", "ip_is_private": true, "outbound": "direct" }));

    // Built-in rule_sets required for DNS split
    let builtin_rule_sets = [
        (
            "geosite-geolocation-cn",
            "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-cn.srs",
        ),
        (
            "geosite-geolocation-!cn",
            "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-geolocation-!cn.srs",
        ),
        (
            "geoip-cn",
            "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-cn.srs",
        ),
    ];
    for (tag, url) in &builtin_rule_sets {
        seen_rule_sets.insert(tag.to_string());
        rule_sets.push(json!({
            "type": "remote",
            "tag": tag,
            "format": "binary",
            "url": url,
            "download_detour": "proxy"
        }));
    }

    for policy in &rule_group.nameserver_policy {
        let normalized_suffix = normalize_domain_suffix(&policy.domain_suffix);
        if normalized_suffix.is_empty() {
            continue;
        }
        let server_tag = if let Some(existing_tag) = dns_server_tags.get(&policy.server) {
            existing_tag.clone()
        } else {
            let next_tag = format!("policy-dns-{}", dns_server_tags.len());
            dns_server_tags.insert(policy.server.clone(), next_tag.clone());
            dns_servers.push(json!({
                "type": "udp",
                "tag": next_tag,
                "server": &policy.server,
                "server_port": 53
            }));
            dns_server_tags
                .get(&policy.server)
                .cloned()
                .unwrap_or_default()
        };
        dns_rules.push(json!({
            "action": "route",
            "domain_suffix": [normalized_suffix],
            "server": server_tag
        }));
    }

    dns_rules.push(json!({
        "action": "route",
        "rule_set": "geosite-geolocation-cn",
        "server": "local-dns"
    }));
    dns_rules.push(json!({
        "type": "logical",
        "mode": "and",
        "action": "route",
        "rules": [
            { "rule_set": "geosite-geolocation-!cn", "invert": true },
            { "rule_set": "geoip-cn" }
        ],
        "server": "local-dns"
    }));

    // User rules
    for rule in &rule_group.rules {
        match rule.rule_type.as_str() {
            "geosite" => {
                let Some(match_value) = sanitize_rule_set_value(&rule.match_value) else {
                    continue;
                };
                let tag = format!("geosite-{}", match_value);
                route_rules.push(json!({
                    "action": "route",
                    "rule_set": [&tag],
                    "outbound": &rule.outbound
                }));
                if seen_rule_sets.insert(tag.clone()) {
                    rule_sets.push(json!({
                        "type": "remote",
                        "tag": &tag,
                        "format": "binary",
                        "url": format!(
                            "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-{}.srs",
                            match_value
                        ),
                        "download_detour": "proxy"
                    }));
                }
            }
            "geoip" => {
                let Some(match_value) = sanitize_rule_set_value(&rule.match_value) else {
                    continue;
                };
                let tag = format!("geoip-{}", match_value);
                route_rules.push(json!({
                    "action": "route",
                    "rule_set": [&tag],
                    "outbound": &rule.outbound
                }));
                if seen_rule_sets.insert(tag.clone()) {
                    rule_sets.push(json!({
                        "type": "remote",
                        "tag": &tag,
                        "format": "binary",
                        "url": format!(
                            "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/geoip-{}.srs",
                            match_value
                        ),
                        "download_detour": "proxy"
                    }));
                }
            }
            "domain_suffix" => {
                route_rules.push(json!({
                    "action": "route",
                    "domain_suffix": [&rule.match_value],
                    "outbound": &rule.outbound
                }));
            }
            "domain" => {
                route_rules.push(json!({
                    "action": "route",
                    "domain": [&rule.match_value],
                    "outbound": &rule.outbound
                }));
            }
            "ip_cidr" => {
                route_rules.push(json!({
                    "action": "route",
                    "ip_cidr": [&rule.match_value],
                    "outbound": &rule.outbound
                }));
            }
            "ip_is_private" => {
                route_rules.push(json!({
                    "action": "route",
                    "ip_is_private": true,
                    "outbound": &rule.outbound
                }));
            }
            _ => {}
        }
    }

    // Build vless outbound
    let mut vless_outbound = json!({
        "type": "vless",
        "tag": "proxy",
        "server": &active_node.address,
        "server_port": active_node.port,
        "uuid": &active_node.uuid,
        "flow": &active_node.flow,
        "tls": build_tls_config(active_node),
        "domain_resolver": "local-dns"
    });
    if active_node.transport != "tcp" {
        vless_outbound["transport"] = json!({ "type": &active_node.transport });
    }

    json!({
        "log": {
            "level": "info",
            "timestamp": true
        },
        "dns": {
            "strategy": "ipv4_only",
            "servers": dns_servers,
            "rules": dns_rules
        },
        "inbounds": [
            {
                "type": "mixed",
                "tag": "mixed-in",
                "listen": "127.0.0.1",
                "listen_port": 2080
            }
        ],
        "outbounds": [
            vless_outbound,
            {
                "type": "direct",
                "tag": "direct"
            },
            {
                "type": "block",
                "tag": "block"
            }
        ],
        "route": {
            "rules": route_rules,
            "rule_set": rule_sets,
            "final": &rule_group.default_strategy,
            "default_domain_resolver": "local-dns"
        },
        "experimental": {
            "cache_file": {
                "enabled": true,
                "path": cache_file_path
            }
        }
    })
}

fn normalize_domain_suffix(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("+.")
        .trim_start_matches('.')
        .to_string()
}

fn sanitize_rule_set_value(value: &str) -> Option<String> {
    let normalized = value.trim();
    if normalized.is_empty()
        || normalized.contains('/')
        || normalized.contains("..")
        || !normalized
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '!')
    {
        return None;
    }

    Some(normalized.to_string())
}

fn build_tls_config(active_node: &Node) -> Value {
    match active_node.security.as_str() {
        "reality" => json!({
            "enabled": true,
            "server_name": &active_node.sni,
            "utls": {
                "enabled": true,
                "fingerprint": &active_node.fingerprint
            },
            "reality": {
                "enabled": true,
                "public_key": &active_node.public_key,
                "short_id": &active_node.short_id
            }
        }),
        "tls" => json!({
            "enabled": true,
            "server_name": &active_node.sni,
            "utls": {
                "enabled": true,
                "fingerprint": &active_node.fingerprint
            }
        }),
        _ => json!({
            "enabled": false
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_config_basic() {
        let node = Node {
            id: "test-id".into(),
            name: "test".into(),
            address: "example.com".into(),
            port: 443,
            uuid: "test-uuid".into(),
            flow: "xtls-rprx-vision".into(),
            security: "reality".into(),
            sni: "www.example.com".into(),
            fingerprint: "chrome".into(),
            public_key: "pk123".into(),
            short_id: "sid".into(),
            transport: "tcp".into(),
        };

        let group = RuleGroup {
            id: "g1".into(),
            name: "Default".into(),
            rules: vec![
                Rule {
                    id: "r1".into(),
                    rule_type: "geosite".into(),
                    match_value: "geolocation-cn".into(),
                    outbound: "direct".into(),
                },
                Rule {
                    id: "r2".into(),
                    rule_type: "geoip".into(),
                    match_value: "cn".into(),
                    outbound: "direct".into(),
                },
            ],
            default_strategy: "proxy".into(),
            fake_ip_filter: vec![],
            nameserver_policy: vec![],
        };

        let config = generate_config(&node, &group, "/tmp/sing-proxy-cache.db");

        // Basic structure
        assert_eq!(config["inbounds"][0]["listen_port"], 2080);
        assert_eq!(config["outbounds"][0]["type"], "vless");
        assert_eq!(config["route"]["final"], "proxy");
        assert_eq!(config["route"]["default_domain_resolver"], "local-dns");
        assert_eq!(config["outbounds"][0]["domain_resolver"], "local-dns");

        // DNS section
        let dns_servers = config["dns"]["servers"].as_array().unwrap();
        assert_eq!(dns_servers.len(), 2);
        assert_eq!(dns_servers[0]["tag"], "remote-dns");
        assert_eq!(config["dns"]["strategy"], "ipv4_only");
        assert_eq!(dns_servers[0]["type"], "udp");
        assert_eq!(dns_servers[1]["tag"], "local-dns");
        assert_eq!(dns_servers[1]["type"], "udp");
        let dns_rules = config["dns"]["rules"].as_array().unwrap();
        assert!(!dns_rules.is_empty());

        // Outbounds keep proxy + direct + block, DNS is handled via hijack-dns
        let outbounds = config["outbounds"].as_array().unwrap();
        assert_eq!(outbounds.len(), 3);
        assert_eq!(outbounds[1]["type"], "direct");
        assert_eq!(outbounds[1]["tag"], "direct");
        assert_eq!(outbounds[2]["type"], "block");
        assert_eq!(outbounds[2]["tag"], "block");

        // Built-in route rules: hijack DNS + private IP direct come first
        let route_rules = config["route"]["rules"].as_array().unwrap();
        assert_eq!(route_rules[0]["protocol"], "dns");
        assert_eq!(route_rules[0]["action"], "hijack-dns");
        assert_eq!(route_rules[1]["ip_is_private"], true);
        assert_eq!(route_rules[1]["action"], "route");
        assert_eq!(route_rules[1]["outbound"], "direct");

        // At least 3 built-in rule_sets (geosite-geolocation-cn, geosite-geolocation-!cn, geoip-cn)
        // User geosite-geolocation-cn is deduplicated with built-in, so total = 3 (built-in) + 0 (deduped geosite) + 0 (deduped geoip-cn) = 3
        let rule_sets = config["route"]["rule_set"].as_array().unwrap();
        assert!(rule_sets.len() >= 3);
        let rule_set_tags: Vec<&str> = rule_sets
            .iter()
            .map(|rs| rs["tag"].as_str().unwrap())
            .collect();
        assert!(rule_set_tags.contains(&"geosite-geolocation-cn"));
        assert!(rule_set_tags.contains(&"geosite-geolocation-!cn"));
        assert!(rule_set_tags.contains(&"geoip-cn"));

        // All rule_sets have download_detour
        for rs in rule_sets {
            assert_eq!(rs["download_detour"], "proxy");
        }

        // cache_file in experimental
        assert_eq!(config["experimental"]["cache_file"]["enabled"], true);
        assert_eq!(
            config["experimental"]["cache_file"]["path"],
            "/tmp/sing-proxy-cache.db"
        );

        // log section
        assert_eq!(config["log"]["level"], "info");
    }

    #[test]
    fn test_generate_config_with_nameserver_policy() {
        let node = Node {
            id: "test-id".into(),
            name: "test".into(),
            address: "example.com".into(),
            port: 443,
            uuid: "test-uuid".into(),
            flow: "xtls-rprx-vision".into(),
            security: "reality".into(),
            sni: "www.example.com".into(),
            fingerprint: "chrome".into(),
            public_key: "pk123".into(),
            short_id: "sid".into(),
            transport: "tcp".into(),
        };
        let group = RuleGroup {
            id: "work".into(),
            name: "Work".into(),
            rules: vec![],
            default_strategy: "proxy".into(),
            fake_ip_filter: vec!["+.npmjs.org".into()],
            nameserver_policy: vec![
                NameServerPolicy {
                    domain_suffix: "+.npmjs.org".into(),
                    server: "100.82.0.1".into(),
                },
                NameServerPolicy {
                    domain_suffix: "+.feishu.cn".into(),
                    server: "100.82.0.1".into(),
                },
            ],
        };

        let config = generate_config(&node, &group, "/tmp/sing-proxy-cache.db");
        let dns_servers = config["dns"]["servers"].as_array().unwrap();
        assert_eq!(dns_servers.len(), 3);
        assert_eq!(dns_servers[2]["server"], "100.82.0.1");

        let dns_rules = config["dns"]["rules"].as_array().unwrap();
        assert_eq!(dns_rules[0]["domain_suffix"][0], "npmjs.org");
        assert_eq!(dns_rules[0]["server"], "policy-dns-2");
        assert_eq!(dns_rules[1]["domain_suffix"][0], "feishu.cn");
        assert_eq!(dns_rules[1]["server"], "policy-dns-2");
    }

    #[test]
    fn test_generate_config_skips_invalid_remote_rule_set_values() {
        let node = Node {
            id: "test-id".into(),
            name: "test".into(),
            address: "example.com".into(),
            port: 443,
            uuid: "test-uuid".into(),
            flow: "xtls-rprx-vision".into(),
            security: "reality".into(),
            sni: "www.example.com".into(),
            fingerprint: "chrome".into(),
            public_key: "pk123".into(),
            short_id: "sid".into(),
            transport: "tcp".into(),
        };
        let group = RuleGroup {
            id: "g1".into(),
            name: "Default".into(),
            rules: vec![
                Rule {
                    id: "r1".into(),
                    rule_type: "geosite".into(),
                    match_value: "../evil".into(),
                    outbound: "direct".into(),
                },
                Rule {
                    id: "r2".into(),
                    rule_type: "geoip".into(),
                    match_value: "cn".into(),
                    outbound: "direct".into(),
                },
            ],
            default_strategy: "proxy".into(),
            fake_ip_filter: vec![],
            nameserver_policy: vec![],
        };

        let config = generate_config(&node, &group, "/tmp/sing-proxy-cache.db");
        let rule_sets = config["route"]["rule_set"].as_array().unwrap();
        let tags: Vec<&str> = rule_sets
            .iter()
            .filter_map(|rule_set| rule_set["tag"].as_str())
            .collect();

        assert!(!tags.contains(&"geosite-../evil"));
        assert!(tags.contains(&"geoip-cn"));
    }

    #[test]
    fn test_generate_config_uses_tls_by_security_type() {
        let mut node = Node {
            id: "test-id".into(),
            name: "test".into(),
            address: "example.com".into(),
            port: 443,
            uuid: "test-uuid".into(),
            flow: "xtls-rprx-vision".into(),
            security: "tls".into(),
            sni: "www.example.com".into(),
            fingerprint: "chrome".into(),
            public_key: "pk123".into(),
            short_id: "sid".into(),
            transport: "tcp".into(),
        };
        let group = RuleGroup {
            id: "g1".into(),
            name: "Default".into(),
            rules: vec![],
            default_strategy: "proxy".into(),
            fake_ip_filter: vec![],
            nameserver_policy: vec![],
        };

        let tls_config = generate_config(&node, &group, "/tmp/sing-proxy-cache.db");
        assert_eq!(tls_config["outbounds"][0]["tls"]["enabled"], true);
        assert!(tls_config["outbounds"][0]["tls"]["reality"].is_null());

        node.security.clear();
        let disabled_tls_config = generate_config(&node, &group, "/tmp/sing-proxy-cache.db");
        assert_eq!(disabled_tls_config["outbounds"][0]["tls"]["enabled"], false);
    }
}
