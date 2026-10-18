#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = pingu_lib::system::tun::worker_entry() {
        std::process::exit(code);
    }
    pingu_lib::run()
}
