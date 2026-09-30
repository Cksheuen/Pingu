//! Isolated real-network comparison. Does not save app configuration or set the system proxy.
use pingu_lib::{
    chain::{self, ChainSettings, NodeRef},
    mihomo::profiles::{self, Subscription},
    storage::app_config::AppConfig,
};
fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let arg = |key: &str| {
        args.iter()
            .position(|x| x == key)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let config_path = arg("--config").ok_or("Usage: chain-probe --config FILE --subscription-file FILE --entry NAME [--exit-id ID] [--prepare FILE]")?;
    let mut config: AppConfig = serde_json::from_slice(
        &std::fs::read(config_path).map_err(|_| "Cannot read app configuration")?,
    )
    .map_err(|_| "Invalid app configuration")?;
    if let Some(path) = arg("--emit-runtime") {
        let value = pingu_lib::mihomo::config_gen::try_generate_app_config(
            &config,
            config.active_rule_group()?,
            &[],
            0,
            0,
        )?;
        pingu_lib::mihomo::private_write(
            std::path::Path::new(&path),
            serde_json::to_string(&value)
                .map_err(|_| "Cannot serialize runtime")?
                .as_bytes(),
        )?;
        println!("Private runtime configuration emitted.");
        return Ok(());
    }
    if args.iter().any(|a| a == "--verify") {
        chain::prepare_gate(&config)?;
        let reservation =
            std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|_| "Cannot allocate port")?;
        let port = reservation
            .local_addr()
            .map_err(|_| "Cannot read port")?
            .port();
        drop(reservation);
        let prepared = pingu_lib::proxy_runtime::prepare_runtime_generation_with_port(
            &config,
            Some(chrono::Utc::now().timestamp_millis() as u64),
            port,
        )?;
        let process = pingu_lib::mihomo::process::MihomoProcess::new();
        if let Err(e) = process.check(prepared.config_path.to_str().ok_or("Invalid path")?) {
            let _ = e.finish_owned_cleanup(prepared.owned_runtime_dir.clone());
            return Err("Candidate failed core validation".into());
        }
        let outcome = (|| {
            process.start(prepared.config_path.to_str().ok_or("Invalid path")?)?;
            let start = std::time::Instant::now();
            while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
                if !process.is_running() || start.elapsed() > std::time::Duration::from_secs(15) {
                    return Err("Candidate listener failed to start".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            pingu_lib::proxy_runtime::verify_startup_proxy_content(port).map(|_| ())
        })();
        let stopped = process.stop();
        if stopped.is_ok() {
            if let Some(dir) = prepared.owned_runtime_dir {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
        outcome?;
        stopped?;
        println!(
            "Candidate passed core validation and all remote content checks on an isolated port."
        );
        return Ok(());
    }
    if args.iter().any(|a| a == "--auto") {
        let exit = config
            .proxy_chain
            .exit
            .clone()
            .or_else(|| {
                config
                    .active_node_id
                    .clone()
                    .map(|node_id| NodeRef::Manual { node_id })
            })
            .ok_or("Choose an exit")?;
        let result = chain::latency::auto_select(&config, exit)?;
        println!(
            "{}",
            serde_json::to_string_pretty(&result).map_err(|_| "Cannot serialize selection")?
        );
        return Ok(());
    }
    let input_path = arg("--subscription-file").ok_or("Missing subscription file")?;
    let raw = std::fs::read_to_string(input_path).map_err(|_| "Cannot read subscription file")?;
    let (fragment, warnings) = profiles::parse_body(&raw)?;
    let entry_name = arg("--entry").ok_or("Missing entry name")?;
    let source_id = "chain-research-subscription".to_string();
    // The private candidate can preserve the original URL for future refreshes.
    let input = if let Some(p) = arg("--url-file") {
        std::fs::read_to_string(p).map_err(|_| "Cannot read private URL file")?
    } else {
        raw
    };
    config.subscriptions.push(Subscription {
        nodes_only: true,
        id: source_id.clone(),
        name: "External subscription".into(),
        input,
        enabled: true,
        updated_at: profiles::timestamp(),
        last_error: None,
        fragment,
        warnings,
    });
    let exit_id = arg("--exit-id")
        .or(config.active_node_id.clone())
        .ok_or("No exit node selected")?;
    let settings = ChainSettings {
        enabled: false,
        entry: Some(NodeRef::Subscription {
            subscription_id: source_id,
            proxy_name: entry_name,
        }),
        exit: Some(NodeRef::Manual { node_id: exit_id }),
    };
    chain::pair(&config, &settings)?;
    config.proxy_chain = settings.clone();
    if let Some(path) = arg("--prepare") {
        pingu_lib::mihomo::private_write(
            std::path::Path::new(&path),
            serde_json::to_string_pretty(&config)
                .map_err(|_| "Cannot serialize candidate")?
                .as_bytes(),
        )?;
        println!("Private candidate prepared; active settings unchanged.");
        return Ok(());
    }
    let result = chain::probe::compare(&config, settings)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&result).map_err(|_| "Cannot serialize results")?
    );
    Ok(())
}
