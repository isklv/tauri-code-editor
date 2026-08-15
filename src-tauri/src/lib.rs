use std::sync::mpsc;

use tauri::{Emitter, Manager, State};
use tokio::sync::Mutex;

#[cfg(target_os = "android")]
use tauri_plugin_shell::process::Command;

// ── Terminal state ──

struct TerminalState {
    // In a real implementation, this would hold PTY connections
    // For Android, we'd use a shell process via tauri-plugin-shell
    _private: (),
}

impl TerminalState {
    fn new() -> Self {
        Self { _private: () }
    }
}

// ── Tauri commands ──

#[tauri::command]
async fn write_terminal(
    data: String,
    _terminal: State<'_, Mutex<TerminalState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // In the real implementation, this writes to the PTY
    // and the PTY output is sent back via the `terminal_output` event
    //
    // For now, we echo back (for demo purposes)
    app.emit("terminal_output", &format!("[echo] {}", data.trim_end()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_file_dialog(
    _dialog: State<'_, Mutex<TerminalState>>,
) -> Result<String, String> {
    // This would use tauri-plugin-dialog in the real implementation
    Ok(String::new())
}

// ── Setup ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(Mutex::new(TerminalState::new()));

            // On Android, we might want to start a shell process
            #[cfg(target_os = "android")]
            {
                // Initialize shell for terminal
                // This would connect to Termux or a built-in shell
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![write_terminal, open_file_dialog])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
