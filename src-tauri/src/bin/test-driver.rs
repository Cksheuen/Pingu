use std::fs;
use std::path::PathBuf;

use pingu_lib::proxy_runtime::{
    app_config_dir, build_proxy_status, proxy_info, resolve_runtime_selection,
};
use pingu_lib::singbox::config_gen::Rule;
use pingu_lib::singbox::process::{log_file_path, LogEntry};
use pingu_lib::storage::app_config::AppConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct RuntimeSnapshot {
    connected: bool,
    uptime_seconds: u64,
    active_node_id: Option<String>,
    active_group_id: Option<String>,
    logs: Vec<LogEntry>,
}

fn runtime_snapshot_path() -> Result<PathBuf, String> {
    Ok(app_config_dir()?.join("test-runtime.json"))
}

fn load_runtime_snapshot() -> Result<RuntimeSnapshot, String> {
    let path = runtime_snapshot_path()?;
    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).map_err(|e| e.to_string()),
        Err(_) => Ok(RuntimeSnapshot::default()),
    }
}

fn save_runtime_snapshot(snapshot: &RuntimeSnapshot) -> Result<(), String> {
    let path = runtime_snapshot_path()?;
    let content = serde_json::to_string_pretty(snapshot).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

fn add_runtime_log(snapshot: &mut RuntimeSnapshot, level: &str, message: impl Into<String>) {
    snapshot.logs.push(LogEntry {
        timestamp: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        level: level.to_string(),
        message: message.into(),
    });
}

fn get_string_arg(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .ok_or_else(|| format!("Missing string arg: {}", key))
}

fn refresh_connected_snapshot(config: &AppConfig, snapshot: &mut RuntimeSnapshot, message: &str) {
    if snapshot.connected {
        snapshot.active_node_id = config.active_node_id.clone();
        snapshot.active_group_id = Some(config.active_group_id.clone());
        snapshot.uptime_seconds += 1;
        add_runtime_log(snapshot, "info", message.to_string());
    }
}

fn invoke(command: &str, args: &Value) -> Result<Value, String> {
    let mut config = AppConfig::load();
    let mut snapshot = load_runtime_snapshot()?;

    let result = match command {
        "import_node" => {
            let uri = get_string_arg(args, "vlessUri")?;
            let node = config.import_node_uri(&uri)?;
            config.save()?;
            json!(node)
        }
        "delete_node" => {
            let id = get_string_arg(args, "id")?;
            config.delete_node(&id);
            config.save()?;
            refresh_connected_snapshot(
                &config,
                &mut snapshot,
                format!("Reloaded after deleting node {}", id).as_str(),
            );
            save_runtime_snapshot(&snapshot)?;
            Value::Null
        }
        "list_nodes" => json!(config.nodes),
        "set_active_node" => {
            let id = get_string_arg(args, "id")?;
            config.set_active_node(&id)?;
            config.save()?;
            refresh_connected_snapshot(
                &config,
                &mut snapshot,
                format!("Reloaded with node {}", id).as_str(),
            );
            save_runtime_snapshot(&snapshot)?;
            Value::Null
        }
        "connect" => {
            let selection = resolve_runtime_selection(&config)?;
            snapshot.connected = true;
            snapshot.uptime_seconds = 1;
            snapshot.active_node_id = Some(selection.node.id.clone());
            snapshot.active_group_id = Some(selection.rule_group.id.clone());
            add_runtime_log(
                &mut snapshot,
                "info",
                format!(
                    "Connected to {} using {}",
                    selection.node.name, selection.rule_group.name
                ),
            );
            save_runtime_snapshot(&snapshot)?;
            Value::Null
        }
        "disconnect" => {
            snapshot.connected = false;
            snapshot.uptime_seconds = 0;
            snapshot.active_node_id = None;
            snapshot.active_group_id = None;
            add_runtime_log(&mut snapshot, "info", "Disconnected");
            save_runtime_snapshot(&snapshot)?;
            Value::Null
        }
        "get_status" => json!(build_proxy_status(
            &config,
            snapshot.connected,
            snapshot.uptime_seconds,
            snapshot.active_node_id.clone(),
            snapshot.active_group_id.clone(),
        )),
        "get_proxy_info" => json!(proxy_info()),
        "get_logs" => json!(snapshot.logs),
        "clear_logs" => {
            snapshot.logs.clear();
            save_runtime_snapshot(&snapshot)?;
            Value::Null
        }
        "get_log_file_path" => json!(log_file_path().to_string_lossy().to_string()),
        "list_rule_groups" => json!(config.rule_groups),
        "get_active_group_id" => json!(config.active_group_id),
        "set_active_group" => {
            let id = get_string_arg(args, "id")?;
            config.set_active_group(&id)?;
            config.save()?;
            refresh_connected_snapshot(
                &config,
                &mut snapshot,
                format!("Reloaded with group {}", id).as_str(),
            );
            save_runtime_snapshot(&snapshot)?;
            Value::Null
        }
        "create_rule_group" => {
            let name = get_string_arg(args, "name")?;
            let group = config.create_rule_group(name);
            config.save()?;
            json!(group)
        }
        "delete_rule_group" => {
            let id = get_string_arg(args, "id")?;
            config.delete_rule_group(&id)?;
            config.save()?;
            refresh_connected_snapshot(
                &config,
                &mut snapshot,
                format!("Reloaded after deleting group {}", id).as_str(),
            );
            save_runtime_snapshot(&snapshot)?;
            Value::Null
        }
        "rename_rule_group" => {
            let id = get_string_arg(args, "id")?;
            let name = get_string_arg(args, "name")?;
            config.rename_rule_group(&id, name)?;
            config.save()?;
            refresh_connected_snapshot(
                &config,
                &mut snapshot,
                format!("Reloaded after renaming group {}", id).as_str(),
            );
            save_runtime_snapshot(&snapshot)?;
            Value::Null
        }
        "list_rules" => json!(config.list_rules()?),
        "add_rule" => {
            let mut rule_value = args
                .get("rule")
                .cloned()
                .ok_or_else(|| "Missing rule arg".to_string())?;
            if let Some(rule_object) = rule_value.as_object_mut() {
                rule_object
                    .entry("id".to_string())
                    .or_insert_with(|| Value::String(String::new()));
            }
            let rule: Rule = serde_json::from_value(rule_value).map_err(|e| e.to_string())?;
            let inserted = config.add_rule_to_active_group(rule)?;
            config.save()?;
            refresh_connected_snapshot(
                &config,
                &mut snapshot,
                format!("Reloaded after adding rule {}", inserted.id).as_str(),
            );
            save_runtime_snapshot(&snapshot)?;
            Value::Null
        }
        "delete_rule" => {
            let id = get_string_arg(args, "id")?;
            config.delete_rule_from_active_group(&id)?;
            config.save()?;
            refresh_connected_snapshot(
                &config,
                &mut snapshot,
                format!("Reloaded after deleting rule {}", id).as_str(),
            );
            save_runtime_snapshot(&snapshot)?;
            Value::Null
        }
        "set_default_strategy" => {
            let strategy = get_string_arg(args, "strategy")?;
            config.set_active_group_default_strategy(&strategy)?;
            config.save()?;
            refresh_connected_snapshot(
                &config,
                &mut snapshot,
                format!("Reloaded after changing strategy to {}", strategy).as_str(),
            );
            save_runtime_snapshot(&snapshot)?;
            Value::Null
        }
        other => return Err(format!("Unknown command: {}", other)),
    };

    Ok(result)
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 || args[1] != "invoke" {
        return Err("Usage: test-driver invoke <command> [json-args]".to_string());
    }

    let command = &args[2];
    let payload = if args.len() >= 4 {
        serde_json::from_str::<Value>(&args[3]).map_err(|e| e.to_string())?
    } else {
        json!({})
    };

    let result = invoke(command, &payload)?;
    println!(
        "{}",
        serde_json::to_string(&result).map_err(|e| e.to_string())?
    );
    Ok(())
}
