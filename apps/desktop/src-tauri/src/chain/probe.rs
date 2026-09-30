//! Bounded diagnostics on private listeners, independent of the system proxy.
use super::EXIT;
use serde_json::{json, Value};
use std::{
    net::{TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

pub(super) static TEST_LOCK: Mutex<()> = Mutex::new(());
pub(super) static CANCELLED: AtomicBool = AtomicBool::new(false);
pub fn cancel() -> bool {
    super::latency::request_cancel()
}
pub(super) fn check_cancelled() -> Result<(), String> {
    if CANCELLED.load(Ordering::SeqCst) {
        Err("Comparison cancelled.".into())
    } else {
        Ok(())
    }
}

pub struct IsolatedRuntime {
    pub port: u16,
    child: Child,
    dir: PathBuf,
}
impl IsolatedRuntime {
    pub fn single(mut node: Value) -> Result<Self, String> {
        node["name"] = json!(EXIT);
        Self::start(vec![node])
    }
    pub fn start(proxies: Vec<Value>) -> Result<Self, String> {
        let reservation =
            TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "Cannot allocate diagnostic port")?;
        let port = reservation
            .local_addr()
            .map_err(|_| "Cannot read diagnostic port")?
            .port();
        let dir = std::env::temp_dir().join(format!("pingu-chain-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).map_err(|_| "Cannot create diagnostic directory")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).is_err() {
                let _ = std::fs::remove_dir(&dir);
                return Err("Cannot secure diagnostic directory".into());
            }
        }
        let path = dir.join("config.json");
        let value = json!({"mixed-port":port,"bind-address":"127.0.0.1","allow-lan":false,"mode":"rule","log-level":"silent","ipv6":false,"proxies":proxies,"rules":[format!("MATCH,{EXIT}")],"dns":{"enable":false}});
        if let Err(error) = crate::mihomo::private_write(&path, value.to_string().as_bytes()) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(error);
        }
        drop(reservation);
        let child = Command::new(crate::resolve_mihomo_path())
            .args(["-f"])
            .arg(&path)
            .arg("-d")
            .arg(&dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let child = match child {
            Ok(c) => c,
            Err(_) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(crate::missing_mihomo_message());
            }
        };
        let mut runtime = Self { port, child, dir };
        let start = Instant::now();
        loop {
            if runtime
                .child
                .try_wait()
                .map_err(|_| "Cannot inspect diagnostic runtime")?
                .is_some()
            {
                return Err(
                    "Mihomo rejected the selected route. Check its protocol and node options."
                        .into(),
                );
            }
            if TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_millis(60))
                .is_ok()
            {
                return Ok(runtime);
            }
            if start.elapsed() > Duration::from_secs(5) {
                return Err("Diagnostic listener did not start.".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
impl Drop for IsolatedRuntime {
    fn drop(&mut self) {
        let _ = self.child.kill();
        if self.child.wait().is_ok() {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

pub use super::latency::{compare, Comparison};
