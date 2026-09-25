use std::sync::Arc;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIconBuilder, TrayIconId};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::config::AppState;
use crate::commands::proxy::ProxyState;

const TRAY_ID: &str = "main-tray";

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------

fn tray_text(lang: &str, key: &str) -> String {
    let result = match (lang, key) {
        ("en", "connected") => "Connected",
        ("zh", "connected") => "已连接",
        ("en", "disconnected") => "Disconnected",
        ("zh", "disconnected") => "未连接",
        ("en", "connect") => "Connect",
        ("zh", "connect") => "连接",
        ("en", "disconnect") => "Disconnect",
        ("zh", "disconnect") => "断开",
        ("en", "nodes") => "Nodes",
        ("zh", "nodes") => "节点",
        ("en", "rules") => "Rule Groups",
        ("zh", "rules") => "规则组",
        ("en", "show") => "Show Window",
        ("zh", "show") => "显示窗口",
        ("en", "quit") => "Quit",
        ("zh", "quit") => "退出",
        _ => key,
    };
    result.to_string()
}

fn format_speed(bytes_per_sec: u64) -> String {
    if bytes_per_sec < 1024 {
        format!("{} B/s", bytes_per_sec)
    } else if bytes_per_sec < 1024 * 1024 {
        format!("{:.1} KB/s", bytes_per_sec as f64 / 1024.0)
    } else {
        format!("{:.2} MB/s", bytes_per_sec as f64 / (1024.0 * 1024.0))
    }
}

/// Traffic text straight from the lifecycle-owned background sample cache.
/// Tray menu construction performs no network I/O; speeds reset to zero when
/// the stream is quiet and to `--` only when there is no usable sample yet.
fn get_traffic_text(proxy_state: &ProxyState) -> Option<String> {
    let sample = proxy_state.traffic_snapshot();
    Some(format!(
        "\u{2191} {}  \u{2193} {}",
        format_speed(sample.upload_speed),
        format_speed(sample.download_speed)
    ))
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

pub fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let menu = build_tray_menu(app.handle())?;

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().cloned().unwrap())
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Pingu")
        .on_menu_event(|app, event: tauri::menu::MenuEvent| {
            handle_tray_menu_event(app, event.id().as_ref());
        })
        .build(app)?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Menu building
// ---------------------------------------------------------------------------

fn build_tray_menu(app_handle: &AppHandle) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let app_state = app_handle.state::<Arc<AppState>>();
    let proxy_state = app_handle.state::<Arc<ProxyState>>();

    let config = app_state.config.lock().map_err(|e| e.to_string())?;
    let connected = proxy_state.is_running();
    let lang = config.language.as_str();

    // --- Status line ---
    let status_label = if connected {
        let node_name = proxy_state
            .runtime_snapshot()
            .ok()
            .and_then(|runtime| runtime.running_node_id)
            .and_then(|node_id| {
                config
                    .nodes
                    .iter()
                    .find(|node| node.id == node_id)
                    .map(|node| node.name.clone())
            })
            .unwrap_or_default();
        if node_name.is_empty() {
            format!("\u{25cf} {}", tray_text(lang, "connected"))
        } else {
            format!("\u{25cf} {} - {}", tray_text(lang, "connected"), node_name)
        }
    } else {
        format!("\u{25cb} {}", tray_text(lang, "disconnected"))
    };

    let status_item = MenuItem::with_id(
        app_handle,
        "tray-status",
        &status_label,
        false,
        None::<&str>,
    )?;

    let sep1 = PredefinedMenuItem::separator(app_handle)?;

    // --- Connect / Disconnect ---
    let connect_disconnect = if connected {
        MenuItem::with_id(
            app_handle,
            "tray-disconnect",
            &tray_text(lang, "disconnect"),
            true,
            None::<&str>,
        )?
    } else {
        let has_nodes = !config.nodes.is_empty() && config.active_node_id.is_some();
        MenuItem::with_id(
            app_handle,
            "tray-connect",
            &tray_text(lang, "connect"),
            has_nodes,
            None::<&str>,
        )?
    };

    let sep2 = PredefinedMenuItem::separator(app_handle)?;

    // --- Nodes submenu ---
    let active_node_id = config.active_node_id.clone();
    let mut node_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    for node in &config.nodes {
        let prefix = if active_node_id.as_deref() == Some(&node.id) {
            "\u{2713} "
        } else {
            "   "
        };
        let label = format!("{}{}", prefix, node.name);
        let item_id = format!("tray-node-{}", node.id);
        let item = MenuItem::with_id(app_handle, &item_id, &label, true, None::<&str>)?;
        node_items.push(item);
    }

    let node_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = node_items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    let nodes_submenu = Submenu::with_items(
        app_handle,
        &tray_text(lang, "nodes"),
        !config.nodes.is_empty(),
        &node_refs,
    )?;

    let sep3 = PredefinedMenuItem::separator(app_handle)?;

    // --- Rule groups submenu ---
    let active_group_id = &config.active_group_id;
    let mut group_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    for group in &config.rule_groups {
        let prefix = if &group.id == active_group_id {
            "\u{2713} "
        } else {
            "   "
        };
        let label = format!("{}{}", prefix, group.name);
        let item_id = format!("tray-group-{}", group.id);
        let item = MenuItem::with_id(app_handle, &item_id, &label, true, None::<&str>)?;
        group_items.push(item);
    }

    let group_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = group_items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    let groups_submenu = Submenu::with_items(
        app_handle,
        &tray_text(lang, "rules"),
        !config.rule_groups.is_empty(),
        &group_refs,
    )?;

    let sep4 = PredefinedMenuItem::separator(app_handle)?;

    // --- Traffic display (only when connected) ---
    let traffic_item = if connected {
        let traffic_text = get_traffic_text(&proxy_state)
            .unwrap_or_else(|| "\u{2191} --  \u{2193} --".to_string());
        Some(MenuItem::with_id(
            app_handle,
            "tray-traffic",
            &traffic_text,
            false,
            None::<&str>,
        )?)
    } else {
        None
    };
    let sep5 = if traffic_item.is_some() {
        Some(PredefinedMenuItem::separator(app_handle)?)
    } else {
        None
    };

    // --- Show / Quit ---
    let show_item = MenuItem::with_id(
        app_handle,
        "tray-show",
        &tray_text(lang, "show"),
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(
        app_handle,
        "tray-quit",
        &tray_text(lang, "quit"),
        true,
        None::<&str>,
    )?;

    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![
        &status_item,
        &sep1,
        &connect_disconnect,
        &sep2,
        &nodes_submenu,
        &sep3,
        &groups_submenu,
        &sep4,
    ];
    if let Some(ref ti) = traffic_item {
        items.push(ti);
    }
    if let Some(ref s) = sep5 {
        items.push(s);
    }
    items.push(&show_item);
    items.push(&quit_item);

    let menu = Menu::with_items(app_handle, &items)?;

    Ok(menu)
}

pub fn rebuild_tray_menu(app_handle: &AppHandle) -> Result<(), String> {
    let menu = build_tray_menu(app_handle).map_err(|e| e.to_string())?;

    if let Some(tray) = app_handle.tray_by_id(&TrayIconId::new(TRAY_ID)) {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;

        // Update tooltip based on connection status
        let proxy_state = app_handle.state::<Arc<ProxyState>>();
        let tooltip = if proxy_state.is_running() {
            "Pingu - Connected"
        } else {
            "Pingu"
        };
        tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Rebuild the tray menu on the main thread (AppKit menu APIs require it).
/// Scheduling never blocks on a lifecycle operation and no state lock is held
/// while the closure is queued; the closure re-reads state when it runs.
pub fn rebuild_tray_menu_on_main(app_handle: AppHandle) -> Result<(), String> {
    let inner = app_handle.clone();
    app_handle
        .run_on_main_thread(move || {
            if let Err(error) = rebuild_tray_menu(&inner) {
                eprintln!("Failed to rebuild tray menu: {error}");
            }
        })
        .map_err(|error| format!("Failed to schedule tray rebuild: {error}"))
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

fn handle_tray_menu_event(app: &AppHandle, event_id: &str) {
    match event_id {
        "tray-connect" => {
            handle_connect(app);
        }
        "tray-disconnect" => {
            handle_disconnect(app);
        }
        "tray-show" => {
            #[cfg(target_os = "macos")]
            {
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "tray-quit" => {
            // Route through the single coordinator: shutdown runs once, off
            // the main thread, and Cmd-Q / repeated clicks cannot duplicate it.
            crate::request_app_exit(app);
        }
        id if id.starts_with("tray-node-") => {
            let node_id = &id["tray-node-".len()..];
            handle_switch_node(app, node_id);
        }
        id if id.starts_with("tray-group-") => {
            let group_id = &id["tray-group-".len()..];
            handle_switch_group(app, group_id);
        }
        _ => {}
    }
}

fn handle_connect(app: &AppHandle) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let app_state = app_handle.state::<Arc<AppState>>().inner().clone();
        let proxy_state = app_handle.state::<Arc<ProxyState>>().inner().clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::commands::proxy::connect_core(&app_state, &proxy_state)
        })
        .await;
        let succeeded = matches!(result, Ok(Ok(())));
        let main_handle = app_handle.clone();
        app_handle
            .run_on_main_thread(move || {
                if succeeded {
                    let _ = rebuild_tray_menu(&main_handle);
                    main_handle.emit("tray-state-changed", "connect").ok();
                }
            })
            .ok();
    });
}

fn handle_disconnect(app: &AppHandle) {
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let proxy_state = app_handle.state::<Arc<ProxyState>>().inner().clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::commands::proxy::disconnect_core(&proxy_state)
        })
        .await;
        let succeeded = matches!(result, Ok(Ok(())));
        let main_handle = app_handle.clone();
        app_handle
            .run_on_main_thread(move || {
                if succeeded {
                    let _ = rebuild_tray_menu(&main_handle);
                    main_handle.emit("tray-state-changed", "disconnect").ok();
                }
            })
            .ok();
    });
}

fn handle_switch_node(app: &AppHandle, node_id: &str) {
    handle_config_switch(app, node_id, "switch-node", SwitchTarget::Node);
}

fn handle_switch_group(app: &AppHandle, group_id: &str) {
    handle_config_switch(app, group_id, "switch-group", SwitchTarget::Group);
}

#[derive(Clone, Copy)]
enum SwitchTarget {
    Node,
    Group,
}

fn handle_config_switch(app: &AppHandle, id: &str, event: &'static str, target: SwitchTarget) {
    let app_handle = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let app_state = app_handle.state::<Arc<AppState>>().inner().clone();
        let proxy_state = app_handle.state::<Arc<ProxyState>>().inner().clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            crate::lifecycle::apply_runtime_config_change(&app_state, &proxy_state, |config| {
                match target {
                    SwitchTarget::Node => config.set_active_node(&id),
                    SwitchTarget::Group => config.set_active_group(&id),
                }
            })
        })
        .await;
        let succeeded = matches!(result, Ok(Ok(())));
        let main_handle = app_handle.clone();
        app_handle
            .run_on_main_thread(move || {
                if succeeded {
                    let _ = rebuild_tray_menu(&main_handle);
                    main_handle.emit("tray-state-changed", event).ok();
                }
            })
            .ok();
    });
}
