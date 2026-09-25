use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub uuid: String,
    pub flow: String,
    #[serde(default)]
    pub security: String,
    pub sni: String,
    pub fingerprint: String,
    pub public_key: String,
    pub short_id: String,
    pub transport: String,
    /// WebSocket path (percent-decoded exactly once). Empty for non-WS nodes.
    #[serde(default)]
    pub ws_path: String,
    /// WebSocket Host header. Empty for non-WS nodes.
    #[serde(default)]
    pub ws_host: String,
    /// TLS ALPN protocols advertised by the share link (e.g. ["h2", "http/1.1"]).
    #[serde(default)]
    pub alpn: Vec<String>,
    #[serde(default)]
    pub grpc_service_name: String,
    #[serde(default)]
    pub skip_cert_verify: bool,
}

pub fn parse_vless_uri(uri: &str) -> Result<Node, String> {
    if !uri.starts_with("vless://") {
        return Err("URI must start with vless://".into());
    }

    // url crate doesn't handle vless:// scheme directly, replace with https://
    let normalized = format!("https://{}", &uri[8..]);
    let parsed = Url::parse(&normalized).map_err(|e| format!("Failed to parse URI: {}", e))?;

    let uuid = parsed.username().to_string();
    if uuid.is_empty() {
        return Err("Missing UUID in URI".into());
    }
    uuid::Uuid::parse_str(&uuid).map_err(|_| "Invalid UUID in URI".to_string())?;

    let address = parsed.host_str().ok_or("Missing host in URI")?.to_string();

    let port = parsed.port().unwrap_or(443);

    // Parse query parameters
    let params: std::collections::HashMap<String, String> = parsed
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    let flow = params.get("flow").cloned().unwrap_or_default();
    let security = params.get("security").cloned().unwrap_or_default();
    let sni = params.get("sni").cloned().unwrap_or_default();
    let fingerprint = params.get("fp").cloned().unwrap_or_default();
    let public_key = params.get("pbk").cloned().unwrap_or_default();
    let short_id = params.get("sid").cloned().unwrap_or_default();
    let transport = params.get("type").cloned().unwrap_or("tcp".into());

    // WebSocket transport settings. `query_pairs` percent-decodes exactly once,
    // so an encoded device path like %2F__pingu_device__%2Fv1%2F<token> is
    // preserved as /__pingu_device__/v1/<token> without double decoding or
    // dropping any embedded query string.
    let ws_path = params.get("path").cloned().unwrap_or_default();
    let ws_host = params.get("host").cloned().unwrap_or_default();
    let alpn = params
        .get("alpn")
        .map(|value| {
            value
                .split(',')
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect()
        })
        .unwrap_or_default();

    // Name from fragment, URL-decoded
    let name = parsed.fragment().unwrap_or("unnamed").to_string();
    let name = percent_encoding::percent_decode_str(&name)
        .decode_utf8()
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| name);

    let id = uuid::Uuid::new_v4().to_string();

    Ok(Node {
        id,
        name,
        address,
        port,
        uuid,
        flow,
        security,
        sni,
        fingerprint,
        public_key,
        short_id,
        transport,
        ws_path,
        ws_host,
        alpn,
        grpc_service_name: params.get("serviceName").cloned().unwrap_or_default(),
        skip_cert_verify: params
            .get("allowInsecure")
            .or_else(|| params.get("insecure"))
            .map(|v| v == "1" || v == "true")
            .unwrap_or(false),
    })
}

#[cfg(test)]
mod tests;
