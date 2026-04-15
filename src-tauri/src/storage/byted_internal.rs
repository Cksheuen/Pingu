use crate::singbox::config_gen::{NameServerPolicy, Rule, RuleGroup};

pub(crate) const BYTED_INTERNAL_DNS_GROUP_NAME: &str = "Byted Internal DNS";
pub(crate) const BYTED_INTERNAL_PRIMARY_DNS: &str = "10.199.34.255";
pub(crate) const BYTED_INTERNAL_SECONDARY_DNS: &str = "10.199.35.253";
pub(crate) const BYTED_INTERNAL_DOMAIN_SUFFIXES: [&str; 4] = [
    "+.byted.org",
    "+.bytedance.net",
    "+.tiktok-row.org",
    "+.tiktok-row.net",
];
pub(crate) const BYTED_INTERNAL_FAKE_IP_FILTERS: [&str; 8] = [
    "+.byted.org",
    "+.bytedance.net",
    "+.tiktok-row.org",
    "+.tiktok-row.net",
    "+.npmjs.org",
    "+.feishu.cn",
    "+.lan",
    "+.local",
];
pub(crate) const BYTED_INTERNAL_DIRECT_SUFFIXES: [&str; 4] = [
    "byted.org",
    "bytedance.net",
    "tiktok-row.org",
    "tiktok-row.net",
];
pub(crate) const BYTED_INTERNAL_DIRECT_IP_CIDRS: [&str; 1] = ["10.0.0.0/8"];

pub(crate) fn make_byted_internal_dns_group() -> RuleGroup {
    let mut group = RuleGroup {
        id: uuid::Uuid::new_v4().to_string(),
        name: BYTED_INTERNAL_DNS_GROUP_NAME.to_string(),
        rules: vec![
            Rule {
                id: uuid::Uuid::new_v4().to_string(),
                rule_type: "geosite".to_string(),
                match_value: "geolocation-cn".to_string(),
                outbound: "direct".to_string(),
            },
            Rule {
                id: uuid::Uuid::new_v4().to_string(),
                rule_type: "geoip".to_string(),
                match_value: "cn".to_string(),
                outbound: "direct".to_string(),
            },
        ],
        default_strategy: "proxy".to_string(),
        fake_ip_filter: vec![],
        nameserver_policy: vec![],
    };
    let _ = strengthen_byted_internal_dns_group(&mut group);
    group
}

pub(crate) fn strengthen_byted_internal_dns_group(group: &mut RuleGroup) -> bool {
    let mut changed = false;

    if group.default_strategy != "proxy" {
        group.default_strategy = "proxy".to_string();
        changed = true;
    }

    changed = ensure_group_rule(group, "geosite", "geolocation-cn", "direct") || changed;
    changed = ensure_group_rule(group, "geoip", "cn", "direct") || changed;

    for suffix in BYTED_INTERNAL_DIRECT_SUFFIXES {
        changed = ensure_group_rule(group, "domain_suffix", suffix, "direct") || changed;
    }
    for cidr in BYTED_INTERNAL_DIRECT_IP_CIDRS {
        changed = ensure_group_rule(group, "ip_cidr", cidr, "direct") || changed;
    }

    for filter in BYTED_INTERNAL_FAKE_IP_FILTERS {
        if !group.fake_ip_filter.iter().any(|item| item == filter) {
            group.fake_ip_filter.push(filter.to_string());
            changed = true;
        }
    }

    for suffix in BYTED_INTERNAL_DOMAIN_SUFFIXES {
        changed = upsert_nameserver_policy(
            &mut group.nameserver_policy,
            suffix,
            &[BYTED_INTERNAL_PRIMARY_DNS, BYTED_INTERNAL_SECONDARY_DNS],
        ) || changed;
    }

    changed
}

pub(crate) fn ensure_group_rule(
    group: &mut RuleGroup,
    rule_type: &str,
    match_value: &str,
    outbound: &str,
) -> bool {
    if group.rules.iter().any(|rule| {
        rule.rule_type == rule_type
            && rule.match_value == match_value
            && rule.outbound == outbound
    }) {
        return false;
    }

    group.rules.push(Rule {
        id: uuid::Uuid::new_v4().to_string(),
        rule_type: rule_type.to_string(),
        match_value: match_value.to_string(),
        outbound: outbound.to_string(),
    });
    true
}

pub(crate) fn upsert_nameserver_policy(
    policies: &mut Vec<NameServerPolicy>,
    domain_suffix: &str,
    servers: &[&str],
) -> bool {
    let mut changed = false;
    let desired_servers: Vec<String> = servers
        .iter()
        .map(|server| server.trim())
        .filter(|server| !server.is_empty())
        .map(|server| server.to_string())
        .collect();
    if desired_servers.is_empty() {
        return false;
    }

    if let Some(policy) = policies
        .iter_mut()
        .find(|policy| policy.domain_suffix == domain_suffix)
    {
        if policy.domain_suffix != domain_suffix {
            policy.domain_suffix = domain_suffix.to_string();
            changed = true;
        }
        if policy.server != desired_servers[0] {
            policy.server = desired_servers[0].clone();
            changed = true;
        }
        if policy.servers != desired_servers {
            policy.servers = desired_servers;
            changed = true;
        }
        return changed;
    }

    policies.push(NameServerPolicy {
        domain_suffix: domain_suffix.to_string(),
        server: desired_servers[0].clone(),
        servers: desired_servers,
    });
    true
}

pub(crate) fn normalize_nameserver_policy(policy: &mut NameServerPolicy) -> bool {
    let normalized_servers = policy.normalized_servers();
    let primary_server = normalized_servers.first().cloned().unwrap_or_default();
    let mut changed = false;

    if policy.server != primary_server {
        policy.server = primary_server;
        changed = true;
    }
    if policy.servers != normalized_servers {
        policy.servers = normalized_servers;
        changed = true;
    }

    changed
}
