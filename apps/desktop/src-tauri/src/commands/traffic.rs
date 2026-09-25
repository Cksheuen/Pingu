use serde::Serialize;
use tauri::State;

use std::sync::Arc;

use crate::commands::proxy::ProxyState;

#[derive(Debug, Clone, Serialize)]
pub struct TrafficSnapshot {
    pub upload_speed: u64,
    pub download_speed: u64,
    pub upload_total: u64,
    pub download_total: u64,
}

/// Latest cached sample from the lifecycle-owned background `/traffic`
/// subscription. This command performs no network I/O: speeds/totals are
/// published by at most one reader per runtime generation and reset to zero on
/// disconnect or generation switch, so stale speeds can never survive a
/// switch.
#[tauri::command]
pub fn get_traffic(proxy_state: State<Arc<ProxyState>>) -> Result<TrafficSnapshot, String> {
    let sample = proxy_state.traffic_snapshot();
    Ok(TrafficSnapshot {
        upload_speed: sample.upload_speed,
        download_speed: sample.download_speed,
        upload_total: sample.upload_total,
        download_total: sample.download_total,
    })
}

#[tauri::command]
pub fn get_clash_api_port(proxy_state: State<Arc<ProxyState>>) -> Option<u16> {
    proxy_state
        .runtime_snapshot()
        .ok()
        .and_then(|runtime| runtime.clash_api_port)
}
