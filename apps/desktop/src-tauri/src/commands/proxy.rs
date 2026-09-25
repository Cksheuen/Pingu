use std::sync::Arc;

use tauri::State;

use crate::commands::config::AppState;
use crate::lifecycle;
pub use crate::lifecycle::ProxyState;
use crate::mihomo::process::LogEntry;
use crate::proxy_runtime::{
    build_ai_service_preflight, build_proxy_status, probe_proxy_egress, proxy_info,
    verify_proxy_content, AiServicePreflight, ProxyInfo, ProxyStatus,
};

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

/// Run lifecycle work (process spawn, network verification, system-proxy
/// changes) off the main thread, then rebuild the tray menu on the UI thread.
/// The operation lock inside [`lifecycle`] keeps these mutually exclusive.
#[tauri::command]
pub async fn connect(
    app_handle: tauri::AppHandle,
    app_state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), String> {
    let app_state = app_state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || connect_core(&app_state, &proxy_state))
        .await
        .map_err(|error| format!("Connect task failed: {error}"))??;
    crate::tray::rebuild_tray_menu_on_main(app_handle)
}

#[tauri::command]
pub async fn disconnect(
    app_handle: tauri::AppHandle,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), String> {
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || disconnect_core(&proxy_state))
        .await
        .map_err(|error| format!("Disconnect task failed: {error}"))??;
    crate::tray::rebuild_tray_menu_on_main(app_handle)
}

#[tauri::command]
pub fn get_status(
    app_state: State<Arc<AppState>>,
    proxy_state: State<Arc<ProxyState>>,
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
    // Only a short lock: config generation never holds this mutex anymore.
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
pub async fn reload_proxy(
    app_state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), String> {
    let app_state = app_state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || reload_proxy_if_running(&app_state, &proxy_state))
        .await
        .map_err(|error| format!("Reload task failed: {error}"))?
}

pub fn reload_proxy_if_running(
    app_state: &AppState,
    proxy_state: &ProxyState,
) -> Result<(), String> {
    lifecycle::reload_proxy_if_running(app_state, proxy_state)
}

#[tauri::command]
pub fn get_proxy_info(proxy_state: State<Arc<ProxyState>>) -> ProxyInfo {
    proxy_info(proxy_state.active_listen_port())
}

#[tauri::command]
pub async fn get_egress_ip(proxy_state: State<'_, Arc<ProxyState>>) -> Result<String, String> {
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Pin the exact runtime (generation/listener) under the operation
        // lock; probe that listener without the lock; re-check the runtime is
        // still live and unchanged before returning, so an egress IP can never
        // be attributed to a runtime that was switched away mid-probe.
        let context = {
            let operation = proxy_state
                .operation_lock
                .lock()
                .map_err(|error| format!("Lifecycle lock failed: {error}"))?;
            proxy_state
                .preflight_context(&operation)
                .ok_or_else(|| "Proxy is not connected".to_string())?
        };
        let egress_ip = probe_proxy_egress(context.listen_port)?;
        let operation = proxy_state
            .operation_lock
            .lock()
            .map_err(|error| format!("Lifecycle lock failed: {error}"))?;
        if !proxy_state.preflight_context_still_current(&operation, &context) {
            return Err("Active proxy changed during verification".to_string());
        }
        Ok(egress_ip)
    })
    .await
    .map_err(|error| format!("Egress probe task failed: {error}"))?
}

#[tauri::command]
pub async fn get_ai_service_preflight(
    app_state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<AiServicePreflight, String> {
    let app_state = app_state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Phase 1: pin the exact runtime identity under the shared operation
        // lock and consume the one-shot connect handoff when present.
        let context = {
            let operation = proxy_state
                .operation_lock
                .lock()
                .map_err(|error| format!("Lifecycle lock failed: {error}"))?;
            proxy_state
                .preflight_context(&operation)
                .ok_or_else(|| "Proxy is not connected".to_string())?
        };
        let handoff = proxy_state.take_preflight_handoff(
            context.generation,
            context.listen_port,
            &context.node_id,
            &context.group_id,
        );

        // Phase 2: obtain the content checks. The handoff reuses the
        // just-completed connect verification; otherwise probes run without
        // holding any lock (up to several seconds).
        let network_checks = match handoff {
            Some(checks) => checks,
            None => verify_proxy_content(context.listen_port)?,
        };

        // Phase 3 (common to both paths): rebuild the report under the
        // operation lock. Re-verify the runtime is still the exact one and its
        // core is actually alive, then read config and build before releasing,
        // so old checks can never be combined with a swapped rule set or a
        // stopped listener. No network I/O happens while the lock is held.
        let operation = proxy_state
            .operation_lock
            .lock()
            .map_err(|error| format!("Lifecycle lock failed: {error}"))?;
        if !proxy_state.preflight_context_still_current(&operation, &context) {
            return Err("Active proxy changed during verification".to_string());
        }
        let egress_ip = network_checks
            .iter()
            .find(|check| check.id == "egress_ip")
            .and_then(|check| check.observed_ip.clone())
            .ok_or("Network verification did not return an egress IP")?;
        let config = app_state.config.lock().map_err(|error| error.to_string())?;
        build_ai_service_preflight(&config, egress_ip, network_checks)
    })
    .await
    .map_err(|error| format!("Preflight task failed: {error}"))?
}

#[tauri::command]
pub fn get_logs(proxy_state: State<Arc<ProxyState>>) -> Vec<LogEntry> {
    proxy_state.get_logs()
}

#[tauri::command]
pub fn clear_logs(proxy_state: State<Arc<ProxyState>>) -> Result<(), String> {
    proxy_state.clear_logs();
    Ok(())
}

#[tauri::command]
pub fn get_log_file_path() -> String {
    crate::mihomo::process::log_file_path()
        .to_string_lossy()
        .to_string()
}
