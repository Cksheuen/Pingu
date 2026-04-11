use tauri::State;

use crate::commands::config::AppState;
use crate::commands::proxy::{reload_proxy_if_running, ProxyState};
use crate::singbox::config_gen::{Rule, RuleGroup};

// Helper: get mutable reference to active group
fn get_active_group_mut(
    config: &mut crate::storage::app_config::AppConfig,
) -> Result<&mut RuleGroup, String> {
    let active_id = config.active_group_id.clone();
    config
        .rule_groups
        .iter_mut()
        .find(|g| g.id == active_id)
        .ok_or("Active group not found".to_string())
}

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
    id: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), String> {
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        if !config.rule_groups.iter().any(|g| g.id == id) {
            return Err("Group not found".to_string());
        }
        config.active_group_id = id;
        config.save()?;
    }

    reload_proxy_if_running(state.inner(), proxy_state.inner())
}

#[tauri::command]
pub fn create_rule_group(name: String, state: State<AppState>) -> Result<RuleGroup, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let group = RuleGroup {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        rules: vec![],
        default_strategy: "proxy".into(),
        fake_ip_filter: vec![],
        nameserver_policy: vec![],
    };
    config.rule_groups.push(group.clone());
    config.save()?;
    Ok(group)
}

#[tauri::command]
pub fn delete_rule_group(id: String, state: State<AppState>) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    if config.rule_groups.len() <= 1 {
        return Err("Cannot delete the last group".to_string());
    }
    config.rule_groups.retain(|g| g.id != id);
    if config.active_group_id == id {
        config.active_group_id = config.rule_groups[0].id.clone();
    }
    config.save()?;
    Ok(())
}

#[tauri::command]
pub fn rename_rule_group(id: String, name: String, state: State<AppState>) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let group = config
        .rule_groups
        .iter_mut()
        .find(|g| g.id == id)
        .ok_or("Group not found")?;
    group.name = name;
    config.save()?;
    Ok(())
}

// --- Rule CRUD (operates on active group) ---

#[tauri::command]
pub fn list_rules(state: State<AppState>) -> Result<Vec<Rule>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    let group = config
        .rule_groups
        .iter()
        .find(|g| g.id == config.active_group_id)
        .ok_or("Active group not found")?;
    Ok(group.rules.clone())
}

#[tauri::command]
pub fn add_rule(
    rule: Rule,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), String> {
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        let rule = if rule.id.is_empty() {
            Rule {
                id: uuid::Uuid::new_v4().to_string(),
                ..rule
            }
        } else {
            rule
        };
        let group = get_active_group_mut(&mut config)?;
        group.rules.push(rule);
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
        let group = get_active_group_mut(&mut config)?;
        group.rules.retain(|r| r.id != id);
        config.save()?;
    }

    reload_proxy_if_running(state.inner(), proxy_state.inner())
}

#[tauri::command]
pub fn set_default_strategy(
    strategy: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), String> {
    if strategy != "proxy" && strategy != "direct" {
        return Err("Strategy must be 'proxy' or 'direct'".to_string());
    }

    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        let group = get_active_group_mut(&mut config)?;
        group.default_strategy = strategy;
        config.save()?;
    }

    reload_proxy_if_running(state.inner(), proxy_state.inner())
}
