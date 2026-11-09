//! Shell integration for new local zsh and bash tabs.
//!
//! Threats: the webview cannot turn this on. The backend reads preferences and
//! injects markers only for a local shell. Scripts are written by this process,
//! never taken from the webview, and opened with O_NOFOLLOW so a planted symlink
//! fails the spawn. Paths placed in the environment are UTF-8 and free of control
//! characters. Errors never include the user path.

use std::ffi::OsStr;
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

pub const PREPARE_FAILED: &str =
    "Could not prepare shell integration. Turn shell integration off and try the tab again.";

#[derive(Debug)]
pub struct Prepared {
    pub program: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

enum ShellKind {
    Zsh,
    Bash,
}

pub fn prepare(config_dir: &Path) -> Result<Option<Prepared>, String> {
    prepare_shell(
        config_dir,
        std::env::var_os("SHELL").as_deref(),
        std::env::var_os("ZDOTDIR").as_deref(),
    )
}

pub fn prepare_shell(
    config_dir: &Path,
    shell: Option<&OsStr>,
    user_zdotdir: Option<&OsStr>,
) -> Result<Option<Prepared>, String> {
    let Some(kind) = shell_kind(shell) else {
        return Ok(None);
    };
    let shell = shell.expect("a recognized shell has a path");
    #[cfg(not(unix))]
    {
        let _ = (config_dir, shell, kind, user_zdotdir);
        return Err(PREPARE_FAILED.into());
    }
    #[cfg(unix)]
    prepare_unix(config_dir, shell, kind, user_zdotdir)
}

fn shell_kind(shell: Option<&OsStr>) -> Option<ShellKind> {
    let text = shell?.to_str()?;
    let path = Path::new(text);
    if !path.is_absolute() {
        return None;
    }
    match path.file_name().and_then(|name| name.to_str())? {
        "zsh" => Some(ShellKind::Zsh),
        "bash" => Some(ShellKind::Bash),
        _ => None,
    }
}

fn utf8_path(path: &Path) -> Result<&str, String> {
    let text = path.to_str().ok_or_else(|| PREPARE_FAILED.to_string())?;
    if text.is_empty() || text.len() > 4096 || text.chars().any(|c| c.is_control()) {
        return Err(PREPARE_FAILED.into());
    }
    Ok(text)
}

fn valid_user_zdotdir(value: &OsStr) -> Option<String> {
    let text = value.to_str()?;
    if text.is_empty() || text.len() > 4096 || text.chars().any(|c| c.is_control()) {
        return None;
    }
    if !Path::new(text).is_absolute() {
        return None;
    }
    Some(text.to_string())
}

#[cfg(unix)]
fn prepare_unix(
    config_dir: &Path,
    shell: &OsStr,
    kind: ShellKind,
    user_zdotdir: Option<&OsStr>,
) -> Result<Option<Prepared>, String> {
    let shell_text = utf8_path(Path::new(shell))?;
    utf8_path(config_dir)?;
    ensure_dir(config_dir)?;
    let root = config_dir.join("shell-integration");
    ensure_dir(&root)?;
    let integration = match kind {
        ShellKind::Zsh => root.join("zsh"),
        ShellKind::Bash => root.join("bash"),
    };
    ensure_dir(&integration)?;
    match kind {
        ShellKind::Zsh => write_zsh(&integration)?,
        ShellKind::Bash => write_script(&integration.join("bashrc"), BASH_RC)?,
    }
    let integration_text = utf8_path(&integration)?.to_string();
    let prepared = match kind {
        ShellKind::Zsh => {
            let mut env = vec![
                ("ZDOTDIR".to_string(), integration_text),
                ("AFTERTERM_INTEGRATION".to_string(), "1".to_string()),
            ];
            if let Some(original) = user_zdotdir.and_then(valid_user_zdotdir) {
                env.push(("AFTERTERM_USER_ZDOTDIR".to_string(), original));
            }
            Prepared { program: None, args: Vec::new(), env }
        }
        ShellKind::Bash => {
            let rc = utf8_path(&integration.join("bashrc"))?.to_string();
            Prepared {
                program: Some(shell_text.to_string()),
                args: vec!["--rcfile".to_string(), rc],
                env: vec![("AFTERTERM_INTEGRATION".to_string(), "1".to_string())],
            }
        }
    };
    Ok(Some(prepared))
}

#[cfg(unix)]
fn ensure_dir(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_dir() {
                return Err(PREPARE_FAILED.into());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            DirBuilder::new()
                .mode(0o700)
                .create(path)
                .map_err(|_| PREPARE_FAILED.to_string())?;
        }
        Err(_) => return Err(PREPARE_FAILED.into()),
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| PREPARE_FAILED.to_string())
}

#[cfg(unix)]
fn write_script(path: &Path, body: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|_| PREPARE_FAILED.to_string())?;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| PREPARE_FAILED.to_string())?;
    file.write_all(body.as_bytes()).map_err(|_| PREPARE_FAILED.to_string())?;
    Ok(())
}

#[cfg(unix)]
fn write_zsh(dir: &Path) -> Result<(), String> {
    write_script(&dir.join(".zshenv"), &zsh_file(".zshenv", false))?;
    write_script(&dir.join(".zprofile"), &zsh_file(".zprofile", false))?;
    write_script(&dir.join(".zlogin"), &zsh_file(".zlogin", false))?;
    write_script(&dir.join(".zshrc"), &zsh_file(".zshrc", true))?;
    Ok(())
}

fn zsh_file(name: &str, hooks: bool) -> String {
    let mut body = format!("{ZSH_SOURCE}\n_afterterm_source_user {name}\n");
    if hooks {
        body.push_str(ZSH_HOOKS);
    }
    body
}

const ZSH_SOURCE: &str = r#"_afterterm_source_user() {
  emulate -L zsh
  local ours="${ZDOTDIR}"
  local name="$1"
  if [[ -n "${AFTERTERM_USER_ZDOTDIR:-}" ]]; then
    builtin export ZDOTDIR="${AFTERTERM_USER_ZDOTDIR}"
  else
    builtin unset ZDOTDIR
  fi
  local home="${HOME:-}"
  local base="${ZDOTDIR:-$home}"
  if [[ -n "$base" && -f "${base}/${name}" ]]; then
    builtin source "${base}/${name}"
  fi
  builtin export ZDOTDIR="$ours"
}"#;

const ZSH_HOOKS: &str = r#"_afterterm_precmd() {
  emulate -L zsh
  local status=$?
  builtin printf '\033]133;D;%s\a' "$status"
  builtin printf '\033]133;A\a'
}
_afterterm_preexec() {
  emulate -L zsh
  local cmd="$1"
  cmd="${cmd//$'\a'/}"
  cmd="${cmd//$'\e'/}"
  cmd="${cmd//$'\234'/}"
  cmd="${cmd//\\/\\\\}"
  cmd="${cmd//$'\n'/\\n}"
  local semi='\x3b'
  cmd="${cmd//;/$semi}"
  builtin printf '\033]633;E;%s\a' "$cmd"
  builtin printf '\033]133;C\a'
}
if ! autoload -Uz add-zsh-hook 2>/dev/null; then
  case " ${precmd_functions[*]} " in
    *" _afterterm_precmd "*) ;;
    *) precmd_functions=(_afterterm_precmd ${precmd_functions}) ;;
  esac
  case " ${preexec_functions[*]} " in
    *" _afterterm_preexec "*) ;;
    *) preexec_functions=(_afterterm_preexec ${preexec_functions}) ;;
  esac
else
  add-zsh-hook precmd _afterterm_precmd
  add-zsh-hook preexec _afterterm_preexec
fi
"#;

const BASH_RC: &str = r#"_afterterm_prompt() {
  local status=$?
  builtin printf '\033]133;D;%s\007' "$status"
  builtin printf '\033]133;A\007'
}
if [[ -f "${HOME}/.bashrc" ]]; then
  builtin source "${HOME}/.bashrc"
fi
if [[ "${PROMPT_COMMAND}" != *"_afterterm_prompt"* ]]; then
  PROMPT_COMMAND="_afterterm_prompt${PROMPT_COMMAND:+;${PROMPT_COMMAND}}"
fi
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  _afterterm_command() {
    local cmd="$1"
    cmd="${cmd//$'\007'/}"
    cmd="${cmd//$'\033'/}"
    cmd="${cmd//$'\234'/}"
    cmd="${cmd//\\/\\\\}"
    cmd="${cmd//$'\n'/\\n}"
    local semi='\x3b'
    cmd="${cmd//;/$semi}"
    builtin printf '\033]633;E;%s\007' "$cmd"
    builtin printf '\033]133;C\007'
  }
  PS0='$(_afterterm_command "$BASH_COMMAND")'
fi
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scratch() -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("afterterm-shell-{nanos}-{}", std::process::id()));
        fs::create_dir(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn zsh_escapes_a_semicolon_as_four_characters() {
        if !Path::new("/bin/zsh").exists() {
            return;
        }
        let dir = scratch();
        let prepared = prepare_shell(&dir, Some(OsStr::new("/bin/zsh")), Some(OsStr::new("foo")))
            .unwrap()
            .unwrap();
        assert!(prepared.program.is_none());
        assert!(prepared.env.iter().any(|(key, value)| key == "ZDOTDIR" && value.ends_with("/zsh")));
        assert!(!prepared.env.iter().any(|(key, _)| key == "AFTERTERM_USER_ZDOTDIR"));
        let zshrc = fs::read_to_string(dir.join("shell-integration/zsh/.zshrc")).unwrap();
        assert!(zshrc.contains(r"'\x3b'"));
        let home = scratch();
        let output = Command::new("/bin/zsh")
            .env_clear()
            .env("HOME", &home)
            .env("ZDOTDIR", dir.join("shell-integration/zsh"))
            .env("PATH", "/usr/bin:/bin")
            .args(["-c", "source \"$ZDOTDIR/.zshrc\"; _afterterm_preexec \"a;b\""])
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("a\\x3bb"), "{stdout}");
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn bash_rcfile_parses_and_does_not_take_login_flags() {
        let dir = scratch();
        let prepared = prepare_shell(&dir, Some(OsStr::new("/bin/bash")), None).unwrap().unwrap();
        assert_eq!(prepared.program.as_deref(), Some("/bin/bash"));
        assert_eq!(prepared.args[0], "--rcfile");
        assert_eq!(prepared.args.len(), 2);
        assert!(prepared.args.iter().all(|arg| arg != "-l" && arg != "-i"));
        let text = fs::read_to_string(&prepared.args[1]).unwrap();
        assert!(!text.contains(r"$'\e'"));
        assert!(!text.contains(r"$'\u009c'"));
        assert!(text.contains(r"'\x3b'"));
        if Path::new("/bin/bash").exists() {
            let status = Command::new("/bin/bash").arg("-n").arg(&prepared.args[1]).status().unwrap();
            assert!(status.success());
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn other_shells_do_not_create_the_integration_directory() {
        let dir = scratch();
        let missing = dir.join("never");
        assert!(prepare_shell(&missing, Some(OsStr::new("/bin/fish")), None).unwrap().is_none());
        assert!(prepare_shell(&missing, Some(OsStr::new("zsh")), None).unwrap().is_none());
        assert!(!missing.exists());
        let bad = OsStr::from_bytes(b"/tmp/\xffdir/zsh");
        let bad_config = Path::new(OsStr::from_bytes(b"/tmp/\xffconfig"));
        assert!(prepare_shell(bad_config, Some(bad), None).unwrap().is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_control_in_an_absolute_shell_path_fails_closed() {
        let dir = scratch();
        let shell = format!("/tmp/bad\u{0001}/zsh");
        let error = prepare_shell(&dir, Some(OsStr::new(&shell)), None).unwrap_err();
        assert_eq!(error, PREPARE_FAILED);
        assert!(!dir.join("shell-integration").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_path_is_not_echoed() {
        let dir = scratch();
        let fixture = dir.join("SUPERSECRETFIXTURE");
        fs::write(&fixture, b"x").unwrap();
        let error = prepare_shell(&fixture, Some(OsStr::new("/bin/zsh")), None).unwrap_err();
        assert_eq!(error, PREPARE_FAILED);
        assert!(!error.contains("SUPERSECRETFIXTURE"));

        let config = dir.join("cfg");
        fs::create_dir(&config).unwrap();
        let target = dir.join("SUPERSECRETFIXTURE-target");
        fs::create_dir(&target).unwrap();
        std::os::unix::fs::symlink(&target, config.join("shell-integration")).unwrap();
        let error = prepare_shell(&config, Some(OsStr::new("/bin/zsh")), None).unwrap_err();
        assert_eq!(error, PREPARE_FAILED);
        assert!(!error.contains("SUPERSECRETFIXTURE"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    use std::os::unix::ffi::OsStrExt;
}
