pub mod commands;
pub mod proxy_runtime;
pub mod singbox;
pub mod storage;
pub mod system;

#[cfg(test)]
mod functional_chain_generated_tests;

use commands::config::AppState;
use commands::proxy::ProxyState;
use singbox::process::SingBoxProcess;
use std::sync::Mutex;
use storage::app_config::AppConfig;

/// Resolve the path to the bundled `sing-box` sidecar binary.
/// In dev mode this falls back to the system PATH version.
pub fn resolve_sing_box_path() -> String {
    // Tauri places sidecar binaries next to the main executable.
    if let Ok(exe) = std::env::current_exe() {
        let sidecar = exe.parent().unwrap_or(exe.as_ref()).join("sing-box");
        if sidecar.exists() {
            return sidecar.to_string_lossy().to_string();
        }
        // macOS .app bundle: also check in MacOS/ directory
        if let Some(parent) = exe.parent() {
            let macos_sidecar = parent.join("sing-box");
            if macos_sidecar.exists() {
                return macos_sidecar.to_string_lossy().to_string();
            }
        }
    }
    // Fallback: system PATH (dev mode)
    "sing-box".to_string()
}

pub fn missing_sing_box_message() -> String {
    "sing-box binary not found. Install `sing-box` on your PATH, or set `PINGU_SING_BOX_BIN` before building so Tauri can bundle it as a sidecar.".to_string()
}

pub fn run() {
    let _ = system::proxy_macos::clear_system_proxy();
    let app_config = AppConfig::load();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState {
            config: Mutex::new(app_config),
        })
        .manage(ProxyState {
            process: SingBoxProcess::new(),
            connected_at: Mutex::new(None),
            running_node_id: Mutex::new(None),
            running_group_id: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::import_node,
            commands::config::delete_node,
            commands::config::list_nodes,
            commands::config::set_active_node,
            commands::proxy::connect,
            commands::proxy::disconnect,
            commands::proxy::get_status,
            commands::proxy::reload_proxy,
            commands::proxy::get_proxy_info,
            commands::proxy::get_logs,
            commands::proxy::clear_logs,
            commands::proxy::get_log_file_path,
            commands::host_overrides::list_host_overrides,
            commands::host_overrides::create_host_override,
            commands::host_overrides::update_host_override,
            commands::host_overrides::delete_host_override,
            commands::host_overrides::toggle_host_override,
            commands::host_overrides::reset_host_overrides,
            commands::rules::list_rule_groups,
            commands::rules::get_active_group_id,
            commands::rules::set_active_group,
            commands::rules::create_rule_group,
            commands::rules::delete_rule_group,
            commands::rules::rename_rule_group,
            commands::rules::list_rules,
            commands::rules::add_rule,
            commands::rules::delete_rule,
            commands::rules::set_default_strategy,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            let _ = system::proxy_macos::clear_system_proxy();
        }
        _ => {}
    });
}
