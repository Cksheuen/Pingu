use super::*;
use std::collections::HashMap;

fn endpoint(server: &str, port: u16) -> ProxySettings {
    ProxySettings {
        enabled: true,
        server: server.into(),
        port: Some(port),
        authenticated: false,
    }
}
struct Fake {
    active: String,
    values: HashMap<String, [ProxySettings; 3]>,
    writes: usize,
    fail_once_at: Option<usize>,
}
impl Fake {
    fn new(before: [ProxySettings; 3]) -> Self {
        Self {
            active: "Wi-Fi".into(),
            values: HashMap::from([("Wi-Fi".into(), before)]),
            writes: 0,
            fail_once_at: None,
        }
    }
}
impl ProxyIo for Fake {
    fn service(&mut self) -> Result<String, String> {
        Ok(self.active.clone())
    }
    fn read(&mut self, service: &str, kind: Kind) -> Result<ProxySettings, String> {
        Ok(self.values[service][kind as usize].clone())
    }
    fn write(&mut self, service: &str, kind: Kind, settings: &ProxySettings) -> Result<(), String> {
        self.writes += 1;
        self.values.get_mut(service).unwrap()[kind as usize] = settings.clone();
        if self.fail_once_at == Some(self.writes) {
            self.fail_once_at = None;
            return Err("injected failure after mutation".into());
        }
        Ok(())
    }
}
#[test]
fn parser_rejects_missing_or_invalid_status_instead_of_assuming_disabled() {
    let settings = parse_proxy_settings(
        "Enabled: Yes\nServer: 127.0.0.1\nPort: 2080\nAuthenticated Proxy Enabled: 0\n",
    )
    .unwrap();
    assert_eq!(settings, endpoint("127.0.0.1", 2080));
    assert!(parse_proxy_settings("unexpected output").is_err());
    assert!(parse_proxy_settings("Enabled: Yes\nServer: \nPort: 0").is_err());
}
#[test]
fn disconnect_restores_previous_vpn_after_multiple_hot_swaps() {
    let before = [
        endpoint("127.0.0.1", 7890),
        endpoint("127.0.0.1", 7891),
        ProxySettings::default(),
    ];
    let mut io = Fake::new(before.clone());
    let mut state = None;
    acquire(&mut state, &mut io, 2080).unwrap();
    acquire(&mut state, &mut io, 2081).unwrap();
    release(&mut state, &mut io).unwrap();
    assert_eq!(io.values["Wi-Fi"], before);
    assert!(state.is_none());
}
#[test]
fn another_vpn_taking_over_survives_pingu_disconnect_and_rejects_hot_swap() {
    let mut io = Fake::new(std::array::from_fn(|_| ProxySettings::default()));
    let mut state = None;
    acquire(&mut state, &mut io, 2080).unwrap();
    let other = std::array::from_fn(|_| endpoint("127.0.0.1", 7890));
    io.values.insert("Wi-Fi".into(), other.clone());
    let writes = io.writes;
    assert!(acquire(&mut state, &mut io, 2081).is_err());
    release(&mut state, &mut io).unwrap();
    assert_eq!(io.values["Wi-Fi"], other);
    assert_eq!(io.writes, writes);
}
#[test]
fn partial_takeover_restores_only_fields_still_owned() {
    let before = std::array::from_fn(|_| ProxySettings::default());
    let mut io = Fake::new(before.clone());
    let mut state = None;
    acquire(&mut state, &mut io, 2080).unwrap();
    io.values.get_mut("Wi-Fi").unwrap()[1] = endpoint("127.0.0.1", 7891);
    release(&mut state, &mut io).unwrap();
    assert_eq!(io.values["Wi-Fi"][0], before[0]);
    assert_eq!(io.values["Wi-Fi"][1], endpoint("127.0.0.1", 7891));
    assert_eq!(io.values["Wi-Fi"][2], before[2]);
}
#[test]
fn disconnect_uses_original_service_after_default_route_changes() {
    let before = std::array::from_fn(|_| ProxySettings::default());
    let mut io = Fake::new(before.clone());
    let mut state = None;
    acquire(&mut state, &mut io, 2080).unwrap();
    io.active = "Ethernet".into();
    let other = std::array::from_fn(|_| endpoint("127.0.0.1", 7890));
    io.values.insert("Ethernet".into(), other.clone());
    assert!(acquire(&mut state, &mut io, 2081).is_err());
    release(&mut state, &mut io).unwrap();
    assert_eq!(io.values["Wi-Fi"], before);
    assert_eq!(io.values["Ethernet"], other);
}
#[test]
fn partial_acquisition_failure_restores_previous_settings() {
    let before = std::array::from_fn(|_| endpoint("127.0.0.1", 7890));
    let mut io = Fake::new(before.clone());
    let mut state = None;
    io.fail_once_at = Some(2);
    assert!(acquire(&mut state, &mut io, 2080).is_err());
    assert_eq!(io.values["Wi-Fi"], before);
    assert!(state.is_none());
}
#[test]
fn failed_hot_swap_keeps_original_lease_for_later_restore() {
    let before = std::array::from_fn(|_| endpoint("127.0.0.1", 7890));
    let mut io = Fake::new(before.clone());
    let mut state = None;
    acquire(&mut state, &mut io, 2080).unwrap();
    io.fail_once_at = Some(io.writes + 2);
    assert!(acquire(&mut state, &mut io, 2081).is_err());
    assert!(io.values["Wi-Fi"].iter().all(|p| p.port == Some(2080)));
    release(&mut state, &mut io).unwrap();
    assert_eq!(io.values["Wi-Fi"], before);
}
#[test]
fn idle_or_authenticated_proxy_is_never_overwritten() {
    let mut before = std::array::from_fn(|_| endpoint("corporate.example", 8080));
    before[0].authenticated = true;
    let mut io = Fake::new(before.clone());
    let mut state = None;
    release(&mut state, &mut io).unwrap();
    assert!(acquire(&mut state, &mut io, 2080).is_err());
    assert_eq!(io.writes, 0);
    assert_eq!(io.values["Wi-Fi"], before);
}
