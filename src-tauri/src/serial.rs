//! Direct serial consoles. No shell subprocess or command interpolation.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Deserialize)]
pub struct Config {
    path: String,
    baud: u32,
    data_bits: u8,
    parity: String,
    stop_bits: u8,
    flow_control: String,
    production: bool,
}
impl Config {
    fn builder(&self) -> Result<serialport::SerialPortBuilder, String> {
        if !self.path.starts_with("/dev/") || self.path.contains('\0') {
            return Err("Choose a device under /dev".into());
        }
        if self.baud == 0 || self.baud > 4_000_000 {
            return Err("Baud must be between 1 and 4000000".into());
        }
        let bits = match self.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            8 => DataBits::Eight,
            _ => return Err("Invalid data bits".into()),
        };
        let parity = match self.parity.as_str() {
            "none" => Parity::None,
            "even" => Parity::Even,
            "odd" => Parity::Odd,
            _ => return Err("Invalid parity".into()),
        };
        let stop = match self.stop_bits {
            1 => StopBits::One,
            2 => StopBits::Two,
            _ => return Err("Invalid stop bits".into()),
        };
        let flow = match self.flow_control.as_str() {
            "none" => FlowControl::None,
            "hardware" => FlowControl::Hardware,
            "software" => FlowControl::Software,
            _ => return Err("Invalid flow control".into()),
        };
        Ok(serialport::new(&self.path, self.baud)
            .data_bits(bits)
            .parity(parity)
            .stop_bits(stop)
            .flow_control(flow)
            .timeout(Duration::from_millis(100)))
    }
}
const BOOT_BUFFER_LIMIT: usize = 256 * 1024;
#[derive(Default)]
struct BootBuffer {
    attached: bool,
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    dropped: usize,
}
impl BootBuffer {
    fn push(&mut self, bytes: &[u8]) {
        self.chunks.push_back(bytes.to_vec());
        self.bytes += bytes.len();
        while self.bytes > BOOT_BUFFER_LIMIT {
            if let Some(chunk) = self.chunks.pop_front() {
                self.bytes -= chunk.len();
                self.dropped += chunk.len();
            }
        }
    }
}
struct Session {
    port: Box<dyn SerialPort>,
    stop: Arc<AtomicBool>,
    reader: Option<std::thread::JoinHandle<()>>,
    config: Config,
    pending: Option<Vec<u8>>,
    generation: u64,
    settled: u64,
    output: Arc<Mutex<BootBuffer>>,
    transferring: Arc<AtomicBool>,
    cancel_transfer: Arc<AtomicBool>,
}
impl Session {
    fn write(&mut self, data: String) -> Result<Option<afterterm_pty::Challenge>, String> {
        if self.transferring.load(Ordering::SeqCst) {
            return Err("A paste is in progress; cancel it before typing".into());
        }
        if self.stop.load(Ordering::SeqCst) {
            return Err("Console disconnected; close the tab and reconnect".into());
        }
        if self.pending.is_some() {
            return Err("Review the pending console input first".into());
        }
        if data.len() > 65536 {
            return Err("Paste at most 64 KiB at a time".into());
        }
        if self.config.production && data.bytes().any(|b| b == b'\r' || b == b'\n') {
            self.generation += 1;
            self.pending = Some(data.into_bytes());
            return Ok(Some(afterterm_pty::Challenge {
                request_id: self.generation,
                input: self
                    .pending
                    .as_ref()
                    .map(|bytes| format!("{:?}", String::from_utf8_lossy(bytes))),
                action: "Submit console input".into(),
                expected: self.config.path.clone(),
                reason: format!(
                    "Production console {} requires review for every Enter or multiline paste",
                    self.config.path
                ),
            }));
        }
        self.port
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(None)
    }
    fn review(&self) -> Option<afterterm_pty::Challenge> {
        self.pending.as_ref().map(|_| afterterm_pty::Challenge {
            request_id: self.generation,
            input: self
                .pending
                .as_ref()
                .map(|bytes| format!("{:?}", String::from_utf8_lossy(bytes))),
            action: "Submit console input".into(),
            expected: self.config.path.clone(),
            reason: format!("Review held input for console {}", self.config.path),
        })
    }
    fn confirm(&mut self, request_id: u64, typed: Option<String>) -> Result<(), String> {
        if request_id > 0 && request_id <= self.settled {
            return Ok(());
        }
        if request_id != self.generation || self.pending.is_none() {
            return Err("Stale console review".into());
        }
        if self.stop.load(Ordering::SeqCst) {
            return Err("Console disconnected; close or reconnect the tab".into());
        }
        if typed.is_some() && typed.as_deref() != Some(self.config.path.as_str()) {
            return Err("Confirmation does not match; input remains held".into());
        }
        let pending = self.pending.take().expect("checked");
        self.settled = request_id;
        let bytes = if typed.is_some() { pending } else { vec![3] };
        self.port
            .write_all(&bytes)
            .map_err(|e| format!("Submission outcome uncertain; do not resend automatically: {e}"))
    }
}
#[derive(Default)]
pub struct Consoles(Mutex<HashMap<u64, Session>>, std::sync::atomic::AtomicU64);
impl Consoles {
    pub fn shutdown(&self) {
        if let Ok(mut sessions) = self.0.lock() {
            for (_, mut session) in sessions.drain() {
                session.cancel_transfer.store(true, Ordering::SeqCst);
                session.stop.store(true, Ordering::SeqCst);
                if let Some(reader) = session.reader.take() {
                    let _ = reader.join();
                }
            }
        }
    }
}
#[derive(Serialize)]
pub struct Port {
    path: String,
    label: String,
    identity: Option<String>,
}
#[tauri::command]
pub fn serial_ports() -> Result<Vec<Port>, String> {
    let mut ports: Vec<_> = serialport::available_ports()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|port| {
            let identity = match &port.port_type {
                serialport::SerialPortType::UsbPort(info) => info
                    .serial_number
                    .as_ref()
                    .filter(|s| !s.is_empty())
                    .map(|s| format!("usb:{:04x}:{:04x}:{}", info.vid, info.pid, s)),
                _ => None,
            };
            let description = match port.port_type {
                serialport::SerialPortType::UsbPort(info) => {
                    info.product.unwrap_or_else(|| "USB serial".into())
                }
                _ => "Serial port".into(),
            };
            Port {
                label: format!("{} — {}", port.port_name, description),
                path: port.port_name,
                identity,
            }
        })
        .collect();
    ports.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ports)
}
#[tauri::command]
pub fn serial_open(app: AppHandle, state: State<Consoles>, config: Config) -> Result<u64, String> {
    let builder = config.builder()?;
    let mut sessions = state.0.lock().map_err(|_| "Console state unavailable")?;
    if sessions.values().any(|s| s.config.path == config.path) {
        return Err("This device is already open in AfterTerm".into());
    }
    let port = builder
        .open()
        .map_err(|e| format!("{}: {e}", config.path))?;
    let id = state.1.fetch_add(1, Ordering::SeqCst) + 1;
    sessions.insert(
        id,
        Session {
            port,
            stop: Arc::new(AtomicBool::new(false)),
            reader: None,
            config,
            pending: None,
            generation: 0,
            settled: 0,
            output: Arc::new(Mutex::new(BootBuffer::default())),
            transferring: Arc::new(AtomicBool::new(false)),
            cancel_transfer: Arc::new(AtomicBool::new(false)),
        },
    );
    if let Err(error) = start_reader(app, sessions.get_mut(&id).ok_or("Console is closed")?, id) {
        sessions.remove(&id);
        return Err(error);
    }
    Ok(id)
}
#[derive(Clone, Serialize)]
struct Output {
    id: u64,
    data: String,
}
#[derive(Clone, Serialize)]
struct Exit {
    id: u64,
    code: u32,
}
// The reader starts at open and buffers output until listeners are attached.
#[tauri::command]
pub fn serial_attach(app: AppHandle, state: State<Consoles>, id: u64) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|_| "Console state unavailable")?;
    let session = sessions.get(&id).ok_or("Console is closed")?;
    let mut output = session
        .output
        .lock()
        .map_err(|_| "Console output unavailable")?;
    if output.attached {
        return Ok(());
    }
    if output.dropped > 0 {
        app.emit(
            "serial:output",
            Output {
                id,
                data: STANDARD.encode(format!(
                    "\r\n[{} bytes of early console output dropped]\r\n",
                    output.dropped
                )),
            },
        )
        .map_err(|e| e.to_string())?;
    }
    while let Some(chunk) = output.chunks.front() {
        app.emit(
            "serial:output",
            Output {
                id,
                data: STANDARD.encode(chunk),
            },
        )
        .map_err(|e| e.to_string())?;
        output.chunks.pop_front();
    }
    output.bytes = 0;
    output.attached = true;
    if session.stop.load(Ordering::SeqCst) {
        let _ = app.emit("serial:exit", Exit { id, code: 1 });
    }
    Ok(())
}
fn start_reader(app: AppHandle, session: &mut Session, id: u64) -> Result<(), String> {
    if session.reader.is_some() {
        return Ok(());
    }
    let mut port = session.port.try_clone().map_err(|e| e.to_string())?;
    let stop = session.stop.clone();
    let output = session.output.clone();
    session.reader = Some(std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while !stop.load(Ordering::SeqCst) {
            match port.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let Ok(mut buffer) = output.lock() else {
                        break;
                    };
                    if buffer.attached {
                        if app
                            .emit(
                                "serial:output",
                                Output {
                                    id,
                                    data: STANDARD.encode(&buf[..n]),
                                },
                            )
                            .is_err()
                        {
                            break;
                        }
                    } else {
                        buffer.push(&buf[..n]);
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                            | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    continue
                }
                Err(_) => break,
            }
        }
        stop.store(true, Ordering::SeqCst);
        let _ = app.emit("serial:exit", Exit { id, code: 1 });
    }));
    Ok(())
}
#[tauri::command]
pub fn serial_write(
    state: State<Consoles>,
    id: u64,
    data: String,
) -> Result<Option<afterterm_pty::Challenge>, String> {
    let mut sessions = state.0.lock().map_err(|_| "Console state unavailable")?;
    let session = sessions.get_mut(&id).ok_or("Console is closed")?;
    session.write(data)
}
#[tauri::command]
pub fn serial_confirm(
    state: State<Consoles>,
    id: u64,
    typed: Option<String>,
    request_id: u64,
) -> Result<(), String> {
    let mut sessions = state.0.lock().map_err(|_| "Console state unavailable")?;
    let session = sessions.get_mut(&id).ok_or("Console is closed")?;
    session.confirm(request_id, typed)
}
#[tauri::command]
pub fn serial_review(
    state: State<Consoles>,
    id: u64,
) -> Result<Option<afterterm_pty::Challenge>, String> {
    let sessions = state.0.lock().map_err(|_| "Console state unavailable")?;
    Ok(sessions.get(&id).ok_or("Console is closed")?.review())
}
#[tauri::command]
pub async fn serial_control(
    state: State<'_, Consoles>,
    id: u64,
    action: String,
    value: bool,
    duration: u64,
) -> Result<(), String> {
    let (mut port, busy, stop) = {
        let mut sessions = state.0.lock().map_err(|_| "Console state unavailable")?;
        let session = sessions.get_mut(&id).ok_or("Console is closed")?;
        if session.stop.load(Ordering::SeqCst)
            || session.pending.is_some()
            || session.transferring.load(Ordering::SeqCst)
        {
            return Err("Console disconnected or awaiting review".into());
        }
        if action == "rts" && session.config.flow_control == "hardware" {
            return Err("RTS is controlled by hardware flow control".into());
        }
        let port = session.port.try_clone().map_err(|e| e.to_string())?;
        session.transferring.store(true, Ordering::SeqCst);
        (port, session.transferring.clone(), session.stop.clone())
    };
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _guard = TransferGuard(busy);
        if stop.load(Ordering::SeqCst) {
            return Err("Console disconnected".into());
        }
        match action.as_str() {
            "break" => {
                if !(50..=2000).contains(&duration) {
                    return Err("BREAK duration must be 50–2000 ms".into());
                }
                port.set_break().map_err(|e| e.to_string())?;
                std::thread::sleep(Duration::from_millis(duration));
                port.clear_break().map_err(|e| e.to_string())
            }
            "dtr" => port
                .write_data_terminal_ready(value)
                .map_err(|e| e.to_string()),
            "rts" => port.write_request_to_send(value).map_err(|e| e.to_string()),
            "interrupt" => port.write_all(&[3]).map_err(|e| e.to_string()),
            "escape" => port.write_all(&[27]).map_err(|e| e.to_string()),
            _ => Err("Unknown console control".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Clone, Serialize)]
struct PasteProgress {
    id: u64,
    sent: usize,
    total: usize,
}
struct TransferGuard(Arc<AtomicBool>);
impl Drop for TransferGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn paced_write(
    port: &mut dyn Write,
    data: &[u8],
    char_delay: u64,
    line_delay: u64,
    cancelled: impl Fn() -> bool,
    mut progress: impl FnMut(usize),
) -> Result<(), String> {
    for (index, byte) in data.iter().enumerate() {
        if cancelled() {
            return Err("Paste cancelled; already transmitted bytes cannot be recalled".into());
        }
        port.write_all(&[*byte])
            .map_err(|e| format!("Paste stopped after {index} bytes: {e}"))?;
        progress(index + 1);
        let end_of_line = *byte == b'\n' || (*byte == b'\r' && data.get(index + 1) != Some(&b'\n'));
        let delay = char_delay + if end_of_line { line_delay } else { 0 };
        let until = std::time::Instant::now() + Duration::from_millis(delay);
        while std::time::Instant::now() < until {
            if cancelled() {
                return Err("Paste cancelled; already transmitted bytes cannot be recalled".into());
            }
            std::thread::sleep(
                Duration::from_millis(5)
                    .min(until.saturating_duration_since(std::time::Instant::now())),
            );
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn serial_paste(
    app: AppHandle,
    state: State<'_, Consoles>,
    id: u64,
    data: String,
    typed: Option<String>,
    char_delay: u64,
    line_delay: u64,
) -> Result<(), String> {
    if data.is_empty() || data.len() > 65536 || char_delay > 100 || line_delay > 2000 {
        return Err(
            "Paste must be 1–65536 bytes; delays at most 100 ms/character and 2000 ms/line".into(),
        );
    }
    if data
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\t' | '\r' | '\n'))
    {
        return Err(
            "Paste contains control characters; use explicit console controls instead".into(),
        );
    }
    let (mut port, stop, cancelled, busy) = {
        let mut sessions = state.0.lock().map_err(|_| "Console state unavailable")?;
        let session = sessions.get_mut(&id).ok_or("Console is closed")?;
        if session.stop.load(Ordering::SeqCst) || session.pending.is_some() {
            return Err("Console disconnected or awaiting review".into());
        }
        if session.config.production && typed.as_deref() != Some(session.config.path.as_str()) {
            return Err("Type the production device path to approve this paste".into());
        }
        if session.transferring.load(Ordering::SeqCst) {
            return Err("A paste is already in progress".into());
        }
        let port = session.port.try_clone().map_err(|e| e.to_string())?;
        session.cancel_transfer.store(false, Ordering::SeqCst);
        session.transferring.store(true, Ordering::SeqCst);
        (
            port,
            session.stop.clone(),
            session.cancel_transfer.clone(),
            session.transferring.clone(),
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = TransferGuard(busy);
        let mut last = std::time::Instant::now();
        paced_write(
            &mut port,
            data.as_bytes(),
            char_delay,
            line_delay,
            || stop.load(Ordering::SeqCst) || cancelled.load(Ordering::SeqCst),
            |sent| {
                if last.elapsed() >= Duration::from_millis(100) || sent == data.len() {
                    let _ = app.emit(
                        "serial:paste-progress",
                        PasteProgress {
                            id,
                            sent,
                            total: data.len(),
                        },
                    );
                    last = std::time::Instant::now();
                }
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn serial_cancel_paste(state: State<Consoles>, id: u64) -> Result<(), String> {
    let sessions = state.0.lock().map_err(|_| "Console state unavailable")?;
    let session = sessions.get(&id).ok_or("Console is closed")?;
    session.cancel_transfer.store(true, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
pub fn serial_close(state: State<Consoles>, id: u64) -> Result<(), String> {
    let session = state
        .0
        .lock()
        .map_err(|_| "Console state unavailable")?
        .remove(&id);
    if let Some(mut session) = session {
        session.cancel_transfer.store(true, Ordering::SeqCst);
        session.stop.store(true, Ordering::SeqCst);
        if let Some(reader) = session.reader.take() {
            let _ = reader.join();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn early_output_buffer_is_ordered_and_bounded() {
        let mut buffer = BootBuffer::default();
        buffer.push(b"boot\r\n");
        buffer.push(b"login:");
        assert_eq!(
            buffer.chunks.iter().flatten().copied().collect::<Vec<_>>(),
            b"boot\r\nlogin:"
        );
        for _ in 0..40 {
            buffer.push(&[1; 8192]);
        }
        assert!(buffer.bytes <= BOOT_BUFFER_LIMIT);
        assert!(buffer.dropped > 0);
    }
    #[test]
    fn paced_paste_cancels_without_sending_remaining_newline() {
        let mut output = Vec::new();
        let sent = std::cell::Cell::new(0);
        let result = paced_write(
            &mut output,
            b"abc\r",
            0,
            0,
            || sent.get() == 2,
            |n| sent.set(n),
        );
        assert!(result.is_err());
        assert_eq!(output, b"ab");
        let mut full = Vec::new();
        paced_write(&mut full, b"a\r\nb\r", 0, 0, || false, |_| {}).unwrap();
        assert_eq!(full, b"a\r\nb\r");
    }
    #[test]
    fn production_serial_holds_enter_and_cancel_discards_paste() {
        let (port, mut peer) = serialport::TTYPort::pair().unwrap();
        peer.set_timeout(Duration::from_millis(50)).unwrap();
        let config = Config {
            path: "/dev/test".into(),
            baud: 9600,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            flow_control: "none".into(),
            production: true,
        };
        let mut session = Session {
            port: Box::new(port),
            stop: Arc::new(AtomicBool::new(false)),
            reader: None,
            config,
            pending: None,
            generation: 0,
            settled: 0,
            output: Arc::new(Mutex::new(BootBuffer::default())),
            transferring: Arc::new(AtomicBool::new(false)),
            cancel_transfer: Arc::new(AtomicBool::new(false)),
        };
        assert!(session.write("show version\r".into()).unwrap().is_some());
        let mut buf = [0u8; 64];
        assert!(
            peer.read(&mut buf).is_err(),
            "unreviewed bytes must not reach device"
        );
        assert!(session.write("extra".into()).is_err());
        session
            .confirm(session.generation, Some("/dev/test".into()))
            .unwrap();
        let n = peer.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"show version\r");
        session.write("erase\rreload\r".into()).unwrap();
        session.confirm(session.generation, None).unwrap();
        let n = peer.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], &[3]);
        session
            .confirm(session.generation, Some("/dev/test".into()))
            .unwrap();
        assert!(
            peer.read(&mut buf).is_err(),
            "duplicate acknowledgement must not write again"
        );
        session.write("reload\n".into()).unwrap();
        assert!(session
            .confirm(session.generation, Some("wrong device".into()))
            .is_err());
        assert!(peer.read(&mut buf).is_err());
        assert!(session.review().is_some());
        session
            .confirm(session.generation - 1, Some("/dev/test".into()))
            .unwrap();
        assert!(
            peer.read(&mut buf).is_err(),
            "old request must not approve new input"
        );
        session.confirm(session.generation, None).unwrap();
        let n = peer.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], &[3]);
        session.config.production = false;
        session.write("show version\r".into()).unwrap();
        let n = peer.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"show version\r");
        peer.write_all(b"console output\r\n").unwrap();
        let n = session.port.read(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"console output\r\n");
        session.cancel_transfer.store(true, Ordering::SeqCst);
        session.stop.store(true, Ordering::SeqCst);
        assert!(session.write("x".into()).is_err());
    }
    #[test]
    fn validates_console_settings_before_open() {
        let mut config = Config {
            path: "/dev/cu.usbserial-test".into(),
            baud: 9600,
            data_bits: 8,
            parity: "none".into(),
            stop_bits: 1,
            flow_control: "none".into(),
            production: true,
        };
        assert!(config.builder().is_ok());
        config.baud = 0;
        assert!(config.builder().is_err());
        config.baud = 115200;
        config.parity = "invalid".into();
        assert!(config.builder().is_err());
        config.parity = "even".into();
        config.path = "/tmp/file".into();
        assert!(config.builder().is_err());
    }
}
