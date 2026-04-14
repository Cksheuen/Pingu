use serde::Serialize;
use tauri::State;

use crate::commands::proxy::ProxyState;

#[derive(Debug, Clone, Serialize)]
pub struct TrafficSnapshot {
    pub upload_speed: u64,
    pub download_speed: u64,
    pub upload_total: u64,
    pub download_total: u64,
}

#[tauri::command]
pub fn get_traffic(proxy_state: State<ProxyState>) -> Result<TrafficSnapshot, String> {
    let port = match proxy_state
        .clash_api_port
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
    {
        Some(port) => port,
        None => {
            return Ok(TrafficSnapshot {
                upload_speed: 0,
                download_speed: 0,
                upload_total: 0,
                download_total: 0,
            });
        }
    };

    let url = format!("http://127.0.0.1:{}/traffic", port);
    let body: serde_json::Value = ureq::get(&url)
        .timeout(std::time::Duration::from_millis(500))
        .call()
        .map_err(|e| format!("Failed to query clash API: {}", e))?
        .into_json()
        .map_err(|e| format!("Failed to parse traffic response: {}", e))?;

    let up = body["up"].as_u64().unwrap_or(0);
    let down = body["down"].as_u64().unwrap_or(0);

    Ok(TrafficSnapshot {
        upload_speed: up,
        download_speed: down,
        upload_total: 0,
        download_total: 0,
    })
}

#[tauri::command]
pub fn get_clash_api_port(proxy_state: State<ProxyState>) -> Option<u16> {
    proxy_state
        .clash_api_port
        .lock()
        .ok()
        .and_then(|guard| *guard)
}
