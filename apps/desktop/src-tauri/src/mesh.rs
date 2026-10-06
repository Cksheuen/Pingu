//! App-owned userspace mesh. Secrets stay in a private stdin pipe and runtime
//! config; host exposure is always a local choice, never enrollment data.
use crate::commands::{config::AppState, proxy::ProxyState};
use crate::lifecycle::{apply_runtime_config_change, mutate_config_only};
use crate::storage::app_config::AppConfig;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::Duration;
use tauri::State;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct MeshSettings {
    pub enabled: bool,
    pub allow_inbound: bool,
    pub exposed_ports: Vec<u16>,
    pub subscription_id: String,
    pub ipv4_cidr: String,
}
impl Default for MeshSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            allow_inbound: false,
            exposed_ports: vec![22, 3000, 5173],
            subscription_id: String::new(),
            ipv4_cidr: String::new(),
        }
    }
}
#[derive(Clone)]
pub struct MeshRoute {
    pub port: u16,
    pub token: String,
}
impl std::fmt::Debug for MeshRoute {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MeshRoute")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}
struct Process {
    child: Child,
    _stdin: ChildStdin,
    api_port: u16,
    route: MeshRoute,
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[derive(Default)]
struct Runtime {
    process: Option<Process>,
    error: Option<String>,
}
#[derive(Default)]
pub struct MeshState {
    runtime: Mutex<Runtime>,
    shutting_down: AtomicBool,
}
impl MeshState {
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        if let Ok(mut rt) = self.runtime.lock() {
            rt.process.take();
        }
    }
}
#[derive(Deserialize)]
struct Enrollment {
    control_url: String,
    auth_key: String,
    hostname: String,
    ipv4_cidr: String,
}
#[derive(Deserialize)]
struct Ready {
    protocol: u8,
    api_port: u16,
    socks_port: u16,
}

fn private_dir(path: &PathBuf) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "Cannot create private mesh state.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot protect mesh state.")?;
    }
    Ok(())
}
fn binary() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("PINGU_MESH_BIN") {
        return Ok(value.into());
    }
    let exe = std::env::current_exe().map_err(|_| "Cannot locate Pingu.")?;
    let name = if cfg!(windows) {
        "pingu-mesh.exe"
    } else {
        "pingu-mesh"
    };
    let candidate = exe.parent().ok_or("Cannot locate Pingu.")?.join(name);
    if !candidate.is_file() {
        return Err("This Pingu build does not include the mesh service.".into());
    }
    Ok(candidate)
}
fn check_ports(ports: &[u16]) -> Result<(), String> {
    if ports.len() > 32
        || ports
            .iter()
            .any(|p| *p == 0 || (2080..=2099).contains(p) || (9090..=9109).contains(p))
    {
        return Err(
            "Choose up to 32 TCP ports; Pingu proxy/control ports cannot be exposed.".into(),
        );
    }
    Ok(())
}
fn valid_cidr(cidr: &str) -> bool {
    let Some((ip, bits)) = cidr.split_once('/') else {
        return false;
    };
    let Ok(ip) = ip.parse::<std::net::Ipv4Addr>() else {
        return false;
    };
    let bytes = ip.octets();
    bits == "24" && bytes[0] == 100 && (64..=127).contains(&bytes[1]) && bytes[3] == 0
}
fn enrollment(config: &AppConfig, id: &str) -> Result<Enrollment, String> {
    let sub = config
        .subscriptions
        .iter()
        .find(|s| s.id == id && s.enabled)
        .ok_or("Select an enabled Pingu cloud subscription.")?;
    let mut url = crate::mihomo::profiles::validate_https_url(&sub.input, "Mesh subscription")?;
    let token = url
        .path()
        .strip_prefix("/s/")
        .ok_or("This subscription does not provide Pingu mesh enrollment.")?;
    if token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("This subscription does not provide Pingu mesh enrollment.".into());
    }
    url.set_path(&format!("{}/mesh", url.path()));
    url.set_query(None);
    url.set_fragment(None);
    let response = crate::mihomo::profiles::subscription_fetch_agent(Duration::from_secs(20))
        .post(url.as_str())
        .send_json(json!({}))
        .map_err(|_| {
            "Mesh enrollment failed. Check this device's mesh permission in the cloud manager."
        })?;
    let mut body = String::new();
    response
        .into_reader()
        .take(16385)
        .read_to_string(&mut body)
        .map_err(|_| "Invalid enrollment response.")?;
    if body.len() > 16384 {
        return Err("Enrollment response too large.".into());
    }
    let result: Enrollment =
        serde_json::from_str(&body).map_err(|_| "Invalid enrollment response.")?;
    let control = crate::mihomo::profiles::validate_https_url(&result.control_url, "Mesh control")?;
    if !matches!(control.path(), "" | "/")
        || control.query().is_some()
        || control.fragment().is_some()
        || result.hostname.len() > 63
        || result.hostname.is_empty()
        || !result
            .hostname
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || result.auth_key.is_empty()
        || result.auth_key.len() > 2048
        || !valid_cidr(&result.ipv4_cidr)
    {
        return Err("Invalid mesh enrollment parameters.".into());
    }
    Ok(result)
}
fn launch(
    settings: &MeshSettings,
    enrollment: &Enrollment,
    blocked: Vec<u16>,
) -> Result<Process, String> {
    let root = dirs::config_dir()
        .ok_or("Cannot locate app data.")?
        .join("sing-proxy")
        .join("mesh");
    private_dir(&root)?;
    // A source id is app-owned. The nested directory is a hash of its bytes,
    // not a server-provided path; separate subscriptions never clone identity.
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    settings.subscription_id.hash(&mut hasher);
    enrollment.control_url.hash(&mut hasher);
    let state_dir = root.join(format!("{:016x}", hasher.finish()));
    private_dir(&state_dir)?;
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut child = Command::new(binary()?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Cannot launch the bundled mesh service.")?;
    let stdin = child.stdin.take().ok_or("Mesh stdin unavailable.")?;
    let stdout = child.stdout.take().ok_or("Mesh stdout unavailable.")?;
    let mut process = Process {
        child,
        _stdin: stdin,
        api_port: 0,
        route: MeshRoute {
            port: 0,
            token: token.clone(),
        },
    };
    serde_json::to_writer(&mut process._stdin, &json!({
        "state_dir": state_dir, "hostname": enrollment.hostname, "control_url": enrollment.control_url,
        "auth_key": enrollment.auth_key, "api_token": token, "allow_inbound": settings.allow_inbound,
        "exposed_ports": settings.exposed_ports, "blocked_ports": blocked,
    })).map_err(|_| "Cannot configure mesh service.")?;
    process
        ._stdin
        .write_all(b"\n")
        .map_err(|_| "Cannot start mesh service.")?;
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let result = BufReader::new(stdout)
            .take(4096)
            .read_line(&mut line)
            .map(|_| line);
        let _ = send.send(result);
    });
    let line = receive
        .recv_timeout(Duration::from_secs(20))
        .map_err(|_| "Mesh startup timed out.")?
        .map_err(|_| "Mesh service failed to start.")?;
    let ready: Ready = serde_json::from_str(&line).map_err(|_| "Mesh service failed to start.")?;
    if ready.protocol != 1
        || ready.api_port == 0
        || ready.socks_port == 0
        || ready.api_port == ready.socks_port
    {
        return Err("Invalid mesh service handshake.".into());
    }
    process.api_port = ready.api_port;
    process.route.port = ready.socks_port;
    Ok(process)
}
fn rpc(process: &Process, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .redirects(0)
        .try_proxy_from_env(false)
        .build();
    let request = agent
        .request(
            method,
            &format!("http://127.0.0.1:{}{path}", process.api_port),
        )
        .set("Authorization", &format!("Bearer {}", process.route.token));
    let response = match body {
        Some(body) => request.send_json(body),
        None => request.call(),
    }
    .map_err(|_| "The mesh service did not respond.")?;
    response
        .into_json()
        .map_err(|_| "Invalid mesh service response.".into())
}
fn publish(
    app: &AppState,
    proxy: &ProxyState,
    settings: MeshSettings,
    route: Option<MeshRoute>,
) -> Result<(), String> {
    apply_runtime_config_change(app, proxy, move |cfg| {
        cfg.mesh = settings;
        cfg.mesh_runtime = route;
        Ok(())
    })
    .map_err(|e| e.message)
}
pub fn start_saved(app: &AppState, proxy: &ProxyState, mesh: &MeshState) -> Result<(), String> {
    let settings = app
        .config
        .lock()
        .map_err(|_| "Configuration unavailable.")?
        .mesh
        .clone();
    if settings.enabled {
        configure(app, proxy, mesh, settings, true)?;
    }
    Ok(())
}
pub fn configure(
    app: &AppState,
    proxy: &ProxyState,
    mesh: &MeshState,
    mut settings: MeshSettings,
    reconnect: bool,
) -> Result<(), String> {
    let mut rt = mesh.runtime.lock().map_err(|_| "Mesh unavailable.")?;
    if mesh.shutting_down.load(Ordering::SeqCst) {
        return Err("Pingu is shutting down.".into());
    }
    let cfg = app
        .config
        .lock()
        .map_err(|_| "Configuration unavailable.")?
        .clone();
    // Closing access must not be blocked by an unfinished/invalid port edit.
    if (!settings.enabled || !settings.allow_inbound) && check_ports(&settings.exposed_ports).is_err() {
        settings.exposed_ports = Vec::new();
    }
    if !settings.enabled {
        rt.process.take();
        rt.error = None;
        // Preserve the last owned prefix so disabling can never leak its traffic
        // into the public proxy or a broad local DIRECT rule.
        settings.ipv4_cidr = cfg.mesh.ipv4_cidr.clone();
        if let Err(error) = publish(app, proxy, settings.clone(), None) {
            let _ = mutate_config_only(app, |c| {
                c.mesh = settings;
                c.mesh_runtime = None;
                Ok(())
            });
            rt.error = Some(error.clone());
            return Err(error);
        }
        return Ok(());
    }
    check_ports(&settings.exposed_ports)?;
    if cfg.mesh.subscription_id == settings.subscription_id {
        if let Some(process) = rt.process.as_mut() {
            if process
                .child
                .try_wait()
                .map_err(|_| "Mesh process unavailable.")?
                .is_none()
            {
                settings.ipv4_cidr = cfg.mesh.ipv4_cidr.clone();
                let changed = rpc(
                    process,
                    "POST",
                    "/exposure",
                    Some(json!({"enabled":settings.allow_inbound,"ports":settings.exposed_ports})),
                );
                if let Err(error) = changed {
                    rt.process.take();
                    if !settings.allow_inbound {
                        // Kill is the fail-closed fallback when IPC is unavailable;
                        // remember the user's refusal before any future reconnect.
                        let _ = mutate_config_only(app, |c| {
                            c.mesh.allow_inbound = false;
                            c.mesh_runtime = None;
                            Ok(())
                        });
                    }
                    rt.error = Some(error.clone());
                    return Err(error);
                }
                if let Err(error) = mutate_config_only(app, |c| {
                    c.mesh = settings;
                    Ok(())
                })
                .map_err(|e| e.message)
                {
                    rt.process.take();
                    rt.error = Some(error.clone());
                    return Err(error);
                }
                rt.error = None;
                return Ok(());
            }
        }
    }
    // Any previous identity is stopped before a new source may grant exposure.
    rt.process.take();
    if !reconnect {
        settings.ipv4_cidr = cfg.mesh.ipv4_cidr;
        // Preference edits remain available while enrollment/control is offline.
        // Only explicit Connect or app startup may start a new identity process.
        return publish(app, proxy, settings, None);
    }
    let result: Result<Process, String> = (|| {
        let grant = enrollment(&cfg, &settings.subscription_id)?;
        settings.ipv4_cidr = grant.ipv4_cidr.clone();
        let snap = proxy.runtime_snapshot()?;
        let mut blocked: Vec<u16> = (2080..=2099).chain(9090..=9109).collect();
        blocked.extend(snap.listen_port);
        blocked.extend(snap.clash_api_port);
        let process = launch(&settings, &grant, blocked)?;
        publish(app, proxy, settings, Some(process.route.clone()))?;
        Ok(process)
    })();
    match result {
        Ok(process) => {
            rt.process = Some(process);
            rt.error = None;
            Ok(())
        }
        Err(error) => {
            rt.error = Some(error.clone());
            Err(error)
        }
    }
}
fn snapshot(app: &AppState, proxy: &ProxyState, mesh: &MeshState) -> Result<Value, String> {
    let mut rt = mesh.runtime.lock().map_err(|_| "Mesh unavailable.")?;
    let cfg = app
        .config
        .lock()
        .map_err(|_| "Configuration unavailable.")?
        .clone();
    let mut status = Value::Null;
    let mut ended = false;
    if let Some(process) = rt.process.as_mut() {
        if process
            .child
            .try_wait()
            .map_err(|_| "Mesh process unavailable.")?
            .is_some()
        {
            ended = true;
        } else {
            match rpc(process, "GET", "/status", None) {
                Ok(value) => status = value,
                Err(error) => {
                    rt.error = Some(error);
                    ended = true;
                }
            }
        }
    }
    if ended {
        rt.process.take();
        let _ = publish(app, proxy, cfg.mesh.clone(), None);
        if rt.error.is_none() {
            rt.error = Some("Mesh service stopped. Reconnect to retry.".into());
        }
    }
    Ok(
        json!({"settings":cfg.mesh,"runtime":status,"error":rt.error,
        "proxy_port":if proxy.is_running() { Some(proxy.active_listen_port()) } else { None }}),
    )
}
#[tauri::command]
pub async fn get_mesh_status(
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
    mesh: State<'_, Arc<MeshState>>,
) -> Result<Value, String> {
    let (a, p, m) = (
        state.inner().clone(),
        proxy_state.inner().clone(),
        mesh.inner().clone(),
    );
    tauri::async_runtime::spawn_blocking(move || snapshot(&a, &p, &m))
        .await
        .map_err(|_| "Mesh status task failed.".to_string())?
}
#[tauri::command]
pub async fn configure_mesh(
    settings: MeshSettings,
    reconnect: Option<bool>,
    state: State<'_, Arc<AppState>>,
    proxy_state: State<'_, Arc<ProxyState>>,
    mesh: State<'_, Arc<MeshState>>,
) -> Result<(), String> {
    let (a, p, m) = (
        state.inner().clone(),
        proxy_state.inner().clone(),
        mesh.inner().clone(),
    );
    tauri::async_runtime::spawn_blocking(move || configure(&a, &p, &m, settings, reconnect.unwrap_or(false)))
        .await
        .map_err(|_| "Mesh configuration task failed.".to_string())?
}
#[tauri::command]
pub async fn ping_mesh_peer(ip: String, mesh: State<'_, Arc<MeshState>>) -> Result<Value, String> {
    let m = mesh.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let rt = m.runtime.lock().map_err(|_| "Mesh unavailable.")?;
        rpc(
            rt.process.as_ref().ok_or("Mesh is disconnected.")?,
            "POST",
            "/ping",
            Some(json!({"ip":ip})),
        )
    })
    .await
    .map_err(|_| "Mesh ping task failed.".to_string())?
}
/// The narrow owned prefix wins over local/imported rules. A stopped service
/// uses REJECT; a stale live route still requires its unguessable SOCKS secret.
pub fn apply(config: &AppConfig, value: &mut Value) -> Result<(), String> {
    if config.mesh.ipv4_cidr.is_empty() {
        return Ok(());
    }
    if !valid_cidr(&config.mesh.ipv4_cidr) {
        return Err("Invalid saved mesh prefix.".into());
    }
    let target = if config.mesh.enabled {
        if let Some(route) = &config.mesh_runtime {
            value["proxies"]
                .as_array_mut()
                .ok_or("Missing proxies.")?
                .push(json!({
                    "name":"Pingu Mesh","type":"socks5","server":"127.0.0.1","port":route.port,
                    "username":"pingu","password":route.token,"udp":false
                }));
            "Pingu Mesh"
        } else {
            "REJECT"
        }
    } else {
        "REJECT"
    };
    value["rules"]
        .as_array_mut()
        .ok_or("Missing rules.")?
        .insert(
            0,
            json!(format!(
                "IP-CIDR,{},{target},no-resolve",
                config.mesh.ipv4_cidr
            )),
        );
    Ok(())
}
#[cfg(test)]
mod tests;
