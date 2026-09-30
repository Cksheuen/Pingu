//! Persistent daily log writer shared by every draining mihomo process.
//!
//! Producers (stdout/stderr reader threads, `add_log`) enqueue preformatted
//! lines over a bounded channel and never touch disk themselves: a saturated
//! queue drops lines and bumps a counter instead of blocking the proxy. A
//! single background thread accumulates a batch (up to `BATCH_CAPACITY` lines
//! or `FLUSH_INTERVAL`), concatenates it into one `write_all`, and reopens the
//! file when the local date rolls over.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// Hard cap on queued, unflushed lines. Bounds memory when disk writes stall.
const QUEUE_CAPACITY: usize = 4096;
/// Lines accumulated before a forced mid-timer flush.
const BATCH_CAPACITY: usize = 256;
/// Upper bound between enqueue and durable write.
const FLUSH_INTERVAL: Duration = Duration::from_millis(250);
/// Upper bound producers wait for a barrier flush during shutdown.
const FLUSH_WAIT_TIMEOUT: Duration = Duration::from_secs(3);
/// Per-line byte cap so the queue count alone bounds memory. Overlong lines
/// are truncated with a marker suffix.
const MAX_LINE_BYTES: usize = 8 * 1024;

enum Message {
    /// One preformatted log line (already newline terminated).
    Line(String),
    /// Acknowledged flush: writer flushes everything already queued, then replies.
    Barrier(SyncSender<()>),
}

pub struct LogWriter {
    tx: SyncSender<Message>,
    dropped: Arc<AtomicU64>,
}

impl LogWriter {
    /// Enqueue a preformatted line. Never blocks: a full or disconnected queue
    /// drops the line and increments the dropped counter instead.
    fn enqueue(&self, line: String) {
        if let Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) =
            self.tx.try_send(Message::Line(line))
        {
            self.dropped.fetch_add(1, AtomicOrdering::SeqCst);
        }
    }

    /// Block until every line enqueued before this call has been flushed.
    /// FIFO ordering guarantees all prior `Line` messages are consumed first.
    /// The whole operation (enqueue + ack) is bounded by
    /// [`FLUSH_WAIT_TIMEOUT`]; returns false on timeout.
    fn flush_barrier(&self) -> bool {
        // Capacity 1 so the writer's ack lands even if this caller has not
        // entered recv yet; a rendezvous channel would drop a try_send ack.
        let (ack_tx, ack_rx) = mpsc::sync_channel::<()>(1);
        // Retry try_send under a shared total deadline: it must not block
        // forever if the queue is momentarily full from a slow disk.
        let start = Instant::now();
        let deadline = start + FLUSH_WAIT_TIMEOUT;
        let mut pending = Message::Barrier(ack_tx);
        loop {
            match self.tx.try_send(pending) {
                Ok(()) => break,
                Err(TrySendError::Disconnected(_)) => return true,
                Err(TrySendError::Full(returned)) => {
                    let now = Instant::now();
                    if now >= deadline {
                        return false;
                    }
                    // Recover the unsent message and keep the remaining time
                    // for both further retries and the final ack wait.
                    pending = returned;
                    thread::sleep(Duration::from_millis(5).min(deadline - now));
                }
            }
        }
        // Wait only for the time left so the total never exceeds the deadline.
        ack_rx
            .recv_timeout(FLUSH_WAIT_TIMEOUT.saturating_sub(start.elapsed()))
            .is_ok()
    }

    /// Test-only accessor: production surfaces drops by writing a summary line
    /// on the next flush rather than exposing a pull API.
    #[cfg(test)]
    fn take_dropped(&self) -> u64 {
        self.dropped.swap(0, AtomicOrdering::SeqCst)
    }
}

/// Process-wide shared writer; multiple draining mihomo processes append to
/// the same daily file through this single background thread.
static WRITER: OnceLock<LogWriter> = OnceLock::new();

pub fn shared() -> &'static LogWriter {
    WRITER.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel::<Message>(QUEUE_CAPACITY);
        let dropped = Arc::new(AtomicU64::new(0));
        thread::Builder::new()
            .name("sing-proxy-log-writer".to_string())
            .spawn({
                let dropped = dropped.clone();
                move || run_writer(rx, log_dir(), LocalDay, RetainProd, dropped)
            })
            .expect("failed to spawn log writer thread");
        LogWriter { tx, dropped }
    })
}

/// Directory holding daily log files.
///
/// Production: `~/.config/sing-proxy/logs/` (cwd fallback matches the legacy
/// path). In test builds this is redirected to a unique per-process temp
/// directory, so unit tests that construct the real process/lifecycle can never
/// read or delete a user's historical logs. HOME is never modified.
pub fn log_dir() -> PathBuf {
    #[cfg(not(test))]
    let dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("sing-proxy")
        .join("logs");

    #[cfg(test)]
    let dir = std::env::temp_dir().join(format!(
        "pingu-rust-unit-logs-{}-{}",
        std::process::id(),
        std::file!()
            .trim_start_matches("src/")
            .replace(['/', '.'], "_")
    ));

    std::fs::create_dir_all(&dir).ok();
    dir
}

/// Path to today's log file.
pub fn log_file_path() -> PathBuf {
    log_dir().join(format!("sing-proxy-{}.log", LocalDay.today()))
}

/// Delete log files older than 7 days, based on the date embedded in the name.
pub fn cleanup_old_logs() {
    cleanup_old_logs_in(&log_dir(), &LocalDay);
}

/// Retention policy parameterized for tests: deletes dated files strictly
/// older than `now - 7 days` inside `dir`.
fn cleanup_old_logs_in<D: DaySource>(dir: &Path, day: &D) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = day.today() - chrono::Duration::days(7);
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(date_str) = name
            .strip_prefix("sing-proxy-")
            .and_then(|s| s.strip_suffix(".log"))
        {
            if let Ok(date) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                if date < cutoff {
                    std::fs::remove_file(entry.path()).ok();
                }
            }
        }
    }
}

/// Format an entry exactly as the legacy line layout, newline terminated, and
/// truncate overlong single lines so the queue depth alone bounds memory. The
/// truncation offset is floored to a UTF-8 char boundary so it never panics on
/// multibyte content (Chinese, emoji).
pub fn format_entry(timestamp: &str, level: &str, message: &str) -> String {
    let mut line = format!("[{timestamp}] [{level}] {message}\n");
    if line.len() > MAX_LINE_BYTES {
        let mut cut = MAX_LINE_BYTES - 4;
        while cut > 0 && !line.is_char_boundary(cut) {
            cut -= 1;
        }
        line.truncate(cut);
        line.push_str("...\n");
    }
    line
}

/// Enqueue one formatted entry line through the shared writer.
pub fn enqueue_entry(timestamp: &str, level: &str, message: &str) {
    shared().enqueue(format_entry(timestamp, level, message));
}

/// Bounded barrier flush; call after stdout/stderr readers have drained so
/// final diagnostics are persisted. Returns false if the flush timed out.
pub fn flush_for_shutdown() -> bool {
    shared().flush_barrier()
}

/// Abstraction over "what day is it" so tests never depend on wall-clock.
trait DaySource {
    fn today(&self) -> chrono::NaiveDate;
}

/// Production day source: the real local date.
struct LocalDay;
impl DaySource for LocalDay {
    fn today(&self) -> chrono::NaiveDate {
        chrono::Local::now().date_naive()
    }
}

/// Retention hook parameterized so production runs the real cleanup while
/// tests can no-op it.
trait Retention {
    fn on_rollover(&self);
}

struct RetainProd;
impl Retention for RetainProd {
    fn on_rollover(&self) {
        cleanup_old_logs();
    }
}

#[cfg(test)]
struct NoRetention;
#[cfg(test)]
impl Retention for NoRetention {
    fn on_rollover(&self) {}
}

fn run_writer<D: DaySource, R: Retention>(
    rx: Receiver<Message>,
    dir: PathBuf,
    day: D,
    retention: R,
    dropped: Arc<AtomicU64>,
) {
    let mut state = WriterState::new(dir, day.today());
    let mut batch: Vec<String> = Vec::with_capacity(BATCH_CAPACITY);
    // Absolute deadline of the next flush. The timer is only advanced when a
    // flush actually happens, so a trickle of arrivals can never keep buffered
    // lines waiting well beyond FLUSH_INTERVAL.
    let mut next_flush = Instant::now() + FLUSH_INTERVAL;

    loop {
        let now = Instant::now();
        let timeout = if now >= next_flush {
            Duration::from_millis(0)
        } else {
            next_flush - now
        };
        match rx.recv_timeout(timeout) {
            Ok(Message::Line(line)) => {
                batch.push(line);
                if batch.len() >= BATCH_CAPACITY {
                    flush(&mut state, &mut batch, &day, &retention, &dropped);
                    next_flush = Instant::now() + FLUSH_INTERVAL;
                }
                // No size flush: leave the deadline untouched.
            }
            // FIFO: every Line enqueued before this Barrier is already in
            // `batch`, so one flush makes the ack's guarantee true.
            Ok(Message::Barrier(ack)) => {
                flush(&mut state, &mut batch, &day, &retention, &dropped);
                next_flush = Instant::now() + FLUSH_INTERVAL;
                // Capacity-1 ack channel: succeeds whether or not the caller
                // has entered recv yet.
                let _ = ack.try_send(());
            }
            Err(RecvTimeoutError::Timeout) => {
                flush(&mut state, &mut batch, &day, &retention, &dropped);
                next_flush = Instant::now() + FLUSH_INTERVAL;
            }
            Err(RecvTimeoutError::Disconnected) => {
                flush(&mut state, &mut batch, &day, &retention, &dropped);
                break;
            }
        }
    }
}

/// Flush the batch with one write, prepending a bounded summary of any lines
/// that producers dropped while the queue was full.
fn flush<D: DaySource, R: Retention>(
    state: &mut WriterState,
    batch: &mut Vec<String>,
    day: &D,
    retention: &R,
    dropped: &AtomicU64,
) {
    let dropped_count = dropped.swap(0, AtomicOrdering::SeqCst);
    if dropped_count > 0 {
        batch.insert(
            0,
            format_entry(
                &chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
                "warn",
                &format!("log writer dropped {dropped_count} line(s) while queue was full"),
            ),
        );
    }
    state.write_batch(batch, day, retention);
}

/// Owns the open daily file and handles date rollover.
struct WriterState {
    dir: PathBuf,
    file: Option<File>,
    day: chrono::NaiveDate,
}

impl WriterState {
    fn new(dir: PathBuf, today: chrono::NaiveDate) -> Self {
        let mut state = Self {
            dir,
            file: None,
            day: today,
        };
        state.open();
        state
    }

    fn path_for(dir: &Path, day: chrono::NaiveDate) -> PathBuf {
        dir.join(format!("sing-proxy-{}.log", day.format("%Y-%m-%d")))
    }

    fn open(&mut self) {
        // Make sure the parent exists: the directory may have been removed or
        // not yet created when the first open was attempted.
        std::fs::create_dir_all(&self.dir).ok();
        let path = Self::path_for(&self.dir, self.day);
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
    }

    /// Concatenate the batch into a single buffer and issue one write+flush.
    /// Reopens the file when the date has changed and runs retention once on
    /// each rollover. If the handle is missing (an earlier open failed) or a
    /// write fails, the handle is dropped so the *next* batch retries the open
    /// once — recovering after a transient filesystem error without a busy
    /// loop (retries are paced by the normal batch/flush cadence).
    fn write_batch<D: DaySource, R: Retention>(
        &mut self,
        batch: &mut Vec<String>,
        day: &D,
        retention: &R,
    ) {
        if batch.is_empty() {
            return;
        }
        let today = day.today();
        if today != self.day {
            self.day = today;
            self.open();
            retention.on_rollover();
        }
        // Recover from a previously failed open: retry on this batch.
        if self.file.is_none() {
            self.open();
        }

        let mut failed = self.file.is_none();
        if let Some(file) = self.file.as_mut() {
            let mut buf = Vec::with_capacity(batch.iter().map(|l| l.len()).sum());
            for line in batch.iter() {
                buf.extend_from_slice(line.as_bytes());
            }
            if file.write_all(&buf).is_err() || file.flush().is_err() {
                // Drop the bad handle so the next batch reopens/retries.
                failed = true;
            }
        }
        if failed {
            self.file = None;
        }
        batch.clear();
    }
}

#[cfg(test)]
mod tests;
