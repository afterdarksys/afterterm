use serde::de::Deserializer;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prefs {
    pub theme: String,
    #[serde(default)]
    pub theme_overrides: BTreeMap<String, ThemeOverrides>,
    pub font_family: String,
    pub font_size: u8,
    pub transparency: f32,
    pub cursor_style: String,
    pub scrollback: u32,
    pub reduced_motion: bool,
    pub ai_enabled: bool,
    #[serde(default = "default_line_height")]
    pub line_height: f32,
    #[serde(default = "default_true")]
    pub cursor_blink: bool,
    #[serde(default = "default_bell")]
    pub bell_style: String,
    #[serde(default)]
    pub option_as_meta: bool,
    #[serde(default)]
    pub copy_on_select: bool,
    #[serde(default = "default_true")]
    pub screen_reader_mode: bool,
    /// Start new tabs with submission review on. Off by default.
    #[serde(default)]
    pub review_new_tabs: bool,
    /// Warp-style command blocks. Off until the user turns them on.
    #[serde(default)]
    pub blocks_enabled: bool,
    #[serde(default = "default_true")]
    pub blocks_gutter: bool,
    /// Inject OSC markers into new local zsh or bash tabs. Never on for SSH or SAH.
    #[serde(default)]
    pub blocks_shell_integration: bool,
    #[serde(default = "default_true")]
    pub blocks_show_exit: bool,
    #[serde(default = "default_true")]
    pub blocks_show_duration: bool,
    #[serde(default)]
    pub blocks_show_timestamps: bool,
    /// Path-style S3 endpoint, stored normalized. Empty means Drive is unconfigured.
    /// The secret access key is never a preference.
    #[serde(default)]
    pub drive_endpoint: String,
    #[serde(default = "default_region")]
    pub drive_region: String,
    #[serde(default)]
    pub drive_bucket: String,
    #[serde(default)]
    pub drive_access_key_id: String,
    #[serde(default = "default_secret_source")]
    pub drive_secret_source: String,
    #[serde(default)]
    pub drive_secret_path: String,
    /// New local tabs use the shell's directory. SSH duplicates host, user, and port only.
    #[serde(default = "default_true")]
    pub new_tab_directory: bool,
    /// Ask before closing a tab whose foreground program is still running.
    #[serde(default = "default_true")]
    pub confirm_close_busy: bool,
    /// Modifier-click opens http(s) links with the system opener.
    #[serde(default = "default_true")]
    pub open_links: bool,
    /// Mark a background tab when it bells or a block finishes.
    #[serde(default = "default_true")]
    pub mark_background_tabs: bool,
    /// System notifications. Off so the first launch does not ask for permission.
    #[serde(default)]
    pub notify_system: bool,
    /// off, local, or reconnect. Off so SSH and serial are not surprise-reconnected.
    #[serde(default = "default_restore")]
    pub restore_sessions: String,
    /// Saved SSH and serial device settings. Passwords and SAH tokens are not a field.
    #[serde(default, deserialize_with = "deserialize_connections")]
    pub connections: Vec<Value>,
}

fn default_restore() -> String {
    "off".into()
}

/// A non-array `connections` value becomes an empty list. Entries stay raw so a
/// later save can still reject a password key. A missing field uses serde default.
fn deserialize_connections<'de, D>(deserializer: D) -> Result<Vec<Value>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok(match value {
        Value::Array(items) => items,
        _ => Vec::new(),
    })
}

fn default_line_height() -> f32 {
    1.0
}
fn default_true() -> bool {
    true
}
fn default_bell() -> String {
    "none".into()
}
fn default_region() -> String {
    "us-east-1".into()
}
fn default_secret_source() -> String {
    "env".into()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ThemeOverrides {
    #[serde(default)]
    pub terminal: BTreeMap<String, String>,
    #[serde(default)]
    pub chrome: BTreeMap<String, String>,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            theme: "signal".into(),
            theme_overrides: BTreeMap::new(),
            font_family: "SF Mono, Menlo, JetBrains Mono, ui-monospace, monospace".into(),
            font_size: 13,
            transparency: 0.82,
            cursor_style: "bar".into(),
            scrollback: 10000,
            reduced_motion: false,
            ai_enabled: false,
            line_height: default_line_height(),
            cursor_blink: true,
            bell_style: default_bell(),
            option_as_meta: false,
            copy_on_select: false,
            screen_reader_mode: true,
            review_new_tabs: false,
            blocks_enabled: false,
            blocks_gutter: true,
            blocks_shell_integration: false,
            blocks_show_exit: true,
            blocks_show_duration: true,
            blocks_show_timestamps: false,
            drive_endpoint: String::new(),
            drive_region: default_region(),
            drive_bucket: String::new(),
            drive_access_key_id: String::new(),
            drive_secret_source: default_secret_source(),
            drive_secret_path: String::new(),
            new_tab_directory: true,
            confirm_close_busy: true,
            open_links: true,
            mark_background_tabs: true,
            notify_system: false,
            restore_sessions: default_restore(),
            connections: Vec::new(),
        }
    }
}

fn prefs_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("prefs.json"))
}

pub fn load(app: &AppHandle) -> Result<Prefs, String> {
    let path = prefs_path(app)?;
    match fs::read_to_string(&path) {
        Ok(text) => {
            let mut prefs: Prefs = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            sanitize(&mut prefs);
            Ok(prefs)
        }
        Err(_) => Ok(Prefs::default()),
    }
}

/// Rebuild a Drive endpoint as `https://host[:port]/s3`. An explicit port, including 443, is kept.
/// Empty input is stored as empty. Spaces, newlines, and other controls are rejected on the
/// original string, so they are not trimmed away. Invalid input is an error and is not echoed.
pub(crate) fn normalize_endpoint(input: &str) -> Result<String, ()> {
    if input.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(());
    }
    let raw = input;
    if raw.is_empty() {
        return Ok(String::new());
    }
    if raw.len() > 200 {
        return Err(());
    }
    if raw.contains(['@', '?', '#']) {
        return Err(());
    }
    let Some(rest) = strip_https(raw) else {
        return Err(());
    };
    let (authority, path) = split_authority(rest)?;
    if path != "/s3" && path != "/s3/" {
        return Err(());
    }
    let (host, port) = split_host_port(&authority)?;
    if host.is_empty() {
        return Err(());
    }
    let host_lower = host.to_ascii_lowercase();
    if host_lower.contains(['[', ']']) {
        return Err(());
    }
    let display = if host_lower.contains(':') {
        format!("[{host_lower}]")
    } else {
        host_lower
    };
    let built = match port {
        Some(port) => format!("https://{display}:{port}/s3"),
        None => format!("https://{display}/s3"),
    };
    let parsed = Url::parse(&built).map_err(|_| ())?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/s3"
    {
        return Err(());
    }
    Ok(built)
}

fn strip_https(raw: &str) -> Option<&str> {
    let (scheme, rest) = raw.split_once("://")?;
    if scheme.eq_ignore_ascii_case("https") {
        Some(rest)
    } else {
        None
    }
}

fn split_authority(rest: &str) -> Result<(String, String), ()> {
    if rest.is_empty() {
        return Err(());
    }
    if let Some(host) = rest.strip_prefix('[') {
        let close = host.find(']').ok_or(())?;
        let after = &rest[close + 2..];
        if after.starts_with(':') {
            let slash = after.find('/').ok_or(())?;
            Ok((rest[..=close + 1].to_string() + &after[..slash], after[slash..].to_string()))
        } else if after.starts_with('/') {
            Ok((rest[..=close + 1].to_string(), after.to_string()))
        } else {
            Err(())
        }
    } else {
        let slash = rest.find('/').ok_or(())?;
        if slash == 0 {
            return Err(());
        }
        Ok((rest[..slash].to_string(), rest[slash..].to_string()))
    }
}

fn split_host_port(authority: &str) -> Result<(String, Option<u16>), ()> {
    if let Some(inner) = authority.strip_prefix('[') {
        let close = inner.find(']').ok_or(())?;
        let host = inner[..close].to_string();
        let tail = &authority[close + 2..];
        if tail.is_empty() {
            return Ok((host, None));
        }
        let digits = tail.strip_prefix(':').ok_or(())?;
        return Ok((host, Some(parse_port(digits)?)));
    }
    if let Some((host, digits)) = authority.rsplit_once(':') {
        if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
            if host.is_empty() {
                return Err(());
            }
            return Ok((host.to_string(), Some(parse_port(digits)?)));
        }
    }
    Ok((authority.to_string(), None))
}

fn parse_port(digits: &str) -> Result<u16, ()> {
    if digits.is_empty() || digits.len() > 5 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(());
    }
    let port: u32 = digits.parse().map_err(|_| ())?;
    if port == 0 || port > 65535 {
        return Err(());
    }
    Ok(port as u16)
}

pub(crate) fn region_error(region: &str) -> Option<&'static str> {
    if region_ok(region) {
        None
    } else {
        Some("Signing region is not valid")
    }
}

fn region_ok(region: &str) -> bool {
    let bytes = region.as_bytes();
    (1..=32).contains(&bytes.len())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

pub(crate) fn bucket_error(bucket: &str) -> Option<&'static str> {
    if bucket.is_empty() {
        return None;
    }
    if bucket_ok(bucket) {
        None
    } else {
        Some("Bucket name is not valid")
    }
}

fn bucket_ok(bucket: &str) -> bool {
    let bytes = bucket.as_bytes();
    if bytes.is_empty() || bytes.len() > 63 || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes.iter().all(|b| b.is_ascii_alphanumeric() || matches!(*b, b'.' | b'_' | b'-'))
        && !bucket.contains("..")
}

pub(crate) fn access_key_error(key: &str) -> Option<&'static str> {
    if key.is_empty() {
        return None;
    }
    let bytes = key.as_bytes();
    if (1..=128).contains(&bytes.len()) && bytes.iter().all(|b| b.is_ascii_alphanumeric()) {
        None
    } else {
        Some("Access key id is not valid")
    }
}

fn secret_path_ok(path: &str) -> bool {
    path.len() <= 4096 && !path.chars().any(|c| c.is_control())
}

pub(crate) fn require_endpoint(endpoint: &str) -> Result<String, String> {
    let normalized = normalize_endpoint(endpoint).map_err(|_| "Endpoint is not valid".to_string())?;
    if normalized.is_empty() {
        return Err("Endpoint is not valid".into());
    }
    Ok(normalized)
}

const SSH_KEYS: &[&str] = &["id", "name", "kind", "host", "user", "port"];
const SERIAL_KEYS: &[&str] = &["id", "name", "kind", "config"];
const SERIAL_CONFIG_KEYS: &[&str] = &[
    "path", "baud", "data_bits", "parity", "stop_bits", "flow_control", "production",
    "lineEnding", "backspace", "localEcho", "profileId", "identity", "autoReconnect",
];

fn object_keys<'a>(value: &'a Value) -> Option<&'a Map<String, Value>> {
    value.as_object()
}

fn allowed_keys(object: &Map<String, Value>, allowed: &[&str]) -> bool {
    object.keys().all(|key| allowed.contains(&key.as_str()))
}

fn has_control(text: &str) -> bool {
    text.chars().any(|c| c.is_control())
}

fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let groups = [8usize, 4, 4, 4, 12];
    let mut index = 0;
    for (group, len) in groups.iter().enumerate() {
        if group > 0 {
            if bytes.get(index) != Some(&b'-') {
                return false;
            }
            index += 1;
        }
        for _ in 0..*len {
            let Some(byte) = bytes.get(index) else {
                return false;
            };
            if !byte.is_ascii_hexdigit() {
                return false;
            }
            index += 1;
        }
    }
    index == bytes.len()
}

fn clean_id(value: &Value) -> Option<String> {
    let text = value.as_str()?;
    if !is_uuid(text) {
        return None;
    }
    Some(text.to_ascii_lowercase())
}

fn clean_name(value: &Value) -> Option<String> {
    let name = value.as_str()?.trim();
    let length = name.chars().count();
    if !(1..=64).contains(&length) || has_control(name) {
        return None;
    }
    Some(name.to_string())
}

fn is_name_host(host: &str) -> bool {
    let mut chars = host.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (1..=253).contains(&host.len())
        && first.is_ascii_alphanumeric()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn is_bracketed_ipv6(host: &str) -> bool {
    let Some(inner) = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    else {
        return false;
    };
    (2..=45).contains(&inner.len())
        && inner.contains(':')
        && inner
            .chars()
            .all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '.'))
}

fn ssh_user_ok(user: &str) -> bool {
    let mut chars = user.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (1..=64).contains(&user.len())
        && (first.is_ascii_alphanumeric() || first == '_')
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Host, user, and port in the same shape OpenSSH accepts. Unknown-key policy
/// stays with the caller. A float port is rejected; an integral JSON number is kept.
pub(crate) fn canonical_ssh_parts(
    host: &Value,
    user: Option<&Value>,
    port: Option<&Value>,
) -> Option<Map<String, Value>> {
    let host = host.as_str()?.trim();
    if !is_name_host(host) && !is_bracketed_ipv6(host) {
        return None;
    }
    let user = match user {
        None | Some(Value::Null) => Value::Null,
        Some(value) => {
            let text = value.as_str()?.trim();
            if text.is_empty() {
                Value::Null
            } else if ssh_user_ok(text) {
                Value::String(text.to_string())
            } else {
                return None;
            }
        }
    };
    let port = match port {
        None | Some(Value::Null) => Value::Null,
        Some(value) => {
            // 2222.0 is a JSON float. Keep it only when it is an integer in range,
            // and store that integer so the file does not keep an f64.
            let number = integral_u64(value)?;
            if (1..=65535).contains(&number) {
                Value::from(number)
            } else {
                return None;
            }
        }
    };
    let mut object = Map::new();
    object.insert("host".into(), Value::String(host.to_string()));
    object.insert("user".into(), user);
    object.insert("port".into(), port);
    Some(object)
}

/// Integer, or a finite JSON float that is exactly that integer. `2222.5` is none.
fn integral_u64(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_u64() {
        return Some(number);
    }
    let float = value.as_f64()?;
    if !float.is_finite() || float < 0.0 {
        return None;
    }
    let whole = float as u64;
    if whole as f64 == float { Some(whole) } else { None }
}

fn u64_in(value: &Value, min: u64, max: u64) -> Option<u64> {
    if !value.is_u64() {
        return None;
    }
    let number = value.as_u64()?;
    if (min..=max).contains(&number) {
        Some(number)
    } else {
        None
    }
}

fn one_of<'a>(value: &'a Value, choices: &[&str]) -> Option<&'a str> {
    let text = value.as_str()?;
    if choices.iter().any(|choice| *choice == text) {
        Some(text)
    } else {
        None
    }
}

fn profile_id_ok(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Serial device settings. An unknown key, including a password, fails the config.
/// Absent identity and autoReconnect are omitted so a well-formed object compares equal.
pub(crate) fn clean_serial_config(value: &Value) -> Option<Value> {
    let object = object_keys(value)?;
    if !allowed_keys(object, SERIAL_CONFIG_KEYS) {
        return None;
    }
    let path = object.get("path")?.as_str()?;
    if path.len() > 256
        || !path.starts_with("/dev/")
        || path.contains('\0')
        || has_control(path)
    {
        return None;
    }
    let baud = u64_in(object.get("baud")?, 1, 4_000_000)?;
    let data_bits = u64_in(object.get("data_bits")?, 5, 8)?;
    let stop_bits = u64_in(object.get("stop_bits")?, 1, 2)?;
    if stop_bits != 1 && stop_bits != 2 {
        return None;
    }
    let parity = one_of(object.get("parity")?, &["none", "even", "odd"])?;
    let flow = one_of(object.get("flow_control")?, &["none", "hardware", "software"])?;
    let production = object.get("production")?.as_bool()?;
    let line_ending = one_of(object.get("lineEnding")?, &["cr", "lf", "crlf"])?;
    let backspace = one_of(object.get("backspace")?, &["bs", "del"])?;
    let local_echo = object.get("localEcho")?.as_bool()?;
    let profile = object.get("profileId")?.as_str()?;
    if !profile_id_ok(profile) {
        return None;
    }
    let mut clean = Map::new();
    clean.insert("path".into(), Value::String(path.to_string()));
    clean.insert("baud".into(), Value::from(baud));
    clean.insert("data_bits".into(), Value::from(data_bits));
    clean.insert("parity".into(), Value::String(parity.to_string()));
    clean.insert("stop_bits".into(), Value::from(stop_bits));
    clean.insert("flow_control".into(), Value::String(flow.to_string()));
    clean.insert("production".into(), Value::Bool(production));
    clean.insert("lineEnding".into(), Value::String(line_ending.to_string()));
    clean.insert("backspace".into(), Value::String(backspace.to_string()));
    clean.insert("localEcho".into(), Value::Bool(local_echo));
    clean.insert("profileId".into(), Value::String(profile.to_string()));
    if let Some(identity) = object.get("identity") {
        let text = identity.as_str()?;
        if text.is_empty() || text.len() > 256 || text.contains('\0') || has_control(text) {
            return None;
        }
        clean.insert("identity".into(), Value::String(text.to_string()));
    }
    if let Some(reconnect) = object.get("autoReconnect") {
        clean.insert("autoReconnect".into(), Value::Bool(reconnect.as_bool()?));
    }
    Some(Value::Object(clean))
}

/// Canonical connection for a save. SSH unknown keys are stripped; the caller
/// rejects the save when the result differs from the original. A serial config
/// with an unknown key is `None`.
pub(crate) fn canonical_connection(value: &Value) -> Option<Value> {
    let object = object_keys(value)?;
    let id = clean_id(object.get("id")?)?;
    let name = clean_name(object.get("name")?)?;
    let kind = object.get("kind")?.as_str()?;
    let mut clean = Map::new();
    clean.insert("id".into(), Value::String(id));
    clean.insert("name".into(), Value::String(name));
    clean.insert("kind".into(), Value::String(kind.to_string()));
    match kind {
        "ssh" => {
            let parts = canonical_ssh_parts(
                object.get("host")?,
                object.get("user"),
                object.get("port"),
            )?;
            for (key, part) in parts {
                clean.insert(key, part);
            }
        }
        "serial" => {
            if !allowed_keys(object, SERIAL_KEYS) {
                return None;
            }
            clean.insert("config".into(), clean_serial_config(object.get("config")?)?);
        }
        _ => return None,
    }
    Some(Value::Object(clean))
}

/// Load path. A bad entry is dropped, including an SSH object that carries an
/// unknown key. The first id wins and the list stops at 32.
pub(crate) fn load_connections(values: &[Value]) -> Vec<Value> {
    let mut kept = Vec::new();
    let mut seen = BTreeSet::new();
    for item in values {
        let Some(object) = object_keys(item) else {
            continue;
        };
        let kind = object.get("kind").and_then(Value::as_str);
        let allowed = match kind {
            Some("ssh") => allowed_keys(object, SSH_KEYS),
            Some("serial") => allowed_keys(object, SERIAL_KEYS),
            _ => false,
        };
        if !allowed {
            continue;
        }
        let Some(clean) = canonical_connection(item) else {
            continue;
        };
        let Some(id) = clean.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !seen.insert(id.to_string()) {
            continue;
        }
        kept.push(clean);
        if kept.len() == 32 {
            break;
        }
    }
    kept
}

fn connections_error(values: &[Value]) -> Result<Vec<Value>, String> {
    let mut cleaned = Vec::new();
    let mut seen = BTreeSet::new();
    for item in values {
        let Some(clean) = canonical_connection(item) else {
            return Err("Saved connection is not valid".into());
        };
        let id = clean
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if !seen.insert(id) {
            return Err("Saved connection is not valid".into());
        }
        cleaned.push(clean);
    }
    if cleaned.len() > 32 {
        return Err("Too many saved connections".into());
    }
    if cleaned != values {
        return Err("Saved connection is not valid".into());
    }
    Ok(cleaned)
}

fn sanitize(prefs: &mut Prefs) {
    prefs.drive_endpoint = normalize_endpoint(&prefs.drive_endpoint).unwrap_or_default();
    if !prefs.drive_region.is_empty() && !region_ok(&prefs.drive_region) {
        prefs.drive_region = default_region();
    }
    if bucket_error(&prefs.drive_bucket).is_some() {
        prefs.drive_bucket.clear();
    }
    if access_key_error(&prefs.drive_access_key_id).is_some() {
        prefs.drive_access_key_id.clear();
    }
    if prefs.drive_secret_source != "env" && prefs.drive_secret_source != "file" {
        prefs.drive_secret_source = default_secret_source();
    }
    if !secret_path_ok(&prefs.drive_secret_path) {
        prefs.drive_secret_path.clear();
    }
    if !matches!(prefs.restore_sessions.as_str(), "off" | "local" | "reconnect") {
        prefs.restore_sessions = default_restore();
    }
    prefs.connections = load_connections(&prefs.connections);
}

fn validate_extras(prefs: &Prefs) -> Result<(), String> {
    if !(1.0..=2.0).contains(&prefs.line_height) {
        return Err("line height must be between 1 and 2".into());
    }
    if !matches!(prefs.bell_style.as_str(), "none" | "visual" | "sound") {
        return Err("bell style must be none, visual or sound".into());
    }
    Ok(())
}

/// Reject a save that is out of range. A valid endpoint is stored in normalized form.
pub fn checked(prefs: &Prefs) -> Result<Prefs, String> {
    if !(0.0..=1.0).contains(&prefs.transparency) {
        return Err("transparency must be between 0 and 1".into());
    }
    if !(8..=32).contains(&prefs.font_size) {
        return Err("font size must be between 8 and 32".into());
    }
    if prefs.scrollback > 100_000 {
        return Err("scrollback is too large".into());
    }
    validate_extras(prefs)?;
    let mut next = prefs.clone();
    next.drive_endpoint = if prefs.drive_endpoint.is_empty() {
        String::new()
    } else {
        normalize_endpoint(&prefs.drive_endpoint).map_err(|_| "Endpoint is not valid".to_string())?
    };
    if let Some(error) = region_error(&prefs.drive_region) {
        return Err(error.into());
    }
    if let Some(error) = bucket_error(&prefs.drive_bucket) {
        return Err(error.into());
    }
    if let Some(error) = access_key_error(&prefs.drive_access_key_id) {
        return Err(error.into());
    }
    if prefs.drive_secret_source != "env" && prefs.drive_secret_source != "file" {
        return Err("Secret source is not valid".into());
    }
    if !secret_path_ok(&prefs.drive_secret_path) {
        return Err("Secret file path is not valid".into());
    }
    if !matches!(prefs.restore_sessions.as_str(), "off" | "local" | "reconnect") {
        return Err("Restore choice is not valid".into());
    }
    next.connections = connections_error(&prefs.connections)?;
    Ok(next)
}

pub fn save(app: &AppHandle, prefs: &Prefs) -> Result<(), String> {
    let prefs = checked(prefs)?;
    let path = prefs_path(app)?;
    let text = serde_json::to_string_pretty(&prefs).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_preferences_and_palettes_round_trip() {
        let mut value = serde_json::to_value(Prefs::default()).unwrap();
        value.as_object_mut().unwrap().remove("theme_overrides");
        let mut prefs: Prefs = serde_json::from_value(value).unwrap();
        assert!(prefs.theme_overrides.is_empty());
        let mut palette = ThemeOverrides::default();
        palette.terminal.insert("red".into(), "#123456".into());
        prefs.theme_overrides.insert("signal".into(), palette);
        let restored: Prefs =
            serde_json::from_str(&serde_json::to_string(&prefs).unwrap()).unwrap();
        assert_eq!(
            restored.theme_overrides["signal"].terminal["red"],
            "#123456"
        );
    }

    #[test]
    fn older_files_get_safe_defaults_for_new_fields() {
        let mut value = serde_json::to_value(Prefs::default()).unwrap();
        for key in [
            "line_height", "cursor_blink", "bell_style", "option_as_meta", "copy_on_select",
            "screen_reader_mode", "review_new_tabs", "new_tab_directory", "confirm_close_busy",
            "open_links", "mark_background_tabs", "notify_system", "restore_sessions", "connections",
        ] {
            value.as_object_mut().unwrap().remove(key);
        }
        let prefs: Prefs = serde_json::from_value(value).unwrap();
        assert!(!prefs.review_new_tabs);
        assert!(!prefs.copy_on_select);
        assert_eq!(prefs.bell_style, "none");
        assert_eq!(prefs.line_height, 1.0);
        assert!(prefs.new_tab_directory);
        assert!(prefs.confirm_close_busy);
        assert!(prefs.open_links);
        assert!(prefs.mark_background_tabs);
        assert!(!prefs.notify_system);
        assert_eq!(prefs.restore_sessions, "off");
        assert!(prefs.connections.is_empty());
        assert!(validate_extras(&prefs).is_ok());
    }

    #[test]
    fn invalid_new_fields_are_refused() {
        let mut prefs = Prefs::default();
        prefs.bell_style = "klaxon".into();
        assert!(validate_extras(&prefs).is_err());
        prefs.bell_style = "sound".into();
        prefs.line_height = 3.0;
        assert!(validate_extras(&prefs).is_err());
    }

    #[test]
    fn defaults_are_sane() {
        let prefs = Prefs::default();
        assert!(prefs.transparency > 0.0 && prefs.transparency <= 1.0);
        assert!(!prefs.ai_enabled);
        assert!(!prefs.blocks_enabled);
        assert!(!prefs.blocks_shell_integration);
        assert_eq!(prefs.drive_region, "us-east-1");
        assert!(prefs.drive_endpoint.is_empty());
        assert!(prefs.font_size >= 8);
        assert_eq!(prefs.restore_sessions, "off");
        assert!(prefs.new_tab_directory);
        assert!(!prefs.notify_system);
    }

    fn ssh_connection(id: &str, name: &str) -> Value {
        serde_json::json!({
            "id": id,
            "name": name,
            "kind": "ssh",
            "host": "web1",
            "user": null,
            "port": null
        })
    }

    fn serial_config() -> Value {
        serde_json::json!({
            "path": "/dev/ttyUSB0",
            "baud": 9600,
            "data_bits": 8,
            "parity": "none",
            "stop_bits": 1,
            "flow_control": "none",
            "production": true,
            "lineEnding": "cr",
            "backspace": "del",
            "localEcho": false,
            "profileId": "generic"
        })
    }

    #[test]
    fn saved_connections_reject_secrets_and_keep_a_valid_list() {
        let id = "00000000-0000-4000-8000-000000000001";
        let good = ssh_connection(id, "edge");
        assert_eq!(canonical_connection(&good).as_ref(), Some(&good));
        let mut prefs = Prefs::default();
        prefs.connections = vec![good.clone()];
        assert_eq!(checked(&prefs).unwrap().connections, vec![good.clone()]);

        let mut with_password = good.clone();
        with_password["password"] = Value::String("secret".into());
        prefs.connections = vec![with_password.clone()];
        assert_eq!(checked(&prefs).unwrap_err(), "Saved connection is not valid");
        let mut loaded = Prefs::default();
        loaded.connections = vec![with_password];
        sanitize(&mut loaded);
        assert!(loaded.connections.is_empty());

        let mut serial = serde_json::json!({
            "id": id,
            "name": "console",
            "kind": "serial",
            "config": serial_config()
        });
        assert_eq!(canonical_connection(&serial).as_ref(), Some(&serial));
        serial["config"]["password"] = Value::String("secret".into());
        assert!(canonical_connection(&serial).is_none());
        prefs.connections = vec![serial];
        assert_eq!(checked(&prefs).unwrap_err(), "Saved connection is not valid");

        let spaced = ssh_connection(id, "  edge  ");
        assert!(canonical_connection(&spaced).is_some());
        prefs.connections = vec![spaced.clone(), ssh_connection("00000000-0000-4000-8000-000000000002", "two")];
        assert_eq!(checked(&prefs).unwrap_err(), "Saved connection is not valid");

        let mut many = Vec::new();
        for index in 0..33 {
            many.push(ssh_connection(&format!("00000000-0000-4000-8000-{index:012}"), "n"));
        }
        prefs.connections = many;
        assert_eq!(checked(&prefs).unwrap_err(), "Too many saved connections");

        let mut untrimmed = Vec::new();
        for index in 0..33 {
            untrimmed.push(ssh_connection(
                &format!("00000000-0000-4000-8000-{index:012}"),
                " spaced ",
            ));
        }
        prefs.connections = untrimmed;
        assert_eq!(checked(&prefs).unwrap_err(), "Too many saved connections");

        let mut invalid_tail = Vec::new();
        for index in 0..32 {
            invalid_tail.push(ssh_connection(&format!("00000000-0000-4000-8000-{index:012}"), "n"));
        }
        let mut bad_serial = serde_json::json!({
            "id": "00000000-0000-4000-8000-000000000099",
            "name": "bad",
            "kind": "serial",
            "config": serial_config()
        });
        bad_serial["config"]["password"] = Value::String("nope".into());
        invalid_tail.push(bad_serial);
        prefs.connections = invalid_tail;
        assert_eq!(checked(&prefs).unwrap_err(), "Saved connection is not valid");

        let float_port = serde_json::from_str::<Value>(
            r#"{"id":"00000000-0000-4000-8000-000000000001","name":"edge","kind":"ssh","host":"web1","user":null,"port":2222.5}"#,
        )
        .unwrap();
        assert!(canonical_connection(&float_port).is_none());
        let integral = serde_json::from_str::<Value>(
            r#"{"id":"00000000-0000-4000-8000-000000000001","name":"edge","kind":"ssh","host":"web1","user":"alice","port":2222.0}"#,
        )
        .unwrap();
        let cleaned = canonical_connection(&integral).unwrap();
        assert_eq!(cleaned["port"], serde_json::json!(2222));
        assert_eq!(cleaned["user"], serde_json::json!("alice"));

        let mut odd = serde_json::to_value(Prefs::default()).unwrap();
        odd["connections"] = serde_json::json!(null);
        odd["restore_sessions"] = serde_json::json!("nope");
        let mut restored: Prefs = serde_json::from_value(odd).unwrap();
        sanitize(&mut restored);
        assert!(restored.connections.is_empty());
        assert_eq!(restored.restore_sessions, "off");
        restored.restore_sessions = "reconnect".into();
        assert!(checked(&restored).is_ok());
    }

    #[test]
    fn endpoint_keeps_an_explicit_port_and_rejects_the_rest() {
        assert_eq!(normalize_endpoint("").unwrap(), "");
        assert_eq!(
            normalize_endpoint("https://API.DarkStorage.io:443/s3/").unwrap(),
            "https://api.darkstorage.io:443/s3"
        );
        assert_eq!(
            normalize_endpoint("https://api.darkstorage.io/s3").unwrap(),
            "https://api.darkstorage.io/s3"
        );
        assert_eq!(
            normalize_endpoint("https://api.darkstorage.io:0443/s3").unwrap(),
            "https://api.darkstorage.io:443/s3"
        );
        assert_eq!(
            normalize_endpoint("https://[2001:DB8::1]/s3").unwrap(),
            "https://[2001:db8::1]/s3"
        );
        assert_eq!(
            normalize_endpoint("https://[::1]:8443/s3").unwrap(),
            "https://[::1]:8443/s3"
        );
        for bad in [
            "http://api.darkstorage.io/s3",
            "https://user:secret@api.darkstorage.io/s3",
            "https://api.darkstorage.io/s3?x=1",
            "https://api.darkstorage.io//s3",
            "https://api.darkstorage.io:0/s3",
            "https://api.darkstorage.io/s3#frag",
            "https://api.darkstorage.io/S3",
        ] {
            assert!(normalize_endpoint(bad).is_err(), "{bad}");
        }
        assert!(normalize_endpoint(&format!("https://{}/s3", "a".repeat(200))).is_err());
        assert!(normalize_endpoint("https://api.darkstorage.io/s3\n").is_err());
    }

    #[test]
    fn load_sanitizes_drive_fields_and_save_rejects_them() {
        let mut prefs = Prefs::default();
        prefs.drive_endpoint = "https://API.Example.com:443/s3/".into();
        prefs.drive_region = "Nope".into();
        prefs.drive_bucket = "bad..name".into();
        prefs.drive_access_key_id = "has space".into();
        prefs.drive_secret_source = "vault".into();
        prefs.drive_secret_path = "bad\npath".into();
        sanitize(&mut prefs);
        assert_eq!(prefs.drive_endpoint, "https://api.example.com:443/s3");
        assert_eq!(prefs.drive_region, "us-east-1");
        assert!(prefs.drive_bucket.is_empty());
        assert!(prefs.drive_access_key_id.is_empty());
        assert_eq!(prefs.drive_secret_source, "env");
        assert!(prefs.drive_secret_path.is_empty());

        let mut empty_region = Prefs::default();
        empty_region.drive_region.clear();
        sanitize(&mut empty_region);
        assert!(empty_region.drive_region.is_empty());
        assert_eq!(checked(&empty_region).unwrap_err(), "Signing region is not valid");

        let mut bad_endpoint = Prefs::default();
        bad_endpoint.drive_endpoint = "http://example.com/s3".into();
        assert_eq!(checked(&bad_endpoint).unwrap_err(), "Endpoint is not valid");
        let mut kept = Prefs::default();
        kept.drive_endpoint = "https://API.Example.com/s3/".into();
        assert_eq!(checked(&kept).unwrap().drive_endpoint, "https://api.example.com/s3");
    }
}
