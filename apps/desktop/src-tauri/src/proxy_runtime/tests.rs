use super::*;
use crate::mihomo::config_gen::{Rule, RuleGroup};

// These are the only tests that change the registry. Serialize them and restore
// the caller's value even on failure; never leak test configuration to a peer.
static REGISTRY_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
struct RegistryEnv {
    previous: Option<std::ffi::OsString>,
    _lock: std::sync::MutexGuard<'static, ()>,
}
impl RegistryEnv {
    fn install() -> Self {
        let lock = REGISTRY_ENV_LOCK.lock().unwrap();
        let previous = std::env::var_os("NPM_CONFIG_REGISTRY");
        std::env::set_var("NPM_CONFIG_REGISTRY", "https://bnpm.byted.org/");
        Self {
            previous,
            _lock: lock,
        }
    }
}
impl Drop for RegistryEnv {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("NPM_CONFIG_REGISTRY", value),
            None => std::env::remove_var("NPM_CONFIG_REGISTRY"),
        }
    }
}

#[test]
fn port_selection_skips_an_occupied_port() {
    let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
    let start = occupied.local_addr().unwrap().port();
    let chosen = find_available_port(start).unwrap();
    assert!(chosen > start && chosen <= start.saturating_add(100));
}

fn sample_node(id: &str) -> Node {
    Node {
        id: id.to_string(),
        name: "Node".to_string(),
        address: "example.com".to_string(),
        port: 443,
        uuid: "123e4567-e89b-12d3-a456-426614174000".to_string(),
        flow: String::new(),
        security: "tls".to_string(),
        sni: "example.com".to_string(),
        fingerprint: String::new(),
        public_key: String::new(),
        short_id: String::new(),
        transport: "tcp".to_string(),
        ..Default::default()
    }
}

fn sample_group(id: &str, name: &str) -> RuleGroup {
    RuleGroup {
        id: id.to_string(),
        name: name.to_string(),
        rules: vec![Rule {
            id: "rule-1".to_string(),
            rule_type: "domain_suffix".to_string(),
            match_value: "example.com".to_string(),
            outbound: "proxy".to_string(),
        }],
        default_strategy: "proxy".to_string(),
        fake_ip_filter: vec![],
        nameserver_policy: vec![],
    }
}

fn sample_config() -> AppConfig {
    AppConfig {
        proxy_chain: Default::default(),
        subscriptions: vec![],
        strategy_selections: Default::default(),
        nodes: vec![sample_node("node-1")],
        active_node_id: Some("node-1".to_string()),
        rule_groups: vec![sample_group("group-1", "Default")],
        active_group_id: "group-1".to_string(),
        host_overrides: vec![],
        autostart: false,
        language: "zh".to_string(),
    }
}

#[test]
fn resolve_runtime_selection_returns_active_node_and_group() {
    let selection = resolve_runtime_selection(&sample_config()).unwrap();

    assert_eq!(selection.node.id, "node-1");
    assert_eq!(selection.rule_group.id, "group-1");
}

#[test]
fn build_proxy_status_returns_group_name_from_config() {
    let status = build_proxy_status(
        &sample_config(),
        true,
        42,
        Some("node-1".to_string()),
        Some("group-1".to_string()),
    );

    assert_eq!(
        status,
        ProxyStatus {
            connected: true,
            active_node_id: Some("node-1".to_string()),
            active_group_id: Some("group-1".to_string()),
            active_group_name: Some("Default".to_string()),
            uptime_seconds: 42,
        }
    );
}

#[test]
fn build_proxy_status_resets_snapshot_when_disconnected() {
    let status = build_proxy_status(
        &sample_config(),
        false,
        99,
        Some("node-1".to_string()),
        Some("group-1".to_string()),
    );

    assert_eq!(
        status,
        ProxyStatus {
            connected: false,
            active_node_id: None,
            active_group_id: None,
            active_group_name: None,
            uptime_seconds: 0,
        }
    );
}

#[test]
fn parse_egress_ip_accepts_a_plain_text_ip_response() {
    assert_eq!(parse_egress_ip("154.26.187.44\n").unwrap(), "154.26.187.44");
    assert_eq!(parse_egress_ip("2001:db8::1").unwrap(), "2001:db8::1");
}

#[test]
fn parse_egress_ip_rejects_an_html_page() {
    assert!(parse_egress_ip("<html><body>154.26.187.44</body></html>").is_err());
}

#[test]
fn ai_preflight_reports_the_effective_route_for_each_service() {
    let mut config = sample_config();
    config.rule_groups[0].default_strategy = "direct".to_string();
    config.rule_groups[0].rules.push(Rule {
        id: "claude-proxy".to_string(),
        rule_type: "domain_suffix".to_string(),
        match_value: "anthropic.com".to_string(),
        outbound: "proxy".to_string(),
    });

    let report = build_ai_service_preflight(
        &config,
        "154.26.187.44".to_string(),
        content_checks_for_egress("154.26.187.44".to_string()),
    )
    .unwrap();
    assert_eq!(report.egress_ip, "154.26.187.44");
    assert!(!report.ready);
    assert_eq!(report.routes[0].outbound, "proxy");
    assert_eq!(report.routes[1].outbound, "direct");

    config.rule_groups[0].default_strategy = "proxy".to_string();
    config.rule_groups[0].rules.push(Rule {
        id: "chatgpt-direct".to_string(),
        rule_type: "domain".to_string(),
        match_value: "chatgpt.com".to_string(),
        outbound: "direct".to_string(),
    });
    let report = build_ai_service_preflight(
        &config,
        "154.26.187.44".to_string(),
        content_checks_for_egress("154.26.187.44".to_string()),
    )
    .unwrap();
    assert!(!report.ready);
    assert_eq!(report.routes[3].outbound, "direct");
    assert_eq!(report.routes[3].matched_by, "domain: chatgpt.com");
}

#[test]
fn ai_preflight_does_not_mistake_dynamic_default_routing_for_direct() {
    let mut config = AppConfig::default_config();
    let report = build_ai_service_preflight(
        &config, "203.0.113.1".into(), content_checks_for_egress("203.0.113.1".into()),
    ).unwrap();
    assert!(report.routes.iter().all(|route| route.outbound == "runtime"));

    // A rule before the dataset is still authoritative and can be reported.
    config.rule_groups[0].rules.insert(0, Rule {
        id: "explicit".into(), rule_type: "domain".into(),
        match_value: "api.anthropic.com".into(), outbound: "proxy".into(),
    });
    let report = build_ai_service_preflight(
        &config, "203.0.113.1".into(), content_checks_for_egress("203.0.113.1".into()),
    ).unwrap();
    assert_eq!(report.routes[0].outbound, "proxy");
    assert_eq!(report.routes[1].outbound, "runtime");
}

#[test]
fn discover_runtime_host_override_adds_system_dns_for_matching_npm_registry() {
    let _registry = RegistryEnv::install();
    let group = RuleGroup {
        id: "group-1".to_string(),
        name: "Default".to_string(),
        rules: vec![],
        default_strategy: "proxy".to_string(),
        fake_ip_filter: vec![],
        nameserver_policy: vec![NameServerPolicy {
            domain_suffix: "+.byted.org".to_string(),
            server: "100.82.0.1".to_string(),
            servers: vec![],
        }],
    };

    let item = discover_runtime_host_override(&group, &std::collections::HashSet::new())
        .expect("runtime fallback override");

    assert_eq!(item.id, "runtime-fallback-bnpm.byted.org");
    assert_eq!(item.host, "bnpm.byted.org");
    assert_eq!(item.resolver_mode, "system-dns");
    assert_eq!(item.outbound_mode, "inherit");
    assert!(item.enabled);
    assert_eq!(item.source, "runtime_fallback");
    assert_eq!(
        item.reason,
        "Current npm registry matched nameserver policy"
    );
    assert!(!item.updated_at.is_empty());
}

#[test]
fn resolve_runtime_host_overrides_prefers_persisted_host_override() {
    let _registry = RegistryEnv::install();
    let mut config = sample_config();
    config.host_overrides.push(HostOverride {
        id: "manual-1".to_string(),
        host: "bnpm.byted.org".to_string(),
        resolver_mode: "remote-dns".to_string(),
        outbound_mode: "direct".to_string(),
        enabled: true,
        source: "manual".to_string(),
        reason: "manual override".to_string(),
        updated_at: "1".to_string(),
    });
    config.rule_groups[0].nameserver_policy = vec![NameServerPolicy {
        domain_suffix: "+.byted.org".to_string(),
        server: "100.82.0.1".to_string(),
        servers: vec![],
    }];

    let overrides = resolve_runtime_host_overrides(&config, &config.rule_groups[0]);

    assert_eq!(overrides.len(), 1);
    assert_eq!(overrides[0].id, "manual-1");
    assert_eq!(overrides[0].resolver_mode, "remote-dns");
    assert_eq!(overrides[0].outbound_mode, "direct");
}

#[test]
fn run_parallel_checks_runs_all_three_checks_concurrently() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Barrier};

    let barrier = Arc::new(Barrier::new(3));
    let running = Arc::new(AtomicUsize::new(0));
    let max_concurrent = Arc::new(AtomicUsize::new(0));

    // Clone assertion handles BEFORE the factory moves the originals.
    let running_assert = running.clone();
    let max_concurrent_assert = max_concurrent.clone();

    // Factory is `move` so each produced closure owns 'static Arc clones
    // and can be spawned onto an unrelated thread.
    let make_check = move || {
        let barrier = barrier.clone();
        let running = running.clone();
        let max_concurrent = max_concurrent.clone();
        move || -> Result<usize, String> {
            let current = running.fetch_add(1, Ordering::SeqCst) + 1;
            max_concurrent.fetch_max(current, Ordering::SeqCst);
            // A sequential implementation deadlocks here: no single task
            // can cross a barrier waiting for all three checks.
            barrier.wait();
            running.fetch_sub(1, Ordering::SeqCst);
            Ok(current)
        }
    };

    // Run off-thread so a sequential regression fails with a timeout
    // instead of hanging the test process.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = run_parallel_checks(make_check(), make_check(), make_check());
        let _ = tx.send(result);
    });

    let (first, second, third) = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("checks never ran concurrently; barrier was not released");
    assert_eq!(max_concurrent_assert.load(Ordering::SeqCst), 3);
    let mut arrivals = [first.unwrap(), second.unwrap(), third.unwrap()];
    arrivals.sort_unstable();
    assert_eq!(arrivals, [1, 2, 3]);
    assert_eq!(running_assert.load(Ordering::SeqCst), 0);
}

#[test]
fn run_parallel_checks_joins_all_and_reports_panics_as_errors() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let completed = Arc::new(AtomicUsize::new(0));
    let make_ok = || {
        let completed = completed.clone();
        move || -> Result<(), String> {
            completed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    };
    let make_err = || {
        let completed = completed.clone();
        move || -> Result<(), String> {
            completed.fetch_add(1, Ordering::SeqCst);
            Err("boom".to_string())
        }
    };
    let make_panic = || {
        let completed = completed.clone();
        move || -> Result<(), String> {
            completed.fetch_add(1, Ordering::SeqCst);
            panic!("intentional panic marker");
        }
    };

    let (ok, errored, panicked) = run_parallel_checks(make_ok(), make_err(), make_panic());

    // Every task runs to the join; a failing check never short-circuits.
    assert_eq!(completed.load(Ordering::SeqCst), 3);
    assert!(ok.is_ok());
    assert_eq!(errored.unwrap_err(), "boom");
    let panic_error = panicked.unwrap_err();
    assert!(
        panic_error.contains("intentional panic marker"),
        "panic payload should become an error, got: {panic_error}"
    );
}

#[test]
fn finalize_content_checks_accepts_consistent_egress_and_204() {
    let checks = finalize_content_checks(
        Ok("154.26.187.44".to_string()),
        Ok("154.26.187.44".to_string()),
        Ok(204),
    )
    .expect("matching IPv4 egress and HTTP 204 must succeed");

    assert_eq!(
        checks,
        content_checks_for_egress("154.26.187.44".to_string())
    );
}

#[test]
fn finalize_content_checks_accepts_and_reports_policy_specific_egress() {
    let checks = finalize_content_checks(
        Ok("154.26.187.44".into()),
        Ok("154.26.187.99".into()),
        Ok(204),
    )
    .unwrap();
    assert_eq!(checks[0].observed_ip.as_deref(), Some("154.26.187.44"));
    assert_eq!(checks[1].observed_ip.as_deref(), Some("154.26.187.99"));
}

#[test]
fn finalize_content_checks_rejects_non_204_google_response() {
    let error = finalize_content_checks(
        Ok("154.26.187.44".to_string()),
        Ok("154.26.187.44".to_string()),
        Ok(200),
    )
    .expect_err("HTTP 200 from generate_204 must fail");

    assert_eq!(
        error,
        "Google content check returned HTTP 200 instead of 204"
    );
}

#[test]
fn finalize_content_checks_propagates_each_probe_failure() {
    let egress_error = finalize_content_checks(
        Err("egress probe down".to_string()),
        Ok("154.26.187.44".to_string()),
        Ok(204),
    )
    .expect_err("egress failure must fail");
    assert_eq!(egress_error, "egress probe down");

    let cloudflare_error = finalize_content_checks(
        Ok("154.26.187.44".to_string()),
        Err("trace down".to_string()),
        Ok(204),
    )
    .expect_err("cloudflare failure must fail");
    assert_eq!(cloudflare_error, "trace down");

    let google_error = finalize_content_checks(
        Ok("154.26.187.44".to_string()),
        Ok("154.26.187.44".to_string()),
        Err("google down".to_string()),
    )
    .expect_err("google failure must fail");
    assert_eq!(google_error, "google down");
}

/// An unsupported subscription construct must stop runtime preparation with a
/// reported error, rather than silently routing traffic with changed membership.
#[test]
fn prepare_runtime_reports_unsupported_subscription_construct() {
    let (fragment, warnings) = crate::mihomo::profiles::parse_body("proxies: [{name: HK-1, type: socks5, server: 127.0.0.1, port: 1080}]\nproxy-groups: [{name: Pick, type: url-test, include-all-proxies: true, filter: '(?=HK)'}]\nrules: ['MATCH,Pick']").unwrap();
    let mut config = sample_config();
    config
        .subscriptions
        .push(crate::mihomo::profiles::Subscription {
            nodes_only: false,
            id: "source".into(),
            name: "Source".into(),
            input: String::new(),
            enabled: true,
            updated_at: String::new(),
            last_error: None,
            fragment,
            warnings,
        });
    let root = runtime_temp_dir();
    let error = match prepare_runtime_generation_in_dir_with_port(
        &config,
        None,
        2080,
        root.0.join("mihomo"),
    ) {
        Err(error) => error,
        Ok(_) => panic!("an unsupported construct must not prepare a runtime"),
    };
    assert!(
        error.contains("unsupported filter pattern") && error.contains("(?=HK)"),
        "error must name the construct: {error}"
    );
    assert!(error.starts_with("Cannot start proxy:"), "{error}");
}

struct RuntimeTempDir(PathBuf);

impl Drop for RuntimeTempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn runtime_temp_dir() -> RuntimeTempDir {
    let path = std::env::temp_dir().join(format!(
        "pingu-runtime-ownership-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&path).unwrap();
    RuntimeTempDir(path)
}

#[test]
fn rejected_generation_removes_only_its_fresh_owned_directory() {
    let root = runtime_temp_dir();
    let mihomo_dir = root.0.join("mihomo");
    let preview_dir = mihomo_dir.join("preview");
    let persisted = mihomo_dir.join("user-config.json");
    std::fs::create_dir_all(&preview_dir).unwrap();
    std::fs::write(preview_dir.join("keep.txt"), b"preview").unwrap();
    std::fs::write(&persisted, b"persisted").unwrap();

    let (fragment, warnings) = crate::mihomo::profiles::parse_body("proxies: [{name: HK-1, type: socks5, server: 127.0.0.1, port: 1080}]\nproxy-groups: [{name: Pick, type: url-test, include-all-proxies: true, filter: '(?=HK)'}]\nrules: ['MATCH,Pick']").unwrap();
    let mut config = sample_config();
    config
        .subscriptions
        .push(crate::mihomo::profiles::Subscription {
            nodes_only: false,
            id: "source".into(),
            name: "Source".into(),
            input: String::new(),
            enabled: true,
            updated_at: String::new(),
            last_error: None,
            fragment,
            warnings,
        });

    let error = match prepare_runtime_generation_in_dir_with_port(
        &config,
        Some(7),
        2080,
        mihomo_dir.clone(),
    ) {
        Err(error) => error,
        Ok(_) => panic!("fallible generation must reject the unsupported filter"),
    };
    assert!(error.contains("unsupported filter pattern"));

    let names = std::fs::read_dir(&mihomo_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(
        names,
        ["preview", "user-config.json"]
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect()
    );
    assert_eq!(
        std::fs::read(preview_dir.join("keep.txt")).unwrap(),
        b"preview"
    );
    assert_eq!(std::fs::read(persisted).unwrap(), b"persisted");
}

#[test]
fn startup_checks_retry_a_listening_but_unready_core() {
    let mut attempts = 0;
    let checks = retry_startup_check(Duration::from_secs(1), Duration::ZERO, |_| {
        attempts += 1;
        if attempts < 3 {
            Err("Provider initialization has not finished".into())
        } else {
            Ok(content_checks_for_egress("192.0.2.1".into()))
        }
    }).unwrap();
    assert_eq!(attempts, 3);
    assert_eq!(checks[0].observed_ip.as_deref(), Some("192.0.2.1"));
}

#[test]
fn startup_checks_fail_closed_when_no_attempt_is_ready() {
    let result: Result<(), String> = retry_startup_check(
        Duration::from_secs(1), Duration::from_secs(2),
        |_| Err("Provider initialization failed".into()),
    );
    assert_eq!(result.unwrap_err(), "Provider initialization failed");
}
