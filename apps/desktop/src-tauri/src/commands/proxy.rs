use std::time::Duration;

use tauri::State;

use crate::commands::config::AppState;
use crate::lifecycle;
pub use crate::lifecycle::ProxyState;
use crate::proxy_runtime::{build_proxy_status, proxy_info, ProxyInfo, ProxyStatus};
use crate::singbox::process::LogEntry;

/// Core connect logic shared by Tauri command and tray menu.
pub fn connect_core(app_state: &AppState, proxy_state: &ProxyState) -> Result<(), String> {
    lifecycle::connect_core(app_state, proxy_state)
}

/// Core disconnect logic shared by Tauri command and tray menu.
pub fn disconnect_core(proxy_state: &ProxyState) -> Result<(), String> {
    lifecycle::disconnect_core(proxy_state)
}

pub fn shutdown_core(proxy_state: &ProxyState) -> Result<(), String> {
    lifecycle::shutdown_core(proxy_state)
}

#[tauri::command]
pub fn connect(
    app_handle: tauri::AppHandle,
    app_state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), String> {
    connect_core(app_state.inner(), proxy_state.inner())?;
    crate::tray::rebuild_tray_menu(&app_handle)?;
    Ok(())
}

#[tauri::command]
pub fn disconnect(
    app_handle: tauri::AppHandle,
    proxy_state: State<ProxyState>,
) -> Result<(), String> {
    disconnect_core(proxy_state.inner())?;
    crate::tray::rebuild_tray_menu(&app_handle)?;
    Ok(())
}

#[tauri::command]
pub fn get_status(
    app_state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<ProxyStatus, String> {
    let connected = proxy_state.process.is_running();
    let runtime = proxy_state.runtime_snapshot()?;
    let uptime = if connected {
        runtime
            .connected_at
            .map(|started_at| started_at.elapsed().as_secs())
            .unwrap_or(0)
    } else {
        0
    };
    let config = app_state.config.lock().map_err(|error| error.to_string())?;

    Ok(build_proxy_status(
        &config,
        connected,
        uptime,
        connected.then_some(runtime.running_node_id).flatten(),
        connected.then_some(runtime.running_group_id).flatten(),
    ))
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
    lifecycle::reload_proxy_if_running(app_state, proxy_state)
}

#[tauri::command]
pub fn get_proxy_info() -> ProxyInfo {
    proxy_info()
}

#[tauri::command]
pub fn get_egress_ip(proxy_state: State<ProxyState>) -> Result<String, String> {
    if !proxy_state.process.is_running() {
        return Err("Proxy is not connected".to_string());
    }

    let proxy = ureq::Proxy::new(&format!("http://127.0.0.1:{}", proxy_state.listen_port))
        .map_err(|error| format!("Failed to configure egress probe: {error}"))?;
    let response = ureq::AgentBuilder::new()
        .proxy(proxy)
        .timeout(Duration::from_secs(8))
        .build()
        .get("https://ping0.cc/")
        .call()
        .map_err(|error| format!("Failed to verify proxy egress: {error}"))?
        .into_string()
        .map_err(|error| format!("Failed to read proxy egress: {error}"))?;
    let ip = response.trim();
    ip.parse::<std::net::IpAddr>()
        .map_err(|_| "Egress probe returned an invalid IP address".to_string())?;
    Ok(ip.to_string())
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
