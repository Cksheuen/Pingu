use super::*;

const DEVICE_URI: &str = "vless://123e4567-e89b-12d3-a456-426614174000@device.example.com:443?security=tls&sni=device.example.com&type=ws&path=%2F__pingu_device__%2Fv1%2Fsecret-token&host=device.example.com#Web%20Device";

#[test]
fn parse_body_rejects_html() {
    let err = parse_subscription_body("<!DOCTYPE html><html><body>login required</body></html>")
        .unwrap_err();
    assert!(err.contains("HTML"));
    assert!(!err.contains("secret-token"));
    assert!(!err.contains("device.example.com"));
}

#[test]
fn parse_body_rejects_multiple_nodes_with_actionable_message() {
    let other = "vless://123e4567-e89b-12d3-a456-426614174001@other.example.net:443?type=tcp#Other";
    let body = format!("{}\n{}\n", DEVICE_URI, other);
    let err = parse_subscription_body(&body).unwrap_err();
    assert!(err.contains("2 node links"));
    // Error must not leak the device credential or URL.
    assert!(!err.contains("secret-token"));
    assert!(!err.contains("device.example.com"));
}

#[test]
fn parse_body_rejects_zero_nodes() {
    let err = parse_subscription_body("proxies: []\n").unwrap_err();
    assert!(err.contains("no vless://"));
}

#[test]
fn validate_rejects_html_content_type() {
    let err = validate_subscription_response(
        200,
        Some("text/html; charset=utf-8"),
        DEVICE_URI.as_bytes(),
    )
    .unwrap_err();
    assert!(err.contains("HTML"));
}

#[test]
fn validate_rejects_non_200_status() {
    let err =
        validate_subscription_response(401, Some("text/plain"), DEVICE_URI.as_bytes()).unwrap_err();
    assert!(err.contains("HTTP 401"));
    assert!(!err.contains("secret-token"));
}

#[test]
fn validate_rejects_empty_body() {
    let err = validate_subscription_response(200, Some("text/plain"), b"").unwrap_err();
    assert!(err.contains("empty"));
}

#[test]
fn validate_accepts_plain_text_single_node() {
    let body = format!("\n  {}\n\n", DEVICE_URI);
    let node = validate_subscription_response(200, Some("text/plain"), body.as_bytes()).unwrap();
    assert_eq!(node.transport, "ws");
    assert_eq!(node.ws_path, "/__pingu_device__/v1/secret-token");
    assert_eq!(node.ws_host, "device.example.com");
}

#[test]
fn read_bounded_enforces_size_limit() {
    let large = vec![b'a'; MAX_SUBSCRIPTION_BYTES + 1];
    let mut cursor = std::io::Cursor::new(large);
    let err = read_bounded(&mut cursor, MAX_SUBSCRIPTION_BYTES).unwrap_err();
    assert!(err.contains("64 KiB"));
}

#[test]
fn read_bounded_accepts_limit_sized_body() {
    let exact = vec![b'a'; MAX_SUBSCRIPTION_BYTES];
    let mut cursor = std::io::Cursor::new(exact);
    assert_eq!(
        read_bounded(&mut cursor, MAX_SUBSCRIPTION_BYTES)
            .unwrap()
            .len(),
        MAX_SUBSCRIPTION_BYTES
    );
}

#[test]
fn resolve_rejects_non_vless_non_https_input() {
    let err = resolve_import_node("not-a-link").unwrap_err();
    assert!(err.contains("vless://"));
    assert!(err.contains("https://"));
    assert!(err.contains("Clash YAML"));
}

#[test]
fn resolve_rejects_plain_http_subscription() {
    let err = resolve_import_node("http://example.com/sub").unwrap_err();
    assert!(err.contains("https://"));
    assert!(!err.contains("example.com"));
}

#[test]
fn resolve_passes_direct_vless_through() {
    let node = resolve_import_node(DEVICE_URI).unwrap();
    assert_eq!(node.name, "Web Device");
}
