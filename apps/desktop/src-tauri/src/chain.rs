//! User-owned two-hop routes. Source fragments and credentials stay intact.
use crate::storage::app_config::AppConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
pub mod latency;
pub mod probe;
pub const ENTRY: &str = "Pingu Chain Entry";
pub const EXIT: &str = "Pingu Chain";
pub const SINGLE_EXIT: &str = "Pingu Chain Exit Only";
pub const ROUTE: &str = "Pingu Chain Route";
pub const HEALTH_URL: &str = "https://www.gstatic.com/generate_204";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NodeRef {
    Manual {
        node_id: String,
    },
    Subscription {
        subscription_id: String,
        proxy_name: String,
    },
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChainSettings {
    pub enabled: bool,
    pub entry: Option<NodeRef>,
    pub exit: Option<NodeRef>,
}
#[derive(Clone, Serialize)]
pub struct Choice {
    pub reference: NodeRef,
    pub name: String,
    pub source: String,
    pub protocol: String,
    pub unavailable_reason: Option<String>,
}
fn unsupported(p: &Value) -> Option<String> {
    let name = p["name"].as_str().unwrap_or("");
    if ["剩余流量", "套餐到期", "官网", "包含 x"]
        .iter()
        .any(|prefix| name.starts_with(prefix))
    {
        return Some("Subscription information, not a selectable node.".into());
    }
    if p.get("dialer-proxy")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        return Some("This node already has a dialer proxy; choose a standalone node.".into());
    }
    if !matches!(
        p["type"].as_str(),
        Some(
            "vless"
                | "vmess"
                | "ss"
                | "trojan"
                | "hysteria2"
                | "hysteria"
                | "tuic"
                | "socks5"
                | "http"
        )
    ) {
        return Some("This protocol is not supported in a two-hop route yet.".into());
    }
    if p["server"].as_str().is_none_or(str::is_empty) {
        return Some("This entry has no proxy server.".into());
    }
    None
}
pub fn choices(config: &AppConfig) -> Vec<Choice> {
    let mut result = Vec::new();
    for n in &config.nodes {
        result.push(Choice {
            reference: NodeRef::Manual {
                node_id: n.id.clone(),
            },
            name: n.name.clone(),
            source: "Personal VPS".into(),
            protocol: "vless".into(),
            unavailable_reason: None,
        });
    }
    for s in config.subscriptions.iter().filter(|s| s.enabled) {
        if let Some(nodes) = s.fragment["proxies"].as_array() {
            for p in nodes {
                if let Some(name) = p["name"].as_str() {
                    result.push(Choice {
                        reference: NodeRef::Subscription {
                            subscription_id: s.id.clone(),
                            proxy_name: name.into(),
                        },
                        name: name.into(),
                        source: s.name.clone(),
                        protocol: p["type"].as_str().unwrap_or("unknown").into(),
                        unavailable_reason: unsupported(p),
                    });
                }
            }
        }
    }
    result
}
pub fn resolve(config: &AppConfig, reference: &NodeRef) -> Result<Value, String> {
    let p = match reference {
        NodeRef::Manual { node_id } => config
            .nodes
            .iter()
            .find(|n| &n.id == node_id)
            .map(crate::mihomo::config_gen::node_proxy),
        NodeRef::Subscription {
            subscription_id,
            proxy_name,
        } => config
            .subscriptions
            .iter()
            .find(|s| &s.id == subscription_id && s.enabled)
            .and_then(|s| s.fragment["proxies"].as_array())
            .and_then(|ps| ps.iter().find(|p| p["name"].as_str() == Some(proxy_name)))
            .cloned(),
    }
    .ok_or("A selected chain node was removed or its subscription is disabled. Choose it again.")?;
    if let Some(error) = unsupported(&p) {
        return Err(error);
    }
    Ok(p)
}
pub fn pair(config: &AppConfig, settings: &ChainSettings) -> Result<(Value, Value), String> {
    let a = settings.entry.as_ref().ok_or("Choose an entry node.")?;
    let b = settings.exit.as_ref().ok_or("Choose an exit node.")?;
    if a == b {
        return Err("Entry and exit must be different nodes.".into());
    }
    let entry = resolve(config, a)?;
    let exit = resolve(config, b)?;
    if entry["server"] == exit["server"] && entry["port"] == exit["port"] {
        return Err("Entry and exit point to the same server and port.".into());
    }
    if matches!(
        exit["type"].as_str(),
        Some("hysteria" | "hysteria2" | "tuic")
    ) && (entry["type"] == "http" || entry["udp"] == false)
    {
        return Err("The exit uses UDP but the entry does not support UDP forwarding.".into());
    }
    Ok((entry, exit))
}
pub fn named_pair(mut entry: Value, mut exit: Value) -> Vec<Value> {
    entry["name"] = json!(ENTRY);
    exit["name"] = json!(EXIT);
    exit["dialer-proxy"] = json!(ENTRY);
    vec![entry, exit]
}
/// Prefer the chain, then each standalone node. Health checks run in the core,
/// independent of UI polling, and recovery restores the first healthy candidate.
pub fn apply(config: &AppConfig, value: &mut Value) -> Result<(), String> {
    if !config.proxy_chain.enabled {
        return Ok(());
    }
    let (entry, exit) = pair(config, &config.proxy_chain)?;
    let mut mapping = std::collections::HashMap::new();
    for key in ["proxies", "proxy-groups"] {
        for p in value[key].as_array().into_iter().flatten() {
            if let Some(name) = p["name"].as_str() {
                mapping.insert(name.to_owned(), ROUTE.to_owned());
            }
        }
    }
    if let Some(rules) = value["rules"].as_array_mut() {
        for r in rules {
            if let Some(rule) = r.as_str() {
                *r = json!(crate::mihomo::config_gen::rewrite_rule(rule, &mapping));
            }
        }
    }
    let mut single_exit = exit.clone();
    single_exit["name"] = json!(SINGLE_EXIT);
    value["proxies"]
        .as_array_mut()
        .ok_or("Missing proxy configuration")?
        .extend(named_pair(entry, exit));
    value["proxies"].as_array_mut().unwrap().push(single_exit);
    value["proxy-groups"]
        .as_array_mut()
        .ok_or("Missing proxy groups")?
        .push(json!({
            "name": ROUTE, "type": "fallback", "proxies": [EXIT, SINGLE_EXIT, ENTRY],
            "url": HEALTH_URL, "interval": 10, "timeout": 4000,
            "lazy": false, "max-failed-times": 1, "expected-status": 204,
            "hidden": true
        }));
    if let Some(providers) = value["rule-providers"].as_object_mut() {
        for provider in providers.values_mut() {
            if provider["proxy"]
                .as_str()
                .is_some_and(|name| mapping.contains_key(name))
            {
                provider["proxy"] = json!(ROUTE);
            }
        }
    }
    Ok(())
}

#[derive(Debug, Serialize, PartialEq)]
pub struct RuntimeRoute {
    pub route: String,
    pub checked_at: Option<String>,
}
/// A fallback group still reports its first member when all members are dead.
/// Read the actual selected member's URL-specific health, not just `now`.
pub fn runtime_route(body: &Value) -> RuntimeRoute {
    let map = &body["proxies"];
    let Some(now) = map[ROUTE]["now"].as_str() else {
        return RuntimeRoute {
            route: "checking".into(),
            checked_at: None,
        };
    };
    let health = &map[now]["extra"][HEALTH_URL];
    let last = health["history"].as_array().and_then(|h| h.last());
    let checked_at = last.and_then(|v| v["time"].as_str()).map(str::to_owned);
    let route = if checked_at.is_none() {
        "checking"
    } else if health["alive"] == false || last.is_some_and(|v| v["delay"] == 0) {
        "unavailable"
    } else {
        match now {
            EXIT => "chain",
            SINGLE_EXIT => "exit",
            ENTRY => "entry",
            _ => "checking",
        }
    };
    RuntimeRoute {
        route: route.into(),
        checked_at,
    }
}
/// A rejected automatic chain leaves no entry selected and pins the chosen
/// standalone exit in the normal selector, including subscription exits.
pub fn use_single_exit(config: &mut AppConfig, exit: NodeRef) -> Result<(), String> {
    resolve(config, &exit)?;
    let name = match &exit {
        NodeRef::Manual { node_id } => {
            let node = config
                .nodes
                .iter()
                .find(|n| &n.id == node_id)
                .ok_or("Exit removed")?;
            let name = format!("{} [{}]", node.name, node.id);
            config.active_node_id = Some(node_id.clone());
            name
        }
        NodeRef::Subscription {
            subscription_id,
            proxy_name,
        } => {
            let source = config
                .subscriptions
                .iter()
                .find(|s| &s.id == subscription_id)
                .ok_or("Exit removed")?;
            format!(
                "{} [{}] / {}",
                source.name,
                &source.id[..source.id.len().min(8)],
                proxy_name
            )
        }
    };
    config
        .strategy_selections
        .insert("Pingu Proxy".into(), name);
    config.proxy_chain = ChainSettings {
        enabled: false,
        entry: None,
        exit: Some(exit),
    };
    Ok(())
}
/// Only app-owned Reality nodes use the configured Gate; never infer an endpoint.
pub fn exit_needs_gate(config: &AppConfig, settings: &ChainSettings) -> bool {
    match &settings.exit {
        Some(NodeRef::Manual { node_id }) => config
            .nodes
            .iter()
            .any(|n| &n.id == node_id && n.security == "reality"),
        _ => false,
    }
}
pub fn prepare_gate(config: &AppConfig) -> Result<(), String> {
    if !config.proxy_chain.enabled {
        return crate::gate::renew_if_enabled().map(|_| ());
    }
    let (entry, _) = pair(config, &config.proxy_chain)?;
    if let Some(NodeRef::Manual { node_id }) = &config.proxy_chain.entry {
        if config
            .nodes
            .iter()
            .any(|n| &n.id == node_id && n.security == "reality")
        {
            crate::gate::renew_if_enabled()?;
        }
    }
    if exit_needs_gate(config, &config.proxy_chain) && crate::gate::get_settings()?.enabled {
        crate::gate::renew_if_enabled()?;
        let runtime = probe::IsolatedRuntime::single(entry)?;
        crate::gate::renew_through_proxy(runtime.port)?;
    }
    Ok(())
}
#[cfg(test)]
mod tests;
