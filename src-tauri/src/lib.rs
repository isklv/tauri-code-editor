use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{recommended_watcher, Event, RecommendedWatcher, RecursiveMode, Watcher};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub mod git;
pub mod linux_env;

// ── Errors ──

/// Commands return plain strings so the frontend can show them directly.
fn err<E: std::fmt::Display>(context: &str) -> impl FnOnce(E) -> String + '_ {
    move |e| format!("{context}: {e}")
}

// ── File system ──

#[derive(Serialize)]
pub struct DirEntryInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[derive(Serialize)]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntryInfo>,
}

/// Largest file we are willing to load into the editor (5 MiB).
const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;

fn resolve(path: &str) -> PathBuf {
    // `canonicalize` fails on paths that do not exist yet, so only use it when it works.
    let p = PathBuf::from(path);
    fs::canonicalize(&p).unwrap_or(p)
}

#[derive(Serialize)]
pub struct Root {
    pub name: String,
    pub path: String,
}

/// Places worth offering as a starting folder, most specific first.
///
/// On Android `home_dir` is the shared storage root (`/storage/emulated/0`),
/// which is only readable once the user grants "All files access"; the app's
/// own data directory is the fallback that always works.
fn root_candidates(app: &AppHandle) -> Vec<Root> {
    let p = app.path();
    let mut roots = vec![
        ("Home", p.home_dir()),
        ("Documents", p.document_dir()),
        ("Downloads", p.download_dir()),
        ("App storage", p.app_data_dir()),
    ];
    if cfg!(unix) {
        roots.push(("Filesystem", Ok(PathBuf::from("/"))));
    }

    let mut seen = Vec::new();
    let mut out = Vec::new();
    for (name, dir) in roots {
        let Ok(dir) = dir else { continue };
        // `app_data_dir` may not exist yet on a fresh install.
        if !dir.exists() && name == "App storage" {
            let _ = fs::create_dir_all(&dir);
        }
        if fs::read_dir(&dir).is_err() || seen.contains(&dir) {
            continue;
        }
        seen.push(dir.clone());
        out.push(Root {
            name: name.to_string(),
            path: dir.to_string_lossy().into_owned(),
        });
    }
    out
}

/// Folder the explorer opens on startup: the first candidate we can actually read.
#[tauri::command]
fn default_root(app: AppHandle) -> Result<String, String> {
    root_candidates(&app)
        .into_iter()
        .next()
        .map(|r| r.path)
        .ok_or_else(|| "no readable folder found".to_string())
}

#[tauri::command]
fn quick_roots(app: AppHandle) -> Vec<Root> {
    root_candidates(&app)
}

#[tauri::command]
fn list_dir(app: AppHandle, path: Option<String>) -> Result<DirListing, String> {
    let dir = match path.filter(|p| !p.is_empty()) {
        Some(p) => resolve(&p),
        None => PathBuf::from(default_root(app)?),
    };
    read_dir_listing(&dir)
}

/// List one directory: sub-directories first, then files, each case-insensitively
/// by name. Entries that cannot be stat'ed are skipped rather than failing the call.
pub fn read_dir_listing(dir: &Path) -> Result<DirListing, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(err("cannot read directory"))? {
        let Ok(entry) = entry else { continue };
        let Ok(meta) = entry.metadata() else { continue };
        entries.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing {
        path: dir.to_string_lossy().into_owned(),
        parent: dir
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|p| !p.is_empty()),
        entries,
    })
}

/// Directories that would swamp a project-wide file search.
#[rustfmt::skip]
const SKIPPED_DIRS: &[&str] = &[
    ".git", ".hg", ".svn", "node_modules", "target", "build", "dist", ".gradle",
    ".idea", ".venv", "venv", "__pycache__", ".next", ".cache", "vendor", ".cxx",
];

/// Upper bounds so a search on a huge tree still returns promptly.
const SEARCH_MAX_VISITED: usize = 60_000;
const SEARCH_MAX_RESULTS: usize = 200;

/// Case-insensitive subsequence match, the usual "quick open" behaviour:
/// `mjs` matches `src/main.js`.
fn fuzzy_matches(haystack: &str, needle: &str) -> bool {
    let mut chars = haystack.chars().flat_map(char::to_lowercase);
    needle
        .chars()
        .flat_map(char::to_lowercase)
        .all(|want| chars.any(|c| c == want))
}

#[tauri::command]
fn find_files(root: String, query: String) -> Result<Vec<String>, String> {
    Ok(search_files(&resolve(&root), query.trim()))
}

/// Breadth-first file search under `root`, for the quick-open palette.
pub fn search_files(root: &Path, query: &str) -> Vec<String> {
    let mut queue = std::collections::VecDeque::from([root.to_path_buf()]);
    let mut results = Vec::new();
    let mut visited = 0usize;

    while let Some(dir) = queue.pop_front() {
        if visited >= SEARCH_MAX_VISITED || results.len() >= SEARCH_MAX_RESULTS {
            break;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_dir() {
                if !SKIPPED_DIRS.contains(&name.as_str()) {
                    queue.push_back(entry.path());
                }
                continue;
            }
            if !file_type.is_file() {
                continue; // don't follow symlinks into cycles
            }

            // Match against the path relative to the root, so "src/ma" works.
            let path = entry.path();
            let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy();
            if query.is_empty() || fuzzy_matches(&relative, query) {
                results.push(path.to_string_lossy().into_owned());
                if results.len() >= SEARCH_MAX_RESULTS {
                    break;
                }
            }
        }
    }

    // Shallower paths first: they are nearly always the ones being looked for.
    results.sort_by_key(|p| (p.matches(['/', '\\']).count(), p.len()));
    results
}

#[tauri::command]
fn read_file_text(path: String) -> Result<String, String> {
    read_text_file(&resolve(&path))
}

/// Read a file for the editor, refusing anything too large or not plain UTF-8 text.
pub fn read_text_file(path: &Path) -> Result<String, String> {
    let meta = fs::metadata(path).map_err(err("cannot stat file"))?;
    if meta.len() > MAX_FILE_SIZE {
        return Err(format!(
            "file is too large to open ({:.1} MiB, limit {} MiB)",
            meta.len() as f64 / (1024.0 * 1024.0),
            MAX_FILE_SIZE / (1024 * 1024)
        ));
    }
    let bytes = fs::read(path).map_err(err("cannot read file"))?;
    if bytes.contains(&0) {
        return Err("file appears to be binary".into());
    }
    String::from_utf8(bytes).map_err(|_| "file is not valid UTF-8".to_string())
}

#[tauri::command]
fn write_file_text(path: String, content: String) -> Result<(), String> {
    write_text_file(&resolve(&path), &content)
}

/// Write a file, creating any missing parent directories.
pub fn write_text_file(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(err("cannot create parent directory"))?;
    }
    fs::write(path, content).map_err(err("cannot write file"))
}

#[tauri::command]
fn create_entry(path: String, is_dir: bool) -> Result<(), String> {
    let path = resolve(&path);
    if path.exists() {
        return Err("path already exists".into());
    }
    if is_dir {
        fs::create_dir_all(&path).map_err(err("cannot create directory"))
    } else {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(err("cannot create parent directory"))?;
        }
        fs::write(&path, "").map_err(err("cannot create file"))
    }
}

#[tauri::command]
fn rename_entry(from: String, to: String) -> Result<(), String> {
    fs::rename(resolve(&from), Path::new(&to)).map_err(err("cannot rename"))
}

#[tauri::command]
fn delete_entry(path: String) -> Result<(), String> {
    let path = resolve(&path);
    let meta = fs::symlink_metadata(&path).map_err(err("cannot stat path"))?;
    if meta.is_dir() {
        fs::remove_dir_all(&path).map_err(err("cannot delete directory"))
    } else {
        fs::remove_file(&path).map_err(err("cannot delete file"))
    }
}

// ── File watcher ──

#[derive(Default)]
struct FsWatcher {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[tauri::command]
fn watch_dir(app: AppHandle, state: State<'_, Arc<FsWatcher>>, path: String) -> Result<(), String> {
    let resolved = resolve(&path);
    if !resolved.exists() {
        return Err("directory does not exist".into());
    }

    let mut guard = state.watcher.lock().unwrap();
    // Drop the previous watcher first.
    *guard = None;

    let emitter = app.clone();
    let mut watcher = recommended_watcher(move |res: Result<Event, notify::Error>| {
        if let Ok(event) = res {
            // Ignore events where all paths are internal git files to avoid chatter.
            let is_git_internal = !event.paths.is_empty()
                && event
                    .paths
                    .iter()
                    .all(|p| p.components().any(|c| c.as_os_str() == ".git"));
            if !is_git_internal {
                let paths: Vec<String> = event
                    .paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                let _ = emitter.emit("fs://change", paths);
            }
        }
    })
    .map_err(err("cannot initialize file watcher"))?;

    watcher
        .watch(&resolved, RecursiveMode::Recursive)
        .map_err(err("cannot watch directory"))?;

    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
fn unwatch_dir(state: State<'_, Arc<FsWatcher>>) -> Result<(), String> {
    *state.watcher.lock().unwrap() = None;
    Ok(())
}

// ── Terminal (PTY) ──

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl PtySession {
    /// Feed keystrokes to the shell.
    pub fn write(&mut self, data: &str) -> Result<(), String> {
        self.writer
            .write_all(data.as_bytes())
            .map_err(err("cannot write to terminal"))?;
        self.writer.flush().map_err(err("cannot flush terminal"))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .resize(pty_size(cols, rows))
            .map_err(err("cannot resize terminal"))
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
struct Terminal {
    session: Mutex<Option<PtySession>>,
    session_id: std::sync::atomic::AtomicU64,
    active_id: std::sync::atomic::AtomicU64,
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn spawn_with_command(
    cmd: CommandBuilder,
    cols: u16,
    rows: u16,
) -> Result<(PtySession, Box<dyn Read + Send>), String> {
    let pair = native_pty_system()
        .openpty(pty_size(cols, rows))
        .map_err(err("cannot open pty"))?;

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(err("cannot spawn shell"))?;
    // The slave handle must be dropped, otherwise the reader never sees EOF.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(err("cannot read from pty"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(err("cannot write to pty"))?;

    Ok((
        PtySession {
            master: pair.master,
            writer,
            child,
        },
        reader,
    ))
}

/// Open a PTY and start a login-less shell in it.
///
/// Returns the session plus a reader for the shell's output; the caller decides
/// what to do with that output (the app forwards it to the webview, tests read
/// it directly).
pub fn spawn_shell(
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<(PtySession, Box<dyn Read + Send>), String> {
    let mut cmd = CommandBuilder::new(default_shell());
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.cwd(dir);
        #[cfg(target_os = "android")]
        cmd.env("HOME", dir);
    }
    cmd.env("TERM", "xterm-256color");
    // An Android app process usually starts without PATH, which leaves the
    // shell unable to find even the toybox applets.
    #[cfg(target_os = "android")]
    cmd.env(
        "PATH",
        "/system/bin:/system/xbin:/vendor/bin:/apex/com.android.runtime/bin:/apex/com.android.art/bin",
    );

    spawn_with_command(cmd, cols, rows)
}

pub fn spawn_app_shell(
    app: &AppHandle,
    shell_mode: Option<&str>,
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<(PtySession, Box<dyn Read + Send>), String> {
    let use_alpine = match shell_mode {
        Some("alpine") => true,
        Some("native") => false,
        _ => linux_env::is_installed(app),
    };

    if use_alpine {
        if let Some(cmd) = linux_env::build_proot_command(app, cwd) {
            match spawn_with_command(cmd, cols, rows) {
                Ok(res) => return Ok(res),
                Err(e) => {
                    eprintln!("PRoot spawn failed: {e}; falling back to native shell");
                }
            }
        }
    }

    spawn_shell(cwd, cols, rows)
}

fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    }
    #[cfg(target_os = "android")]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/system/bin/sh".into())
    }
    #[cfg(not(any(windows, target_os = "android")))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

#[tauri::command]
fn pty_start(
    app: AppHandle,
    terminal: State<'_, Arc<Terminal>>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    shell_mode: Option<String>,
) -> Result<u64, String> {
    // Generate a fresh session ID before killing old session
    let id = terminal
        .session_id
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    terminal
        .active_id
        .store(id, std::sync::atomic::Ordering::SeqCst);
    kill_session(&terminal);

    let (session, mut reader) =
        spawn_app_shell(&app, shell_mode.as_deref(), cwd.as_deref(), cols, rows)?;

    let emitter = app.clone();
    let term_state = terminal.inner().clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if emitter.emit("pty://output", &buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
        // Only emit exit if this session is STILL the active session (not replaced by a newer session and not killed)
        if term_state
            .active_id
            .load(std::sync::atomic::Ordering::SeqCst)
            == id
        {
            let _ = emitter.emit("pty://exit", id);
        }
    });

    *terminal.session.lock().unwrap() = Some(session);
    Ok(id)
}

#[tauri::command]
fn pty_write(terminal: State<'_, Arc<Terminal>>, data: String) -> Result<(), String> {
    let mut guard = terminal.session.lock().unwrap();
    guard
        .as_mut()
        .ok_or("terminal is not running")?
        .write(&data)
}

#[tauri::command]
fn pty_resize(terminal: State<'_, Arc<Terminal>>, cols: u16, rows: u16) -> Result<(), String> {
    let guard = terminal.session.lock().unwrap();
    match guard.as_ref() {
        Some(session) => session.resize(cols, rows),
        None => Ok(()), // resizing a terminal that is not running is a no-op
    }
}

fn kill_session(terminal: &Terminal) {
    if let Some(mut session) = terminal.session.lock().unwrap().take() {
        session.kill();
    }
}

#[tauri::command]
fn pty_kill(terminal: State<'_, Arc<Terminal>>) -> Result<(), String> {
    terminal
        .active_id
        .store(0, std::sync::atomic::Ordering::SeqCst);
    kill_session(&terminal);
    Ok(())
}

#[tauri::command]
fn get_linux_env_status(
    app: AppHandle,
    state: State<'_, Arc<linux_env::InstallState>>,
) -> linux_env::LinuxEnvStatus {
    linux_env::get_status(&app, &state)
}

#[tauri::command]
fn install_linux_env(
    app: AppHandle,
    state: State<'_, Arc<linux_env::InstallState>>,
) -> Result<(), String> {
    linux_env::start_install(app, state.inner().clone())
}

#[tauri::command]
fn remove_linux_env(app: AppHandle) -> Result<(), String> {
    linux_env::remove_env(&app)
}

// ── Git commands ──

#[tauri::command]
fn git_status(app: AppHandle, path: String) -> Result<git::GitRepoStatus, String> {
    git::get_repo_status(Some(&app), &path)
}

#[tauri::command]
fn git_stage(app: AppHandle, path: String, files: Vec<String>) -> Result<(), String> {
    git::stage_files(Some(&app), &path, &files)
}

#[tauri::command]
fn git_unstage(app: AppHandle, path: String, files: Vec<String>) -> Result<(), String> {
    git::unstage_files(Some(&app), &path, &files)
}

#[tauri::command]
fn git_discard(app: AppHandle, path: String, files: Vec<String>) -> Result<(), String> {
    git::discard_files(Some(&app), &path, &files)
}

#[tauri::command]
fn git_commit(app: AppHandle, path: String, message: String) -> Result<String, String> {
    git::commit(Some(&app), &path, &message)
}

#[tauri::command]
fn git_push(app: AppHandle, path: String, token: Option<String>) -> Result<String, String> {
    git::push(Some(&app), &path, token.as_deref())
}

#[tauri::command]
fn git_pull(app: AppHandle, path: String, token: Option<String>) -> Result<String, String> {
    git::pull(Some(&app), &path, token.as_deref())
}

#[tauri::command]
fn git_fetch(app: AppHandle, path: String, token: Option<String>) -> Result<String, String> {
    git::fetch(Some(&app), &path, token.as_deref())
}

#[tauri::command]
fn git_diff(app: AppHandle, path: String, file: String, staged: bool) -> Result<String, String> {
    git::diff_file(Some(&app), &path, &file, staged)
}

#[tauri::command]
fn git_show_file(
    app: AppHandle,
    path: String,
    file: String,
    revision: Option<String>,
) -> Result<String, String> {
    git::show_file(Some(&app), &path, &file, revision.as_deref())
}

#[tauri::command]
fn git_branches(app: AppHandle, path: String) -> Result<Vec<String>, String> {
    git::list_branches(Some(&app), &path)
}

#[tauri::command]
fn git_checkout(app: AppHandle, path: String, branch: String) -> Result<String, String> {
    git::checkout_branch(Some(&app), &path, &branch)
}

#[tauri::command]
fn git_create_branch(app: AppHandle, path: String, branch: String) -> Result<String, String> {
    git::create_branch(Some(&app), &path, &branch)
}

#[tauri::command]
fn git_clone(
    app: AppHandle,
    url: String,
    target_parent: String,
    custom_name: Option<String>,
    token: Option<String>,
) -> Result<String, String> {
    git::clone_repo(
        Some(&app),
        &url,
        &target_parent,
        custom_name.as_deref(),
        token.as_deref(),
    )
}

#[tauri::command]
fn github_get_user(token: String) -> Result<git::GitHubUser, String> {
    git::github_get_user(&token)
}

#[tauri::command]
fn github_list_repos(token: String) -> Result<Vec<git::GitHubRepo>, String> {
    git::github_list_repos(&token)
}

// ── Setup ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Terminal::default()))
        .manage(Arc::new(FsWatcher::default()))
        .manage(Arc::new(linux_env::InstallState::default()))
        .invoke_handler(tauri::generate_handler![
            default_root,
            quick_roots,
            list_dir,
            find_files,
            read_file_text,
            write_file_text,
            create_entry,
            rename_entry,
            delete_entry,
            watch_dir,
            unwatch_dir,
            pty_start,
            pty_write,
            pty_resize,
            pty_kill,
            get_linux_env_status,
            install_linux_env,
            remove_linux_env,
            git_status,
            git_stage,
            git_unstage,
            git_discard,
            git_commit,
            git_push,
            git_pull,
            git_fetch,
            git_diff,
            git_show_file,
            git_branches,
            git_checkout,
            git_create_branch,
            git_clone,
            github_get_user,
            github_list_repos,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
