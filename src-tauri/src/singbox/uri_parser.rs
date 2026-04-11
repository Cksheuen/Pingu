use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_vless_uri() {
        let uri = "vless://123e4567-e89b-12d3-a456-426614174000@example.com:443?flow=xtls-rprx-vision&security=reality&sni=www.example.com&fp=chrome&pbk=AAAA&sid=1234&type=tcp#My%20Node";
        let node = parse_vless_uri(uri).unwrap();
        assert_eq!(node.uuid, "123e4567-e89b-12d3-a456-426614174000");
        assert_eq!(node.address, "example.com");
        assert_eq!(node.port, 443);
        assert_eq!(node.flow, "xtls-rprx-vision");
        assert_eq!(node.security, "reality");
        assert_eq!(node.sni, "www.example.com");
        assert_eq!(node.fingerprint, "chrome");
        assert_eq!(node.public_key, "AAAA");
        assert_eq!(node.short_id, "1234");
        assert_eq!(node.transport, "tcp");
        assert_eq!(node.name, "My Node");
    }

    #[test]
    fn test_invalid_scheme() {
        let result = parse_vless_uri("http://example.com");
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_uuid() {
        let result = parse_vless_uri("vless://not-a-uuid@example.com:443?type=tcp#Bad");
        assert!(result.is_err());
    }
}
