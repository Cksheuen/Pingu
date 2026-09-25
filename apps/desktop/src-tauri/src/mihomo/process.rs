use super::log_writer;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const MAX_LOG_LINES: usize = 500;
/// Bounded wait for stdout/stderr readers to drain after kill, so stop() never
/// blocks indefinitely while still preserving final diagnostics.
const READER_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

/// Return the path to today's log file under `~/.config/sing-proxy/logs/`.
pub fn log_file_path() -> PathBuf {
    log_writer::log_file_path()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

pub struct MihomoProcess {
    // The child paired with a receiver that closes when both stdout/stderr
    // reader threads finish draining their pipes.
    child: Mutex<Option<(Child, mpsc::Receiver<()>)>>,
    logs: Arc<Mutex<VecDeque<LogEntry>>>,
    binary_path: String,
}

/// Validation failed, with an optional child whose exit could not yet be
/// confirmed. The child handle stays owned until a reaper observes exit; an
/// explicitly supplied temporary directory is removed only after that point.
pub struct ValidationError {
    message: String,
    unconfirmed_child: Option<Child>,
}

impl ValidationError {
    fn confirmed(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            unconfirmed_child: None,
        }
    }

    fn unconfirmed(message: impl Into<String>, child: Child) -> Self {
        Self {
            message: message.into(),
            unconfirmed_child: Some(child),
        }
    }

    /// Complete cleanup from an explicit ownership token. No path is inferred
    /// from validator arguments. If exit is unconfirmed, a small dedicated
    /// reaper retains the child and defers removal until `wait` succeeds.
    pub fn finish_owned_cleanup(mut self, owned_dir: Option<PathBuf>) -> String {
        let message = self.message;
        if let Some(mut child) = self.unconfirmed_child.take() {
            thread::spawn(move || loop {
                match child.wait() {
                    Ok(_) => {
                        remove_explicit_dir(owned_dir.as_deref());
                        break;
                    }
                    Err(_) => thread::sleep(Duration::from_millis(100)),
                }
            });
        } else if let Some(path) = owned_dir.as_deref() {
            if let Err(error) = std::fs::remove_dir_all(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return format!("{message}; cannot remove validation directory");
                }
            }
        }
        message
    }

    #[cfg(test)]
    pub(crate) fn exit_confirmed(&self) -> bool {
        self.unconfirmed_child.is_none()
    }
}

fn remove_explicit_dir(path: Option<&std::path::Path>) {
    if let Some(path) = path {
        let _ = std::fs::remove_dir_all(path);
    }
}

impl MihomoProcess {
    pub fn new() -> Self {
        Self::with_binary(crate::resolve_mihomo_path())
    }

    pub fn with_binary(binary_path: impl Into<String>) -> Self {
        log_writer::cleanup_old_logs();
        Self::with_binary_inner(binary_path)
    }

    #[cfg(test)]
    pub(crate) fn with_binary_for_test(binary_path: impl Into<String>) -> Self {
        Self::with_binary_inner(binary_path)
    }

    fn with_binary_inner(binary_path: impl Into<String>) -> Self {
        Self {
            child: Mutex::new(None),
            logs: Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES))),
            binary_path: binary_path.into(),
        }
    }

    /// Create an independently managed mihomo instance with the same binary.
    /// Lifecycle uses this for a blue/green local-proxy handoff, keeping the old
    /// process alive while the new listener is being verified.
    pub fn successor(&self) -> Self {
        Self::with_binary(self.binary_path.clone())
    }

    pub fn check(&self, config_path: &str) -> Result<(), ValidationError> {
        let mut child = Command::new(&self.binary_path)
            .args(["-t", "-f", config_path, "-d", runtime_dir(config_path)])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    ValidationError::confirmed(crate::missing_mihomo_message())
                } else {
                    ValidationError::confirmed("Cannot launch Mihomo configuration validation.")
                }
            })?;
        let started = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return if status.success() {
                        Ok(())
                    } else {
                        Err(ValidationError::confirmed("Mihomo rejected the generated configuration. Check subscription proxy/group/rule references and supported options."))
                    }
                }
                Ok(None) if started.elapsed() < Duration::from_secs(30) => {
                    thread::sleep(Duration::from_millis(50))
                }
                result => {
                    let message = if result.is_err() {
                        "Mihomo configuration validation status could not be read."
                    } else {
                        "Mihomo configuration validation exceeded its deadline."
                    };
                    let _ = child.kill();
                    return match child.wait() {
                        Ok(_) => Err(ValidationError::confirmed(message)),
                        Err(_) => Err(ValidationError::unconfirmed(message, child)),
                    };
                }
            }
        }
    }

    pub fn start(&self, config_path: &str) -> Result<(), String> {
        let mut guard = self
            .child
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        if guard.is_some() {
            return Err("mihomo is already running".into());
        }

        // Clear old logs
        if let Ok(mut logs) = self.logs.lock() {
            logs.clear();
        }

        let mut child = Command::new(&self.binary_path)
            .args(["-f", config_path, "-d", runtime_dir(config_path)])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    crate::missing_mihomo_message()
                } else {
                    format!("Failed to start mihomo: {}", e)
                }
            })?;

        // Each reader signals once after its pipe reaches EOF (process exited /
        // killed). stop() waits for both (bounded) before issuing the barrier
        // flush, so final diagnostics are never lost.
        let (drained_tx, drained_rx) = mpsc::channel::<()>();

        // Capture stderr in a background thread (mihomo logs to stderr)
        if let Some(stderr) = child.stderr.take() {
            let logs = Arc::clone(&self.logs);
            let drained = drained_tx.clone();
            thread::spawn(move || {
                read_output_into_logs(stderr, &logs, persist_to_file);
                let _ = drained.send(());
            });
        }

        // Capture stdout similarly
        if let Some(stdout) = child.stdout.take() {
            let logs = Arc::clone(&self.logs);
            let drained = drained_tx.clone();
            thread::spawn(move || {
                read_output_into_logs(stdout, &logs, persist_to_file);
                let _ = drained.send(());
            });
        }
        // Drop the sending half we retained; only the two reader threads hold
        // senders now, so the channel closes when both have drained.
        drop(drained_tx);

        *guard = Some((child, drained_rx));
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        // Take the child (and its drain receiver) out of the mutex, then DROP
        // the guard before kill/wait/flush. The UI also takes this mutex in
        // get_status/is_running, so holding it across the wait would block the
        // main thread. start/stop are already serialized by lifecycle's
        // operation_lock.
        let taken = {
            let mut guard = self
                .child
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            guard.take()
        };

        let Some((mut child, drained_rx)) = taken else {
            // No child tracked (already stopped / core exited unexpectedly).
            // Still barrier-flush: a final "Disconnected" entry queued after a
            // previous stop must not be left sitting in the writer's buffer.
            log_writer::flush_for_shutdown();
            return Ok(());
        };

        let kill_error = child.kill().err();
        match child.wait() {
            Ok(_) => {
                // A successful wait is the ownership boundary: regardless of a
                // preceding kill error, the child is now confirmed exited and
                // lifecycle may safely remove its generated runtime directory.
                let _ = drained_rx.recv_timeout(READER_DRAIN_TIMEOUT);
                let _ = drained_rx.recv_timeout(READER_DRAIN_TIMEOUT);
                log_writer::flush_for_shutdown();
                Ok(())
            }
            Err(wait_error) => {
                // Do not turn an unconfirmed child into `None`: a later stop or
                // status check must retain the OS handle and ownership metadata
                // until exit can actually be observed.
                let mut guard = self
                    .child
                    .lock()
                    .map_err(|error| format!("Lock error: {error}"))?;
                *guard = Some((child, drained_rx));
                match kill_error {
                    Some(kill_error) => Err(format!(
                        "Failed to kill mihomo: {kill_error}; failed to wait on mihomo: {wait_error}"
                    )),
                    None => Err(format!("Failed to wait on mihomo: {wait_error}")),
                }
            }
        }
    }

    pub fn is_running(&self) -> bool {
        let mut guard = match self.child.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };

        if let Some((ref mut child, _)) = *guard {
            match child.try_wait() {
                Ok(Some(_)) => {
                    // Process has exited
                    *guard = None;
                    false
                }
                Ok(None) => true,
                Err(_) => false,
            }
        } else {
            false
        }
    }

    pub fn get_logs(&self) -> Vec<LogEntry> {
        self.logs
            .lock()
            .map(|l| l.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn clear_logs(&self) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.clear();
        }
    }

    pub fn add_log(&self, level: &str, message: &str) {
        let entry = LogEntry {
            timestamp: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            level: level.to_string(),
            message: redact_log_message(message),
        };

        // In-memory buffer (500-line UI ring)
        if let Ok(mut logs) = self.logs.lock() {
            if logs.len() >= MAX_LOG_LINES {
                logs.pop_front();
            }
            logs.push_back(entry.clone());
        }

        // Persistent file via the shared non-blocking background writer.
        log_writer::enqueue_entry(&entry.timestamp, &entry.level, &entry.message);
    }
}

/// Read one piped output stream to EOF: keep the 500-line in-memory UI ring
/// and hand every line to a persistence sink without touching disk on this
/// thread. The sink is injected so tests can run without the global writer.
fn read_output_into_logs<R, F>(output: R, logs: &Arc<Mutex<VecDeque<LogEntry>>>, persist: F)
where
    R: std::io::Read,
    F: Fn(&LogEntry),
{
    let reader = BufReader::new(output);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let entry = parse_log_line(&line);
        if let Ok(mut buf) = logs.lock() {
            if buf.len() >= MAX_LOG_LINES {
                buf.pop_front();
            }
            buf.push_back(entry.clone());
        }
        persist(&entry);
    }
}

/// Production persistence sink: non-blocking enqueue to the shared writer.
fn persist_to_file(entry: &LogEntry) {
    log_writer::enqueue_entry(&entry.timestamp, &entry.level, &entry.message);
}

/// Parse a mihomo log line. mihomo can output JSON logs like:
/// {"level":"info","msg":"some message","time":"..."}
/// or plain text lines.
fn parse_log_line(line: &str) -> LogEntry {
    let trimmed = line.trim();
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let level = json
            .get("level")
            .and_then(|v| v.as_str())
            .unwrap_or("info")
            .to_string();
        let message = json
            .get("msg")
            .or_else(|| json.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or(trimmed)
            .to_string();
        let timestamp = json
            .get("time")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string());
        LogEntry {
            timestamp,
            level,
            message: redact_log_message(&message),
        }
    } else {
        LogEntry {
            timestamp: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            level: "info".to_string(),
            message: redact_log_message(trimmed),
        }
    }
}

#[cfg(test)]
mod tests;

fn runtime_dir(config_path: &str) -> &str {
    std::path::Path::new(config_path)
        .parent()
        .and_then(|p| p.to_str())
        .unwrap_or(".")
}

/// Core provider failures can contain subscription URLs. Keep diagnostics but
/// never persist URL credentials, query tokens or opaque device paths.
fn redact_log_message(message: &str) -> String {
    let mut result = String::new();
    let mut remaining = message;
    while let Some(marker) = remaining.find("://") {
        let start = remaining[..marker]
            .char_indices()
            .rev()
            .find(|(_, c)| !c.is_ascii_alphanumeric() && *c != '+' && *c != '-' && *c != '.')
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        let end = remaining[marker + 3..]
            .find(|c: char| c.is_whitespace() || matches!(c, '\"' | '\'' | '<' | '>'))
            .map(|i| marker + 3 + i)
            .unwrap_or(remaining.len());
        result.push_str(&remaining[..start]);
        result.push_str("[redacted URL]");
        remaining = &remaining[end..];
    }
    result.push_str(remaining);
    result
}
