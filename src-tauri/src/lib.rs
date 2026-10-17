mod files;
mod launch;
mod prefs;
mod serial;
mod ssh;
use serial::{
    serial_attach, serial_cancel_paste, serial_close, serial_confirm, serial_control, serial_open,
    serial_paste, serial_ports, serial_review, serial_write,
};
use ssh::ssh_algorithms;

use std::path::PathBuf;
use std::sync::Arc;

use afterterm_pty::session::{
    HoldResolution, LogStatus, SessionDetails, SessionId, SessionInfo, SessionManager, Signal,
    Sink, SpawnOpts, WriteOutcome,
};
use afterterm_pty::Challenge;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Serialize;
use std::io::Write as _;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

struct AppSink {
    app: AppHandle,
}

#[derive(Clone, Serialize)]
struct OutputEvent {
    id: u64,
    data: String,
    sequence: u64,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    id: u64,
    code: u32,
}

#[derive(Clone, Serialize)]
struct ChallengeEvent {
    id: u64,
    challenge: Challenge,
}

impl Sink for AppSink {
    fn output(&self, id: SessionId, sequence: u64, chunk: &[u8]) {
        let _ = self.app.emit(
            "pty:output",
            OutputEvent {
                id: id.0,
                data: B64.encode(chunk),
                sequence,
            },
        );
    }

    fn exit(&self, id: SessionId, code: u32) {
        let _ = self.app.emit("pty:exit", ExitEvent { id: id.0, code });
    }

    fn challenge(&self, id: SessionId, challenge: Challenge) {
        let _ = self.app.emit(
            "pty:challenge",
            ChallengeEvent {
                id: id.0,
                challenge,
            },
        );
    }
}

pub struct PtyHandle(pub Arc<SessionManager>);
struct LaunchArgs(Vec<String>);

#[tauri::command]
fn launch_args(state: State<LaunchArgs>) -> Vec<String> {
    state.0.clone()
}

fn session_id(id: u64) -> SessionId {
    SessionId(id)
}

#[tauri::command]
fn pty_spawn(
    state: State<PtyHandle>,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    sah_args: Option<Vec<String>>,
) -> Result<u64, String> {
    let cwd = cwd.map(PathBuf::from);
    let args = sah_args.unwrap_or_default();
    let program = if args.is_empty() {
        None
    } else {
        Some(
            launch::sah_binary()?
                .to_str()
                .ok_or("SAH client path is not UTF-8")?
                .to_owned(),
        )
    };
    let id = state.0.spawn_with_args(
        SpawnOpts { rows, cols, cwd, program },
        &args,
    )?;
    Ok(id.0)
}

#[tauri::command]
async fn pty_write(
    state: State<'_, PtyHandle>,
    id: u64,
    data: String,
) -> Result<Option<Challenge>, String> {
    let id = session_id(id);
    match state.0.write(id, &data)? {
        WriteOutcome::Written => Ok(None),
        WriteOutcome::Held { line, generation } => {
            let manager = Arc::clone(&state.0);
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                manager.resolve_hold_line(id, generation, &line)
            })
            .await
            .map_err(|e| e.to_string())??;
            match outcome {
                HoldResolution::Released => Ok(None),
                HoldResolution::Challenge(challenge) => Ok(Some(challenge)),
            }
        }
    }
}

#[tauri::command]
async fn pty_confirm(
    state: State<'_, PtyHandle>,
    id: u64,
    request_id: u64,
    typed: Option<String>,
) -> Result<(), String> {
    let id = session_id(id);
    let manager = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || manager.confirm(id, request_id, typed.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    Ok(())
}

#[tauri::command]
fn pty_resize(state: State<PtyHandle>, id: u64, rows: u16, cols: u16) -> Result<(), String> {
    state.0.resize(session_id(id), rows, cols)
}

#[tauri::command]
fn pty_kill(state: State<PtyHandle>, id: u64) -> Result<(), String> {
    state.0.kill(session_id(id))
}

#[tauri::command]
fn pty_list(state: State<PtyHandle>) -> Result<Vec<SessionInfo>, String> {
    state.0.list()
}

#[tauri::command]
fn pty_set_title(state: State<PtyHandle>, id: u64, title: String) -> Result<(), String> {
    state.0.set_title(session_id(id), title)
}

#[tauri::command]
fn pty_attach(
    state: State<PtyHandle>,
    id: u64,
) -> Result<afterterm_pty::session::Snapshot, String> {
    state.0.snapshot(session_id(id))
}
#[tauri::command]
fn pty_review(state: State<PtyHandle>, id: u64) -> Result<Option<Challenge>, String> {
    state.0.pending(session_id(id))
}
#[tauri::command]
fn pty_set_reviewed(
    state: State<PtyHandle>,
    id: u64,
    reviewed: bool,
    typed: Option<String>,
) -> Result<(), String> {
    state
        .0
        .set_reviewed(session_id(id), reviewed, typed.as_deref())
}

#[tauri::command]
fn pty_info(state: State<PtyHandle>, id: u64) -> Result<SessionDetails, String> {
    state.0.details(session_id(id))
}

#[tauri::command]
fn pty_signal(state: State<PtyHandle>, id: u64, signal: String) -> Result<String, String> {
    state.0.signal(session_id(id), Signal::parse(&signal)?)
}

/// Folders AfterTerm owns (config, data, logs, cache); user saves and logs are never written inside them.
fn protected_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let path = app.path();
    [
        path.app_config_dir(),
        path.app_data_dir(),
        path.app_local_data_dir(),
        path.app_log_dir(),
        path.app_cache_dir(),
    ]
        .into_iter()
        .filter_map(Result::ok)
        .collect()
}

/// Run the native save dialog in Rust. The webview only suggests a file name;
/// it never supplies the path that is written.
async fn choose_save_path(
    app: &AppHandle,
    window: &tauri::Window,
    suggested: &str,
    label: &str,
    extension: &str,
) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let dialog = app
        .dialog()
        .file()
        .set_parent(window)
        .set_can_create_directories(true)
        .set_file_name(files::safe_file_name(suggested, extension))
        .add_filter(label, &[extension]);
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_save_file())
        .await
        .map_err(|e| e.to_string())?;
    match picked {
        None => Ok(None),
        Some(path) => path.into_path().map(Some).map_err(|e| e.to_string()),
    }
}

#[tauri::command]
async fn save_text_file(
    app: AppHandle,
    window: tauri::Window,
    kind: String,
    suggested_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    if contents.len() > files::MAX_SAVE_BYTES {
        return Err("The text is larger than 64 MiB; reduce scrollback or save a selection".into());
    }
    let (label, extension) = match kind.as_str() {
        "transcript" | "selection" => ("Plain text", "txt"),
        "html" => ("HTML document", "html"),
        _ => return Err(format!("Unknown save kind: {kind}")),
    };
    let Some(path) = choose_save_path(&app, &window, &suggested_name, label, extension).await? else {
        return Ok(None);
    };
    let mut file = files::open_for_write(&path, &protected_dirs(&app), false)?;
    file.write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
async fn pty_log_start(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, PtyHandle>,
    id: u64,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let Some(path) = choose_save_path(&app, &window, &suggested_name, "Session log", "log").await? else {
        return Ok(None);
    };
    let file = files::open_for_write(&path, &protected_dirs(&app), true)?;
    let shown = path.display().to_string();
    state.0.start_log(session_id(id), file, shown.clone())?;
    Ok(Some(shown))
}

#[tauri::command]
fn pty_log_stop(state: State<PtyHandle>, id: u64) -> Result<Option<LogStatus>, String> {
    state.0.stop_log(session_id(id))
}

#[tauri::command]
fn print_page(window: tauri::WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

#[tauri::command]
fn prefs_load(app: AppHandle) -> Result<prefs::Prefs, String> {
    prefs::load(&app)
}

#[tauri::command]
fn prefs_save(app: AppHandle, prefs: prefs::Prefs) -> Result<(), String> {
    prefs::save(&app, &prefs)
}

fn apply_window_effects(app: &tauri::App) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri::window::{Effect, EffectState, EffectsBuilder};
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_effects(
                EffectsBuilder::new()
                    .effect(Effect::HudWindow)
                    .state(EffectState::Active)
                    .radius(10.0)
                    .build(),
            );
        }
    }
    let _ = app;
    Ok(())
}

/// Menu accelerators off macOS, keyed by the macOS accelerator written in install_menu.
/// CmdOrCtrl would be Control there, and Control+letter belongs to the shell (^C, ^A, ^P, ^W...);
/// GTK can run a menu accelerator before the web view sees the key, which would take those keys
/// away from the terminal. Letter shortcuts therefore use Control+Shift (the terminal convention),
/// and where that collides with an existing Control+Shift shortcut, Alt is added as well.
/// Must match OTHER_BINDINGS in src/keybindings.ts (checked by npm test).
const OTHER_ACCELERATORS: &[(&str, &str)] = &[
    ("CmdOrCtrl+,", "Ctrl+,"),
    ("CmdOrCtrl+T", "Ctrl+Shift+T"),
    ("CmdOrCtrl+W", "Ctrl+Shift+W"),
    ("CmdOrCtrl+S", "Ctrl+Shift+S"),
    ("CmdOrCtrl+Shift+S", "Ctrl+Shift+Alt+S"),
    ("CmdOrCtrl+Alt+S", "Ctrl+Shift+Alt+H"),
    ("CmdOrCtrl+Shift+L", "Ctrl+Shift+L"),
    ("CmdOrCtrl+P", "Ctrl+Shift+P"),
    ("CmdOrCtrl+X", "Ctrl+Shift+X"),
    ("CmdOrCtrl+C", "Ctrl+Shift+C"),
    ("CmdOrCtrl+V", "Ctrl+Shift+V"),
    ("CmdOrCtrl+A", "Ctrl+Shift+A"),
    ("CmdOrCtrl+Shift+A", "Ctrl+Shift+Alt+A"),
    ("CmdOrCtrl+F", "Ctrl+Shift+F"),
    ("CmdOrCtrl+Shift+E", "Ctrl+Shift+E"),
    ("CmdOrCtrl+K", "Ctrl+Shift+K"),
    ("CmdOrCtrl+Alt+R", "Ctrl+Shift+Alt+R"),
    ("Ctrl+Shift+C", "Ctrl+Shift+Alt+C"),
    ("CmdOrCtrl+Shift+R", "Ctrl+Shift+R"),
    ("CmdOrCtrl+Shift+H", "Ctrl+Shift+H"),
    ("CmdOrCtrl+Shift+O", "Ctrl+Shift+O"),
    ("CmdOrCtrl+Shift+K", "Ctrl+Shift+Alt+K"),
    ("CmdOrCtrl+I", "Ctrl+Shift+I"),
    ("CmdOrCtrl+=", "Ctrl+="),
    ("CmdOrCtrl+-", "Ctrl+-"),
    ("CmdOrCtrl+0", "Ctrl+0"),
    ("CmdOrCtrl+Shift+]", "Ctrl+Shift+]"),
    ("CmdOrCtrl+Shift+[", "Ctrl+Shift+["),
];

/// The accelerator to register on this platform. Off macOS an accelerator missing from
/// OTHER_ACCELERATORS is dropped rather than registered, so it can never take a shell key.
fn platform_accelerator(accelerator: &str, macos: bool) -> Option<&str> {
    if macos {
        return Some(accelerator);
    }
    OTHER_ACCELERATORS
        .iter()
        .find(|(mac, _)| *mac == accelerator)
        .map(|(_, other)| *other)
}

fn item(
    handle: &AppHandle,
    id: &str,
    label: &str,
    accelerator: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<tauri::Wry>> {
    let accelerator =
        accelerator.and_then(|value| platform_accelerator(value, cfg!(target_os = "macos")));
    tauri::menu::MenuItem::with_id(handle, id, label, true, accelerator)
}

/// Every custom item is routed to the webview as an "afterterm:menu" event with its id.
/// Accelerators must match DEFAULT_BINDINGS (macOS) and, through OTHER_ACCELERATORS,
/// OTHER_BINDINGS in src/keybindings.ts (checked by npm test).
fn install_menu(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{AboutMetadata, Menu, PredefinedMenuItem, Submenu};
    let handle = app.handle();
    let sep = || PredefinedMenuItem::separator(handle);

    let about = PredefinedMenuItem::about(
        handle,
        Some("About AfterTerm"),
        Some(AboutMetadata {
            name: Some("AfterTerm".into()),
            version: Some(env!("CARGO_PKG_VERSION").into()),
            ..Default::default()
        }),
    )?;
    let app_menu = Submenu::with_items(
        handle,
        "AfterTerm",
        true,
        &[
            &about,
            &sep()?,
            &item(handle, "app.prefs", "Preferences…", Some("CmdOrCtrl+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(handle, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::hide_others(handle, None)?,
            &PredefinedMenuItem::show_all(handle, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(handle, Some("Quit AfterTerm"))?,
        ],
    )?;
    let file = Submenu::with_id_and_items(
        handle,
        "file",
        "File",
        true,
        &[
            &item(handle, "file.new-tab", "New Tab", Some("CmdOrCtrl+T"))?,
            &item(handle, "file.close-tab", "Close Tab", Some("CmdOrCtrl+W"))?,
            &sep()?,
            &item(handle, "file.save-transcript", "Save Transcript…", Some("CmdOrCtrl+S"))?,
            &item(handle, "file.save-selection", "Save Selection…", Some("CmdOrCtrl+Shift+S"))?,
            &item(handle, "file.export-html", "Export Transcript as HTML…", Some("CmdOrCtrl+Alt+S"))?,
            &item(handle, "file.log-session", "Log Session to File… (toggle)", Some("CmdOrCtrl+Shift+L"))?,
            &sep()?,
            &item(handle, "file.print", "Print Transcript…", Some("CmdOrCtrl+P"))?,
        ],
    )?;
    let edit = Submenu::with_id_and_items(
        handle,
        "edit",
        "Edit",
        true,
        &[
            &item(handle, "edit.cut", "Cut", Some("CmdOrCtrl+X"))?,
            &item(handle, "edit.copy", "Copy", Some("CmdOrCtrl+C"))?,
            &item(handle, "edit.paste", "Paste", Some("CmdOrCtrl+V"))?,
            &item(handle, "edit.select-all", "Select All", Some("CmdOrCtrl+A"))?,
            &item(handle, "edit.clear-selection", "Clear Selection", Some("CmdOrCtrl+Shift+A"))?,
            &sep()?,
            &item(handle, "edit.find", "Find…", Some("CmdOrCtrl+F"))?,
            &item(handle, "edit.explain", "Explain Selection", Some("CmdOrCtrl+Shift+E"))?,
        ],
    )?;
    let signals = Submenu::with_id_and_items(
        handle,
        "shell.signals",
        "Send Signal",
        true,
        &[
            &item(handle, "shell.signal-int", "Interrupt (SIGINT)", None)?,
            &item(handle, "shell.signal-tstp", "Suspend (SIGTSTP)", None)?,
            &item(handle, "shell.signal-quit", "Quit (SIGQUIT)", None)?,
            &item(handle, "shell.signal-hup", "Hang Up (SIGHUP)", None)?,
            &item(handle, "shell.signal-term", "Terminate (SIGTERM)", None)?,
        ],
    )?;
    let shell = Submenu::with_id_and_items(
        handle,
        "shell",
        "Shell",
        true,
        &[
            &item(handle, "shell.clear", "Clear Scrollback", Some("CmdOrCtrl+K"))?,
            &item(handle, "shell.reset", "Reset Terminal (sends stty sane)", Some("CmdOrCtrl+Alt+R"))?,
            &item(handle, "shell.stty-show", "Show Terminal Settings (sends stty -a)", None)?,
            &sep()?,
            &item(handle, "shell.interrupt", "Send Control-C", Some("Ctrl+Shift+C"))?,
            &signals,
            &sep()?,
            &item(handle, "shell.toggle-review", "Toggle Submission Review", Some("CmdOrCtrl+Shift+R"))?,
            &sep()?,
            &item(handle, "shell.connect-sah", "Connect SAH…", Some("CmdOrCtrl+Shift+H"))?,
            &item(handle, "shell.connect-console", "Connect Serial Console…", Some("CmdOrCtrl+Shift+O"))?,
            &item(handle, "shell.ssh-compat", "SSH Compatibility…", Some("CmdOrCtrl+Shift+K"))?,
        ],
    )?;
    let view = Submenu::with_id_and_items(
        handle,
        "view",
        "View",
        true,
        &[
            &item(handle, "view.session-info", "Session Info…", Some("CmdOrCtrl+I"))?,
            &sep()?,
            &item(handle, "view.font-larger", "Bigger Text", Some("CmdOrCtrl+="))?,
            &item(handle, "view.font-smaller", "Smaller Text", Some("CmdOrCtrl+-"))?,
            &item(handle, "view.font-reset", "Default Text Size", Some("CmdOrCtrl+0"))?,
            &sep()?,
            &item(handle, "view.prefs", "Preferences and Themes…", None)?,
        ],
    )?;
    let window = Submenu::with_id_and_items(
        handle,
        "window",
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &sep()?,
            &item(handle, "window.next-tab", "Next Tab", Some("CmdOrCtrl+Shift+]"))?,
            &item(handle, "window.prev-tab", "Previous Tab", Some("CmdOrCtrl+Shift+["))?,
        ],
    )?;
    let menu = Menu::with_items(handle, &[&app_menu, &file, &edit, &shell, &view, &window])?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_gui(vec![])
}

pub fn launch_cli() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|s| s == "--help" || s == "-h") {
        print!("{}", launch::HELP);
        return Ok(());
    }
    let (mode, args) = launch::select(args, launch::load_config()?.default_mode);
    if mode == launch::Mode::Console {
        #[cfg(unix)]
        return launch::console(args);
        #[cfg(not(unix))]
        return Err("Console mode requires macOS or Linux".into());
    }
    let args = args.into_iter()
        .map(|s| s.into_string().map_err(|_| "GUI arguments must be UTF-8".to_string()))
        .collect::<Result<Vec<_>, _>>()?;
    run_gui(args);
    Ok(())
}

fn run_gui(args: Vec<String>) {
    tauri::Builder::default()
        .manage(LaunchArgs(args))
        .setup(|app| {
            let sink = Arc::new(AppSink {
                app: app.handle().clone(),
            });
            app.manage(serial::Consoles::default());
            app.manage(PtyHandle(Arc::new(SessionManager::new(sink))));
            apply_window_effects(app).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            install_menu(app)?;
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            launch_args,
            serial_ports,
            serial_open,
            serial_attach,
            serial_write,
            serial_confirm,
            serial_close,
            serial_control,
            serial_paste,
            serial_cancel_paste,
            serial_review,
            ssh_algorithms,
            pty_spawn,
            pty_write,
            pty_confirm,
            pty_resize,
            pty_kill,
            pty_list,
            pty_set_title,
            pty_attach,
            pty_review,
            pty_set_reviewed,
            pty_info,
            pty_signal,
            pty_log_start,
            pty_log_stop,
            save_text_file,
            print_page,
            prefs_load,
            prefs_save
        ])
        .on_menu_event(|app, event| {
            let _ = app.emit("afterterm:menu", event.id().0.to_string());
        })
        .build(tauri::generate_context!())
        .expect("error while building AfterTerm")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(consoles) = app.try_state::<serial::Consoles>() {
                    consoles.shutdown();
                }
                if let Some(handle) = app.try_state::<PtyHandle>() {
                    handle.0.shutdown();
                }
            }
        });
}

#[cfg(test)]
mod registration_tests {
    #[test]
    fn every_command_is_registered() {
        let lib = include_str!("lib.rs");
        let start = lib
            .find("generate_handler![")
            .expect("generate_handler! block");
        let end = start + lib[start..].find(']').expect("end of handler list");
        let handler = &lib[start..end];
        for name in [
            "launch_args",
            "ssh_algorithms",
            "serial_ports",
            "serial_open",
            "serial_attach",
            "serial_write",
            "serial_confirm",
            "serial_close",
            "serial_control",
            "serial_paste",
            "serial_cancel_paste",
            "serial_review",
            "pty_spawn",
            "pty_write",
            "pty_confirm",
            "pty_resize",
            "pty_kill",
            "pty_list",
            "pty_set_title",
            "pty_attach",
            "pty_review",
            "pty_set_reviewed",
            "pty_info",
            "pty_signal",
            "pty_log_start",
            "pty_log_stop",
            "save_text_file",
            "print_page",
            "prefs_load",
            "prefs_save",
        ] {
            assert!(handler.contains(name), "{name} is not registered");
        }
    }
}

#[cfg(test)]
mod accelerator_tests {
    use super::{platform_accelerator, OTHER_ACCELERATORS};
    use std::collections::HashSet;

    /// Every Some("...") accelerator written in install_menu.
    fn menu_accelerators() -> Vec<&'static str> {
        let lib = include_str!("lib.rs");
        let start = lib.find("fn install_menu").expect("install_menu");
        let end = start + lib[start..].find("\n}\n").expect("end of install_menu");
        lib[start..end]
            .split("Some(\"")
            .skip(1)
            .filter_map(|rest| rest.split_once("\")").map(|(value, _)| value))
            .filter(|value| value.contains('+'))
            .collect()
    }

    #[test]
    fn macos_keeps_the_written_accelerator() {
        assert_eq!(platform_accelerator("CmdOrCtrl+C", true), Some("CmdOrCtrl+C"));
        assert_eq!(platform_accelerator("Ctrl+Shift+C", true), Some("Ctrl+Shift+C"));
    }

    #[test]
    fn other_platforms_move_letters_to_control_shift() {
        assert_eq!(platform_accelerator("CmdOrCtrl+C", false), Some("Ctrl+Shift+C"));
        assert_eq!(platform_accelerator("CmdOrCtrl+A", false), Some("Ctrl+Shift+A"));
        assert_eq!(platform_accelerator("CmdOrCtrl+P", false), Some("Ctrl+Shift+P"));
        assert_eq!(platform_accelerator("CmdOrCtrl+Shift+S", false), Some("Ctrl+Shift+Alt+S"));
        assert_eq!(platform_accelerator("Ctrl+Shift+C", false), Some("Ctrl+Shift+Alt+C"));
        assert_eq!(platform_accelerator("CmdOrCtrl+=", false), Some("Ctrl+="));
        assert_eq!(platform_accelerator("CmdOrCtrl+Q", false), None);
    }

    #[test]
    fn every_menu_accelerator_has_an_other_platform_entry() {
        let accelerators = menu_accelerators();
        assert!(accelerators.len() >= 25, "parsed {accelerators:?}");
        for accelerator in accelerators {
            assert!(
                platform_accelerator(accelerator, false).is_some(),
                "{accelerator} has no OTHER_ACCELERATORS entry"
            );
        }
    }

    #[test]
    fn other_platform_accelerators_never_take_a_shell_control_key() {
        let mut macs = HashSet::new();
        let mut others = HashSet::new();
        for (mac, other) in OTHER_ACCELERATORS {
            assert!(macs.insert(*mac), "{mac} listed twice");
            assert!(others.insert(*other), "{other} used twice");
            let parts: Vec<&str> = other.split('+').collect();
            let key = parts.last().expect("key");
            assert!(!parts.contains(&"CmdOrCtrl"), "{other} must name Ctrl explicitly");
            if key.len() == 1 && key.chars().all(|c| c.is_ascii_alphabetic()) {
                assert!(parts.contains(&"Shift"), "{other} would take Control+{key} from the shell");
            }
        }
    }
}
