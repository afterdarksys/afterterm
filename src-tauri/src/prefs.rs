use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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
    fn defaults_are_sane() {
        let prefs = Prefs::default();
        assert!(prefs.transparency > 0.0 && prefs.transparency <= 1.0);
        assert!(!prefs.ai_enabled);
        assert!(prefs.font_size >= 8);
    }
}
