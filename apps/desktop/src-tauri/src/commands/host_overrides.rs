use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::commands::config::AppState;
use crate::commands::proxy::ProxyState;
use crate::lifecycle::{apply_runtime_config_change, LifecycleError};
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
pub fn list_host_overrides(state: State<Arc<AppState>>) -> Result<Vec<HostOverride>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.list_host_overrides())
}

#[tauri::command]
pub async fn create_host_override(
    input: CreateHostOverrideInput,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<HostOverride, LifecycleError> {
    let app_state = state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app_state, &proxy_state, |config| {
            config.create_host_override(
                &input.host,
                input.resolver_mode.as_deref(),
                input.outbound_mode.as_deref(),
                input.enabled,
                input.source.as_deref(),
                input.reason.as_deref(),
            )
        })
    })
    .await
    .map_err(|error| LifecycleError::external("lifecycle_failed", error.to_string(), true))?
}

#[tauri::command]
pub async fn update_host_override(
    input: UpdateHostOverrideInput,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<HostOverride, LifecycleError> {
    let app_state = state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app_state, &proxy_state, |config| {
            config.update_host_override(
                &input.id,
                input.host.as_deref(),
                input.resolver_mode.as_deref(),
                input.outbound_mode.as_deref(),
                input.enabled,
                input.source.as_deref(),
                input.reason.as_deref(),
            )
        })
    })
    .await
    .map_err(|error| LifecycleError::external("lifecycle_failed", error.to_string(), true))?
}

#[tauri::command]
pub async fn delete_host_override(
    id: String,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), LifecycleError> {
    let app_state = state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app_state, &proxy_state, |config| {
            config.delete_host_override(&id)
        })
    })
    .await
    .map_err(|error| LifecycleError::external("lifecycle_failed", error.to_string(), true))?
}

#[tauri::command]
pub async fn toggle_host_override(
    id: String,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<HostOverride, LifecycleError> {
    let app_state = state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app_state, &proxy_state, |config| {
            config.toggle_host_override(&id)
        })
    })
    .await
    .map_err(|error| LifecycleError::external("lifecycle_failed", error.to_string(), true))?
}

#[tauri::command]
pub async fn reset_host_overrides(
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), LifecycleError> {
    let app_state = state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app_state, &proxy_state, |config| {
            config.reset_host_overrides();
            Ok(())
        })
    })
    .await
    .map_err(|error| LifecycleError::external("lifecycle_failed", error.to_string(), true))?
}
