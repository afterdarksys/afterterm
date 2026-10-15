//! Interface selection happens before initializing the desktop runtime.
use serde::Deserialize;
use std::{ffi::OsString, path::PathBuf};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Gui,
    Console,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub default_mode: Mode,
}

pub const HELP: &str = "Usage: afterterm [gui|console] [SAHCONNECT ARGS...]\n\nNo connection arguments opens a local shell. Otherwise arguments pass literally\nto sahconnect, e.g. afterterm gui connect web1 or afterterm console login.\nUse -- to pass arguments beginning with --help or a mode name.\n\nDefault: gui. Configure default_mode in $XDG_CONFIG_HOME/afterterm/launch.json\n(or ~/.config/afterterm/launch.json). AFTERTERM_CONFIG overrides the file path.\nConsole mode is direct: AfterTerm input review is disabled.\n";

pub fn select(args: Vec<OsString>, default: Mode) -> (Mode, Vec<OsString>) {
    let mut args = args.into_iter().peekable();
    let mode = match args.peek().and_then(|s| s.to_str()) {
        Some("gui") => {
            args.next();
            Mode::Gui
        }
        Some("console") => {
            args.next();
            Mode::Console
        }
        _ => default,
    };
    if args.peek().is_some_and(|s| s == "--") {
        args.next();
    }
    (mode, args.collect())
}

pub fn load_config() -> Result<Config, String> {
    let explicit = std::env::var_os("AFTERTERM_CONFIG");
    let path = match &explicit {
        Some(path) => PathBuf::from(path),
        None => {
            let root = std::env::var_os("XDG_CONFIG_HOME")
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
                .ok_or("Set HOME, XDG_CONFIG_HOME, or AFTERTERM_CONFIG")?;
            root.join("afterterm/launch.json")
        }
    };
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && explicit.is_none() => {
            Ok(Config::default())
        }
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

pub fn sah_binary() -> Result<PathBuf, String> {
    afterterm_pty::path::resolve_binary("sahconnect").ok_or(
        "sahconnect is not installed on the developer PATH; install the SAH Go client first".into(),
    )
}

#[cfg(unix)]
pub fn console(args: Vec<OsString>) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let program = if args.is_empty() {
        std::env::var_os("SHELL")
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".into())
    } else {
        sah_binary()?.into_os_string()
    };
    // exec preserves the controlling TTY, signals, resize, pipes and exit status.
    eprintln!("AfterTerm console: direct mode; AfterTerm input review is disabled.");
    let error = std::process::Command::new(program)
        .args(args)
        .env("PATH", afterterm_pty::path::augmented_path())
        .exec();
    Err(format!("Could not launch console: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn modes_override_defaults_and_preserve_literal_args() {
        for mode in [Mode::Gui, Mode::Console] {
            assert_eq!(select(vec![], mode), (mode, vec![]));
            let args = vec!["console", "--", "connect", "host;echo bad", "--root"]
                .into_iter()
                .map(Into::into)
                .collect();
            assert_eq!(
                select(args, mode),
                (
                    Mode::Console,
                    vec!["connect".into(), "host;echo bad".into(), "--root".into()]
                )
            );
            assert_eq!(select(vec!["gui".into()], mode).0, Mode::Gui);
        }
    }
    #[test]
    fn invalid_config_is_not_silently_ignored() {
        assert!(serde_json::from_str::<Config>(r#"{"default_mode":"tty"}"#).is_err());
        assert!(serde_json::from_str::<Config>(r#"{"defaut_mode":"console"}"#).is_err());
        assert_eq!(
            serde_json::from_str::<Config>(r#"{"default_mode":"console"}"#)
                .unwrap()
                .default_mode,
            Mode::Console
        );
    }
}
