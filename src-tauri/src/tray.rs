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

fn get_traffic_text(proxy_state: &ProxyState) -> Option<String> {
    let port = proxy_state.clash_api_port.lock().ok()?.clone()?;
    let url = format!("http://127.0.0.1:{}/traffic", port);
    let body: serde_json::Value = ureq::get(&url)
        .timeout(std::time::Duration::from_millis(500))
        .call()
        .ok()?
        .into_json()
        .ok()?;
    let up = body["up"].as_u64().unwrap_or(0);
    let down = body["down"].as_u64().unwrap_or(0);
    Some(format!("\u{2191} {}  \u{2193} {}", format_speed(up), format_speed(down)))
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
    let app_state = app_handle.state::<AppState>();
    let proxy_state = app_handle.state::<ProxyState>();

    let config = app_state.config.lock().map_err(|e| e.to_string())?;
    let connected = proxy_state.process.is_running();
    let lang = config.language.as_str();

    // --- Status line ---
    let status_label = if connected {
        let node_name = proxy_state
            .running_node_id
            .lock()
            .ok()
            .and_then(|id| {
                id.as_ref().and_then(|nid| {
                    config
                        .nodes
                        .iter()
                        .find(|n| &n.id == nid)
                        .map(|n| n.name.clone())
                })
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

    let status_item = MenuItem::with_id(app_handle, "tray-status", &status_label, false, None::<&str>)?;

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

    let node_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        node_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
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

    let group_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        group_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
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
        Some(MenuItem::with_id(app_handle, "tray-traffic", &traffic_text, false, None::<&str>)?)
    } else {
        None
    };
    let sep5 = if traffic_item.is_some() {
        Some(PredefinedMenuItem::separator(app_handle)?)
    } else {
        None
    };

    // --- Show / Quit ---
    let show_item = MenuItem::with_id(app_handle, "tray-show", &tray_text(lang, "show"), true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app_handle, "tray-quit", &tray_text(lang, "quit"), true, None::<&str>)?;

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
        let proxy_state = app_handle.state::<ProxyState>();
        let tooltip = if proxy_state.process.is_running() {
            "Pingu - Connected"
        } else {
            "Pingu"
        };
        tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    }

    Ok(())
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
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        "tray-quit" => {
            let _ = crate::system::proxy_macos::clear_system_proxy();
            app.exit(0);
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
    let app_state = app.state::<AppState>();
    let proxy_state = app.state::<ProxyState>();
    if crate::commands::proxy::connect_core(app_state.inner(), proxy_state.inner()).is_ok()
        && rebuild_tray_menu(app).is_ok()
    {
        app.emit("tray-state-changed", "connect").ok();
    }
}

fn handle_disconnect(app: &AppHandle) {
    let proxy_state = app.state::<ProxyState>();
    if crate::commands::proxy::disconnect_core(proxy_state.inner()).is_ok()
        && rebuild_tray_menu(app).is_ok()
    {
        app.emit("tray-state-changed", "disconnect").ok();
    }
}

fn handle_switch_node(app: &AppHandle, node_id: &str) {
    let app_state = app.state::<AppState>();
    let proxy_state = app.state::<ProxyState>();

    {
        let mut config = match app_state.config.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        if config.set_active_node(node_id).is_err() {
            return;
        }
        let _ = config.save();
    }

    // Reload proxy if running
    if crate::commands::proxy::reload_proxy_if_running(app_state.inner(), proxy_state.inner()).is_ok()
        && rebuild_tray_menu(app).is_ok()
    {
        app.emit("tray-state-changed", "switch-node").ok();
    }
}

fn handle_switch_group(app: &AppHandle, group_id: &str) {
    let app_state = app.state::<AppState>();
    let proxy_state = app.state::<ProxyState>();

    {
        let mut config = match app_state.config.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        if config.set_active_group(group_id).is_err() {
            return;
        }
        let _ = config.save();
    }

    // Reload proxy if running
    if crate::commands::proxy::reload_proxy_if_running(app_state.inner(), proxy_state.inner()).is_ok()
        && rebuild_tray_menu(app).is_ok()
    {
        app.emit("tray-state-changed", "switch-group").ok();
    }
}
