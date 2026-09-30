use std::sync::Arc;

use tauri::State;

use crate::commands::config::AppState;
use crate::gate::{GateLease, GateSettings};
use crate::lifecycle::mutate_config_only;

#[tauri::command]
pub fn get_autostart(app_state: State<Arc<AppState>>) -> Result<bool, String> {
    let config = app_state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.autostart)
}

#[tauri::command]
pub async fn set_autostart(
    _app_handle: tauri::AppHandle,
    app_state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;

    let app_state = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // OS change and persistence run inside one shared operation-lock
        // critical section, so concurrent toggles cannot reorder the OS
        // enable/disable relative to the saved setting.
        crate::lifecycle::apply_config_with_side_effect(
            &app_state,
            move |_| {
                let manager = _app_handle.autolaunch();
                if enabled {
                    manager.enable().map_err(|e| e.to_string())?;
                } else {
                    manager.disable().map_err(|e| e.to_string())?;
                }
                Ok(())
            },
            |config| {
                config.autostart = enabled;
                Ok(())
            },
        )
        .map(|_| ())
        .map_err(|error| error.message)
    })
    .await
    .map_err(|error| format!("Autostart task failed: {error}"))?
}

#[tauri::command]
pub fn get_language(app_state: State<Arc<AppState>>) -> Result<String, String> {
    let config = app_state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.language.clone())
}

#[tauri::command]
pub async fn set_language(
    app_handle: tauri::AppHandle,
    app_state: State<'_, Arc<AppState>>,
    language: String,
) -> Result<(), String> {
    if language != "en" && language != "zh" {
        return Err(format!("Unsupported language: {}", language));
    }
    let app_state = app_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        mutate_config_only(&app_state, |config| {
            config.language = language.clone();
            Ok(())
        })
    })
    .await
    .map_err(|error| format!("Language task failed: {error}"))?
    .map_err(|error| error.message)?;

    // No lock is held while the tray menu is rebuilt, and the menu rebuild
    // (AppKit on macOS) is dispatched to the main thread.
    crate::tray::rebuild_tray_menu_on_main(app_handle)
}

#[tauri::command]
pub async fn get_gate_settings() -> Result<GateSettings, String> {
    tauri::async_runtime::spawn_blocking(crate::gate::get_settings)
        .await
        .map_err(|error| format!("Gate settings task failed: {error}"))?
}

#[tauri::command]
pub async fn configure_gate(access_link: String) -> Result<GateSettings, String> {
    tauri::async_runtime::spawn_blocking(move || crate::gate::configure(&access_link))
        .await
        .map_err(|error| format!("Gate task failed: {error}"))?
}

#[tauri::command]
pub async fn set_gate_enabled(enabled: bool) -> Result<GateSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = crate::gate::set_enabled(enabled)?;
        if enabled {
            crate::gate::renew()?;
            return crate::gate::get_settings();
        }
        Ok(settings)
    })
    .await
    .map_err(|error| format!("Gate task failed: {error}"))?
}

#[tauri::command]
pub async fn renew_gate_lease() -> Result<GateLease, String> {
    tauri::async_runtime::spawn_blocking(crate::gate::renew)
        .await
        .map_err(|error| format!("Gate task failed: {error}"))?
}
