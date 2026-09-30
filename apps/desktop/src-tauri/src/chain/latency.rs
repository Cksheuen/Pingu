//! HTTPS first-byte latency through the complete route, with a paired VPS baseline.
use super::{
    probe::{self, IsolatedRuntime},
    AppConfig, ChainSettings, NodeRef,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

pub const ROUNDS: usize = 3;
const TARGETS: [(&str, &str, u64); 2] = [
    ("YouTube", "https://www.youtube.com/generate_204", 204),
    ("GitHub", "https://github.com/robots.txt", 200),
];
#[derive(Clone, Debug, Serialize)]
pub struct TargetMeasurement {
    pub name: String,
    pub url: String,
    pub response_ms: Vec<f64>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct RouteMeasurement {
    pub route: String,
    pub targets: Vec<TargetMeasurement>,
    pub egress_ip: Option<String>,
    pub error: Option<String>,
}
impl RouteMeasurement {
    fn new(route: &str) -> Self {
        Self {
            route: route.into(),
            targets: TARGETS
                .iter()
                .map(|(name, url, _)| TargetMeasurement {
                    name: (*name).into(),
                    url: (*url).into(),
                    response_ms: vec![],
                    error: None,
                })
                .collect(),
            egress_ip: None,
            error: None,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Comparison {
    pub settings: ChainSettings,
    pub measured_at: String,
    pub routes: Vec<RouteMeasurement>,
    pub cancelled: bool,
    pub same_exit: bool,
    pub gain_percent: Option<f64>,
    pub eligible: bool,
}
#[derive(Clone, Serialize, Default)]
pub struct Progress {
    pub completed: usize,
    pub total: usize,
    pub running: bool,
    pub applying: bool,
}
static PROGRESS: Mutex<Progress> = Mutex::new(Progress {
    completed: 0,
    total: 0,
    running: false,
    applying: false,
});
pub fn cancelled() -> bool {
    probe::CANCELLED.load(Ordering::SeqCst)
}
pub fn progress() -> Progress {
    PROGRESS.lock().unwrap_or_else(|p| p.into_inner()).clone()
}
struct FinishProgress;
impl Drop for FinishProgress {
    fn drop(&mut self) {
        let mut p = PROGRESS.lock().unwrap_or_else(|p| p.into_inner());
        p.running = false;
        p.applying = false;
    }
}
pub fn request_cancel() -> bool {
    let p = PROGRESS.lock().unwrap_or_else(|p| p.into_inner());
    if p.applying {
        return false;
    }
    probe::CANCELLED.store(true, Ordering::SeqCst);
    true
}
#[derive(Clone, Serialize)]
pub struct Candidate {
    pub reference: NodeRef,
    pub name: String,
    pub source: String,
    pub comparison: Option<Comparison>,
    pub error: Option<String>,
}
#[derive(Serialize)]
pub struct Selection {
    pub outcome: String,
    pub measured_at: String,
    pub baseline: RouteMeasurement,
    pub candidates: Vec<Candidate>,
    pub selected: Option<NodeRef>,
    pub gain_percent: Option<f64>,
    pub applied: bool,
}
fn curl(port: u16, url: &str, body: bool) -> Result<(String, Value), String> {
    probe::check_cancelled()?;
    let mut command = Command::new("curl");
    command.args([
        "--silent",
        "--show-error",
        "--fail",
        "--proxy",
        &format!("http://127.0.0.1:{port}"),
        "--noproxy",
        "",
        "--connect-timeout",
        "3",
        "--max-time",
        "6",
        "--max-filesize",
        "65536",
        "--http1.1",
    ]);
    if !body {
        command.args(["--output", "/dev/null"]);
    }
    let mut child = command
        .args(["--write-out", "\nPINGU_METRICS%{json}", url])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Cannot start latency probe")?;
    loop {
        if probe::check_cancelled().is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Comparison cancelled.".into());
        }
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Cannot read latency probe".into());
            }
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|_| "Cannot read latency probe")?;
    if !output.status.success() {
        return Err("Request failed or exceeded 6 seconds.".into());
    }
    let text = String::from_utf8(output.stdout).map_err(|_| "Invalid probe response")?;
    let (body, metrics) = text
        .rsplit_once("\nPINGU_METRICS")
        .ok_or("Missing timing")?;
    Ok((
        body.into(),
        serde_json::from_str(metrics).map_err(|_| "Invalid timing")?,
    ))
}
fn egress(port: u16) -> Result<String, String> {
    let (body, m) = curl(port, "https://www.cloudflare.com/cdn-cgi/trace", true)?;
    if m["http_code"] != 200 {
        return Err("Egress check failed".into());
    }
    let ip = body
        .lines()
        .find_map(|l| l.strip_prefix("ip="))
        .ok_or("Missing exit IP")?;
    ip.parse::<std::net::IpAddr>()
        .map_err(|_| "Invalid exit IP")?;
    Ok(ip.into())
}
fn sample(port: u16, index: usize) -> Result<f64, String> {
    let (_, m) = curl(port, TARGETS[index].1, false)?;
    if m["http_code"].as_u64() != Some(TARGETS[index].2) {
        return Err("Unexpected site response; not a latency sample.".into());
    }
    let ms = m["time_starttransfer"]
        .as_f64()
        .ok_or("Missing first-byte timing")?
        * 1000.0;
    if !ms.is_finite() || ms <= 0.0 {
        return Err("Invalid first-byte timing".into());
    }
    Ok(ms)
}
fn record(route: &mut RouteMeasurement, port: u16, target: usize) -> bool {
    match sample(port, target) {
        Ok(ms) => {
            route.targets[target].response_ms.push(ms);
            true
        }
        Err(e) => {
            route.targets[target].error = Some(e);
            false
        }
    }
}
fn median(v: &[f64]) -> Option<f64> {
    if v.is_empty() || v.iter().any(|n| !n.is_finite() || *n <= 0.0) {
        return None;
    }
    let mut v = v.to_vec();
    v.sort_by(f64::total_cmp);
    Some(if v.len() % 2 == 1 {
        v[v.len() / 2]
    } else {
        (v[v.len() / 2 - 1] + v[v.len() / 2]) / 2.0
    })
}
fn complete(r: &RouteMeasurement) -> bool {
    r.error.is_none()
        && r.egress_ip.is_some()
        && r.targets.len() == TARGETS.len()
        && r.targets.iter().all(|t| {
            t.error.is_none() && t.response_ms.len() == ROUNDS && median(&t.response_ms).is_some()
        })
}
/// Normalize per site so a slow endpoint cannot dominate the score. Require a
/// useful gain (10% and 30ms) and reject a candidate that regresses any site >5%.
pub fn score(routes: &[RouteMeasurement]) -> Option<(f64, bool)> {
    let a = routes.iter().find(|r| r.route == "direct_exit")?;
    let b = routes.iter().find(|r| r.route == "chain")?;
    if !complete(a) || !complete(b) || a.egress_ip != b.egress_ip {
        return None;
    }
    let mut ratios = vec![];
    let mut savings = vec![];
    for (a, b) in a.targets.iter().zip(&b.targets) {
        if a.url != b.url {
            return None;
        }
        let (x, y) = (median(&a.response_ms)?, median(&b.response_ms)?);
        ratios.push(y / x);
        savings.push(x - y);
    }
    let ratio = ratios.iter().sum::<f64>() / ratios.len() as f64;
    Some((
        (1.0 - ratio) * 100.0,
        ratio <= 0.90
            && savings.iter().sum::<f64>() / savings.len() as f64 >= 30.0
            && ratios.iter().all(|r| *r <= 1.05),
    ))
}
fn build(settings: ChainSettings, routes: Vec<RouteMeasurement>) -> Comparison {
    let same_exit = routes[0].egress_ip.is_some() && routes[0].egress_ip == routes[1].egress_ip;
    let cancelled = probe::CANCELLED.load(Ordering::SeqCst);
    let scored = if cancelled { None } else { score(&routes) };
    Comparison {
        settings,
        measured_at: chrono::Utc::now().to_rfc3339(),
        routes,
        cancelled,
        same_exit,
        gain_percent: scored.map(|s| s.0),
        eligible: scored.is_some_and(|s| s.1),
    }
}
fn measure_pair(
    config: &AppConfig,
    settings: ChainSettings,
    direct: &IsolatedRuntime,
) -> Comparison {
    let mut routes = vec![
        RouteMeasurement::new("direct_exit"),
        RouteMeasurement::new("chain"),
    ];
    let result = (|| -> Result<(), String> {
        let (entry, exit) = super::pair(config, &settings)?;
        let mut gated = config.clone();
        gated.proxy_chain = settings.clone();
        gated.proxy_chain.enabled = true;
        super::prepare_gate(&gated)?;
        let chain = IsolatedRuntime::start(super::named_pair(entry, exit))?;
        routes[0].egress_ip = Some(egress(direct.port)?);
        routes[1].egress_ip = Some(egress(chain.port)?);
        for round in 0..ROUNDS {
            for target in 0..TARGETS.len() {
                // Alternate the baseline/candidate order inside each paired round.
                for index in if round % 2 == 0 { [0, 1] } else { [1, 0] } {
                    probe::check_cancelled()?;
                    let port = if index == 0 { direct.port } else { chain.port };
                    if !record(&mut routes[index], port, target) {
                        return Err("Incomplete site samples".into());
                    }
                }
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        routes[1].error = Some(e);
    }
    build(settings, routes)
}
fn baseline(
    config: &AppConfig,
    exit: &NodeRef,
) -> Result<(IsolatedRuntime, RouteMeasurement), String> {
    if matches!(exit, NodeRef::Manual { .. }) {
        crate::gate::renew_if_enabled()?;
    }
    let runtime = IsolatedRuntime::single(super::resolve(config, exit)?)?;
    let mut measured = RouteMeasurement::new("direct_exit");
    measured.egress_ip = Some(egress(runtime.port)?);
    for _ in 0..ROUNDS {
        for target in 0..TARGETS.len() {
            probe::check_cancelled()?;
            if !record(&mut measured, runtime.port, target) {
                return Err(
                    "The single-node baseline is unavailable. Current settings were kept.".into(),
                );
            }
        }
    }
    Ok((runtime, measured))
}
pub fn compare(config: &AppConfig, settings: ChainSettings) -> Result<Comparison, String> {
    let _guard = probe::TEST_LOCK
        .try_lock()
        .map_err(|_| "A route test is already running.")?;
    probe::CANCELLED.store(false, Ordering::SeqCst);
    super::pair(config, &settings)?;
    if matches!(settings.exit, Some(NodeRef::Manual { .. })) {
        crate::gate::renew_if_enabled()?;
    }
    let direct = IsolatedRuntime::single(super::resolve(config, settings.exit.as_ref().unwrap())?)?;
    Ok(measure_pair(config, settings, &direct))
}
fn candidates(config: &AppConfig, exit: &NodeRef) -> Vec<Candidate> {
    let mut seen = HashSet::new();
    super::choices(config)
        .into_iter()
        .filter_map(|c| {
            if !matches!(c.reference, NodeRef::Subscription { .. })
                || c.unavailable_reason.is_some()
                || &c.reference == exit
            {
                return None;
            }
            let settings = ChainSettings {
                enabled: true,
                entry: Some(c.reference.clone()),
                exit: Some(exit.clone()),
            };
            let (mut entry, _) = super::pair(config, &settings).ok()?;
            entry.as_object_mut()?.remove("name");
            if !seen.insert(entry.to_string()) {
                return None;
            }
            Some(Candidate {
                reference: c.reference,
                name: c.name,
                source: c.source,
                comparison: None,
                error: None,
            })
        })
        .collect()
}
pub fn auto_select(config: &AppConfig, exit: NodeRef) -> Result<Selection, String> {
    auto_select_with(config, exit, |_| Ok(()))
}
pub fn auto_select_with(
    config: &AppConfig,
    exit: NodeRef,
    apply: impl FnOnce(&mut Selection) -> Result<(), String>,
) -> Result<Selection, String> {
    let _guard = probe::TEST_LOCK
        .try_lock()
        .map_err(|_| "A route test is already running.")?;
    probe::CANCELLED.store(false, Ordering::SeqCst);
    let candidates = candidates(config, &exit);
    *PROGRESS.lock().unwrap_or_else(|p| p.into_inner()) = Progress {
        completed: 0,
        total: candidates.len(),
        running: true,
        applying: false,
    };
    let _finish = FinishProgress;
    if candidates.is_empty() {
        return Err("No subscription nodes are available for this exit.".into());
    }
    let (direct, base) = baseline(config, &exit)?;
    let results = Mutex::new(candidates);
    let next = AtomicUsize::new(0);
    let deadline = Instant::now() + Duration::from_secs(300);
    let total = results.lock().unwrap().len();
    let workers = if crate::gate::get_settings()?.enabled {
        1
    } else {
        2
    };
    std::thread::scope(|scope| {
        for _ in 0..workers {
            let results = &results;
            let next = &next;
            let direct = &direct;
            let exit = &exit;
            scope.spawn(move || loop {
                if probe::check_cancelled().is_err() || Instant::now() >= deadline {
                    break;
                }
                let index = next.fetch_add(1, Ordering::SeqCst);
                if index >= total {
                    break;
                }
                let reference = results.lock().unwrap()[index].reference.clone();
                let comparison = measure_pair(
                    config,
                    ChainSettings {
                        enabled: true,
                        entry: Some(reference),
                        exit: Some(exit.clone()),
                    },
                    direct,
                );
                results.lock().unwrap()[index].comparison = Some(comparison);
                PROGRESS.lock().unwrap_or_else(|p| p.into_inner()).completed += 1;
            });
        }
    });
    let mut candidates = results.into_inner().unwrap();
    let cancelled = probe::CANCELLED.load(Ordering::SeqCst);
    for c in &mut candidates {
        if c.comparison.is_none() {
            c.error = Some(
                if cancelled {
                    "Cancelled"
                } else {
                    "Scan time limit reached"
                }
                .into(),
            );
        }
    }
    let (outcome, selected, gain) = decision(&candidates, cancelled);
    let mut selection = Selection {
        outcome: outcome.into(),
        measured_at: chrono::Utc::now().to_rfc3339(),
        baseline: base,
        candidates,
        selected,
        gain_percent: gain,
        applied: false,
    };
    if selection.outcome == "selected" || selection.outcome == "no_gain" {
        {
            let mut p = PROGRESS.lock().unwrap_or_else(|p| p.into_inner());
            if probe::CANCELLED.load(Ordering::SeqCst) {
                selection.outcome = "cancelled".into();
                selection.selected = None;
                return Ok(selection);
            }
            p.applying = true;
        }
        apply(&mut selection)?;
    }
    Ok(selection)
}

fn decision(
    candidates: &[Candidate],
    cancelled: bool,
) -> (&'static str, Option<NodeRef>, Option<f64>) {
    let completed = candidates.iter().all(|c| c.comparison.is_some());
    let winner = candidates
        .iter()
        .filter(|c| c.comparison.as_ref().is_some_and(|r| r.eligible))
        .min_by(|a, b| {
            let latency = |c: &Candidate| {
                c.comparison.as_ref().unwrap().routes[1]
                    .targets
                    .iter()
                    .map(|t| median(&t.response_ms).unwrap())
                    .sum::<f64>()
            };
            latency(a).total_cmp(&latency(b))
        });
    return if cancelled {
        ("cancelled", None, None)
    } else if !completed {
        ("inconclusive", None, None)
    } else if let Some(w) = winner {
        (
            "selected",
            Some(w.reference.clone()),
            w.comparison.as_ref().unwrap().gain_percent,
        )
    } else if candidates.iter().any(|c| {
        c.comparison
            .as_ref()
            .is_some_and(|r| r.gain_percent.is_some())
    }) {
        ("no_gain", None, None)
    } else {
        ("inconclusive", None, None)
    };
}

#[cfg(test)]
mod tests;
