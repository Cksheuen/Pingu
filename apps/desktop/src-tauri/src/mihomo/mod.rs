pub mod config_gen;
mod log_writer;
pub mod process;
pub mod subscription;
pub mod uri_parser;

pub mod controller;
pub mod profiles;

pub fn private_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options
            .open(&temp)
            .map_err(|_| "Cannot create private configuration")?;
        file.write_all(bytes)
            .map_err(|_| "Cannot write configuration")?;
        file.sync_all().map_err(|_| "Cannot save configuration")?;
        std::fs::rename(&temp, path).map_err(|_| "Cannot replace configuration")
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temp);
    }
    result.map_err(str::to_string)
}
