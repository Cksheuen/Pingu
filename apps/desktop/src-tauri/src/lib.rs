pub mod chain;
pub mod commands;
pub mod gate;
pub mod lifecycle;
pub mod mihomo;
pub mod proxy_runtime;
pub mod storage;
pub mod system;
pub mod traffic_monitor;
pub mod tray;

use commands::config::AppState;
use commands::proxy::ProxyState;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use storage::app_config::AppConfig;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WindowEvent};

// ---------------------------------------------------------------------------
// Central quit coordination
// ---------------------------------------------------------------------------
//
// Normal shutdown can take several seconds (mihomo stop + system-proxy
// clear). It must run off the main thread but exactly once: Quit, window
// close-then-quit, or a second Cmd-Q arriving while shutdown is in flight must
// never spawn duplicate shutdown work or leave a freshly started runtime
// behind.
const EXIT_IDLE: u8 = 0;
const EXIT_SHUTTING: u8 = 1;
const EXIT_COMPLETE: u8 = 2;
static EXIT_STATE: AtomicU8 = AtomicU8::new(EXIT_IDLE);

/// Transition idle -> shutting. Returns true exactly once until shutdown
/// completes; a repeat Quit while pending gets false and starts no work.
fn begin_exit_if_idle() -> bool {
    EXIT_STATE
        .compare_exchange(EXIT_IDLE, EXIT_SHUTTING, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

fn mark_exit_complete() {
    EXIT_STATE.store(EXIT_COMPLETE, Ordering::SeqCst);
}

/// Begin the single coordinated shutdown. Safe to call from the tray Quit
/// item or any other exit path; repeat calls while shutdown is pending are
/// no-ops. Once shutdown completes the app exits normally.
pub fn request_app_exit(app_handle: &AppHandle) {
    // Only the idle -> shutting transition starts work.
    if !begin_exit_if_idle() {
        return;
    }
    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let proxy_state = app_handle.state::<Arc<ProxyState>>().inner().clone();
        // shutdown_core latches shutdown intent (rejecting queued connects)
        // and stops the runtime off the main thread.
        let result = tauri::async_runtime::spawn_blocking(move || {
            commands::proxy::shutdown_core(&proxy_state)
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => eprintln!("Pingu shutdown reported an error: {error}"),
            Err(error) => eprintln!("Pingu shutdown task failed: {error}"),
        }
        mark_exit_complete();
        // Triggers ExitRequested again; with state complete it is allowed.
        app_handle.exit(0);
    });
}

/// Resolve the path to the bundled `mihomo` sidecar binary.
/// In dev mode this falls back to the system PATH version.
pub fn resolve_mihomo_path() -> String {
    if let Some(path) = std::env::var_os("PINGU_MIHOMO_BIN") {
        return path.to_string_lossy().to_string();
    }

    // Tauri places sidecar binaries next to the main executable.
    if let Ok(exe) = std::env::current_exe() {
        let sidecar = exe.parent().unwrap_or(exe.as_ref()).join("mihomo");
        if sidecar.exists() {
            return sidecar.to_string_lossy().to_string();
        }
        // macOS .app bundle: also check in MacOS/ directory
        if let Some(parent) = exe.parent() {
            let macos_sidecar = parent.join("mihomo");
            if macos_sidecar.exists() {
                return macos_sidecar.to_string_lossy().to_string();
            }
        }
    }
    // Fallback: system PATH (dev mode)
    "mihomo".to_string()
}

pub fn missing_mihomo_message() -> String {
    "mihomo binary not found. Install `mihomo` on your PATH, or set `PINGU_MIHOMO_BIN` before building so Tauri can bundle it as a sidecar.".to_string()
}

pub fn run() {
    let app_config = AppConfig::load();
    let connect_on_start = std::env::args_os().skip(1).any(|arg| arg == "--connect");

    let operation_lock = Arc::new(Mutex::new(()));
    let app_state = Arc::new(AppState::new(app_config, Arc::clone(&operation_lock)));
    let proxy_state = Arc::new(ProxyState::production_with_lock(operation_lock));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(Arc::clone(&app_state))
        .manage(Arc::clone(&proxy_state))
        .setup(move |app| {
            tray::setup_tray(app)?;
            // Remote deployments can start the normal, verified lifecycle
            // without a second headless core or a separate system-proxy owner.
            if connect_on_start {
                let handle = app.handle().clone();
                let state = app.state::<Arc<AppState>>().inner().clone();
                let proxy = app.state::<Arc<ProxyState>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        commands::proxy::connect_core(&state, &proxy)
                    })
                    .await;
                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => eprintln!("Pingu startup connection failed: {error}"),
                        Err(error) => eprintln!("Pingu startup task failed: {error}"),
                    }
                    let _ = handle.emit("tray-state-changed", ());
                    let _ = tray::rebuild_tray_menu_on_main(handle);
                });
            }
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
                interval.tick().await;
                loop {
                    interval.tick().await;
                    let proxy_state = app_handle.state::<Arc<ProxyState>>();
                    if proxy_state.is_running() {
                        let app_state = app_handle.state::<Arc<AppState>>().inner().clone();
                        let _ = tauri::async_runtime::spawn_blocking(move || {
                            let _operation = app_state
                                .operation_lock
                                .lock()
                                .map_err(|_| "Operation unavailable".to_string())?;
                            let config = app_state
                                .config
                                .lock()
                                .map_err(|_| "Configuration unavailable".to_string())?
                                .clone();
                            crate::chain::prepare_gate(&config)
                        })
                        .await;
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::chain::get_proxy_chain,
            commands::chain::get_chain_runtime,
            commands::chain::get_chain_probe_progress,
            commands::chain::auto_select_chain,
            commands::chain::save_proxy_chain,
            commands::chain::compare_proxy_chain,
            commands::chain::cancel_chain_comparison,
            commands::config::import_node,
            commands::network::list_subscriptions,
            commands::network::import_subscription,
            commands::network::refresh_subscription,
            commands::network::update_subscription,
            commands::network::delete_subscription,
            commands::network::list_strategy_groups,
            commands::network::select_strategy_proxy,
            commands::network::test_strategy_delay,
            commands::network::list_connections,
            commands::network::close_connection,
            commands::network::close_all_connections,
            commands::config::delete_node,
            commands::config::list_nodes,
            commands::config::set_active_node,
            commands::proxy::connect,
            commands::proxy::disconnect,
            commands::proxy::get_status,
            commands::proxy::reload_proxy,
            commands::proxy::get_proxy_info,
            commands::proxy::get_egress_ip,
            commands::proxy::get_ai_service_preflight,
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
        RunEvent::ExitRequested { api, .. } => {
            if EXIT_STATE.load(Ordering::SeqCst) == EXIT_COMPLETE {
                // Our coordinated shutdown finished; let the process exit.
                return;
            }
            // Prevent the immediate exit and run shutdown off the main
            // thread exactly once.
            api.prevent_exit();
            request_app_exit(app_handle);
        }
        RunEvent::Exit => {
            // Fallback for unusual termination paths that did not pass
            // through ExitRequested coordination.
            if EXIT_STATE.load(Ordering::SeqCst) != EXIT_COMPLETE {
                let proxy_state = app_handle.state::<Arc<ProxyState>>();
                let _ = commands::proxy::shutdown_core(proxy_state.inner());
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod exit_coordination_tests;
