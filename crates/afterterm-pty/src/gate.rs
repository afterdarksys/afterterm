//! Submission review is conservative: every CR/LF is held in reviewed mode.
//! Keystrokes provide only an unverified preview, never authorization or target identity.

use crate::destructive::{self, Challenge};

const WRAPPERS: &[&str] = &["sudo", "doas", "exec", "command", "time", "nohup", "nice"];

#[derive(Debug, Default)]
pub struct LineTracker {
    line: String,
    /// Unknown command preview after shell editing; submission is still held.
    desynced: bool,
}

#[derive(Debug, PartialEq)]
pub enum Step {
    /// Write these bytes now. No completed command to review.
    Pass(Vec<u8>),
    /// A submission requires review. Withhold `newline`; `passed`
    /// is the current packet prefix; `rest` arrived after Enter.
    Hold {
        passed: Vec<u8>,
        line: String,
        newline: Vec<u8>,
        rest: Vec<u8>,
    },
}

impl LineTracker {
    pub fn reset(&mut self) {
        self.line.clear();
        self.desynced = false;
    }
    pub fn invalidate(&mut self) {
        self.reset();
        self.desynced = true;
    }
    pub fn feed(&mut self, data: &str) -> Step {
        for (offset, ch) in data.char_indices() {
            // Check submission bytes before interpreting escape sequences. Even
            // incomplete/fragmented escapes cannot bypass the review boundary.
            if ch == '\r' || ch == '\n' {
                let end = offset
                    + if ch == '\r' && data[offset..].starts_with("\r\n") {
                        2
                    } else {
                        1
                    };
                let line = if self.desynced {
                    String::new()
                } else {
                    self.line.clone()
                };
                self.invalidate();
                return Step::Hold {
                    passed: data.as_bytes()[..offset].to_vec(),
                    line,
                    newline: data.as_bytes()[offset..end].to_vec(),
                    rest: data.as_bytes()[end..].to_vec(),
                };
            }
            match ch {
                '\u{3}' => self.reset(),
                '\u{8}' | '\u{7f}' if !self.desynced => {
                    self.line.pop();
                }
                c if c.is_control() => self.desynced = true,
                _ if !self.desynced && self.line.len() < 4096 => self.line.push(ch),
                _ => self.desynced = true,
            }
        }
        Step::Pass(data.as_bytes().to_vec())
    }
}

fn program_name(program: &str) -> &str {
    program.rsplit(['/', '\\']).next().unwrap_or(program)
}

/// Quote-aware tokens. No expansion, no globbing.
pub fn tokenize(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(ch) = chars.next() {
        if quote == Some('\'') {
            if ch == '\'' {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if quote == Some('"') {
            if ch == '"' {
                quote = None;
            } else if ch == '\\' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            c if c.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            '#' if current.is_empty() => break,
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// Split `&&` `||` `;` `|` outside quotes so a pipeline can still be gated.
pub fn segments(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut chars = line.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(ch) = chars.next() {
        if quote == Some('\'') {
            current.push(ch);
            if ch == '\'' {
                quote = None;
            }
            continue;
        }
        if quote == Some('"') {
            current.push(ch);
            if ch == '"' {
                quote = None;
            } else if ch == '\\' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            continue;
        }
        match ch {
            '\'' | '"' => {
                quote = Some(ch);
                current.push(ch);
            }
            '&' if chars.peek() == Some(&'&') => {
                chars.next();
                push_segment(&mut out, &mut current);
            }
            '|' if chars.peek() == Some(&'|') => {
                chars.next();
                push_segment(&mut out, &mut current);
            }
            '|' | ';' => push_segment(&mut out, &mut current),
            _ => current.push(ch),
        }
    }
    push_segment(&mut out, &mut current);
    out
}

fn push_segment(out: &mut Vec<String>, current: &mut String) {
    let trimmed = current.trim();
    if !trimmed.is_empty() {
        out.push(trimmed.to_string());
    }
    current.clear();
}

pub fn command_and_args(tokens: &[String]) -> Option<(String, Vec<String>)> {
    let mut i = 0;
    while i < tokens.len() {
        let name = program_name(&tokens[i]);
        if WRAPPERS.contains(&name) {
            i += 1;
            while i < tokens.len() && tokens[i].starts_with('-') && tokens[i] != "--" {
                i += 1;
            }
            if i < tokens.len() && tokens[i] == "--" {
                i += 1;
            }
            continue;
        }
        return Some((tokens[i].clone(), tokens[i + 1..].to_vec()));
    }
    None
}

pub fn line_is_destructive(line: &str) -> bool {
    if line.trim().is_empty() || line.trim_end().ends_with('\\') {
        return false;
    }
    for segment in segments(line) {
        let tokens = tokenize(&segment);
        if let Some((command, args)) = command_and_args(&tokens) {
            if destructive::is_destructive(&command, &args) {
                return true;
            }
        }
    }
    false
}

/// A hint from explicit arguments, never from the GUI process environment.
/// Unknown shell state, aliases and compound commands remain visibly unknown.
pub fn challenge_for_line(_root: Option<&std::path::Path>, line: &str) -> Option<Challenge> {
    let pieces = segments(line);
    if pieces.len() == 1 && !line.contains(['$', '`', '\\', '\n', '\r']) {
        let tokens = tokenize(line);
        if let Some((program, args)) = command_and_args(&tokens) {
            let flag = match program_name(&program) {
                "kubectl" | "oc" => Some("--context"),
                "helm" => Some("--kube-context"),
                "aws" => Some("--profile"),
                "gcloud" => Some("--project"),
                "az" => Some("--subscription"),
                _ => None,
            };
            if let Some(flag) = flag {
                let mut values = Vec::new();
                for (index, arg) in args.iter().enumerate() {
                    if arg == "--" {
                        break;
                    }
                    if arg == flag {
                        if let Some(value) = args.get(index + 1) {
                            values.push(value.as_str());
                        }
                    } else if let Some(value) = arg.strip_prefix(&format!("{flag}=")) {
                        values.push(value);
                    }
                }
                if values.len() == 1 {
                    let value = values[0];
                    if !value.is_empty()
                        && value.len() <= 200
                        && value
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || "_-.:/@".contains(c))
                    {
                        return Some(Challenge { request_id: 0,
                            input: None, action: "Review terminal submission".into(), expected: value.into(),
                            reason: format!("Explicit {flag} argument: {value}. This is an unverified command hint, not the resolved host/account. Check the terminal before submitting") });
                    }
                }
            }
        }
    }
    Some(Challenge { request_id: 0,
                            input: None, action: "Review terminal submission".into(), expected: "unknown target".into(),
        reason: "The actual command target is unknown. Shell editing, aliases, exports, working-directory changes and remote shells cannot be verified from keystrokes. Check the terminal before submitting".into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_submission_is_reviewed_including_unknown_input() {
        for prefix in [
            "ls",
            "kubectl delete pod api",
            "\x1b[A",
            "kubectl del\t",
            "\x1b[",
            "\x1b[200~text",
            "aliascmd",
            "",
            "\x03",
            "abc\x7f",
        ] {
            let mut tracker = LineTracker::default();
            tracker.feed(prefix);
            assert!(
                matches!(tracker.feed("\r"), Step::Hold { .. }),
                "{prefix:?}"
            );
        }
    }
    #[test]
    fn typed_bytes_pass_but_multiline_remainder_is_held() {
        let mut tracker = LineTracker::default();
        assert_eq!(tracker.feed("echo "), Step::Pass(b"echo ".to_vec()));
        match tracker.feed("first\r\nsecond\r") {
            Step::Hold {
                passed,
                newline,
                rest,
                line,
            } => {
                assert_eq!(passed, b"first");
                assert_eq!(newline, b"\r\n");
                assert_eq!(rest, b"second\r");
                assert_eq!(line, "echo first");
            }
            other => panic!("{other:?}"),
        }
    }
    #[test]
    fn target_hints_are_command_specific_and_never_probe_defaults() {
        for (line, expected) in [
            ("kubectl --context prod delete pod api", "prod"),
            ("aws --profile=prod ec2 terminate-instances", "prod"),
            (
                "helm --kube-context cluster-prod upgrade api ./chart",
                "cluster-prod",
            ),
            ("terraform apply", "unknown target"),
            (
                "kubectl --kubeconfig prod.yaml delete pod api",
                "unknown target",
            ),
            ("kubectl delete pod api", "unknown target"),
            (
                "kubectl --context dev --context prod delete pod api",
                "unknown target",
            ),
            ("kubectl --context $CTX delete pod api", "unknown target"),
            (
                "kubectl --context dev get pods; aws --profile prod delete-bucket",
                "unknown target",
            ),
        ] {
            assert_eq!(
                challenge_for_line(None, line).unwrap().expected,
                expected,
                "{line}"
            );
        }
    }

    #[test]
    fn wrappers_and_pipelines_still_match() {
        assert!(line_is_destructive("sudo kubectl delete pod api"));
        assert!(line_is_destructive("sudo -n kubectl delete pod api"));
        assert!(line_is_destructive("cat plan.json | kubectl apply -f -"));
        assert!(line_is_destructive("true && terraform apply"));
        assert!(!line_is_destructive("kubectl get pods"));
        assert!(!line_is_destructive("terraform plan"));
        assert!(!line_is_destructive("echo kubectl delete"));
        assert!(!line_is_destructive("kubectl delete pod api \\"));
    }

    #[test]
    fn quotes_do_not_split_a_token() {
        assert_eq!(
            tokenize(r#"helm upgrade api './charts/api' --set tag="v1""#),
            vec!["helm", "upgrade", "api", "./charts/api", "--set", "tag=v1"],
        );
    }

    #[test]
    fn comments_and_blanks_are_not_destructive() {
        assert!(!line_is_destructive(""));
        assert!(!line_is_destructive("  # kubectl delete pod api"));
        assert!(!line_is_destructive("echo hi # kubectl delete"));
    }
}
