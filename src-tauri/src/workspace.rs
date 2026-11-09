//! Saved window layout. Separate from prefs so a bad workspace cannot break preferences.
//!
//! Threats: a workspace file is untrusted input. It must not carry SAH arguments, passwords,
//! scrollback, or a claim of production protection. SSH stores host, user, and port only.
//! Serial stores device settings. Paths and hostnames are size-capped and must not contain
//! controls. Errors stay static and do not echo paths. This module does not open a network
//! connection and does not weaken TLS.

use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const MAX_BYTES: usize = 64 * 1024;
const TAB_CAP: usize = 32;

fn has_control(text: &str) -> bool {
    text.chars().any(|c| c.is_control())
}

fn only_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

/// Absolute local path, or null when the value is missing, the wrong type, or not a local path.
fn clean_cwd(value: Option<&Value>) -> Value {
    let Some(Value::String(text)) = value else {
        return Value::Null;
    };
    if text.is_empty()
        || text.len() > 4096
        || !text.starts_with('/')
        || text.contains('\0')
        || has_control(text)
    {
        return Value::Null;
    }
    Value::String(text.clone())
}

fn clean_tab(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    match object.get("kind")?.as_str()? {
        "local" => {
            if !only_keys(object, &["kind", "cwd"]) {
                return None;
            }
            Some(serde_json::json!({
                "kind": "local",
                "cwd": clean_cwd(object.get("cwd")),
            }))
        }
        "ssh" => {
            if !only_keys(object, &["kind", "host", "user", "port"]) {
                return None;
            }
            let parts = crate::prefs::canonical_ssh_parts(
                object.get("host")?,
                object.get("user"),
                object.get("port"),
            )?;
            Some(serde_json::json!({
                "kind": "ssh",
                "host": parts.get("host")?,
                "user": parts.get("user")?,
                "port": parts.get("port")?,
            }))
        }
        "serial" => {
            if !only_keys(object, &["kind", "config"]) {
                return None;
            }
            let config = crate::prefs::clean_serial_config(object.get("config")?)?;
            Some(serde_json::json!({
                "kind": "serial",
                "config": config,
            }))
        }
        _ => None,
    }
}

fn kept_index(kept: &[(usize, Value)], raw: u64) -> Option<usize> {
    let raw = usize::try_from(raw).ok()?;
    if raw >= TAB_CAP {
        return None;
    }
    kept.iter().position(|(source, _)| *source == raw)
}

fn remap_active(value: Option<&Value>, kept: &[(usize, Value)]) -> u64 {
    if kept.is_empty() {
        return 0;
    }
    let Some(value) = value else {
        return 0;
    };
    if !value.is_u64() {
        return 0;
    }
    let Some(raw) = value.as_u64() else {
        return 0;
    };
    kept_index(kept, raw).unwrap_or(0) as u64
}

fn remap_split(value: Option<&Value>, kept: &[(usize, Value)]) -> Value {
    let Some(value) = value else {
        return Value::Null;
    };
    if value.is_null() {
        return Value::Null;
    }
    let Some(object) = value.as_object() else {
        return Value::Null;
    };
    if !only_keys(object, &["orientation", "index", "focus"]) {
        return Value::Null;
    }
    let Some(orientation) = object.get("orientation").and_then(Value::as_str) else {
        return Value::Null;
    };
    if orientation != "right" && orientation != "down" {
        return Value::Null;
    }
    let Some(focus) = object.get("focus").filter(|item| item.is_u64()).and_then(Value::as_u64) else {
        return Value::Null;
    };
    if focus != 0 && focus != 1 {
        return Value::Null;
    }
    let Some(index) = object.get("index").and_then(Value::as_array) else {
        return Value::Null;
    };
    if index.len() != 2 || !index.iter().all(|item| item.is_u64()) {
        return Value::Null;
    }
    let Some(left) = index[0].as_u64().and_then(|raw| kept_index(kept, raw)) else {
        return Value::Null;
    };
    let Some(right) = index[1].as_u64().and_then(|raw| kept_index(kept, raw)) else {
        return Value::Null;
    };
    if left == right {
        return Value::Null;
    }
    serde_json::json!({
        "orientation": orientation,
        "index": [left, right],
        "focus": focus,
    })
}

/// Sanitized workspace. Extra top-level keys are ignored. A bad tab is dropped.
/// Version other than 1, or a missing tabs array, is an error and nothing is written.
pub(crate) fn prepare(value: &Value) -> Result<Value, ()> {
    let root = value.as_object().ok_or(())?;
    let version = root.get("version").ok_or(())?;
    if !version.is_u64() || version.as_u64() != Some(1) {
        return Err(());
    }
    let tabs = root.get("tabs").and_then(Value::as_array).ok_or(())?;
    let mut kept = Vec::new();
    for (index, tab) in tabs.iter().take(TAB_CAP).enumerate() {
        if let Some(clean) = clean_tab(tab) {
            kept.push((index, clean));
        }
    }
    let active = remap_active(root.get("active"), &kept);
    let split = remap_split(root.get("split"), &kept);
    let tabs: Vec<Value> = kept.into_iter().map(|(_, tab)| tab).collect();
    Ok(serde_json::json!({
        "version": 1,
        "active": active,
        "split": split,
        "tabs": tabs,
    }))
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, ()> {
    app.path().app_config_dir().map_err(|_| ())
}

pub fn load(app: &AppHandle) -> Option<Value> {
    let path = config_dir(app).ok()?.join("workspace.json");
    let bytes = fs::read(&path).ok()?;
    if bytes.len() > MAX_BYTES {
        return None;
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    prepare(&value).ok()
}

/// Pretty text to write, or a static error. Does not touch the filesystem.
pub(crate) fn sanitized(workspace: &Value) -> Result<String, String> {
    let incoming = serde_json::to_string(workspace).map_err(|_| "Workspace is not valid".to_string())?;
    if incoming.len() > MAX_BYTES {
        return Err("Workspace is not valid".into());
    }
    let prepared = prepare(workspace).map_err(|_| "Workspace is not valid".to_string())?;
    let pretty = serde_json::to_string_pretty(&prepared).map_err(|_| "Workspace is not valid".to_string())?;
    if pretty.len() > MAX_BYTES {
        return Err("Workspace is not valid".into());
    }
    Ok(pretty)
}

pub fn save(app: &AppHandle, workspace: &Value) -> Result<(), String> {
    let pretty = sanitized(workspace)?;
    let dir = config_dir(app).map_err(|_| "Workspace could not be saved".to_string())?;
    fs::create_dir_all(&dir).map_err(|_| "Workspace could not be saved".to_string())?;
    fs::write(dir.join("workspace.json"), pretty).map_err(|_| "Workspace could not be saved".to_string())
}

fn hostname_from_buffer(buf: &[u8]) -> Option<String> {
    let end = buf.iter().position(|byte| *byte == 0)?;
    let name = std::str::from_utf8(&buf[..end]).ok()?;
    if name.is_empty() || has_control(name) {
        return None;
    }
    Some(name.to_string())
}

#[cfg(unix)]
fn machine_hostname() -> Vec<String> {
    let mut buf = [0u8; 256];
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast::<libc::c_char>(), buf.len()) };
    if rc != 0 {
        return Vec::new();
    }
    hostname_from_buffer(&buf).into_iter().collect()
}

#[cfg(not(unix))]
fn machine_hostname() -> Vec<String> {
    Vec::new()
}

#[tauri::command]
pub fn workspace_load(app: AppHandle) -> Result<Option<Value>, String> {
    Ok(load(&app))
}

#[tauri::command]
pub fn workspace_save(app: AppHandle, workspace: Value) -> Result<(), String> {
    save(&app, &workspace)
}

#[tauri::command]
pub fn local_hostnames() -> Vec<String> {
    machine_hostname()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(cwd: &str) -> Value {
        serde_json::json!({"kind": "local", "cwd": cwd})
    }

    fn ssh() -> Value {
        serde_json::json!({"kind": "ssh", "host": "web1", "user": "alice", "port": 2222})
    }

    fn serial() -> Value {
        serde_json::json!({
            "kind": "serial",
            "config": {
                "path": "/dev/tty.usbserial",
                "baud": 9600,
                "data_bits": 8,
                "parity": "none",
                "stop_bits": 1,
                "flow_control": "none",
                "production": false,
                "lineEnding": "cr",
                "backspace": "del",
                "localEcho": false,
                "profileId": "generic"
            }
        })
    }

    #[test]
    fn keeps_local_ssh_and_serial_and_drops_secrets() {
        let file = serde_json::json!({
            "version": 1,
            "active": 2,
            "note": "ignored",
            "split": {"orientation": "right", "index": [0, 2], "focus": 1},
            "tabs": [
                local("/tmp/work"),
                {"kind": "ssh", "host": "web1", "user": "alice", "port": 2222, "password": "nope"},
                ssh(),
                {"kind": "serial", "config": {"path": "/dev/tty.usbserial", "password": "nope"}},
                serial(),
                {"kind": "sah", "args": ["login"]},
            ]
        });
        let clean = prepare(&file).unwrap();
        assert_eq!(clean["active"], 1);
        assert_eq!(clean["tabs"].as_array().unwrap().len(), 3);
        assert_eq!(clean["tabs"][0]["cwd"], "/tmp/work");
        assert_eq!(clean["tabs"][1]["host"], "web1");
        assert_eq!(clean["tabs"][1]["user"], "alice");
        assert_eq!(clean["tabs"][1]["port"], 2222);
        assert!(clean["tabs"][1].get("password").is_none());
        assert_eq!(clean["tabs"][2]["config"]["path"], "/dev/tty.usbserial");
        assert!(clean["tabs"][2]["config"].get("password").is_none());
        assert_eq!(clean["split"]["index"], serde_json::json!([0, 1]));
        assert_eq!(clean["split"]["focus"], 1);
        assert!(sanitized(&file).unwrap().contains("\"version\": 1"));
    }

    #[test]
    fn invalid_cwd_stays_a_tab_and_bad_files_do_not_sanitize() {
        let kept = prepare(&serde_json::json!({
            "version": 1,
            "tabs": [local("relative"), {"kind": "local", "cwd": 4}, {"kind": "local", "cwd": "/tmp", "extra": true}]
        }))
        .unwrap();
        assert_eq!(kept["tabs"].as_array().unwrap().len(), 2);
        assert_eq!(kept["tabs"][0]["cwd"], Value::Null);
        assert_eq!(kept["tabs"][1]["cwd"], Value::Null);
        assert_eq!(kept["active"], 0);
        assert!(kept["split"].is_null());
        assert!(prepare(&serde_json::json!({"version": 2, "tabs": []})).is_err());
        assert!(prepare(&serde_json::json!({"version": 1})).is_err());
        assert!(prepare(&serde_json::json!("nope")).is_err());
        let empty = prepare(&serde_json::json!({"version": 1, "tabs": [{"kind": "nope"}]})).unwrap();
        assert_eq!(empty["tabs"].as_array().unwrap().len(), 0);
        assert!(sanitized(&serde_json::json!({"version": 2, "tabs": []})).is_err());
    }

    #[test]
    fn split_and_active_follow_dropped_tabs_and_reject_floats() {
        let file = serde_json::json!({
            "version": 1,
            "active": 1.5,
            "split": {"orientation": "down", "index": [0, 1.0], "focus": 0, "extra": true},
            "tabs": [local("/tmp"), ssh()]
        });
        let clean = prepare(&file).unwrap();
        assert_eq!(clean["active"], 0);
        assert!(clean["split"].is_null());
        let dropped = prepare(&serde_json::json!({
            "version": 1,
            "active": 0,
            "split": {"orientation": "right", "index": [0, 1], "focus": 1},
            "tabs": [{"kind": "ssh", "host": "web1", "password": "x"}, ssh()]
        }))
        .unwrap();
        assert_eq!(dropped["active"], 0);
        assert!(dropped["split"].is_null());
        assert_eq!(dropped["tabs"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn caps_the_tab_list_and_rejects_an_oversize_file() {
        let mut tabs = Vec::new();
        for _ in 0..40 {
            tabs.push(local("/tmp"));
        }
        let clean = prepare(&serde_json::json!({"version": 1, "active": 39, "tabs": tabs})).unwrap();
        assert_eq!(clean["tabs"].as_array().unwrap().len(), 32);
        assert_eq!(clean["active"], 0);
        let huge = "x".repeat(MAX_BYTES + 1);
        assert!(sanitized(&serde_json::json!(huge)).is_err());
    }

    #[test]
    fn hostname_buffer_fails_closed() {
        assert_eq!(hostname_from_buffer(b"lab\0"), Some("lab".into()));
        assert_eq!(hostname_from_buffer(b"lab"), None);
        assert_eq!(hostname_from_buffer(&[0xff, 0]), None);
        assert_eq!(hostname_from_buffer(b"\n\0"), None);
        assert_eq!(hostname_from_buffer(b"\0"), None);
        for name in machine_hostname() {
            assert!(!name.is_empty());
            assert!(!has_control(&name));
        }
    }
}
