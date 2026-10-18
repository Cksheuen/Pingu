//! A launchd network helper authorized at installation. Each connection owns
//! one core and a session-scoped DNS override, both removed on app disconnect.
use serde_json::{json, Value};

#[cfg(target_os = "macos")]
mod dns;
#[cfg(target_os = "macos")]
mod helper;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkMode {
    #[default]
    System,
    Tun,
}

pub fn configure(mode: NetworkMode, value: &mut Value) -> Result<(), String> {
    if mode == NetworkMode::Tun {
        // Mihomo discards the IPv6 TUN address when its global switch is off.
        value["ipv6"] = json!(true);
        value["tun"] = json!({
            "enable": true, "stack": "mixed", "auto-route": true,
            "auto-detect-interface": true, "strict-route": true, "mtu": 1500,
            "dns-hijack": ["any:53", "tcp://any:53"],
            "inet6-address": ["fdfe:dcba:9876::1/126"]
        });
        #[cfg(target_os = "macos")]
        dns::configure(value)?;
    }
    Ok(())
}

pub fn enabled(path: &str) -> bool {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .is_some_and(|v| v["tun"]["enable"] == true)
}

pub fn verify_interface(port: u16) -> Result<(), String> {
    let value = crate::mihomo::controller::request(port, "GET", "/configs", None)?;
    let device = value["tun"]["device"].as_str().unwrap_or("");
    if value["tun"]["enable"] != true || !device.starts_with("utun") {
        return Err("Mihomo did not enable its TUN interface. Check the core logs.".into());
    }
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn if_nametoindex(name: *const std::ffi::c_char) -> u32;
        }
        let name = std::ffi::CString::new(device).map_err(|_| "Invalid TUN interface name")?;
        if unsafe { if_nametoindex(name.as_ptr()) } == 0 {
            return Err("The configured TUN interface is missing from macOS.".into());
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::fs;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::{Component, Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    };
    use std::time::{Duration, Instant};

    unsafe extern "C" {
        fn geteuid() -> u32;
        fn getpeereid(socket: i32, uid: *mut u32, gid: *mut u32) -> i32;
        fn kill(pid: i32, signal: i32) -> i32;
    }

    pub struct PrivilegedProcess {
        control: UnixStream,
        running: Arc<AtomicBool>,
        completed: mpsc::Receiver<Result<(), String>>,
        socket_dir: PathBuf,
    }

    impl PrivilegedProcess {
        pub fn start(config: &str, log: impl Fn(String) + Send + 'static) -> Result<Self, String> {
            let dir = PathBuf::from(format!(
                "/private/tmp/pingu-tun-{}",
                uuid::Uuid::new_v4().simple()
            ));
            fs::create_dir(&dir).map_err(|e| e.to_string())?;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            let socket = dir.join("control");
            let result = Self::launch(config, &socket, log);
            if result.is_err() {
                let _ = fs::remove_dir_all(&dir);
            }
            result
        }

        fn launch(
            config: &str,
            socket: &Path,
            log: impl Fn(String) + Send + 'static,
        ) -> Result<Self, String> {
            // The unprivileged app creates this endpoint. The root worker only
            // connects to it, never chowns or writes a user-controlled path.
            let listener = UnixListener::bind(socket).map_err(|e| e.to_string())?;
            fs::set_permissions(socket, fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
            listener.set_nonblocking(true).map_err(|e| e.to_string())?;
            super::helper::ensure_installed()?;
            super::helper::start(config, socket)?;
            let started = Instant::now();
            let stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(_) if started.elapsed() < Duration::from_secs(10) => {
                        std::thread::sleep(Duration::from_millis(50))
                    }
                    Err(_) => return Err("The authorized TUN worker did not start.".into()),
                }
            };
            let mut uid = 1;
            let mut gid = 0;
            if unsafe { getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != 0 {
                return Err("TUN worker did not have administrator authorization.".into());
            }
            let _ = fs::remove_file(socket);
            let mut reader = control_reader(&stream)?;
            let mut first = String::new();
            reader
                .read_line(&mut first)
                .map_err(|e| format!("TUN worker handshake failed: {e}"))?;
            let event: Value = serde_json::from_str(&first)
                .map_err(|_| "TUN worker did not acknowledge startup")?;
            if event["event"] != "started" {
                return Err(event["error"]
                    .as_str()
                    .unwrap_or("The TUN worker could not launch the bundled core.")
                    .to_owned());
            }
            stream.set_read_timeout(None).map_err(|e| e.to_string())?;
            let running = Arc::new(AtomicBool::new(true));
            let live = running.clone();
            let (tx, completed) = mpsc::channel();
            std::thread::spawn(move || {
                let mut outcome = Err("TUN worker closed without confirming core shutdown.".into());
                for line in reader.lines().map_while(Result::ok) {
                    let Ok(event) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if event["event"] == "exited" {
                        outcome = if event["clean"] == true {
                            Ok(())
                        } else {
                            Err(
                                "TUN core stopped, but its private runtime could not be removed."
                                    .into(),
                            )
                        };
                        break;
                    }
                    if let Some(line) = event["line"].as_str() {
                        log(line.to_owned());
                    }
                }
                live.store(false, Ordering::SeqCst);
                let _ = tx.send(outcome);
            });
            Ok(Self {
                control: stream,
                running,
                completed,
                socket_dir: socket.parent().unwrap().to_owned(),
            })
        }

        pub fn is_running(&self) -> bool {
            self.running.load(Ordering::SeqCst)
        }

        pub fn stop(&mut self) -> Result<(), String> {
            let _ = self.control.write_all(b"stop\n");
            let result = self
                .completed
                .recv_timeout(Duration::from_secs(12))
                .map_err(|_| {
                    "TUN core shutdown could not be confirmed; its runtime was retained."
                        .to_string()
                })?;
            if result.is_ok() {
                let _ = fs::remove_dir_all(&self.socket_dir);
            }
            result
        }
    }

    impl Drop for PrivilegedProcess {
        fn drop(&mut self) {
            let _ = self.control.shutdown(std::net::Shutdown::Both);
        }
    }

    pub(super) fn control_reader(stream: &UnixStream) -> Result<BufReader<UnixStream>, String> {
        // Darwin accept() inherits O_NONBLOCK from the polling listener. The
        // handshake/log reader must wait for frames rather than treating a
        // momentarily empty socket as worker exit.
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|e| e.to_string())?;
        Ok(BufReader::new(
            stream.try_clone().map_err(|e| e.to_string())?,
        ))
    }

    struct RootRuntime(PathBuf);
    impl Drop for RootRuntime {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    pub(super) fn validate_config(value: &Value) -> Result<(), String> {
        // The installed client is callable by its owning user, so the helper
        // must enforce the narrow network-only contract itself. Never accept
        // additional listeners, UI paths, scripts or other root side effects.
        const ALLOWED: &[&str] = &[
            "mixed-port",
            "allow-lan",
            "bind-address",
            "mode",
            "log-level",
            "ipv6",
            "external-controller",
            "secret",
            "profile",
            "find-process-mode",
            "dns",
            "proxies",
            "proxy-groups",
            "proxy-providers",
            "rule-providers",
            "rules",
            "tun",
            "pingu-vps-egress",
        ];
        if value
            .as_object()
            .is_none_or(|fields| fields.keys().any(|key| !ALLOWED.contains(&key.as_str())))
        {
            return Err("Unsupported field in privileged network configuration".into());
        }
        const TUN_FIELDS: &[&str] = &[
            "enable",
            "stack",
            "auto-route",
            "auto-detect-interface",
            "strict-route",
            "mtu",
            "dns-hijack",
            "inet6-address",
        ];
        if value["tun"]
            .as_object()
            .is_none_or(|fields| fields.keys().any(|key| !TUN_FIELDS.contains(&key.as_str())))
        {
            return Err("Unsupported privileged TUN option".into());
        }
        if value["tun"]["enable"] != true
            || value["allow-lan"] != false
            || value["bind-address"] != "127.0.0.1"
            || !value["external-controller"]
                .as_str()
                .is_some_and(|v| v.starts_with("127.0.0.1:"))
            || value["secret"].as_str().is_none_or(|v| v.len() < 16)
        {
            return Err("TUN requires Pingu's private generated configuration".into());
        }
        for key in ["proxy-providers", "rule-providers"] {
            for provider in value[key].as_object().into_iter().flat_map(|v| v.values()) {
                if let Some(path) = provider["path"].as_str() {
                    if Path::new(path).is_absolute()
                        || Path::new(path)
                            .components()
                            .any(|p| !matches!(p, Component::Normal(_)))
                    {
                        return Err(
                            "Provider cache paths must stay in the runtime directory".into()
                        );
                    }
                }
            }
        }
        Ok(())
    }

    fn event(writer: &Arc<Mutex<UnixStream>>, value: Value) {
        if let Ok(mut stream) = writer.lock() {
            let _ = writeln!(stream, "{value}");
        }
    }

    struct Core(Child);
    impl Core {
        fn terminate(&mut self) -> Result<(), String> {
            if self.0.try_wait().map_err(|e| e.to_string())?.is_some() {
                return Ok(());
            }
            unsafe {
                kill(self.0.id() as i32, 15);
            }
            let deadline = Instant::now() + Duration::from_secs(7);
            while Instant::now() < deadline {
                if self.0.try_wait().map_err(|e| e.to_string())?.is_some() {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            self.0.kill().map_err(|e| e.to_string())?;
            self.0.wait().map_err(|e| e.to_string())?;
            Ok(())
        }
    }
    impl Drop for Core {
        fn drop(&mut self) {
            let _ = self.terminate();
        }
    }

    pub(super) fn worker(config: &Path, socket: &Path, owner: u32) -> Result<(), String> {
        if unsafe { geteuid() } != 0 {
            return Err("TUN worker requires administrator authorization".into());
        }
        let runtime = config.parent().ok_or("Missing runtime directory")?;
        let socket_dir = socket.parent().ok_or("Missing control directory")?;
        let meta = fs::symlink_metadata(runtime).map_err(|e| e.to_string())?;
        let control_meta = fs::symlink_metadata(socket_dir).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink()
            || control_meta.file_type().is_symlink()
            || meta.uid() == 0
            || meta.uid() != owner
            || meta.uid() != control_meta.uid()
            || meta.mode() & 0o077 != 0
            || control_meta.mode() & 0o077 != 0
            || !runtime
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("runtime-"))
            || config.file_name().is_none_or(|n| n != "config.json")
        {
            return Err("Untrusted TUN runtime ownership".into());
        }
        // Check the opened inode before reading, not a path subsequently
        // reopened as root. The core later receives a root-owned snapshot.
        let source = fs::File::open(config).map_err(|e| e.to_string())?;
        let file = source.metadata().map_err(|e| e.to_string())?;
        if !file.is_file()
            || file.uid() != meta.uid()
            || file.mode() & 0o077 != 0
            || file.len() > 4 * 1024 * 1024
        {
            return Err("Untrusted TUN configuration file".into());
        }
        let mut payload = Vec::new();
        source
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut payload)
            .map_err(|e| e.to_string())?;
        let mut value: Value = serde_json::from_slice(&payload).map_err(|e| e.to_string())?;
        validate_config(&value)?;
        let dns_port = super::dns::prepare(&mut value)?;
        let payload = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        let stream = UnixStream::connect(socket).map_err(|e| e.to_string())?;
        let mut uid = 0;
        let mut gid = 0;
        if unsafe { getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != meta.uid() {
            return Err("TUN control socket belongs to another user".into());
        }
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        let writer = Arc::new(Mutex::new(stream.try_clone().map_err(|e| e.to_string())?));
        let root_path = PathBuf::from(format!(
            "/private/var/run/pingu-tun-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir(&root_path).map_err(|e| e.to_string())?;
        let root = RootRuntime(root_path);
        fs::set_permissions(&root.0, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let root_config = root.0.join("config.json");
        crate::mihomo::private_write(&root_config, &payload)?;
        let binary = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("Missing bundle")?
            .join("mihomo");
        let mut child = Core(
            Command::new(binary)
                .args(["-f"])
                .arg(&root_config)
                .arg("-d")
                .arg(&root.0)
                .env_clear()
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .env("HOME", &root.0)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?,
        );
        let dns_session = match super::dns::Session::start(dns_port) {
            Ok(session) => session,
            Err(error) => {
                event(&writer, json!({"event":"failed", "error":error}));
                return Err(error);
            }
        };
        event(&writer, json!({"event":"started"}));
        let outputs: Vec<Box<dyn std::io::Read + Send>> = vec![
            Box::new(child.0.stdout.take().unwrap()),
            Box::new(child.0.stderr.take().unwrap()),
        ];
        let mut readers = Vec::new();
        for output in outputs {
            let writer = writer.clone();
            readers.push(std::thread::spawn(move || {
                for line in BufReader::new(output).lines().map_while(Result::ok) {
                    event(&writer, json!({"line":line}));
                }
            }));
        }
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            // EOF (app crash/exit) has the same meaning as an explicit stop.
            let _ = BufReader::new(stream).read_line(&mut line);
            let _ = tx.send(());
        });
        loop {
            if rx.recv_timeout(Duration::from_millis(100)).is_ok()
                || super::helper::shutting_down()
                || child.0.try_wait().map_err(|e| e.to_string())?.is_some()
            {
                break;
            }
        }
        // Release only our DNS session before closing its resolver.
        drop(dns_session);
        let stopped = child.terminate();
        for reader in readers {
            let _ = reader.join();
        }
        let restored = fs::remove_dir_all(&root.0).map_err(|e| e.to_string());
        event(
            &writer,
            json!({"event":"exited", "clean":stopped.is_ok() && restored.is_ok()}),
        );
        stopped.and(restored)
    }
}

#[cfg(target_os = "macos")]
pub use macos::PrivilegedProcess;

/// Handle this before initializing Tauri, plugins, configuration or the UI.
pub fn worker_entry() -> Option<i32> {
    let args: Vec<_> = std::env::args_os().collect();
    let mode = args.get(1).and_then(|v| v.to_str());
    if !matches!(
        mode,
        Some("--pingu-network-helper" | "--pingu-network-client")
    ) {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        let result = match mode {
            Some("--pingu-network-helper") if args.len() == 2 => helper::run(),
            Some("--pingu-network-client") => helper::client(&args[2..]),
            _ => Err("Invalid network component arguments".into()),
        };
        return Some(match result {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("{error}");
                1
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    Some(1)
}

#[cfg(test)]
mod tests;
