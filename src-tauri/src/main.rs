#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = afterterm_lib::launch_cli() {
        eprintln!("afterterm: {error}");
        std::process::exit(2);
    }
}
