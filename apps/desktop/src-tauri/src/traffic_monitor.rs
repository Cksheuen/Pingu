//! Lifecycle-owned background reader for the mihomo Clash API traffic stream.
//!
//! `GET /traffic` is an infinite chunked NDJSON stream: the first JSON record
//! arrives roughly one second after the response headers and a new record
//! follows every second. Treating it as a finite JSON body (the previous
//! `.timeout(500ms).call().into_json()` behaviour) always timed out, so both
//! the UI card and the tray menu showed placeholder speeds while connected.
//!
//! This module keeps exactly one subscription per runtime generation. A
//! dedicated OS thread owns the streaming response (HTTP/chunked decoding is
//! delegated to `ureq::Response::into_reader`), parses one bounded line at a
//! time, publishes the latest sample into a tiny lock-protected cache, and
//! never waits for EOF before publishing. UI/tray readers only take the cache
//! lock; they perform no network I/O.

use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// Maximum bytes accepted for a single NDJSON line. mihomo traffic records
/// are tiny; anything larger is discarded so a malformed peer cannot grow
/// memory without bound.
const MAX_LINE_BYTES: usize = 64 * 1024;
/// Read deadline per socket fill. Records arrive once per second, so this is
/// longer than the steady-state gap. ureq's chunked decoder cannot resume a
/// response after a mid-chunk timeout, so any timeout drops the whole
/// response and reconnects with bounded backoff (partial NDJSON discarded).
/// 2 s also bounds how long detach/switch joins can wait, off the UI thread.
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
/// Reconnect backoff ramp, capped.
const BACKOFF_STEPS_MS: [u64; 6] = [100, 200, 500, 1000, 2000, 2000];
/// How often `/connections` is polled for cumulative byte totals.
const TOTALS_INTERVAL: Duration = Duration::from_secs(3);
/// A speed sample older than this means the stream went quiet; speeds reset to
/// zero rather than freezing on the last value.
const SPEED_FRESHNESS: Duration = Duration::from_millis(3_500);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TrafficSample {
    pub generation: u64,
    pub upload_speed: u64,
    pub download_speed: u64,
    pub upload_total: u64,
    pub download_total: u64,
}

#[derive(Default)]
struct CachedSample {
    generation: u64,
    upload_speed: u64,
    download_speed: u64,
    speeds_at: Option<Instant>,
    upload_total: u64,
    download_total: u64,
    totals_at: Option<Instant>,
}

struct Subscription {
    cancel: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

/// Shared traffic cache owned by [`crate::lifecycle::ProxyState`].
pub struct TrafficMonitor {
    /// Generation whose results are allowed to land in the cache. `0` means no
    /// runtime is attached. The reader thread compares every publish against
    /// this, so a switched runtime can never publish stale samples.
    active_generation: Arc<AtomicU64>,
    current: Mutex<Option<Subscription>>,
    sample: Arc<Mutex<CachedSample>>,
}

impl Default for TrafficMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl TrafficMonitor {
    pub fn new() -> Self {
        Self {
            active_generation: Arc::new(AtomicU64::new(0)),
            current: Mutex::new(None),
            sample: Arc::new(Mutex::new(CachedSample::default())),
        }
    }

    /// Start (or replace) the background subscription for a runtime. The whole
    /// hand-off runs under `current` so attach/detach are serialized: first
    /// cancel and join any previous reader, then publish the new generation
    /// and reset the visible cache, and only then spawn the new reader. That
    /// order guarantees a new reader never observes a stale generation and
    /// exits immediately, and old-runtime speeds can never survive a switch.
    pub fn attach(&self, generation: u64, clash_api_port: u16) {
        if generation == 0 {
            return;
        }

        let mut current = match self.current.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if let Some(previous) = current.take() {
            previous.cancel.store(true, Ordering::SeqCst);
            // The stream thread owns its blocking socket; it exits within the
            // bounded read timeout. Joining here prevents reader pile-up on a
            // rapid hot swap.
            if let Some(join) = previous.join {
                let _ = join.join();
            }
        }
        self.active_generation.store(generation, Ordering::SeqCst);
        self.reset_sample(generation);

        let cancel = Arc::new(AtomicBool::new(false));
        let handle = spawn_reader(
            generation,
            clash_api_port,
            Arc::clone(&cancel),
            Arc::clone(&self.active_generation),
            Arc::clone(&self.sample),
        );
        *current = Some(Subscription {
            cancel,
            join: Some(handle),
        });
    }

    /// Cancel the active reader and reset cached speeds/totals. Called on
    /// disconnect, shutdown and failed cleanup.
    pub fn detach(&self) {
        let mut current = match self.current.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if let Some(previous) = current.take() {
            previous.cancel.store(true, Ordering::SeqCst);
            if let Some(join) = previous.join {
                let _ = join.join();
            }
        }
        drop(current);
        self.active_generation.store(0, Ordering::SeqCst);
        self.reset_sample(0);
    }

    /// Read the latest sample for `current_generation`. Readers never perform
    /// network I/O. Samples produced by an older generation are suppressed;
    /// stale speed readings decay to zero while cumulative totals remain
    /// available until the next disconnect/switch resets them.
    pub fn snapshot(&self, current_generation: u64) -> TrafficSample {
        let cached = match self.sample.lock() {
            Ok(guard) => guard,
            Err(_) => return TrafficSample::default(),
        };
        if cached.generation != current_generation || current_generation == 0 {
            return TrafficSample::default();
        }

        let speeds_fresh = cached
            .speeds_at
            .map(|at| at.elapsed() <= SPEED_FRESHNESS)
            .unwrap_or(false);

        TrafficSample {
            generation: current_generation,
            upload_speed: if speeds_fresh { cached.upload_speed } else { 0 },
            download_speed: if speeds_fresh {
                cached.download_speed
            } else {
                0
            },
            upload_total: if cached.totals_at.is_some() {
                cached.upload_total
            } else {
                0
            },
            download_total: if cached.totals_at.is_some() {
                cached.download_total
            } else {
                0
            },
        }
    }

    fn reset_sample(&self, generation: u64) {
        if let Ok(mut cached) = self.sample.lock() {
            *cached = CachedSample {
                generation,
                speeds_at: None,
                totals_at: None,
                ..CachedSample::default()
            };
        }
    }
}

fn spawn_reader(
    generation: u64,
    clash_api_port: u16,
    cancel: Arc<AtomicBool>,
    active_generation: Arc<AtomicU64>,
    sample: Arc<Mutex<CachedSample>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        run_subscription(
            generation,
            clash_api_port,
            cancel,
            active_generation,
            sample,
        );
    })
}

fn run_subscription(
    generation: u64,
    clash_api_port: u16,
    cancel: Arc<AtomicBool>,
    active_generation: Arc<AtomicU64>,
    sample: Arc<Mutex<CachedSample>>,
) {
    let mut backoff = 0usize;
    let mut last_totals = Instant::now()
        .checked_sub(TOTALS_INTERVAL)
        .unwrap_or_else(Instant::now);

    'reconnect: while !cancel.load(Ordering::SeqCst) {
        if active_generation.load(Ordering::SeqCst) != generation {
            return;
        }

        let response = match open_traffic_stream(clash_api_port) {
            Ok(response) => response,
            Err(_) => {
                if !wait_backoff(&mut backoff, &cancel) {
                    return;
                }
                continue;
            }
        };
        // ureq's chunked decoder is not resumable after a mid-chunk read
        // timeout (chunk-size state is held across reads), so on ANY timeout
        // this whole response is dropped: a fresh connection, a fresh parser
        // and bounded backoff. Partial NDJSON is discarded with it.
        let mut line_reader = LineReader::new();
        let mut body = LineReader::wrap(response.into_reader());

        loop {
            if cancel.load(Ordering::SeqCst)
                || active_generation.load(Ordering::SeqCst) != generation
            {
                return;
            }

            match line_reader.read_line(&mut body) {
                Ok(line) => {
                    let trimmed = String::from_utf8_lossy(&line);
                    let trimmed = trimmed.trim();
                    if let Some((up, down)) = parse_traffic_record(trimmed) {
                        // Only a real traffic row proves the stream works;
                        // resetting on the HTTP 200 alone would let empty/EOF
                        // loops spin without backoff.
                        backoff = 0;
                        publish_speeds(&sample, generation, &active_generation, up, down);
                        if last_totals.elapsed() >= TOTALS_INTERVAL {
                            last_totals = Instant::now();
                            if let Some((up_total, down_total)) =
                                fetch_connection_totals(clash_api_port)
                            {
                                publish_totals(
                                    &sample,
                                    generation,
                                    &active_generation,
                                    up_total,
                                    down_total,
                                );
                            }
                        }
                    }
                }
                Err(LineError::TimedOut) => {
                    // The ureq chunked decoder cannot be resumed after a
                    // mid-chunk timeout; drop this response (and its partial
                    // NDJSON) and reconnect with bounded backoff.
                    drop(body);
                    drop(line_reader);
                    if !wait_backoff(&mut backoff, &cancel) {
                        return;
                    }
                    continue 'reconnect;
                }
                Err(LineError::Overlong) => continue,
                Err(LineError::Closed) => {
                    if !wait_backoff(&mut backoff, &cancel) {
                        return;
                    }
                    continue 'reconnect;
                }
            }
        }
    }
}

fn stream_agent() -> ureq::Agent {
    // No global `.timeout(...)`: that would impose a total deadline on an
    // infinite stream. Only the connect/read phases are bounded.
    ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout_read(READ_TIMEOUT)
        .build()
}

fn open_traffic_stream(port: u16) -> Result<ureq::Response, ureq::Error> {
    crate::mihomo::controller::authorize(
        stream_agent().get(&format!("http://127.0.0.1:{port}/traffic")),
    )
    .set("Accept", "application/json")
    .call()
}

fn wait_backoff(step: &mut usize, cancel: &AtomicBool) -> bool {
    let delay_ms = BACKOFF_STEPS_MS[(*step).min(BACKOFF_STEPS_MS.len() - 1)];
    *step = (*step + 1).min(BACKOFF_STEPS_MS.len() - 1);
    let started = Instant::now();
    let delay = Duration::from_millis(delay_ms);
    while started.elapsed() < delay {
        if cancel.load(Ordering::SeqCst) {
            return false;
        }
        thread::sleep(Duration::from_millis(20));
    }
    true
}

#[derive(Debug, PartialEq, Eq)]
enum LineError {
    TimedOut,
    Overlong,
    Closed,
}

/// Stateful bounded NDJSON line reader. Its partial-line buffer survives a
/// socket read timeout, so a record split across deadline boundaries is
/// completed on the next call instead of being corrupted or duplicated.
struct LineReader {
    buf: Vec<u8>,
    discarding: bool,
}

impl LineReader {
    fn new() -> Self {
        Self {
            buf: Vec::new(),
            discarding: false,
        }
    }

    fn wrap<R: Read>(inner: R) -> BufReader<R> {
        BufReader::new(inner)
    }

    /// Read one newline-terminated line, capped at [`MAX_LINE_BYTES`].
    fn read_line<R: Read>(&mut self, body: &mut BufReader<R>) -> Result<Vec<u8>, LineError> {
        let mut saw_more = false;
        loop {
            let available = match body.fill_buf() {
                Ok(buf) if buf.is_empty() => {
                    if saw_more || !self.buf.is_empty() {
                        if self.discarding {
                            self.reset();
                            return Err(LineError::Overlong);
                        }
                        return Ok(self.take_line());
                    }
                    return Err(LineError::Closed);
                }
                Ok(buf) => buf,
                Err(error) => match error.kind() {
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
                        // Pending bytes (and the discard flag) stay in self.
                        return Err(LineError::TimedOut);
                    }
                    std::io::ErrorKind::Interrupted => continue,
                    _ => return Err(LineError::Closed),
                },
            };

            let (newline, consumed) = match available.iter().position(|byte| *byte == b'\n') {
                Some(index) => (true, index + 1),
                None => (false, available.len()),
            };

            if !self.discarding {
                let keep = if newline { consumed - 1 } else { consumed };
                let room = MAX_LINE_BYTES.saturating_sub(self.buf.len());
                if keep > room {
                    // Line exceeds the bound: keep alignment, drop content.
                    self.buf.clear();
                    self.discarding = true;
                } else {
                    self.buf.extend_from_slice(&available[..keep]);
                }
            }
            body.consume(consumed);
            saw_more = true;

            if newline {
                if self.discarding {
                    self.reset();
                    return Err(LineError::Overlong);
                }
                return Ok(self.take_line());
            }
        }
    }

    fn take_line(&mut self) -> Vec<u8> {
        if self.buf.last() == Some(&b'\r') {
            self.buf.pop();
        }
        let out = std::mem::take(&mut self.buf);
        self.discarding = false;
        out
    }

    fn reset(&mut self) {
        self.buf.clear();
        self.discarding = false;
    }
}

/// Parse a mihomo `{"up": <bytes/s>, "down": <bytes/s>}` record. Chunk-size
/// and other non-JSON framing never reaches this layer (ureq decodes chunked
/// transfer encoding); malformed rows are ignored.
fn parse_traffic_record(text: &str) -> Option<(u64, u64)> {
    if !text.starts_with('{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let up = value.get("up")?.as_u64()?;
    let down = value.get("down")?.as_u64()?;
    Some((up, down))
}

/// Fetch cumulative byte totals from `/connections`. This is a finite JSON
/// document with a short total deadline, unlike the streaming `/traffic`
/// endpoint. Missed-interval rate sums are never reported as byte totals.
fn fetch_connection_totals(port: u16) -> Option<(u64, u64)> {
    let body: serde_json::Value = crate::mihomo::controller::authorize(ureq::get(&format!(
        "http://127.0.0.1:{port}/connections"
    )))
    .timeout(Duration::from_millis(1_500))
    .call()
    .ok()?
    .into_json()
    .ok()?;
    // mihomo 1.13.x reports cumulative totals as `uploadTotal`/`downloadTotal`.
    let upload_total = body.get("uploadTotal")?.as_u64()?;
    let download_total = body.get("downloadTotal")?.as_u64()?;
    Some((upload_total, download_total))
}

fn generation_is_current(active: &AtomicU64, generation: u64) -> bool {
    active.load(Ordering::SeqCst) == generation
}

fn publish_speeds(
    cache: &Arc<Mutex<CachedSample>>,
    generation: u64,
    active: &AtomicU64,
    up: u64,
    down: u64,
) {
    if !generation_is_current(active, generation) {
        return;
    }
    if let Ok(mut cached) = cache.lock() {
        if cached.generation != generation {
            return;
        }
        cached.upload_speed = up;
        cached.download_speed = down;
        cached.speeds_at = Some(Instant::now());
    }
}

fn publish_totals(
    cache: &Arc<Mutex<CachedSample>>,
    generation: u64,
    active: &AtomicU64,
    up: u64,
    down: u64,
) {
    if !generation_is_current(active, generation) {
        return;
    }
    if let Ok(mut cached) = cache.lock() {
        if cached.generation != generation {
            return;
        }
        cached.upload_total = up;
        cached.download_total = down;
        cached.totals_at = Some(Instant::now());
    }
}

#[cfg(test)]
mod tests;
