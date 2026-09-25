use super::*;
use crate::proxy_runtime::content_checks_for_egress;
use crate::storage::app_config::AppConfig;

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

fn empty_state() -> (Arc<AppState>, ProxyState) {
    // In-memory only: never touch the user's real config in unit tests.
    // AppState and ProxyState share one operation lock, as in production.
    let config = AppConfig {
        subscriptions: vec![],
        strategy_selections: Default::default(),
        nodes: vec![],
        active_node_id: None,
        rule_groups: vec![],
        active_group_id: String::new(),
        host_overrides: vec![],
        autostart: false,
        language: "zh".to_string(),
    };
    let lock = Arc::new(Mutex::new(()));
    let app_state = Arc::new(AppState::new(config, Arc::clone(&lock)));
    let proxy_state = ProxyState::new_with_lock(
        MihomoProcess::new(),
        Arc::new(RecordingSystemProxy::default()),
        2080,
        lock,
    );
    (app_state, proxy_state)
}

fn launch() -> RuntimeLaunch {
    RuntimeLaunch {
        config_path: "/tmp/a.json".into(),
        owned_runtime_dir: None,
        node_id: "node-a".into(),
        node_name: "A".into(),
        node_address: "example.com".into(),
        node_port: 443,
        group_id: "group-a".into(),
        group_name: "A".into(),
        clash_api_port: 59091,
        listen_port: 52081,
    }
}

#[test]
fn disconnect_preserves_monotonic_generation() {
    let (_, state) = empty_state();
    set_runtime_connected(&state, &launch(), false).unwrap();
    let gen = state.runtime_snapshot().unwrap().generation;
    assert!(gen >= 1);

    set_runtime_disconnected(&state).unwrap();
    let after = state.runtime_snapshot().unwrap();
    assert!(after.connected_at.is_none());
    assert_eq!(after.generation, gen);

    // Reconnect advances, never reuses generation 1.
    set_runtime_connected(&state, &launch(), false).unwrap();
    assert!(state.runtime_snapshot().unwrap().generation > gen);
    state.traffic.detach();
}

#[test]
fn preflight_handoff_is_one_shot_and_exactly_keyed() {
    let (_, state) = empty_state();
    let runtime = launch();
    let checks = content_checks_for_egress("198.51.100.5".to_string());
    state.store_preflight_handoff(&runtime, 9, checks.clone());

    let first = state.take_preflight_handoff(9, runtime.listen_port, "node-a", "group-a");
    assert_eq!(first, Some(checks.clone()));
    // Second preflight must not reuse the connect result.
    let second = state.take_preflight_handoff(9, runtime.listen_port, "node-a", "group-a");
    assert_eq!(second, None);

    state.store_preflight_handoff(&runtime, 9, checks.clone());
    // Any key mismatch is treated as a different runtime.
    assert_eq!(
        state.take_preflight_handoff(10, runtime.listen_port, "node-a", "group-a"),
        None
    );
    state.store_preflight_handoff(&runtime, 9, checks.clone());
    assert_eq!(
        state.take_preflight_handoff(9, 52082, "node-a", "group-a"),
        None
    );
    state.store_preflight_handoff(&runtime, 9, checks);
    assert_eq!(
        state.take_preflight_handoff(9, runtime.listen_port, "node-b", "group-a"),
        None
    );
}

#[test]
fn preflight_handoff_expires_after_ttl() {
    let (_, state) = empty_state();
    if let Ok(mut handoff) = state.preflight_handoff.lock() {
        *handoff = Some(PreflightHandoff {
            generation: 3,
            listen_port: 52081,
            node_id: "node-a".into(),
            group_id: "group-a".into(),
            recorded_at: Instant::now() - PREFLIGHT_HANDOFF_TTL - Duration::from_millis(10),
            checks: content_checks_for_egress("198.51.100.5".to_string()),
        });
    }
    assert_eq!(
        state.take_preflight_handoff(3, 52081, "node-a", "group-a"),
        None
    );
}

#[test]
fn lifecycle_operations_are_rejected_after_shutdown_intent() {
    let (app_state, state) = empty_state();

    // Simulate a queued operation already holding the lock while shutdown
    // intent is latched; once it releases, connect/reload must refuse.
    let held = state.operation_lock.lock().unwrap();
    state.mark_shutting_down();
    drop(held);

    let error = connect_core(&app_state, &state).unwrap_err();
    assert!(error.contains("shutting down"), "got: {error}");

    let error = reload_proxy_if_running(&app_state, &state).unwrap_err();
    assert!(error.contains("shutting down"), "got: {error}");

    let error = apply_runtime_config_change(&app_state, &state, |config| {
        config.language = "en".into();
        Ok(())
    })
    .unwrap_err();
    assert_eq!(error.code, "lifecycle_failed");
    assert!(error.message.contains("shutting down"));

    // Normal disconnect remains permitted after shutdown (used by Quit).
    assert!(disconnect_core(&state).is_ok());
}

#[test]
fn preflight_context_refuses_without_a_live_core() {
    // connected_at can remain recorded after a crashed child; without a
    // real running core the preflight context must be refused.
    let (_, state) = empty_state();
    set_runtime_connected(&state, &launch(), false).unwrap();
    let operation = state.operation_lock.lock().unwrap();
    assert!(state.preflight_context(&operation).is_none());
    state.traffic.detach();
}
