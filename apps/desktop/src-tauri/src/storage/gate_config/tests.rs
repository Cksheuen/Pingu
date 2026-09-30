use super::*;

#[test]
fn serde_defaults_keep_partial_gate_config_compatible() {
    let config: GateConfig =
        serde_json::from_str(r#"{"endpoint":"https://example.com/lease"}"#).unwrap();

    assert!(!config.enabled);
    assert!(!config.configured());
    assert!(config.last_error.is_none());
}
