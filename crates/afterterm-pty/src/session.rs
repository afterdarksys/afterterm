//! Multi-session native PTY manager.
//!
//! Threats: a dropped master closes the pty and SIGHUPs the shell, so every
//! session lives in managed state. Writes fail closed if the lock is poisoned
//! or the session is gone. The production gate withholds Enter until answered;
//! a wrong or missing answer sends Ctrl+C instead of the newline.
//! Signals go only to this session's own process tree: the foreground process
//! group of its pty when that group belongs to the child's session, otherwise
//! the child's own group. Signal names are an allowlist. Session logs write to
//! a file the caller already opened; this module never opens paths itself.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Read-only facts about one session, for the Session Info panel.
#[derive(Clone, Debug, serde::Serialize)]
pub struct SessionDetails {
    pub id: SessionId,
    pub title: String,
    pub program: String,
    pub args: Vec<String>,
    pub pid: Option<u32>,
    pub foreground_pgid: Option<i32>,
    pub start_cwd: String,
    pub cwd: Option<String>,
    pub rows: u16,
    pub cols: u16,
    pub started_at_ms: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub exit: Option<u32>,
    pub reviewed: bool,
    pub log: Option<LogStatus>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct LogStatus {
    pub path: String,
    pub bytes: u64,
    /// Why logging stopped on its own, if it did.
    pub error: Option<String>,
    /// False once the log has stopped because of an error.
    pub active: bool,
}

/// The only signals a user can send from the GUI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Int,
    Tstp,
    Quit,
    Hup,
    Term,
}

impl Signal {
    /// Exact upper-case names only; anything else is refused.
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "INT" => Ok(Self::Int),
            "TSTP" => Ok(Self::Tstp),
            "QUIT" => Ok(Self::Quit),
            "HUP" => Ok(Self::Hup),
            "TERM" => Ok(Self::Term),
            _ => Err(format!("Unsupported signal: {name}")),
        }
    }
    #[cfg(unix)]
    fn number(self) -> libc::c_int {
        match self {
            Self::Int => libc::SIGINT,
            Self::Tstp => libc::SIGTSTP,
            Self::Quit => libc::SIGQUIT,
            Self::Hup => libc::SIGHUP,
            Self::Term => libc::SIGTERM,
        }
    }
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
/// Chunks queued for the log writer; at 8 KiB per read this bounds the queue near 2 MiB.
const LOG_QUEUE: usize = 256;
#[derive(Default)]
struct LogShared {
    bytes: u64,
    error: Option<String>,
}
/// The PTY reader never touches the log file: it hands chunks to a writer thread through a
/// bounded queue, so a slow or hung volume stops the log instead of freezing the terminal.
struct SessionLog {
    sender: Option<std::sync::mpsc::SyncSender<Vec<u8>>>,
    path: String,
    shared: Arc<Mutex<LogShared>>,
}
impl SessionLog {
    fn start(mut file: Box<dyn Write + Send>, path: String) -> Self {
        let (sender, receiver) = std::sync::mpsc::sync_channel::<Vec<u8>>(LOG_QUEUE);
        let shared = Arc::new(Mutex::new(LogShared::default()));
        let worker = shared.clone();
        thread::spawn(move || {
            for chunk in receiver {
                let result = file.write_all(&chunk);
                let mut state = worker.lock().unwrap_or_else(|e| e.into_inner());
                match result {
                    Ok(()) => state.bytes += chunk.len() as u64,
                    Err(e) => {
                        state.error.get_or_insert(format!("write failed: {e}"));
                        return;
                    }
                }
            }
            let _ = file.flush();
        });
        Self { sender: Some(sender), path, shared }
    }
    fn send(&mut self, data: &[u8]) {
        let Some(sender) = &self.sender else { return };
        let reason = match sender.try_send(data.to_vec()) {
            Ok(()) => return,
            Err(std::sync::mpsc::TrySendError::Full(_)) => {
                "the log file could not keep up with terminal output"
            }
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => "the log writer stopped",
        };
        self.sender = None;
        self.shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .error
            .get_or_insert(reason.into());
    }
    fn status(&self) -> LogStatus {
        let shared = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        LogStatus {
            path: self.path.clone(),
            bytes: shared.bytes,
            error: shared.error.clone(),
            active: self.sender.is_some() && shared.error.is_none(),
        }
    }
}
#[derive(Default)]
struct OutputState {
    chunks: VecDeque<OutputChunk>,
    bytes: usize,
    dropped: usize,
    sequence: u64,
    exit: Option<u32>,
    total: u64,
    log: Option<SessionLog>,
}
impl OutputState {
    fn push(&mut self, data: &[u8]) -> u64 {
        self.sequence += 1;
        self.bytes += data.len();
        self.total += data.len() as u64;
        if let Some(log) = self.log.as_mut() {
            // Never blocks: a failing or slow log stops logging, never the session.
            log.send(data);
        }
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
    program: String,
    args: Vec<String>,
    pid: Option<u32>,
    started_at_ms: u64,
    bytes_in: u64,
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
        self.spawn_with_args(opts, &[])
    }

    /// Spawn an executable with literal argv; never interpret arguments as shell text.
    pub fn spawn_with_args(&self, opts: SpawnOpts, args: &[String]) -> Result<SessionId, String> {
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
        let program = opts.program.clone().unwrap_or_else(|| {
            std::env::var("SHELL").unwrap_or_else(|_| "default login shell".into())
        });
        let mut cmd = match opts.program {
            Some(program) => CommandBuilder::new(program),
            None => CommandBuilder::new_default_prog(),
        };
        cmd.args(args);
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
        let pid = child.process_id();
        let started_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
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
                    reviewed: false,
                    output: output.clone(),
                    program,
                    args: args.to_vec(),
                    pid,
                    started_at_ms,
                    bytes_in: 0,
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
    pub fn details(&self, id: SessionId) -> Result<SessionDetails, String> {
        let arc = self.session(id)?;
        let session = arc.lock().map_err(lock_err)?;
        let size = session.master.get_size().map_err(|e| e.to_string())?;
        let state = session.output.lock().map_err(lock_err)?;
        let alive = state.exit.is_none();
        Ok(SessionDetails {
            id,
            title: session.title.clone(),
            program: session.program.clone(),
            args: session.args.clone(),
            pid: session.pid,
            foreground_pgid: if alive { session.master.process_group_leader() } else { None },
            start_cwd: session.cwd.display().to_string(),
            cwd: session.pid.filter(|_| alive).and_then(process_cwd),
            rows: size.rows,
            cols: size.cols,
            started_at_ms: session.started_at_ms,
            bytes_in: session.bytes_in,
            bytes_out: state.total,
            exit: state.exit,
            reviewed: session.reviewed,
            log: state.log.as_ref().map(SessionLog::status),
        })
    }
    /// Signal this session's foreground job, or its own child. Returns a description of the target.
    pub fn signal(&self, id: SessionId, signal: Signal) -> Result<String, String> {
        let arc = self.session(id)?;
        let session = arc.lock().map_err(lock_err)?;
        if session.output.lock().map_err(lock_err)?.exit.is_some() {
            return Err("Session has exited".into());
        }
        #[cfg(unix)]
        {
            let pid = session
                .pid
                .and_then(|pid| libc::pid_t::try_from(pid).ok())
                .filter(|pid| *pid > 1)
                .ok_or("Child process id is unknown")?;
            // The child is a session leader, so its process group id is its pid. The tty's
            // foreground group is used only when the tty belongs to the child's session: the
            // kernel lets tcsetpgrp pick only groups of that session, and this check holds even
            // after a pipeline's group leader has exited (getsid on the leader would not).
            let fd = session.master.as_raw_fd();
            let target = match (session.master.process_group_leader(), fd) {
                (Some(group), Some(fd)) if group > 1 && unsafe { libc::tcgetsid(fd) } == pid => group,
                _ => pid,
            };
            if unsafe { libc::killpg(target, signal.number()) } != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(if target == pid {
                format!("process group {target} (the session's own program)")
            } else {
                format!("foreground process group {target}")
            })
        }
        #[cfg(not(unix))]
        {
            let _ = (session, signal);
            Err("Signals are supported on macOS and Linux only".into())
        }
    }
    /// Append raw output to an already-opened file until stopped.
    pub fn start_log(&self, id: SessionId, file: std::fs::File, path: String) -> Result<(), String> {
        let arc = self.session(id)?;
        let session = arc.lock().map_err(lock_err)?;
        let mut state = session.output.lock().map_err(lock_err)?;
        if state.exit.is_some() {
            return Err("Session has exited".into());
        }
        if state.log.is_some() {
            return Err("This session is already being logged".into());
        }
        state.log = Some(SessionLog::start(Box::new(file), path));
        Ok(())
    }
    pub fn stop_log(&self, id: SessionId) -> Result<Option<LogStatus>, String> {
        let arc = self.session(id)?;
        let session = arc.lock().map_err(lock_err)?;
        let mut state = session.output.lock().map_err(lock_err)?;
        // Dropping the sender lets the writer finish queued chunks and exit on its own.
        Ok(state.log.take().map(|log| log.status()))
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
#[cfg(target_os = "macos")]
fn process_cwd(pid: u32) -> Option<String> {
    let pid = libc::c_int::try_from(pid).ok()?;
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            (&mut info as *mut libc::proc_vnodepathinfo).cast(),
            size,
        )
    };
    if read != size {
        return None;
    }
    let path = &info.pvi_cdir.vip_path;
    let bytes = unsafe {
        std::slice::from_raw_parts(path.as_ptr().cast::<u8>(), std::mem::size_of_val(path))
    };
    let path = std::ffi::CStr::from_bytes_until_nul(bytes).ok()?;
    Some(path.to_string_lossy().into_owned()).filter(|p| !p.is_empty())
}
#[cfg(target_os = "linux")]
fn process_cwd(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/cwd"))
        .ok()
        .map(|p| p.display().to_string())
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_cwd(_pid: u32) -> Option<String> {
    None
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
    session.bytes_in += bytes.len() as u64;
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
    fn child_arguments_are_literal_and_output_is_retained() {
        let collect = Arc::new(Collect {
            output: Mutex::new(Vec::new()),
            exits: Mutex::new(Vec::new()),
        });
        let manager = SessionManager::new(collect.clone());
        let id = manager.spawn_with_args(SpawnOpts {
            rows: 24, cols: 80, cwd: Some(PathBuf::from("/")),
            program: Some("/usr/bin/printf".into()),
        }, &["%s".into(), "literal;$(echo expanded) with spaces".into()]).unwrap();
        assert!(wait_for(&collect, b"literal;$(echo expanded) with spaces", Duration::from_secs(3)));
        assert!(!manager.snapshot(id).unwrap().reviewed);
        manager.shutdown();
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
        manager.set_reviewed(id, true, None).unwrap();
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
    fn only_allowlisted_signal_names_parse() {
        assert_eq!(Signal::parse("INT").unwrap(), Signal::Int);
        assert_eq!(Signal::parse("TSTP").unwrap(), Signal::Tstp);
        assert_eq!(Signal::parse("QUIT").unwrap(), Signal::Quit);
        assert_eq!(Signal::parse("HUP").unwrap(), Signal::Hup);
        assert_eq!(Signal::parse("TERM").unwrap(), Signal::Term);
        for bad in ["KILL", "int", "SIGINT", "9", "", "TERM ", "STOP", "USR1"] {
            assert!(Signal::parse(bad).is_err(), "{bad} must be refused");
        }
    }
    #[cfg(unix)]
    #[test]
    fn signals_reach_the_session_child_and_refuse_after_exit() {
        let collect = Arc::new(Collect {
            output: Mutex::new(Vec::new()),
            exits: Mutex::new(Vec::new()),
        });
        let manager = SessionManager::new(collect.clone());
        let id = manager
            .spawn_with_args(
                SpawnOpts { rows: 24, cols: 80, cwd: Some(PathBuf::from("/")), program: Some("/bin/sleep".into()) },
                &["30".into()],
            )
            .unwrap();
        let details = manager.details(id).unwrap();
        assert_eq!(details.program, "/bin/sleep");
        assert_eq!(details.args, vec!["30".to_string()]);
        assert!(details.pid.is_some());
        assert_eq!((details.rows, details.cols), (24, 80));
        manager.signal(id, Signal::Term).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while manager.snapshot(id).unwrap().exit.is_none() {
            assert!(Instant::now() < deadline, "SIGTERM did not end the child");
            thread::sleep(Duration::from_millis(10));
        }
        assert!(manager.signal(id, Signal::Int).is_err());
        assert!(manager.signal(SessionId(999), Signal::Int).is_err());
        manager.shutdown();
    }
    #[cfg(unix)]
    #[test]
    fn session_log_appends_raw_output_and_counts_bytes() {
        let collect = Arc::new(Collect {
            output: Mutex::new(Vec::new()),
            exits: Mutex::new(Vec::new()),
        });
        let manager = SessionManager::new(collect.clone());
        let id = manager
            .spawn(SpawnOpts { rows: 24, cols: 80, cwd: Some(PathBuf::from("/")), program: Some("/bin/sh".into()) })
            .unwrap();
        let dir = std::env::temp_dir().join(format!("afterterm-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.log");
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
        manager.start_log(id, file, path.display().to_string()).unwrap();
        let again = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        assert!(manager.start_log(id, again, "x".into()).is_err());
        manager.write(id, "printf 'logged-%s\\n' marker\n").unwrap();
        assert!(wait_for(&collect, b"logged-marker", Duration::from_secs(3)));
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let logged = std::fs::read(&path).unwrap();
            if logged.windows(13).any(|w| w == b"logged-marker") {
                break;
            }
            assert!(Instant::now() < deadline, "log never received the output");
            thread::sleep(Duration::from_millis(10));
        }
        let details = manager.details(id).unwrap();
        assert!(details.bytes_in > 0 && details.bytes_out > 0);
        let log = details.log.unwrap();
        assert!(log.active && log.error.is_none() && log.bytes > 0);
        assert!(manager.stop_log(id).unwrap().is_some());
        assert!(manager.stop_log(id).unwrap().is_none());
        manager.shutdown();
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn a_hung_log_volume_stops_the_log_without_blocking_output() {
        struct Hung(std::sync::mpsc::Receiver<()>);
        impl Write for Hung {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                let _ = self.0.recv();
                Err(std::io::Error::other("volume went away"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (release, hang) = std::sync::mpsc::channel();
        let mut state = OutputState::default();
        state.log = Some(SessionLog::start(Box::new(Hung(hang)), "hung.log".into()));
        let started = Instant::now();
        for _ in 0..LOG_QUEUE + 4 {
            state.push(&[b'x'; 64]);
        }
        assert!(started.elapsed() < Duration::from_secs(1), "output blocked on the log");
        let status = state.log.as_ref().unwrap().status();
        assert!(!status.active);
        assert!(status.error.unwrap().contains("could not keep up"));
        assert_eq!(state.total, (LOG_QUEUE as u64 + 4) * 64);
        drop(release);
    }
    #[cfg(unix)]
    #[test]
    fn signals_reach_a_foreground_pipeline_whose_leader_exited() {
        let collect = Arc::new(Collect {
            output: Mutex::new(Vec::new()),
            exits: Mutex::new(Vec::new()),
        });
        let manager = SessionManager::new(collect.clone());
        let id = manager
            .spawn_with_args(
                SpawnOpts { rows: 24, cols: 80, cwd: Some(PathBuf::from("/")), program: Some("/bin/sh".into()) },
                &["-i".into()],
            )
            .unwrap();
        // `true` leads the pipeline's process group and exits at once; sleep stays in front.
        manager.write(id, "true | sleep 30; echo pipeline-$?-done\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let shell = manager.details(id).unwrap().pid.unwrap() as i32;
        loop {
            let group = manager.details(id).unwrap().foreground_pgid;
            if group.is_some_and(|g| g != shell) {
                thread::sleep(Duration::from_millis(100));
                break;
            }
            assert!(Instant::now() < deadline, "pipeline never reached the foreground");
            thread::sleep(Duration::from_millis(10));
        }
        let target = manager.signal(id, Signal::Int).unwrap();
        assert!(target.starts_with("foreground process group"), "{target}");
        assert!(wait_for(&collect, b"pipeline-130-done", Duration::from_secs(3)));
        manager.shutdown();
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
