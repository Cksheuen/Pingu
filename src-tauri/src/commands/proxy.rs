use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::commands::config::AppState;
use crate::proxy_runtime::{check_generated_config, prepare_runtime};
use crate::singbox::process::{LogEntry, SingBoxProcess};
use crate::system::proxy_macos;

pub struct ProxyState {
    pub process: SingBoxProcess,
    pub connected_at: Mutex<Option<Instant>>,
    pub running_node_id: Mutex<Option<String>>,
    pub running_group_id: Mutex<Option<String>>,
}

#[derive(Serialize)]
pub struct ProxyStatus {
    pub connected: bool,
    pub active_node_id: Option<String>,
    pub uptime_seconds: u64,
}

#[derive(Serialize)]
pub struct ProxyInfo {
    pub listen_host: String,
    pub listen_port: u16,
    pub http_proxy: String,
    pub socks_proxy: String,
    pub terminal_commands: Vec<String>,
    pub unset_commands: Vec<String>,
}

struct RuntimeLaunch {
    config_path: PathBuf,
    node_id: String,
    node_name: String,
    node_address: String,
    node_port: u16,
    group_id: String,
    group_name: String,
}

#[tauri::command]
pub fn connect(app_state: State<AppState>, proxy_state: State<ProxyState>) -> Result<(), String> {
    let runtime = prepare_runtime_launch(app_state.inner())?;

    proxy_state
        .process
        .start(runtime.config_path.to_str().ok_or("Invalid path")?)?;

    if let Err(error) = wait_for_local_proxy_port(proxy_state.inner()) {
        return Err(cleanup_runtime_failure(proxy_state.inner(), error));
    }

    if let Err(error) = proxy_macos::set_system_proxy(2080) {
        return Err(cleanup_runtime_failure(
            proxy_state.inner(),
            format!("Failed to configure system proxy: {}", error),
        ));
    }

    if let Err(error) = set_runtime_connected(
        proxy_state.inner(),
        runtime.node_id.clone(),
        runtime.group_id.clone(),
    ) {
        return Err(cleanup_runtime_failure(
            proxy_state.inner(),
            format!("Failed to record runtime snapshot: {}", error),
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
    proxy_state
        .process
        .add_log("info", "System proxy configured on port 2080");

    Ok(())
}

#[tauri::command]
pub fn disconnect(proxy_state: State<ProxyState>) -> Result<(), String> {
    let mut errors = Vec::new();

    if let Err(error) = proxy_state.process.stop() {
        errors.push(format!("Failed to stop sing-box: {}", error));
    }
    if let Err(error) = proxy_macos::clear_system_proxy() {
        errors.push(format!("Failed to clear system proxy: {}", error));
    }
    if let Err(error) = set_runtime_disconnected(proxy_state.inner()) {
        errors.push(format!("Failed to clear runtime snapshot: {}", error));
    }

    if errors.is_empty() {
        proxy_state
            .process
            .add_log("info", "Disconnected, system proxy cleared");
        Ok(())
    } else {
        let combined_error = errors.join("; ");
        proxy_state.process.add_log("error", &combined_error);
        Err(combined_error)
    }
}

#[tauri::command]
pub fn get_status(
    _app_state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<ProxyStatus, String> {
    let connected = proxy_state.process.is_running();
    let uptime = proxy_state
        .connected_at
        .lock()
        .map_err(|e| e.to_string())?
        .map(|t| t.elapsed().as_secs())
        .unwrap_or(0);
    let active_node_id = if connected {
        proxy_state
            .running_node_id
            .lock()
            .map_err(|e| e.to_string())?
            .clone()
    } else {
        None
    };

    Ok(ProxyStatus {
        connected,
        active_node_id,
        uptime_seconds: if connected { uptime } else { 0 },
    })
}

#[tauri::command]
pub fn reload_proxy(
    app_state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), String> {
    reload_proxy_if_running(app_state.inner(), proxy_state.inner())
}

pub fn reload_proxy_if_running(
    app_state: &AppState,
    proxy_state: &ProxyState,
) -> Result<(), String> {
    if !proxy_state.process.is_running() {
        return Ok(());
    }

    proxy_state.process.stop().map_err(|error| {
        cleanup_runtime_failure(
            proxy_state,
            format!("Failed to stop sing-box before reload: {}", error),
        )
    })?;

    let runtime = prepare_runtime_launch(app_state).map_err(|error| {
        cleanup_runtime_failure(
            proxy_state,
            format!("Failed to prepare runtime for reload: {}", error),
        )
    })?;

    proxy_state
        .process
        .start(runtime.config_path.to_str().ok_or("Invalid path")?)
        .map_err(|error| {
            cleanup_runtime_failure(
                proxy_state,
                format!("Failed to start sing-box during reload: {}", error),
            )
        })?;

    wait_for_local_proxy_port(proxy_state).map_err(|error| {
        cleanup_runtime_failure(
            proxy_state,
            format!("sing-box failed during reload: {}", error),
        )
    })?;

    set_runtime_connected(
        proxy_state,
        runtime.node_id.clone(),
        runtime.group_id.clone(),
    )
    .map_err(|error| {
        cleanup_runtime_failure(
            proxy_state,
            format!("Failed to record runtime snapshot after reload: {}", error),
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

#[tauri::command]
pub fn get_proxy_info() -> ProxyInfo {
    ProxyInfo {
        listen_host: "127.0.0.1".to_string(),
        listen_port: 2080,
        http_proxy: "http://127.0.0.1:2080".to_string(),
        socks_proxy: "socks5://127.0.0.1:2080".to_string(),
        terminal_commands: vec![
            "export http_proxy=http://127.0.0.1:2080".to_string(),
            "export https_proxy=http://127.0.0.1:2080".to_string(),
            "export all_proxy=socks5://127.0.0.1:2080".to_string(),
        ],
        unset_commands: vec!["unset http_proxy https_proxy all_proxy".to_string()],
    }
}

#[tauri::command]
pub fn get_logs(proxy_state: State<ProxyState>) -> Vec<LogEntry> {
    proxy_state.process.get_logs()
}

#[tauri::command]
pub fn clear_logs(proxy_state: State<ProxyState>) -> Result<(), String> {
    proxy_state.process.clear_logs();
    Ok(())
}

#[tauri::command]
pub fn get_log_file_path() -> String {
    crate::singbox::process::log_file_path()
        .to_string_lossy()
        .to_string()
}

fn prepare_runtime_launch(app_state: &AppState) -> Result<RuntimeLaunch, String> {
    let config = app_state.config.lock().map_err(|e| e.to_string())?;
    let prepared = prepare_runtime(&config)?;

    let runtime = RuntimeLaunch {
        config_path: prepared.config_path.clone(),
        node_id: prepared.node.id.clone(),
        node_name: prepared.node.name.clone(),
        node_address: prepared.node.address.clone(),
        node_port: prepared.node.port,
        group_id: prepared.rule_group.id.clone(),
        group_name: prepared.rule_group.name.clone(),
    };

    drop(config);
    check_generated_config(&runtime.config_path)?;

    Ok(runtime)
}

fn set_runtime_connected(
    proxy_state: &ProxyState,
    node_id: String,
    group_id: String,
) -> Result<(), String> {
    let mut connected_at = proxy_state.connected_at.lock().map_err(|e| e.to_string())?;
    let mut running_node_id = proxy_state
        .running_node_id
        .lock()
        .map_err(|e| e.to_string())?;
    let mut running_group_id = proxy_state
        .running_group_id
        .lock()
        .map_err(|e| e.to_string())?;

    *connected_at = Some(Instant::now());
    *running_node_id = Some(node_id);
    *running_group_id = Some(group_id);

    Ok(())
}

fn set_runtime_disconnected(proxy_state: &ProxyState) -> Result<(), String> {
    let mut connected_at = proxy_state.connected_at.lock().map_err(|e| e.to_string())?;
    let mut running_node_id = proxy_state
        .running_node_id
        .lock()
        .map_err(|e| e.to_string())?;
    let mut running_group_id = proxy_state
        .running_group_id
        .lock()
        .map_err(|e| e.to_string())?;

    *connected_at = None;
    *running_node_id = None;
    *running_group_id = None;

    Ok(())
}

fn cleanup_runtime_failure(proxy_state: &ProxyState, error: String) -> String {
    let mut errors = vec![error];

    if let Err(stop_error) = proxy_state.process.stop() {
        errors.push(format!(
            "Failed to stop sing-box during cleanup: {}",
            stop_error
        ));
    }
    if let Err(proxy_error) = proxy_macos::clear_system_proxy() {
        errors.push(format!(
            "Failed to clear system proxy during cleanup: {}",
            proxy_error
        ));
    }
    if let Err(state_error) = set_runtime_disconnected(proxy_state) {
        errors.push(format!(
            "Failed to clear runtime snapshot during cleanup: {}",
            state_error
        ));
    }

    let combined_error = errors.join("; ");
    proxy_state.process.add_log("error", &combined_error);
    combined_error
}

fn wait_for_local_proxy_port(proxy_state: &ProxyState) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], 2080));
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
                    return Err(
                        "Timed out waiting for sing-box to listen on 127.0.0.1:2080".to_string()
                    );
                }
                std::thread::sleep(poll_interval);
            }
        }
    }
}
