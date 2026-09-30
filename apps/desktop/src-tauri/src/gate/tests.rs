use super::*;

#[test]
fn access_link_is_normalized_to_secret_free_lease_endpoint() {
    let (endpoint, token) =
        parse_access_link("https://cksheuen.site/__pingu_gate__/allow?token=secret-value&ttl=7d")
            .unwrap();

    assert_eq!(endpoint, "https://cksheuen.site/__pingu_gate__/lease");
    assert_eq!(token, "secret-value");
    assert!(!endpoint.contains("secret-value"));
}

#[test]
fn base_access_link_is_normalized_to_lease_endpoint() {
    let (endpoint, _) =
        parse_access_link("https://cksheuen.site/__pingu_gate__/?token=secret-value").unwrap();

    assert_eq!(endpoint, "https://cksheuen.site/__pingu_gate__/lease");
}

#[test]
fn insecure_or_tokenless_links_are_rejected() {
    assert!(parse_access_link("http://example.com/gate?token=secret").is_err());
    assert!(parse_access_link("https://example.com/gate").is_err());
}

#[test]
fn settings_contract_does_not_expose_token() {
    let config = GateConfig {
        enabled: true,
        endpoint: "https://example.com/lease".to_string(),
        token: "never-return-this".to_string(),
        last_ip: Some("198.51.100.10".to_string()),
        lease_expires_at: Some("2026-08-10T15:30:00+00:00".to_string()),
        last_error: None,
    };

    let serialized = serde_json::to_string(&GateSettings::from(&config)).unwrap();
    assert!(!serialized.contains("never-return-this"));
}
