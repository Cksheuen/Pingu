use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;

fn main() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    let config_path = args
        .windows(2)
        .find(|pair| pair[0] == "-c")
        .map(|pair| pair[1].clone())
        .ok_or("missing -c config")?;
    let config: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(config_path).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;

    match args.get(1).map(String::as_str) {
        Some("check") => check_config(&config),
        Some("run") => run(&config),
        _ => Err("usage: fake-sing-box <check|run> -c <config>".to_string()),
    }
}

fn check_config(config: &serde_json::Value) -> Result<(), String> {
    let port = config["inbounds"][0]["listen_port"]
        .as_u64()
        .ok_or("missing inbound listen_port")?;
    let clash = config["experimental"]["clash_api"]["external_controller"]
        .as_str()
        .ok_or("missing clash controller")?;
    if port == 0 || clash.is_empty() {
        return Err("invalid test config".to_string());
    }
    Ok(())
}

fn run(config: &serde_json::Value) -> Result<(), String> {
    check_config(config)?;
    let proxy_port = config["inbounds"][0]["listen_port"]
        .as_u64()
        .ok_or("missing inbound listen_port")? as u16;
    let clash_address = config["experimental"]["clash_api"]["external_controller"]
        .as_str()
        .ok_or("missing clash controller")?
        .to_string();
    let active = Arc::new(AtomicUsize::new(0));

    let api_listener = TcpListener::bind(&clash_address).map_err(|error| error.to_string())?;
    let api_active = Arc::clone(&active);
    thread::spawn(move || {
        for stream in api_listener.incoming().flatten() {
            let _ = respond_connections(stream, api_active.load(Ordering::SeqCst));
        }
    });

    let proxy_listener = TcpListener::bind(("127.0.0.1", proxy_port))
        .map_err(|error| error.to_string())?;
    eprintln!("tcp server started at 127.0.0.1:{proxy_port}");
    eprintln!("sing-box started");
    for stream in proxy_listener.incoming().flatten() {
        let active = Arc::clone(&active);
        thread::spawn(move || {
            let _ = handle_connect(stream, active);
        });
    }
    Ok(())
}

fn respond_connections(mut stream: TcpStream, active: usize) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|error| error.to_string())?);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|error| error.to_string())?;
    let connections = (0..active)
        .map(|index| serde_json::json!({"id": format!("test-{index}")}))
        .collect::<Vec<_>>();
    let body = serde_json::json!({"connections": connections}).to_string();
    write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    )
    .map_err(|error| error.to_string())
}

fn handle_connect(mut client: TcpStream, active: Arc<AtomicUsize>) -> Result<(), String> {
    let mut reader = BufReader::new(client.try_clone().map_err(|error| error.to_string())?);
    let mut request = String::new();
    reader.read_line(&mut request).map_err(|error| error.to_string())?;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|error| error.to_string())?;
        if line == "\r\n" || line.is_empty() {
            break;
        }
    }
    let destination = request
        .split_whitespace()
        .nth(1)
        .ok_or("missing CONNECT destination")?;
    let (host, port) = destination
        .rsplit_once(':')
        .ok_or("invalid CONNECT destination")?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err("fake-sing-box rejects non-loopback destinations".to_string());
    }
    let mut upstream = TcpStream::connect((host, port.parse::<u16>().map_err(|e| e.to_string())?))
        .map_err(|error| error.to_string())?;
    client
        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
        .map_err(|error| error.to_string())?;
    active.fetch_add(1, Ordering::SeqCst);
    let mut upstream_read = upstream.try_clone().map_err(|error| error.to_string())?;
    let mut client_write = client.try_clone().map_err(|error| error.to_string())?;
    let download = thread::spawn(move || std::io::copy(&mut upstream_read, &mut client_write));
    let _ = std::io::copy(&mut client, &mut upstream);
    let _ = download.join();
    active.fetch_sub(1, Ordering::SeqCst);
    Ok(())
}
