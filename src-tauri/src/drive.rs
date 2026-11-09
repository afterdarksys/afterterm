//! Drive speaks the S3 API of darkstorage.io, a fully S3-compatible storage system.
//!
//! Threats: a webview or a hostile response trying to exfiltrate the secret,
//! follow a redirect, parse a DTD, or write outside the dialog path. The secret
//! is never stored in preferences, never logged, and never compared with ==.
//! TLS verification stays on. aws-sigv4 may retain its own copy during signing.
//! This client holds each object in memory and refuses anything over 8 MiB.
//! Paths come from the native dialog, never from the webview.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use aws_credential_types::Credentials;
use aws_sigv4::http_request::{sign, PayloadChecksumKind, SignableBody, SignableRequest, SigningSettings};
use aws_sigv4::sign::v4;
use aws_smithy_runtime_api::client::identity::Identity;
use serde::Serialize;
use tauri::AppHandle;
use zeroize::Zeroize;

use crate::prefs::{access_key_error, bucket_error, region_error, require_endpoint};

const MAX_OBJECT_BYTES: usize = 8 * 1024 * 1024;
const MAX_LIST_BYTES: usize = 2 * 1024 * 1024;
const MAX_PREVIEW_BYTES: usize = 256 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;
const SIGN_FAILED: &str = "The request could not be signed";
const CONNECTION: &str = "Drive request failed (connection)";
const SECRET_UNAVAILABLE: &str = "The secret file is not available";
const SECRET_UNREADABLE: &str = "The secret file could not be read";
const NO_SECRET: &str = "No secret access key is available";
const FILE_UNAVAILABLE: &str = "The file is not available";
const RESPONSE_INVALID: &str = "Drive response is not valid";

pub(crate) struct Secret(String);

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl Secret {
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Serialize)]
pub struct ObjectList {
    pub keys: Vec<String>,
    pub prefixes: Vec<String>,
    pub truncated: bool,
}

struct DrivePrefs {
    endpoint: String,
    region: String,
    bucket: String,
    access_key: String,
    secret_source: String,
    secret_path: String,
}

pub(crate) fn secret_from_env(vars: &[(&str, Option<String>)]) -> Result<Secret, String> {
    for (_name, value) in vars {
        if let Some(value) = value {
            if value.is_empty() || value.len() > 4096 || value.chars().any(|c| c.is_control()) {
                return Err(NO_SECRET.into());
            }
            return Ok(Secret(value.clone()));
        }
    }
    Err(NO_SECRET.into())
}

fn env_present(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

pub(crate) fn validate_object_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 1024 || key.contains('\\') || key.starts_with('/') || key.chars().any(|c| c.is_control()) {
        return Err("Object key is not valid".into());
    }
    let parts: Vec<&str> = key.split('/').collect();
    for (index, part) in parts.iter().enumerate() {
        if part.is_empty() {
            if index + 1 != parts.len() {
                return Err("Object key is not valid".into());
            }
        } else if *part == "." || *part == ".." {
            return Err("Object key is not valid".into());
        }
    }
    Ok(())
}

pub(crate) fn encode_component(text: &str, preserve_slash: bool) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        let plain = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') || (preserve_slash && byte == b'/');
        if plain {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub(crate) fn host_header(endpoint: &str) -> String {
    endpoint.trim_start_matches("https://").trim_end_matches("/s3").to_string()
}

pub(crate) fn object_url(endpoint: &str, bucket: &str, key: &str) -> String {
    format!("{endpoint}/{bucket}/{}", encode_component(key, true))
}

pub(crate) fn list_objects_url(endpoint: &str, bucket: &str, prefix: &str, flat: bool) -> String {
    let mut query = String::new();
    if !flat {
        query.push_str("delimiter=%2F&");
    }
    query.push_str("max-keys=200&prefix=");
    query.push_str(&encode_component(prefix, false));
    format!("{endpoint}/{bucket}?{query}")
}

pub(crate) fn drive_delete_flow(
    key: &str,
    confirm: &str,
    bucket: &str,
    access_key: &str,
    read_secret: impl FnOnce() -> Result<Secret, String>,
) -> Result<Secret, String> {
    validate_object_key(key)?;
    if confirm != key {
        return Err("Type the object key to confirm delete".into());
    }
    if bucket.is_empty() {
        return Err("No bucket is configured".into());
    }
    if let Some(error) = bucket_error(bucket) {
        return Err(error.into());
    }
    if access_key.is_empty() {
        return Err("No access key id is configured".into());
    }
    if let Some(error) = access_key_error(access_key) {
        return Err(error.into());
    }
    read_secret()
}

pub(crate) fn prepare_delete(
    endpoint: &str,
    region: &str,
    key: &str,
    confirm: &str,
    bucket: &str,
    access_key: &str,
    read_secret: impl FnOnce() -> Result<Secret, String>,
) -> Result<(String, Secret), String> {
    let endpoint = require_endpoint(endpoint)?;
    if let Some(error) = region_error(region) {
        return Err(error.into());
    }
    let secret = drive_delete_flow(key, confirm, bucket, access_key, read_secret)?;
    Ok((endpoint, secret))
}

pub(crate) fn prepare_put(
    endpoint: &str,
    region: &str,
    key: &str,
    bucket: &str,
    access_key: &str,
    size: u64,
    read_secret: impl FnOnce() -> Result<Secret, String>,
) -> Result<Secret, String> {
    require_endpoint(endpoint)?;
    if let Some(error) = region_error(region) {
        return Err(error.into());
    }
    validate_object_key(key)?;
    if bucket.is_empty() {
        return Err("No bucket is configured".into());
    }
    if let Some(error) = bucket_error(bucket) {
        return Err(error.into());
    }
    if access_key.is_empty() {
        return Err("No access key id is configured".into());
    }
    if let Some(error) = access_key_error(access_key) {
        return Err(error.into());
    }
    if size > MAX_OBJECT_BYTES as u64 {
        return Err("Upload is larger than 8 MiB".into());
    }
    read_secret()
}

struct Signed {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    send_body: bool,
}

fn sign_request(
    method: &str,
    url: &str,
    host: &str,
    region: &str,
    access_key: &str,
    secret: &Secret,
    payload: &[u8],
    send_body: bool,
    time: SystemTime,
) -> Result<Signed, String> {
    let mut settings = SigningSettings::default();
    settings.payload_checksum_kind = PayloadChecksumKind::XAmzSha256;
    let credentials = Credentials::new(access_key, secret.expose(), None, None, "afterterm");
    let identity = Identity::new(credentials, None);
    let built = v4::SigningParams::builder()
        .identity(&identity)
        .region(region)
        .name("s3")
        .time(time)
        .settings(settings)
        .build()
        .map_err(|_| SIGN_FAILED.to_string())?;
    let params: aws_sigv4::http_request::SigningParams = built.into();
    let headers = [("host", host)];
    let body = if send_body { SignableBody::Bytes(payload) } else { SignableBody::empty() };
    let signable = SignableRequest::new(method, url, headers.into_iter(), body).map_err(|_| SIGN_FAILED.to_string())?;
    let output = sign(signable, &params).map_err(|_| SIGN_FAILED.to_string())?;
    let signed_headers: Vec<(String, String)> = output.output().headers().map(|(key, value)| (key.to_string(), value.to_string())).collect();
    drop(identity);
    Ok(Signed {
        method: method.to_string(),
        url: url.to_string(),
        headers: signed_headers,
        body: if send_body { payload.to_vec() } else { Vec::new() },
        send_body,
    })
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(20))
        .timeout_write(Duration::from_secs(20))
        .redirects(0)
        .build()
}

enum Fetch {
    Body(Vec<u8>),
    Status { code: u16, body: Vec<u8> },
}

fn execute(signed: Signed, max_body: usize) -> Result<Vec<u8>, String> {
    let result = (|| -> Result<Fetch, String> {
        let mut request = agent().request(&signed.method, &signed.url);
        for (key, value) in &signed.headers {
            request = request.set(key, value);
        }
        let response = if signed.send_body {
            request.send_bytes(&signed.body)
        } else {
            request.call()
        };
        match response {
            Ok(response) => match read_bounded(response.into_reader(), max_body) {
                Ok(body) => Ok(Fetch::Body(body)),
                Err(Bound::TooLarge) => Err("too-large".into()),
                Err(Bound::Io) => Err(CONNECTION.into()),
            },
            Err(ureq::Error::Status(code, response)) => {
                let body = read_capped(response.into_reader(), MAX_ERROR_BYTES).unwrap_or_default();
                Ok(Fetch::Status { code, body })
            }
            Err(_) => Err(CONNECTION.into()),
        }
    })();
    match result {
        Ok(Fetch::Body(body)) => Ok(body),
        Ok(Fetch::Status { code, body }) => Err(error_message(code, &body)),
        Err(error) if error == "too-large" => Err("too-large".into()),
        Err(error) => Err(error),
    }
}

enum Bound {
    TooLarge,
    Io,
}

fn read_bounded(mut reader: impl Read, max: usize) -> Result<Vec<u8>, Bound> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    loop {
        let read = match reader.read(&mut tmp) {
            Ok(0) => return Ok(buf),
            Ok(n) => n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(Bound::Io),
        };
        if buf.len() + read > max {
            return Err(Bound::TooLarge);
        }
        buf.extend_from_slice(&tmp[..read]);
    }
}

fn read_capped(mut reader: impl Read, max: usize) -> std::io::Result<Vec<u8>> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    while buf.len() < max {
        let read = match reader.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let room = max - buf.len();
        buf.extend_from_slice(&tmp[..read.min(room)]);
    }
    Ok(buf)
}

fn error_message(status: u16, body: &[u8]) -> String {
    let Some(text) = std::str::from_utf8(body).ok() else {
        return format!("Drive request failed ({status})");
    };
    if dangerous_xml(text) {
        return format!("Drive request failed ({status})");
    }
    if let Ok(doc) = parse_document(text) {
        if let Some(code) = doc.error_code {
            return format!("Drive request failed ({status} {code})");
        }
    }
    format!("Drive request failed ({status})")
}

fn load_prefs(app: &AppHandle) -> DrivePrefs {
    let prefs = crate::prefs::load(app).unwrap_or_default();
    DrivePrefs {
        endpoint: prefs.drive_endpoint,
        region: prefs.drive_region,
        bucket: prefs.drive_bucket,
        access_key: prefs.drive_access_key_id,
        secret_source: prefs.drive_secret_source,
        secret_path: prefs.drive_secret_path,
    }
}

fn read_configured_secret(prefs: &DrivePrefs, protected: &[PathBuf]) -> Result<Secret, String> {
    match prefs.secret_source.as_str() {
        "env" => secret_from_env(&[
            ("DARKSTORAGE_SECRET_ACCESS_KEY", env_present("DARKSTORAGE_SECRET_ACCESS_KEY")),
            ("AWS_SECRET_ACCESS_KEY", env_present("AWS_SECRET_ACCESS_KEY")),
        ]),
        "file" => read_secret_file(Path::new(&prefs.secret_path), protected),
        _ => Err("Secret source is not valid".into()),
    }
}

fn require_access(access_key: &str) -> Result<(), String> {
    if access_key.is_empty() {
        return Err("No access key id is configured".into());
    }
    if let Some(error) = access_key_error(access_key) {
        return Err(error.into());
    }
    Ok(())
}

fn require_bucket(bucket: &str) -> Result<(), String> {
    if bucket.is_empty() {
        return Err("No bucket is configured".into());
    }
    if let Some(error) = bucket_error(bucket) {
        return Err(error.into());
    }
    Ok(())
}

fn size_error(label: &str) -> String {
    match label {
        "preview" => "Object preview is too large".into(),
        "download" => "Download is larger than 8 MiB".into(),
        _ => "Drive response is too large".into(),
    }
}

fn call(signed: Signed, max_body: usize, label: &str) -> Result<Vec<u8>, String> {
    match execute(signed, max_body) {
        Err(error) if error == "too-large" => Err(size_error(label)),
        other => other,
    }
}

fn success_xml(body: &[u8]) -> Result<(), String> {
    if body.is_empty() {
        return Ok(());
    }
    let text = std::str::from_utf8(body).map_err(|_| RESPONSE_INVALID.to_string())?;
    if text.trim().is_empty() {
        return Ok(());
    }
    let doc = parse_document(text)?;
    if doc.saw_error {
        return Err(RESPONSE_INVALID.into());
    }
    Ok(())
}

#[tauri::command]
pub async fn drive_list_buckets(app: AppHandle) -> Result<Vec<String>, String> {
    let prefs = load_prefs(&app);
    let endpoint = require_endpoint(&prefs.endpoint)?;
    if let Some(error) = region_error(&prefs.region) {
        return Err(error.into());
    }
    require_access(&prefs.access_key)?;
    let protected = crate::protected_dirs(&app);
    let secret = read_configured_secret(&prefs, &protected)?;
    let signed = sign_request("GET", &endpoint, &host_header(&endpoint), &prefs.region, &prefs.access_key, &secret, b"", false, SystemTime::now())?;
    drop(secret);
    let body = tauri::async_runtime::spawn_blocking(move || call(signed, MAX_LIST_BYTES, "list"))
        .await
        .map_err(|_| CONNECTION.to_string())??;
    let text = std::str::from_utf8(&body).map_err(|_| RESPONSE_INVALID.to_string())?;
    let doc = parse_document(text)?;
    if doc.saw_error {
        return Err(RESPONSE_INVALID.into());
    }
    Ok(doc.buckets)
}

#[tauri::command]
pub async fn drive_list_objects(app: AppHandle, prefix: String, flat: bool) -> Result<ObjectList, String> {
    let prefs = load_prefs(&app);
    let endpoint = require_endpoint(&prefs.endpoint)?;
    if let Some(error) = region_error(&prefs.region) {
        return Err(error.into());
    }
    if !prefix.is_empty() {
        validate_object_key(&prefix)?;
    }
    require_bucket(&prefs.bucket)?;
    require_access(&prefs.access_key)?;
    let protected = crate::protected_dirs(&app);
    let secret = read_configured_secret(&prefs, &protected)?;
    let url = list_objects_url(&endpoint, &prefs.bucket, &prefix, flat);
    let signed = sign_request("GET", &url, &host_header(&endpoint), &prefs.region, &prefs.access_key, &secret, b"", false, SystemTime::now())?;
    drop(secret);
    let body = tauri::async_runtime::spawn_blocking(move || call(signed, MAX_LIST_BYTES, "list"))
        .await
        .map_err(|_| CONNECTION.to_string())??;
    let text = std::str::from_utf8(&body).map_err(|_| RESPONSE_INVALID.to_string())?;
    let doc = parse_document(text)?;
    if doc.saw_error {
        return Err(RESPONSE_INVALID.into());
    }
    Ok(ObjectList { keys: doc.keys, prefixes: doc.prefixes, truncated: doc.truncated })
}

#[tauri::command]
pub async fn drive_preview(app: AppHandle, key: String) -> Result<String, String> {
    let prefs = load_prefs(&app);
    let endpoint = require_endpoint(&prefs.endpoint)?;
    if let Some(error) = region_error(&prefs.region) {
        return Err(error.into());
    }
    validate_object_key(&key)?;
    require_bucket(&prefs.bucket)?;
    require_access(&prefs.access_key)?;
    let protected = crate::protected_dirs(&app);
    let secret = read_configured_secret(&prefs, &protected)?;
    let url = object_url(&endpoint, &prefs.bucket, &key);
    let signed = sign_request("GET", &url, &host_header(&endpoint), &prefs.region, &prefs.access_key, &secret, b"", false, SystemTime::now())?;
    drop(secret);
    let body = tauri::async_runtime::spawn_blocking(move || call(signed, MAX_PREVIEW_BYTES, "preview"))
        .await
        .map_err(|_| CONNECTION.to_string())??;
    String::from_utf8(body).map_err(|_| "Object preview is not UTF-8 text".to_string())
}

#[tauri::command]
pub async fn drive_put_text(app: AppHandle, key: String, text: String) -> Result<(), String> {
    let prefs = load_prefs(&app);
    if text.len() > MAX_OBJECT_BYTES {
        return Err("Upload is larger than 8 MiB".into());
    }
    let protected = crate::protected_dirs(&app);
    let secret = prepare_put(&prefs.endpoint, &prefs.region, &key, &prefs.bucket, &prefs.access_key, text.len() as u64, || {
        read_configured_secret(&prefs, &protected)
    })?;
    let endpoint = require_endpoint(&prefs.endpoint)?;
    let url = object_url(&endpoint, &prefs.bucket, &key);
    let bytes = text.into_bytes();
    let signed = sign_request("PUT", &url, &host_header(&endpoint), &prefs.region, &prefs.access_key, &secret, &bytes, true, SystemTime::now())?;
    drop(secret);
    let body = tauri::async_runtime::spawn_blocking(move || call(signed, MAX_LIST_BYTES, "list"))
        .await
        .map_err(|_| CONNECTION.to_string())??;
    success_xml(&body)
}

#[tauri::command]
pub async fn drive_put_file(app: AppHandle, window: tauri::Window, key: String) -> Result<Option<String>, String> {
    let prefs = load_prefs(&app);
    require_endpoint(&prefs.endpoint)?;
    if let Some(error) = region_error(&prefs.region) {
        return Err(error.into());
    }
    validate_object_key(&key)?;
    require_bucket(&prefs.bucket)?;
    require_access(&prefs.access_key)?;
    let Some(path) = crate::choose_open_path(&app, &window).await? else {
        return Ok(None);
    };
    let protected = crate::protected_dirs(&app);
    let secret_path = if prefs.secret_source == "file" && !prefs.secret_path.is_empty() {
        Some(PathBuf::from(&prefs.secret_path))
    } else {
        None
    };
    let endpoint = require_endpoint(&prefs.endpoint)?;
    let region = prefs.region.clone();
    let bucket = prefs.bucket.clone();
    let access = prefs.access_key.clone();
    let source = prefs.secret_source.clone();
    let configured_secret = prefs.secret_path.clone();
    let body = tauri::async_runtime::spawn_blocking(move || {
        let bytes = read_upload(&path, &protected, secret_path.as_deref())?;
        let secret = if source == "file" {
            read_secret_file(Path::new(&configured_secret), &protected)?
        } else if source == "env" {
            secret_from_env(&[
                ("DARKSTORAGE_SECRET_ACCESS_KEY", env_present("DARKSTORAGE_SECRET_ACCESS_KEY")),
                ("AWS_SECRET_ACCESS_KEY", env_present("AWS_SECRET_ACCESS_KEY")),
            ])?
        } else {
            return Err("Secret source is not valid".into());
        };
        let url = object_url(&endpoint, &bucket, &key);
        let signed = sign_request("PUT", &url, &host_header(&endpoint), &region, &access, &secret, &bytes, true, SystemTime::now())?;
        drop(secret);
        let response = call(signed, MAX_LIST_BYTES, "list")?;
        success_xml(&response)
    })
    .await
    .map_err(|_| CONNECTION.to_string())??;
    let _ = body;
    Ok(Some("Upload saved".into()))
}

#[tauri::command]
pub async fn drive_download(app: AppHandle, window: tauri::Window, key: String) -> Result<Option<String>, String> {
    let prefs = load_prefs(&app);
    let endpoint = require_endpoint(&prefs.endpoint)?;
    if let Some(error) = region_error(&prefs.region) {
        return Err(error.into());
    }
    validate_object_key(&key)?;
    require_bucket(&prefs.bucket)?;
    require_access(&prefs.access_key)?;
    let protected = crate::protected_dirs(&app);
    let secret = read_configured_secret(&prefs, &protected)?;
    let url = object_url(&endpoint, &prefs.bucket, &key);
    let signed = sign_request("GET", &url, &host_header(&endpoint), &prefs.region, &prefs.access_key, &secret, b"", false, SystemTime::now())?;
    drop(secret);
    let bytes = tauri::async_runtime::spawn_blocking(move || call(signed, MAX_OBJECT_BYTES, "download"))
        .await
        .map_err(|_| CONNECTION.to_string())??;
    let suggested = key.rsplit('/').next().unwrap_or("object");
    let Some(path) = crate::choose_save_path(&app, &window, suggested, "Any file", "bin").await.map_err(|_| FILE_UNAVAILABLE.to_string())? else {
        return Ok(None);
    };
    let protected = crate::protected_dirs(&app);
    tauri::async_runtime::spawn_blocking(move || write_download(&path, &bytes, &protected))
        .await
        .map_err(|_| FILE_UNAVAILABLE.to_string())??;
    Ok(Some("Download saved".into()))
}

#[tauri::command]
pub async fn drive_delete(app: AppHandle, key: String, confirm: String) -> Result<(), String> {
    let prefs = load_prefs(&app);
    let protected = crate::protected_dirs(&app);
    let (endpoint, secret) = prepare_delete(&prefs.endpoint, &prefs.region, &key, &confirm, &prefs.bucket, &prefs.access_key, || {
        read_configured_secret(&prefs, &protected)
    })?;
    let url = object_url(&endpoint, &prefs.bucket, &key);
    let signed = sign_request("DELETE", &url, &host_header(&endpoint), &prefs.region, &prefs.access_key, &secret, b"", false, SystemTime::now())?;
    drop(secret);
    let body = tauri::async_runtime::spawn_blocking(move || call(signed, MAX_LIST_BYTES, "list"))
        .await
        .map_err(|_| CONNECTION.to_string())??;
    success_xml(&body)
}

fn read_secret_file(path: &Path, protected: &[PathBuf]) -> Result<Secret, String> {
    #[cfg(not(unix))]
    {
        let _ = (path, protected);
        return Err(SECRET_UNAVAILABLE.into());
    }
    #[cfg(unix)]
    read_secret_file_unix(path, protected)
}

#[cfg(unix)]
fn read_secret_file_unix(path: &Path, protected: &[PathBuf]) -> Result<Secret, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(SECRET_UNAVAILABLE.into());
    }
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(SECRET_UNREADABLE.into()),
        Err(_) => return Err(SECRET_UNAVAILABLE.into()),
    };
    if meta.file_type().is_symlink() || !meta.is_file() || meta.nlink() != 1 || meta.uid() != unsafe { libc::geteuid() } {
        return Err(SECRET_UNAVAILABLE.into());
    }
    if meta.mode() & 0o077 != 0 || meta.len() > 4096 {
        return Err(SECRET_UNAVAILABLE.into());
    }
    if meta.len() == 0 {
        return Err(NO_SECRET.into());
    }
    if under_protected(path, protected) {
        return Err(SECRET_UNAVAILABLE.into());
    }
    let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path).map_err(|error| {
        if error.raw_os_error() == Some(libc::ELOOP) {
            SECRET_UNAVAILABLE.to_string()
        } else {
            SECRET_UNREADABLE.to_string()
        }
    })?;
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        bytes.zeroize();
        return Err(SECRET_UNREADABLE.into());
    }
    if bytes.len() > 4096 {
        bytes.zeroize();
        return Err(SECRET_UNAVAILABLE.into());
    }
    let mut text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => {
            let mut bytes = error.into_bytes();
            bytes.zeroize();
            return Err(SECRET_UNAVAILABLE.into());
        }
    };
    if text.ends_with('\n') {
        text.pop();
        if text.ends_with('\r') {
            text.pop();
        }
    }
    if text.is_empty() {
        text.zeroize();
        return Err(NO_SECRET.into());
    }
    if text.chars().any(|c| c.is_control()) {
        text.zeroize();
        return Err(SECRET_UNAVAILABLE.into());
    }
    Ok(Secret(text))
}

fn under_protected(path: &Path, protected: &[PathBuf]) -> bool {
    let Some(parent) = path.parent() else {
        return true;
    };
    let Ok(parent) = parent.canonicalize() else {
        return true;
    };
    protected.iter().any(|dir| {
        let dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        parent.starts_with(&dir)
    })
}

fn read_upload(path: &Path, protected: &[PathBuf], secret_file: Option<&Path>) -> Result<Vec<u8>, String> {
    #[cfg(not(unix))]
    {
        let _ = (path, protected, secret_file);
        return Err(FILE_UNAVAILABLE.into());
    }
    #[cfg(unix)]
    read_upload_unix(path, protected, secret_file)
}

#[cfg(unix)]
fn read_upload_unix(path: &Path, protected: &[PathBuf], secret_file: Option<&Path>) -> Result<Vec<u8>, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    if !path.is_absolute() || under_protected(path, protected) {
        return Err(FILE_UNAVAILABLE.into());
    }
    let meta = fs::symlink_metadata(path).map_err(|_| FILE_UNAVAILABLE.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.nlink() != 1 || meta.uid() != unsafe { libc::geteuid() } {
        return Err(FILE_UNAVAILABLE.into());
    }
    if meta.len() > MAX_OBJECT_BYTES as u64 {
        return Err("Upload is larger than 8 MiB".into());
    }
    if let Some(secret) = secret_file {
        if !secret.as_os_str().is_empty() {
            if let (Ok(upload), Ok(secret)) = (path.canonicalize(), secret.canonicalize()) {
                if upload == secret {
                    return Err(FILE_UNAVAILABLE.into());
                }
            }
        }
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| FILE_UNAVAILABLE.to_string())?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|_| FILE_UNAVAILABLE.to_string())?;
    if bytes.len() > MAX_OBJECT_BYTES {
        return Err("Upload is larger than 8 MiB".into());
    }
    Ok(bytes)
}

fn write_download(path: &Path, bytes: &[u8], protected: &[PathBuf]) -> Result<(), String> {
    #[cfg(not(unix))]
    {
        let _ = (path, bytes, protected);
        return Err(FILE_UNAVAILABLE.into());
    }
    #[cfg(unix)]
    write_download_unix(path, bytes, protected)
}

#[cfg(unix)]
fn write_download_unix(path: &Path, bytes: &[u8], protected: &[PathBuf]) -> Result<(), String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    if !path.is_absolute() || path.file_name().is_none() || under_protected(path, protected) {
        return Err(FILE_UNAVAILABLE.into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| FILE_UNAVAILABLE.to_string())?;
    let meta = file.metadata().map_err(|_| FILE_UNAVAILABLE.to_string())?;
    if !meta.is_file() || meta.nlink() != 1 || meta.uid() != unsafe { libc::geteuid() } {
        return Err(FILE_UNAVAILABLE.into());
    }
    file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(|_| FILE_UNAVAILABLE.to_string())?;
    file.write_all(bytes).map_err(|_| FILE_UNAVAILABLE.to_string())?;
    Ok(())
}

struct Frame {
    name: String,
    saw_text: bool,
    saw_child: bool,
}

struct S3Doc {
    buckets: Vec<String>,
    keys: Vec<String>,
    prefixes: Vec<String>,
    truncated: bool,
    saw_error: bool,
    error_code: Option<String>,
}

fn dangerous_xml(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    lower.contains("<!doctype") || lower.contains("<!entity") || lower.contains("<![cdata[") || lower.contains("<!--")
}

fn parse_document(body: &str) -> Result<S3Doc, String> {
    if dangerous_xml(body) || body.contains("<!") {
        return Err(RESPONSE_INVALID.into());
    }
    let bytes = body.as_bytes();
    let mut index = 0;
    let mut stack: Vec<Frame> = Vec::new();
    let mut doc = S3Doc {
        buckets: Vec::new(),
        keys: Vec::new(),
        prefixes: Vec::new(),
        truncated: false,
        saw_error: false,
        error_code: None,
    };
    while index < bytes.len() {
        if bytes[index] != b'<' {
            let start = index;
            while index < bytes.len() && bytes[index] != b'<' {
                index += 1;
            }
            let text = &body[start..index];
            if text.chars().all(|c| c.is_ascii_whitespace()) {
                continue;
            }
            apply_text(&mut doc, &mut stack, text)?;
            continue;
        }
        if body[index..].starts_with("<?") {
            let end = find_tag_end(body, index).map_err(|_| RESPONSE_INVALID.to_string())?;
            if end == 0 || bytes[end - 1] != b'?' {
                return Err(RESPONSE_INVALID.into());
            }
            index = end + 1;
            continue;
        }
        if body[index..].starts_with("<!") {
            return Err(RESPONSE_INVALID.into());
        }
        let end = find_tag_end(body, index).map_err(|_| RESPONSE_INVALID.to_string())?;
        let inside = &body[index + 1..end];
        let closing = inside.starts_with('/');
        let raw = inside.trim_start_matches('/');
        let self_closing = tag_self_closes(inside);
        let name = tag_name(raw);
        if name.is_empty() {
            return Err(RESPONSE_INVALID.into());
        }
        if closing {
            let Some(frame) = stack.pop() else {
                return Err(RESPONSE_INVALID.into());
            };
            if frame.name != name {
                return Err(RESPONSE_INVALID.into());
            }
        } else {
            if let Some(parent) = stack.last_mut() {
                if parent.saw_text {
                    return Err(RESPONSE_INVALID.into());
                }
                parent.saw_child = true;
            }
            if name == "Error" {
                doc.saw_error = true;
            }
            if !self_closing {
                stack.push(Frame { name: name.to_string(), saw_text: false, saw_child: false });
            }
        }
        index = end + 1;
    }
    if !stack.is_empty() {
        return Err(RESPONSE_INVALID.into());
    }
    Ok(doc)
}

fn apply_text(doc: &mut S3Doc, stack: &mut [Frame], raw: &str) -> Result<(), String> {
    {
        let Some(frame) = stack.last_mut() else {
            return Err(RESPONSE_INVALID.into());
        };
        if frame.saw_child || frame.saw_text {
            return Err(RESPONSE_INVALID.into());
        }
        frame.saw_text = true;
    }
    let text = decode_entities(raw).map_err(|_| RESPONSE_INVALID.to_string())?;
    let Some(parent) = stack.last().map(|frame| frame.name.clone()) else {
        return Err(RESPONSE_INVALID.into());
    };
    let grand = stack.len().checked_sub(2).and_then(|index| stack.get(index).map(|frame| frame.name.clone()));
    match (grand.as_deref(), parent.as_str()) {
        (Some("Bucket"), "Name") => {
            if bucket_error(&text).is_some() || text.is_empty() {
                return Err(RESPONSE_INVALID.into());
            }
            doc.buckets.push(text);
        }
        (Some("Contents"), "Key") => {
            validate_object_key(&text)?;
            doc.keys.push(text);
        }
        (Some("CommonPrefixes"), "Prefix") => {
            validate_object_key(&text)?;
            doc.prefixes.push(text);
        }
        (_, "IsTruncated") => {
            if text.trim().eq_ignore_ascii_case("true") {
                doc.truncated = true;
            }
        }
        (Some("Error"), "Code") => {
            let code = text.trim();
            if !code.is_empty() && code.len() <= 64 && code.bytes().all(|b| b.is_ascii_alphanumeric()) {
                doc.error_code = Some(code.to_string());
            }
            doc.saw_error = true;
        }
        _ => {}
    }
    Ok(())
}

fn decode_entities(raw: &str) -> Result<String, ()> {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find(';') else {
            return Err(());
        };
        let value = match &after[..end] {
            "amp" => "&",
            "lt" => "<",
            "gt" => ">",
            "quot" => "\"",
            "apos" => "'",
            _ => return Err(()),
        };
        out.push_str(value);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn find_tag_end(body: &str, start: usize) -> Result<usize, ()> {
    let bytes = body.as_bytes();
    let mut index = start;
    let mut quote = None;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(open) = quote {
            if byte == open {
                quote = None;
            }
        } else if byte == b'"' || byte == b'\'' {
            quote = Some(byte);
        } else if byte == b'>' {
            return Ok(index);
        }
        index += 1;
    }
    Err(())
}

fn tag_self_closes(inside: &str) -> bool {
    let bytes = inside.as_bytes();
    let mut quote = None;
    for (index, byte) in bytes.iter().enumerate() {
        if let Some(open) = quote {
            if *byte == open {
                quote = None;
            }
        } else if *byte == b'"' || *byte == b'\'' {
            quote = Some(*byte);
        } else if *byte == b'/' && index + 1 == bytes.len() {
            return true;
        }
    }
    false
}

fn tag_name(raw: &str) -> &str {
    raw.split(|c: char| c.is_ascii_whitespace() || c == '/')
        .next()
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prefs::normalize_endpoint;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn frozen() -> SystemTime {
        UNIX_EPOCH + Duration::from_secs(1_700_000_000)
    }

    fn error_of<T>(result: Result<T, String>) -> String {
        match result {
            Err(error) => error,
            Ok(_) => panic!("expected an error"),
        }
    }

    fn expose_ok(result: Result<Secret, String>) -> String {
        match result {
            Ok(secret) => secret.expose().to_string(),
            Err(_) => panic!("expected a secret"),
        }
    }

    #[test]
    fn tls_verification_stays_on() {
        let source = include_str!("drive.rs");
        let needle = ["danger_accept", "_invalid_certs"].concat();
        let skip = ["Insecure", "SkipVerify"].concat();
        assert!(!source.contains(&needle), "tls verification disabled");
        assert!(!source.contains(&skip), "tls verification skipped");
    }

    #[test]
    fn host_and_query_encoding() {
        assert_eq!(host_header("https://api.darkstorage.io:443/s3"), "api.darkstorage.io:443");
        assert_eq!(host_header("https://[::1]/s3"), "[::1]");
        assert_eq!(object_url("https://api.darkstorage.io/s3", "bucket", "a/b c"), "https://api.darkstorage.io/s3/bucket/a/b%20c");
        assert!(list_objects_url("https://api.darkstorage.io/s3", "bucket", "a/b", false).ends_with("?delimiter=%2F&max-keys=200&prefix=a%2Fb"));
        assert!(list_objects_url("https://api.darkstorage.io/s3", "bucket", "", true).ends_with("?max-keys=200&prefix="));
    }

    #[test]
    fn object_keys_reject_traversal() {
        assert!(validate_object_key("foo/bar").is_ok());
        assert!(validate_object_key("foo/").is_ok());
        assert!(validate_object_key("").is_err());
        assert!(validate_object_key("/abs").is_err());
        assert!(validate_object_key("a//b").is_err());
        assert!(validate_object_key("a/../b").is_err());
        assert!(validate_object_key("a/./b").is_err());
        assert!(validate_object_key("a\\b").is_err());
    }

    #[test]
    fn delete_confirmation_reads_the_secret_only_after_the_key_matches() {
        let mut reads = 0;
        let mismatch = drive_delete_flow("notes/a", "notes/b", "bucket", "AKIATEST", || {
            reads += 1;
            Ok(Secret("unused".into()))
        });
        assert_eq!(error_of(mismatch), "Type the object key to confirm delete");
        assert_eq!(reads, 0);
        let matched = drive_delete_flow("notes/a", "notes/a", "bucket", "AKIATEST", || {
            reads += 1;
            Ok(Secret("SUPERSECRETFIXTURE".into()))
        });
        assert!(matched.is_ok());
        assert_eq!(reads, 1);
    }

    #[test]
    fn signing_uses_the_access_key_and_hides_the_secret() {
        let secret = Secret("SUPERSECRETFIXTURE".into());
        let signed = match sign_request(
            "GET",
            "https://api.darkstorage.io/s3",
            "api.darkstorage.io",
            "us-east-1",
            "AKIATEST",
            &secret,
            b"",
            false,
            frozen(),
        ) {
            Ok(signed) => signed,
            Err(_) => panic!("sign failed"),
        };
        let blob = signed.headers.iter().map(|(key, value)| format!("{key}:{value}")).collect::<String>();
        let auth = signed
            .headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("authorization"))
            .map(|(_, value)| value.clone())
            .unwrap_or_default();
        let safe = !blob.contains("SUPERSECRETFIXTURE")
            && blob.contains("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
            && blob.contains("20231114T221320Z")
            && auth.to_ascii_lowercase().contains("host")
            && auth.contains("AKIATEST");
        assert!(safe);
    }

    #[test]
    fn list_xml_ignores_owner_names_and_rejects_dangerous_markup() {
        let body = r#"<?xml version="1.0"?>
<ListAllMyBucketsResult>
  <Owner><Name>SUPERSECRETFIXTURE</Name></Owner>
  <Buckets>
    <Bucket><Name>logs</Name></Bucket>
    <Bucket><Name>media</Name></Bucket>
  </Buckets>
</ListAllMyBucketsResult>"#;
        let doc = parse_document(body).unwrap();
        assert_eq!(doc.buckets, ["logs", "media"]);
        assert!(!doc.buckets.iter().any(|name| name.contains("SUPERSECRETFIXTURE")));
        let objects = r#"<ListBucketResult>
          <Contents><Key>a/b</Key></Contents>
          <CommonPrefixes><Prefix>a/</Prefix></CommonPrefixes>
          <IsTruncated>true</IsTruncated>
        </ListBucketResult>"#;
        let listed = parse_document(objects).unwrap();
        assert_eq!(listed.keys, ["a/b"]);
        assert_eq!(listed.prefixes, ["a/"]);
        assert!(listed.truncated);
        assert!(parse_document("<List><!DOCTYPE foo><Name>x</Name></List>").is_err());
        assert!(parse_document("<List><Contents><Key>a&#59;b</Key></Contents></List>").is_err());
        let error = br#"<Error><Code>NoSuchBucket</Code><Message>SUPERSECRETFIXTURE</Message></Error>"#;
        let message = error_message(404, error);
        assert_eq!(message, "Drive request failed (404 NoSuchBucket)");
        assert!(!message.contains("SUPERSECRETFIXTURE"));
        assert_eq!(error_message(404, b"\xff"), "Drive request failed (404)");
        let with_error = "<ListBucketResult><Error><Code>NotACode!</Code></Error></ListBucketResult>";
        let bad = parse_document(with_error).unwrap();
        assert!(bad.saw_error);
        assert!(bad.error_code.is_none());
    }

    #[test]
    fn secret_env_fails_closed_on_the_first_present_value() {
        let missing = secret_from_env(&[("DARKSTORAGE_SECRET_ACCESS_KEY", None), ("AWS_SECRET_ACCESS_KEY", Some("aws-secret".into()))]);
        assert_eq!(expose_ok(missing), "aws-secret");
        let empty = secret_from_env(&[("DARKSTORAGE_SECRET_ACCESS_KEY", Some(String::new())), ("AWS_SECRET_ACCESS_KEY", Some("aws-secret".into()))]);
        assert_eq!(error_of(empty), NO_SECRET);
        let control = secret_from_env(&[("DARKSTORAGE_SECRET_ACCESS_KEY", Some("bad\nsecret".into()))]);
        assert_eq!(error_of(control), NO_SECRET);
    }

    #[cfg(unix)]
    #[test]
    fn secret_file_policy() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("afterterm-secret-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir(&dir).unwrap();
        let path = dir.join("key");
        fs::write(&path, b"super-secret\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(expose_ok(read_secret_file(&path, &[])), "super-secret");
        fs::write(&path, b"\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(error_of(read_secret_file(&path, &[])), NO_SECRET);
        fs::write(&path, b"\n\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(error_of(read_secret_file(&path, &[])), SECRET_UNAVAILABLE);
        fs::write(&path, b"group-readable").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o660)).unwrap();
        assert_eq!(error_of(read_secret_file(&path, &[])), SECRET_UNAVAILABLE);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let missing = dir.join("missing");
        assert_eq!(error_of(read_secret_file(&missing, &[])), SECRET_UNREADABLE);
        assert_eq!(error_of(read_secret_file(Path::new("relative"), &[])), SECRET_UNAVAILABLE);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn put_checks_size_before_the_secret() {
        let mut reads = 0;
        let too_big = prepare_put("https://api.darkstorage.io/s3", "us-east-1", "a", "bucket", "AKIATEST", (MAX_OBJECT_BYTES as u64) + 1, || {
            reads += 1;
            Ok(Secret("nope".into()))
        });
        assert_eq!(error_of(too_big), "Upload is larger than 8 MiB");
        assert_eq!(reads, 0);
        let empty = prepare_put("https://api.darkstorage.io/s3", "us-east-1", "a", "bucket", "AKIATEST", 0, || {
            reads += 1;
            Ok(Secret("nope".into()))
        });
        assert!(empty.is_ok());
        assert_eq!(reads, 1);
    }

    #[test]
    fn endpoint_helper_is_shared() {
        assert_eq!(normalize_endpoint("https://API.Example.com:443/s3/").unwrap(), "https://api.example.com:443/s3");
        assert!(require_endpoint("").is_err());
    }
}
