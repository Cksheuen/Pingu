use std::collections::HashMap;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::commands::config::AppState;
use crate::mihomo::process::MihomoProcess;
use crate::proxy_runtime::NetworkContentCheck;
use crate::proxy_runtime::{
    find_available_port, prepare_runtime_generation_with_port, verify_proxy_content,
    PreparedRuntime,
};
use crate::storage::app_config::AppConfig;
use crate::system::{MacOsSystemProxyControl, SystemProxyControl};
use crate::traffic_monitor::{TrafficMonitor, TrafficSample};

#[derive(Debug, Clone, Default)]
pub struct RuntimeSnapshot {
    pub connected_at: Option<Instant>,
    pub running_node_id: Option<String>,
    pub running_group_id: Option<String>,
    pub clash_api_port: Option<u16>,
    pub listen_port: Option<u16>,
    pub config_path: Option<PathBuf>,
    /// Explicit ownership token for the unique generated directory backing the
    /// active process. Never derived from an arbitrary config path.
    pub owned_runtime_dir: Option<PathBuf>,
    /// Random app-issued identity for routing connection operations without
    /// accepting controller ports from IPC.
    pub controller_scope: Option<String>,
    pub generation: u64,
}

struct DrainingCore {
    process: Arc<MihomoProcess>,
    clash_api_port: Option<u16>,
    controller_scope: Option<String>,
    owned_runtime_dir: Option<PathBuf>,
}

#[derive(Clone)]
struct ControllerTarget {
    scope: String,
    port: u16,
}

#[derive(Clone, PartialEq, Eq)]
struct ConnectionRoute {
    scope: String,
    connection_id: String,
}

pub struct ProxyState {
    process: Mutex<Arc<MihomoProcess>>,
    draining_cores: Arc<Mutex<Vec<Arc<DrainingCore>>>>,
    connection_routes: Mutex<HashMap<String, ConnectionRoute>>,
    /// Ownership during the narrow start/verify window before a runtime is
    /// published. Retained when process exit cannot be confirmed.
    pending_runtime_dir: Mutex<Option<PathBuf>>,
    pub operation_lock: Arc<Mutex<()>>,
    pub runtime: Mutex<RuntimeSnapshot>,
    pub system_proxy: Arc<dyn SystemProxyControl>,
    pub listen_port: u16,
    traffic: TrafficMonitor,
    /// Latched once Quit/startup-exit shutdown begins. A lifecycle operation
    /// already queued on `operation_lock` must fail fast after acquiring the
    /// lock instead of starting a new mihomo while the app exits.
    shutdown_intent: AtomicBool,
    owns_system_proxy: AtomicBool,
    /// One-shot handoff of the successful connect-time content checks for the
    /// immediately following preflight request. At most 3 s fresh.
    preflight_handoff: Mutex<Option<PreflightHandoff>>,
}

#[derive(Debug, Clone)]
pub struct PreflightHandoff {
    pub generation: u64,
    pub listen_port: u16,
    pub node_id: String,
    pub group_id: String,
    pub recorded_at: Instant,
    pub checks: Vec<NetworkContentCheck>,
}

/// Max freshness for the one-shot connect-to-preflight handoff.
pub const PREFLIGHT_HANDOFF_TTL: Duration = Duration::from_secs(3);

impl ProxyState {
    pub fn production() -> Self {
        Self::new(
            MihomoProcess::new(),
            Arc::new(MacOsSystemProxyControl),
            2080,
        )
    }

    pub fn production_with_lock(operation_lock: Arc<Mutex<()>>) -> Self {
        Self {
            process: Mutex::new(Arc::new(MihomoProcess::new())),
            draining_cores: Arc::new(Mutex::new(Vec::new())),
            connection_routes: Mutex::new(HashMap::new()),
            pending_runtime_dir: Mutex::new(None),
            operation_lock,
            runtime: Mutex::new(RuntimeSnapshot::default()),
            system_proxy: Arc::new(MacOsSystemProxyControl),
            listen_port: 2080,
            traffic: TrafficMonitor::new(),
            shutdown_intent: AtomicBool::new(false),
            owns_system_proxy: AtomicBool::new(false),
            preflight_handoff: Mutex::new(None),
        }
    }

    pub fn new(
        process: MihomoProcess,
        system_proxy: Arc<dyn SystemProxyControl>,
        listen_port: u16,
    ) -> Self {
        Self {
            process: Mutex::new(Arc::new(process)),
            draining_cores: Arc::new(Mutex::new(Vec::new())),
            connection_routes: Mutex::new(HashMap::new()),
            pending_runtime_dir: Mutex::new(None),
            operation_lock: Arc::new(Mutex::new(())),
            runtime: Mutex::new(RuntimeSnapshot::default()),
            system_proxy,
            listen_port,
            traffic: TrafficMonitor::new(),
            shutdown_intent: AtomicBool::new(false),
            owns_system_proxy: AtomicBool::new(false),
            preflight_handoff: Mutex::new(None),
        }
    }

    pub fn new_with_lock(
        process: MihomoProcess,
        system_proxy: Arc<dyn SystemProxyControl>,
        listen_port: u16,
        operation_lock: Arc<Mutex<()>>,
    ) -> Self {
        Self {
            process: Mutex::new(Arc::new(process)),
            draining_cores: Arc::new(Mutex::new(Vec::new())),
            connection_routes: Mutex::new(HashMap::new()),
            pending_runtime_dir: Mutex::new(None),
            operation_lock,
            runtime: Mutex::new(RuntimeSnapshot::default()),
            system_proxy,
            listen_port,
            traffic: TrafficMonitor::new(),
            shutdown_intent: AtomicBool::new(false),
            owns_system_proxy: AtomicBool::new(false),
            preflight_handoff: Mutex::new(None),
        }
    }

    fn clear_owned_system_proxy(&self) -> Result<(), String> {
        if !self.owns_system_proxy.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.system_proxy.clear()?;
        self.owns_system_proxy.store(false, Ordering::SeqCst);
        Ok(())
    }

    /// True once Quit/startup-exit shutdown has been requested.
    pub fn is_shutting_down(&self) -> bool {
        self.shutdown_intent.load(Ordering::SeqCst)
    }

    fn mark_shutting_down(&self) {
        self.shutdown_intent.store(true, Ordering::SeqCst);
    }

    /// Latch shutdown intent BEFORE waiting for the operation lock, so an
    /// operation queued ahead of shutdown cannot win and start a new runtime.
    fn guard_after_lock(&self) -> Result<(), String> {
        if self.is_shutting_down() {
            Err("Pingu is shutting down".to_string())
        } else {
            Ok(())
        }
    }

    /// Consume the one-shot connect handoff if it exactly matches the runtime
    /// the preflight is about to describe and is still fresh.
    pub fn take_preflight_handoff(
        &self,
        generation: u64,
        listen_port: u16,
        node_id: &str,
        group_id: &str,
    ) -> Option<Vec<NetworkContentCheck>> {
        let mut handoff = self.preflight_handoff.lock().ok()?;
        let candidate = handoff.take()?;
        let fresh = candidate.recorded_at.elapsed() <= PREFLIGHT_HANDOFF_TTL;
        let matches = candidate.generation == generation
            && candidate.listen_port == listen_port
            && candidate.node_id == node_id
            && candidate.group_id == group_id;
        if fresh && matches {
            Some(candidate.checks)
        } else {
            None
        }
    }

    fn store_preflight_handoff(
        &self,
        runtime: &RuntimeLaunch,
        generation: u64,
        checks: Vec<NetworkContentCheck>,
    ) {
        if let Ok(mut handoff) = self.preflight_handoff.lock() {
            *handoff = Some(PreflightHandoff {
                generation,
                listen_port: runtime.listen_port,
                node_id: runtime.node_id.clone(),
                group_id: runtime.group_id.clone(),
                recorded_at: Instant::now(),
                checks,
            });
        }
    }

    fn clear_preflight_handoff(&self) {
        if let Ok(mut handoff) = self.preflight_handoff.lock() {
            *handoff = None;
        }
    }

    /// Latest traffic sample for the active runtime generation. Never blocks
    /// on network I/O; speeds/totals come from the lifecycle-owned background
    /// reader and reset to zero when disconnected or after a generation switch.
    pub fn traffic_snapshot(&self) -> TrafficSample {
        match self.runtime_snapshot() {
            Ok(snapshot) if snapshot.connected_at.is_some() => {
                self.traffic.snapshot(snapshot.generation)
            }
            _ => TrafficSample::default(),
        }
    }

    pub fn runtime_snapshot(&self) -> Result<RuntimeSnapshot, String> {
        self.runtime
            .lock()
            .map(|snapshot| snapshot.clone())
            .map_err(|error| error.to_string())
    }

    pub fn is_running(&self) -> bool {
        self.active_process()
            .map(|process| process.is_running())
            .unwrap_or(false)
    }

    pub fn get_logs(&self) -> Vec<crate::mihomo::process::LogEntry> {
        self.active_process()
            .map(|process| process.get_logs())
            .unwrap_or_default()
    }

    pub fn clear_logs(&self) {
        if let Ok(process) = self.active_process() {
            process.clear_logs();
        }
    }

    pub fn active_listen_port(&self) -> u16 {
        self.runtime_snapshot()
            .ok()
            .and_then(|snapshot| snapshot.listen_port)
            .unwrap_or(self.listen_port)
    }

    fn active_process(&self) -> Result<Arc<MihomoProcess>, String> {
        self.process
            .lock()
            .map(|process| Arc::clone(&process))
            .map_err(|error| error.to_string())
    }

    fn replace_active_process(
        &self,
        replacement: Arc<MihomoProcess>,
    ) -> Result<Arc<MihomoProcess>, String> {
        let mut process = self.process.lock().map_err(|error| error.to_string())?;
        Ok(std::mem::replace(&mut *process, replacement))
    }

    fn managed_controller_targets_locked(&self) -> Result<Vec<ControllerTarget>, String> {
        let mut targets = Vec::new();
        let snapshot = self.runtime_snapshot()?;
        if snapshot.connected_at.is_some() && self.active_process()?.is_running() {
            if let (Some(scope), Some(port)) = (snapshot.controller_scope, snapshot.clash_api_port)
            {
                targets.push(ControllerTarget { scope, port });
            }
        }
        let draining = self
            .draining_cores
            .lock()
            .map_err(|error| error.to_string())?;
        for core in draining.iter() {
            if !core.process.is_running() {
                continue;
            }
            if let (Some(scope), Some(port)) = (&core.controller_scope, core.clash_api_port) {
                targets.push(ControllerTarget {
                    scope: scope.clone(),
                    port,
                });
            }
        }
        Ok(targets)
    }

    /// Aggregate the app-owned active and draining controllers under the same
    /// operation lock used by lifecycle transitions. Returned IDs are opaque
    /// capabilities stored in an app-side route table; they contain no port.
    pub fn list_managed_connections(
        &self,
    ) -> Result<crate::mihomo::controller::Connections, String> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| "Operation unavailable".to_string())?;
        self.guard_after_lock()?;
        let targets = self.managed_controller_targets_locked()?;
        if targets.is_empty() {
            return Err("Connect Mihomo first.".into());
        }

        let mut snapshots = Vec::new();
        let mut errors = Vec::new();
        for target in targets {
            match crate::mihomo::controller::connections(target.port) {
                Ok(snapshot) => snapshots.push((target, snapshot)),
                Err(error) => errors.push(format!(
                    "A managed Mihomo controller could not be queried: {error}"
                )),
            }
        }
        // Never publish a deceptively fresh partial snapshot: the UI retains
        // its previous complete snapshot on error, and the route map stays
        // untouched so an existing opaque ID can still be closed safely.
        if !errors.is_empty() {
            return Err(errors.join("; "));
        }

        let existing = self
            .connection_routes
            .lock()
            .map_err(|_| "Connection routes unavailable".to_string())?
            .clone();
        let reverse = existing
            .iter()
            .map(|(opaque_id, route)| {
                (
                    (route.scope.clone(), route.connection_id.clone()),
                    opaque_id.clone(),
                )
            })
            .collect::<HashMap<_, _>>();
        let mut refreshed = HashMap::new();
        let mut aggregate = crate::mihomo::controller::Connections {
            upload_total: 0,
            download_total: 0,
            connections: Vec::new(),
        };
        for (target, snapshot) in snapshots {
            aggregate.upload_total = aggregate.upload_total.saturating_add(snapshot.upload_total);
            aggregate.download_total = aggregate
                .download_total
                .saturating_add(snapshot.download_total);
            for mut connection in snapshot.connections {
                let route = ConnectionRoute {
                    scope: target.scope.clone(),
                    connection_id: connection.id,
                };
                let opaque_id = reverse
                    .get(&(route.scope.clone(), route.connection_id.clone()))
                    .cloned()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                refreshed.insert(opaque_id.clone(), route);
                connection.id = opaque_id;
                aggregate.connections.push(connection);
            }
        }
        *self
            .connection_routes
            .lock()
            .map_err(|_| "Connection routes unavailable".to_string())? = refreshed;
        Ok(aggregate)
    }

    pub fn close_managed_connection(&self, opaque_id: &str) -> Result<(), String> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| "Operation unavailable".to_string())?;
        self.guard_after_lock()?;
        let route = self
            .connection_routes
            .lock()
            .map_err(|_| "Connection routes unavailable".to_string())?
            .get(opaque_id)
            .cloned()
            .ok_or("Connection is no longer managed.")?;
        let target = self
            .managed_controller_targets_locked()?
            .into_iter()
            .find(|target| target.scope == route.scope);
        let Some(target) = target else {
            if let Ok(mut routes) = self.connection_routes.lock() {
                routes.remove(opaque_id);
            }
            return Err("Connection is no longer managed.".into());
        };
        crate::mihomo::controller::close(target.port, Some(&route.connection_id))?;
        if let Ok(mut routes) = self.connection_routes.lock() {
            routes.remove(opaque_id);
        }
        Ok(())
    }

    pub fn close_all_managed_connections(&self) -> Result<(), String> {
        let _operation = self
            .operation_lock
            .lock()
            .map_err(|_| "Operation unavailable".to_string())?;
        self.guard_after_lock()?;
        let targets = self.managed_controller_targets_locked()?;
        if targets.is_empty() {
            return Err("Connect Mihomo first.".into());
        }
        let mut errors = Vec::new();
        for target in &targets {
            if let Err(error) = crate::mihomo::controller::close(target.port, None) {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            let scopes = targets
                .iter()
                .map(|target| target.scope.as_str())
                .collect::<Vec<_>>();
            if let Ok(mut routes) = self.connection_routes.lock() {
                routes.retain(|_, route| !scopes.contains(&route.scope.as_str()));
            }
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    fn stop_all_processes(&self) -> Result<(), String> {
        let mut errors = Vec::new();
        if let Ok(process) = self.active_process() {
            let owned_runtime_dir = self
                .runtime_snapshot()
                .ok()
                .and_then(|snapshot| snapshot.owned_runtime_dir);
            match process.stop() {
                Ok(()) => {
                    if let Err(error) = remove_owned_runtime_dir(owned_runtime_dir.as_deref()) {
                        errors.push(error);
                    }
                    let pending_runtime_dir = self
                        .pending_runtime_dir
                        .lock()
                        .map_err(|error| error.to_string())?
                        .clone();
                    if pending_runtime_dir != owned_runtime_dir {
                        if let Err(error) = remove_owned_runtime_dir(pending_runtime_dir.as_deref())
                        {
                            errors.push(error);
                        }
                    }
                    if errors.is_empty() {
                        if let Ok(mut pending) = self.pending_runtime_dir.lock() {
                            *pending = None;
                        }
                    }
                }
                Err(error) => {
                    // Keep artifacts while process exit is not confirmed.
                    errors.push(error);
                }
            }
        }
        let draining = self
            .draining_cores
            .lock()
            .map_err(|error| error.to_string())?
            .clone();
        for core in draining {
            match core.process.stop() {
                Ok(()) => {
                    if let Err(error) = remove_owned_runtime_dir(core.owned_runtime_dir.as_deref())
                    {
                        errors.push(error);
                    } else if let Ok(mut registered) = self.draining_cores.lock() {
                        registered.retain(|item| !Arc::ptr_eq(item, &core));
                    }
                }
                Err(error) => {
                    // Keep the core registered: its process exit is not yet
                    // confirmed, so both endpoint ownership and artifacts stay.
                    errors.push(error);
                }
            }
        }
        if errors.is_empty() {
            if let Ok(mut routes) = self.connection_routes.lock() {
                routes.clear();
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

fn remove_owned_runtime_dir(path: Option<&Path>) -> Result<(), String> {
    let Some(path) = path else {
        return Ok(());
    };
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Failed to remove owned runtime directory {}: {error}",
            path.display()
        )),
    }
}

fn cleanup_confirmed_dead_active_runtime(proxy_state: &ProxyState) -> Result<(), String> {
    let process = proxy_state.active_process()?;
    if process.is_running() {
        return Err("mihomo is already running".into());
    }
    // `is_running == false` can also mean `try_wait` failed. `stop()` is the
    // ownership barrier: its success now requires a successful wait (or an
    // already-confirmed empty child slot), and retains the child on wait error.
    process.stop()?;
    let snapshot = proxy_state.runtime_snapshot()?;
    remove_owned_runtime_dir(snapshot.owned_runtime_dir.as_deref())?;
    let pending_runtime_dir = proxy_state
        .pending_runtime_dir
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    if pending_runtime_dir != snapshot.owned_runtime_dir {
        remove_owned_runtime_dir(pending_runtime_dir.as_deref())?;
    }
    if let Ok(mut pending) = proxy_state.pending_runtime_dir.lock() {
        *pending = None;
    }
    if snapshot.connected_at.is_some()
        || snapshot.config_path.is_some()
        || snapshot.owned_runtime_dir.is_some()
    {
        set_runtime_disconnected(proxy_state)?;
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LifecycleError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub config_applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_connections: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl LifecycleError {
    pub fn external(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self::failed(code, message, retryable)
    }

    fn failed(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable,
            config_applied: false,
            active_connections: None,
            reason: None,
        }
    }
}

impl std::fmt::Display for LifecycleError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

pub struct RuntimeLaunch {
    pub config_path: PathBuf,
    pub owned_runtime_dir: Option<PathBuf>,
    pub node_id: String,
    pub node_name: String,
    pub node_address: String,
    pub node_port: u16,
    pub group_id: String,
    pub group_name: String,
    pub clash_api_port: u16,
    pub listen_port: u16,
}

pub fn connect_core(app_state: &AppState, proxy_state: &ProxyState) -> Result<(), String> {
    let _operation = proxy_state
        .operation_lock
        .lock()
        .map_err(|error| format!("Lifecycle lock failed: {error}"))?;
    proxy_state.guard_after_lock()?;

    if proxy_state.is_running() {
        return Err("mihomo is already running".to_string());
    }
    cleanup_confirmed_dead_active_runtime(proxy_state)?;

    crate::gate::renew_if_enabled()
        .map_err(|error| format!("Automatic network access failed: {error}"))?;
    let runtime = prepare_runtime_launch(app_state, proxy_state)?;
    if let Err(error) = proxy_state.guard_after_lock() {
        return Err(cleanup_unstarted_runtime(&runtime, error));
    }

    let process = proxy_state.active_process()?;
    *proxy_state
        .pending_runtime_dir
        .lock()
        .map_err(|error| error.to_string())? = runtime.owned_runtime_dir.clone();
    if let Err(error) = process.start(runtime.config_path.to_str().ok_or("Invalid path")?) {
        let error = cleanup_unstarted_runtime(&runtime, error);
        if !runtime
            .owned_runtime_dir
            .as_ref()
            .is_some_and(|path| path.exists())
        {
            if let Ok(mut pending) = proxy_state.pending_runtime_dir.lock() {
                *pending = None;
            }
        }
        return Err(error);
    }

    if let Err(error) =
        wait_for_candidate_ready(&process, runtime.listen_port, runtime.clash_api_port)
    {
        return Err(cleanup_runtime_failure_locked(
            proxy_state,
            runtime.owned_runtime_dir.as_deref(),
            error,
        ));
    }

    // A running local listener only means mihomo parsed the configuration.
    // Verify proxied content (IP, Cloudflare trace, and Google) before
    // claiming the relay is usable or changing the user's system proxy settings.
    let verified_checks = match verify_proxy_content(runtime.listen_port) {
        Ok(checks) => checks,
        Err(error) => {
            return Err(cleanup_runtime_failure_locked(
                proxy_state,
                runtime.owned_runtime_dir.as_deref(),
                format!("VPS content verification failed: {error}"),
            ))
        }
    };

    proxy_state.owns_system_proxy.store(true, Ordering::SeqCst);
    if let Err(error) = proxy_state.system_proxy.set(runtime.listen_port) {
        return Err(cleanup_runtime_failure_locked(
            proxy_state,
            runtime.owned_runtime_dir.as_deref(),
            format!("Failed to configure system proxy: {error}"),
        ));
    }

    if let Err(error) = set_runtime_connected(proxy_state, &runtime, false) {
        return Err(cleanup_runtime_failure_locked(
            proxy_state,
            runtime.owned_runtime_dir.as_deref(),
            format!("Failed to record runtime snapshot: {error}"),
        ));
    }
    // Hand the just-verified checks to the immediately following preflight so
    // the connect UI does not repeat the three network probes. One-shot, ≤3 s,
    // keyed by the exact runtime; never consulted for Gate renewal.
    let generation = proxy_state
        .runtime_snapshot()
        .map(|s| s.generation)
        .unwrap_or(0);
    proxy_state.store_preflight_handoff(&runtime, generation, verified_checks);

    proxy_state.active_process()?.add_log(
        "info",
        &format!(
            "Connected to {} ({}:{})",
            runtime.node_name, runtime.node_address, runtime.node_port
        ),
    );
    proxy_state.active_process()?.add_log(
        "info",
        &format!("Active rule group: {}", runtime.group_name),
    );
    proxy_state.active_process()?.add_log(
        "info",
        &format!("System proxy configured on port {}", runtime.listen_port),
    );

    Ok(())
}

pub fn disconnect_core(proxy_state: &ProxyState) -> Result<(), String> {
    let _operation = proxy_state
        .operation_lock
        .lock()
        .map_err(|error| format!("Lifecycle lock failed: {error}"))?;
    disconnect_locked(proxy_state, true)
}

pub fn shutdown_core(proxy_state: &ProxyState) -> Result<(), String> {
    // Latch first: a connect/reload queued on this lock must refuse after the
    // lock is acquired rather than resurrecting mihomo during app exit.
    proxy_state.mark_shutting_down();
    let _operation = proxy_state
        .operation_lock
        .lock()
        .map_err(|error| format!("Lifecycle lock failed: {error}"))?;
    disconnect_locked(proxy_state, false)
}

fn disconnect_locked(proxy_state: &ProxyState, write_log: bool) -> Result<(), String> {
    proxy_state.clear_preflight_handoff();
    let mut errors = Vec::new();

    let all_processes_stopped = match proxy_state.stop_all_processes() {
        Ok(()) => true,
        Err(error) => {
            errors.push(format!("Failed to stop mihomo: {error}"));
            false
        }
    };
    if let Err(error) = proxy_state.clear_owned_system_proxy() {
        errors.push(format!("Failed to clear system proxy: {error}"));
    }
    if all_processes_stopped {
        if let Err(error) = set_runtime_disconnected(proxy_state) {
            errors.push(format!("Failed to clear runtime snapshot: {error}"));
        }
    }

    if errors.is_empty() {
        if write_log {
            let _ = proxy_state
                .active_process()
                .map(|process| process.add_log("info", "Disconnected, system proxy cleared"));
        }
        Ok(())
    } else {
        let combined_error = errors.join("; ");
        let _ = proxy_state
            .active_process()
            .map(|process| process.add_log("error", &combined_error));
        Err(combined_error)
    }
}

pub fn reload_proxy_if_running(
    app_state: &AppState,
    proxy_state: &ProxyState,
) -> Result<(), String> {
    let _operation = proxy_state
        .operation_lock
        .lock()
        .map_err(|error| format!("Lifecycle lock failed: {error}"))?;
    proxy_state.guard_after_lock()?;

    if !proxy_state.is_running() {
        return Ok(());
    }

    crate::gate::renew_if_enabled()
        .map_err(|error| format!("Automatic network access failed: {error}"))?;

    // Prepare and validate a replacement before changing the system proxy. The
    // previous process remains alive long enough for its existing TCP streams
    // to drain, while new streams move to the verified candidate.
    let runtime = prepare_runtime_launch(app_state, proxy_state)?;
    let previous = proxy_state.runtime_snapshot()?;
    hot_swap_runtime(proxy_state, runtime, previous)?;

    proxy_state
        .active_process()?
        .add_log("info", "Reloaded mihomo with a verified candidate runtime");

    Ok(())
}

pub fn apply_runtime_config_change<T>(
    app_state: &AppState,
    proxy_state: &ProxyState,
    mutate: impl FnOnce(&mut AppConfig) -> Result<T, String>,
) -> Result<T, LifecycleError> {
    let _operation = proxy_state.operation_lock.lock().map_err(|error| {
        LifecycleError::failed(
            "lifecycle_failed",
            format!("Lifecycle lock failed: {error}"),
            true,
        )
    })?;
    if proxy_state.is_shutting_down() {
        return Err(LifecycleError::failed(
            "lifecycle_failed",
            "Pingu is shutting down",
            false,
        ));
    }
    // Take only a short config lock to snapshot the candidate input. The
    // shared operation lock (already held) serializes every AppConfig writer,
    // so verification and the hot swap run without holding the config lock
    // and cannot freeze main-thread status/settings/tray reads, while the
    // on-disk/in-memory config cannot drift underneath us.
    let previous_config = {
        let config_guard = app_state
            .config
            .lock()
            .map_err(|error| LifecycleError::failed("lifecycle_failed", error.to_string(), true))?;
        config_guard.clone()
    };
    let mut candidate = previous_config.clone();
    let result = mutate(&mut candidate)
        .map_err(|error| LifecycleError::failed("validation_failed", error, false))?;

    if !proxy_state.is_running() {
        candidate
            .save()
            .map_err(|error| LifecycleError::failed("config_save_failed", error, true))?;
        let mut config_guard = app_state
            .config
            .lock()
            .map_err(|error| LifecycleError::failed("lifecycle_failed", error.to_string(), true))?;
        *config_guard = candidate;
        return Ok(result);
    }

    let previous = proxy_state
        .runtime_snapshot()
        .map_err(|error| LifecycleError::failed("lifecycle_failed", error, true))?;
    let next_generation = previous.generation.saturating_add(1);
    let runtime = prepare_runtime_launch_for_config(&candidate, proxy_state, next_generation)
        .map_err(|error| LifecycleError::failed("validation_failed", error, false))?;

    if let Err(error) = candidate.save() {
        let _ = remove_owned_runtime_dir(runtime.owned_runtime_dir.as_deref());
        return Err(LifecycleError::failed("config_save_failed", error, true));
    }
    if let Err(error) = hot_swap_runtime(proxy_state, runtime, previous) {
        // Restore the pre-swap config so neither disk nor memory can describe
        // a runtime that never went live. The operation lock is still held, so
        // no other writer raced this swap.
        let _ = previous_config.save();
        if let Ok(mut config_guard) = app_state.config.lock() {
            *config_guard = previous_config;
        }
        return Err(LifecycleError::failed("lifecycle_failed", error, true));
    }
    let mut config_guard = app_state
        .config
        .lock()
        .map_err(|error| LifecycleError::failed("lifecycle_failed", error.to_string(), true))?;
    *config_guard = candidate;
    let _ = proxy_state.active_process().map(|process| {
        process.add_log(
            "info",
            "Switched to a verified runtime without dropping the previous listener",
        )
    });
    Ok(result)
}

/// Mutate and persist [`AppConfig`] without touching the runtime. Takes the
/// shared operation lock so plain settings writes cannot interleave with a
/// hot swap's candidate/rollback window. The config mutex is held only while
/// cloning and while publishing the committed value — never across mutation
/// I/O or `save`.
pub fn mutate_config_only<T>(
    app_state: &AppState,
    mutate: impl FnOnce(&mut AppConfig) -> Result<T, String>,
) -> Result<T, LifecycleError> {
    let _operation = app_state
        .operation_lock
        .lock()
        .map_err(|error| LifecycleError::failed("lifecycle_failed", error.to_string(), true))?;
    let mut candidate = {
        let config = app_state
            .config
            .lock()
            .map_err(|error| LifecycleError::failed("lifecycle_failed", error.to_string(), true))?;
        config.clone()
    };
    let result = mutate(&mut candidate)
        .map_err(|error| LifecycleError::failed("validation_failed", error, false))?;
    // Commit to disk first; only then publish to in-memory state, so a failed
    // save leaves both unchanged.
    candidate
        .save()
        .map_err(|error| LifecycleError::failed("config_save_failed", error, true))?;
    let mut config = app_state
        .config
        .lock()
        .map_err(|error| LifecycleError::failed("lifecycle_failed", error.to_string(), true))?;
    *config = candidate;
    Ok(result)
}

/// Run an external (OS) side effect and a config update as one atomic critical
/// operation under the shared operation lock: the side effect happens after
/// the config mutex is released, then persistence commits before the in-memory
/// state is republished. Concurrent toggles therefore cannot reorder the OS
/// change and the persisted setting.
pub fn apply_config_with_side_effect<T>(
    app_state: &AppState,
    side_effect: impl FnOnce(&AppConfig) -> Result<(), String>,
    mutate: impl FnOnce(&mut AppConfig) -> Result<T, String>,
) -> Result<T, LifecycleError> {
    let _operation = app_state
        .operation_lock
        .lock()
        .map_err(|error| LifecycleError::failed("lifecycle_failed", error.to_string(), true))?;
    let current = {
        let config = app_state
            .config
            .lock()
            .map_err(|error| LifecycleError::failed("lifecycle_failed", error.to_string(), true))?;
        config.clone()
    };
    // The side effect reads the current configuration without holding the
    // config mutex; the operation lock keeps it coherent.
    side_effect(&current)
        .map_err(|error| LifecycleError::failed("side_effect_failed", error, true))?;

    let mut candidate = current;
    let result = mutate(&mut candidate)
        .map_err(|error| LifecycleError::failed("validation_failed", error, false))?;
    candidate
        .save()
        .map_err(|error| LifecycleError::failed("config_save_failed", error, true))?;
    let mut config = app_state
        .config
        .lock()
        .map_err(|error| LifecycleError::failed("lifecycle_failed", error.to_string(), true))?;
    *config = candidate;
    Ok(result)
}

const DRAIN_TIMEOUT: Duration = Duration::from_secs(30);
const DRAIN_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Start a candidate on a separate local listener, prove that its egress works,
/// then point new system-proxy connections at it. Existing streams remain on
/// the previous listener until they drain or the bounded timeout expires.
fn hot_swap_runtime(
    proxy_state: &ProxyState,
    runtime: RuntimeLaunch,
    previous: RuntimeSnapshot,
) -> Result<(), String> {
    let current = proxy_state.active_process()?;
    let candidate = Arc::new(current.successor());
    if let Err(error) = candidate.start(runtime.config_path.to_str().ok_or("Invalid path")?) {
        return Err(cleanup_unstarted_runtime(&runtime, error));
    }

    if let Err(error) =
        wait_for_candidate_ready(&candidate, runtime.listen_port, runtime.clash_api_port)
    {
        return Err(cleanup_candidate_runtime(
            proxy_state,
            &candidate,
            &runtime,
            format!("Candidate listener failed: {error}"),
        ));
    }
    let verified_checks = match verify_proxy_content(runtime.listen_port) {
        Ok(checks) => checks,
        Err(error) => {
            proxy_state.clear_preflight_handoff();
            return Err(cleanup_candidate_runtime(
                proxy_state,
                &candidate,
                &runtime,
                format!("Candidate content verification failed: {error}"),
            ));
        }
    };
    proxy_state.owns_system_proxy.store(true, Ordering::SeqCst);
    if let Err(error) = proxy_state.system_proxy.set(runtime.listen_port) {
        return Err(cleanup_candidate_runtime(
            proxy_state,
            &candidate,
            &runtime,
            format!("Failed to promote candidate system proxy: {error}"),
        ));
    }

    let previous_process = match proxy_state.replace_active_process(Arc::clone(&candidate)) {
        Ok(process) => process,
        Err(error) => {
            if let Some(previous_port) = previous.listen_port {
                let _ = proxy_state.system_proxy.set(previous_port);
            }
            return Err(cleanup_candidate_runtime(
                proxy_state,
                &candidate,
                &runtime,
                format!("Failed to promote candidate process: {error}"),
            ));
        }
    };
    if let Err(error) = set_runtime_connected(proxy_state, &runtime, true) {
        let _ = proxy_state.replace_active_process(previous_process);
        if let Some(previous_port) = previous.listen_port {
            let _ = proxy_state.system_proxy.set(previous_port);
        }
        return Err(cleanup_candidate_runtime(
            proxy_state,
            &candidate,
            &runtime,
            format!("Failed to record candidate runtime: {error}"),
        ));
    }

    schedule_drain(
        Arc::clone(&proxy_state.draining_cores),
        Arc::clone(&proxy_state.operation_lock),
        Arc::new(DrainingCore {
            process: previous_process,
            clash_api_port: previous.clash_api_port,
            controller_scope: previous.controller_scope,
            owned_runtime_dir: previous.owned_runtime_dir,
        }),
    );
    // set_runtime_connected computed the new generation inside the swap.
    let generation = proxy_state
        .runtime_snapshot()
        .map(|s| s.generation)
        .unwrap_or(0);
    proxy_state.store_preflight_handoff(&runtime, generation, verified_checks);
    Ok(())
}

fn schedule_drain(
    draining_cores: Arc<Mutex<Vec<Arc<DrainingCore>>>>,
    operation_lock: Arc<Mutex<()>>,
    core: Arc<DrainingCore>,
) {
    if let Ok(mut draining) = draining_cores.lock() {
        draining.push(Arc::clone(&core));
    }

    std::thread::spawn(move || {
        let started_at = Instant::now();
        while started_at.elapsed() < DRAIN_TIMEOUT {
            let should_stop = {
                let Ok(_operation) = operation_lock.lock() else {
                    return;
                };
                let registered = draining_cores
                    .lock()
                    .map(|draining| draining.iter().any(|item| Arc::ptr_eq(item, &core)))
                    .unwrap_or(false);
                if !registered {
                    return;
                }
                if !core.process.is_running() {
                    true
                } else {
                    matches!(query_active_connections(core.clash_api_port), Ok(0))
                }
            };
            if should_stop {
                break;
            }
            std::thread::sleep(DRAIN_POLL_INTERVAL);
        }
        // Serialize confirmed exit, artifact cleanup, and endpoint removal with
        // list/close/hot-swap operations. No caller can target a replaced core
        // between the managed-target snapshot and its controller request.
        let Ok(_operation) = operation_lock.lock() else {
            return;
        };
        let registered = draining_cores
            .lock()
            .map(|draining| draining.iter().any(|item| Arc::ptr_eq(item, &core)))
            .unwrap_or(false);
        if !registered {
            return;
        }
        if core.process.stop().is_ok()
            && remove_owned_runtime_dir(core.owned_runtime_dir.as_deref()).is_ok()
        {
            if let Ok(mut draining) = draining_cores.lock() {
                draining.retain(|item| !Arc::ptr_eq(item, &core));
            }
        }
    });
}

fn query_active_connections(clash_api_port: Option<u16>) -> Result<usize, String> {
    let port = clash_api_port.ok_or("Clash API is unavailable")?;
    let url = format!("http://127.0.0.1:{port}/connections");
    let response: serde_json::Value = crate::mihomo::controller::authorize(ureq::get(&url))
        .timeout(Duration::from_millis(500))
        .call()
        .map_err(|error| format!("Failed to query active connections: {error}"))?
        .into_json()
        .map_err(|error| format!("Failed to parse active connections: {error}"))?;
    match response.get("connections") {
        Some(serde_json::Value::Null) => Ok(0),
        Some(serde_json::Value::Array(rows)) => Ok(rows.len()),
        _ => Err("Active connections response is missing connections".into()),
    }
}

pub fn prepare_runtime_launch(
    app_state: &AppState,
    proxy_state: &ProxyState,
) -> Result<RuntimeLaunch, String> {
    // Clone under a short lock: config generation (file write + mihomo
    // check) must not block readers that only need the current config.
    let config = app_state
        .config
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let generation = proxy_state.runtime_snapshot()?.generation.saturating_add(1);
    let listen_port = find_available_port(proxy_state.listen_port)?;
    let prepared = prepare_runtime_generation_with_port(&config, Some(generation), listen_port)?;
    runtime_launch_from_prepared(prepared, proxy_state)
}

fn prepare_runtime_launch_for_config(
    config: &AppConfig,
    proxy_state: &ProxyState,
    generation: u64,
) -> Result<RuntimeLaunch, String> {
    runtime_launch_from_prepared(
        prepare_runtime_generation_with_port(
            config,
            Some(generation),
            find_available_port(proxy_state.listen_port)?,
        )?,
        proxy_state,
    )
}

fn runtime_launch_from_prepared(
    prepared: PreparedRuntime,
    proxy_state: &ProxyState,
) -> Result<RuntimeLaunch, String> {
    let runtime = RuntimeLaunch {
        config_path: prepared.config_path.clone(),
        owned_runtime_dir: prepared.owned_runtime_dir.clone(),
        node_id: prepared.node.id.clone(),
        node_name: prepared.node.name.clone(),
        node_address: prepared.node.address.clone(),
        node_port: prepared.node.port,
        group_id: prepared.rule_group.id.clone(),
        group_name: prepared.rule_group.name.clone(),
        clash_api_port: prepared.clash_api_port,
        listen_port: prepared.listen_port,
    };
    if let Err(error) = proxy_state
        .active_process()?
        .check(runtime.config_path.to_str().ok_or("Invalid path")?)
    {
        return Err(error.finish_owned_cleanup(runtime.owned_runtime_dir.clone()));
    }
    Ok(runtime)
}

fn set_runtime_connected(
    proxy_state: &ProxyState,
    runtime: &RuntimeLaunch,
    preserve_connected_at: bool,
) -> Result<(), String> {
    let mut snapshot = proxy_state
        .runtime
        .lock()
        .map_err(|error| error.to_string())?;
    let connected_at = if preserve_connected_at {
        snapshot.connected_at.unwrap_or_else(Instant::now)
    } else {
        Instant::now()
    };
    let generation = snapshot.generation.saturating_add(1);
    *snapshot = RuntimeSnapshot {
        connected_at: Some(connected_at),
        running_node_id: Some(runtime.node_id.clone()),
        running_group_id: Some(runtime.group_id.clone()),
        clash_api_port: Some(runtime.clash_api_port),
        listen_port: Some(runtime.listen_port),
        config_path: Some(runtime.config_path.clone()),
        owned_runtime_dir: runtime.owned_runtime_dir.clone(),
        controller_scope: Some(uuid::Uuid::new_v4().to_string()),
        generation,
    };
    drop(snapshot);
    if let Ok(mut pending) = proxy_state.pending_runtime_dir.lock() {
        *pending = None;
    }
    proxy_state
        .traffic
        .attach(generation, runtime.clash_api_port);
    Ok(())
}

fn set_runtime_disconnected(proxy_state: &ProxyState) -> Result<(), String> {
    let mut snapshot = proxy_state
        .runtime
        .lock()
        .map_err(|error| error.to_string())?;
    // The generation is intentionally preserved: it must stay monotonic
    // across reconnects so caches keyed by a previous generation can never be
    // mistaken for the new runtime's results.
    let generation = snapshot.generation;
    *snapshot = RuntimeSnapshot {
        generation,
        ..RuntimeSnapshot::default()
    };
    drop(snapshot);
    proxy_state.traffic.detach();
    if let Ok(mut routes) = proxy_state.connection_routes.lock() {
        routes.clear();
    }
    Ok(())
}

fn cleanup_runtime_failure_locked(
    proxy_state: &ProxyState,
    owned_runtime_dir: Option<&Path>,
    error: String,
) -> String {
    proxy_state.clear_preflight_handoff();
    let mut errors = vec![error];

    let stopped = match proxy_state.stop_all_processes() {
        Ok(()) => {
            if let Err(cleanup_error) = remove_owned_runtime_dir(owned_runtime_dir) {
                errors.push(cleanup_error);
            }
            true
        }
        Err(stop_error) => {
            errors.push(format!(
                "Failed to stop mihomo during cleanup: {stop_error}"
            ));
            false
        }
    };
    if let Err(proxy_error) = proxy_state.clear_owned_system_proxy() {
        errors.push(format!(
            "Failed to clear system proxy during cleanup: {proxy_error}"
        ));
    }
    if stopped {
        if let Err(state_error) = set_runtime_disconnected(proxy_state) {
            errors.push(format!(
                "Failed to clear runtime snapshot during cleanup: {state_error}"
            ));
        }
    }

    let combined_error = errors.join("; ");
    let _ = proxy_state
        .active_process()
        .map(|process| process.add_log("error", &combined_error));
    combined_error
}

fn cleanup_unstarted_runtime(runtime: &RuntimeLaunch, error: String) -> String {
    match remove_owned_runtime_dir(runtime.owned_runtime_dir.as_deref()) {
        Ok(()) => error,
        Err(cleanup_error) => format!("{error}; {cleanup_error}"),
    }
}

fn cleanup_candidate_runtime(
    proxy_state: &ProxyState,
    process: &Arc<MihomoProcess>,
    runtime: &RuntimeLaunch,
    error: String,
) -> String {
    match process.stop() {
        Ok(()) => match remove_owned_runtime_dir(runtime.owned_runtime_dir.as_deref()) {
            Ok(()) => error,
            Err(cleanup_error) => format!("{error}; {cleanup_error}"),
        },
        Err(stop_error) => {
            if let Ok(mut draining) = proxy_state.draining_cores.lock() {
                draining.push(Arc::new(DrainingCore {
                    process: Arc::clone(process),
                    clash_api_port: None,
                    controller_scope: None,
                    owned_runtime_dir: runtime.owned_runtime_dir.clone(),
                }));
            }
            format!(
                "{error}; candidate exit was not confirmed, runtime artifacts retained: {stop_error}"
            )
        }
    }
}

fn wait_for_candidate_ready(
    process: &MihomoProcess,
    listen_port: u16,
    clash_api_port: u16,
) -> Result<(), String> {
    let address = SocketAddr::from(([127, 0, 0, 1], listen_port));
    let timeout = Duration::from_secs(5);
    let poll_interval = Duration::from_millis(100);
    let started_at = Instant::now();

    loop {
        if !process.is_running() {
            return Err(
                "mihomo exited during startup, please check the generated config or logs"
                    .to_string(),
            );
        }
        match TcpStream::connect_timeout(&address, poll_interval) {
            Ok(_) => {
                if !process.is_running() {
                    return Err(
                        "mihomo exited during startup, please check the generated config or logs"
                            .to_string(),
                    );
                }
                if query_active_connections(Some(clash_api_port)).is_ok() {
                    if !process.is_running() {
                        return Err(
                            "mihomo exited during startup, please check the generated config or logs"
                                .to_string(),
                        );
                    }
                    return Ok(());
                }
            }
            Err(_) => {}
        }
        if started_at.elapsed() >= timeout {
            return Err(format!(
                "Timed out waiting for the intended mihomo runtime on 127.0.0.1:{}",
                listen_port
            ));
        }
        std::thread::sleep(poll_interval);
    }
}

#[cfg(test)]
mod tests;

/// Coherent preflight snapshot taken under the operation lock: the fields
/// together identify the exact runtime the caller is about to describe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreflightContext {
    pub generation: u64,
    pub listen_port: u16,
    pub node_id: String,
    pub group_id: String,
}

impl ProxyState {
    /// Snapshot the active runtime identity under the shared operation lock so
    /// a hot swap cannot land between the identity read and the network probes
    /// that are then run without holding the lock.
    pub fn preflight_context(
        &self,
        _operation: &std::sync::MutexGuard<'_, ()>,
    ) -> Option<PreflightContext> {
        if self.shutdown_intent.load(Ordering::SeqCst) {
            return None;
        }
        // A stale `connected_at` must not outlive a crashed/stopped core.
        if !self.is_running() {
            return None;
        }
        let snapshot = self.runtime_snapshot().ok()?;
        if snapshot.connected_at.is_none() {
            return None;
        }
        Some(PreflightContext {
            generation: snapshot.generation,
            listen_port: snapshot.listen_port?,
            node_id: snapshot.running_node_id?,
            group_id: snapshot.running_group_id?,
        })
    }

    /// Verify the runtime described by a preflight snapshot is still the live
    /// one. Taken again under the operation lock after probes complete, so a
    /// switched/stopped runtime can never be reported as ready.
    pub fn preflight_context_still_current(
        &self,
        _operation: &std::sync::MutexGuard<'_, ()>,
        context: &PreflightContext,
    ) -> bool {
        match self.preflight_context(_operation) {
            Some(current) => &current == context,
            None => false,
        }
    }
}

#[cfg(test)]
mod perf_stage_tests;
