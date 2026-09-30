use std::process::Command;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct ProxySettings {
    enabled: bool,
    server: String,
    port: Option<u16>,
    authenticated: bool,
}

pub fn get_active_network_service() -> Result<String, String> {
    // Get the default route interface
    let route_output = Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .map_err(|e| format!("Failed to run route: {}", e))?;

    let route_str = String::from_utf8_lossy(&route_output.stdout);

    let interface = route_str
        .lines()
        .find(|line| line.contains("interface:"))
        .and_then(|line| line.split(':').nth(1))
        .map(|s| s.trim().to_string());

    let interface = match interface {
        Some(iface) => iface,
        None => return Ok("Wi-Fi".into()),
    };

    // Map interface name to network service name
    let ns_output = Command::new("networksetup")
        .args(["-listnetworkserviceorder"])
        .output()
        .map_err(|e| format!("Failed to run networksetup: {}", e))?;

    let ns_str = String::from_utf8_lossy(&ns_output.stdout);

    // Parse output: lines like "(Hardware Port: Wi-Fi, Device: en0)"
    // preceded by the service name line like "(1) Wi-Fi"
    let lines: Vec<&str> = ns_str.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if line.contains(&format!("Device: {}", interface)) {
            // The service name is on the previous line
            if i > 0 {
                let service_line = lines[i - 1];
                // Strip the leading "(N) " prefix
                if let Some(pos) = service_line.find(')') {
                    let name = service_line[pos + 1..].trim();
                    if !name.is_empty() {
                        return Ok(name.to_string());
                    }
                }
            }
        }
    }

    Ok("Wi-Fi".into())
}

#[derive(Clone, Copy, Debug)]
enum Kind {
    Http,
    Https,
    Socks,
}
const KINDS: [Kind; 3] = [Kind::Http, Kind::Https, Kind::Socks];
impl Kind {
    fn commands(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Kind::Http => ("-getwebproxy", "-setwebproxy", "-setwebproxystate"),
            Kind::Https => (
                "-getsecurewebproxy",
                "-setsecurewebproxy",
                "-setsecurewebproxystate",
            ),
            Kind::Socks => (
                "-getsocksfirewallproxy",
                "-setsocksfirewallproxy",
                "-setsocksfirewallproxystate",
            ),
        }
    }
}
#[derive(Clone, Debug)]
struct Lease {
    service: String,
    before: [ProxySettings; 3],
    owned: [Option<ProxySettings>; 3],
}
static LEASE: std::sync::Mutex<Option<Lease>> = std::sync::Mutex::new(None);
trait ProxyIo {
    fn service(&mut self) -> Result<String, String>;
    fn read(&mut self, service: &str, kind: Kind) -> Result<ProxySettings, String>;
    fn write(&mut self, service: &str, kind: Kind, settings: &ProxySettings) -> Result<(), String>;
}
struct NetworkSetup;
impl ProxyIo for NetworkSetup {
    fn service(&mut self) -> Result<String, String> {
        get_active_network_service()
    }
    fn read(&mut self, service: &str, kind: Kind) -> Result<ProxySettings, String> {
        parse_proxy_settings(&run_networksetup_output(&[kind.commands().0, service])?)
    }
    fn write(&mut self, service: &str, kind: Kind, settings: &ProxySettings) -> Result<(), String> {
        let (_, set, toggle) = kind.commands();
        if !settings.server.is_empty() && settings.port.is_some_and(|p| p > 0) {
            run_networksetup(&[
                set,
                service,
                &settings.server,
                &settings.port.unwrap().to_string(),
            ])?;
        }
        run_networksetup(&[toggle, service, if settings.enabled { "on" } else { "off" }])?;
        let current = self.read(service, kind)?;
        // macOS may retain an unused address when a previously empty proxy is
        // disabled. Only enabled endpoints affect traffic.
        if current.enabled != settings.enabled || (settings.enabled && current != *settings) {
            return Err(format!("Proxy verification failed for {service}"));
        }
        Ok(())
    }
}
pub fn set_system_proxy(port: u16) -> Result<(), String> {
    let mut lease = LEASE
        .lock()
        .map_err(|_| "Proxy ownership state unavailable")?;
    acquire(&mut lease, &mut NetworkSetup, port)
}
pub fn clear_system_proxy() -> Result<(), String> {
    let mut lease = LEASE
        .lock()
        .map_err(|_| "Proxy ownership state unavailable")?;
    release(&mut lease, &mut NetworkSetup)
}
fn read_all(io: &mut impl ProxyIo, service: &str) -> Result<[ProxySettings; 3], String> {
    Ok([
        io.read(service, Kind::Http)?,
        io.read(service, Kind::Https)?,
        io.read(service, Kind::Socks)?,
    ])
}
/// A hot swap updates only settings still held by this process. Never use a
/// mere "was connected" flag as permission to reclaim another client's proxy.
fn acquire(state: &mut Option<Lease>, io: &mut impl ProxyIo, port: u16) -> Result<(), String> {
    let service = io.service()?;
    let prior = read_all(io, &service)?;
    let previous = state.clone();
    if let Some(lease) = &previous {
        if lease.service != service
            || lease
                .owned
                .iter()
                .zip(&prior)
                .any(|(owned, actual)| owned.as_ref() != Some(actual))
        {
            return Err("System proxy changed outside Pingu. Current settings were kept; disconnect Pingu before reconnecting.".into());
        }
    } else if prior.iter().any(|p| p.authenticated) {
        // networksetup cannot retrieve credentials, so it cannot safely restore
        // an authenticated proxy after replacing its endpoint.
        return Err("An authenticated system proxy is configured. Pingu left it unchanged.".into());
    }
    let desired = ProxySettings {
        enabled: true,
        server: "127.0.0.1".into(),
        port: Some(port),
        authenticated: false,
    };
    *state = Some(previous.clone().unwrap_or(Lease {
        service: service.clone(),
        before: prior.clone(),
        owned: std::array::from_fn(|_| None),
    }));
    for (index, kind) in KINDS.iter().copied().enumerate() {
        let result = (|| {
            if io.read(&service, kind)? != prior[index] {
                return Err("System proxy changed while Pingu was connecting.".into());
            }
            state.as_mut().unwrap().owned[index] = Some(desired.clone());
            io.write(&service, kind, &desired)
        })();
        if let Err(error) = result {
            let mut rollback_failed = false;
            for (i, kind) in KINDS.iter().copied().enumerate().take(index + 1) {
                match io.read(&service, kind) {
                    Ok(current) if current == desired => {
                        if io.write(&service, kind, &prior[i]).is_err() {
                            rollback_failed = true;
                            continue;
                        }
                    }
                    Ok(_) => {} // Another client owns this field now.
                    Err(_) => {
                        rollback_failed = true;
                        continue;
                    }
                }
                state.as_mut().unwrap().owned[i] =
                    previous.as_ref().and_then(|p| p.owned[i].clone());
            }
            if !rollback_failed {
                *state = previous;
            }
            return Err(if rollback_failed {
                format!("{error} Some proxy settings still require restoration.")
            } else {
                error
            });
        }
    }
    Ok(())
}
/// Restore the original service, even after Wi-Fi/Ethernet/default-route changes.
/// Compare each field immediately before writing so another VPN's values survive.
fn release(state: &mut Option<Lease>, io: &mut impl ProxyIo) -> Result<(), String> {
    let Some(lease) = state.as_mut() else {
        return Ok(());
    };
    let mut errors = Vec::new();
    for (index, kind) in KINDS.iter().copied().enumerate() {
        let Some(owned) = lease.owned[index].as_ref() else {
            continue;
        };
        match io.read(&lease.service, kind) {
            Ok(current) if &current == owned => {
                if let Err(error) = io.write(&lease.service, kind, &lease.before[index]) {
                    errors.push(error);
                    continue;
                }
            }
            Ok(_) => {}
            Err(error) => {
                errors.push(error);
                continue;
            }
        }
        lease.owned[index] = None;
    }
    if errors.is_empty() {
        *state = None;
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn run_networksetup(args: &[&str]) -> Result<(), String> {
    run_networksetup_output(args).map(|_| ())
}

fn run_networksetup_output(args: &[&str]) -> Result<String, String> {
    let output = Command::new("networksetup")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run networksetup: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("networksetup failed: {}", stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_proxy_settings(output: &str) -> Result<ProxySettings, String> {
    let mut saw_enabled = false;
    let mut settings = ProxySettings::default();
    for line in output.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        match key.trim() {
            "Enabled" => {
                saw_enabled = true;
                settings.enabled = match value.trim() {
                    "Yes" => true,
                    "No" => false,
                    _ => return Err("Invalid system proxy status".into()),
                };
            }
            "Server" => settings.server = value.trim().to_string(),
            "Port" => settings.port = value.trim().parse().ok(),
            "Authenticated Proxy Enabled" => settings.authenticated = value.trim() != "0",
            _ => {}
        }
    }
    if !saw_enabled
        || (settings.enabled
            && (settings.server.is_empty() || settings.port.is_none_or(|p| p == 0)))
    {
        return Err("Cannot read current system proxy settings; nothing was changed.".into());
    }
    Ok(settings)
}

#[cfg(test)]
mod tests;
