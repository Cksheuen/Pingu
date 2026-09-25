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

#[test]
fn test_parse_ws_device_node_preserves_path_host_alpn() {
    let uri = "vless://123e4567-e89b-12d3-a456-426614174000@device.example.com:443?security=tls&sni=device.example.com&fp=chrome&alpn=h2,http/1.1&type=ws&path=%2F__pingu_device__%2Fv1%2Fsecret-token%3Fmode%3Dauto&host=device.example.com#Web%20Device";
    let node = parse_vless_uri(uri).unwrap();
    assert_eq!(node.transport, "ws");
    // Decoded exactly once; embedded query string is preserved.
    assert_eq!(node.ws_path, "/__pingu_device__/v1/secret-token?mode=auto");
    assert_eq!(node.ws_host, "device.example.com");
    assert_eq!(node.alpn, vec!["h2", "http/1.1"]);
    assert_eq!(node.security, "tls");
    assert_eq!(node.name, "Web Device");
}

#[test]
fn test_old_persisted_node_loads_with_defaults() {
    // Node JSON saved before ws_path/ws_host/alpn existed (TCP/Reality).
    let legacy = serde_json::json!({
        "id": "old-id",
        "name": "Old Node",
        "address": "example.com",
        "port": 443,
        "uuid": "123e4567-e89b-12d3-a456-426614174000",
        "flow": "xtls-rprx-vision",
        "security": "reality",
        "sni": "www.example.com",
        "fingerprint": "chrome",
        "public_key": "AAAA",
        "short_id": "1234",
        "transport": "tcp"
    });
    let node: Node = serde_json::from_value(legacy).unwrap();
    assert_eq!(node.transport, "tcp");
    assert_eq!(node.security, "reality");
    assert!(node.ws_path.is_empty());
    assert!(node.ws_host.is_empty());
    assert!(node.alpn.is_empty());
}
