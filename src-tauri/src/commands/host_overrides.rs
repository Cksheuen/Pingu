use serde::Deserialize;
use tauri::State;

use crate::commands::config::AppState;
use crate::commands::proxy::{reload_proxy_if_running, ProxyState};
use crate::storage::app_config::HostOverride;

#[derive(Debug, Deserialize)]
pub struct CreateHostOverrideInput {
    pub host: String,
    pub resolver_mode: Option<String>,
    pub outbound_mode: Option<String>,
    pub enabled: Option<bool>,
    pub source: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateHostOverrideInput {
    pub id: String,
    pub host: Option<String>,
    pub resolver_mode: Option<String>,
    pub outbound_mode: Option<String>,
    pub enabled: Option<bool>,
    pub source: Option<String>,
    pub reason: Option<String>,
}

#[tauri::command]
pub fn list_host_overrides(state: State<AppState>) -> Result<Vec<HostOverride>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.list_host_overrides())
}

#[tauri::command]
pub fn create_host_override(
    input: CreateHostOverrideInput,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<HostOverride, String> {
    let created = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        let created = config.create_host_override(
            &input.host,
            input.resolver_mode.as_deref(),
            input.outbound_mode.as_deref(),
            input.enabled,
            input.source.as_deref(),
            input.reason.as_deref(),
        )?;
        config.save()?;
        created
    };

    reload_proxy_if_running(state.inner(), proxy_state.inner())?;
    Ok(created)
}

#[tauri::command]
pub fn update_host_override(
    input: UpdateHostOverrideInput,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<HostOverride, String> {
    let updated = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        let updated = config.update_host_override(
            &input.id,
            input.host.as_deref(),
            input.resolver_mode.as_deref(),
            input.outbound_mode.as_deref(),
            input.enabled,
            input.source.as_deref(),
            input.reason.as_deref(),
        )?;
        config.save()?;
        updated
    };

    reload_proxy_if_running(state.inner(), proxy_state.inner())?;
    Ok(updated)
}

#[tauri::command]
pub fn delete_host_override(
    id: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), String> {
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.delete_host_override(&id)?;
        config.save()?;
    }

    reload_proxy_if_running(state.inner(), proxy_state.inner())
}

#[tauri::command]
pub fn toggle_host_override(
    id: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<HostOverride, String> {
    let updated = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        let updated = config.toggle_host_override(&id)?;
        config.save()?;
        updated
    };

    reload_proxy_if_running(state.inner(), proxy_state.inner())?;
    Ok(updated)
}

#[tauri::command]
pub fn reset_host_overrides(
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), String> {
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.reset_host_overrides();
        config.save()?;
    }

    reload_proxy_if_running(state.inner(), proxy_state.inner())
}
