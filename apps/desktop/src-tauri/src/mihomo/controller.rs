//! Authenticated app-owned loopback controller. Credentials never cross IPC.
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;
static SECRET: OnceLock<String> = OnceLock::new();
pub fn secret() -> &'static str {
    SECRET.get_or_init(|| format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4()))
}
pub fn authorize(request: ureq::Request) -> ureq::Request {
    request.set("Authorization", &format!("Bearer {}", secret()))
}
pub fn request(port: u16, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    request_with_timeout(port, method, path, body, Duration::from_secs(12))
}
fn request_with_timeout(
    port: u16,
    method: &str,
    path: &str,
    body: Option<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(timeout)
        .build();
    let request = authorize(agent.request(method, &format!("http://127.0.0.1:{port}{path}")));
    let response = match body {
        Some(body) => request.send_json(body),
        None => request.call(),
    }
    .map_err(|e| match e {
        ureq::Error::Status(status, _) => format!("Mihomo controller returned HTTP {status}."),
        _ => "Mihomo controller unavailable.".into(),
    })?;
    if response.status() == 204 {
        return Ok(Value::Null);
    }
    response
        .into_json()
        .map_err(|_| "Invalid Mihomo controller response.".into())
}
/// No force flag: Mihomo preserves the mixed listener and established streams.
pub fn reload(port: u16, payload: &str) -> Result<(), String> {
    request_with_timeout(
        port,
        "PUT",
        "/configs",
        Some(json!({"payload": payload})),
        Duration::from_secs(90),
    )?;
    Ok(())
}

fn segment(name: &str) -> String {
    percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC)
        .to_string()
        .replace("%2D", "-")
        .replace("%5F", "_")
        .replace("%2E", ".")
        .replace("%7E", "~")
}
#[derive(Debug, Serialize)]
pub struct DelayHistory {
    pub time: String,
    pub delay: u64,
}
#[derive(Debug, Serialize)]
pub struct StrategyGroup {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub now: Option<String>,
    pub all: Vec<String>,
    pub alive: bool,
    pub history: Vec<DelayHistory>,
}
pub fn groups(port: u16) -> Result<Vec<StrategyGroup>, String> {
    let body = request(port, "GET", "/proxies", None)?;
    let map = body["proxies"].as_object().ok_or("Missing proxy groups.")?;
    let mut groups = map
        .iter()
        .filter_map(|(name, p)| {
            let all = p["all"].as_array()?;
            Some(StrategyGroup {
                name: name.clone(),
                kind: text(p, "type"),
                now: p["now"].as_str().map(str::to_string),
                all: all
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect(),
                alive: p["alive"].as_bool().unwrap_or(true),
                history: p["history"]
                    .as_array()
                    .map(|h| {
                        h.iter()
                            .map(|v| DelayHistory {
                                time: text(v, "time"),
                                delay: v["delay"].as_u64().unwrap_or(0),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect::<Vec<_>>();
    groups.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(groups)
}
pub fn select(port: u16, group: &str, name: &str) -> Result<(), String> {
    request(
        port,
        "PUT",
        &format!("/proxies/{}", segment(group)),
        Some(json!({"name":name})),
    )?;
    Ok(())
}
#[derive(Debug, Serialize)]
pub struct DelayResult {
    pub delay: u64,
}
pub fn delay(port: u16, name: &str) -> Result<DelayResult, String> {
    let body = request(
        port,
        "GET",
        &format!(
            "/proxies/{}/delay?timeout=8000&url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204",
            segment(name)
        ),
        None,
    )?;
    Ok(DelayResult {
        delay: body["delay"].as_u64().ok_or("Delay test failed.")?,
    })
}
#[derive(Debug, Serialize)]
pub struct Connection {
    pub id: String,
    pub host: String,
    pub destination_ip: String,
    pub destination_port: String,
    pub source_ip: String,
    pub network: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub process: String,
    pub chains: Vec<String>,
    pub rule: String,
    pub rule_payload: String,
    pub upload: u64,
    pub download: u64,
    pub start: String,
}
#[derive(Debug, Serialize)]
pub struct Connections {
    pub upload_total: u64,
    pub download_total: u64,
    pub connections: Vec<Connection>,
}
fn text(v: &Value, key: &str) -> String {
    v[key]
        .as_str()
        .map(str::to_string)
        .or_else(|| v[key].as_u64().map(|v| v.to_string()))
        .unwrap_or_default()
}
pub fn connections(port: u16) -> Result<Connections, String> {
    parse_connections(request(port, "GET", "/connections", None)?)
}
pub fn parse_connections(body: Value) -> Result<Connections, String> {
    let empty = Vec::new();
    let rows = match body.get("connections") {
        Some(Value::Null) => &empty,
        Some(Value::Array(rows)) => rows,
        _ => return Err("Missing connections.".into()),
    };
    Ok(Connections {
        upload_total: body["uploadTotal"].as_u64().unwrap_or(0),
        download_total: body["downloadTotal"].as_u64().unwrap_or(0),
        connections: rows
            .iter()
            .map(|v| {
                let m = &v["metadata"];
                Connection {
                    id: text(v, "id"),
                    host: text(m, "host"),
                    destination_ip: text(m, "destinationIP"),
                    destination_port: text(m, "destinationPort"),
                    source_ip: text(m, "sourceIP"),
                    network: text(m, "network"),
                    kind: text(m, "type"),
                    process: text(m, "process"),
                    chains: v["chains"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default(),
                    rule: text(v, "rule"),
                    rule_payload: text(v, "rulePayload"),
                    upload: v["upload"].as_u64().unwrap_or(0),
                    download: v["download"].as_u64().unwrap_or(0),
                    start: text(v, "start"),
                }
            })
            .collect(),
    })
}
pub fn close(port: u16, id: Option<&str>) -> Result<(), String> {
    let path = id
        .map(|id| format!("/connections/{}", segment(id)))
        .unwrap_or_else(|| "/connections".into());
    request(port, "DELETE", &path, None)?;
    Ok(())
}
#[cfg(test)]
mod tests;
