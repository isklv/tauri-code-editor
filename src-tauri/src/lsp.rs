//! Language Server Protocol (LSP) backend manager.
//!
//! Spawns and manages stdio-based language servers (gopls, pyright, rust-analyzer, etc.)
//! both on the host system and within the Alpine Linux PRoot environment.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::linux_env;

#[derive(Serialize, Clone, Debug)]
pub struct LspMessagePayload {
    pub lang: String,
    pub message: String,
}

pub struct LspSession {
    stdin: ChildStdin,
    child: Child,
}

#[derive(Default)]
pub struct LspManager {
    sessions: Mutex<HashMap<String, LspSession>>,
}

impl LspManager {
    pub fn kill_all(&self) {
        let mut map = self.sessions.lock().unwrap();
        for (_, mut session) in map.drain() {
            let _ = session.child.kill();
            let _ = session.child.wait();
        }
    }
}

/// Information about a language server executable and its arguments.
struct ServerSpec {
    binary: &'static str,
    args: &'static [&'static str],
    guest_locations: &'static [&'static str],
}

fn get_server_spec(lang: &str) -> Option<ServerSpec> {
    match lang {
        "go" => Some(ServerSpec {
            binary: "gopls",
            args: &[],
            guest_locations: &["/root/go/bin/gopls", "/usr/local/bin/gopls", "/usr/bin/gopls"],
        }),
        "python" => Some(ServerSpec {
            binary: "pyright-langserver",
            args: &["--stdio"],
            guest_locations: &[
                "/usr/bin/pyright-langserver",
                "/usr/local/bin/pyright-langserver",
                "/root/.local/bin/pyright-langserver",
                "/usr/bin/pylsp",
            ],
        }),
        "rust" => Some(ServerSpec {
            binary: "rust-analyzer",
            args: &[],
            guest_locations: &[
                "/root/.cargo/bin/rust-analyzer",
                "/usr/bin/rust-analyzer",
                "/usr/local/bin/rust-analyzer",
            ],
        }),
        "typescript" | "javascript" => Some(ServerSpec {
            binary: "typescript-language-server",
            args: &["--stdio"],
            guest_locations: &[
                "/usr/bin/typescript-language-server",
                "/usr/local/bin/typescript-language-server",
                "/root/.bun/bin/typescript-language-server",
            ],
        }),
        _ => None,
    }
}

/// Find if a binary is executable on the host PATH.
fn find_host_binary(name: &str) -> Option<PathBuf> {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let full = dir.join(name);
            if full.is_file() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Ok(meta) = full.metadata() {
                        if meta.permissions().mode() & 0o111 != 0 {
                            return Some(full);
                        }
                    }
                }
                #[cfg(not(unix))]
                return Some(full);
            }
        }
    }
    None
}

/// Spawn the language server process either on the host or inside Alpine PRoot.
fn spawn_server(
    app: &AppHandle,
    lang: &str,
    cwd: Option<&str>,
) -> Result<Child, String> {
    let spec = get_server_spec(lang)
        .ok_or_else(|| format!("No language server specification for '{lang}'"))?;

    // 1. Check host PATH first
    if let Some(host_bin) = find_host_binary(spec.binary) {
        let mut cmd = Command::new(host_bin);
        cmd.args(spec.args);
        if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
            cmd.current_dir(dir);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        return cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn host {} for {lang}: {e}", spec.binary));
    }

    // 2. Check Alpine PRoot guest rootfs
    if let Ok((_proot, rootfs)) = linux_env::ready_paths(app).ok_or("Alpine not available") {
        // Find if server exists in guest locations
        for &guest_path in spec.guest_locations {
            let host_target = rootfs.join(guest_path.trim_start_matches('/'));
            if host_target.is_file() {
                if let Some(mut cmd) = linux_env::proot_command(app, cwd) {
                    cmd.arg(guest_path);
                    cmd.args(spec.args);
                    cmd.stdin(Stdio::piped())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::null());
                    return cmd.spawn().map_err(|e| {
                        format!("Failed to spawn Alpine {} for {lang}: {e}", spec.binary)
                    });
                }
            }
        }

        // Try direct proot execution of the command name (letting guest PATH resolve it)
        if let Some(mut cmd) = linux_env::proot_command(app, cwd) {
            cmd.arg(spec.binary);
            cmd.args(spec.args);
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            if let Ok(child) = cmd.spawn() {
                return Ok(child);
            }
        }
    }

    Err(format!(
        "Language server '{}' is not installed. You can install it via the terminal (e.g. apk add {}).",
        spec.binary,
        match lang {
            "go" => "go (and go install golang.org/x/tools/gopls@latest)",
            "python" => "pyright or python3 -m pip install python-lsp-server",
            "rust" => "rust-analyzer",
            _ => spec.binary,
        }
    ))
}

/// Read a single LSP JSON-RPC message from an input stream according to the LSP specification.
fn read_lsp_message<R: BufRead>(reader: &mut R) -> std::io::Result<Option<String>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None); // EOF
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            // Blank line terminates header section
            break;
        }
        if let Some(val) = trimmed.strip_prefix("Content-Length:") {
            if let Ok(len) = val.trim().parse::<usize>() {
                content_length = Some(len);
            }
        }
    }

    match content_length {
        Some(len) => {
            let mut buf = vec![0u8; len];
            reader.read_exact(&mut buf)?;
            let msg = String::from_utf8(buf)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            Ok(Some(msg))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn lsp_start(
    app: AppHandle,
    state: State<'_, Arc<LspManager>>,
    lang: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if sessions.contains_key(&lang) {
        return Ok(()); // Already running
    }

    let mut child = spawn_server(&app, &lang, cwd.as_deref())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open child stdin for LSP".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open child stdout for LSP".to_string())?;

    sessions.insert(lang.clone(), LspSession { stdin, child });

    // Spawn reader thread for LSP stdout
    let emitter = app.clone();
    let lang_clone = lang.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some(msg)) = read_lsp_message(&mut reader) {
            if emitter
                .emit(
                    "lsp://message",
                    LspMessagePayload {
                        lang: lang_clone.clone(),
                        message: msg,
                    },
                )
                .is_err()
            {
                break;
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn lsp_send(
    state: State<'_, Arc<LspManager>>,
    lang: String,
    payload: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&lang)
        .ok_or_else(|| format!("LSP server for '{lang}' is not running"))?;

    let header = format!("Content-Length: {}\r\n\r\n", payload.len());
    session
        .stdin
        .write_all(header.as_bytes())
        .map_err(|e| format!("Failed to write LSP header: {e}"))?;
    session
        .stdin
        .write_all(payload.as_bytes())
        .map_err(|e| format!("Failed to write LSP payload: {e}"))?;
    session
        .stdin
        .flush()
        .map_err(|e| format!("Failed to flush LSP stdin: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn lsp_stop(
    state: State<'_, Arc<LspManager>>,
    lang: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(mut session) = sessions.remove(&lang) {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}

#[tauri::command]
pub fn lsp_supported(
    app: AppHandle,
    lang: String,
) -> Result<bool, String> {
    let spec = match get_server_spec(&lang) {
        Some(s) => s,
        None => return Ok(false),
    };

    if find_host_binary(spec.binary).is_some() {
        return Ok(true);
    }

    if let Ok((_proot, rootfs)) = linux_env::ready_paths(&app).ok_or("Alpine not available") {
        for &guest_path in spec.guest_locations {
            let host_target = rootfs.join(guest_path.trim_start_matches('/'));
            if host_target.is_file() {
                return Ok(true);
            }
        }
    }

    Ok(false)
}
