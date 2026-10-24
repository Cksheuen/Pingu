use super::*;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pingu-rule-cache-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn get(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

#[test]
fn cached_rule_set_is_fetched_from_loopback_without_the_proxy() {
    let remote = "https://example.com/geo/geoip/cn.mrs";
    let cached = provider_entry("pingu-geoip-cn", remote, "ipcidr", Some(4321));
    assert_eq!(cached["url"], "http://127.0.0.1:4321/pingu-geoip-cn.mrs");
    assert_eq!(cached["proxy"], "DIRECT");
    assert_eq!(cached["path"], "providers/pingu-geoip-cn.mrs");

    let uncached = provider_entry("pingu-geoip-cn", remote, "ipcidr", None);
    assert_eq!(uncached["url"], remote);
    assert_eq!(uncached["proxy"], "Pingu Proxy");
}

#[test]
fn loopback_server_serves_only_cached_rule_sets() {
    let dir = temp_dir("serve");
    std::fs::write(dir.join("pingu-geosite-cn.mrs"), b"rules").unwrap();
    std::fs::write(dir.join("secret.txt"), b"private").unwrap();
    let port = serve(dir.clone()).unwrap();

    let found = get(port, "/pingu-geosite-cn.mrs");
    assert!(found.starts_with("HTTP/1.1 200"));
    assert!(found.ends_with("\r\n\r\nrules"));
    for path in ["/secret.txt", "/../secret.txt", "/pingu-missing.mrs", "/pingu-..%2Fsecret.mrs"] {
        assert!(get(port, path).starts_with("HTTP/1.1 404"), "{path} must not be served");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn refresh_replaces_only_stale_copies_with_valid_rule_sets() {
    let dir = temp_dir("refresh");
    let sources = BTreeMap::from([
        ("pingu-geoip-cn".to_string(), "geoip".to_string()),
        ("pingu-geosite-cn".to_string(), "geosite".to_string()),
        ("pingu-geosite-ads".to_string(), "portal".to_string()),
    ]);
    std::fs::write(dir.join("pingu-geoip-cn.mrs"), b"fresh").unwrap();
    let valid = [&ZSTD_MAGIC[..], b"rules"].concat();
    let fetched = Mutex::new(Vec::new());

    refresh_in(&dir, &sources, SystemTime::now(), |url| {
        fetched.lock().unwrap().push(url.to_string());
        Ok(if url == "portal" { b"<html>login</html>".to_vec() } else { valid.clone() })
    });

    assert_eq!(*fetched.lock().unwrap(), ["portal", "geosite"]);
    assert_eq!(std::fs::read(dir.join("pingu-geoip-cn.mrs")).unwrap(), b"fresh");
    assert_eq!(std::fs::read(dir.join("pingu-geosite-cn.mrs")).unwrap(), valid);
    assert!(!dir.join("pingu-geosite-ads.mrs").exists());

    let later = SystemTime::now() + STALE_AFTER + Duration::from_secs(1);
    refresh_in(&dir, &sources, later, |_| Ok(valid.clone()));
    assert_eq!(std::fs::read(dir.join("pingu-geoip-cn.mrs")).unwrap(), valid);
    std::fs::remove_dir_all(dir).unwrap();
}
