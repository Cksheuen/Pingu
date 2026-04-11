use std::process::Command;

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

pub fn set_system_proxy(port: u16) -> Result<(), String> {
    let service = get_active_network_service()?;
    let port_str = port.to_string();

    // Set HTTP proxy
    run_networksetup(&["-setwebproxy", &service, "127.0.0.1", &port_str])?;
    run_networksetup(&["-setwebproxystate", &service, "on"])?;

    // Set HTTPS proxy
    run_networksetup(&["-setsecurewebproxy", &service, "127.0.0.1", &port_str])?;
    run_networksetup(&["-setsecurewebproxystate", &service, "on"])?;

    // Set SOCKS proxy
    run_networksetup(&["-setsocksfirewallproxy", &service, "127.0.0.1", &port_str])?;
    run_networksetup(&["-setsocksfirewallproxystate", &service, "on"])?;

    Ok(())
}

pub fn clear_system_proxy() -> Result<(), String> {
    let service = get_active_network_service()?;

    run_networksetup(&["-setwebproxystate", &service, "off"])?;
    run_networksetup(&["-setsecurewebproxystate", &service, "off"])?;
    run_networksetup(&["-setsocksfirewallproxystate", &service, "off"])?;

    Ok(())
}

fn run_networksetup(args: &[&str]) -> Result<(), String> {
    let output = Command::new("networksetup")
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run networksetup: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("networksetup failed: {}", stderr));
    }

    Ok(())
}
