//! Publish a separate, session-owned resolver. Never edit another VPN's DNS
//! dictionary or persistent network-service preferences. configd removes this
//! entry if the helper exits, including crashes.
use core_foundation::{
    array::CFArray,
    base::{CFType, CFTypeRef, TCFType},
    boolean::CFBoolean,
    dictionary::CFDictionary,
    number::CFNumber,
    string::CFString,
};
use serde_json::{json, Value};
use std::{
    net::{TcpListener, UdpSocket},
    time::{Duration, Instant},
};
const PORT: u16 = 16553;
const LISTEN: &str = "127.0.0.1:16553";
#[link(name = "SystemConfiguration", kind = "framework")]
unsafe extern "C" {
    static kSCDynamicStoreUseSessionKeys: CFTypeRef;
    fn SCDynamicStoreCreateWithOptions(
        allocator: CFTypeRef,
        name: CFTypeRef,
        options: CFTypeRef,
        callback: CFTypeRef,
        context: CFTypeRef,
    ) -> CFTypeRef;
    fn SCDynamicStoreSetValue(store: CFTypeRef, key: CFTypeRef, value: CFTypeRef) -> u8;
    fn SCDynamicStoreRemoveValue(store: CFTypeRef, key: CFTypeRef) -> u8;
}
fn upstreams(text: &str) -> Result<Vec<String>, String> {
    for block in text.split("resolver #").skip(1) {
        if block
            .lines()
            .any(|s| s.trim_start().starts_with("domain ") || s.contains("flags    : Scoped"))
        {
            continue;
        }
        let port = block
            .lines()
            .find_map(|s| s.trim().strip_prefix("port     : "))
            .unwrap_or("53");
        if port != "53" {
            continue;
        }
        let values: Vec<_> = block
            .lines()
            .filter_map(|s| {
                if !s.trim_start().starts_with("nameserver[") {
                    return None;
                }
                let address = s.split_once(" : ")?.1.trim();
                Some(if address.contains(':') {
                    format!("udp://[{address}]:53")
                } else {
                    format!("udp://{address}:53")
                })
            })
            .collect();
        if !values.is_empty() {
            return Ok(values);
        }
    }
    Err("No existing system DNS resolver is available for TUN".into())
}
fn replace_system(value: &mut Value, servers: &[String]) {
    if let Some(items) = value.as_array_mut() {
        let mut replaced = Vec::new();
        for item in items.iter() {
            if item == "system" {
                replaced.extend(servers.iter().map(|s| json!(s)));
            } else {
                replaced.push(item.clone());
            }
        }
        *items = replaced;
    } else if value == "system" {
        *value = json!(servers);
    }
}
fn configure_with_servers(value: &mut Value, servers: &[String]) {
    let dns = &mut value["dns"];
    dns["enable"] = json!(true);
    dns["listen"] = json!(LISTEN);
    dns["enhanced-mode"] = json!("fake-ip");
    dns["fake-ip-range"] = json!("198.18.0.1/16");
    dns["ipv6"] = json!(true);
    dns["fake-ip-range6"] = json!("fdfe:dcba:9876::1/64");
    // UDP proxy protocols may resolve a destination before sending it. A
    // corporate resolver can return its own synthetic IP range, which is not
    // routable at the proxy exit. Resolve proxy destinations through that exit;
    // retain local resolution for DIRECT, proxy bootstrap and intranet policy.
    let remote = ["https://1.1.1.1/dns-query#Pingu Proxy".to_owned()];
    for key in ["nameserver", "fallback"] {
        replace_system(&mut dns[key], &remote);
    }
    for key in [
        "default-nameserver",
        "direct-nameserver",
        "proxy-server-nameserver",
    ] {
        replace_system(&mut dns[key], servers);
    }
    if let Some(policies) = dns["nameserver-policy"].as_object_mut() {
        for policy in policies.values_mut() {
            replace_system(policy, servers);
            // Existing local VPN DNS knows the current intranet. Keep explicit
            // private DNS servers and add that local resolver as a fallback;
            // never send intranet policies to an added public DNS service.
            let local = servers
                .iter()
                .filter(|s| s.starts_with("udp://127."))
                .collect::<Vec<_>>();
            if let Some(values) = policy.as_array_mut() {
                let private = !values.is_empty()
                    && values.iter().all(|v| {
                        v.as_str()
                            .and_then(|s| s.parse::<std::net::IpAddr>().ok())
                            .is_some_and(|ip| match ip {
                                std::net::IpAddr::V4(ip) => ip.is_private()
                                    || (ip.octets()[0] == 100
                                        && (64..128).contains(&ip.octets()[1])),
                                std::net::IpAddr::V6(ip) => ip.is_unique_local()
                                    || ip.is_unicast_link_local(),
                            })
                    });
                if private {
                    for server in &local {
                        let item = json!(server);
                        if !values.contains(&item) {
                            values.push(item);
                        }
                    }
                }
            }
        }
    }
    // Null fallback means absent, not a usable Mihomo server list.
    if dns["fallback"].is_null() {
        dns.as_object_mut().unwrap().remove("fallback");
    }
}
pub(super) fn configure(value: &mut Value) -> Result<(), String> {
    #[cfg(not(test))]
    let servers = {
        let output = std::process::Command::new("/usr/sbin/scutil")
            .arg("--dns")
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err("Cannot read the current system DNS configuration".into());
        }
        upstreams(&String::from_utf8_lossy(&output.stdout))?
    };
    #[cfg(test)]
    let servers = vec!["udp://127.0.0.1:53".to_owned()];
    configure_with_servers(value, &servers);
    Ok(())
}
pub(super) fn prepare(value: &mut Value) -> Result<u16, String> {
    if value["dns"]["listen"] != LISTEN || value["dns"]["enhanced-mode"] != "fake-ip" {
        return Err("TUN requires its private DNS listener".into());
    }
    // Detect a collision before publishing a resolver pointing at another app.
    let _udp =
        UdpSocket::bind(LISTEN).map_err(|e| format!("Pingu DNS port is unavailable: {e}"))?;
    let _tcp =
        TcpListener::bind(LISTEN).map_err(|e| format!("Pingu DNS port is unavailable: {e}"))?;
    Ok(PORT)
}
pub(super) struct Session {
    store: CFType,
    key: CFString,
}
impl Session {
    pub(super) fn start(port: u16) -> Result<Self, String> {
        let socket = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        socket
            .set_read_timeout(Some(Duration::from_millis(150)))
            .map_err(|e| e.to_string())?;
        socket
            .connect(("127.0.0.1", port))
            .map_err(|e| e.to_string())?;
        // A fake-IP query checks the listener without requiring external DNS.
        let query = b"\x50\x47\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x0bpingu-check\x07invalid\x00\x00\x01\x00\x01";
        let until = Instant::now() + Duration::from_secs(6);
        loop {
            let _ = socket.send(query);
            let mut buffer = [0; 512];
            if socket
                .recv(&mut buffer)
                .is_ok_and(|len| len >= 12 && buffer[..2] == query[..2])
            {
                break;
            }
            if Instant::now() >= until {
                return Err("TUN DNS listener did not start".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let options = CFDictionary::from_CFType_pairs(&[(
            unsafe { CFType::wrap_under_get_rule(kSCDynamicStoreUseSessionKeys) },
            CFBoolean::true_value().as_CFType(),
        )]);
        let name = CFString::new("Pingu TUN DNS");
        let raw = unsafe {
            SCDynamicStoreCreateWithOptions(
                std::ptr::null(),
                name.as_CFTypeRef(),
                options.as_CFTypeRef(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
        if raw.is_null() {
            return Err("Cannot create the Pingu DNS session".into());
        }
        let session = Self {
            store: unsafe { CFType::wrap_under_create_rule(raw) },
            key: CFString::new(&format!(
                "State:/Network/Service/Pingu-{}-DNS/DNS",
                uuid::Uuid::new_v4()
            )),
        };
        let values = CFDictionary::from_CFType_pairs(&[
            (
                CFString::new("ServerAddresses"),
                CFArray::from_CFTypes(&[CFString::new("127.0.0.1")]).as_CFType(),
            ),
            (
                CFString::new("ServerPort"),
                CFNumber::from(i32::from(port)).as_CFType(),
            ),
            (
                CFString::new("SupplementalMatchDomains"),
                CFArray::from_CFTypes(&[CFString::new("")]).as_CFType(),
            ),
            (
                CFString::new("SupplementalMatchOrders"),
                CFArray::from_CFTypes(&[CFNumber::from(1)]).as_CFType(),
            ),
        ]);
        if unsafe {
            SCDynamicStoreSetValue(
                session.store.as_CFTypeRef(),
                session.key.as_CFTypeRef(),
                values.as_CFTypeRef(),
            )
        } == 0
        {
            return Err("Cannot publish the Pingu DNS resolver".into());
        }
        Ok(session)
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        unsafe {
            SCDynamicStoreRemoveValue(self.store.as_CFTypeRef(), self.key.as_CFTypeRef());
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolver_snapshot_skips_pingu_and_scoped_domains() {
        let text = "resolver #1\n nameserver[0] : 127.0.0.1\n port     : 16553\nresolver #2\n domain   : private.test\n nameserver[0] : 10.0.0.2\nresolver #3\n nameserver[0] : 127.0.0.1\n port     : 53\nresolver #4\n nameserver[0] : 192.168.1.1\n";
        assert_eq!(upstreams(text).unwrap(), vec!["udp://127.0.0.1:53"]);
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
}
