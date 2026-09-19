//! A confirmation gate in front of destructive commands aimed at production.
//!
//! Threats: this protects against a mistake -- the wrong terminal, the wrong
//! kubeconfig, the wrong window -- not against an attacker, who could run the
//! command outside this app. It is a speed bump placed exactly where people
//! actually slip, and it fails closed: an unrecognised shape is not treated as
//! safe, it is simply not gated, and anything matched is gated until answered.

use serde::{Deserialize, Serialize};

use crate::context;

/// (program, subcommands that change something).
///
/// Deliberately specific. A gate that fires on `kubectl get` teaches people to
/// type through it without reading, which is worse than no gate at all.
const DESTRUCTIVE: &[(&str, &[&str])] = &[
    ("terraform", &["apply", "destroy"]),
    ("tofu", &["apply", "destroy"]),
    ("kubectl", &["delete", "apply", "replace", "patch", "scale", "drain", "cordon", "uncordon", "taint", "rollout"]),
    ("oc", &["delete", "apply", "replace", "patch", "scale", "rollout"]),
    ("helm", &["upgrade", "uninstall", "delete", "rollback"]),
    ("helmfile", &["apply", "destroy", "sync"]),
    ("flux", &["uninstall"]),
    ("argocd", &["delete"]),
    ("docker", &["rm", "rmi", "prune"]),
    ("podman", &["rm", "rmi", "prune"]),
    ("pulumi", &["up", "destroy"]),
];

/// Subcommand prefixes that are destructive whatever follows, for CLIs whose
/// verbs are open-ended.
const DESTRUCTIVE_PREFIXES: &[(&str, &[&str])] = &[
    ("aws", &["delete-", "terminate-", "remove-", "detach-", "disable-", "put-", "modify-"]),
    ("gcloud", &["delete", "remove"]),
    ("az", &["delete", "remove", "purge"]),
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Challenge {
    /// What the command would do, for the dialog.
    pub action: String,
    /// The exact string the user has to type.
    pub expected: String,
    /// Which signal made this look like production.
    pub reason: String,
}

/// How far in to look for the subcommand. Flag *values* are indistinguishable
/// from subcommands without a spec for every flag (`kubectl -n payments
/// delete` -- "payments" is not the verb), so scan rather than assume
/// position, but stay near the front: a subcommand is never the seventh
/// argument, while a bucket named "delete-me" might be.
const VERB_WINDOW: usize = 4;

fn program_name(program: &str) -> &str {
    program.rsplit(['/', '\\']).next().unwrap_or(program)
}

fn destructive_verb<'a>(program: &str, args: &'a [String]) -> Option<&'a str> {
    let program = program_name(program);

    args.iter()
        .take_while(|arg| arg.as_str() != "--")
        .map(String::as_str)
        .filter(|arg| !arg.starts_with('-'))
        .take(VERB_WINDOW)
        .find(|arg| {
            DESTRUCTIVE
                .iter()
                .any(|(name, verbs)| *name == program && verbs.contains(arg))
                || DESTRUCTIVE_PREFIXES.iter().any(|(name, prefixes)| {
                    *name == program && prefixes.iter().any(|prefix| arg.starts_with(prefix))
                })
        })
}

pub fn is_destructive(program: &str, args: &[String]) -> bool {
    destructive_verb(program, args).is_some()
}

pub fn is_infra_apply(program: &str, args: &[String]) -> bool {
    let program = program_name(program);
    matches!(program, "terraform" | "tofu")
        && destructive_verb(program, args).is_some_and(|verb| verb == "apply" || verb == "destroy")
}

pub fn challenge_for(
    program: &str,
    args: &[String],
    context: Option<&str>,
    production: bool,
) -> Option<Challenge> {
    if !production || !is_destructive(program, args) {
        return None;
    }
    let expected = context?.trim();
    if expected.is_empty() {
        return None;
    }

    let verb = destructive_verb(program, args).unwrap_or("");
    Some(Challenge {
        action: format!("{} {verb}", program_name(program)),
        expected: expected.to_string(),
        reason: format!("{expected} looks like production"),
    })
}

pub fn answered(challenge: &Challenge, typed: Option<&str>) -> bool {
    typed.is_some_and(|value| value.trim() == challenge.expected)
}

pub fn challenge_for_task(root: Option<&std::path::Path>, command: &str, args: &[String]) -> Option<Challenge> {
    if !is_destructive(command, args) {
        return None;
    }
    let (name, production) = context::target(root);
    challenge_for(command, args, name.as_deref(), production)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(line: &str) -> Vec<String> {
        line.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn terraform_apply_is_the_reviewed_apply_shape() {
        assert!(is_infra_apply("terraform", &args("apply -input=false plan.out")));
        assert!(is_infra_apply("/opt/homebrew/bin/tofu", &args("destroy")));
        assert!(!is_infra_apply("terraform", &args("plan -out=plan.out")));
        assert!(!is_infra_apply("kubectl", &args("apply -f deploy.yaml")));
    }

    #[test]
    fn changing_commands_are_recognised() {
        for line in [
            "terraform apply", "terraform destroy -auto-approve", "tofu apply",
            "kubectl delete deployment api", "kubectl apply -f deploy.yaml",
            "kubectl rollout restart deployment/api", "kubectl drain node-1",
            "helm upgrade api ./chart", "helm uninstall api",
            "docker prune", "pulumi destroy",
        ] {
            let parts = args(line);
            assert!(
                is_destructive(&parts[0], &parts[1..]),
                "{line} should be gated",
            );
        }
    }

    #[test]
    fn reading_commands_are_left_alone() {
        for line in [
            "terraform plan", "terraform show", "terraform fmt", "tofu validate",
            "kubectl get pods", "kubectl describe pod api", "kubectl logs api",
            "helm list", "helm template ./chart", "docker ps", "git status",
            "npm test", "make build",
        ] {
            let parts = args(line);
            assert!(
                !is_destructive(&parts[0], &parts[1..]),
                "{line} should not be gated",
            );
        }
    }

    #[test]
    fn global_flags_do_not_hide_the_verb() {
        let parts = args("kubectl -n payments --context prod delete pod api");
        assert!(is_destructive(&parts[0], &parts[1..]));
    }

    #[test]
    fn an_absolute_path_is_still_the_same_program() {
        let parts = args("/opt/homebrew/bin/terraform apply");
        assert!(is_destructive(&parts[0], &parts[1..]));
    }

    #[test]
    fn open_ended_clis_match_on_prefix() {
        for line in ["aws delete-bucket --name x", "aws terminate-instances --ids i-1", "gcloud delete thing", "az purge x"] {
            let parts = args(line);
            assert!(is_destructive(&parts[0], &parts[1..]), "{line} should be gated");
        }
        for line in ["aws describe-instances", "aws s3 ls", "gcloud list", "az show x"] {
            let parts = args(line);
            assert!(!is_destructive(&parts[0], &parts[1..]), "{line} should not be gated");
        }
    }

    #[test]
    fn a_far_flung_argument_does_not_trip_the_gate() {
        let parts = args("aws s3 ls --recursive --page-size 100 s3://delete-me");
        assert!(!is_destructive(&parts[0], &parts[1..]));
    }

    #[test]
    fn arguments_after_a_double_dash_are_not_subcommands() {
        let parts = args("kubectl exec api -- rm -rf /tmp/x");
        assert!(!is_destructive(&parts[0], &parts[1..]));
    }

    #[test]
    fn a_command_with_no_arguments_is_not_gated() {
        assert!(!is_destructive("kubectl", &[]));
        assert!(!is_destructive("terraform", &args("-help")));
    }

    #[test]
    fn production_plus_destructive_raises_a_challenge() {
        let parts = args("terraform apply");
        let challenge = challenge_for(&parts[0], &parts[1..], Some("acme-prod"), true)
            .expect("a destructive command against prod must be gated");
        assert_eq!(challenge.expected, "acme-prod");
        assert_eq!(challenge.action, "terraform apply");
        assert!(challenge.reason.contains("acme-prod"));
    }

    #[test]
    fn nothing_is_gated_outside_production() {
        let parts = args("terraform destroy");
        assert_eq!(challenge_for(&parts[0], &parts[1..], Some("staging"), false), None);
    }

    #[test]
    fn a_read_only_command_is_not_gated_even_in_production() {
        let parts = args("terraform plan");
        assert_eq!(challenge_for(&parts[0], &parts[1..], Some("acme-prod"), true), None);
    }

    #[test]
    fn without_a_context_name_there_is_nothing_to_type() {
        let parts = args("kubectl delete pod api");
        assert_eq!(challenge_for(&parts[0], &parts[1..], None, true), None);
        assert_eq!(challenge_for(&parts[0], &parts[1..], Some("   "), true), None);
    }

    #[test]
    fn wrong_typed_name_is_not_an_answer() {
        let challenge = Challenge {
            action: "kubectl delete".into(),
            expected: "acme-prod".into(),
            reason: "acme-prod looks like production".into(),
        };
        assert!(!answered(&challenge, None));
        assert!(!answered(&challenge, Some("staging")));
        assert!(!answered(&challenge, Some("acme-prod-2")));
        assert!(answered(&challenge, Some("acme-prod")));
        assert!(answered(&challenge, Some("  acme-prod  ")));
    }
}
