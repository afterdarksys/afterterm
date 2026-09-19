//! Reconstruct a shell line from PTY keystrokes and decide whether Enter
//! should wait for the production challenge.
//!
//! Threats: stops a *typed* `kubectl delete` / `terraform apply` against a
//! production context from executing when the user hits Enter in this
//! terminal. Does NOT parse a real shell: aliases, functions, `eval`,
//! `sudo -u`, zsh widgets, and anything after Tab/arrow-key editing are
//! treated as unknown and **not** gated (a false positive trains people to
//! type through the dialog). An attacker in the PTY can already run anything;
//! this is a mistake bumper.

use crate::destructive::{self, Challenge};

const WRAPPERS: &[&str] = &["sudo", "doas", "exec", "command", "time", "nohup", "nice"];

#[derive(Debug, Default)]
pub struct LineTracker {
    line: String,
    /// CSI/OSC/Tab/other controls we do not replay. Enter after this is not gated.
    desynced: bool,
    in_escape: bool,
}

#[derive(Debug, PartialEq)]
pub enum Step {
    /// Write these bytes now. No completed command to review.
    Pass(Vec<u8>),
    /// A reconstructed line looks destructive. Withhold `newline`; `passed`
    /// was already typed and should go through; `rest` arrived after Enter.
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
        self.in_escape = false;
    }

    pub fn feed(&mut self, data: &str) -> Step {
        let bytes = data.as_bytes();
        let mut passed = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];
            if self.in_escape {
                passed.push(b);
                if (0x40..=0x7e).contains(&b) && b != b'[' && b != b']' && b != b'(' && b != b')' {
                    self.in_escape = false;
                }
                i += 1;
                continue;
            }
            if b == 0x1b {
                passed.push(b);
                self.in_escape = true;
                self.desynced = true;
                i += 1;
                continue;
            }
            if b == b'\t' {
                passed.push(b);
                self.desynced = true;
                i += 1;
                continue;
            }
            if b == 0x03 {
                passed.push(b);
                self.reset();
                i += 1;
                continue;
            }
            if b == 0x08 || b == 0x7f {
                passed.push(b);
                if !self.desynced {
                    self.line.pop();
                }
                i += 1;
                continue;
            }
            if b == b'\r' || b == b'\n' {
                let mut newline = vec![b];
                if b == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
                    newline.push(b'\n');
                    i += 1;
                }
                let line = std::mem::take(&mut self.line);
                let desynced = self.desynced;
                self.reset();
                i += 1;
                if !desynced && line_is_destructive(&line) {
                    return Step::Hold {
                        passed,
                        line,
                        newline,
                        rest: bytes[i..].to_vec(),
                    };
                }
                passed.extend_from_slice(&newline);
                continue;
            }
            if b < 0x20 {
                passed.push(b);
                self.desynced = true;
                i += 1;
                continue;
            }
            if !self.desynced {
                if let Ok(text) = std::str::from_utf8(&bytes[i..]) {
                    if let Some(ch) = text.chars().next() {
                        let n = ch.len_utf8();
                        passed.extend_from_slice(&bytes[i..i + n]);
                        self.line.push(ch);
                        i += n;
                        continue;
                    }
                }
                self.desynced = true;
            }
            passed.push(b);
            i += 1;
        }
        Step::Pass(passed)
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

pub fn challenge_for_line(root: Option<&std::path::Path>, line: &str) -> Option<Challenge> {
    for segment in segments(line) {
        let tokens = tokenize(&segment);
        if let Some((command, args)) = command_and_args(&tokens) {
            if let Some(challenge) = destructive::challenge_for_task(root, &command, &args) {
                return Some(challenge);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_typing_is_passed_through() {
        let mut t = LineTracker::default();
        assert_eq!(t.feed("kubectl get pods"), Step::Pass(b"kubectl get pods".to_vec()));
        match t.feed("\r") {
            Step::Pass(bytes) => assert_eq!(bytes, b"\r"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn destructive_enter_is_held() {
        let mut t = LineTracker::default();
        t.feed("kubectl delete pod api");
        match t.feed("\r") {
            Step::Hold { line, newline, rest, passed } => {
                assert_eq!(line, "kubectl delete pod api");
                assert_eq!(newline, b"\r");
                assert!(rest.is_empty());
                assert!(passed.is_empty());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_paste_holds_from_the_destructive_line() {
        let mut t = LineTracker::default();
        match t.feed("kubectl get pods\rkubectl delete pod api\rkubectl get\r") {
            Step::Hold { line, rest, passed, .. } => {
                assert_eq!(line, "kubectl delete pod api");
                assert_eq!(rest, b"kubectl get\r");
                assert_eq!(passed, b"kubectl get pods\rkubectl delete pod api");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn backspace_edits_the_reconstructed_line() {
        let mut t = LineTracker::default();
        t.feed("kubectl delete");
        t.feed("\u{7f}\u{7f}\u{7f}\u{7f}\u{7f}\u{7f}");
        t.feed("get");
        match t.feed("\r") {
            Step::Pass(_) => {}
            other => panic!("edited into a read should pass: {other:?}"),
        }
    }

    #[test]
    fn arrows_desync_and_enter_is_not_gated() {
        let mut t = LineTracker::default();
        t.feed("kubectl delete pod api");
        t.feed("\u{1b}[A");
        match t.feed("\r") {
            Step::Pass(_) => {}
            other => panic!("desynced enter must not hold: {other:?}"),
        }
    }

    #[test]
    fn tab_completion_is_not_gated() {
        let mut t = LineTracker::default();
        t.feed("kubectl del");
        t.feed("\t");
        match t.feed("\r") {
            Step::Pass(_) => {}
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn ctrl_c_clears_the_line() {
        let mut t = LineTracker::default();
        t.feed("kubectl delete");
        t.feed("\u{3}");
        match t.feed("\r") {
            Step::Pass(bytes) => assert_eq!(bytes, b"\r"),
            other => panic!("{other:?}"),
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
