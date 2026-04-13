use std::sync::Mutex;
use tauri::State;

use crate::commands::proxy::{reload_proxy_if_running, ProxyState};
use crate::singbox::uri_parser::Node;
use crate::storage::app_config::AppConfig;

pub struct AppState {
    pub config: Mutex<AppConfig>,
}

#[tauri::command]
pub fn import_node(vless_uri: String, state: State<AppState>) -> Result<Node, String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let node = config.import_node_uri(&vless_uri)?;
    config.save()?;
    Ok(node)
}

#[tauri::command]
pub fn delete_node(id: String, state: State<AppState>) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.delete_node(&id);
    config.save()?;
    Ok(())
}

#[tauri::command]
pub fn list_nodes(state: State<AppState>) -> Result<Vec<Node>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.nodes.clone())
}

#[tauri::command]
pub fn set_active_node(
    id: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), String> {
    {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        config.set_active_node(&id)?;
        config.save()?;
    }

    reload_proxy_if_running(state.inner(), proxy_state.inner())
}
