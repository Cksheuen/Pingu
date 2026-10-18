use super::*;

#[test]
fn resolver_snapshot_skips_pingu_and_scoped_domains() {
    let text = "resolver #1\n nameserver[0] : 127.0.0.1\n port     : 16553\nresolver #2\n domain   : private.test\n nameserver[0] : 10.0.0.2\nresolver #3\n nameserver[0] : 127.0.0.1\n port     : 53\nresolver #4\n nameserver[0] : 192.168.1.1\n";
    assert_eq!(upstreams(text).unwrap(), vec!["udp://127.0.0.1:53"]);
}

#[test]
fn resolver_snapshot_without_another_proxy_escapes_ipv6_zone_for_mihomo() {
    let text = "resolver #1\n nameserver[0] : fe80::1%en0\n nameserver[1] : 192.168.1.1\n if_index : 15 (en0)\n flags    : Request A records, Request AAAA records\n";
    let servers = upstreams(text).unwrap();
    let expected = json!(["udp://[fe80::1%25en0]:53", "udp://192.168.1.1:53"]);
    assert_eq!(json!(servers), expected);
    let mut value = json!({"dns":{
        "nameserver":["system"], "default-nameserver":["system"],
        "direct-nameserver":["system"], "proxy-server-nameserver":["system"]
    }});
    configure_with_servers(&mut value, &servers);
    for key in [
        "default-nameserver",
        "direct-nameserver",
        "proxy-server-nameserver",
    ] {
        assert_eq!(value["dns"][key], expected, "{key}");
    }
}

#[test]
fn tun_dns_preserves_internal_policy_and_avoids_system_resolver_recursion() {
    let mut value = json!({"dns":{"nameserver":["system"],"direct-nameserver":["system"],"fake-ip-filter":["+.inner.test"],"nameserver-policy":{"+.inner.test":["10.0.0.53"],"+.v6.inner.test":["fd00::53"],"public.test":["https://dns.google/dns-query#Pingu Proxy"]}}});
    configure_with_servers(&mut value, &["udp://127.0.0.1:53".into()]);
    assert_eq!(
        value["dns"]["nameserver"],
        json!(["https://1.1.1.1/dns-query#Pingu Proxy"])
    );
    assert_eq!(
        value["dns"]["direct-nameserver"],
        json!(["udp://127.0.0.1:53"])
    );
    assert_eq!(value["dns"]["fake-ip-filter"], json!(["+.inner.test"]));
    assert_eq!(
        value["dns"]["nameserver-policy"]["+.inner.test"],
        json!(["10.0.0.53", "udp://127.0.0.1:53"])
    );
    assert_eq!(
        value["dns"]["nameserver-policy"]["+.v6.inner.test"],
        json!(["fd00::53", "udp://127.0.0.1:53"])
    );
    assert_eq!(
        value["dns"]["nameserver-policy"]["public.test"],
        json!(["https://dns.google/dns-query#Pingu Proxy"])
    );
    assert!(value["dns"].get("fallback").is_none());
}
