#![cfg(unix)]

use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, process::Command};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "afterterm-launch-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn command(&self) -> Command {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_afterterm"));
        cmd.env("AFTERTERM_CONFIG", self.0.join("launch.json"))
            .env("PATH", &self.0);
        cmd
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn console_preserves_literal_arguments_and_client_exit_status() {
    let fixture = Fixture::new();
    let client = fixture.0.join("sahconnect");
    fs::write(&client, "#!/bin/sh\nprintf '%s\\n' \"$@\"\nexit 37\n").unwrap();
    fs::set_permissions(&client, fs::Permissions::from_mode(0o700)).unwrap();
    for (config, args) in [
        ("gui", vec!["console", "connect", "web1;$(echo nope)"]),
        ("console", vec!["connect", "web1;$(echo nope)"]),
    ] {
        fs::write(
            fixture.0.join("launch.json"),
            format!(r#"{{"default_mode":"{config}"}}"#),
        )
        .unwrap();
        let output = fixture.command().args(args).output().unwrap();
        assert_eq!(output.status.code(), Some(37));
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            "connect\nweb1;$(echo nope)\n"
        );
        assert!(String::from_utf8(output.stderr)
            .unwrap()
            .contains("review is disabled"));
    }
}

#[test]
fn missing_explicit_config_errors_but_help_remains_available() {
    let fixture = Fixture::new();
    assert_eq!(
        fixture
            .command()
            .arg("console")
            .output()
            .unwrap()
            .status
            .code(),
        Some(2)
    );
    let output = fixture.command().arg("--help").output().unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8(output.stdout)
        .unwrap()
        .contains("Usage: afterterm"));
}
