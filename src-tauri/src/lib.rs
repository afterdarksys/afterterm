mod prefs;

use std::path::PathBuf;
use std::sync::Arc;

use afterterm_pty::session::{HoldResolution, SessionId, SessionInfo, SessionManager, Sink, SpawnOpts, WriteOutcome};
use afterterm_pty::{gather, ActiveContext, Challenge};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

struct AppSink {
    app: AppHandle,
}

#[derive(Clone, Serialize)]
struct OutputEvent {
    id: u64,
    data: String,
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
    fn output(&self, id: SessionId, chunk: &[u8]) {
        let _ = self.app.emit(
            "pty:output",
            OutputEvent {
                id: id.0,
                data: B64.encode(chunk),
            },
        );
    }

    fn exit(&self, id: SessionId, code: u32) {
        if let Some(handle) = self.app.try_state::<PtyHandle>() {
            let _ = handle.0.mark_exited(id);
        }
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

fn session_id(id: u64) -> SessionId {
    SessionId(id)
}

#[tauri::command]
fn pty_spawn(state: State<PtyHandle>, rows: u16, cols: u16, cwd: Option<String>) -> Result<u64, String> {
    let cwd = cwd.map(PathBuf::from);
    let id = state.0.spawn(SpawnOpts {
        rows,
        cols,
        cwd,
        program: None,
    })?;
    Ok(id.0)
}

#[tauri::command]
async fn pty_write(state: State<'_, PtyHandle>, id: u64, data: String) -> Result<(), String> {
    let id = session_id(id);
    match state.0.write(id, &data)? {
        WriteOutcome::Written => Ok(()),
        WriteOutcome::Held { line, generation } => {
            let manager = Arc::clone(&state.0);
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                manager.resolve_hold_line(id, generation, &line)
            })
            .await
            .map_err(|e| e.to_string())??;
            match outcome {
                HoldResolution::Released | HoldResolution::Challenge(_) => Ok(()),
            }
        }
    }
}

#[tauri::command]
async fn pty_confirm(state: State<'_, PtyHandle>, id: u64, typed: Option<String>) -> Result<(), String> {
    let id = session_id(id);
    let manager = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || manager.confirm(id, typed.as_deref()))
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
fn pty_context(state: State<PtyHandle>, id: Option<u64>) -> Result<ActiveContext, String> {
    let cwd = match id {
        Some(id) => Some(state.0.cwd(session_id(id))?),
        None => None,
    };
    Ok(gather(cwd.as_deref()))
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

fn install_menu(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
    let handle = app.handle();
    let new_tab = MenuItem::with_id(handle, "term.new-tab", "New Tab", true, Some("CmdOrCtrl+T"))?;
    let close_tab = MenuItem::with_id(handle, "term.close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let clear = MenuItem::with_id(handle, "term.clear", "Clear Scrollback", true, Some("CmdOrCtrl+K"))?;
    let interrupt = MenuItem::with_id(handle, "term.interrupt", "Interrupt", true, Some("Ctrl+Shift+C"))?;
    let prefs = MenuItem::with_id(handle, "term.prefs", "Preferences…", true, Some("CmdOrCtrl+,"))?;
    let find = MenuItem::with_id(handle, "term.find", "Find", true, Some("CmdOrCtrl+F"))?;
    let explain = MenuItem::with_id(handle, "term.explain", "Explain Selection", true, None::<&str>)?;

    let shell = Submenu::with_id_and_items(
        handle,
        "shell",
        "Shell",
        true,
        &[&new_tab, &close_tab, &PredefinedMenuItem::separator(handle)?, &clear, &interrupt],
    )?;
    let edit = Submenu::with_id_and_items(
        handle,
        "edit",
        "Edit",
        true,
        &[
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &find,
            &explain,
        ],
    )?;
    let view = Submenu::with_id_and_items(handle, "view", "View", true, &[&prefs])?;
    let window = Submenu::with_id_and_items(
        handle,
        "window",
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::maximize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;
    let menu = Menu::with_items(handle, &[&shell, &edit, &view, &window])?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let sink = Arc::new(AppSink {
                app: app.handle().clone(),
            });
            app.manage(PtyHandle(Arc::new(SessionManager::new(sink))));
            apply_window_effects(app).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            install_menu(app)?;
            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_confirm,
            pty_resize,
            pty_kill,
            pty_list,
            pty_set_title,
            pty_context,
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
        let start = lib.find("generate_handler![").expect("generate_handler! block");
        let end = start + lib[start..].find(']').expect("end of handler list");
        let handler = &lib[start..end];
        for name in [
            "pty_spawn",
            "pty_write",
            "pty_confirm",
            "pty_resize",
            "pty_kill",
            "pty_list",
            "pty_set_title",
            "pty_context",
            "prefs_load",
            "prefs_save",
        ] {
            assert!(handler.contains(name), "{name} is not registered");
        }
    }
}
