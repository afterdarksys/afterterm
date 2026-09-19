//! Which cluster, account and workspace a command launched from here would hit.
//!
//! Every probe is optional, bounded and best effort: a missing tool or an
//! unconfigured context is a blank field, never an error.

use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::path::resolve_binary;

const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_FIELD: usize = 200;

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Clone)]
pub struct ActiveContext {
    pub kube_context: Option<String>,
    pub kube_namespace: Option<String>,
    pub aws_profile: Option<String>,
    pub aws_region: Option<String>,
    pub terraform_workspace: Option<String>,
    pub production: bool,
}

/// Does this name look like production? Deliberately broad: a false positive
/// costs a highlight, a false negative costs an outage.
pub fn looks_like_production(fields: &[Option<String>]) -> bool {
    const MARKERS: &[&str] = &["prod", "prd", "live", "production"];
    fields.iter().flatten().any(|value| {
        let lower = value.to_lowercase();
        MARKERS.iter().any(|marker| {
            lower.split(|c: char| !c.is_alphanumeric()).any(|part| part == *marker)
                || lower.starts_with(marker)
                || lower.ends_with(marker)
        })
    })
}

fn clean(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_FIELD {
        return None;
    }
    Some(trimmed.to_string())
}

fn probe(binary: &str, args: &[&str], cwd: Option<&Path>) -> Option<String> {
    let path = resolve_binary(binary)?;
    let mut command = Command::new(path);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }

    let mut child = command.spawn().ok()?;
    let (tx, rx) = mpsc::channel();
    let mut stdout = child.stdout.take()?;
    thread::spawn(move || {
        use std::io::Read;
        let mut buffer = String::new();
        let _ = stdout.read_to_string(&mut buffer);
        let _ = tx.send(buffer);
    });

    let deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(_) => return None,
        }
    }

    rx.recv_timeout(Duration::from_secs(1)).ok().and_then(clean)
}

pub fn gather(root: Option<&Path>) -> ActiveContext {
    let kube_context = probe("kubectl", &["config", "current-context"], None);
    let kube_namespace = probe(
        "kubectl",
        &["config", "view", "--minify", "--output", "jsonpath={..namespace}"],
        None,
    );

    let aws_profile = std::env::var("AWS_PROFILE")
        .ok()
        .and_then(clean)
        .or_else(|| std::env::var("AWS_DEFAULT_PROFILE").ok().and_then(clean))
        .or_else(|| probe("aws", &["configure", "get", "profile"], None));
    let aws_region = std::env::var("AWS_REGION")
        .ok()
        .and_then(clean)
        .or_else(|| std::env::var("AWS_DEFAULT_REGION").ok().and_then(clean))
        .or_else(|| probe("aws", &["configure", "get", "region"], None));

    let terraform_workspace = root.and_then(|dir| {
        probe("terraform", &["workspace", "show"], Some(dir))
            .or_else(|| probe("tofu", &["workspace", "show"], Some(dir)))
    });

    let production = looks_like_production(&[
        kube_context.clone(),
        kube_namespace.clone(),
        aws_profile.clone(),
        terraform_workspace.clone(),
    ]);

    ActiveContext {
        kube_context,
        kube_namespace,
        aws_profile,
        aws_region,
        terraform_workspace,
        production,
    }
}

pub fn target(root: Option<&Path>) -> (Option<String>, bool) {
    let context = gather(root);
    let name = context
        .kube_context
        .clone()
        .or_else(|| context.terraform_workspace.clone())
        .or_else(|| context.aws_profile.clone());
    (name, context.production)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_names_are_recognised() {
        for name in [
            "prod", "production", "arn:aws:eks:us-east-1:1:cluster/acme-prod",
            "gke_acme-prod_us-central1_main", "acme-live", "prd-cluster", "PROD",
        ] {
            assert!(
                looks_like_production(&[Some(name.into())]),
                "{name} should read as production",
            );
        }
    }

    #[test]
    fn ordinary_names_are_not_flagged() {
        for name in ["staging", "dev", "minikube", "docker-desktop", "acme-test", "sandbox", "reproducer"] {
            assert!(
                !looks_like_production(&[Some(name.into())]),
                "{name} should not read as production",
            );
        }
    }

    #[test]
    fn any_field_can_trigger_the_flag() {
        assert!(looks_like_production(&[None, None, Some("prod-admin".into())]));
        assert!(!looks_like_production(&[None, None, None]));
    }

    #[test]
    fn blank_and_oversized_values_are_dropped() {
        assert_eq!(clean("  ".into()), None);
        assert_eq!(clean("\n".into()), None);
        assert_eq!(clean("x".repeat(MAX_FIELD + 1)), None);
        assert_eq!(clean("  minikube \n".into()), Some("minikube".into()));
    }

    #[test]
    fn a_missing_tool_is_a_blank_field_not_an_error() {
        assert_eq!(probe("definitely-not-installed-xyzzy", &["--version"], None), None);
    }

    #[test]
    fn gathering_never_panics_without_any_tooling() {
        let _context = gather(None);
    }
}
