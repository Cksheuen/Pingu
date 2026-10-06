use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::uri_parser::Node;
use crate::storage::app_config::HostOverride;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExactDnsPolicy {
    pub domain: String,
    pub server: String,
}

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
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub server: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub servers: Vec<String>,
}

impl NameServerPolicy {
    pub fn normalized_servers(&self) -> Vec<String> {
        let mut normalized = Vec::new();
        for server in self
            .servers
            .iter()
            .map(|server| server.trim())
            .chain(std::iter::once(self.server.trim()))
        {
            if server.is_empty() {
                continue;
            }
            if normalized.iter().any(|existing| existing == server) {
                continue;
            }
            normalized.push(server.to_string());
        }
        normalized
    }

    pub fn primary_server(&self) -> Option<String> {
        self.normalized_servers().into_iter().next()
    }
}

/// Convert persisted legacy VLESS nodes without changing their IDs or share-link secrets.
pub fn node_proxy(node: &Node) -> Value {
    let mut p = json!({"name":node.name,"type":"vless","server":node.address,"port":node.port,"uuid":node.uuid,"udp":true,"tls":node.security=="tls"||node.security=="reality","network":node.transport});
    p["skip-cert-verify"] = json!(node.skip_cert_verify);
    if node.transport == "grpc" {
        p["grpc-opts"] = json!({"grpc-service-name":node.grpc_service_name});
    }
    if !node.flow.is_empty() {
        p["flow"] = json!(node.flow);
    }
    if !node.sni.is_empty() {
        p["servername"] = json!(node.sni);
    }
    if !node.fingerprint.is_empty() {
        p["client-fingerprint"] = json!(node.fingerprint);
    }
    if !node.alpn.is_empty() {
        p["alpn"] = json!(node.alpn);
    }
    if node.security == "reality" {
        p["reality-opts"] = json!({"public-key":node.public_key,"short-id":node.short_id});
    }
    if node.transport == "ws" {
        p["ws-opts"] = json!({"path":node.ws_path,"headers":{"Host":node.ws_host}});
    }
    p
}
pub fn generate_config(
    active_node: &Node,
    rule_group: &RuleGroup,
    cache_file_path: &str,
    clash_api_port: u16,
) -> Value {
    generate_config_with_host_overrides(
        active_node,
        rule_group,
        cache_file_path,
        &[],
        clash_api_port,
    )
}
pub fn generate_config_with_exact_dns_policies(
    active_node: &Node,
    rule_group: &RuleGroup,
    cache_file_path: &str,
    policies: &[ExactDnsPolicy],
    clash_api_port: u16,
) -> Value {
    let overrides = policies
        .iter()
        .map(|p| HostOverride {
            id: p.domain.clone(),
            host: p.domain.clone(),
            resolver_mode: p.server.clone(),
            outbound_mode: "inherit".into(),
            enabled: true,
            source: "compat".into(),
            reason: String::new(),
            updated_at: String::new(),
        })
        .collect::<Vec<_>>();
    generate_config_with_host_overrides(
        active_node,
        rule_group,
        cache_file_path,
        &overrides,
        clash_api_port,
    )
}
pub fn generate_config_with_host_overrides(
    active_node: &Node,
    rule_group: &RuleGroup,
    cache_file_path: &str,
    overrides: &[HostOverride],
    clash_api_port: u16,
) -> Value {
    generate_config_with_host_overrides_and_port(
        active_node,
        rule_group,
        cache_file_path,
        overrides,
        clash_api_port,
        2080,
    )
}
pub fn generate_config_with_host_overrides_and_port(
    active_node: &Node,
    rule_group: &RuleGroup,
    _cache_file_path: &str,
    overrides: &[HostOverride],
    clash_api_port: u16,
    listen_port: u16,
) -> Value {
    let mut config = crate::storage::app_config::AppConfig::default_config();
    config.nodes = vec![active_node.clone()];
    config.active_node_id = Some(active_node.id.clone());
    generate_app_config(&config, rule_group, overrides, clash_api_port, listen_port)
}
fn target(name: &str) -> &str {
    match name {
        "proxy" => "Pingu Proxy",
        "direct" => "DIRECT",
        "block" => "REJECT",
        other => other,
    }
}
fn dns_server(name: &str) -> &str {
    match name {
        "system-dns" => "system",
        "remote-dns" => "https://dns.google/dns-query#Pingu Proxy",
        "local-dns" => "223.5.5.5",
        other => other,
    }
}
/// Subscription objects are namespaced to avoid collisions between independent providers.
fn mapped(name: &str, map: &std::collections::HashMap<String, String>) -> String {
    map.get(name).cloned().unwrap_or_else(|| name.to_string())
}
/// Mihomo builds an include-all group from every top-level proxy in the generated
/// document, so namespacing names alone would leak one source's nodes into another.
/// These three keys are recomposed per source instead of being passed through.
const SOURCE_SCOPED_GROUP_KEYS: [&str; 3] = [
    "include-all",
    "include-all-proxies",
    "include-all-providers",
];
fn flag(value: &Value) -> bool {
    match value {
        Value::Bool(_) => value.as_bool().unwrap_or(false),
        Value::String(s) => matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "true" | "yes" | "on" | "1"
        ),
        _ => false,
    }
}
/// Mihomo compiles each backtick-separated segment with regexp2 and no implicit flags,
/// so patterns pass through verbatim: no trimming, empty segments kept (an empty
/// pattern matches everything), and case sensitivity or `(?i)` left to the pattern.
/// Patterns regexp2 accepts but this generator cannot are reported, never dropped.
fn compile_filters(filter: &str) -> Result<Vec<regex::Regex>, String> {
    filter
        .split('`')
        .map(|pattern| {
            regex::Regex::new(pattern)
                .map_err(|error| format!("unsupported filter pattern `{pattern}`: {error}"))
        })
        .collect()
}
struct SourceMembers {
    proxies: Vec<String>,
    uses: Vec<String>,
}
/// Recompose one source's group the way the pinned parser does, but against that
/// source's own objects only. Membership order follows the core: explicit references
/// first, then include-all matches scanning names in sorted order with the filter
/// patterns inner (a name is taken once, on its first matching pattern). Matching uses
/// original names so anchored patterns keep their meaning after the source-prefix
/// rename; namespacing happens last. Provider node names are never renamed, so provider
/// filtering stays native and is left to the core.
fn source_members(
    group: &Value,
    map: &std::collections::HashMap<String, String>,
    own_names: &[String],
    own_providers: &[String],
) -> Result<SourceMembers, String> {
    let include_all = flag(&group["include-all"]);
    let include_proxies = include_all || flag(&group["include-all-proxies"]);
    let include_providers = include_all || flag(&group["include-all-providers"]);
    let names = |key: &str| {
        group[key]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };
    let mut proxies = names("proxies");
    if include_proxies {
        let mut sorted = own_names.to_vec();
        sorted.sort();
        match group["filter"].as_str().filter(|filter| !filter.is_empty()) {
            Some(filter) => {
                let patterns = compile_filters(filter)?;
                for name in &sorted {
                    if patterns.iter().any(|pattern| pattern.is_match(name))
                        && !proxies.contains(name)
                    {
                        proxies.push(name.clone());
                    }
                }
            }
            None => {
                for name in &sorted {
                    if !proxies.contains(name) {
                        proxies.push(name.clone());
                    }
                }
            }
        }
        if let Some(exclude) = group["exclude-filter"].as_str().filter(|f| !f.is_empty()) {
            let patterns = compile_filters(exclude)?;
            proxies.retain(|name| !patterns.iter().any(|pattern| pattern.is_match(name)));
        }
    }
    let mut uses = if include_providers {
        let mut sorted = own_providers.to_vec();
        sorted.sort();
        sorted
    } else {
        names("use")
    };
    uses.retain(|name| !name.is_empty());
    // As in the pinned parser, an include-all group with neither proxies nor providers
    // to draw on falls back to its empty-fallback (COMPATIBLE by default).
    if include_proxies && proxies.is_empty() && uses.is_empty() {
        proxies.push(
            group["empty-fallback"]
                .as_str()
                .unwrap_or("COMPATIBLE")
                .to_string(),
        );
    }
    Ok(SourceMembers {
        proxies: proxies.iter().map(|name| mapped(name, map)).collect(),
        uses: uses.iter().map(|name| mapped(name, map)).collect(),
    })
}
fn rewrite_dns(v: &mut Value, map: &std::collections::HashMap<String, String>) {
    match v {
        Value::String(s) => {
            if let Some((server, group)) = s.rsplit_once('#') {
                if let Some(name) = map.get(group) {
                    *s = format!("{server}#{name}");
                }
            }
        }
        Value::Array(a) => {
            for x in a {
                rewrite_dns(x, map)
            }
        }
        Value::Object(o) => {
            for x in o.values_mut() {
                rewrite_dns(x, map)
            }
        }
        _ => {}
    }
}

/// Namespace only fields that name source-local runtime objects. Rewriting
/// every comma-separated token corrupts legitimate payloads when, for example,
/// a DOMAIN or PROCESS-NAME happens to equal a proxy/group display name.
pub(crate) fn rewrite_rule(rule: &str, map: &std::collections::HashMap<String, String>) -> String {
    let mut parts = rule
        .split(',')
        .map(|part| part.trim().to_string())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return rule.to_string();
    }
    let kind = parts[0].to_ascii_uppercase();
    parts[0] = kind.clone();
    if kind == "RULE-SET" && parts.len() > 1 {
        parts[1] = mapped(&parts[1], map);
    }
    // Mirror v1.19.31 RC.ParseRulePayload exactly. Logical and regex rules may
    // contain commas in their payload and accept no params, so their target is
    // the final field. Ordinary rules use field 2 and preserve trailing params.
    let policy_index = match kind.as_str() {
        "MATCH" | "FINAL" => 1,
        "NOT" | "OR" | "AND" | "SUB-RULE" | "DOMAIN-REGEX" | "PROCESS-NAME-REGEX"
        | "PROCESS-PATH-REGEX" => parts.len().saturating_sub(1),
        _ => 2,
    };
    if parts.len() > policy_index {
        parts[policy_index] = mapped(&parts[policy_index], map);
    }
    parts.join(",")
}

pub fn generate_app_config(
    config: &crate::storage::app_config::AppConfig,
    group: &RuleGroup,
    overrides: &[HostOverride],
    api: u16,
    port: u16,
) -> Value {
    match try_generate_app_config(config, group, overrides, api, port) {
        Ok(value) => value,
        Err(error) => {
            // Never emit a config that silently changed a source's policy: surface the
            // unsupported construct so the import reports it and the core never starts
            // with membership we could not reproduce.
            eprintln!("pingu: refusing to generate configuration: {error}");
            json!({"error": error})
        }
    }
}
/// Runtime and import paths use this so an unsupported subscription construct is
/// reported instead of being silently turned into different routing.
pub fn try_generate_app_config(
    config: &crate::storage::app_config::AppConfig,
    group: &RuleGroup,
    overrides: &[HostOverride],
    api: u16,
    port: u16,
) -> Result<Value, String> {
    use std::collections::HashMap;
    let mut proxies = Vec::new();
    let mut groups = Vec::new();
    let mut choices = Vec::new();
    let mut all_proxy_names = Vec::new();
    let mut provider_names = Vec::new();
    let mut proxy_providers = serde_json::Map::new();
    let mut rule_providers = serde_json::Map::new();
    let mut imported_rules = Vec::new();
    let mut imported_default = None;
    // Direct traffic and IP rules must resolve even when foreign DoH endpoints
    // are blocked. Proxy protocols resolve destination domains at their exit;
    // an explicit remote-dns override goes through Pingu Proxy (see dns_server).
    // Keep local/corporate policies authoritative for direct connections too.
    let mut dns = json!({
        "enable": true,
        "ipv6": false,
        "enhanced-mode": "redir-host",
        "nameserver": ["system"],
        "default-nameserver": ["system"],
        "proxy-server-nameserver": ["system"],
        "direct-nameserver": ["system"],
        "direct-nameserver-follow-policy": true,
        "nameserver-policy": {}
    });
    let mut nodes = config.nodes.iter().collect::<Vec<_>>();
    nodes.sort_by_key(|n| config.active_node_id.as_deref() != Some(n.id.as_str()));
    for node in nodes {
        let mut p = node_proxy(node);
        let name = format!("{} [{}]", node.name, node.id);
        p["name"] = json!(name);
        choices.push(name.clone());
        all_proxy_names.push(name);
        proxies.push(p);
    }
    for subscription in config.subscriptions.iter().filter(|s| s.enabled) {
        // Keep the provider's original document for refresh, but optionally use
        // it only as a node catalog without taking over the user's routing/DNS.
        let mut node_catalog;
        let f = if subscription.nodes_only {
            node_catalog = subscription.fragment.clone();
            if let Some(object) = node_catalog.as_object_mut() {
                for key in ["rules", "rule-providers", "dns"] {
                    object.remove(key);
                }
            }
            &node_catalog
        } else {
            &subscription.fragment
        };
        let prefix = format!(
            "{} [{}]",
            subscription.name,
            &subscription.id[..subscription.id.len().min(8)]
        );
        let mut map = HashMap::new();
        for key in ["proxies", "proxy-groups"] {
            if let Some(items) = f[key].as_array() {
                for item in items {
                    if let Some(name) = item["name"].as_str() {
                        map.insert(name.to_string(), format!("{prefix} / {name}"));
                    }
                }
            }
        }
        for key in ["proxy-providers", "rule-providers"] {
            if let Some(items) = f[key].as_object() {
                for name in items.keys() {
                    map.insert(name.clone(), format!("{prefix} / {name}"));
                }
            }
        }
        if let Some(items) = f["proxies"].as_array() {
            for item in items {
                let mut p = item.clone();
                let name = mapped(p["name"].as_str().unwrap_or(""), &map);
                p["name"] = json!(name);
                if let Some(dialer) = p["dialer-proxy"].as_str() {
                    p["dialer-proxy"] = json!(mapped(dialer, &map));
                }
                choices.push(name.clone());
                all_proxy_names.push(name);
                proxies.push(p);
            }
        }
        // Names available for include-all membership, in the source's own namespace.
        let own_names = f["proxies"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|p| p["name"].as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let own_provider_keys = f["proxy-providers"]
            .as_object()
            .map(|items| items.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        if let Some(items) = f["proxy-groups"].as_array() {
            for item in items {
                let mut g = item.clone();
                let name = mapped(g["name"].as_str().unwrap_or(""), &map);
                let include_all = flag(&g["include-all"]);
                let include_proxies = include_all || flag(&g["include-all-proxies"]);
                let include_providers = include_all || flag(&g["include-all-providers"]);
                if include_proxies || include_providers {
                    // Resolve membership against this source's own objects so a shared
                    // name can no longer pull another source's nodes into the group.
                    // Filters run on un-namespaced names, so the prefix a display name
                    // contributes can never re-match or defeat an anchored pattern.
                    let members = source_members(&g, &map, &own_names, &own_provider_keys)?;
                    if members.proxies.is_empty() {
                        if let Some(o) = g.as_object_mut() {
                            o.remove("proxies");
                        }
                    } else {
                        g["proxies"] = json!(members.proxies);
                    }
                    if members.uses.is_empty() {
                        if let Some(o) = g.as_object_mut() {
                            o.remove("use");
                        }
                    } else {
                        g["use"] = json!(members.uses);
                    }
                    // Membership is resolved, so the core must not re-expand these
                    // across every source.
                    for key in SOURCE_SCOPED_GROUP_KEYS {
                        if let Some(o) = g.as_object_mut() {
                            o.remove(key);
                        }
                    }
                    // Filtering semantics, matched to the pinned groupbase:
                    // - Our flattened static proxies become a Compatible provider, which
                    //   the core never filters, and we already applied both patterns to
                    //   them on original names. So with no providers in play the patterns
                    //   must go, or the core would re-run exclude-filter against our
                    //   namespaced names and silently drop nodes.
                    // - Real providers keep native filtering (their node names are never
                    //   renamed), so their patterns stay.
                    // - Exclude-filter is applied by the core to every provider including
                    //   the Compatible one, so it cannot serve both at once; that
                    //   combination is refused rather than silently changing membership.
                    let providers_in_use = !members.uses.is_empty();
                    let exclude_filter = g["exclude-filter"].as_str().filter(|f| !f.is_empty());
                    if include_proxies && providers_in_use && exclude_filter.is_some() {
                        return Err(format!(
                            "group `{}` combines include-all proxies with proxy providers and an exclude-filter; \
                             source-local isolation cannot preserve that pattern for both without changing \
                             which nodes are selected. Split it into separate groups or drop the exclude-filter.",
                            g["name"].as_str().unwrap_or("")
                        ));
                    }
                    if !providers_in_use {
                        for key in ["filter", "exclude-filter"] {
                            if let Some(o) = g.as_object_mut() {
                                o.remove(key);
                            }
                        }
                    }
                } else {
                    // Membership here is author-written, so the core later sees only
                    // namespaced names. An exclude-filter is evaluated by the core against
                    // exactly those names, which would let a source prefix or display name
                    // swallow a node the author meant to keep, so for a static list it is
                    // applied to the original names here and then dropped. Provider node
                    // names are never renamed, so provider filtering stays native; a group
                    // that needs the pattern for both at once is refused exactly as in the
                    // include-all branch, rather than silently changing membership.
                    let has_static = g["proxies"]
                        .as_array()
                        .map(|items| !items.is_empty())
                        .unwrap_or(false);
                    let providers_in_use = g["use"]
                        .as_array()
                        .map(|items| !items.is_empty())
                        .unwrap_or(false);
                    let exclude_filter = g["exclude-filter"]
                        .as_str()
                        .filter(|f| !f.is_empty())
                        .map(str::to_string);
                    if providers_in_use && has_static && exclude_filter.is_some() {
                        return Err(format!(
                            "group `{}` lists static proxies alongside proxy providers and an exclude-filter; \
                             source-local isolation cannot preserve that pattern for both without changing \
                             which nodes are selected. Split it into separate groups or drop the exclude-filter.",
                            g["name"].as_str().unwrap_or("")
                        ));
                    }
                    // Only a static-only group resolves the pattern here; with providers in
                    // play the core must keep filtering their un-renamed node names natively.
                    let patterns = match exclude_filter.as_deref().filter(|_| !providers_in_use) {
                        Some(exclude) => Some(compile_filters(exclude)?),
                        None => None,
                    };
                    for key in ["proxies", "use"] {
                        let only_proxies = key == "proxies";
                        if let Some(items) = g[key].as_array() {
                            let rewritten = items
                                .iter()
                                .filter_map(Value::as_str)
                                .filter(|item| match &patterns {
                                    // Evaluated on the original name, before the source
                                    // prefix, so the pattern keeps the meaning it had.
                                    Some(patterns) if only_proxies => {
                                        !patterns.iter().any(|pattern| pattern.is_match(item))
                                    }
                                    _ => true,
                                })
                                .map(|item| mapped(item, &map))
                                .collect::<Vec<_>>();
                            g[key] = json!(rewritten);
                        }
                    }
                    // The static list is already resolved, so the core must not re-run the
                    // pattern against names it was never written for.
                    if patterns.is_some() {
                        if let Some(o) = g.as_object_mut() {
                            o.remove("exclude-filter");
                        }
                    }
                }
                // These name a source-local object and must be renamed with everything
                // else, or Mihomo cannot resolve them at load time.
                for key in ["empty-fallback", "default-selected"] {
                    if let Some(value) = g[key].as_str() {
                        let rewritten = mapped(value, &map);
                        g[key] = json!(rewritten);
                    }
                }
                g["name"] = json!(name);
                choices.push(name);
                groups.push(g);
            }
        }
        for key in ["proxy-providers", "rule-providers"] {
            if let Some(items) = f[key].as_object() {
                for (index, (name, item)) in items.iter().enumerate() {
                    let name = mapped(name, &map);
                    let mut p = item.clone();
                    p["path"] = json!(format!("providers/{}/{key}-{index}.cache", subscription.id));
                    if let Some(proxy) = p["proxy"].as_str() {
                        p["proxy"] = json!(mapped(proxy, &map));
                    }
                    // A provider's own override may route through a source-local proxy.
                    if let Some(dialer) = p["override"]["dialer-proxy"].as_str() {
                        p["override"]["dialer-proxy"] = json!(mapped(dialer, &map));
                    }
                    if key == "proxy-providers" {
                        provider_names.push(name.clone());
                        proxy_providers.insert(name, p);
                    } else {
                        rule_providers.insert(name, p);
                    }
                }
            }
        }
        if let Some(rules) = f["rules"].as_array() {
            for rule in rules.iter().filter_map(Value::as_str) {
                let rewritten = rewrite_rule(rule, &map);
                if rewritten.starts_with("MATCH,") || rewritten.starts_with("FINAL,") {
                    if imported_default.is_none() {
                        imported_default = Some(rewritten.replacen("FINAL,", "MATCH,", 1));
                    }
                } else {
                    imported_rules.push(rewritten);
                }
            }
        }
        if let Some(source) = f["dns"].as_object() {
            for (key, v) in source {
                let mut v = v.clone();
                rewrite_dns(&mut v, &map);
                if key == "nameserver-policy" {
                    if let Some(p) = v.as_object() {
                        for (k, v) in p {
                            dns["nameserver-policy"][k] = v.clone();
                        }
                    }
                } else if key == "fake-ip-filter" {
                    let a = dns
                        .as_object_mut()
                        .unwrap()
                        .entry(key.clone())
                        .or_insert_with(|| json!([]));
                    if let (Some(out), Some(add)) = (a.as_array_mut(), v.as_array()) {
                        out.extend(add.clone());
                    }
                } else {
                    dns[key] = v;
                }
            }
        }
    }
    let mut auto = json!({"name":"Pingu Auto","type":"url-test","url":"https://www.gstatic.com/generate_204","interval":300,"tolerance":50,"lazy":true});
    if !all_proxy_names.is_empty() {
        auto["proxies"] = json!(all_proxy_names);
    }
    if !provider_names.is_empty() {
        auto["use"] = json!(provider_names);
    }
    if all_proxy_names.is_empty() && provider_names.is_empty() {
        auto["proxies"] = json!(["DIRECT"]);
    }
    groups.push(auto);
    choices.insert(0, "Pingu Auto".into());
    if choices.len() == 1 && provider_names.is_empty() {
        choices.push("DIRECT".into());
    }
    // A saved selection is expressed as the group's native `default-selected`, not by
    // reordering the list: the core resolves it by name at load time and falls back to
    // the first member when it names something no longer present. That keeps provider
    // node selections working (their names are never in `choices`) and leaves membership
    // order untouched. An authored `default-selected` is overridden only by a saved one.
    for g in &mut groups {
        if g["type"] == "select" {
            if let Some(selected) = g["name"]
                .as_str()
                .and_then(|n| config.strategy_selections.get(n))
            {
                g["default-selected"] = json!(selected);
            }
        }
    }
    // Keep a saved manual active node as the default; subscription-only installs start
    // with automatic selection, which is the core's own first-member fallback.
    let device_default = config
        .active_node_id
        .as_ref()
        .and_then(|id| config.nodes.iter().find(|node| &node.id == id))
        .map(|node| format!("{} [{}]", node.name, node.id));
    let mut selector = json!({"name":"Pingu Proxy","type":"select","proxies":choices});
    if let Some(selected) = config
        .strategy_selections
        .get("Pingu Proxy")
        .cloned()
        .or(device_default)
    {
        selector["default-selected"] = json!(selected);
    }
    if !provider_names.is_empty() {
        selector["use"] = json!(provider_names);
    }
    groups.push(selector);
    let mut rules = Vec::new();
    for item in overrides.iter().filter(|i| i.enabled) {
        if item.resolver_mode != "inherit" {
            dns["nameserver-policy"][&item.host] = json!([dns_server(&item.resolver_mode)]);
        }
        if item.outbound_mode != "inherit" {
            rules.push(format!(
                "DOMAIN,{},{}",
                item.host,
                target(&item.outbound_mode)
            ));
        }
    }
    for policy in &group.nameserver_policy {
        let suffix = policy
            .domain_suffix
            .trim()
            .trim_start_matches("+.")
            .trim_start_matches('.');
        if !suffix.is_empty() {
            dns["nameserver-policy"][format!("+.{suffix}")] = json!(policy
                .normalized_servers()
                .iter()
                .map(|s| dns_server(s))
                .collect::<Vec<_>>());
        }
    }
    if !group.fake_ip_filter.is_empty() {
        let filters = dns
            .as_object_mut()
            .unwrap()
            .entry("fake-ip-filter")
            .or_insert_with(|| json!([]));
        if let Some(filters) = filters.as_array_mut() {
            filters.extend(group.fake_ip_filter.iter().map(|s| json!(s)));
        }
    }
    // Private destinations remain direct and local user rules are authoritative over imported rules.
    rules.extend(
        [
            "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve",
            "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve",
            "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
            "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    for rule in &group.rules {
        let t = target(&rule.outbound);
        match rule.rule_type.as_str() {
            "domain" => rules.push(format!("DOMAIN,{},{}", rule.match_value, t)),
            "domain_suffix" => rules.push(format!("DOMAIN-SUFFIX,{},{}", rule.match_value, t)),
            "ip_cidr" => rules.push(format!("IP-CIDR,{},{}", rule.match_value, t)),
            "geosite" | "geoip" => {
                let value = if rule.rule_type == "geosite" && rule.match_value == "geolocation-cn" {
                    "cn"
                } else {
                    &rule.match_value
                };
                if !value.is_empty()
                    && value
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '!')
                {
                    let key = format!("pingu-{}-{value}", rule.rule_type);
                    let behavior = if rule.rule_type == "geosite" {
                        "domain"
                    } else {
                        "ipcidr"
                    };
                    rule_providers.insert(key.clone(),json!({"type":"http","behavior":behavior,"format":"mrs","url":format!("https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/{}/{}.mrs",rule.rule_type,value),"path":format!("providers/{key}.mrs"),"proxy":"Pingu Proxy","interval":86400}));
                    rules.push(format!("RULE-SET,{key},{t}"));
                }
            }
            "ip_is_private" => {}
            _ => {}
        }
    }
    rules.extend(imported_rules);
    rules.push(if group.default_strategy == "direct" {
        "MATCH,DIRECT".into()
    } else {
        imported_default.unwrap_or_else(|| "MATCH,Pingu Proxy".into())
    });
    let mut value = json!({"mixed-port":port,"allow-lan":false,"bind-address":"127.0.0.1","mode":"rule","log-level":"info","ipv6":false,"external-controller":format!("127.0.0.1:{api}"),"secret":super::controller::secret(),"profile":{"store-selected":false,"store-fake-ip":false},"find-process-mode":"strict","dns":dns,"proxies":proxies,"proxy-groups":groups,"proxy-providers":proxy_providers,"rule-providers":rule_providers,"rules":rules});
    crate::chain::apply(config, &mut value)?;
    Ok(value)
}
#[cfg(test)]
mod tests;
