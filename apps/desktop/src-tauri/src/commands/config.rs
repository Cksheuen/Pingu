use std::sync::Mutex;
use tauri::State;

use crate::commands::proxy::ProxyState;
use crate::lifecycle::{apply_runtime_config_change, LifecycleError};
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
pub fn delete_node(
    id: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), LifecycleError> {
    apply_runtime_config_change(state.inner(), proxy_state.inner(), |config| {
        if !config.nodes.iter().any(|node| node.id == id) {
            return Err("Node not found".to_string());
        }
        config.delete_node(&id);
        Ok(())
    })
}

#[tauri::command]
pub fn list_nodes(state: State<AppState>) -> Result<Vec<Node>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.nodes.clone())
}

#[tauri::command]
pub fn set_active_node(
    app_handle: tauri::AppHandle,
    id: String,
    state: State<AppState>,
    proxy_state: State<ProxyState>,
) -> Result<(), LifecycleError> {
    apply_runtime_config_change(state.inner(), proxy_state.inner(), |config| {
        config.set_active_node(&id)
    })?;
    crate::tray::rebuild_tray_menu(&app_handle)
        .map_err(|error| LifecycleError::external("lifecycle_failed", error, true))?;
    Ok(())
}
