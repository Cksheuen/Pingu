use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

const MAX_LOG_LINES: usize = 500;

/// Return the path to today's log file under `~/.config/sing-proxy/logs/`.
pub fn log_file_path() -> std::path::PathBuf {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("sing-proxy")
        .join("logs");
    std::fs::create_dir_all(&dir).ok();
    let date = chrono::Local::now().format("%Y-%m-%d");
    dir.join(format!("sing-proxy-{}.log", date))
}

/// Delete log files older than 7 days.
fn cleanup_old_logs() {
    let dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("sing-proxy")
        .join("logs");
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let cutoff = chrono::Local::now() - chrono::Duration::days(7);
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(date_str) = name
                .strip_prefix("sing-proxy-")
                .and_then(|s| s.strip_suffix(".log"))
            {
                if let Ok(date) = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
                    if date < cutoff.date_naive() {
                        std::fs::remove_file(entry.path()).ok();
                    }
                }
            }
        }
    }
}

/// Append a formatted log line to the current day's log file.
fn append_to_log_file(entry: &LogEntry) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_file_path())
    {
        writeln!(
            file,
            "[{}] [{}] {}",
            entry.timestamp, entry.level, entry.message
        )
        .ok();
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

pub struct SingBoxProcess {
    child: Mutex<Option<Child>>,
    logs: Arc<Mutex<VecDeque<LogEntry>>>,
}

impl SingBoxProcess {
    pub fn new() -> Self {
        cleanup_old_logs();
        Self {
            child: Mutex::new(None),
            logs: Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LOG_LINES))),
        }
    }

    pub fn start(&self, config_path: &str) -> Result<(), String> {
        let mut guard = self
            .child
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        if guard.is_some() {
            return Err("sing-box is already running".into());
        }

        // Clear old logs
        if let Ok(mut logs) = self.logs.lock() {
            logs.clear();
        }

        let mut child = Command::new(crate::resolve_sing_box_path())
            .args(["run", "-c", config_path])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    crate::missing_sing_box_message()
                } else {
                    format!("Failed to start sing-box: {}", e)
                }
            })?;

        // Capture stderr in a background thread (sing-box logs to stderr)
        if let Some(stderr) = child.stderr.take() {
            let logs = Arc::clone(&self.logs);
            thread::spawn(move || {
                let reader = BufReader::new(stderr);
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
                    append_to_log_file(&entry);
                }
            });
        }

        // Capture stdout similarly
        if let Some(stdout) = child.stdout.take() {
            let logs = Arc::clone(&self.logs);
            thread::spawn(move || {
                let reader = BufReader::new(stdout);
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
                    append_to_log_file(&entry);
                }
            });
        }

        *guard = Some(child);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self
            .child
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;

        if let Some(mut child) = guard.take() {
            child
                .kill()
                .map_err(|e| format!("Failed to kill sing-box: {}", e))?;
            child
                .wait()
                .map_err(|e| format!("Failed to wait on sing-box: {}", e))?;
        }

        Ok(())
    }

    pub fn is_running(&self) -> bool {
        let mut guard = match self.child.lock() {
            Ok(g) => g,
            Err(_) => return false,
        };

        if let Some(ref mut child) = *guard {
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
            message: message.to_string(),
        };

        // In-memory buffer
        if let Ok(mut logs) = self.logs.lock() {
            if logs.len() >= MAX_LOG_LINES {
                logs.pop_front();
            }
            logs.push_back(entry.clone());
        }

        // File persistence
        append_to_log_file(&entry);
    }
}

/// Parse a sing-box log line. sing-box can output JSON logs like:
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
            message,
        }
    } else {
        LogEntry {
            timestamp: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            level: "info".to_string(),
            message: trimmed.to_string(),
        }
    }
}
