use super::*;

#[test]
fn read_output_keeps_only_the_500_line_ui_ring() {
    let logs = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES)));
    // No-op sink keeps this test away from the global writer/user log dir.
    let no_persist = |_: &LogEntry| {};

    let input = (0..600)
        .map(|i| format!("line-{i}"))
        .collect::<Vec<_>>()
        .join("\n");
    read_output_into_logs(input.as_bytes(), &logs, no_persist);

    let buffer = logs.lock().unwrap();
    assert_eq!(buffer.len(), MAX_LOG_LINES);
    assert_eq!(buffer.front().unwrap().message, "line-100");
    assert_eq!(buffer.back().unwrap().message, "line-599");
}

#[test]
fn read_output_parses_json_and_plain_lines() {
    let logs = Arc::new(Mutex::new(VecDeque::new()));
    let no_persist = |_: &LogEntry| {};
    let input =
        "{\"level\":\"warn\",\"msg\":\"json line\",\"time\":\"2026-09-12 10:00:00\"}\nplain line\n";
    read_output_into_logs(input.as_bytes(), &logs, no_persist);

    let buffer = logs.lock().unwrap();
    assert_eq!(buffer.len(), 2);
    assert_eq!(buffer[0].level, "warn");
    assert_eq!(buffer[0].message, "json line");
    assert_eq!(buffer[0].timestamp, "2026-09-12 10:00:00");
    assert_eq!(buffer[1].level, "info");
    assert_eq!(buffer[1].message, "plain line");
}

#[test]
fn persist_sink_is_invoked_for_every_drained_line() {
    use std::sync::atomic::AtomicUsize;
    let logs = Arc::new(Mutex::new(VecDeque::new()));
    let count = Arc::new(AtomicUsize::new(0));
    let sink = {
        let count = count.clone();
        move |_: &LogEntry| {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    };

    read_output_into_logs(b"a\nb\nc\n".as_slice(), &logs, sink);
    assert_eq!(
        count.load(std::sync::atomic::Ordering::SeqCst),
        3,
        "persistence sink must receive every parsed line"
    );
}

#[test]
fn core_logs_redact_subscription_credentials_and_device_paths() {
    let entry = parse_log_line(
        r#"time=now level=error msg=\"Get https://user:password@example.com/__pingu_device__/token?key=private: timeout\""#,
    );
    for secret in ["password", "token", "private", "user:"] {
        assert!(!entry.message.contains(secret));
    }
    assert!(entry.message.contains("timeout"));
}

struct ValidationTempDir(PathBuf);

impl ValidationTempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "pingu-validator-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for ValidationTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn rejected_validator_confirms_exit_before_owned_cleanup() {
    let dir = ValidationTempDir::new();
    let config = dir.0.join("config.json");
    std::fs::write(&config, b"{}").unwrap();
    let error = MihomoProcess::with_binary_for_test("/usr/bin/false")
        .check(config.to_str().unwrap())
        .expect_err("false must reject validation");
    assert!(error.exit_confirmed());
    let message = error.finish_owned_cleanup(Some(dir.0.clone()));
    assert!(message.contains("rejected"));
    assert!(!dir.0.exists());
}

#[test]
fn unconfirmed_validator_retains_directory_until_reaped() {
    let dir = ValidationTempDir::new();
    std::fs::write(dir.0.join("config.json"), b"{}").unwrap();
    let child = Command::new("/bin/sh")
        .args(["-c", "sleep 0.2"])
        .spawn()
        .unwrap();
    let error = ValidationError::unconfirmed("validation pending", child);
    let message = error.finish_owned_cleanup(Some(dir.0.clone()));
    assert_eq!(message, "validation pending");
    assert!(dir.0.exists(), "directory must remain while child is live");

    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while dir.0.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "reaper never confirmed exit and cleaned ownership"
        );
        thread::sleep(Duration::from_millis(10));
    }
}
