use crate::{
    commands::config::AppState,
    egress::{self, EgressState, Management, SelectedEgress},
    lifecycle::{apply_runtime_config_change, mutate_config_only, ProxyState},
};
use serde_json::json;
use std::sync::Arc;
use tauri::State;

fn snapshot(app: &AppState) -> Result<crate::storage::app_config::AppConfig, String> {
    app.config
        .lock()
        .map(|c| c.clone())
        .map_err(|_| "Configuration unavailable".into())
}

#[tauri::command]
pub async fn get_vps_egress(
    state: State<'_, Arc<AppState>>,
    refresh: bool,
) -> Result<EgressState, String> {
    let config = snapshot(&state)?;
    tauri::async_runtime::spawn_blocking(move || egress::state(&config, refresh))
        .await
        .map_err(|_| "Egress status task failed".into())
}

#[tauri::command]
pub async fn configure_vps_egress(
    state: State<'_, Arc<AppState>>,
    management: Management,
) -> Result<EgressState, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = egress::MANAGEMENT_LOCK
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "Egress manager busy")?;
        management.validate()?;
        mutate_config_only(&app, |config| {
            if config.vps_egress.selected.is_some()
                && config.vps_egress.management.as_ref() != Some(&management)
            {
                return Err(
                    "Switch to the VPS direct exit before changing its management connection."
                        .into(),
                );
            }
            config.vps_egress.management = Some(management);
            Ok(())
        })
        .map_err(|e| e.message)?;
        Ok(egress::state(&snapshot(&app)?, true))
    })
    .await
    .map_err(|_| "Egress configuration task failed".to_string())?
}

#[tauri::command]
pub async fn create_cloudflare_egress(
    state: State<'_, Arc<AppState>>,
    name: String,
    id: Option<String>,
) -> Result<EgressState, String> {
    let app = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = egress::MANAGEMENT_LOCK
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "Egress manager busy")?;
        if name.trim().is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control)
        {
            return Err("Use a name containing 1–60 printable characters.".into());
        }
        let config = snapshot(&app)?;
        let management = config
            .vps_egress
            .management
            .as_ref()
            .ok_or("Configure the VPS management connection first")?;
        let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        uuid::Uuid::parse_str(&id).map_err(|_| "Invalid exit ID")?;
        let remote = egress::request(management, json!({"action":"create", "id":id, "name":name}))?;
        remote_state(&app, remote)
    })
    .await
    .map_err(|_| "Cloudflare creation task failed".to_string())?
}

fn select(app: &AppState, proxy: &ProxyState, exit_id: &str) -> Result<(), String> {
    let original = snapshot(app)?;
    let selection = if exit_id != "direct" {
        let management = original
            .vps_egress
            .management
            .as_ref()
            .ok_or("Configure VPS management first")?;
        let remote = egress::request(management, json!({"action":"status"}))?;
        let exit = remote
            .exits
            .into_iter()
            .find(|x| x.id == exit_id && x.ready && x.phase == "ready")
            .ok_or("The Cloudflare exit has not passed its connection check")?;
        let (proxy_name, server) = egress::selected_proxy(&original)?;
        if server != management.proxy_server {
            return Err("The selected node belongs to another VPS.".into());
        }
        Some(SelectedEgress {
            id: exit.id,
            proxy_name,
            server,
            uuid: exit.uuid,
        })
    } else {
        None
    };
    apply_runtime_config_change(app, proxy, move |config| {
        // Check the route again under the lifecycle lock, after the remote probe.
        if let Some(exit) = &selection {
            if egress::selected_proxy(config)? != (exit.proxy_name.clone(), exit.server.clone())
                || config.vps_egress.management != original.vps_egress.management
            {
                return Err("The selected VPS changed during verification; retry.".into());
            }
        }
        config.vps_egress.selected = selection;
        Ok(())
    })
    .map_err(|e| e.message)
}

#[tauri::command]
pub async fn select_vps_egress(
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
    mode: String,
) -> Result<EgressState, String> {
    if mode != "direct" && mode != "legacy" && uuid::Uuid::parse_str(&mode).is_err() {
        return Err("Unknown VPS exit".into());
    }
    let app = state.inner().clone();
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = egress::MANAGEMENT_LOCK
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "Egress manager busy")?;
        select(&app, &proxy, &mode)?;
        Ok(egress::state(&snapshot(&app)?, true))
    })
    .await
    .map_err(|_| "Egress selection task failed".to_string())?
}

#[tauri::command]
pub async fn delete_cloudflare_egress(
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
    id: String,
) -> Result<EgressState, String> {
    let app = state.inner().clone();
    let proxy = proxy_state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = egress::MANAGEMENT_LOCK
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "Egress manager busy")?;
        let config = snapshot(&app)?;
        let management = config
            .vps_egress
            .management
            .as_ref()
            .ok_or("Configure VPS management first")?;
        if config
            .vps_egress
            .selected
            .as_ref()
            .is_some_and(|e| e.id == id)
        {
            select(&app, &proxy, "direct")?;
        }
        let remote = egress::request(management, json!({"action":"delete", "id":id}))?;
        remote_state(&app, remote)
    })
    .await
    .map_err(|_| "Cloudflare deletion task failed".to_string())?
}

#[tauri::command]
pub async fn rename_cloudflare_egress(
    state: State<'_, Arc<AppState>>,
    id: String,
    name: String,
) -> Result<EgressState, String> {
    remote_change(
        state.inner().clone(),
        json!({"action":"rename", "id":id, "name":name}),
    )
    .await
}

#[tauri::command]
pub async fn bind_magpie_egress(
    state: State<'_, Arc<AppState>>,
    provider: String,
    account_ref: String,
    selection: String,
    revision: String,
) -> Result<EgressState, String> {
    remote_change(
        state.inner().clone(),
        json!({"action":"magpie_bind", "provider":provider,
        "ref":account_ref, "selection":selection, "revision":revision}),
    )
    .await
}

async fn remote_change(
    app: Arc<AppState>,
    payload: serde_json::Value,
) -> Result<EgressState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = egress::MANAGEMENT_LOCK
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "Egress manager busy")?;
        let config = snapshot(&app)?;
        let management = config
            .vps_egress
            .management
            .as_ref()
            .ok_or("Configure VPS management first")?;
        let remote = egress::request(management, payload)?;
        remote_state(&app, remote)
    })
    .await
    .map_err(|_| "VPS configuration task failed".to_string())?
}

fn remote_state(app: &AppState, remote: egress::RemoteReply) -> Result<EgressState, String> {
    let mut result = egress::state(&snapshot(app)?, false);
    result.installed = remote.installed;
    result.exits = remote.exits;
    result.magpie = remote.magpie;
    Ok(result)
}
