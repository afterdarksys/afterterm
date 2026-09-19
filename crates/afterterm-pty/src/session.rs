//! Multi-session native PTY manager.
//!
//! Threats: a dropped master closes the pty and SIGHUPs the shell, so every
//! session lives in managed state. Writes fail closed if the lock is poisoned
//! or the session is gone. The production gate withholds Enter until answered;
//! a wrong or missing answer sends Ctrl+C instead of the newline.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
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
}

pub trait Sink: Send + Sync + 'static {
    fn output(&self, id: SessionId, chunk: &[u8]);
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

struct HeldEnter {
    newline: Vec<u8>,
    rest: Vec<u8>,
    generation: u64,
    challenge: Option<Challenge>,
}

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    tracker: LineTracker,
    held: Option<HeldEnter>,
    generation: u64,
    cwd: PathBuf,
    title: String,
    alive: bool,
}

struct Inner {
    sessions: HashMap<SessionId, PtySession>,
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
    "pty state lock poisoned".to_string()
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

    pub fn spawn(&self, opts: SpawnOpts) -> Result<SessionId, String> {
        let cwd = opts.cwd.unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/"))
        });
        if !cwd.is_dir() {
            return Err(format!("working directory is not a directory: {}", cwd.display()));
        }

        let pair = native_pty_system()
            .openpty(pty_size(opts.rows, opts.cols))
            .map_err(|e| format!("could not open pty: {e}"))?;

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

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("could not spawn shell: {e}"))?;
        let killer = child.clone_killer();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        let mut slot = self.inner.lock().map_err(lock_err)?;
        let id = SessionId(slot.next_id);
        slot.next_id += 1;

        let sink = Arc::clone(&self.sink);
        thread::spawn(move || {
            let mut buf = [0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => sink.output(id, &buf[..n]),
                    Err(_) => break,
                }
            }
        });

        let sink = Arc::clone(&self.sink);
        thread::spawn(move || {
            let code = child.wait().map(|status| status.exit_code()).unwrap_or(1);
            sink.exit(id, code);
        });

        slot.sessions.insert(
            id,
            PtySession {
                master: pair.master,
                writer,
                killer,
                tracker: LineTracker::default(),
                held: None,
                generation: 0,
                cwd,
                title: "shell".into(),
                alive: true,
            },
        );
        Ok(id)
    }

    pub fn mark_exited(&self, id: SessionId) -> Result<(), String> {
        let mut slot = self.inner.lock().map_err(lock_err)?;
        if let Some(session) = slot.sessions.get_mut(&id) {
            session.alive = false;
        }
        Ok(())
    }

    pub fn set_title(&self, id: SessionId, title: String) -> Result<(), String> {
        let mut slot = self.inner.lock().map_err(lock_err)?;
        let session = slot.sessions.get_mut(&id).ok_or("no such pty session")?;
        session.title = title;
        Ok(())
    }

    pub fn write(&self, id: SessionId, data: &str) -> Result<WriteOutcome, String> {
        let mut slot = self.inner.lock().map_err(lock_err)?;
        let session = slot.sessions.get_mut(&id).ok_or("no such pty session")?;
        match ingest(session, data)? {
            None => Ok(WriteOutcome::Written),
            Some((line, generation)) => Ok(WriteOutcome::Held { line, generation }),
        }
    }

    pub fn resolve_hold_line(
        &self,
        id: SessionId,
        generation: u64,
        line: &str,
    ) -> Result<HoldResolution, String> {
        let cwd = {
            let slot = self.inner.lock().map_err(lock_err)?;
            let session = slot.sessions.get(&id).ok_or("no such pty session")?;
            let Some(held) = session.held.as_ref() else {
                return Ok(HoldResolution::Released);
            };
            if held.generation != generation {
                return Ok(HoldResolution::Released);
            }
            session.cwd.clone()
        };

        let challenge = challenge_for_line(Some(cwd.as_path()), line);

        let mut slot = self.inner.lock().map_err(lock_err)?;
        let session = slot.sessions.get_mut(&id).ok_or("no such pty session")?;
        let Some(held) = session.held.as_mut() else {
            return Ok(HoldResolution::Released);
        };
        if held.generation != generation {
            return Ok(HoldResolution::Released);
        }
        if let Some(challenge) = challenge {
            held.challenge = Some(challenge.clone());
            self.sink.challenge(id, challenge.clone());
            return Ok(HoldResolution::Challenge(challenge));
        }
        let held = session.held.take().expect("held checked above");
        write_raw(session, &held.newline)?;
        if !held.rest.is_empty() {
            let rest = String::from_utf8_lossy(&held.rest).into_owned();
            drop(slot);
            return self.write_followup(id, &rest);
        }
        Ok(HoldResolution::Released)
    }

    fn write_followup(&self, id: SessionId, data: &str) -> Result<HoldResolution, String> {
        match self.write(id, data)? {
            WriteOutcome::Written => Ok(HoldResolution::Released),
            WriteOutcome::Held { line, generation } => self.resolve_hold_line(id, generation, &line),
        }
    }

    pub fn confirm(&self, id: SessionId, typed: Option<&str>) -> Result<HoldResolution, String> {
        let rest = {
            let mut slot = self.inner.lock().map_err(lock_err)?;
            let session = slot.sessions.get_mut(&id).ok_or("no such pty session")?;
            let Some(held) = session.held.take() else {
                return Ok(HoldResolution::Released);
            };
            let Some(challenge) = held.challenge else {
                session.tracker.reset();
                write_raw(session, &[0x03])?;
                return Ok(HoldResolution::Released);
            };
            if typed.is_none() || !answered(&challenge, typed) {
                session.tracker.reset();
                write_raw(session, &[0x03])?;
                return Ok(HoldResolution::Released);
            }
            write_raw(session, &held.newline)?;
            if held.rest.is_empty() {
                return Ok(HoldResolution::Released);
            }
            String::from_utf8_lossy(&held.rest).into_owned()
        };
        self.write_followup(id, &rest)
    }

    pub fn resize(&self, id: SessionId, rows: u16, cols: u16) -> Result<(), String> {
        let slot = self.inner.lock().map_err(lock_err)?;
        let session = slot.sessions.get(&id).ok_or("no such pty session")?;
        session
            .master
            .resize(pty_size(rows, cols))
            .map_err(|e| format!("pty resize failed: {e}"))
    }

    pub fn kill(&self, id: SessionId) -> Result<(), String> {
        let mut slot = self.inner.lock().map_err(lock_err)?;
        if let Some(mut session) = slot.sessions.remove(&id) {
            let _ = session.killer.kill();
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<SessionInfo>, String> {
        let slot = self.inner.lock().map_err(lock_err)?;
        Ok(slot
            .sessions
            .iter()
            .map(|(id, session)| SessionInfo {
                id: *id,
                cwd: session.cwd.display().to_string(),
                title: session.title.clone(),
                alive: session.alive,
            })
            .collect())
    }

    pub fn cwd(&self, id: SessionId) -> Result<PathBuf, String> {
        let slot = self.inner.lock().map_err(lock_err)?;
        let session = slot.sessions.get(&id).ok_or("no such pty session")?;
        Ok(session.cwd.clone())
    }

    pub fn shutdown(&self) {
        if let Ok(mut slot) = self.inner.lock() {
            for (_, mut session) in slot.sessions.drain() {
                let _ = session.killer.kill();
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
        .map_err(|e| format!("pty write failed: {e}"))
}

fn ingest(session: &mut PtySession, data: &str) -> Result<Option<(String, u64)>, String> {
    if data.is_empty() {
        return Ok(None);
    }
    if let Some(held) = session.held.as_mut() {
        if data.as_bytes().contains(&0x03) {
            session.held = None;
            session.tracker.reset();
            write_raw(session, &[0x03])?;
            return Ok(None);
        }
        held.rest.extend_from_slice(data.as_bytes());
        return Ok(None);
    }
    match session.tracker.feed(data) {
        Step::Pass(bytes) => {
            write_raw(session, &bytes)?;
            Ok(None)
        }
        Step::Hold {
            passed,
            line,
            newline,
            rest,
        } => {
            write_raw(session, &passed)?;
            session.generation += 1;
            let generation = session.generation;
            session.held = Some(HeldEnter {
                newline,
                rest,
                generation,
                challenge: None,
            });
            Ok(Some((line, generation)))
        }
    }
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
        fn output(&self, _id: SessionId, chunk: &[u8]) {
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
        manager.write(a, "printf 'alpha-marker\\n'\n").expect("write a");
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
}
