use tauri::State;

use crate::commands::config::AppState;
use crate::commands::proxy::ProxyState;
use crate::lifecycle::{apply_runtime_config_change, LifecycleError};
use crate::singbox::config_gen::{Rule, RuleGroup};

#[tauri::command]
pub fn list_rule_groups(state: State<AppState>) -> Result<Vec<RuleGroup>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.rule_groups.clone())
}

#[tauri::command]
pub fn get_active_group_id(state: State<AppState>) -> Result<String, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.active_group_id.clone())
}

#[tauri::command]
pub fn set_active_group(
    app_handle: tauri::AppHandle,
    id: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), LifecycleError> {
    apply_runtime_config_change(state.inner(), proxy_state.inner(), |config| {
        config.set_active_group(&id)
    })?;
    crate::tray::rebuild_tray_menu(&app_handle)
        .map_err(|error| LifecycleError::external("lifecycle_failed", error, true))?;
    Ok(())
}

#[tauri::command]
pub fn create_rule_group(name: String, state: State<AppState>) -> Result<RuleGroup, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let group = config.create_rule_group(name);
    config.save()?;
    Ok(group)
}

#[tauri::command]
pub fn delete_rule_group(
    id: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), LifecycleError> {
    apply_runtime_config_change(state.inner(), proxy_state.inner(), |config| {
        config.delete_rule_group(&id)
    })
}

#[tauri::command]
pub fn rename_rule_group(id: String, name: String, state: State<AppState>) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.rename_rule_group(&id, name)?;
    config.save()?;
    Ok(())
}

#[tauri::command]
pub fn list_rules(state: State<AppState>) -> Result<Vec<Rule>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    config.list_rules()
}

#[tauri::command]
pub fn add_rule(
    rule: Rule,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), LifecycleError> {
    apply_runtime_config_change(state.inner(), proxy_state.inner(), |config| {
        config.add_rule_to_active_group(rule).map(|_| ())
    })
}

#[tauri::command]
pub fn delete_rule(
    id: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), LifecycleError> {
    apply_runtime_config_change(state.inner(), proxy_state.inner(), |config| {
        config.delete_rule_from_active_group(&id)
    })
}

#[tauri::command]
pub fn set_default_strategy(
    app_handle: tauri::AppHandle,
    strategy: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), LifecycleError> {
    apply_runtime_config_change(state.inner(), proxy_state.inner(), |config| {
        config.set_active_group_default_strategy(&strategy)
    })?;
    crate::tray::rebuild_tray_menu(&app_handle)
        .map_err(|error| LifecycleError::external("lifecycle_failed", error, true))?;
    Ok(())
}
