use super::*;

#[test]
fn parses_enabled_local_proxy_settings() {
    let settings = parse_proxy_settings(
        "Enabled: Yes\nServer: 127.0.0.1\nPort: 2080\nAuthenticated Proxy Enabled: 0\n",
    );

    assert_eq!(
        settings,
        ProxySettings {
            enabled: true,
            server: "127.0.0.1".to_string(),
            port: Some(2080),
        }
    );
}
