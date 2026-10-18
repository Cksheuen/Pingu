//! Only the installing user's immutable, installed client may ask this helper
//! to start a core. GUI signatures are deliberately outside this trust boundary. Executables and launchd metadata are copied into root-owned
//! locations at installation; requests never contain an executable or command.
use core_foundation::{
    base::{CFType, CFTypeRef, TCFType},
    dictionary::CFDictionary,
    number::CFNumber,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{MetadataExt, PermissionsExt},
            net::{UnixListener, UnixStream},
        },
    },
    path::Path,
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

const LABEL: &str = "com.pingu.network";
const ROOT: &str = "/Library/PrivilegedHelperTools/com.pingu.network";
const SOCKET: &str = "/private/var/run/pingu-network/control.sock";
const BRIDGE: &str =
    "/Library/PrivilegedHelperTools/com.pingu.network/Pingu.app/Contents/MacOS/pingu";
const PROTOCOL: &str = "/Library/PrivilegedHelperTools/com.pingu.network/client-protocol";
const PLIST: &str = "/Library/LaunchDaemons/com.pingu.network.plist";
static STOP: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);
unsafe extern "C" {
    fn geteuid() -> u32;
    fn getpeereid(fd: i32, uid: *mut u32, gid: *mut u32) -> i32;
    fn getsockopt(fd: i32, level: i32, name: i32, value: *mut i32, len: *mut u32) -> i32;
    fn chown(path: *const i8, uid: u32, gid: u32) -> i32;
    fn signal(sig: i32, handler: extern "C" fn(i32)) -> usize;
}
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    static kSecGuestAttributePid: CFTypeRef;
    fn SecCodeCopySelf(flags: u32, code: *mut CFTypeRef) -> i32;
    fn SecCodeCopyDesignatedRequirement(
        code: CFTypeRef,
        flags: u32,
        requirement: *mut CFTypeRef,
    ) -> i32;
    fn SecCodeCopyGuestWithAttributes(
        host: CFTypeRef,
        attributes: CFTypeRef,
        flags: u32,
        code: *mut CFTypeRef,
    ) -> i32;
    fn SecCodeCheckValidity(code: CFTypeRef, flags: u32, requirement: CFTypeRef) -> i32;
}
fn cf_result(code: i32, value: CFTypeRef) -> Result<CFType, String> {
    if code != 0 || value.is_null() {
        return Err(format!(
            "Network helper code identity check failed ({code})"
        ));
    }
    Ok(unsafe { CFType::wrap_under_create_rule(value) })
}
fn own_requirement() -> Result<CFType, String> {
    let mut value = std::ptr::null();
    let code = unsafe { SecCodeCopySelf(0, &mut value) };
    let own = cf_result(code, value)?;
    let code = unsafe { SecCodeCopyDesignatedRequirement(own.as_CFTypeRef(), 0, &mut value) };
    cf_result(code, value)
}
fn authorize(stream: &UnixStream, owner: u32, requirement: &CFType) -> Result<(), String> {
    let (mut uid, mut gid, mut pid, mut len) = (0, 0, 0, 4);
    // SOL_LOCAL / LOCAL_PEERPID: PID is supplied by the kernel, not the client.
    if unsafe { getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
        || uid != owner
        || unsafe { getsockopt(stream.as_raw_fd(), 0, 2, &mut pid, &mut len) } != 0
        || pid <= 0
    {
        return Err("Network helper rejected the caller".into());
    }
    let key = unsafe { CFType::wrap_under_get_rule(kSecGuestAttributePid) };
    let attributes = CFDictionary::from_CFType_pairs(&[(key, CFNumber::from(pid).as_CFType())]);
    let mut value = std::ptr::null();
    let code = unsafe {
        SecCodeCopyGuestWithAttributes(std::ptr::null(), attributes.as_CFTypeRef(), 0, &mut value)
    };
    let peer = cf_result(code, value)?;
    if unsafe { SecCodeCheckValidity(peer.as_CFTypeRef(), 0, requirement.as_CFTypeRef()) } != 0 {
        return Err("Pingu network helper needs installation for this app version".into());
    }
    Ok(())
}
fn request(value: Value) -> Result<(), String> {
    let mut stream = UnixStream::connect(SOCKET).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(4)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(4)))
        .map_err(|e| e.to_string())?;
    let (mut uid, mut gid) = (1, 0);
    if unsafe { getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != 0 {
        return Err("Untrusted network helper endpoint".into());
    }
    writeln!(stream, "{value}").map_err(|e| e.to_string())?;
    let response = read_frame(&stream)?;
    if response["ok"] == true {
        Ok(())
    } else {
        Err(response["error"]
            .as_str()
            .unwrap_or("Network helper did not acknowledge the request")
            .to_string())
    }
}
fn read_frame(stream: &UnixStream) -> Result<Value, String> {
    let mut line = String::new();
    BufReader::new(stream.take(8193))
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if line.len() > 8192 || !line.ends_with('\n') {
        return Err("Invalid helper frame".into());
    }
    serde_json::from_str(&line).map_err(|_| "Invalid helper request".into())
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn installed_bridge() -> Result<bool, String> {
    let metadata = match fs::symlink_metadata(PROTOCOL) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Cannot inspect the installed network helper: {error}"
            ))
        }
    };
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o022 != 0
        || metadata.len() > 16
    {
        return Err("Untrusted network helper installation metadata".into());
    }
    if fs::read_to_string(PROTOCOL)
        .map_err(|e| e.to_string())?
        .trim()
        != "1"
    {
        return Err("The installed network helper protocol is incompatible".into());
    }
    for path in [ROOT, BRIDGE] {
        let meta = fs::symlink_metadata(path)
            .map_err(|e| format!("Network helper installation is incomplete: {e}"))?;
        if meta.file_type().is_symlink() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
            return Err("Untrusted installed network client".into());
        }
    }
    Ok(true)
}
fn bridge_request(args: &[&std::ffi::OsStr]) -> Result<(), String> {
    // This executable stays root-owned and stable across GUI updates. It runs
    // as the normal user and exposes only ping/start; it is NOT setuid.
    let output = Command::new(BRIDGE)
        .arg("--pingu-network-client")
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("Cannot run the installed network client: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "Network helper is installed but unavailable: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let response: Value =
        serde_json::from_slice(&output.stdout).map_err(|_| "Invalid network client response")?;
    if response["ok"] != true || response["protocol"] != 1 {
        return Err("Incompatible network client response".into());
    }
    Ok(())
}
pub(super) fn client(args: &[std::ffi::OsString]) -> Result<(), String> {
    let request_value = match args {
        [action] if action == "ping" => json!({"action":"ping"}),
        [action, config, socket] if action == "start" => {
            if !Path::new(config).is_absolute() || !Path::new(socket).is_absolute() {
                return Err("Network client requires absolute private runtime paths".into());
            }
            json!({"action":"start", "config":config.to_str().ok_or("Invalid config path")?, "socket":socket.to_str().ok_or("Invalid control path")?})
        }
        _ => return Err("Unsupported network client operation".into()),
    };
    request(request_value)?;
    println!("{}", json!({"ok":true,"protocol":1}));
    Ok(())
}
pub(super) fn ensure_installed() -> Result<(), String> {
    ensure_ready(
        installed_bridge()?,
        || bridge_request(&[std::ffi::OsStr::new("ping")]),
        install,
    )
}
fn ensure_ready(
    installed: bool,
    mut ping: impl FnMut() -> Result<(), String>,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if installed {
        // An unavailable service is an operational error, not a reason to
        // reinstall or ask the user for authorization on every connection.
        return ping();
    }
    install()?;
    let until = Instant::now() + Duration::from_secs(8);
    loop {
        match ping() {
            Ok(()) => return Ok(()),
            Err(error) if Instant::now() >= until => return Err(error),
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}
fn install() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let core = exe.parent().ok_or("Missing Pingu bundle")?.join("mihomo");
    if !core.is_file() {
        return Err("Bundled Mihomo is missing".into());
    }
    let bundle = exe
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or("Missing Pingu application bundle")?;
    if !bundle.join("Contents/Info.plist").is_file() {
        return Err("Install Pingu.app before enabling TUN".into());
    }
    let stage = format!("{ROOT}/.Pingu-{}.app", uuid::Uuid::new_v4());
    let uid = unsafe { geteuid() };
    if uid == 0 {
        return Err("Launch Pingu as your normal user".into());
    }
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>{LABEL}</string><key>ProgramArguments</key><array><string>{ROOT}/Pingu.app/Contents/MacOS/pingu</string><string>--pingu-network-helper</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>15</integer><key>ProcessType</key><string>Background</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict></dict></plist>"#
    );
    // Everything executable after installation is root-owned. No sudoers,
    // setuid executable, cached password, or user-writable launch target.
    let script = format!(
        r#"set -eu
/usr/bin/install -d -o root -g wheel -m 755 {ROOT}
/usr/bin/ditto {} {stage}
/usr/sbin/chown -R root:wheel {stage}
/bin/chmod -R go-w {stage}
/usr/bin/codesign --verify --deep --strict {stage}
/bin/launchctl bootout system/{LABEL} >/dev/null 2>&1 || true
/bin/rm -rf {ROOT}/Pingu.previous.app
if test -d {ROOT}/Pingu.app; then /bin/mv {ROOT}/Pingu.app {ROOT}/Pingu.previous.app; fi
/bin/mv {stage} {ROOT}/Pingu.app
/usr/bin/printf '%s' {} > {ROOT}/owner
/usr/sbin/chown root:wheel {ROOT}/owner
/bin/chmod 600 {ROOT}/owner
/usr/bin/printf '%s' '1' > {PROTOCOL}
/usr/sbin/chown root:wheel {PROTOCOL}
/bin/chmod 644 {PROTOCOL}
/usr/bin/printf '%s' {} > {PLIST}
/usr/sbin/chown root:wheel {PLIST}
/bin/chmod 644 {PLIST}
/bin/launchctl bootstrap system {PLIST}
/bin/rm -f {ROOT}/pingu {ROOT}/mihomo"#,
        quote(&bundle.to_string_lossy()),
        quote(&uid.to_string()),
        quote(&plist)
    );
    let apple = format!("with timeout of 300 seconds\ndo shell script {} with administrator privileges\nend timeout", serde_json::to_string(&script).map_err(|e| e.to_string())?);
    let output = Command::new("/usr/bin/osascript")
        .args(["-e", &apple])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Network helper installation was cancelled or failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if !installed_bridge()? {
        return Err("Network client installation was not completed".into());
    }
    Ok(())
}
pub(super) fn start(config: &str, socket: &Path) -> Result<(), String> {
    if !installed_bridge()? {
        return Err("Network helper has not been installed".into());
    }
    bridge_request(&[
        std::ffi::OsStr::new("start"),
        std::ffi::OsStr::new(config),
        socket.as_os_str(),
    ])
}

extern "C" fn stop_signal(_: i32) {
    STOP.store(true, Ordering::SeqCst);
}
pub(super) fn shutting_down() -> bool {
    STOP.load(Ordering::SeqCst)
}
struct Busy;
impl Drop for Busy {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}
pub(super) fn run() -> Result<(), String> {
    if unsafe { geteuid() } != 0 {
        return Err("Network helper must be started by launchd as root".into());
    }
    let owner: u32 = fs::read_to_string(format!("{ROOT}/owner"))
        .map_err(|e| e.to_string())?
        .parse()
        .map_err(|_| "Invalid helper owner")?;
    if owner == 0 {
        return Err("Invalid helper owner".into());
    }
    let requirement = own_requirement()?;
    let dir = Path::new(SOCKET).parent().unwrap();
    if !dir.exists() {
        fs::create_dir(dir).map_err(|e| e.to_string())?;
    }
    let meta = fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.uid() != 0 || meta.mode() & 0o022 != 0 {
        return Err("Untrusted helper socket directory".into());
    }
    if Path::new(SOCKET).exists() {
        fs::remove_file(SOCKET).map_err(|e| e.to_string())?;
    }
    let listener = UnixListener::bind(SOCKET).map_err(|e| e.to_string())?;
    fs::set_permissions(SOCKET, fs::Permissions::from_mode(0o600)).map_err(|e| e.to_string())?;
    let path = std::ffi::CString::new(SOCKET).unwrap();
    if unsafe { chown(path.as_ptr(), owner, u32::MAX) } != 0 {
        return Err("Cannot assign helper socket owner".into());
    }
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    unsafe {
        signal(15, stop_signal);
        signal(2, stop_signal);
    }
    let mut active: Option<std::thread::JoinHandle<()>> = None;
    while !shutting_down() {
        let (mut stream, _) = match listener.accept() {
            Ok(value) => value,
            Err(_) => {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
        };
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .map_err(|e| e.to_string())?;
        let result: Result<(), String> = (|| {
            authorize(&stream, owner, &requirement)?;
            let request = read_frame(&stream)?;
            match request["action"].as_str() {
                Some("ping") => Ok(()),
                Some("start") => {
                    let config = request["config"]
                        .as_str()
                        .ok_or("Missing config")?
                        .to_owned();
                    let socket = request["socket"]
                        .as_str()
                        .ok_or("Missing control socket")?
                        .to_owned();
                    if BUSY.swap(true, Ordering::SeqCst) {
                        return Err("A Pingu TUN connection is already running".into());
                    }
                    if let Some(thread) = active.take() {
                        let _: std::thread::Result<()> = thread.join();
                    }
                    active = Some(std::thread::spawn(move || {
                        let _guard = Busy;
                        if let Err(error) =
                            super::macos::worker(Path::new(&config), Path::new(&socket), owner)
                        {
                            eprintln!("TUN worker: {error}");
                        }
                    }));
                    Ok(())
                }
                _ => Err("Unsupported network helper operation".into()),
            }
        })();
        let response = match result {
            Ok(()) => json!({"ok":true}),
            Err(error) => json!({"ok":false,"error":error}),
        };
        let _ = writeln!(stream, "{response}");
    }
    if let Some(thread) = active {
        let _ = thread.join();
    }
    let _ = fs::remove_file(SOCKET);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn existing_helper_errors_never_request_installation_authorization() {
        let error = ensure_ready(
            true,
            || Err("service is unavailable".into()),
            || panic!("must not request administrator authorization"),
        )
        .unwrap_err();
        assert_eq!(error, "service is unavailable");
        ensure_ready(
            true,
            || Ok(()),
            || panic!("a GUI update must reuse the installed client"),
        )
        .unwrap();
    }
    #[test]
    fn client_cannot_dispatch_commands_or_relative_runtime_paths() {
        assert!(client(&["exec".into(), "/bin/sh".into()]).is_err());
        assert!(client(&["start".into(), "config.json".into(), "/tmp/socket".into()]).is_err());
    }
    #[test]
    fn helper_rejects_another_user_and_bounds_frames() {
        let (a, mut b) = UnixStream::pair().unwrap();
        let requirement = own_requirement().unwrap();
        assert!(authorize(&a, u32::MAX, &requirement).is_err());
        let writer = std::thread::spawn(move || b.write_all(&vec![b'x'; 8193]).unwrap());
        assert!(read_frame(&a).is_err());
        writer.join().unwrap();
    }
    #[test]
    fn helper_rejects_a_different_signed_binary() {
        use std::process::Stdio;
        let dir = std::path::PathBuf::from("/private/tmp")
            .join(format!("pingu-reject-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("socket");
        let listener = UnixListener::bind(&path).unwrap();
        let mut child = Command::new("/usr/bin/nc")
            .arg("-U")
            .arg(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let (stream, _) = listener.accept().unwrap();
        assert!(authorize(&stream, unsafe { geteuid() }, &own_requirement().unwrap()).is_err());
        child.kill().unwrap();
        child.wait().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn helper_accepts_the_same_signed_running_binary() {
        // socketpair's LOCAL_PEERPID is not set on Darwin; a real listener is required.
        let dir = std::path::PathBuf::from("/private/tmp")
            .join(format!("pingu-auth-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("socket");
        let listener = UnixListener::bind(&path).unwrap();
        let _client = UnixStream::connect(&path).unwrap();
        let (stream, _) = listener.accept().unwrap();
        authorize(&stream, unsafe { geteuid() }, &own_requirement().unwrap()).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
}
