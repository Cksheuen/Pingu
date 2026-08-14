use tauri::State;

use crate::commands::config::AppState;
use crate::gate::{GateLease, GateSettings};

#[tauri::command]
pub fn get_autostart(app_state: State<AppState>) -> Result<bool, String> {
    let config = app_state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.autostart)
}

#[tauri::command]
pub fn set_autostart(
    app_handle: tauri::AppHandle,
    app_state: State<AppState>,
    enabled: bool,
) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;

    let manager = app_handle.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }

    let mut config = app_state.config.lock().map_err(|e| e.to_string())?;
    config.autostart = enabled;
    config.save()?;

    Ok(())
}

#[tauri::command]
pub fn get_language(app_state: State<AppState>) -> Result<String, String> {
    let config = app_state.config.lock().map_err(|e| e.to_string())?;
    Ok(config.language.clone())
}

#[tauri::command]
pub fn set_language(
    app_handle: tauri::AppHandle,
    app_state: State<AppState>,
    language: String,
) -> Result<(), String> {
    if language != "en" && language != "zh" {
        return Err(format!("Unsupported language: {}", language));
    }
    let mut config = app_state.config.lock().map_err(|e| e.to_string())?;
    config.language = language;
    config.save()?;
    crate::tray::rebuild_tray_menu(&app_handle)?;
    Ok(())
}

#[tauri::command]
pub fn get_gate_settings() -> Result<GateSettings, String> {
    crate::gate::get_settings()
}

#[tauri::command]
pub fn configure_gate(access_link: String) -> Result<GateSettings, String> {
    crate::gate::configure(&access_link)
}

#[tauri::command]
pub fn set_gate_enabled(enabled: bool) -> Result<GateSettings, String> {
    let settings = crate::gate::set_enabled(enabled)?;
    if enabled {
        crate::gate::renew()?;
        return crate::gate::get_settings();
    }
    Ok(settings)
}

#[tauri::command]
pub fn renew_gate_lease() -> Result<GateLease, String> {
    crate::gate::renew()
}
