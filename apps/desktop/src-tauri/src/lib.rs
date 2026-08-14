pub mod commands;
pub mod gate;
pub mod lifecycle;
pub mod proxy_runtime;
pub mod singbox;
pub mod storage;
pub mod system;
pub mod tray;

#[cfg(test)]
mod functional_chain_generated_tests;

use commands::config::AppState;
use commands::proxy::ProxyState;
use std::sync::Mutex;
use storage::app_config::AppConfig;
#[cfg(debug_assertions)]
use tauri::Emitter;
use tauri::{Manager, RunEvent, WindowEvent};

/// Resolve the path to the bundled `sing-box` sidecar binary.
/// In dev mode this falls back to the system PATH version.
pub fn resolve_sing_box_path() -> String {
    if let Some(path) = std::env::var_os("PINGU_SING_BOX_BIN") {
        return path.to_string_lossy().to_string();
    }

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
    let system_proxy = system::production_system_proxy();
    let _ = system_proxy.clear();
    let app_config = AppConfig::load();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(AppState {
            config: Mutex::new(app_config),
        })
        .manage(ProxyState::production())
        .setup(|app| {
            tray::setup_tray(app)?;
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    let proxy_state = app_handle.state::<ProxyState>();
                    if proxy_state.process.is_running() {
                        let _ = crate::gate::renew_if_enabled();
                    }
                }
            });

            #[cfg(debug_assertions)]
            if std::env::var_os("PINGU_SMOKE_AUTOCONNECT").is_some() {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let app_state = app_handle.state::<AppState>();
                    let proxy_state = app_handle.state::<ProxyState>();
                    match commands::proxy::connect_core(app_state.inner(), proxy_state.inner()) {
                        Ok(()) => {
                            let _ = tray::rebuild_tray_menu(&app_handle);
                            let _ = app_handle.emit("tray-state-changed", "connect");
                        }
                        Err(error) => eprintln!("Pingu smoke autoconnect failed: {error}"),
                    }
                });
            }
            Ok(())
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
            commands::proxy::get_egress_ip,
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
            commands::settings::get_autostart,
            commands::settings::set_autostart,
            commands::settings::get_language,
            commands::settings::set_language,
            commands::settings::get_gate_settings,
            commands::settings::configure_gate,
            commands::settings::set_gate_enabled,
            commands::settings::renew_gate_lease,
            commands::traffic::get_traffic,
            commands::traffic::get_clash_api_port,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } => {
            if label == "main" {
                api.prevent_close();
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.hide();
                }
                #[cfg(target_os = "macos")]
                {
                    let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                }
            }
        }
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            let proxy_state = app_handle.state::<ProxyState>();
            let _ = commands::proxy::shutdown_core(proxy_state.inner());
        }
        _ => {}
    });
}
