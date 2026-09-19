use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prefs {
    pub theme: String,
    pub font_family: String,
    pub font_size: u8,
    pub transparency: f32,
    pub cursor_style: String,
    pub scrollback: u32,
    pub reduced_motion: bool,
    pub ai_enabled: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            theme: "signal".into(),
            font_family: "SF Mono, Menlo, JetBrains Mono, ui-monospace, monospace".into(),
            font_size: 13,
            transparency: 0.82,
            cursor_style: "bar".into(),
            scrollback: 10000,
            reduced_motion: false,
            ai_enabled: false,
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
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(_) => Ok(Prefs::default()),
    }
}

pub fn save(app: &AppHandle, prefs: &Prefs) -> Result<(), String> {
    if !(0.0..=1.0).contains(&prefs.transparency) {
        return Err("transparency must be between 0 and 1".into());
    }
    if !(8..=32).contains(&prefs.font_size) {
        return Err("font size must be between 8 and 32".into());
    }
    if prefs.scrollback > 100_000 {
        return Err("scrollback is too large".into());
    }
    let path = prefs_path(app)?;
    let text = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let prefs = Prefs::default();
        assert!(prefs.transparency > 0.0 && prefs.transparency <= 1.0);
        assert!(!prefs.ai_enabled);
        assert!(prefs.font_size >= 8);
    }
}
