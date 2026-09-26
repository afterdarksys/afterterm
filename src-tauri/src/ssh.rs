use serde::Serialize;
use std::process::Command;
#[derive(Serialize)]
pub struct Algorithms {
    client: String,
    kex: Vec<String>,
    host_key: Vec<String>,
    cipher: Vec<String>,
    mac: Vec<String>,
}
#[tauri::command]
pub async fn ssh_algorithms() -> Result<Algorithms, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let client = afterterm_pty::path::resolve_binary("ssh")
            .ok_or("OpenSSH client not found on the developer PATH")?;
        let query = |kind: &str| -> Result<Vec<String>, String> {
            let output = Command::new(&client)
                .args(["-Q", kind])
                .env("PATH", afterterm_pty::path::augmented_path())
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(format!(
                    "OpenSSH query {kind} failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            Ok(String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::to_owned)
                .collect())
        };
        Ok(Algorithms {
            client: client.display().to_string(),
            kex: query("kex")?,
            host_key: query("key-sig")?,
            cipher: query("cipher")?,
            mac: query("mac")?,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
