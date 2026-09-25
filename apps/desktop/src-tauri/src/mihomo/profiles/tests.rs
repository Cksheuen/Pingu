use super::*;
const URI:&str="vless://123e4567-e89b-12d3-a456-426614174000@example.com:443?security=tls&type=ws&path=%2Fws#One";
#[test]
fn parses_base64_multiple_protocols() {
    let encoded = STANDARD.encode(format!(
        "{URI}\ntrojan://secret@example.net:443?sni=example.net#Two"
    ));
    let (f, _) = parse_body(&encoded).unwrap();
    assert_eq!(f["proxies"].as_array().unwrap().len(), 2);
    assert_eq!(f["proxies"][0]["ws-opts"]["path"], "/ws");
    assert_eq!(f["proxies"][1]["type"], "trojan");
}
#[test]
fn accepts_provider_payload_and_retains_full_config_policy() {
    let(f,w)=parse_body("mixed-port: 1234\nexternal-controller: 0.0.0.0:9999\nsecret: attacker\ntun: {enable: true}\nproxies: [{name: A, type: socks5, server: example.com, port: 1080}]\nproxy-groups: [{name: Select, type: select, proxies: [A]}]\nrules: ['DOMAIN,example.com,Select', 'MATCH,Select']\ndns: {nameserver: ['1.1.1.1'], listen: '0.0.0.0:53'}").unwrap();
    assert_eq!(f["rules"].as_array().unwrap().len(), 2);
    assert_eq!(f["dns"]["nameserver"][0], "1.1.1.1");
    for k in ["mixed-port", "external-controller", "secret", "tun"] {
        assert!(f.get(k).is_none());
    }
    assert!(f["dns"].get("listen").is_none());
    assert!(w.iter().any(|w| w.contains("external-controller")));
}
#[test]
fn rejects_local_provider_and_file_credentials() {
    assert!(parse_body("proxy-providers: {local: {type: file, path: /etc/passwd}}").is_err());
    assert!(parse_body("proxies: [{name: A, type: socks5, server: localhost, port: 1080, private-key-path: /etc/passwd}]").is_err());
}
#[test]
fn rejects_unsafe_url_authority_boundaries() {
    for url in [
        "https://127.0.0.1/private",
        "https://[::1]/private",
        "https://localhost/private",
        "https://user:secret@example.com/private",
    ] {
        assert!(load_input(url).is_err(), "accepted unsafe fetch URL: {url}");
    }
    for url in [
        "https://10.0.0.1/provider",
        "https://metadata.localhost/provider",
        "https://[::1]/provider",
        "https://[::ffff:127.0.0.1]/provider",
        "https://:secret@example.com/provider",
    ] {
        let body = format!(
            "proxy-providers: {{remote: {{type: http, url: '{url}'}}}}"
        );
        assert!(parse_body(&body).is_err(), "accepted unsafe provider URL: {url}");
    }
}
#[test]
fn resolver_rejects_empty_private_and_mixed_answers() {
    let socket = |ip: &str| format!("{ip}:443").parse::<SocketAddr>().unwrap();
    assert!(reject_unsafe_addresses(vec![]).is_err());
    assert!(reject_unsafe_addresses(vec![socket("127.0.0.1")]).is_err());
    assert!(reject_unsafe_addresses(vec![
        socket("1.1.1.1"),
        socket("10.0.0.1")
    ])
    .is_err());
    assert_eq!(
        reject_unsafe_addresses(vec![socket("1.1.1.1"), socket("8.8.8.8")])
            .unwrap()
            .len(),
        2
    );
}
#[test]
fn isolates_remote_cache_path() {
    let(f,w)=parse_body("proxy-providers: {remote: {type: http, url: 'https://example.com/private?key=secret', path: /etc/passwd}}").unwrap();
    assert_eq!(
        f["proxy-providers"]["remote"]["path"],
        "providers/proxy-providers-0.cache"
    );
    assert!(w.iter().any(|warning| warning.contains(
        "Remote providers are downloaded and refreshed by Mihomo"
    )));
    assert!(!w.join(" ").contains("example.com"));
    assert!(!w.join(" ").contains("secret"));
}
#[test]
fn errors_and_summaries_do_not_expose_subscription_secrets() {
    let error = parse_body("trojan://top-secret@/%zz").unwrap_err();
    assert!(!error.contains("top-secret"));
    let s = Subscription {
        id: "id".into(),
        name: "Example".into(),
        input: "https://example.com/private?secret=value".into(),
        enabled: true,
        updated_at: String::new(),
        last_error: None,
        fragment: json!({}),
        warnings: vec![],
    };
    let rendered = serde_json::to_string(&s.summary()).unwrap();
    assert!(!rendered.contains("value"));
    assert!(!format!("{s:?}").contains("value"));
}
#[test]
fn rejects_duplicate_named_config_and_html() {
    assert!(parse_body("<html>private token</html>").is_err());
    assert!(parse_body("proxies: [{name: A, type: socks5}, {name: A, type: socks5}]").is_err());
}
#[test]
fn parses_common_uri_families() {
    for uri in [
        "ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@example.com:443#SS",
        "hy2://password@example.com:443?sni=example.com#HY",
        "socks5://user:password@example.com:1080#SOCKS",
    ] {
        assert!(parse_proxy_uri(uri).is_ok(), "{uri}");
    }
    let vmess=STANDARD.encode(r#"{"v":"2","ps":"VMess","add":"example.com","port":"443","id":"123e4567-e89b-12d3-a456-426614174000","net":"ws","tls":"tls","path":"/ws"}"#);
    assert_eq!(
        parse_proxy_uri(&format!("vmess://{vmess}")).unwrap()["ws-opts"]["path"],
        "/ws"
    );
}
