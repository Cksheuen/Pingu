use super::*;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pingu-lifecycle-ownership-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fake_core_script(dir: &Path) -> PathBuf {
    let path = dir.join("fake-core.sh");
    std::fs::write(
        &path,
        b"#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    path
}

fn start_fake_core(script: &Path, runtime_dir: &Path) -> Arc<MihomoProcess> {
    std::fs::create_dir_all(runtime_dir).unwrap();
    let config = runtime_dir.join("config.json");
    std::fs::write(&config, b"{}").unwrap();
    let process = Arc::new(MihomoProcess::with_binary_for_test(
        script.to_string_lossy().into_owned(),
    ));
    process.start(config.to_str().unwrap()).unwrap();
    process
}

struct ControllerFixture {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
    accepted: Arc<AtomicUsize>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl ControllerFixture {
    fn join(mut self) -> Vec<String> {
        if let Some(join) = self.join.take() {
            join.join().unwrap();
        }
        self.requests.lock().unwrap().clone()
    }
}

fn controller_fixture(
    get_bodies: Vec<String>,
    expected_requests: usize,
    fail: bool,
) -> ControllerFixture {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let accepted = Arc::new(AtomicUsize::new(0));
    let requests_for_thread = Arc::clone(&requests);
    let accepted_for_thread = Arc::clone(&accepted);
    let join = std::thread::spawn(move || {
        let mut bodies = VecDeque::from(get_bodies);
        let deadline = Instant::now() + Duration::from_secs(10);
        while accepted_for_thread.load(AtomicOrdering::SeqCst) < expected_requests
            && Instant::now() < deadline
        {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let mut bytes = [0_u8; 4096];
            let count = stream.read(&mut bytes).unwrap_or(0);
            let request = String::from_utf8_lossy(&bytes[..count]);
            let first_line = request.lines().next().unwrap_or_default().to_string();
            requests_for_thread.lock().unwrap().push(first_line.clone());
            accepted_for_thread.fetch_add(1, AtomicOrdering::SeqCst);
            if fail {
                let _ = stream.write_all(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            } else if first_line.starts_with("GET ") {
                let body = bodies.pop_front().unwrap_or_else(|| {
                    r#"{"uploadTotal":0,"downloadTotal":0,"connections":[]}"#.into()
                });
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                let _ = stream.write_all(response.as_bytes());
            } else {
                let _ = stream.write_all(
                    b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        }
    });
    ControllerFixture {
        port,
        requests,
        accepted,
        join: Some(join),
    }
}

fn connection_body(id: &str, host: &str, upload: u64, download: u64) -> String {
    format!(
        r#"{{"uploadTotal":{upload},"downloadTotal":{download},"connections":[{{"id":"{id}","metadata":{{"host":"{host}","destinationIP":"127.0.0.1","destinationPort":"443","sourceIP":"127.0.0.1","network":"tcp","type":"HTTP","process":"fixture"}},"chains":["proxy"],"rule":"Match","rulePayload":"","upload":{upload},"download":{download},"start":"now"}}]}}"#
    )
}

fn state_with_managed_cores(
    root: &Path,
    current_port: u16,
    draining_port: u16,
) -> (ProxyState, PathBuf, PathBuf) {
    let script = fake_core_script(root);
    let current_dir = root.join("runtime-current");
    let draining_dir = root.join("runtime-draining");
    let current = start_fake_core(&script, &current_dir);
    let draining = start_fake_core(&script, &draining_dir);
    let state = ProxyState::new(
        Arc::try_unwrap(current).ok().unwrap(),
        Arc::new(RecordingSystemProxy::default()),
        2080,
    );
    *state.runtime.lock().unwrap() = RuntimeSnapshot {
        connected_at: Some(Instant::now()),
        clash_api_port: Some(current_port),
        config_path: Some(current_dir.join("config.json")),
        owned_runtime_dir: Some(current_dir.clone()),
        controller_scope: Some(uuid::Uuid::new_v4().to_string()),
        generation: 2,
        ..RuntimeSnapshot::default()
    };
    state
        .draining_cores
        .lock()
        .unwrap()
        .push(Arc::new(DrainingCore {
            process: draining,
            clash_api_port: Some(draining_port),
            controller_scope: Some(uuid::Uuid::new_v4().to_string()),
            owned_runtime_dir: Some(draining_dir.clone()),
        }));
    (state, current_dir, draining_dir)
}

#[derive(Default)]
struct RecordingSystemProxy {
    events: Mutex<Vec<String>>,
}

impl SystemProxyControl for RecordingSystemProxy {
    fn set(&self, port: u16) -> Result<(), String> {
        self.events.lock().unwrap().push(format!("set:{port}"));
        Ok(())
    }

    fn clear(&self) -> Result<(), String> {
        self.events.lock().unwrap().push("clear".to_string());
        Ok(())
    }
}

#[test]
fn runtime_snapshot_updates_atomically_and_preserves_start_on_reload() {
    let state = ProxyState::new(
        MihomoProcess::new(),
        Arc::new(RecordingSystemProxy::default()),
        2080,
    );
    let first = RuntimeLaunch {
        config_path: "/tmp/a.json".into(),
        owned_runtime_dir: None,
        node_id: "node-a".into(),
        node_name: "A".into(),
        node_address: "example.com".into(),
        node_port: 443,
        group_id: "group-a".into(),
        group_name: "A".into(),
        clash_api_port: 9090,
        listen_port: 2080,
    };
    set_runtime_connected(&state, &first, false).unwrap();
    let initial = state.runtime_snapshot().unwrap();

    let second = RuntimeLaunch {
        config_path: "/tmp/b.json".into(),
        node_id: "node-b".into(),
        group_id: "group-b".into(),
        clash_api_port: 9091,
        listen_port: 2081,
        ..first
    };
    set_runtime_connected(&state, &second, true).unwrap();
    let reloaded = state.runtime_snapshot().unwrap();

    assert_eq!(initial.connected_at, reloaded.connected_at);
    assert_eq!(reloaded.running_node_id.as_deref(), Some("node-b"));
    assert_eq!(reloaded.running_group_id.as_deref(), Some("group-b"));
    assert_eq!(reloaded.clash_api_port, Some(9091));
    assert_eq!(reloaded.listen_port, Some(2081));
    assert_eq!(state.active_listen_port(), 2081);
    assert_eq!(reloaded.generation, 2);
}

#[test]
fn idle_shutdown_does_not_clear_an_unowned_system_proxy() {
    let system = Arc::new(RecordingSystemProxy::default());
    let state = ProxyState::new(MihomoProcess::new(), system.clone(), 2080);
    shutdown_core(&state).unwrap();
    assert!(system.events.lock().unwrap().is_empty());
}
#[test]
fn shutdown_clears_only_a_proxy_claimed_by_this_runtime() {
    let system = Arc::new(RecordingSystemProxy::default());
    let state = ProxyState::new(MihomoProcess::new(), system.clone(), 2080);
    state.owns_system_proxy.store(true, Ordering::SeqCst);
    shutdown_core(&state).unwrap();
    assert_eq!(*system.events.lock().unwrap(), vec!["clear"]);
    shutdown_core(&state).unwrap();
    assert_eq!(system.events.lock().unwrap().len(), 1);
}

#[test]
fn validation_failure_removes_only_the_prestart_owned_directory() {
    let root = TestDir::new();
    let runtime_dir = root.path().join("runtime-candidate");
    let preview_dir = root.path().join("preview");
    let persisted = root.path().join("settings.json");
    std::fs::create_dir_all(&runtime_dir).unwrap();
    std::fs::create_dir_all(&preview_dir).unwrap();
    std::fs::write(runtime_dir.join("config.json"), b"{}").unwrap();
    std::fs::write(preview_dir.join("keep"), b"preview").unwrap();
    std::fs::write(&persisted, b"persisted").unwrap();

    let state = ProxyState::new(
        MihomoProcess::with_binary_for_test("/usr/bin/false"),
        Arc::new(RecordingSystemProxy::default()),
        2080,
    );
    let prepared = PreparedRuntime {
        config_dir: runtime_dir.clone(),
        owned_runtime_dir: Some(runtime_dir.clone()),
        config_path: runtime_dir.join("config.json"),
        cache_path: runtime_dir.join("cache.db"),
        node: crate::mihomo::uri_parser::Node::default(),
        rule_group: crate::mihomo::config_gen::RuleGroup {
            id: "group".into(),
            name: "Group".into(),
            rules: vec![],
            default_strategy: "direct".into(),
            fake_ip_filter: vec![],
            nameserver_policy: vec![],
        },
        clash_api_port: 59091,
        listen_port: 52081,
    };

    let error = match runtime_launch_from_prepared(prepared, &state) {
        Err(error) => error,
        Ok(_) => panic!("validation must reject the candidate"),
    };
    assert!(error.contains("rejected"), "got: {error}");
    assert!(!runtime_dir.exists());
    assert_eq!(std::fs::read(preview_dir.join("keep")).unwrap(), b"preview");
    assert_eq!(std::fs::read(persisted).unwrap(), b"persisted");
}

#[test]
fn reconnect_cleans_a_confirmed_dead_runtime_before_replacing_ownership() {
    let root = TestDir::new();
    let old_dir = root.path().join("runtime-old");
    let preview_dir = root.path().join("preview");
    std::fs::create_dir_all(&old_dir).unwrap();
    std::fs::create_dir_all(&preview_dir).unwrap();
    std::fs::write(old_dir.join("config.json"), b"{}").unwrap();
    std::fs::write(preview_dir.join("keep"), b"preview").unwrap();
    let process = MihomoProcess::with_binary_for_test("/usr/bin/false");
    process
        .start(old_dir.join("config.json").to_str().unwrap())
        .unwrap();
    let exit_deadline = Instant::now() + Duration::from_secs(2);
    while process.is_running() {
        assert!(Instant::now() < exit_deadline, "fixture child did not exit");
        std::thread::sleep(Duration::from_millis(5));
    }
    let state = ProxyState::new(process, Arc::new(RecordingSystemProxy::default()), 2080);
    *state.runtime.lock().unwrap() = RuntimeSnapshot {
        connected_at: Some(Instant::now()),
        config_path: Some(old_dir.join("config.json")),
        owned_runtime_dir: Some(old_dir.clone()),
        controller_scope: Some(uuid::Uuid::new_v4().to_string()),
        generation: 8,
        ..RuntimeSnapshot::default()
    };

    cleanup_confirmed_dead_active_runtime(&state).unwrap();

    assert!(!old_dir.exists());
    assert!(preview_dir.join("keep").exists());
    let snapshot = state.runtime_snapshot().unwrap();
    assert!(snapshot.connected_at.is_none());
    assert!(snapshot.owned_runtime_dir.is_none());
    assert_eq!(snapshot.generation, 8);
}

#[test]
fn draining_runtime_directory_survives_until_exit_and_active_directory_remains() {
    let root = TestDir::new();
    let script = fake_core_script(root.path());
    let old_dir = root.path().join("runtime-old");
    let active_dir = root.path().join("runtime-active");
    let old_process = start_fake_core(&script, &old_dir);
    std::fs::create_dir_all(&active_dir).unwrap();
    std::fs::write(active_dir.join("config.json"), b"{}").unwrap();
    let active = connection_body("still-open", "old.example", 1, 2);
    let empty = r#"{"uploadTotal":1,"downloadTotal":2,"connections":[]}"#.to_string();
    let fixture = controller_fixture(vec![active, empty], 2, false);
    let draining = Arc::new(Mutex::new(Vec::new()));
    let core = Arc::new(DrainingCore {
        process: old_process,
        clash_api_port: Some(fixture.port),
        controller_scope: Some(uuid::Uuid::new_v4().to_string()),
        owned_runtime_dir: Some(old_dir.clone()),
    });
    schedule_drain(Arc::clone(&draining), Arc::new(Mutex::new(())), core);

    let first_poll_deadline = Instant::now() + Duration::from_secs(2);
    while fixture.accepted.load(AtomicOrdering::SeqCst) < 1 {
        assert!(Instant::now() < first_poll_deadline, "drain never polled");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(old_dir.exists(), "draining owner must retain its directory");
    assert!(active_dir.exists(), "active generation must not be deleted");

    let cleanup_deadline = Instant::now() + Duration::from_secs(3);
    while old_dir.exists() {
        assert!(
            Instant::now() < cleanup_deadline,
            "old runtime was not removed after confirmed exit"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(active_dir.exists());
    assert!(draining.lock().unwrap().is_empty());
    let requests = fixture.join();
    assert_eq!(requests.len(), 2);
}

#[test]
fn occupied_old_listener_and_dead_candidate_cannot_satisfy_readiness() {
    let root = TestDir::new();
    let occupied_old_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let old_port = occupied_old_listener.local_addr().unwrap().port();
    let selected = find_available_port(old_port).unwrap();
    assert_ne!(selected, old_port, "an occupied default must be skipped");

    let runtime_dir = root.path().join("runtime-dead-candidate");
    std::fs::create_dir_all(&runtime_dir).unwrap();
    let config_path = runtime_dir.join("config.json");
    std::fs::write(&config_path, b"{}").unwrap();
    let process = MihomoProcess::with_binary_for_test("/usr/bin/false");
    process.start(config_path.to_str().unwrap()).unwrap();
    let unused_api = TcpListener::bind("127.0.0.1:0").unwrap();
    let unused_api_port = unused_api.local_addr().unwrap().port();
    drop(unused_api);

    let error = wait_for_candidate_ready(&process, old_port, unused_api_port)
        .expect_err("another process's listener must not make a dead candidate ready");
    assert!(error.contains("exited during startup"), "got: {error}");
}

#[test]
fn drain_polling_stops_before_contacting_an_unregistered_reused_endpoint() {
    let root = TestDir::new();
    let script = fake_core_script(root.path());
    let old_dir = root.path().join("runtime-unregistered");
    let old_process = start_fake_core(&script, &old_dir);
    let active = connection_body("still-open", "old.example", 1, 2);
    let fixture = controller_fixture(vec![active], 1, false);
    let draining = Arc::new(Mutex::new(Vec::new()));
    let operation_lock = Arc::new(Mutex::new(()));
    let core = Arc::new(DrainingCore {
        process: Arc::clone(&old_process),
        clash_api_port: Some(fixture.port),
        controller_scope: Some(uuid::Uuid::new_v4().to_string()),
        owned_runtime_dir: Some(old_dir),
    });
    schedule_drain(
        Arc::clone(&draining),
        Arc::clone(&operation_lock),
        Arc::clone(&core),
    );

    let first_poll_deadline = Instant::now() + Duration::from_secs(2);
    while fixture.accepted.load(AtomicOrdering::SeqCst) < 1 {
        assert!(Instant::now() < first_poll_deadline, "drain never polled");
        std::thread::sleep(Duration::from_millis(5));
    }
    {
        let _operation = operation_lock.lock().unwrap();
        draining
            .lock()
            .unwrap()
            .retain(|item| !Arc::ptr_eq(item, &core));
    }
    std::thread::sleep(DRAIN_POLL_INTERVAL + Duration::from_millis(150));
    assert_eq!(
        fixture.accepted.load(AtomicOrdering::SeqCst),
        1,
        "no poll may occur after lifecycle unregisters the core"
    );
    assert_eq!(fixture.join().len(), 1);
    old_process.stop().unwrap();
}

#[test]
fn managed_connections_aggregate_route_close_and_reject_forged_or_stale_ids() {
    let root = TestDir::new();
    let current_fixture = controller_fixture(
        vec![
            connection_body("current-native", "current.example", 10, 20),
            connection_body("current-native", "current.example", 10, 20),
        ],
        3,
        false,
    );
    let draining_fixture = controller_fixture(
        vec![
            connection_body("old-native", "old.example", 3, 4),
            connection_body("old-native", "old.example", 3, 4),
        ],
        4,
        false,
    );
    let (state, _, _) =
        state_with_managed_cores(root.path(), current_fixture.port, draining_fixture.port);
    let outsider = TcpListener::bind("127.0.0.1:0").unwrap();
    outsider.set_nonblocking(true).unwrap();

    let first = state.list_managed_connections().unwrap();
    assert_eq!(first.upload_total, 13);
    assert_eq!(first.download_total, 24);
    assert_eq!(first.connections.len(), 2);
    assert!(first
        .connections
        .iter()
        .all(|connection| uuid::Uuid::parse_str(&connection.id).is_ok()));
    let old_id = first
        .connections
        .iter()
        .find(|connection| connection.host == "old.example")
        .unwrap()
        .id
        .clone();
    let first_ids = first
        .connections
        .iter()
        .map(|connection| (connection.host.clone(), connection.id.clone()))
        .collect::<HashMap<_, _>>();

    let second = state.list_managed_connections().unwrap();
    let second_ids = second
        .connections
        .iter()
        .map(|connection| (connection.host.clone(), connection.id.clone()))
        .collect::<HashMap<_, _>>();
    assert_eq!(
        first_ids, second_ids,
        "opaque IDs must remain stable per owner"
    );

    assert!(state.close_managed_connection("forged-id").is_err());
    assert!(
        matches!(outsider.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    );
    state.close_managed_connection(&old_id).unwrap();
    assert!(state.close_managed_connection(&old_id).is_err());
    state.close_all_managed_connections().unwrap();

    let current_requests = current_fixture.join();
    let draining_requests = draining_fixture.join();
    assert_eq!(
        current_requests,
        vec![
            "GET /connections HTTP/1.1",
            "GET /connections HTTP/1.1",
            "DELETE /connections HTTP/1.1"
        ]
    );
    assert_eq!(
        draining_requests,
        vec![
            "GET /connections HTTP/1.1",
            "GET /connections HTTP/1.1",
            "DELETE /connections/old-native HTTP/1.1",
            "DELETE /connections HTTP/1.1"
        ]
    );
    state.stop_all_processes().unwrap();
}

#[test]
fn any_managed_controller_failure_preserves_routes_and_returns_error() {
    let root = TestDir::new();
    let healthy = controller_fixture(
        vec![connection_body("current", "current.example", 1, 2)],
        1,
        false,
    );
    let failing = controller_fixture(vec![], 1, true);
    let (state, _, _) = state_with_managed_cores(root.path(), healthy.port, failing.port);
    state.connection_routes.lock().unwrap().insert(
        "existing-opaque-id".into(),
        ConnectionRoute {
            scope: state.runtime_snapshot().unwrap().controller_scope.unwrap(),
            connection_id: "current".into(),
        },
    );

    let error = state.list_managed_connections().unwrap_err();
    assert!(error.contains("managed Mihomo controller"), "got: {error}");
    let routes = state.connection_routes.lock().unwrap();
    assert_eq!(routes.len(), 1);
    assert!(routes.contains_key("existing-opaque-id"));
    drop(routes);
    healthy.join();
    failing.join();
    state.stop_all_processes().unwrap();
}
