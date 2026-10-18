use super::*;

#[cfg(target_os = "macos")]
#[test]
fn nonblocking_accepted_control_waits_for_later_worker_frames() {
    use std::io::{BufRead, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;
    let (stream, mut worker) = UnixStream::pair().unwrap();
    stream.set_nonblocking(true).unwrap();
    let mut reader = macos::control_reader(&stream).unwrap();
    let sender = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(30));
        worker.write_all(b"started\n").unwrap();
        std::thread::sleep(Duration::from_millis(30));
        worker.write_all(b"later core log\n").unwrap();
    });
    let mut first = String::new();
    reader.read_line(&mut first).unwrap();
    assert_eq!(first, "started\n");
    stream.set_read_timeout(None).unwrap();
    let mut next = String::new();
    reader.read_line(&mut next).unwrap();
    assert_eq!(next, "later core log\n");
    sender.join().unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn privileged_config_refuses_cache_escape_and_public_control() {
    let base = json!({"tun":{"enable":true}, "allow-lan":false, "bind-address":"127.0.0.1", "external-controller":"127.0.0.1:9090", "secret":"test-private-secret", "proxy-providers":{"a":{"path":"providers/a.yaml"}}});
    assert!(macos::validate_config(&base).is_ok());
    for path in [
        "../../elsewhere",
        "/etc/elsewhere",
        "providers/../elsewhere",
    ] {
        let mut value = base.clone();
        value["proxy-providers"]["a"]["path"] = json!(path);
        assert!(macos::validate_config(&value).is_err());
    }
    let mut value = base.clone();
    value["external-controller"] = json!("0.0.0.0:9090");
    assert!(macos::validate_config(&value).is_err());
    let mut value = base;
    value["external-ui"] = json!("/tmp/ui");
    assert!(macos::validate_config(&value).is_err());
}

#[test]
fn legacy_settings_remain_system_proxy_and_tun_choice_round_trips() {
    let config = crate::storage::app_config::AppConfig::default_config();
    let mut value = serde_json::to_value(&config).unwrap();
    value.as_object_mut().unwrap().remove("network_mode");
    let mut restored: crate::storage::app_config::AppConfig =
        serde_json::from_value(value).unwrap();
    assert_eq!(restored.network_mode, NetworkMode::System);
    restored.network_mode = NetworkMode::Tun;
    let restored: crate::storage::app_config::AppConfig =
        serde_json::from_slice(&serde_json::to_vec(&restored).unwrap()).unwrap();
    assert_eq!(restored.network_mode, NetworkMode::Tun);
}
