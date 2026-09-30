use std::sync::{Arc, Mutex};

use tauri::State;

use crate::commands::proxy::ProxyState;
use crate::lifecycle::{apply_runtime_config_change, mutate_config_only, LifecycleError};
use crate::mihomo::subscription::{fetch_subscription_node, resolve_import_node};
use crate::mihomo::uri_parser::Node;
use crate::storage::app_config::AppConfig;

pub struct AppState {
    pub config: Mutex<AppConfig>,
    /// Shared with [`ProxyState`]: every `AppConfig` writer and every runtime
    /// lifecycle change takes this lock, so a short settings write can never
    /// be overwritten by (or interleave with) a hot-swap candidate/rollback
    /// window.
    pub operation_lock: Arc<Mutex<()>>,
}

impl AppState {
    pub fn new(config: AppConfig, operation_lock: Arc<Mutex<()>>) -> Self {
        Self {
            config: Mutex::new(config),
            operation_lock,
        }
    }
}

#[tauri::command]
pub async fn import_node(
    vless_uri: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Node, String> {
    let input = vless_uri.trim().to_string();
    // Fetch (blocking HTTPS) and parse happen outside every lock so the app
    // stays responsive while the subscription server is contacted.
    let parsed = if input.starts_with("https://") {
        tauri::async_runtime::spawn_blocking(move || fetch_subscription_node(&input))
            .await
            .map_err(|_| "Subscription import task failed to start.".to_string())??
    } else {
        resolve_import_node(&input)?
    };

    // Persist under the shared operation lock so the write cannot race a
    // running hot swap.
    let app_state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        mutate_config_only(&app_state, |config| Ok(config.add_node(parsed)))
    })
    .await
    .map_err(|error| format!("Import task failed: {error}"))?
    .map_err(|error| error.message)
}

#[tauri::command]
pub async fn delete_node(
    id: String,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), LifecycleError> {
    let app_state = state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app_state, &proxy_state, |config| {
            if !config.nodes.iter().any(|node| node.id == id) {
                return Err("Node not found".to_string());
            }
            config.delete_node(&id);
            Ok(())
        })
    })
    .await
    .map_err(|error| LifecycleError::external("lifecycle_failed", error.to_string(), true))?
}

#[tauri::command]
pub fn list_nodes(state: State<Arc<AppState>>) -> Result<Vec<Node>, String> {
    let config = state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.nodes.clone())
}

#[tauri::command]
pub async fn set_active_node(
    app_handle: tauri::AppHandle,
    id: String,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), LifecycleError> {
    let app_state = state.inner().clone();
    let proxy_state = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app_state, &proxy_state, |config| {
            config.set_active_node(&id)
        })
    })
    .await
    .map_err(|error| LifecycleError::external("lifecycle_failed", error.to_string(), true))??;
    crate::tray::rebuild_tray_menu_on_main(app_handle)
        .map_err(|error| LifecycleError::external("lifecycle_failed", error, true))
}
