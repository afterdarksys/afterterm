//! Multi-session native PTY manager.
//!
//! Threats: a dropped master closes the pty and SIGHUPs the shell, so every
//! session lives in managed state. Writes fail closed if the lock is poisoned
//! or the session is gone. The production gate withholds Enter until answered;
//! a wrong or missing answer sends Ctrl+C instead of the newline.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::destructive::{answered, Challenge};
use crate::gate::{challenge_for_line, LineTracker, Step};
use crate::path::augmented_path;

const READ_BUF: usize = 8192;

#[derive(Clone, Copy, Debug, Hash, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct SessionId(pub u64);

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SessionInfo {
    pub id: SessionId,
    pub cwd: String,
    pub title: String,
    pub alive: bool,
    pub reviewed: bool,
}

pub trait Sink: Send + Sync + 'static {
    fn output(&self, id: SessionId, sequence: u64, chunk: &[u8]);
    fn exit(&self, id: SessionId, code: u32);
    fn challenge(&self, id: SessionId, challenge: Challenge);
}

#[derive(Clone, Debug, Default)]
pub struct SpawnOpts {
    pub rows: u16,
    pub cols: u16,
    pub cwd: Option<PathBuf>,
    pub program: Option<String>,
}

#[derive(Debug)]
pub enum WriteOutcome {
    Written,
    Held { line: String, generation: u64 },
}

#[derive(Debug)]
pub enum HoldResolution {
    Released,
    Challenge(Challenge),
}

const HISTORY_LIMIT: usize = 256 * 1024;
const INPUT_LIMIT: usize = 64 * 1024;

#[derive(Clone, Debug, serde::Serialize)]
pub struct OutputChunk {
    pub sequence: u64,
    pub data: Vec<u8>,
}
#[derive(Clone, Debug, serde::Serialize)]
pub struct Snapshot {
    pub chunks: Vec<OutputChunk>,
    pub dropped: usize,
    pub sequence: u64,
    pub exit: Option<u32>,
    pub reviewed: bool,
    pub pending: Option<Challenge>,
}
#[derive(Default)]
struct OutputState {
    chunks: VecDeque<OutputChunk>,
    bytes: usize,
    dropped: usize,
    sequence: u64,
    exit: Option<u32>,
}
impl OutputState {
    fn push(&mut self, data: &[u8]) -> u64 {
        self.sequence += 1;
        self.bytes += data.len();
        self.chunks.push_back(OutputChunk {
            sequence: self.sequence,
            data: data.to_vec(),
        });
        while self.bytes > HISTORY_LIMIT {
            if let Some(chunk) = self.chunks.pop_front() {
                self.bytes -= chunk.data.len();
                self.dropped += chunk.data.len();
            }
        }
        self.sequence
    }
}
struct HeldEnter {
    bytes: Vec<u8>,
    generation: u64,
    challenge: Option<Challenge>,
}
#[derive(Default)]
struct PasteState {
    tail: VecDeque<u8>,
    open: bool,
}
impl PasteState {
    fn observe(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.tail.push_back(*byte);
            if self.tail.len() > 6 {
                self.tail.pop_front();
            }
            if self.tail.iter().copied().eq(b"\x1b[200~".iter().copied()) {
                self.open = true;
            }
            if self.tail.iter().copied().eq(b"\x1b[201~".iter().copied()) {
                self.open = false;
            }
        }
    }
}
struct PtySession {
    paste: PasteState,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    tracker: LineTracker,
    held: Option<HeldEnter>,
    generation: u64,
    settled: u64,
    cwd: PathBuf,
    title: String,
    reviewed: bool,
    output: Arc<Mutex<OutputState>>,
}
struct Inner {
    sessions: HashMap<SessionId, Arc<Mutex<PtySession>>>,
    next_id: u64,
}
pub struct SessionManager {
    inner: Mutex<Inner>,
    sink: Arc<dyn Sink>,
}
fn pty_size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}
fn lock_err(_: impl std::fmt::Debug) -> String {
    "pty state lock poisoned".into()
}
impl SessionManager {
    pub fn new(sink: Arc<dyn Sink>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                sessions: HashMap::new(),
                next_id: 1,
            }),
            sink,
        }
    }
    fn session(&self, id: SessionId) -> Result<Arc<Mutex<PtySession>>, String> {
        self.inner
            .lock()
            .map_err(lock_err)?
            .sessions
            .get(&id)
            .cloned()
            .ok_or("no such pty session".into())
    }
    pub fn spawn(&self, opts: SpawnOpts) -> Result<SessionId, String> {
        let cwd = opts.cwd.unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/"))
        });
        if !cwd.is_dir() {
            return Err(format!(
                "working directory is not a directory: {}",
                cwd.display()
            ));
        }
        let pair = native_pty_system()
            .openpty(pty_size(opts.rows, opts.cols))
            .map_err(|e| e.to_string())?;
        let mut cmd = match opts.program {
            Some(program) => CommandBuilder::new(program),
            None => CommandBuilder::new_default_prog(),
        };
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("PATH", augmented_path());
        if std::env::var_os("LANG").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }
        cmd.cwd(&cwd);
        // Obtain fallible handles before starting a child, avoiding unowned children on setup failure.
        #[cfg(unix)]
        let mut reader = {
            let fd = pair.master.as_raw_fd().ok_or("PTY has no descriptor")?;
            // Own a close-on-exec duplicate for the reader lifetime; never poll a descriptor
            // which can be closed/reused when a tab removes its master handle.
            let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
            if duplicate < 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            unsafe { std::fs::File::from_raw_fd(duplicate) }
        };
        #[cfg(not(unix))]
        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("could not spawn shell: {e}"))?;
        let killer = child.clone_killer();
        // Retain the slave while draining: macOS may discard unread PTY output
        // when the final slave descriptor closes, even for a successful child.
        let slave = pair.slave;
        let child_done = Arc::new(AtomicBool::new(false));
        let output = Arc::new(Mutex::new(OutputState::default()));
        let id = {
            let mut slot = match self.inner.lock() {
                Ok(slot) => slot,
                Err(e) => {
                    let _ = child.kill();
                    return Err(lock_err(e));
                }
            };
            let id = SessionId(slot.next_id);
            slot.next_id += 1;
            slot.sessions.insert(
                id,
                Arc::new(Mutex::new(PtySession {
                    paste: PasteState::default(),
                    master: pair.master,
                    writer,
                    killer,
                    tracker: LineTracker::default(),
                    held: None,
                    generation: 0,
                    settled: 0,
                    cwd,
                    title: "shell".into(),
                    reviewed: true,
                    output: output.clone(),
                })),
            );
            id
        };
        let sink = self.sink.clone();
        let stream = output.clone();
        let reader_done = child_done.clone();
        let reader_thread = thread::spawn(move || {
            #[cfg(unix)]
            let _slave = slave;
            #[cfg(not(unix))]
            drop(slave);
            let mut buf = [0u8; READ_BUF];
            loop {
                #[cfg(unix)]
                {
                    let mut poll = libc::pollfd {
                        fd: reader.as_raw_fd(),
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    let ready = unsafe { libc::poll(&mut poll, 1, 10) };
                    if ready < 0 {
                        if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
                        {
                            continue;
                        }
                        break;
                    }
                    if ready == 0 {
                        if reader_done.load(Ordering::Acquire) {
                            break;
                        }
                        continue;
                    }
                }
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let Ok(mut state) = stream.lock() else {
                            break;
                        };
                        let sequence = state.push(&buf[..n]);
                        sink.output(id, sequence, &buf[..n]);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
        });
        let sink = self.sink.clone();
        thread::spawn(move || {
            let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
            child_done.store(true, Ordering::Release);
            // Exit follows the final output, including for a child which exits before attach.
            let _ = reader_thread.join();
            if let Ok(mut state) = output.lock() {
                state.exit = Some(code);
                sink.exit(id, code);
            }
        });
        Ok(id)
    }
    pub fn snapshot(&self, id: SessionId) -> Result<Snapshot, String> {
        let arc = self.session(id)?;
        let session = arc.lock().map_err(lock_err)?;
        let state = session.output.lock().map_err(lock_err)?;
        Ok(Snapshot {
            chunks: state.chunks.iter().cloned().collect(),
            dropped: state.dropped,
            sequence: state.sequence,
            exit: state.exit,
            reviewed: session.reviewed,
            pending: session.held.as_ref().and_then(|h| h.challenge.clone()),
        })
    }
    pub fn pending(&self, id: SessionId) -> Result<Option<Challenge>, String> {
        let arc = self.session(id)?;
        let session = arc.lock().map_err(lock_err)?;
        Ok(session.held.as_ref().and_then(|h| h.challenge.clone()))
    }
    pub fn set_reviewed(
        &self,
        id: SessionId,
        reviewed: bool,
        typed: Option<&str>,
    ) -> Result<(), String> {
        let arc = self.session(id)?;
        let mut session = arc.lock().map_err(lock_err)?;
        if session.held.is_some() {
            return Err("Resolve the pending submission before changing modes".into());
        }
        if !reviewed && typed != Some("DIRECT") {
            return Err("Type DIRECT to disable submission review".into());
        }
        session.reviewed = reviewed;
        session.tracker.invalidate();
        Ok(())
    }
    pub fn set_title(&self, id: SessionId, title: String) -> Result<(), String> {
        self.session(id)?.lock().map_err(lock_err)?.title = title;
        Ok(())
    }
    pub fn write(&self, id: SessionId, data: &str) -> Result<WriteOutcome, String> {
        if data.len() > INPUT_LIMIT {
            return Err("Input exceeds 64 KiB; use smaller pastes".into());
        }
        let arc = self.session(id)?;
        let mut session = arc.lock().map_err(lock_err)?;
        if session.output.lock().map_err(lock_err)?.exit.is_some() {
            return Err("Shell has exited".into());
        }
        if session.held.is_some() {
            return Err("Review or cancel the pending submission first".into());
        }
        if !session.reviewed {
            write_raw(&mut session, data.as_bytes())?;
            return Ok(WriteOutcome::Written);
        }
        match session.tracker.feed(data) {
            Step::Pass(bytes) => {
                write_raw(&mut session, &bytes)?;
                Ok(WriteOutcome::Written)
            }
            Step::Hold { line, rest, .. } => {
                // Hold the entire packet: never leave a new bracketed paste half-open on cancel.
                session.generation += 1;
                let generation = session.generation;
                let preview = if rest.is_empty() { line } else { String::new() };
                session.held = Some(HeldEnter {
                    bytes: data.as_bytes().to_vec(),
                    generation,
                    challenge: None,
                });
                Ok(WriteOutcome::Held {
                    line: preview,
                    generation,
                })
            }
        }
    }
    pub fn resolve_hold_line(
        &self,
        id: SessionId,
        generation: u64,
        line: &str,
    ) -> Result<HoldResolution, String> {
        let arc = self.session(id)?;
        let mut session = arc.lock().map_err(lock_err)?;
        let Some(held) = session.held.as_mut().filter(|h| h.generation == generation) else {
            return Ok(HoldResolution::Released);
        };
        let mut challenge = challenge_for_line(None, line)
            .ok_or("Submission target unavailable; input remains held")?;
        challenge.request_id = generation;
        challenge.input = Some(format!("{:?}", String::from_utf8_lossy(&held.bytes)));
        challenge.reason.push_str(&format!(
            ". This approves the entire held input packet ({} bytes), including any pasted lines",
            held.bytes.len()
        ));
        held.challenge = Some(challenge.clone());
        self.sink.challenge(id, challenge.clone());
        Ok(HoldResolution::Challenge(challenge))
    }
    pub fn confirm(
        &self,
        id: SessionId,
        request_id: u64,
        typed: Option<&str>,
    ) -> Result<HoldResolution, String> {
        let arc = self.session(id)?;
        let mut session = arc.lock().map_err(lock_err)?;
        // An acknowledged or ambiguously-delivered old request can never submit a newer one.
        if request_id > 0 && request_id <= session.settled {
            return Ok(HoldResolution::Released);
        }
        let held = session.held.as_ref().ok_or("No pending submission")?;
        if held.generation != request_id {
            return Err("Stale submission review".into());
        }
        let challenge = held
            .challenge
            .as_ref()
            .ok_or("Submission is still being prepared")?;
        if typed.is_some() && !answered(challenge, typed) {
            return Err("Confirmation does not match; input remains held".into());
        }
        let held = session.held.take().expect("checked");
        session.settled = request_id;
        session.tracker.invalidate();
        let bytes = if typed.is_some() { held.bytes } else { vec![3] };
        write_raw(&mut session, &bytes).map_err(|e| {
            format!("Submission outcome uncertain; do not resend automatically: {e}")
        })?;
        Ok(HoldResolution::Released)
    }
    pub fn resize(&self, id: SessionId, rows: u16, cols: u16) -> Result<(), String> {
        self.session(id)?
            .lock()
            .map_err(lock_err)?
            .master
            .resize(pty_size(rows, cols))
            .map_err(|e| e.to_string())
    }
    pub fn kill(&self, id: SessionId) -> Result<(), String> {
        let session = self.inner.lock().map_err(lock_err)?.sessions.remove(&id);
        if let Some(session) = session {
            let mut session = session.lock().map_err(lock_err)?;
            if session.output.lock().map_err(lock_err)?.exit.is_none() {
                if let Err(error) = session.killer.kill() {
                    if error.raw_os_error() != Some(3) {
                        return Err(error.to_string());
                    }
                }
            }
        }
        Ok(())
    }
    pub fn list(&self) -> Result<Vec<SessionInfo>, String> {
        let sessions: Vec<_> = self
            .inner
            .lock()
            .map_err(lock_err)?
            .sessions
            .iter()
            .map(|(id, s)| (*id, s.clone()))
            .collect();
        sessions
            .into_iter()
            .map(|(id, arc)| {
                let session = arc.lock().map_err(lock_err)?;
                let alive = session.output.lock().map_err(lock_err)?.exit.is_none();
                Ok(SessionInfo {
                    id,
                    cwd: session.cwd.display().to_string(),
                    title: session.title.clone(),
                    alive,
                    reviewed: session.reviewed,
                })
            })
            .collect()
    }
    pub fn cwd(&self, id: SessionId) -> Result<PathBuf, String> {
        Ok(self.session(id)?.lock().map_err(lock_err)?.cwd.clone())
    }
    pub fn shutdown(&self) {
        let sessions = if let Ok(mut slot) = self.inner.lock() {
            slot.sessions.drain().map(|(_, s)| s).collect::<Vec<_>>()
        } else {
            return;
        };
        for session in sessions {
            if let Ok(mut s) = session.lock() {
                let _ = s.killer.kill();
            }
        }
    }
}
fn write_raw(session: &mut PtySession, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Ok(());
    }
    session
        .writer
        .write_all(bytes)
        .and_then(|()| session.writer.flush())
        .map_err(|e| format!("pty write failed: {e}"))?;
    session.paste.observe(bytes);
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    struct Collect {
        output: Mutex<Vec<u8>>,
        exits: Mutex<Vec<u32>>,
    }

    impl Sink for Collect {
        fn output(&self, _id: SessionId, _sequence: u64, chunk: &[u8]) {
            self.output.lock().expect("output").extend_from_slice(chunk);
        }
        fn exit(&self, _id: SessionId, code: u32) {
            self.exits.lock().expect("exits").push(code);
        }
        fn challenge(&self, _id: SessionId, _challenge: Challenge) {}
    }

    fn wait_for(collect: &Collect, needle: &[u8], timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let buf = collect.output.lock().expect("output");
            if buf.windows(needle.len()).any(|w| w == needle) {
                return true;
            }
            drop(buf);
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[cfg(unix)]
    #[test]
    fn two_shells_are_independent() {
        let collect = Arc::new(Collect {
            output: Mutex::new(Vec::new()),
            exits: Mutex::new(Vec::new()),
        });
        let manager = SessionManager::new(collect.clone());
        let a = manager
            .spawn(SpawnOpts {
                rows: 24,
                cols: 80,
                cwd: Some(PathBuf::from("/")),
                program: Some("/bin/sh".into()),
            })
            .expect("spawn a");
        let b = manager
            .spawn(SpawnOpts {
                rows: 24,
                cols: 80,
                cwd: Some(PathBuf::from("/")),
                program: Some("/bin/sh".into()),
            })
            .expect("spawn b");
        assert_ne!(a, b);
        manager.set_reviewed(a, false, Some("DIRECT")).unwrap();
        manager
            .write(a, "printf 'alpha-marker\\n'\n")
            .expect("write a");
        assert!(wait_for(&collect, b"alpha-marker", Duration::from_secs(3)));
        manager.kill(a).expect("kill a");
        manager.kill(b).expect("kill b");
        manager.shutdown();
    }

    #[cfg(unix)]
    #[test]
    fn missing_cwd_fails_closed() {
        let collect = Arc::new(Collect {
            output: Mutex::new(Vec::new()),
            exits: Mutex::new(Vec::new()),
        });
        let manager = SessionManager::new(collect);
        let err = manager
            .spawn(SpawnOpts {
                rows: 24,
                cols: 80,
                cwd: Some(PathBuf::from("/definitely-not-a-directory-afterterm")),
                program: Some("/bin/sh".into()),
            })
            .unwrap_err();
        assert!(err.contains("working directory"));
    }

    #[cfg(unix)]
    #[test]
    fn write_to_unknown_session_fails_closed() {
        let collect = Arc::new(Collect {
            output: Mutex::new(Vec::new()),
            exits: Mutex::new(Vec::new()),
        });
        let manager = SessionManager::new(collect);
        let err = manager.write(SessionId(99), "x").unwrap_err();
        assert!(err.contains("no such pty session"));
    }
    #[test]
    fn history_is_bounded_and_sequenced() {
        let mut stream = OutputState::default();
        for _ in 0..40 {
            stream.push(&[7; 8192]);
        }
        assert_eq!(stream.sequence, 40);
        assert_eq!(stream.bytes, HISTORY_LIMIT);
        assert_eq!(stream.dropped, 8 * 8192);
        assert_eq!(stream.chunks.front().unwrap().sequence, 9);
    }
    #[cfg(unix)]
    #[test]
    fn reviewed_input_is_held_and_confirmation_is_bound_to_request() {
        let collect = Arc::new(Collect {
            output: Mutex::new(Vec::new()),
            exits: Mutex::new(Vec::new()),
        });
        let manager = SessionManager::new(collect.clone());
        let id = manager
            .spawn(SpawnOpts {
                rows: 24,
                cols: 80,
                cwd: Some(PathBuf::from("/")),
                program: Some("/bin/sh".into()),
            })
            .unwrap();
        assert!(manager.set_reviewed(id, false, None).is_err());
        let (line, generation) = match manager.write(id, "printf 'executed-%s' 'once'\n").unwrap() {
            WriteOutcome::Held { line, generation } => (line, generation),
            other => panic!("{other:?}"),
        };
        manager.resolve_hold_line(id, generation, &line).unwrap();
        assert!(!wait_for(
            &collect,
            b"executed-once",
            Duration::from_millis(50)
        ));
        assert!(manager.write(id, "surprise\n").is_err());
        assert!(manager
            .confirm(id, generation + 1, Some("unknown target"))
            .is_err());
        assert!(manager.confirm(id, generation, Some("wrong")).is_err());
        manager
            .confirm(id, generation, Some("unknown target"))
            .unwrap();
        assert!(wait_for(&collect, b"executed-once", Duration::from_secs(3)));
        manager
            .confirm(id, generation, Some("unknown target"))
            .unwrap();
        let (line, next) = match manager.write(id, "printf 'never-%s' 'execute'\n").unwrap() {
            WriteOutcome::Held { line, generation } => (line, generation),
            other => panic!("{other:?}"),
        };
        manager.resolve_hold_line(id, next, &line).unwrap();
        manager
            .confirm(id, generation, Some("unknown target"))
            .unwrap();
        assert_eq!(manager.pending(id).unwrap().unwrap().request_id, next);
        manager.confirm(id, next, None).unwrap();
        assert!(!wait_for(
            &collect,
            b"never-execute",
            Duration::from_millis(50)
        ));
        manager.set_reviewed(id, false, Some("DIRECT")).unwrap();
        manager.write(id, "printf 'direct-%s' 'works'\n").unwrap();
        assert!(wait_for(&collect, b"direct-works", Duration::from_secs(3)));
        manager.kill(id).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn early_output_and_exit_survive_a_thousand_late_attachments() {
        // /bin/echo immediately writes a newline and exits, usually before snapshot.
        let collect = Arc::new(Collect {
            output: Mutex::new(Vec::new()),
            exits: Mutex::new(Vec::new()),
        });
        let manager = SessionManager::new(collect);
        for _ in 0..1000 {
            let id = manager
                .spawn(SpawnOpts {
                    rows: 24,
                    cols: 80,
                    cwd: Some(PathBuf::from("/")),
                    program: Some("/bin/echo".into()),
                })
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            let snapshot = loop {
                let snapshot = manager.snapshot(id).unwrap();
                if snapshot.exit.is_some() {
                    break snapshot;
                }
                assert!(Instant::now() < deadline, "short child did not exit");
                thread::sleep(Duration::from_millis(1));
            };
            assert_eq!(snapshot.exit, Some(0));
            assert_eq!(
                snapshot
                    .chunks
                    .iter()
                    .flat_map(|c| c.data.clone())
                    .collect::<Vec<_>>(),
                b"\r\n"
            );
            assert_eq!(manager.snapshot(id).unwrap().sequence, snapshot.sequence);
            manager.kill(id).unwrap();
            assert!(manager.list().unwrap().is_empty());
        }
    }
    #[cfg(unix)]
    #[test]
    fn a_blocked_writer_does_not_lock_other_sessions() {
        struct Blocked {
            entered: std::sync::mpsc::Sender<()>,
            release: std::sync::mpsc::Receiver<()>,
        }
        impl Write for Blocked {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.entered.send(()).unwrap();
                self.release.recv().unwrap();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let collect = Arc::new(Collect {
            output: Mutex::new(Vec::new()),
            exits: Mutex::new(Vec::new()),
        });
        let manager = Arc::new(SessionManager::new(collect));
        let spawn = || {
            manager
                .spawn(SpawnOpts {
                    rows: 24,
                    cols: 80,
                    cwd: Some(PathBuf::from("/")),
                    program: Some("/bin/sh".into()),
                })
                .unwrap()
        };
        let a = spawn();
        let b = spawn();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        manager.session(a).unwrap().lock().unwrap().writer = Box::new(Blocked {
            entered: entered_tx,
            release: release_rx,
        });
        let first_manager = manager.clone();
        let first = thread::spawn(move || first_manager.write(a, "a"));
        entered_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let second_manager = manager.clone();
        let second = thread::spawn(move || {
            done_tx.send(second_manager.write(b, "b").is_ok()).unwrap();
        });
        let result = done_rx.recv_timeout(Duration::from_secs(3));
        release_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        second.join().unwrap();
        manager.shutdown();
        assert_eq!(result.unwrap(), true);
    }
    #[test]
    fn bracketed_paste_state_survives_fragmented_packets() {
        let mut state = PasteState::default();
        state.observe(b"\x1b[20");
        state.observe(b"0~text");
        assert!(state.open);
        state.observe(b"more\r\n\x1b[2");
        state.observe(b"01~");
        assert!(!state.open);
    }
}
