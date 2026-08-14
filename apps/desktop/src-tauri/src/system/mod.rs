use std::sync::Arc;

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

pub trait SystemProxyControl: Send + Sync {
    fn set(&self, port: u16) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

pub struct MacOsSystemProxyControl;

impl SystemProxyControl for MacOsSystemProxyControl {
    fn set(&self, port: u16) -> Result<(), String> {
        proxy_macos::set_system_proxy(port)
    }

    fn clear(&self) -> Result<(), String> {
        proxy_macos::clear_system_proxy()
    }
}

pub fn production_system_proxy() -> Arc<dyn SystemProxyControl> {
    Arc::new(MacOsSystemProxyControl)
}
