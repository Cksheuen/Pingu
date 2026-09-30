use crate::{
    chain::{self, ChainSettings, Choice},
    commands::config::AppState,
    lifecycle::{apply_runtime_config_change, ProxyState},
};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;
#[derive(Serialize)]
pub struct ChainSnapshot {
    pub settings: ChainSettings,
    pub choices: Vec<Choice>,
}
#[tauri::command]
pub fn get_proxy_chain(state: State<Arc<AppState>>) -> Result<ChainSnapshot, String> {
    let config = state
        .config
        .lock()
        .map_err(|_| "Configuration unavailable")?;
    Ok(ChainSnapshot {
        settings: config.proxy_chain.clone(),
        choices: chain::choices(&config),
    })
}
#[tauri::command]
pub async fn save_proxy_chain(
    settings: ChainSettings,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<(), String> {
    let app = state.inner().clone();
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        apply_runtime_config_change(&app, &proxy, |config| {
            if settings.enabled {
                chain::pair(config, &settings)?;
            }
            config.proxy_chain = settings;
            Ok(())
        })
        .map_err(|e| e.message)
    })
    .await
    .map_err(|_| "Chain update failed".to_string())?
}
#[tauri::command]
pub async fn compare_proxy_chain(
    settings: ChainSettings,
    state: State<'_, Arc<AppState>>,
) -> Result<chain::probe::Comparison, String> {
    let config = state
        .config
        .lock()
        .map_err(|_| "Configuration unavailable")?
        .clone();
    tauri::async_runtime::spawn_blocking(move || chain::probe::compare(&config, settings))
        .await
        .map_err(|_| "Chain comparison failed".to_string())?
}
#[tauri::command]
pub fn cancel_chain_comparison() -> bool {
    chain::probe::cancel()
}

#[tauri::command]
pub async fn get_chain_runtime(
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<chain::RuntimeRoute, String> {
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = proxy.runtime_snapshot()?;
        if snapshot.connected_at.is_none() || !proxy.is_running() {
            return Err("Connect Mihomo first.".into());
        }
        let port = snapshot
            .clash_api_port
            .ok_or("Mihomo controller unavailable.")?;
        let body = crate::mihomo::controller::request(port, "GET", "/proxies", None)?;
        if proxy.runtime_snapshot()?.generation != snapshot.generation {
            return Err("Runtime changed; refreshing route.".into());
        }
        Ok(chain::runtime_route(&body))
    })
    .await
    .map_err(|_| "Chain status unavailable".to_string())?
}

#[tauri::command]
pub fn get_chain_probe_progress() -> chain::latency::Progress {
    chain::latency::progress()
}

#[tauri::command]
pub async fn auto_select_chain(
    exit: chain::NodeRef,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
) -> Result<chain::latency::Selection, String> {
    let app = state.inner().clone();
    let proxy = proxy_state.inner().clone();
    let config = app
        .config
        .lock()
        .map_err(|_| "Configuration unavailable")?
        .clone();
    tauri::async_runtime::spawn_blocking(move || {
        chain::latency::auto_select_with(&config, exit.clone(), |selection| {
            let expected = serde_json::to_value(&config).map_err(|_| "Invalid configuration")?;
            apply_runtime_config_change(&app, &proxy, |current| {
                if chain::latency::cancelled() {
                    return Err("Selection cancelled; current settings were kept.".into());
                }
                if serde_json::to_value(&*current).ok().as_ref() != Some(&expected) {
                    return Err(
                        "Configuration changed during testing. Run automatic selection again."
                            .into(),
                    );
                }
                if let Some(entry) = selection.selected.clone() {
                    current.proxy_chain = ChainSettings {
                        enabled: true,
                        entry: Some(entry),
                        exit: Some(exit.clone()),
                    };
                    chain::pair(current, &current.proxy_chain)?;
                } else {
                    chain::use_single_exit(current, exit.clone())?;
                }
                Ok(())
            })
            .map_err(|e| e.message)?;
            selection.applied = true;
            Ok(())
        })
    })
    .await
    .map_err(|_| "Automatic selection failed".to_string())?
}
