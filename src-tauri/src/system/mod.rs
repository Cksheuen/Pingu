#[cfg(target_os = "macos")]
pub mod proxy_macos;

#[cfg(not(target_os = "macos"))]
pub mod proxy_macos {
    pub fn get_active_network_service() -> Result<String, String> {
        Err("Not supported on this platform".to_string())
    }

    pub fn set_system_proxy(_port: u16) -> Result<(), String> {
        Err("Not supported on this platform".to_string())
    }

    pub fn clear_system_proxy() -> Result<(), String> {
        Err("Not supported on this platform".to_string())
    }
}
