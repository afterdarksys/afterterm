//! Writing user-chosen files (transcripts, selections, session logs).
//!
//! Threats: a compromised or buggy webview asking to write arbitrary paths;
//! symlink or hard-link redirection of the chosen file; FIFOs and devices that
//! block or misbehave; clobbering AfterTerm's own preferences. Paths only ever
//! come from the native save dialog run in Rust, never from the webview. The
//! final path component is opened with O_NOFOLLOW and O_NONBLOCK, must be a
//! regular file with one link owned by the current user, and ends up 0600.
//! Anything under the app's config or data folders is refused. Fails closed.

use std::fs::{File, OpenOptions};
use std::path::{Component, Path, PathBuf};

/// Largest transcript or HTML export accepted over IPC.
pub const MAX_SAVE_BYTES: usize = 64 * 1024 * 1024;

/// A default file name for the dialog: no separators, no leading dots, bounded length.
pub fn safe_file_name(name: &str, extension: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim_start_matches(['.', '-']).chars().take(80).collect::<String>();
    if cleaned.is_empty() {
        format!("session.{extension}")
    } else if cleaned.ends_with(&format!(".{extension}")) {
        cleaned
    } else {
        format!("{cleaned}.{extension}")
    }
}

/// Open a dialog-chosen path for writing under the rules above.
pub fn open_for_write(path: &Path, protected: &[PathBuf], append: bool) -> Result<File, String> {
    if !path.is_absolute() {
        return Err("Refusing to write: the path is not absolute".into());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return Err("Refusing to write: the path contains . or .. components".into());
    }
    let name = path.file_name().ok_or("Refusing to write: no file name")?;
    let parent = path.parent().ok_or("Refusing to write: no parent folder")?;
    let parent = parent
        .canonicalize()
        .map_err(|e| format!("The folder for {} is not available: {e}", path.display()))?;
    if !parent.is_dir() {
        return Err("Refusing to write: the parent is not a folder".into());
    }
    for dir in protected {
        let dir = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        if parent.starts_with(&dir) {
            return Err("Refusing to write inside AfterTerm's own configuration or data folder".into());
        }
    }
    open_checked(&parent.join(name), append)
}

#[cfg(unix)]
fn open_checked(path: &Path, append: bool) -> Result<File, String> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .append(append)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| {
            if e.raw_os_error() == Some(libc::ELOOP) {
                format!("Refusing to follow a symbolic link at {}", path.display())
            } else {
                format!("Could not open {}: {e}", path.display())
            }
        })?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.file_type().is_file() {
        return Err(format!("Refusing to write: {} is not a regular file", path.display()));
    }
    if meta.nlink() > 1 {
        return Err(format!("Refusing to write: {} has other hard links", path.display()));
    }
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err(format!("Refusing to write: {} belongs to another user", path.display()));
    }
    // Back to blocking writes now that the target is known to be a regular file.
    let fd = std::os::fd::AsRawFd::as_raw_fd(&file);
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|e| e.to_string())?;
    if !append {
        file.set_len(0).map_err(|e| e.to_string())?;
    }
    Ok(file)
}

#[cfg(not(unix))]
fn open_checked(path: &Path, append: bool) -> Result<File, String> {
    let file = OpenOptions::new()
        .write(true)
        .create(true)
        .append(append)
        .truncate(!append)
        .open(path)
        .map_err(|e| format!("Could not open {}: {e}", path.display()))?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Refusing to write: not a regular file".into());
    }
    Ok(file)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("afterterm-files-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn writes_a_new_file_0600_and_truncates_on_save() {
        let dir = scratch("ok");
        let path = dir.join("t.txt");
        std::fs::write(&path, "old contents that are longer").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        open_for_write(&path, &[], false).unwrap().write_all(b"new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        open_for_write(&path, &[], true).unwrap().write_all(b"+more").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new+more");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_relative_and_dotted_paths() {
        assert!(open_for_write(Path::new("relative.txt"), &[], false).is_err());
        let dir = scratch("dots");
        assert!(open_for_write(&dir.join("..").join("x.txt"), &[], false).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_symlinks_without_touching_the_target() {
        let dir = scratch("link");
        let target = dir.join("target.txt");
        std::fs::write(&target, "keep").unwrap();
        let link = dir.join("link.txt");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let err = open_for_write(&link, &[], false).unwrap_err();
        assert!(err.contains("symbolic link"), "{err}");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_hard_links_directories_and_fifos() {
        let dir = scratch("special");
        let original = dir.join("a.txt");
        std::fs::write(&original, "keep").unwrap();
        let hard = dir.join("b.txt");
        std::fs::hard_link(&original, &hard).unwrap();
        assert!(open_for_write(&hard, &[], false).unwrap_err().contains("hard links"));
        assert_eq!(std::fs::read_to_string(&original).unwrap(), "keep");
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        assert!(open_for_write(&sub, &[], false).is_err());
        let fifo = dir.join("fifo");
        let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert!(open_for_write(&fifo, &[], false).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_the_app_config_folder_and_missing_parents() {
        let dir = scratch("config");
        let config = dir.join("config");
        std::fs::create_dir_all(config.join("nested")).unwrap();
        let err = open_for_write(&config.join("prefs.json"), &[config.clone()], false).unwrap_err();
        assert!(err.contains("configuration"), "{err}");
        assert!(open_for_write(&config.join("nested").join("x.txt"), &[config.clone()], false).is_err());
        assert!(!config.join("prefs.json").exists());
        assert!(open_for_write(&dir.join("missing").join("x.txt"), &[], false).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn default_names_have_no_separators() {
        assert_eq!(safe_file_name("../../etc/passwd", "txt"), "etc-passwd.txt");
        assert_eq!(safe_file_name("", "log"), "session.log");
        assert_eq!(safe_file_name("zsh-2026.txt", "txt"), "zsh-2026.txt");
        assert!(!safe_file_name("a/b\\c", "html").contains(['/', '\\']));
    }
}
