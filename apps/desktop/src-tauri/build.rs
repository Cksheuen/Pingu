use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=PINGU_MIHOMO_BIN");
    println!("cargo:rerun-if-env-changed=MIHOMO_BIN");
    println!("cargo:rerun-if-changed=binaries");
    let target = env::var("TARGET").expect("TARGET should be set by Cargo");
    println!("cargo:rerun-if-env-changed=PINGU_MESH_BIN");
    let mut bins = Vec::new();
    if let Some(path) = prepare_mihomo_sidecar(&target) { bins.push(path.to_string_lossy().to_string()); }
    if let Some(path) = prepare_mesh_sidecar(&target) { bins.push(path.to_string_lossy().to_string()); }
    apply_tauri_config_override(json!({"bundle":{"externalBin":if bins.is_empty() { Value::Null } else { json!(bins) }}}));

    tauri_build::build()
}

fn prepare_mihomo_sidecar(target: &str) -> Option<PathBuf> {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR")?);
    let binaries_dir = manifest_dir.join("binaries");
    let suffix = executable_suffix(target);
    let expected_filename = format!("mihomo-{target}{suffix}");

    if binaries_dir.join(&expected_filename).exists() {
        return Some(binaries_dir.join("mihomo"));
    }

    let source = env::var_os("PINGU_MIHOMO_BIN")
        .map(PathBuf::from)
        .or_else(|| env::var_os("MIHOMO_BIN").map(PathBuf::from))
        .or_else(|| find_mihomo_on_path(target))?;

    let out_dir = PathBuf::from(env::var_os("OUT_DIR")?);
    let stage_dir = out_dir.join("pingu-sidecars");
    fs::create_dir_all(&stage_dir).ok()?;

    let staged_binary = stage_dir.join(expected_filename);
    fs::copy(&source, &staged_binary).ok()?;
    ensure_executable(&staged_binary);

    Some(stage_dir.join("mihomo"))
}

fn executable_suffix(target: &str) -> &'static str {
    if target.contains("windows") {
        ".exe"
    } else {
        ""
    }
}

fn find_mihomo_on_path(target: &str) -> Option<PathBuf> {
    let executable = format!("mihomo{}", executable_suffix(target));
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|dir| dir.join(&executable))
            .find(|candidate| candidate.is_file())
    })
}

fn apply_tauri_config_override(override_config: Value) {
    let mut merged = env::var("TAURI_CONFIG")
        .ok()
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .unwrap_or_else(|| json!({}));
    merge_json(&mut merged, override_config);
    env::set_var("TAURI_CONFIG", merged.to_string());
}

fn merge_json(base: &mut Value, overlay: Value) {
    match (base, overlay) {
        (Value::Object(base_map), Value::Object(overlay_map)) => {
            for (key, value) in overlay_map {
                merge_json(base_map.entry(key).or_insert(Value::Null), value);
            }
        }
        (base_slot, overlay_value) => *base_slot = overlay_value,
    }
}

fn ensure_executable(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if let Ok(metadata) = fs::metadata(path) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(0o755);
            let _ = fs::set_permissions(path, permissions);
        }
    }
}

fn prepare_mesh_sidecar(target: &str) -> Option<PathBuf> {
    let source = PathBuf::from(env::var_os("PINGU_MESH_BIN")?);
    let stage = PathBuf::from(env::var_os("OUT_DIR")?).join("pingu-sidecars");
    fs::create_dir_all(&stage).ok()?;
    let dest = stage.join(format!("pingu-mesh-{target}{}",executable_suffix(target)));
    fs::copy(source,&dest).ok()?; ensure_executable(&dest);
    Some(stage.join("pingu-mesh"))
}
