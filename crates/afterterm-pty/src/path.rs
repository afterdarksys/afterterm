//! Developer PATH for GUI-launched apps.
//!
//! A bundled `.app` launched from Finder inherits launchd's PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), not the login shell. Homebrew, cargo
//! and version managers live elsewhere, so the PTY and context probes search
//! those extra directories too.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

const EXTRA_BIN_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/opt/local/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    "/snap/bin",
];

const HOME_BIN_DIRS: &[&str] = &[
    ".asdf/shims",
    ".local/share/mise/shims",
    ".local/bin",
    ".cargo/bin",
    "go/bin",
    ".volta/bin",
    ".bun/bin",
    ".pyenv/shims",
    ".rbenv/shims",
    "bin",
];

pub fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

pub fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();

    let mut push = |dir: PathBuf| {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };

    for extra in EXTRA_BIN_DIRS {
        push(PathBuf::from(extra));
    }
    if let Some(home) = std::env::var_os("HOME") {
        for suffix in HOME_BIN_DIRS {
            push(PathBuf::from(&home).join(suffix));
        }
    }
    dirs
}

pub fn resolve_binary(name: &str) -> Option<PathBuf> {
    search_dirs()
        .into_iter()
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

/// PATH value the shell should inherit so Finder-launched windows still find brew/mise.
pub fn augmented_path() -> OsString {
    let dirs = search_dirs();
    std::env::join_paths(&dirs).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_dirs_include_path_and_known_extras() {
        let dirs = search_dirs();
        assert!(!dirs.is_empty());
        let has_homebrew = dirs.iter().any(|d| d.ends_with("bin") || d.ends_with("sbin"));
        assert!(has_homebrew);
    }

    #[test]
    fn missing_binaries_are_none() {
        assert_eq!(resolve_binary("definitely-not-installed-xyzzy-afterterm"), None);
    }
}
