use tauri::State;

use crate::commands::config::AppState;

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
pub fn set_language(app_state: State<AppState>, language: String) -> Result<(), String> {
    let mut config = app_state.config.lock().map_err(|e| e.to_string())?;
    config.language = language;
    config.save()?;
    Ok(())
}
