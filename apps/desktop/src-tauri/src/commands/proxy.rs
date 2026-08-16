use tauri::State;

use crate::commands::config::AppState;
use crate::lifecycle;
pub use crate::lifecycle::ProxyState;
use crate::proxy_runtime::{
    build_ai_service_preflight, build_proxy_status, probe_proxy_egress, proxy_info,
    verify_proxy_content, AiServicePreflight, ProxyInfo, ProxyStatus,
};
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
    let connected = proxy_state.is_running();
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
pub fn get_proxy_info(proxy_state: State<ProxyState>) -> ProxyInfo {
    proxy_info(proxy_state.active_listen_port())
}

#[tauri::command]
pub fn get_egress_ip(proxy_state: State<ProxyState>) -> Result<String, String> {
    if !proxy_state.is_running() {
        return Err("Proxy is not connected".to_string());
    }

    probe_proxy_egress(proxy_state.active_listen_port())
}

#[tauri::command]
pub fn get_ai_service_preflight(
    app_state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<AiServicePreflight, String> {
    if !proxy_state.is_running() {
        return Err("Proxy is not connected".to_string());
    }

    let network_checks = verify_proxy_content(proxy_state.active_listen_port())?;
    let egress_ip = network_checks
        .iter()
        .find(|check| check.id == "egress_ip")
        .and_then(|check| check.observed_ip.clone())
        .ok_or("Network verification did not return an egress IP")?;
    let config = app_state.config.lock().map_err(|error| error.to_string())?;
    build_ai_service_preflight(&config, egress_ip, network_checks)
}

#[tauri::command]
pub fn get_logs(proxy_state: State<ProxyState>) -> Vec<LogEntry> {
    proxy_state.get_logs()
}

#[tauri::command]
pub fn clear_logs(proxy_state: State<ProxyState>) -> Result<(), String> {
    proxy_state.clear_logs();
    Ok(())
}

#[tauri::command]
pub fn get_log_file_path() -> String {
    crate::singbox::process::log_file_path()
        .to_string_lossy()
        .to_string()
}
