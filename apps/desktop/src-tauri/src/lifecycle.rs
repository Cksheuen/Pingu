use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::commands::config::AppState;
use crate::proxy_runtime::{prepare_runtime_generation_with_port, PreparedRuntime};
use crate::singbox::process::SingBoxProcess;
use crate::storage::app_config::AppConfig;
use crate::system::{MacOsSystemProxyControl, SystemProxyControl};

#[derive(Debug, Clone, Default)]
pub struct RuntimeSnapshot {
    pub connected_at: Option<Instant>,
    pub running_node_id: Option<String>,
    pub running_group_id: Option<String>,
    pub clash_api_port: Option<u16>,
    pub config_path: Option<PathBuf>,
    pub generation: u64,
}

pub struct ProxyState {
    pub process: SingBoxProcess,
    pub operation_lock: Mutex<()>,
    pub runtime: Mutex<RuntimeSnapshot>,
    pub system_proxy: Arc<dyn SystemProxyControl>,
    pub listen_port: u16,
}

impl ProxyState {
    pub fn production() -> Self {
        Self::new(
            SingBoxProcess::new(),
            Arc::new(MacOsSystemProxyControl),
            2080,
        )
    }

    pub fn new(
        process: SingBoxProcess,
        system_proxy: Arc<dyn SystemProxyControl>,
        listen_port: u16,
    ) -> Self {
        Self {
            process,
            operation_lock: Mutex::new(()),
            runtime: Mutex::new(RuntimeSnapshot::default()),
            system_proxy,
            listen_port,
        }
    }

    pub fn runtime_snapshot(&self) -> Result<RuntimeSnapshot, String> {
        self.runtime
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|error| error.to_string())
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LifecycleError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub config_applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_connections: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl LifecycleError {
    pub fn external(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self::failed(code, message, retryable)
    }

    fn failed(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable,
            config_applied: false,
            active_connections: None,
            reason: None,
        }
    }

    fn reload_blocked(active_connections: Option<usize>, reason: &str) -> Self {
        let message = match active_connections {
            Some(count) => format!(
                "Pingu detected {count} active connection(s); close them or disconnect before changing the running configuration"
            ),
            None => "Pingu could not verify active connections; disconnect before changing the running configuration".to_string(),
        };
        Self {
            code: "reload_blocked".to_string(),
            message,
            retryable: true,
            config_applied: false,
            active_connections,
            reason: Some(reason.to_string()),
        }
    }
}

impl std::fmt::Display for LifecycleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

pub struct RuntimeLaunch {
    pub config_path: PathBuf,
    pub node_id: String,
    pub node_name: String,
    pub node_address: String,
    pub node_port: u16,
    pub group_id: String,
    pub group_name: String,
    pub clash_api_port: u16,
}

pub fn connect_core(app_state: &AppState, proxy_state: &ProxyState) -> Result<(), String> {
    let _operation = proxy_state
        .operation_lock
        .lock()
        .map_err(|error| format!("Lifecycle lock failed: {error}"))?;

    if proxy_state.process.is_running() {
        return Err("sing-box is already running".to_string());
    }

    crate::gate::renew_if_enabled()
        .map_err(|error| format!("Automatic network access failed: {error}"))?;
    let runtime = prepare_runtime_launch(app_state, proxy_state)?;

    proxy_state
        .process
        .start(runtime.config_path.to_str().ok_or("Invalid path")?)?;

    if let Err(error) = wait_for_local_proxy_port(proxy_state) {
        return Err(cleanup_runtime_failure_locked(proxy_state, error));
    }

    if let Err(error) = proxy_state.system_proxy.set(proxy_state.listen_port) {
        return Err(cleanup_runtime_failure_locked(
            proxy_state,
            format!("Failed to configure system proxy: {error}"),
        ));
    }

    if let Err(error) = set_runtime_connected(proxy_state, &runtime, false) {
        return Err(cleanup_runtime_failure_locked(
            proxy_state,
            format!("Failed to record runtime snapshot: {error}"),
        ));
    }

    proxy_state.process.add_log(
        "info",
        &format!(
            "Connected to {} ({}:{})",
            runtime.node_name, runtime.node_address, runtime.node_port
        ),
    );
    proxy_state.process.add_log(
        "info",
        &format!("Active rule group: {}", runtime.group_name),
    );
    proxy_state.process.add_log(
        "info",
        &format!(
            "System proxy configured on port {}",
            proxy_state.listen_port
        ),
    );

    Ok(())
}

pub fn disconnect_core(proxy_state: &ProxyState) -> Result<(), String> {
    let _operation = proxy_state
        .operation_lock
        .lock()
        .map_err(|error| format!("Lifecycle lock failed: {error}"))?;
    disconnect_locked(proxy_state, true)
}

pub fn shutdown_core(proxy_state: &ProxyState) -> Result<(), String> {
    let _operation = proxy_state
        .operation_lock
        .lock()
        .map_err(|error| format!("Lifecycle lock failed: {error}"))?;
    disconnect_locked(proxy_state, false)
}

fn disconnect_locked(proxy_state: &ProxyState, write_log: bool) -> Result<(), String> {
    let mut errors = Vec::new();

    if let Err(error) = proxy_state.process.stop() {
        errors.push(format!("Failed to stop sing-box: {error}"));
    }
    if let Err(error) = proxy_state.system_proxy.clear() {
        errors.push(format!("Failed to clear system proxy: {error}"));
    }
    if let Err(error) = set_runtime_disconnected(proxy_state) {
        errors.push(format!("Failed to clear runtime snapshot: {error}"));
    }

    if errors.is_empty() {
        if write_log {
            proxy_state
                .process
                .add_log("info", "Disconnected, system proxy cleared");
        }
        Ok(())
    } else {
        let combined_error = errors.join("; ");
        proxy_state.process.add_log("error", &combined_error);
        Err(combined_error)
    }
}

pub fn reload_proxy_if_running(
    app_state: &AppState,
    proxy_state: &ProxyState,
) -> Result<(), String> {
    let _operation = proxy_state
        .operation_lock
        .lock()
        .map_err(|error| format!("Lifecycle lock failed: {error}"))?;

    if !proxy_state.process.is_running() {
        return Ok(());
    }

    crate::gate::renew_if_enabled()
        .map_err(|error| format!("Automatic network access failed: {error}"))?;

    // Prepare and validate the replacement before touching the running process.
    let runtime = prepare_runtime_launch(app_state, proxy_state)?;
    let previous = proxy_state.runtime_snapshot()?;

    proxy_state
        .process
        .stop()
        .map_err(|error| format!("Failed to stop sing-box before reload: {error}"))?;

    let start_result = proxy_state
        .process
        .start(runtime.config_path.to_str().ok_or("Invalid path")?)
        .and_then(|_| wait_for_local_proxy_port(proxy_state));

    if let Err(error) = start_result {
        let recovery_error = recover_previous_runtime(proxy_state, &previous).err();
        let mut message = format!("Failed to start sing-box during reload: {error}");
        if let Some(recovery_error) = recovery_error {
            let _ = proxy_state.system_proxy.clear();
            let _ = set_runtime_disconnected(proxy_state);
            message.push_str(&format!(
                "; failed to restore previous runtime: {recovery_error}"
            ));
        }
        proxy_state.process.add_log("error", &message);
        return Err(message);
    }

    set_runtime_connected(proxy_state, &runtime, true).map_err(|error| {
        cleanup_runtime_failure_locked(
            proxy_state,
            format!("Failed to record runtime snapshot after reload: {error}"),
        )
    })?;

    proxy_state.process.add_log(
        "info",
        &format!(
            "Reloaded sing-box with {} ({}:{})",
            runtime.node_name, runtime.node_address, runtime.node_port
        ),
    );
    proxy_state.process.add_log(
        "info",
        &format!("Active rule group: {}", runtime.group_name),
    );

    Ok(())
}

fn recover_previous_runtime(
    proxy_state: &ProxyState,
    previous: &RuntimeSnapshot,
) -> Result<(), String> {
    let config_path = previous
        .config_path
        .as_ref()
        .ok_or("Previous runtime config is unavailable")?;
    proxy_state
        .process
        .start(config_path.to_str().ok_or("Invalid previous config path")?)?;
    wait_for_local_proxy_port(proxy_state)?;
    *proxy_state
        .runtime
        .lock()
        .map_err(|error| error.to_string())? = previous.clone();
    Ok(())
}

pub fn apply_runtime_config_change<T>(
    app_state: &AppState,
    proxy_state: &ProxyState,
    mutate: impl FnOnce(&mut AppConfig) -> Result<T, String>,
) -> Result<T, LifecycleError> {
    let _operation = proxy_state.operation_lock.lock().map_err(|error| {
        LifecycleError::failed(
            "lifecycle_failed",
            format!("Lifecycle lock failed: {error}"),
            true,
        )
    })?;
    let mut config_guard = app_state
        .config
        .lock()
        .map_err(|error| LifecycleError::failed("lifecycle_failed", error.to_string(), true))?;
    let mut candidate = config_guard.clone();
    let result = mutate(&mut candidate)
        .map_err(|error| LifecycleError::failed("validation_failed", error, false))?;

    if !proxy_state.process.is_running() {
        candidate
            .save()
            .map_err(|error| LifecycleError::failed("config_save_failed", error, true))?;
        *config_guard = candidate;
        return Ok(result);
    }

    let previous = proxy_state
        .runtime_snapshot()
        .map_err(|error| LifecycleError::failed("lifecycle_failed", error, true))?;
    let next_generation = previous.generation.saturating_add(1);
    let runtime = prepare_runtime_launch_for_config(&candidate, proxy_state, next_generation)
        .map_err(|error| LifecycleError::failed("validation_failed", error, false))?;

    let active_connections = query_active_connections(previous.clash_api_port)
        .map_err(|_| LifecycleError::reload_blocked(None, "connections_unavailable"))?;
    if active_connections > 0 {
        return Err(LifecycleError::reload_blocked(
            Some(active_connections),
            "active_connections",
        ));
    }

    proxy_state.process.stop().map_err(|error| {
        LifecycleError::failed(
            "lifecycle_failed",
            format!("Failed to stop sing-box before reload: {error}"),
            true,
        )
    })?;

    let start_result =
        proxy_state
            .process
            .start(runtime.config_path.to_str().ok_or_else(|| {
                LifecycleError::failed("validation_failed", "Invalid path", false)
            })?)
            .and_then(|_| wait_for_local_proxy_port(proxy_state));

    if let Err(error) = start_result {
        let recovery_error = recover_previous_runtime(proxy_state, &previous).err();
        if let Some(recovery_error) = recovery_error {
            let _ = proxy_state.system_proxy.clear();
            let _ = set_runtime_disconnected(proxy_state);
            return Err(LifecycleError::failed(
                "lifecycle_failed",
                format!(
                    "Failed to start candidate runtime: {error}; failed to restore previous runtime: {recovery_error}"
                ),
                true,
            ));
        }
        return Err(LifecycleError::failed(
            "lifecycle_failed",
            format!("Failed to start candidate runtime: {error}; previous runtime restored"),
            true,
        ));
    }

    if let Err(error) = candidate.save() {
        let _ = proxy_state.process.stop();
        let recovery_error = recover_previous_runtime(proxy_state, &previous).err();
        if recovery_error.is_some() {
            let _ = proxy_state.system_proxy.clear();
            let _ = set_runtime_disconnected(proxy_state);
        }
        return Err(LifecycleError::failed("config_save_failed", error, true));
    }

    set_runtime_connected(proxy_state, &runtime, true)
        .map_err(|error| LifecycleError::failed("lifecycle_failed", error, true))?;
    *config_guard = candidate;
    proxy_state.process.add_log(
        "info",
        &format!(
            "Reloaded sing-box with {} ({})",
            runtime.node_name, runtime.group_name
        ),
    );
    Ok(result)
}

fn query_active_connections(clash_api_port: Option<u16>) -> Result<usize, String> {
    let port = clash_api_port.ok_or("Clash API is unavailable")?;
    let url = format!("http://127.0.0.1:{port}/connections");
    let response: serde_json::Value = ureq::get(&url)
        .timeout(Duration::from_millis(500))
        .call()
        .map_err(|error| format!("Failed to query active connections: {error}"))?
        .into_json()
        .map_err(|error| format!("Failed to parse active connections: {error}"))?;
    response
        .get("connections")
        .and_then(|connections| connections.as_array())
        .map(|connections| connections.len())
        .ok_or_else(|| "Active connections response is missing connections".to_string())
}

pub fn prepare_runtime_launch(
    app_state: &AppState,
    proxy_state: &ProxyState,
) -> Result<RuntimeLaunch, String> {
    let config = app_state.config.lock().map_err(|error| error.to_string())?;
    let generation = proxy_state.runtime_snapshot()?.generation.saturating_add(1);
    let prepared =
        prepare_runtime_generation_with_port(&config, Some(generation), proxy_state.listen_port)?;
    drop(config);
    runtime_launch_from_prepared(prepared, proxy_state)
}

fn prepare_runtime_launch_for_config(
    config: &AppConfig,
    proxy_state: &ProxyState,
    generation: u64,
) -> Result<RuntimeLaunch, String> {
    runtime_launch_from_prepared(
        prepare_runtime_generation_with_port(config, Some(generation), proxy_state.listen_port)?,
        proxy_state,
    )
}

fn runtime_launch_from_prepared(
    prepared: PreparedRuntime,
    proxy_state: &ProxyState,
) -> Result<RuntimeLaunch, String> {
    let runtime = RuntimeLaunch {
        config_path: prepared.config_path.clone(),
        node_id: prepared.node.id.clone(),
        node_name: prepared.node.name.clone(),
        node_address: prepared.node.address.clone(),
        node_port: prepared.node.port,
        group_id: prepared.rule_group.id.clone(),
        group_name: prepared.rule_group.name.clone(),
        clash_api_port: prepared.clash_api_port,
    };
    proxy_state
        .process
        .check(runtime.config_path.to_str().ok_or("Invalid path")?)?;
    Ok(runtime)
}

fn set_runtime_connected(
    proxy_state: &ProxyState,
    runtime: &RuntimeLaunch,
    preserve_connected_at: bool,
) -> Result<(), String> {
    let mut snapshot = proxy_state
        .runtime
        .lock()
        .map_err(|error| error.to_string())?;
    let connected_at = if preserve_connected_at {
        snapshot.connected_at.unwrap_or_else(Instant::now)
    } else {
        Instant::now()
    };
    let generation = snapshot.generation.saturating_add(1);
    *snapshot = RuntimeSnapshot {
        connected_at: Some(connected_at),
        running_node_id: Some(runtime.node_id.clone()),
        running_group_id: Some(runtime.group_id.clone()),
        clash_api_port: Some(runtime.clash_api_port),
        config_path: Some(runtime.config_path.clone()),
        generation,
    };
    Ok(())
}

fn set_runtime_disconnected(proxy_state: &ProxyState) -> Result<(), String> {
    let mut snapshot = proxy_state
        .runtime
        .lock()
        .map_err(|error| error.to_string())?;
    let generation = snapshot.generation;
    *snapshot = RuntimeSnapshot {
        generation,
        ..RuntimeSnapshot::default()
    };
    Ok(())
}

fn cleanup_runtime_failure_locked(proxy_state: &ProxyState, error: String) -> String {
    let mut errors = vec![error];

    if let Err(stop_error) = proxy_state.process.stop() {
        errors.push(format!(
            "Failed to stop sing-box during cleanup: {stop_error}"
        ));
    }
    if let Err(proxy_error) = proxy_state.system_proxy.clear() {
        errors.push(format!(
            "Failed to clear system proxy during cleanup: {proxy_error}"
        ));
    }
    if let Err(state_error) = set_runtime_disconnected(proxy_state) {
        errors.push(format!(
            "Failed to clear runtime snapshot during cleanup: {state_error}"
        ));
    }

    let combined_error = errors.join("; ");
    proxy_state.process.add_log("error", &combined_error);
    combined_error
}

fn wait_for_local_proxy_port(proxy_state: &ProxyState) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], proxy_state.listen_port));
    let timeout = Duration::from_secs(5);
    let poll_interval = Duration::from_millis(100);
    let started_at = Instant::now();

    loop {
        match TcpStream::connect_timeout(&address, poll_interval) {
            Ok(_) => return Ok(()),
            Err(_) => {
                if !proxy_state.process.is_running() {
                    return Err(
                        "sing-box exited during startup, please check the generated config or logs"
                            .to_string(),
                    );
                }
                if started_at.elapsed() >= timeout {
                    return Err(format!(
                        "Timed out waiting for sing-box to listen on 127.0.0.1:{}",
                        proxy_state.listen_port
                    ));
                }
                std::thread::sleep(poll_interval);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            SingBoxProcess::new(),
            Arc::new(RecordingSystemProxy::default()),
            2080,
        );
        let first = RuntimeLaunch {
            config_path: "/tmp/a.json".into(),
            node_id: "node-a".into(),
            node_name: "A".into(),
            node_address: "example.com".into(),
            node_port: 443,
            group_id: "group-a".into(),
            group_name: "A".into(),
            clash_api_port: 9090,
        };
        set_runtime_connected(&state, &first, false).unwrap();
        let initial = state.runtime_snapshot().unwrap();

        let second = RuntimeLaunch {
            config_path: "/tmp/b.json".into(),
            node_id: "node-b".into(),
            group_id: "group-b".into(),
            clash_api_port: 9091,
            ..first
        };
        set_runtime_connected(&state, &second, true).unwrap();
        let reloaded = state.runtime_snapshot().unwrap();

        assert_eq!(initial.connected_at, reloaded.connected_at);
        assert_eq!(reloaded.running_node_id.as_deref(), Some("node-b"));
        assert_eq!(reloaded.running_group_id.as_deref(), Some("group-b"));
        assert_eq!(reloaded.clash_api_port, Some(9091));
        assert_eq!(reloaded.generation, 2);
    }
}
