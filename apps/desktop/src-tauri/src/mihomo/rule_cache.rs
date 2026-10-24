//! Local copies of the GeoSite/GeoIP rule sets Pingu generates.
//!
//! Every runtime starts in a fresh directory and Mihomo holds traffic until
//! its rule providers finish their first load, so the remote rule sets were
//! downloaded through the proxy on every connect (about 2 s on a chained
//! route). Cached copies are served from a loopback listener instead: both the
//! user core and the root TUN core can reach it, and Mihomo never binds
//! loopback dials to the physical interface. The cache itself is refreshed in
//! the background through the verified local proxy.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

const MAX_BYTES: u64 = 16 * 1024 * 1024;
const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
/// Every `.mrs` rule set is a zstd stream; anything else (a captive portal
/// page, an error body) must never replace a working copy.
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xB5, 0x2F, 0xFD];

static SERVER: OnceLock<Option<u16>> = OnceLock::new();
static SOURCES: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());
static REFRESHING: AtomicBool = AtomicBool::new(false);

/// Rule-provider entry for `key`: the loopback copy when one is cached,
/// otherwise the remote rule set through the selected proxy.
pub fn provider(key: &str, url: &str, behavior: &str) -> Value {
    if let Ok(mut sources) = SOURCES.lock() {
        sources.insert(key.to_string(), url.to_string());
    }
    let dir = cache_dir();
    let port = dir.join(file_name(key)).is_file().then(|| server_port(&dir)).flatten();
    provider_entry(key, url, behavior, port)
}

fn provider_entry(key: &str, url: &str, behavior: &str, loopback: Option<u16>) -> Value {
    let path = format!("providers/{key}.mrs");
    match loopback {
        Some(port) => json!({"type":"http","behavior":behavior,"format":"mrs","url":format!("http://127.0.0.1:{port}/{}", file_name(key)),"path":path,"proxy":"DIRECT","interval":3600}),
        None => json!({"type":"http","behavior":behavior,"format":"mrs","url":url,"path":path,"proxy":"Pingu Proxy","interval":86400}),
    }
}

/// Download missing or day-old rule sets through the verified listener.
/// Runs once at a time, off the lifecycle lock; failures keep the old copy.
pub fn refresh_stale(listen_port: u16) {
    // Lifecycle unit tests run fake listeners; never reach the network there.
    if cfg!(test) {
        return;
    }
    let sources = match SOURCES.lock() {
        Ok(sources) if !sources.is_empty() => sources.clone(),
        _ => return,
    };
    if REFRESHING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let dir = cache_dir();
        if std::fs::create_dir_all(&dir).is_ok() {
            let proxy = ureq::Proxy::new(format!("http://127.0.0.1:{listen_port}"));
            if let Ok(proxy) = proxy {
                let agent = ureq::AgentBuilder::new()
                    .try_proxy_from_env(false)
                    .proxy(proxy)
                    .timeout(Duration::from_secs(30))
                    .build();
                refresh_in(&dir, &sources, SystemTime::now(), |url| download(&agent, url));
            }
        }
        REFRESHING.store(false, Ordering::SeqCst);
    });
}

fn refresh_in(
    dir: &Path,
    sources: &BTreeMap<String, String>,
    now: SystemTime,
    fetch: impl Fn(&str) -> Result<Vec<u8>, String>,
) {
    for (key, url) in sources {
        let path = dir.join(file_name(key));
        let fresh = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .is_ok_and(|modified| now.duration_since(modified).unwrap_or_default() < STALE_AFTER);
        if fresh {
            continue;
        }
        if let Ok(bytes) = fetch(url) {
            if bytes.starts_with(&ZSTD_MAGIC) {
                let _ = super::private_write(&path, &bytes);
            }
        }
    }
}

fn download(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>, String> {
    let response = agent.get(url).call().map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Rule set exceeds its size limit".into());
    }
    Ok(bytes)
}

fn file_name(key: &str) -> String {
    format!("{key}.mrs")
}

fn cache_dir() -> PathBuf {
    #[cfg(not(test))]
    let dir = crate::proxy_runtime::app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("sing-proxy"))
        .join("mihomo")
        .join("rule-cache");
    // Unit tests drive the helpers with explicit directories; generated test
    // configs must keep using the remote rule sets.
    #[cfg(test)]
    let dir = std::env::temp_dir().join(format!("pingu-rule-cache-unused-{}", std::process::id()));
    dir
}

fn server_port(dir: &Path) -> Option<u16> {
    *SERVER.get_or_init(|| serve(dir.to_path_buf()).ok())
}

fn serve(dir: PathBuf) -> std::io::Result<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = respond(stream, &dir);
        }
    });
    Ok(port)
}

fn respond(mut stream: TcpStream, dir: &Path) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let mut request = Vec::new();
    let mut chunk = [0u8; 1024];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") && request.len() < 8192 {
        let read = stream.read(&mut chunk)?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
    }
    let line = String::from_utf8_lossy(&request);
    let body = line
        .strip_prefix("GET /")
        .and_then(|rest| rest.split(' ').next())
        .filter(|name| cached_name(name))
        .and_then(|name| std::fs::read(dir.join(name)).ok());
    match body {
        Some(body) => {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )?;
            stream.write_all(&body)
        }
        None => stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
    }
}

/// Only names this module writes are served; nothing can escape the cache.
fn cached_name(name: &str) -> bool {
    name.strip_suffix(".mrs")
        .and_then(|key| key.strip_prefix("pingu-"))
        .is_some_and(|rest| {
            !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '!')
        })
}

#[cfg(test)]
mod tests;
