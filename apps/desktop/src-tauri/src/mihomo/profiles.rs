//! Bounded subscription ingestion. Only routing data crosses into app-owned runtime configs.
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::Duration;
use url::Url;

pub const MAX_BYTES: usize = 4 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
pub struct Subscription {
    #[serde(default)]
    pub nodes_only: bool,
    pub id: String,
    pub name: String,
    pub input: String,
    pub enabled: bool,
    pub updated_at: String,
    pub last_error: Option<String>,
    pub fragment: Value,
    pub warnings: Vec<String>,
}
impl std::fmt::Debug for Subscription {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Subscription")
            .field("id", &self.id)
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct SubscriptionSummary {
    pub nodes_only: bool,
    pub id: String,
    pub name: String,
    pub source_kind: String,
    pub source_host: Option<String>,
    pub enabled: bool,
    pub proxy_count: usize,
    pub group_count: usize,
    pub rule_count: usize,
    pub updated_at: String,
    pub last_error: Option<String>,
    pub warnings: Vec<String>,
}
impl Subscription {
    pub fn summary(&self) -> SubscriptionSummary {
        let url = Url::parse(&self.input)
            .ok()
            .filter(|u| u.scheme() == "https");
        SubscriptionSummary {
            nodes_only: self.nodes_only,
            id: self.id.clone(),
            name: self.name.clone(),
            source_kind: if url.is_some() { "url" } else { "inline" }.into(),
            source_host: url.and_then(|u| u.host_str().map(str::to_string)),
            enabled: self.enabled,
            proxy_count: self.fragment["proxies"].as_array().map_or(0, Vec::len),
            group_count: self.fragment["proxy-groups"].as_array().map_or(0, Vec::len),
            rule_count: self.fragment["rules"].as_array().map_or(0, Vec::len),
            updated_at: self.updated_at.clone(),
            last_error: self.last_error.clone(),
            warnings: self.warnings.clone(),
        }
    }
}
pub fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 120 || name.chars().any(char::is_control) {
        return Err("Subscription name must contain 1–120 printable bytes.".into());
    }
    Ok(name.into())
}
pub fn load_input(input: &str) -> Result<(Value, Vec<String>), String> {
    let input = input.trim();
    if input.starts_with("https://") && !input.contains('\n') {
        validate_https_url(input, "Subscription")?;
        let agent = subscription_fetch_agent(Duration::from_secs(20));
        let response = agent
            .get(input)
            .set("User-Agent", "Pingu/mihomo")
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(code, _) => {
                    format!("Subscription server returned HTTP {code}.")
                }
                _ => "Subscription request failed. Check network access and the saved URL.".into(),
            })?;
        if response.status() != 200 {
            return Err(format!(
                "Subscription server returned HTTP {}. Redirects are not followed.",
                response.status()
            ));
        }
        // Some subscription panels label YAML as text/html. Validate the bounded
        // body below: parse_body rejects actual HTML and accepts only routing data.
        let mut body = Vec::new();
        response
            .into_reader()
            .take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut body)
            .map_err(|_| "Failed to read subscription.")?;
        let text = std::str::from_utf8(&body).map_err(|_| "Subscription is not UTF-8 text.")?;
        parse_body(text)
    } else {
        parse_body(input)
    }
}

pub(super) fn validate_https_url(input: &str, label: &str) -> Result<Url, String> {
    let url = Url::parse(input).map_err(|_| format!("Invalid {label} HTTPS URL."))?;
    let host = url
        .host_str()
        .ok_or_else(|| format!("Invalid {label} URL authority."))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || unsafe_hostname(host)
    {
        return Err(format!(
            "{label} URLs must use HTTPS without embedded credentials or local/private destinations."
        ));
    }
    Ok(url)
}

pub(super) fn subscription_fetch_agent(timeout: Duration) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(timeout)
        // Subscription fetching must use the URL authority we validate;
        // inherited HTTP(S)_PROXY settings would move the connection to an
        // unvalidated destination and bypass the resolver boundary below.
        .try_proxy_from_env(false)
        // Resolve once inside ureq and reject the entire answer set if it
        // contains a loopback/private/link-local address. The vetted
        // SocketAddrs are the ones ureq connects to, closing the usual
        // validate-then-resolve DNS rebinding gap for the initial fetch.
        .resolver(resolve_public_addresses)
        .build()
}

fn resolve_public_addresses(netloc: &str) -> std::io::Result<Vec<SocketAddr>> {
    reject_unsafe_addresses(netloc.to_socket_addrs()?.collect())
}

fn reject_unsafe_addresses(addresses: Vec<SocketAddr>) -> std::io::Result<Vec<SocketAddr>> {
    if addresses.is_empty()
        || addresses
            .iter()
            .any(|address| !is_allowed_remote_ip(address.ip()))
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "subscription destination resolved to a local or private address",
        ));
    }
    Ok(addresses)
}

fn unsafe_hostname(host: &str) -> bool {
    let host = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| !is_allowed_remote_ip(address))
}

/// Reject destinations that can reach the local host/network or are explicitly
/// special-use. This is an SSRF boundary, not a general Internet-routability
/// classifier; ordinary globally scoped addresses remain compatible.
fn is_allowed_remote_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [a, b, c, _] = address.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 192 && b == 0 && c == 2)
                || (a == 192 && b == 168)
                || (a == 198 && (b == 18 || b == 19))
                || (a == 198 && b == 51 && c == 100)
                || (a == 203 && b == 0 && c == 113)
                || a >= 224)
        }
        IpAddr::V6(address) => {
            if let Some(address) = address.to_ipv4_mapped() {
                return is_allowed_remote_ip(IpAddr::V4(address));
            }
            let segments = address.segments();
            let unique_local = (segments[0] & 0xfe00) == 0xfc00;
            let link_or_site_local =
                (segments[0] & 0xffc0) == 0xfe80 || (segments[0] & 0xffc0) == 0xfec0;
            let documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
            let discard_only =
                segments[0] == 0x0100 && segments[1] == 0 && segments[2] == 0 && segments[3] == 0;
            !(address.is_unspecified()
                || address.is_loopback()
                || address.is_multicast()
                || unique_local
                || link_or_site_local
                || documentation
                || discard_only)
        }
    }
}
pub fn decode_base64(value: &str) -> Result<String, String> {
    let compact: String = value.chars().filter(|c| !c.is_whitespace()).collect();
    for engine in [&STANDARD, &STANDARD_NO_PAD, &URL_SAFE, &URL_SAFE_NO_PAD] {
        if let Ok(bytes) = engine.decode(&compact) {
            if let Ok(s) = String::from_utf8(bytes) {
                return Ok(s);
            }
        }
    }
    Err("Invalid base64 subscription content.".into())
}
pub fn parse_body(body: &str) -> Result<(Value, Vec<String>), String> {
    if body.len() > MAX_BYTES {
        return Err("Subscription exceeds the 4 MiB limit.".into());
    }
    let body = body.trim_start_matches('\u{feff}').trim();
    if body.is_empty() || body.starts_with('<') {
        return Err("Subscription is empty or contains HTML.".into());
    }
    if let Ok(value) = serde_yaml::from_str::<Value>(body) {
        if value.is_object() {
            return sanitize_fragment(value);
        }
    }
    let decoded;
    let text = if body.lines().any(|l| l.trim().contains("://")) {
        body
    } else {
        decoded = decode_base64(body)?;
        decoded.as_str()
    };
    let mut proxies = Vec::new();
    for line in text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        if proxies.len() >= 2000 {
            return Err("Subscription exceeds 2000 proxies.".into());
        }
        proxies.push(parse_proxy_uri(line).map_err(|_|format!("Invalid or unsupported proxy URI at entry {}. Use Mihomo YAML for unsupported protocols/options.",proxies.len()+1))?);
    }
    // URI subscriptions frequently reuse display names; preserve each node using stable occurrence suffixes.
    let mut names = std::collections::HashSet::new();
    for (i, p) in proxies.iter_mut().enumerate() {
        let n = p["name"].as_str().unwrap_or("Node").to_string();
        if !names.insert(n.clone()) {
            p["name"] = json!(format!("{n} ({})", i + 1));
        }
    }
    sanitize_fragment(json!({"proxies":proxies}))
}
fn sanitize_fragment(value: Value) -> Result<(Value, Vec<String>), String> {
    let object = value
        .as_object()
        .ok_or("Expected a Mihomo configuration or proxy provider.")?;
    let allowed = [
        "proxies",
        "proxy-groups",
        "proxy-providers",
        "rule-providers",
        "rules",
        "dns",
    ];
    let mut fragment = serde_json::Map::new();
    let mut warnings = Vec::new();
    for (key, value) in object {
        if allowed.contains(&key.as_str()) {
            fragment.insert(key.clone(), value.clone());
        } else {
            warnings.push(format!("App-owned or unsupported setting omitted: {key}"));
        }
    }
    let mut fragment = Value::Object(fragment);
    if fragment.get("rules").is_some() {
        warnings.push("Local host/routing overrides take precedence. Across enabled sources, specific rules retain source order; the first source MATCH supplies the shared default.".into());
    }
    if fragment.get("dns").is_some() {
        warnings.push("DNS settings are merged in enabled-source order (later scalar settings win); local DNS policies take precedence.".into());
    }
    let proxies = fragment.get("proxies").and_then(Value::as_array);
    let providers = fragment.get("proxy-providers").and_then(Value::as_object);
    if proxies.map_or(true, Vec::is_empty) && providers.map_or(true, serde_json::Map::is_empty) {
        return Err("Subscription has no proxies or proxy providers.".into());
    }
    let mut names = std::collections::HashSet::new();
    for key in ["proxies", "proxy-groups"] {
        if let Some(items) = fragment.get(key) {
            let items = items
                .as_array()
                .ok_or("Proxy/group collection must be an array.")?;
            if items.len() > 2000 {
                return Err("Too many proxies or groups.".into());
            }
            for item in items {
                let name = item["name"]
                    .as_str()
                    .ok_or("Each proxy/group needs a name.")?;
                if name.is_empty()
                    || name.len() > 200
                    || name.contains(',')
                    || name.chars().any(char::is_control)
                    || !names.insert(name.to_string())
                {
                    return Err(
                        "Proxy/group names must be unique, printable and cannot contain commas."
                            .into(),
                    );
                }
                if item.get("type").and_then(Value::as_str).is_none() {
                    return Err("Each proxy/group needs a type.".into());
                }
                reject_external_paths(item)?;
                if key == "proxies"
                    && matches!(item["type"].as_str(), Some("ss"))
                    && item.get("plugin").is_some()
                    && !matches!(
                        item["plugin"].as_str(),
                        Some("obfs" | "v2ray-plugin" | "shadow-tls" | "restls")
                    )
                {
                    return Err("Unsupported Shadowsocks plugin.".into());
                }
            }
        }
    }
    if let Some(rules) = fragment.get("rules") {
        let rules = rules.as_array().ok_or("Rules must be an array.")?;
        if rules.len() > 20000 || rules.iter().any(|r| r.as_str().is_none()) {
            return Err("Rules must contain at most 20000 strings.".into());
        }
    }
    for key in ["proxy-providers", "rule-providers"] {
        if let Some(providers) = fragment.get_mut(key) {
            let providers = providers
                .as_object_mut()
                .ok_or("Providers must be a mapping.")?;
            if providers.len() > 100 {
                return Err("Too many remote providers.".into());
            }
            for (index, (_, provider)) in providers.iter_mut().enumerate() {
                let obj = provider.as_object_mut().ok_or("Invalid provider.")?;
                if obj.get("type").and_then(Value::as_str) != Some("http") {
                    return Err("Only HTTPS remote providers are accepted; local file providers cannot be imported.".into());
                }
                let raw_url = obj
                    .get("url")
                    .and_then(Value::as_str)
                    .ok_or("Provider URL missing.")?;
                validate_https_url(raw_url, "Remote provider")?;
                obj.insert(
                    "path".into(),
                    json!(format!("providers/{key}-{index}.cache")),
                );
            }
        }
    }
    if ["proxy-providers", "rule-providers"].iter().any(|key| {
        fragment
            .get(key)
            .and_then(Value::as_object)
            .is_some_and(|providers| !providers.is_empty())
    }) {
        warnings.push("Remote providers are downloaded and refreshed by Mihomo. Use only trusted subscription sources; later provider DNS and redirects are outside the app fetch address checks.".into());
    }
    if let Some(dns) = fragment.get_mut("dns") {
        let obj = dns.as_object_mut().ok_or("DNS must be a mapping.")?;
        let allowed = [
            "nameserver",
            "fallback",
            "default-nameserver",
            "proxy-server-nameserver",
            "direct-nameserver",
            "nameserver-policy",
            "fallback-filter",
            "fake-ip-filter",
            "fake-ip-filter-mode",
            "enhanced-mode",
            "fake-ip-range",
            "respect-rules",
            "ipv6",
            "use-hosts",
            "use-system-hosts",
        ];
        obj.retain(|key, _| {
            let keep = allowed.contains(&key.as_str());
            if !keep {
                warnings.push(format!(
                    "App-owned or unsupported DNS setting omitted: {key}"
                ));
            }
            keep
        });
    }
    Ok((fragment, warnings))
}
fn reject_external_paths(v: &Value) -> Result<(), String> {
    match v {
        Value::Object(o) => {
            for (k, v) in o {
                if [
                    "private-key-path",
                    "certificate-path",
                    "ca",
                    "ca-file",
                    "client-cert",
                    "client-key",
                    "script",
                    "config-path",
                ]
                .contains(&k.as_str())
                {
                    return Err("Subscription contains a local-file or script setting.".into());
                }
                reject_external_paths(v)?;
            }
        }
        Value::Array(a) => {
            for v in a {
                reject_external_paths(v)?;
            }
        }
        _ => {}
    }
    Ok(())
}
fn decoded(value: &str) -> String {
    percent_encoding::percent_decode_str(value)
        .decode_utf8_lossy()
        .into_owned()
}
pub fn parse_proxy_uri(uri: &str) -> Result<Value, String> {
    if uri.starts_with("vless://") {
        return Ok(super::config_gen::node_proxy(
            &super::uri_parser::parse_vless_uri(uri)?,
        ));
    }
    if let Some(encoded) = uri.strip_prefix("vmess://") {
        let v: Value =
            serde_json::from_str(&decode_base64(encoded)?).map_err(|_| "Invalid VMess payload")?;
        let number = |k: &str, default: u64| {
            v[k].as_u64()
                .or_else(|| v[k].as_str().and_then(|s| s.parse().ok()))
                .unwrap_or(default)
        };
        let mut p = json!({"name":v["ps"].as_str().unwrap_or("VMess"),"type":"vmess","server":v["add"],"port":number("port",443),"uuid":v["id"],"alterId":number("aid",0),"cipher":v["scy"].as_str().unwrap_or("auto"),"tls":v["tls"].as_str()==Some("tls"),"servername":v["sni"].as_str().or_else(||v["host"].as_str()).unwrap_or(""),"udp":true});
        let network = v["net"].as_str().unwrap_or("tcp");
        p["network"] = json!(network);
        if network == "ws" {
            p["ws-opts"] = json!({"path":v["path"].as_str().unwrap_or("/"),"headers":{"Host":v["host"].as_str().unwrap_or("")}});
        }
        if network == "grpc" {
            p["grpc-opts"] = json!({"grpc-service-name":v["path"].as_str().unwrap_or("")});
        }
        return Ok(p);
    }
    if let Some(rest) = uri.strip_prefix("ss://") {
        let (rest, frag) = rest.split_once('#').unwrap_or((rest, "Shadowsocks"));
        let all;
        if !rest.contains('@') {
            all = decode_base64(rest)?;
        } else {
            all = rest.into();
        }
        let (auth, addr) = all.rsplit_once('@').ok_or("Invalid Shadowsocks URI")?;
        let auth = if auth.contains(':') {
            decoded(auth)
        } else {
            decode_base64(&decoded(auth))?
        };
        let (method, password) = auth
            .split_once(':')
            .ok_or("Invalid Shadowsocks credentials")?;
        let u = Url::parse(&format!("http://{addr}")).map_err(|_| "Invalid Shadowsocks server")?;
        if u.query().is_some() {
            return Err("Use YAML for Shadowsocks plugin options".into());
        }
        return Ok(
            json!({"name":decoded(frag),"type":"ss","server":u.host_str().ok_or("Missing server")?,"port":u.port().ok_or("Missing port")?,"cipher":method,"password":password,"udp":true}),
        );
    }
    let u = Url::parse(uri).map_err(|_| "Invalid proxy URI")?;
    let q: std::collections::HashMap<_, _> = u.query_pairs().collect();
    let name = u
        .fragment()
        .map(decoded)
        .unwrap_or_else(|| u.host_str().unwrap_or("Proxy").into());
    let kind = match u.scheme() {
        "trojan" => "trojan",
        "hy2" | "hysteria2" => "hysteria2",
        "socks" | "socks5" => "socks5",
        "http" | "https" => "http",
        _ => return Err("Unsupported proxy protocol".into()),
    };
    let mut p = json!({"name":name,"type":kind,"server":u.host_str().ok_or("Missing proxy server")?,"port":u.port().unwrap_or(443),"udp":true});
    if kind == "http" || kind == "socks5" {
        p["username"] = json!(decoded(u.username()));
        p["password"] = json!(u.password().map(decoded).unwrap_or_default());
        p["tls"] = json!(u.scheme() == "https");
    } else {
        p["password"] = json!(decoded(u.username()));
        p["sni"] = json!(q.get("sni").map(|s| s.as_ref()).unwrap_or(""));
        p["skip-cert-verify"] = json!(q.get("insecure").map(|s| s == "1").unwrap_or(false));
    }
    if let Some(network) = q.get("type") {
        p["network"] = json!(network);
        if network == "ws" {
            p["ws-opts"] = json!({"path":q.get("path").map(|s|s.as_ref()).unwrap_or("/"),"headers":{"Host":q.get("host").map(|s|s.as_ref()).unwrap_or("")}});
        }
    }
    if kind == "hysteria2" {
        if let Some(obfs) = q.get("obfs") {
            p["obfs"] = json!(obfs);
        }
        if let Some(pass) = q.get("obfs-password") {
            p["obfs-password"] = json!(pass);
        }
    }
    Ok(p)
}
#[cfg(test)]
mod tests;
