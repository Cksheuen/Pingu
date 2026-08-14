use std::process::Command;

use pingu_lib::proxy_runtime::{check_generated_config, prepare_runtime};
use pingu_lib::storage::app_config::AppConfig;

fn print_usage() {
    eprintln!("用法:");
    eprintln!("  cargo run --manifest-path src-tauri/Cargo.toml --bin debug-proxy -- status");
    eprintln!("  cargo run --manifest-path src-tauri/Cargo.toml --bin debug-proxy -- prepare");
    eprintln!("  cargo run --manifest-path src-tauri/Cargo.toml --bin debug-proxy -- start");
}

fn print_status(config: &AppConfig) {
    println!("nodes: {}", config.nodes.len());
    println!(
        "active_node_id: {}",
        config.active_node_id.as_deref().unwrap_or("<none>")
    );
    println!("rule_groups: {}", config.rule_groups.len());
    println!("active_group_id: {}", config.active_group_id);

    if let Some(active_id) = &config.active_node_id {
        if let Some(node) = config.nodes.iter().find(|node| &node.id == active_id) {
            println!("active_node_name: {}", node.name);
            println!("active_node_server: {}:{}", node.address, node.port);
        }
    }

    if let Some(group) = config
        .rule_groups
        .iter()
        .find(|group| group.id == config.active_group_id)
    {
        println!("active_group_name: {}", group.name);
        println!("active_group_default_strategy: {}", group.default_strategy);
        println!("active_group_rules: {}", group.rules.len());
    }
}

fn main() -> Result<(), String> {
    let action = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "status".to_string());
    let config = AppConfig::load();

    match action.as_str() {
        "status" => {
            print_status(&config);
            Ok(())
        }
        "prepare" => {
            print_status(&config);
            let prepared = prepare_runtime(&config)?;
            check_generated_config(&prepared.config_path)?;
            println!("config_dir: {}", prepared.config_dir.display());
            println!("cache_path: {}", prepared.cache_path.display());
            println!("config_path: {}", prepared.config_path.display());
            println!("prepared_node: {}", prepared.node.name);
            println!("prepared_group: {}", prepared.rule_group.name);
            println!("sing-box config check: ok");
            Ok(())
        }
        "start" => {
            print_status(&config);
            let prepared = prepare_runtime(&config)?;
            check_generated_config(&prepared.config_path)?;
            println!("starting sing-box with: {}", prepared.config_path.display());
            println!("listen: http://127.0.0.1:2080");
            let status = Command::new("sing-box")
                .args([
                    "run",
                    "-c",
                    prepared.config_path.to_str().ok_or("Invalid config path")?,
                ])
                .status()
                .map_err(|e| format!("Failed to start sing-box: {}", e))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("sing-box exited with status: {}", status))
            }
        }
        _ => {
            print_usage();
            Err(format!("Unknown action: {}", action))
        }
    }
}
