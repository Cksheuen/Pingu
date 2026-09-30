use super::*;
use std::io::{Read, Write};
/// Read one complete HTTP request: through the header terminator and then the full
/// Content-Length body. Responding before the body is consumed makes the client's send
/// fail and surfaces as a spurious "controller unavailable".
fn read_request(socket: &mut std::net::TcpStream) -> String {
    socket
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .unwrap();
    let mut raw = Vec::new();
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        let count = socket.read(&mut chunk).unwrap();
        assert!(count > 0, "client closed before sending a full request");
        raw.extend_from_slice(&chunk[..count]);
        if let Some(index) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let headers = String::from_utf8_lossy(&raw[..header_end]).into_owned();
    let length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .unwrap_or(0);
    while raw.len() < header_end + length {
        let count = socket.read(&mut chunk).unwrap();
        assert!(count > 0, "client closed mid-body");
        raw.extend_from_slice(&chunk[..count]);
    }
    String::from_utf8_lossy(&raw[..header_end + length]).into_owned()
}
#[test]
fn controller_authenticates_and_encodes_group_paths() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let request = read_request(&mut socket);
        socket
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .unwrap();
        request
    });
    select(port, "My / Group", "A").unwrap();
    let request = server.join().unwrap();
    assert!(request.starts_with("PUT /proxies/My%20%2F%20Group"));
    assert!(request.contains(&format!("Authorization: Bearer {}", secret())));
}
#[test]
fn normalizes_connections_for_ipc() {
    let result=parse_connections(json!({"uploadTotal":42,"downloadTotal":84,"connections":[{"id":"connection","metadata":{"host":"example.com","destinationPort":443,"network":"tcp","process":"Browser"},"chains":["A","Pingu Proxy"],"rule":"Domain","rulePayload":"example.com","upload":12,"download":24}]})).unwrap();
    assert_eq!(result.connections[0].destination_port, "443");
    assert_eq!(result.connections[0].destination_ip, "");
    assert_eq!(result.connections[0].chains.len(), 2);
    assert_eq!(result.upload_total, 42);
}

/// Explicit integration acceptance: actual Mihomo binary, ephemeral files/ports,
/// local HTTP traffic only. Never enables the macOS system proxy.
#[test]
#[ignore = "requires PINGU_MIHOMO_BIN; starts isolated real core"]
fn real_mihomo_config_controller_and_connections() {
    use crate::mihomo::profiles::{parse_body, Subscription};
    use crate::storage::app_config::AppConfig;
    use std::net::{TcpListener, TcpStream};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::{Duration, Instant};
    struct Core {
        child: std::process::Child,
        dir: std::path::PathBuf,
    }
    impl Drop for Core {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    let binary = std::env::var("PINGU_MIHOMO_BIN").expect("Set PINGU_MIHOMO_BIN explicitly");
    let free_port = || {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    };
    let port = free_port();
    let api = free_port();
    let(fragment,warnings)=parse_body("proxies: [{name: Example, type: socks5, server: 127.0.0.1, port: 1}]\nproxy-groups: [{name: Choice, type: select, proxies: [DIRECT, REJECT, Example]}]\nrules: ['MATCH,Choice']").unwrap();
    let mut config = AppConfig::default_config();
    config.active_rule_group_mut().unwrap().rules.clear();
    config.subscriptions.push(Subscription {
        nodes_only: false,
        id: "smoke".into(),
        name: "Smoke".into(),
        input: String::new(),
        enabled: true,
        updated_at: String::new(),
        last_error: None,
        fragment,
        warnings,
    });
    let mut generated = crate::mihomo::config_gen::generate_app_config(
        &config,
        config.active_rule_group().unwrap(),
        &[],
        api,
        port,
    );
    // Make local traffic traverse the imported strategy, rather than the private-IP bypass.
    generated["rules"] = json!(["MATCH,Smoke [smoke] / Choice"]);
    let dir = std::env::temp_dir().join(format!("pingu-real-mihomo-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let path = dir.join("config.json");
    crate::mihomo::private_write(&path, generated.to_string().as_bytes()).unwrap();
    let check = std::process::Command::new(&binary)
        .args([
            "-t",
            "-f",
            path.to_str().unwrap(),
            "-d",
            dir.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        check.status.success(),
        "{}",
        String::from_utf8_lossy(&check.stdout)
    );
    let child = std::process::Command::new(&binary)
        .args(["-f", path.to_str().unwrap(), "-d", dir.to_str().unwrap()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let _core = Core { child, dir };
    let start = Instant::now();
    while groups(api).is_err() {
        assert!(
            start.elapsed() < Duration::from_secs(8),
            "Core did not become ready"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(matches!(
        ureq::get(&format!("http://127.0.0.1:{api}/proxies")).call(),
        Err(ureq::Error::Status(401, _))
    ));
    select(api, "Smoke [smoke] / Choice", "REJECT").unwrap();
    assert_eq!(
        groups(api)
            .unwrap()
            .iter()
            .find(|g| g.name == "Smoke [smoke] / Choice")
            .unwrap()
            .now
            .as_deref(),
        Some("REJECT")
    );
    select(api, "Smoke [smoke] / Choice", "DIRECT").unwrap();
    let origin = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin_port = origin.local_addr().unwrap().port();
    origin.set_nonblocking(true).unwrap();
    let done = Arc::new(AtomicBool::new(false));
    let finished = done.clone();
    let server = std::thread::spawn(move || {
        while !finished.load(Ordering::SeqCst) {
            match origin.accept() {
                Ok((mut s, _)) => {
                    let finished = finished.clone();
                    std::thread::spawn(move || {
                        s.set_write_timeout(Some(Duration::from_secs(1))).ok();
                        s.set_read_timeout(Some(Duration::from_secs(1))).ok();
                        let mut bytes = [0; 8192];
                        let count = match s.read(&mut bytes) {
                            Ok(count) => count,
                            Err(_) => return,
                        };
                        if String::from_utf8_lossy(&bytes[..count]).contains("/delay") {
                            let _=s.write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                            return;
                        }
                        if s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10485760\r\n\r\n")
                            .is_err()
                        {
                            return;
                        }
                        while !finished.load(Ordering::SeqCst) {
                            if s.write_all(&[b'x'; 1024]).is_err() {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(20));
                        }
                    });
                }
                Err(_) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    });
    let delay_path = format!(
        "/proxies/{}/delay?timeout=3000&url={}",
        segment("Smoke [smoke] / Choice"),
        segment(&format!("http://127.0.0.1:{origin_port}/delay"))
    );
    assert!(request(api, "GET", &delay_path, None).unwrap()["delay"]
        .as_u64()
        .is_some());
    let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(client,"GET http://127.0.0.1:{origin_port}/stream HTTP/1.1\r\nHost: 127.0.0.1:{origin_port}\r\n\r\n").unwrap();
    let mut bytes = [0; 1024];
    let received = client.read(&mut bytes).unwrap();
    assert!(received > 0);
    let start = Instant::now();
    let row = loop {
        let rows = connections(api).unwrap();
        if let Some(row) = rows
            .connections
            .into_iter()
            .find(|c| c.destination_port == origin_port.to_string())
        {
            break row;
        }
        assert!(start.elapsed() < Duration::from_secs(3));
        std::thread::sleep(Duration::from_millis(30));
    };
    assert!(row.chains.contains(&"Smoke [smoke] / Choice".into()));
    assert!(row.chains.contains(&"DIRECT".into()));
    assert_eq!(row.rule, "Match");
    close(api, Some(&row.id)).unwrap();
    let start = Instant::now();
    while connections(api)
        .unwrap()
        .connections
        .iter()
        .any(|c| c.id == row.id)
    {
        assert!(start.elapsed() < Duration::from_secs(3));
        std::thread::sleep(Duration::from_millis(20));
    }
    let mut clients = Vec::new();
    for _ in 0..2 {
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(client,"GET http://127.0.0.1:{origin_port}/stream HTTP/1.1\r\nHost: 127.0.0.1:{origin_port}\r\n\r\n").unwrap();
        assert!(client.read(&mut bytes).unwrap() > 0);
        clients.push(client);
    }
    assert_eq!(connections(api).unwrap().connections.len(), 2);
    close(api, None).unwrap();
    let start = Instant::now();
    while !connections(api).unwrap().connections.is_empty() {
        assert!(start.elapsed() < Duration::from_secs(3));
        std::thread::sleep(Duration::from_millis(20));
    }
    done.store(true, Ordering::SeqCst);
    server.join().unwrap();
}

#[test]
fn accepts_mihomo_null_connections_after_close() {
    assert!(
        parse_connections(json!({"connections":null,"uploadTotal":7,"downloadTotal":9}))
            .unwrap()
            .connections
            .is_empty()
    );
    assert!(parse_connections(json!({})).is_err());
}

/// Real-core acceptance for source isolation: imported sources with homonymous
/// include-all groups. Asserts the controller's actual group membership, since only the
/// core decides what an include-all group contains. One source additionally uses a
/// loopback HTTP provider so provider filtering is checked natively rather than inferred.
#[test]
#[ignore = "requires PINGU_MIHOMO_BIN; starts isolated real core"]
fn real_mihomo_keeps_imported_sources_isolated() {
    use crate::mihomo::profiles::{parse_body, Subscription};
    use crate::storage::app_config::AppConfig;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::{Duration, Instant};
    struct Core {
        child: Option<std::process::Child>,
        dir: std::path::PathBuf,
    }
    impl Core {
        fn start(&mut self, binary: &str, path: &std::path::Path) {
            assert!(self.child.is_none(), "test core is already running");
            self.child = Some(
                std::process::Command::new(binary)
                    .args([
                        "-f",
                        path.to_str().unwrap(),
                        "-d",
                        self.dir.to_str().unwrap(),
                    ])
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap(),
            );
        }

        fn restart(&mut self, binary: &str, path: &std::path::Path) {
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            self.start(binary, path);
        }
    }
    impl Drop for Core {
        fn drop(&mut self) {
            // Terminate the core even if an assertion above panicked.
            if let Some(mut child) = self.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    struct Origin {
        stop: Arc<AtomicBool>,
        server: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for Origin {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(server) = self.server.take() {
                let _ = server.join();
            }
        }
    }
    let binary = std::env::var("PINGU_MIHOMO_BIN").expect("Set PINGU_MIHOMO_BIN explicitly");
    let free_port = || {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    };
    // Loopback-only provider payload; no external traffic.
    let provider_body = b"proxies:\n  - {name: HK-provider, type: socks5, server: 127.0.0.1, port: 1099}\n  - {name: JP-provider, type: socks5, server: 127.0.0.1, port: 1098}\n".to_vec();
    let origin_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let provider_port = origin_listener.local_addr().unwrap().port();
    origin_listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let serving = stop.clone();
    let payload = provider_body.clone();
    let server = std::thread::spawn(move || {
        while !serving.load(Ordering::SeqCst) {
            match origin_listener.accept() {
                Ok((mut socket, _)) => {
                    let body = payload.clone();
                    std::thread::spawn(move || {
                        let mut bytes = [0; 4096];
                        let _ = socket.read(&mut bytes);
                        let _ = socket.write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: text/yaml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            )
                            .as_bytes(),
                        );
                        let _ = socket.write_all(&body);
                    });
                }
                Err(_) => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    });
    let _origin = Origin {
        stop: stop.clone(),
        server: Some(server),
    };
    let api = free_port();
    let port = free_port();
    let mut config = AppConfig::default_config();
    config.active_rule_group_mut().unwrap().rules.clear();
    // Source A: homonymous nodes plus an anchored filter and a provider. The provider
    // URL is loopback so this core makes no external request; the import sanitizer
    // requires HTTPS for real subscriptions, so the test injects the fragment itself
    // rather than weakening that production guard.
    let source_a = format!(
        "proxies: [{{name: HK-1, type: socks5, server: 127.0.0.1, port: 1080}}, {{name: US-1, type: socks5, server: 127.0.0.1, port: 1081}}]\n\
         proxy-groups: [\
           {{name: Auto, type: url-test, include-all: true, url: 'http://127.0.0.1:{probe}', interval: 3600}}, \
           {{name: HK, type: select, include-all-proxies: true, filter: '^HK'}}, \
           {{name: Pick, type: select, include-all: true, filter: '^HK'}}, \
           {{name: Provider Pick, type: select, use: [remote], proxies: [HK-1]}}, \
           {{name: Authored Pick, type: select, default-selected: US-1, proxies: [US-1, HK-1]}}\
         ]\n\
         rules: ['MATCH,Auto']",
        probe = free_port(),
    );
    // Source B: same node names, so a naive include-all would cross-contaminate.
    let source_b = format!(
        "proxies: [{{name: HK-1, type: socks5, server: 127.0.0.1, port: 1082}}, {{name: JP-1, type: socks5, server: 127.0.0.1, port: 1083}}]\n\
         proxy-groups: [\
           {{name: Auto, type: url-test, include-all: true, url: 'http://127.0.0.1:{probe}', interval: 3600}}, \
           {{name: Removed Pick, type: select, proxies: [JP-1, HK-1]}}\
         ]\n\
         rules: ['MATCH,Auto']",
        probe = free_port(),
    );
    // Source C: display name repeats an exclude-filter keyword; both nodes must survive.
    let source_c = "proxies: [{name: US-1, type: socks5, server: 127.0.0.1, port: 1084}, {name: JP-1, type: socks5, server: 127.0.0.1, port: 1085}]\nproxy-groups: [{name: Auto, type: url-test, include-all-proxies: true, exclude-filter: 'HK'}, {name: Explicit, type: select, proxies: [US-1, JP-1], exclude-filter: 'HK'}]\nrules: ['MATCH,Auto']";
    for (id, name, body) in [
        ("aaaaaaaa", "Source A", source_a.as_str()),
        ("bbbbbbbb", "Source B", source_b.as_str()),
        ("cccccccc", "HK subscription", source_c),
    ] {
        let (mut fragment, warnings) = parse_body(body).unwrap();
        if id == "aaaaaaaa" {
            // Test-owned loopback provider: its node names are never renamed, so the
            // core's own provider filtering is what decides this group's membership.
            fragment["proxy-providers"] = json!({
                "remote": {
                    "type": "http",
                    "url": format!("http://127.0.0.1:{provider_port}/proxies"),
                    "path": "x.cache",
                    "interval": 3600,
                    "health-check": {"enable": false},
                }
            });
        }
        config.subscriptions.push(Subscription {
            nodes_only: false,
            id: id.into(),
            name: name.into(),
            input: String::new(),
            enabled: true,
            updated_at: String::new(),
            last_error: None,
            fragment,
            warnings,
        });
    }
    config.strategy_selections.insert(
        "Source A [aaaaaaaa] / Provider Pick".into(),
        "JP-provider".into(),
    );
    config.strategy_selections.insert(
        "Source A [aaaaaaaa] / Authored Pick".into(),
        "Source A [aaaaaaaa] / HK-1".into(),
    );
    config.strategy_selections.insert(
        "Source B [bbbbbbbb] / Removed Pick".into(),
        "Source B [bbbbbbbb] / Removed-1".into(),
    );
    let generated = crate::mihomo::config_gen::try_generate_app_config(
        &config,
        config.active_rule_group().unwrap(),
        &[],
        api,
        port,
    )
    .expect("generation must succeed for ordinary include-all subscriptions");
    // The app's own groups default to a public health-check URL; point every group and
    // provider at loopback so this isolated core makes no external request at all.
    let mut generated = generated;
    let probe_url = format!("http://127.0.0.1:{}/probe", free_port());
    if let Some(groups) = generated["proxy-groups"].as_array_mut() {
        for group in groups {
            if group.get("url").is_some() {
                group["url"] = json!(probe_url);
            }
        }
    }
    // Never rewrite a provider's download URL - the loopback fixture must still load.
    // Only health-check targets are repointed at loopback.
    if let Some(providers) = generated["proxy-providers"].as_object_mut() {
        for provider in providers.values_mut() {
            if provider.get("health-check").is_some() {
                provider["health-check"]["url"] = json!(probe_url);
            }
        }
    }
    let dir = std::env::temp_dir().join(format!("pingu-isolation-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let mut core = Core { child: None, dir };
    let path = core.dir.join("config.json");
    crate::mihomo::private_write(&path, generated.to_string().as_bytes()).unwrap();
    let check = std::process::Command::new(&binary)
        .args([
            "-t",
            "-f",
            path.to_str().unwrap(),
            "-d",
            core.dir.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        check.status.success(),
        "core rejected the generated config: {}",
        String::from_utf8_lossy(&check.stdout)
    );
    core.start(&binary, &path);
    let start = Instant::now();
    while groups(api).is_err() {
        assert!(
            start.elapsed() < Duration::from_secs(8),
            "Core did not become ready"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    let strategy = |name: &str| {
        groups(api)
            .unwrap()
            .into_iter()
            .find(|g| g.name == name)
            .unwrap_or_else(|| panic!("group {name} missing from the running core"))
    };
    let members = |name: &str| strategy(name).all;
    // Wait for the loopback provider to load before asserting provider membership.
    let provider_deadline = Instant::now();
    while !members("Source A [aaaaaaaa] / Pick")
        .iter()
        .any(|m| m == "HK-provider")
    {
        assert!(
            provider_deadline.elapsed() < Duration::from_secs(8),
            "provider never loaded: {:?}",
            members("Source A [aaaaaaaa] / Pick")
        );
        std::thread::sleep(Duration::from_millis(50));
    }
    // Real membership must stay inside each source.
    for (source, own, foreign) in [
        ("Source A [aaaaaaaa]", ["HK-1", "US-1"], "Source B"),
        ("Source B [bbbbbbbb]", ["HK-1", "JP-1"], "Source A"),
        ("HK subscription [cccccccc]", ["US-1", "JP-1"], "Source A"),
    ] {
        let auto = members(&format!("{source} / Auto"));
        for node in own {
            assert!(
                auto.contains(&format!("{source} / {node}")),
                "{source} / Auto lost its own node {node}: {auto:?}"
            );
        }
        assert!(
            !auto.iter().any(|m| m.contains(foreign)),
            "{source} / Auto leaked {foreign} nodes: {auto:?}"
        );
    }
    // A display name repeating `HK` must not make the exclude filter drop both nodes.
    let c = members("HK subscription [cccccccc] / Auto");
    assert!(
        c.len() == 2,
        "exclude-filter `HK` must not match the source prefix: {c:?}"
    );
    // The anchored static filter must have selected, not fallen back.
    assert_eq!(
        members("Source A [aaaaaaaa] / HK"),
        vec!["Source A [aaaaaaaa] / HK-1".to_string()],
        "^HK must not fall back"
    );
    // Mixed static + provider group with filter `^HK`: the static node is matched on its
    // original name (and namespaced), while provider nodes keep native filtering and are
    // not renamed. A provider key is not itself a member - its payload node names are.
    let pick = members("Source A [aaaaaaaa] / Pick");
    assert!(
        pick.contains(&"Source A [aaaaaaaa] / HK-1".to_string()),
        "static ^HK match missing: {pick:?}"
    );
    assert!(
        pick.contains(&"HK-provider".to_string()),
        "provider filter chose nothing: {pick:?}"
    );
    assert!(
        !pick.iter().any(|m| m.contains("JP-provider")),
        "provider filter kept JP: {pick:?}"
    );
    assert!(
        !pick.iter().any(|m| m.contains("US-1")),
        "static filter kept US-1: {pick:?}"
    );
    assert!(
        !pick.iter().any(|m| m.contains("Source B")),
        "provider group leaked another source: {pick:?}"
    );
    // The explicit-only exclusion was evaluated before namespacing. The core sees both
    // original members even though the source display name itself contains `HK`.
    assert_eq!(
        members("HK subscription [cccccccc] / Explicit"),
        vec![
            "HK subscription [cccccccc] / US-1".to_string(),
            "HK subscription [cccccccc] / JP-1".to_string(),
        ]
    );
    // Persisted selections are native defaults in a freshly generated core. Provider
    // nodes are not in the static list, and a saved value overrides an authored default.
    assert_eq!(
        strategy("Source A [aaaaaaaa] / Provider Pick")
            .now
            .as_deref(),
        Some("JP-provider")
    );
    assert_eq!(
        strategy("Source A [aaaaaaaa] / Authored Pick")
            .now
            .as_deref(),
        Some("Source A [aaaaaaaa] / HK-1")
    );
    // A removed saved member is deliberately left to Mihomo, which falls back to the
    // first still-present member instead of making generation fail or changing order.
    assert_eq!(
        strategy("Source B [bbbbbbbb] / Removed Pick")
            .now
            .as_deref(),
        Some("Source B [bbbbbbbb] / JP-1")
    );

    // A runtime selection must not supersede the persisted native default on restart.
    select(api, "Source A [aaaaaaaa] / Provider Pick", "HK-provider").unwrap();
    assert_eq!(
        strategy("Source A [aaaaaaaa] / Provider Pick")
            .now
            .as_deref(),
        Some("HK-provider")
    );
    core.restart(&binary, &path);
    let restart = Instant::now();
    let restarted = loop {
        let selected = groups(api).ok().and_then(|groups| {
            groups
                .into_iter()
                .find(|g| g.name == "Source A [aaaaaaaa] / Provider Pick")
        });
        if selected.as_ref().and_then(|g| g.now.as_deref()) == Some("JP-provider") {
            break selected.unwrap();
        }
        assert!(
            restart.elapsed() < Duration::from_secs(8),
            "saved provider selection did not recover after restart: {:?}",
            selected.and_then(|g| g.now)
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    assert_eq!(restarted.now.as_deref(), Some("JP-provider"));
}
