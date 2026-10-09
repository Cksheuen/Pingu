use crate::commands::config::AppState;
use crate::lifecycle::{apply_runtime_config_change, mutate_config_only, ProxyState};
use crate::mihomo::{
    controller,
    profiles::{self, Subscription, SubscriptionSummary},
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn list_subscriptions(state: State<Arc<AppState>>) -> Result<Vec<SubscriptionSummary>, String> {
    Ok(state
        .config
        .lock()
        .map_err(|_| "Configuration unavailable")?
        .subscriptions
        .iter()
        .map(Subscription::summary)
        .collect())
}

fn validate_candidate(subscription: &Subscription) -> Result<(), String> {
    let mut config = crate::storage::app_config::AppConfig::default_config();
    config.subscriptions = vec![subscription.clone()];
    let mut group = config.active_rule_group()?.clone();
    group.rules.clear();
    let value = crate::mihomo::config_gen::try_generate_app_config(&config, &group, &[], 0, 0)?;
    let dir = std::env::temp_dir().join(format!("pingu-mihomo-validate-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).map_err(|_| "Cannot create validation directory")?;
    let path = dir.join("config.json");
    if let Err(error) = (|| {
        crate::mihomo::private_write(
            &path,
            serde_json::to_string(&value)
                .map_err(|_| "Invalid configuration")?
                .as_bytes(),
        )
    })() {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(error);
    }
    match crate::mihomo::process::MihomoProcess::new()
        .check(path.to_str().ok_or("Invalid validation path")?)
    {
        Ok(()) => {
            let _ = std::fs::remove_dir_all(dir);
            Ok(())
        }
        Err(error) => {
            let _ = error.finish_owned_cleanup(Some(dir));
            Err("Mihomo rejected this subscription configuration. Check proxy/group/rule references and supported options.".into())
        }
    }
}
#[tauri::command]
pub async fn import_subscription(
    name: String,
    input: String,
    nodes_only: Option<bool>,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<SubscriptionSummary, String> {
    let app = state.inner().clone();
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let name = profiles::validate_name(&name)?;
        let (fragment, warnings) = profiles::load_input(&input)?;
        let subscription = Subscription {
            nodes_only: nodes_only.unwrap_or(false),
            id: uuid::Uuid::new_v4().to_string(),
            name,
            input: input.trim().into(),
            enabled: true,
            updated_at: profiles::timestamp(),
            last_error: None,
            fragment,
            warnings,
        };
        validate_candidate(&subscription)?;
        let summary = subscription.summary();
        apply_runtime_config_change(&app, &proxy, move |config| {
            if config.subscriptions.len() >= 30 {
                return Err("Maximum 30 subscriptions.".into());
            }
            config.subscriptions.push(subscription);
            Ok(())
        })
        .map_err(|e| e.message)?;
        Ok(summary)
    })
    .await
    .map_err(|_| "Subscription import task failed".to_string())?
}
#[tauri::command]
pub async fn refresh_subscription(
    id: String,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<SubscriptionSummary, String> {
    let app = state.inner().clone();
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let original = app
            .config
            .lock()
            .map_err(|_| "Configuration unavailable")?
            .subscriptions
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or("Subscription not found")?;
        let mut candidate = original.clone();
        let refresh = (|| {
            let (fragment, warnings) = profiles::load_input(&candidate.input)?;
            candidate.fragment = fragment;
            candidate.warnings = warnings;
            candidate.last_error = None;
            candidate.updated_at = profiles::timestamp();
            validate_candidate(&candidate)
        })();
        if let Err(error) = refresh {
            let error_copy = error.clone();
            let _ = mutate_config_only(&app, |config| {
                if let Some(current) = config.subscriptions.iter_mut().find(|s| s.id == id) {
                    current.last_error = Some(error_copy);
                }
                Ok(())
            });
            return Err(format!("{error} Last working subscription was retained."));
        }
        apply_runtime_config_change(&app, &proxy, |config| {
            let current = config
                .subscriptions
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or("Subscription was removed while refreshing")?;
            if current.updated_at != original.updated_at {
                return Err("Subscription changed while refreshing; retry.".into());
            }
            candidate.name = current.name.clone();
            candidate.enabled = current.enabled;
            *current = candidate;
            Ok(current.summary())
        })
        .map_err(|e| e.message)
    })
    .await
    .map_err(|_| "Subscription refresh task failed".to_string())?
}
#[tauri::command]
pub async fn update_subscription(
    id: String,
    name: Option<String>,
    enabled: Option<bool>,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<SubscriptionSummary, String> {
    let app = state.inner().clone();
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let name = name.as_deref().map(profiles::validate_name).transpose()?;
        apply_runtime_config_change(&app, &proxy, |config| {
            let s = config
                .subscriptions
                .iter_mut()
                .find(|s| s.id == id)
                .ok_or("Subscription not found")?;
            if let Some(name) = name {
                s.name = name;
            }
            if let Some(enabled) = enabled {
                s.enabled = enabled;
            }
            Ok(s.summary())
        })
        .map_err(|e| e.message)
    })
    .await
    .map_err(|_| "Subscription update task failed".to_string())?
}
#[tauri::command]
pub async fn delete_subscription(
    id: String,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), String> {
    let app = state.inner().clone();
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app, &proxy, |config| {
            if !config.subscriptions.iter().any(|s| s.id == id) {
                return Err("Subscription not found".into());
            }
            config.subscriptions.retain(|s| s.id != id);
            Ok(())
        })
        .map_err(|e| e.message)
    })
    .await
    .map_err(|_| "Subscription removal task failed".to_string())?
}
fn api_port(proxy: &ProxyState) -> Result<u16, String> {
    let snapshot = proxy.runtime_snapshot()?;
    if snapshot.connected_at.is_none() || !proxy.is_running() {
        return Err("Connect Mihomo first.".into());
    }
    snapshot
        .clash_api_port
        .ok_or("Mihomo controller unavailable.".into())
}
/// Static choices remain available before connecting, including subscription
/// nodes. Provider-only members appear when the core has fetched the provider.
fn offline_strategy_groups(
    config: &crate::storage::app_config::AppConfig,
) -> Result<Vec<controller::StrategyGroup>, String> {
    let value = crate::mihomo::config_gen::try_generate_app_config(
        config,
        config.active_rule_group()?,
        &[],
        0,
        0,
    )?;
    Ok(value["proxy-groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| {
            let all = g["proxies"]
                .as_array()?
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>();
            let selected = g["default-selected"]
                .as_str()
                .filter(|s| all.iter().any(|n| n == s))
                .map(str::to_string)
                .or_else(|| all.first().cloned());
            Some(controller::StrategyGroup {
                name: g["name"].as_str()?.into(),
                kind: g["type"].as_str()?.into(),
                now: selected,
                all,
                alive: false,
                history: vec![],
            })
        })
        .collect())
}
#[tauri::command]
pub async fn list_strategy_groups(
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<Vec<controller::StrategyGroup>, String> {
    let app = state.inner().clone();
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = app
            .operation_lock
            .lock()
            .map_err(|_| "Operation unavailable")?;
        if proxy.is_running() {
            controller::groups(api_port(&proxy)?)
        } else {
            offline_strategy_groups(
                &app.config
                    .lock()
                    .map_err(|_| "Configuration unavailable")?
                    .clone(),
            )
        }
    })
    .await
    .map_err(|_| "Strategy query failed".to_string())?
}

fn select_strategy_locked(
    app: &AppState,
    proxy: &ProxyState,
    group: String,
    name: String,
) -> Result<(), String> {
    if proxy.is_shutting_down() {
        return Err("Pingu is shutting down".into());
    }
    let _phase = proxy.operation_phase("switching");
    let mut config = app
        .config
        .lock()
        .map_err(|_| "Configuration unavailable")?
        .clone();
    if config.proxy_chain.enabled {
        return Err("Disable the chain before changing strategy groups.".into());
    }
    let port = if proxy.is_running() {
        Some(api_port(proxy)?)
    } else {
        None
    };
    let groups = match port {
        Some(port) => controller::groups(port)?,
        None => offline_strategy_groups(&config)?,
    };
    let g = groups
        .iter()
        .find(|g| g.name == group)
        .ok_or("Strategy group not found")?;
    if !matches!(g.kind.to_lowercase().as_str(), "selector" | "select") {
        return Err("Only selector groups allow manual selection.".into());
    }
    if !g.all.contains(&name) {
        return Err("Proxy does not belong to this group.".into());
    }
    if g.now.as_ref() == Some(&name) && config.strategy_selections.get(&group) == Some(&name) {
        return Ok(());
    }
    config
        .strategy_selections
        .insert(group.clone(), name.clone());
    let changed = (|| {
        if let Some(port) = port {
            proxy.routing_changed(None)?;
            controller::select(port, &group, &name)?;
            crate::proxy_runtime::verify_startup_proxy_content(proxy.active_listen_port())?;
        }
        config.save()
    })();
    if let Err(error) = changed {
        if let (Some(port), Some(now)) = (port, &g.now) {
            if let Err(rollback) = controller::select(port, &group, now) {
                let cleanup = crate::lifecycle::disconnect_locked(proxy, false).err();
                return Err(format!(
                    "{error}; selection rollback failed: {rollback}; proxy stopped{}",
                    cleanup.map(|e| format!(": {e}")).unwrap_or_default()
                ));
            }
        }
        return Err(error);
    }
    let selected_id = crate::proxy_runtime::resolve_runtime_selection(&config)
        .ok()
        .map(|s| (s.node.id, s.node.name));
    *app.config.lock().map_err(|_| "Configuration unavailable")? = config;
    proxy.routing_changed(selected_id)?;
    Ok(())
}
#[tauri::command]
pub async fn select_strategy_proxy(
    group: String,
    name: String,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), String> {
    let app = state.inner().clone();
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = app
            .operation_lock
            .lock()
            .map_err(|_| "Operation unavailable")?;
        select_strategy_locked(&app, &proxy, group, name)
    })
    .await
    .map_err(|_| "Strategy selection task failed".to_string())?
}
#[tauri::command]
pub async fn test_strategy_delay(
    name: String,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<controller::DelayResult, String> {
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || controller::delay(api_port(&proxy)?, &name))
        .await
        .map_err(|_| "Delay test task failed".to_string())?
}
#[tauri::command]
pub async fn list_connections(
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<controller::Connections, String> {
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || proxy.list_managed_connections())
        .await
        .map_err(|_| "Connections query failed".to_string())?
}
#[tauri::command]
pub async fn close_connection(
    id: String,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), String> {
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || proxy.close_managed_connection(&id))
        .await
        .map_err(|_| "Close connection failed".to_string())?
}
#[tauri::command]
pub async fn close_all_connections(proxy_state: State<'_, Arc<ProxyState>>) -> Result<(), String> {
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || proxy.close_all_managed_connections())
        .await
        .map_err(|_| "Close connections failed".to_string())?
}
