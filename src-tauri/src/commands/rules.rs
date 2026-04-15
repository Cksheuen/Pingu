use tauri::State;

use crate::commands::config::AppState;
use crate::commands::proxy::{reload_proxy_if_running, ProxyState};
use crate::singbox::config_gen::{Rule, RuleGroup};

// --- Group CRUD ---

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
) -> Result<(), String> {
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.set_active_group(&id)?;
        config.save()?;
    }

    reload_proxy_if_running(state.inner(), proxy_state.inner())?;
    crate::tray::rebuild_tray_menu(&app_handle)?;
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
pub fn delete_rule_group(id: String, state: State<AppState>) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.delete_rule_group(&id)?;
    config.save()?;
    Ok(())
}

#[tauri::command]
pub fn rename_rule_group(id: String, name: String, state: State<AppState>) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.rename_rule_group(&id, name)?;
    config.save()?;
    Ok(())
}

// --- Rule CRUD (operates on active group) ---

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
) -> Result<(), String> {
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.add_rule_to_active_group(rule)?;
        config.save()?;
    }

    reload_proxy_if_running(state.inner(), proxy_state.inner())
}

#[tauri::command]
pub fn delete_rule(
    id: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), String> {
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.delete_rule_from_active_group(&id)?;
        config.save()?;
    }

    reload_proxy_if_running(state.inner(), proxy_state.inner())
}

#[tauri::command]
pub fn set_default_strategy(
    app_handle: tauri::AppHandle,
    strategy: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), String> {
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.set_active_group_default_strategy(&strategy)?;
        config.save()?;
    }

    reload_proxy_if_running(state.inner(), proxy_state.inner())?;
    crate::tray::rebuild_tray_menu(&app_handle)?;
    Ok(())
}
