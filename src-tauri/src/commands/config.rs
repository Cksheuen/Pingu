use std::sync::Mutex;
use tauri::State;

use crate::commands::proxy::{reload_proxy_if_running, ProxyState};
use crate::singbox::uri_parser::{parse_vless_uri, Node};
use crate::storage::app_config::AppConfig;

pub struct AppState {
    pub config: Mutex<AppConfig>,
}

#[tauri::command]
pub fn import_node(vless_uri: String, state: State<AppState>) -> Result<Node, String> {
    let node = parse_vless_uri(&vless_uri)?;
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.nodes.push(node.clone());
    // If this is the first node, set it as active
    if config.active_node_id.is_none() {
        config.active_node_id = Some(node.id.clone());
    }
    config.save()?;
    Ok(node)
}

#[tauri::command]
pub fn delete_node(id: String, state: State<AppState>) -> Result<(), String> {
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.nodes.retain(|n| n.id != id);
    if config.active_node_id.as_deref() == Some(&id) {
        config.active_node_id = config.nodes.first().map(|n| n.id.clone());
    }
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
        if !config.nodes.iter().any(|n| n.id == id) {
            return Err("Node not found".to_string());
        }
        config.active_node_id = Some(id);
        config.save()?;
    }

    reload_proxy_if_running(state.inner(), proxy_state.inner())
}
