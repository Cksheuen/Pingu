use std::sync::Arc;

use tauri::State;

use crate::commands::config::AppState;
use crate::commands::proxy::ProxyState;
use crate::lifecycle::{apply_runtime_config_change, mutate_config_only, LifecycleError};
use crate::mihomo::config_gen::{Rule, RuleGroup};

#[tauri::command]
pub fn list_rule_groups(state: State<Arc<AppState>>) -> Result<Vec<RuleGroup>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.rule_groups.clone())
}

#[tauri::command]
pub fn get_active_group_id(state: State<Arc<AppState>>) -> Result<String, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.active_group_id.clone())
}

#[tauri::command]
pub async fn set_active_group(
    app_handle: tauri::AppHandle,
    id: String,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), LifecycleError> {
    let app_state = state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app_state, &proxy_state, |config| {
            config.set_active_group(&id)
        })
    })
    .await
    .map_err(|error| LifecycleError::external("lifecycle_failed", error.to_string(), true))??;
    crate::tray::rebuild_tray_menu_on_main(app_handle)
        .map_err(|error| LifecycleError::external("lifecycle_failed", error, true))
}

#[tauri::command]
pub async fn create_rule_group(
    name: String,
    state: State<'_, Arc<AppState>>,
) -> Result<RuleGroup, String> {
    let app_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        mutate_config_only(&app_state, |config| Ok(config.create_rule_group(name)))
    })
    .await
    .map_err(|error| format!("Rule group task failed: {error}"))?
    .map_err(|error| error.message)
}

#[tauri::command]
pub async fn delete_rule_group(
    id: String,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), LifecycleError> {
    let app_state = state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app_state, &proxy_state, |config| {
            config.delete_rule_group(&id)
        })
    })
    .await
    .map_err(|error| LifecycleError::external("lifecycle_failed", error.to_string(), true))?
}

#[tauri::command]
pub async fn rename_rule_group(
    id: String,
    name: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let app_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        mutate_config_only(&app_state, |config| config.rename_rule_group(&id, name))
    })
    .await
    .map_err(|error| format!("Rule group task failed: {error}"))?
    .map_err(|error| error.message)
}

#[tauri::command]
pub fn list_rules(state: State<Arc<AppState>>) -> Result<Vec<Rule>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    config.list_rules()
}

#[tauri::command]
pub async fn add_rule(
    rule: Rule,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), LifecycleError> {
    let app_state = state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app_state, &proxy_state, |config| {
            config.add_rule_to_active_group(rule).map(|_| ())
        })
    })
    .await
    .map_err(|error| LifecycleError::external("lifecycle_failed", error.to_string(), true))?
}

#[tauri::command]
pub async fn delete_rule(
    id: String,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), LifecycleError> {
    let app_state = state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app_state, &proxy_state, |config| {
            config.delete_rule_from_active_group(&id)
        })
    })
    .await
    .map_err(|error| LifecycleError::external("lifecycle_failed", error.to_string(), true))?
}

#[tauri::command]
pub async fn set_default_strategy(
    app_handle: tauri::AppHandle,
    strategy: String,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), LifecycleError> {
    let app_state = state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app_state, &proxy_state, |config| {
            config.set_active_group_default_strategy(&strategy)
        })
    })
    .await
    .map_err(|error| LifecycleError::external("lifecycle_failed", error.to_string(), true))??;
    crate::tray::rebuild_tray_menu_on_main(app_handle)
        .map_err(|error| LifecycleError::external("lifecycle_failed", error, true))
}
