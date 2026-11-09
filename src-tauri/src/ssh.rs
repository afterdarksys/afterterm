use serde::{Deserialize, Serialize};
use std::process::Command;

/// Threats: a caller-supplied SSH argument list could inject options
/// (`-o ProxyCommand`, `StrictHostKeyChecking=no`) or a shell string.
/// `ssh_argv` accepts only a host, an optional user, and an optional port,
/// and it refuses anything else. AfterTerm does not check host keys and does
/// not store credentials; the OpenSSH client keeps its own host-key defaults.
/// A rejected field is an error. This does not verify the remote identity.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SshTarget {
    pub host: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
}

/// Argv for the installed OpenSSH client: `ssh -t [-p PORT] -- destination`.
/// Destination is `host` or `user@host`. An IPv6 host is already bracketed.
pub fn ssh_argv(target: &SshTarget) -> Result<Vec<String>, String> {
    let host = validate_host(&target.host)?;
    let user = match target.user.as_deref() {
        None => None,
        Some(user) => validate_user(user)?,
    };
    let dest = match user {
        Some(user) => format!("{user}@{host}"),
        None => host,
    };
    let mut argv = vec!["-t".to_string()];
    if let Some(port) = validate_port(target.port)? {
        argv.push("-p".to_string());
        argv.push(port.to_string());
    }
    argv.push("--".to_string());
    argv.push(dest);
    Ok(argv)
}

pub fn ssh_program() -> Result<String, String> {
    let path = afterterm_pty::path::resolve_binary("ssh")
        .ok_or("OpenSSH client not found on the developer PATH")?;
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "OpenSSH client path is not UTF-8".to_string())
}

fn validate_host(raw: &str) -> Result<String, String> {
    if raw.len() > 300 {
        return Err("SSH host is too long".into());
    }
    let host = raw.trim();
    if host.is_empty() {
        return Err("Enter an SSH host".into());
    }
    if host.len() > 253 {
        return Err("SSH host is too long".into());
    }
    if is_name_host(host) || is_bracketed_ipv6(host) {
        return Ok(host.to_owned());
    }
    Err("SSH host must be a hostname, an IPv4 address, or a bracketed IPv6 address".into())
}

fn is_name_host(host: &str) -> bool {
    let mut chars = host.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
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

fn validate_user(raw: &str) -> Result<Option<String>, String> {
    if raw.len() > 80 {
        return Err("SSH user is too long".into());
    }
    let user = raw.trim();
    if user.is_empty() {
        return Ok(None);
    }
    if user.len() > 64 {
        return Err("SSH user is too long".into());
    }
    let mut chars = user.chars();
    let Some(first) = chars.next() else {
        return Ok(None);
    };
    if !(first.is_ascii_alphanumeric() || first == '_')
        || !user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err("SSH user has an unsupported character".into());
    }
    Ok(Some(user.to_owned()))
}

fn validate_port(port: Option<u16>) -> Result<Option<u16>, String> {
    match port {
        None => Ok(None),
        Some(0) => Err("SSH port must be between 1 and 65535".into()),
        Some(port) => Ok(Some(port)),
    }
}
#[derive(Serialize)]
pub struct Algorithms {
    client: String,
    kex: Vec<String>,
    host_key: Vec<String>,
    cipher: Vec<String>,
    mac: Vec<String>,
}
#[tauri::command]
pub async fn ssh_algorithms() -> Result<Algorithms, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let client = afterterm_pty::path::resolve_binary("ssh")
            .ok_or("OpenSSH client not found on the developer PATH")?;
        let query = |kind: &str| -> Result<Vec<String>, String> {
            let output = Command::new(&client)
                .args(["-Q", kind])
                .env("PATH", afterterm_pty::path::augmented_path())
                .output()
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err(format!(
                    "OpenSSH query {kind} failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }
            Ok(String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::to_owned)
                .collect())
        };
        Ok(Algorithms {
            client: client.display().to_string(),
            kex: query("kex")?,
            host_key: query("key-sig")?,
            cipher: query("cipher")?,
            mac: query("mac")?,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(host: &str, user: Option<&str>, port: Option<u16>) -> SshTarget {
        SshTarget {
            host: host.to_owned(),
            user: user.map(str::to_owned),
            port,
        }
    }

    fn owned(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn argv_forces_a_tty_and_stops_at_the_destination() {
        assert_eq!(
            ssh_argv(&target("web1", None, None)).unwrap(),
            owned(&["-t", "--", "web1"])
        );
        assert_eq!(
            ssh_argv(&target("web1", Some("alice"), Some(2222))).unwrap(),
            owned(&["-t", "-p", "2222", "--", "alice@web1"])
        );
        assert_eq!(
            ssh_argv(&target("[2001:db8::1]", Some("alice"), None)).unwrap(),
            owned(&["-t", "--", "alice@[2001:db8::1]"])
        );
        assert_eq!(
            ssh_argv(&target("192.0.2.10", None, None)).unwrap(),
            owned(&["-t", "--", "192.0.2.10"])
        );
        assert_eq!(
            ssh_argv(&target(" web1 ", Some("  "), None)).unwrap(),
            owned(&["-t", "--", "web1"])
        );
        assert_eq!(
            ssh_argv(&target("web1", Some("a.b_c-d"), Some(65535))).unwrap(),
            owned(&["-t", "-p", "65535", "--", "a.b_c-d@web1"])
        );
        let long = "a".repeat(253);
        assert_eq!(
            ssh_argv(&target(&long, None, None)).unwrap(),
            owned(&["-t", "--", long.as_str()])
        );
    }

    #[test]
    fn rejects_option_injection_and_bad_fields() {
        for host in [
            "-oProxyCommand=id",
            "web1 -o StrictHostKeyChecking=no",
            "web1;rm",
            "web1\n-oBatchMode=yes",
            "user@host",
            "fe80::1",
            "[192.0.2.1]",
            "",
            "   ",
            ".",
            "-web",
            "host$(id)",
            "host`id`",
            "host|id",
            "../etc",
            "[::1]:22",
            "[]",
            "[::1",
            "*",
            "web1,web2",
        ] {
            assert!(ssh_argv(&target(host, None, None)).is_err(), "{host}");
        }
        assert!(ssh_argv(&target(&"a".repeat(254), None, None)).is_err());
        assert!(ssh_argv(&target("web1", Some("-o"), None)).is_err());
        assert!(ssh_argv(&target("web1", Some(".alice"), None)).is_err());
        assert!(ssh_argv(&target("web1", Some("al ice"), None)).is_err());
        assert!(ssh_argv(&target("web1", Some("a/b"), None)).is_err());
        assert!(ssh_argv(&target("web1", Some(&"a".repeat(65)), None)).is_err());
        assert!(ssh_argv(&target("web1", None, Some(0))).is_err());
        let joined = ssh_argv(&target("web1", Some("ops"), Some(22)))
            .unwrap()
            .join(" ");
        assert!(!joined
            .to_ascii_lowercase()
            .contains("stricthostkeychecking"));
        assert!(!joined.contains(" -o"));
        assert!(!joined.contains("ProxyCommand"));
        assert!(!joined.contains("IdentityFile"));
    }

    #[test]
    fn rejects_unknown_target_fields() {
        assert!(
            serde_json::from_str::<SshTarget>(r#"{"host":"web1","identityFile":"/tmp/key"}"#)
                .is_err()
        );
        let parsed: SshTarget =
            serde_json::from_str(r#"{"host":"web1","user":null,"port":null}"#).unwrap();
        assert_eq!(ssh_argv(&parsed).unwrap(), owned(&["-t", "--", "web1"]));
    }
}
