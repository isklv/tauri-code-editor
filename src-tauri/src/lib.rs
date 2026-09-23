use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use base64::prelude::*;
use notify::{recommended_watcher, Event, RecommendedWatcher, RecursiveMode, Watcher};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct CliTargets(pub Mutex<Vec<String>>);

pub mod git;
pub mod linux_env;
pub mod lsp;

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
    let p = PathBuf::from(path);
    #[cfg(not(target_os = "android"))]
    {
        fs::canonicalize(&p).unwrap_or(p)
    }
    #[cfg(target_os = "android")]
    {
        normalize_path(&p)
    }
}

pub fn normalize_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            _ => out.push(comp),
        }
    }
    out
}

pub fn ensure_starter_project(dir: &Path) {
    if !dir.exists() {
        let _ = fs::create_dir_all(dir);
    }
    // Remove any legacy starter files from earlier builds (index.html, style.css, main.js)
    // so that only README.md remains in the workspace.
    for file in &["index.html", "style.css", "main.js"] {
        let path = dir.join(file);
        if path.exists() {
            let _ = fs::remove_file(path);
        }
    }
    let readme_path = dir.join("README.md");
    let readme = "# 🦎 Geko\n\n\
**Geko** — быстрый редактор кода для Android и десктопа на базе Tauri v2, Monaco Editor и xterm.js.\n\n\
---\n\n\
## 🚀 Основные возможности\n\n\
### 📁 Проводник файлов (Explorer)\n\
- Древовидная файловая структура проекта.\n\
- Создание файлов и папок (кнопка `＋` или контекстное меню).\n\
- Переименование, удаление и копирование пути к файлу.\n\
- Открытие любой папки в качестве корня рабочей области.\n\n\
### 📝 Редактор кода (Monaco Editor)\n\
- Полнофункциональный редактор из VS Code.\n\
- Подсветка синтаксиса для сотен языков (JS, TS, Python, Rust, C/C++, HTML, CSS, JSON, Go и др.).\n\
- Автодополнение кода (IntelliSense) с путями файлов и синтаксическими сниппетами.\n\
- Полноценная поддержка композиции и ввода с мобильных софт-клавиатур.\n\n\
### ⚡ Быстрый поиск файлов (Quick Open / Ctrl+P)\n\
- Моментальный нечёткий поиск файлов по всему проекту через верхнюю строку поиска или комбинацию `Ctrl+P`.\n\
- Поиск по содержимому файлов на вкладке Search (`Ctrl+Shift+F`).\n\n\
### 💻 Встроенный терминал и Linux-окружение\n\
- Терминал на базе xterm.js с настоящим PTY-интерфейсом.\n\
- Автономное окружение **Alpine Linux** через PRoot прямо внутри приложения.\n\
- Пакетный менеджер **`apk`**: установка компиляторов, интерпретаторов и CLI-инструментов (`apk add python3 git nodejs gcc make bash curl`).\n\
- Вспомогательная панель клавиш для мобильных устройств: Esc, Tab, Ctrl, Alt, стрелки курсора, пайпы (`|`, `~`, `/`).\n\n\
### 🌿 Контроль версий Git & GitHub\n\
- Встроенная панель Source Control (`Ctrl+Shift+G`).\n\
- Отслеживание изменений (staged / unstaged), diff просмотр файлов.\n\
- Создание коммитов, переключение веток, sync / push / pull.\n\
- Клонирование публичных и приватных репозиториев GitHub по Personal Access Token.\n\n\
### 📱 Мобильная оптимизация\n\
- Адаптивный интерфейс: нижняя панель навигации для телефонов и боковая панель (Activity Bar) для планшетов и десктопа.\n\
- Поддержка многооконного режима и рабочего стола Samsung DeX.\n\
- Сохранение открытых файлов и сессий.\n\n\
---\n\n\
## 📋 История изменений (Changelog)\n\n\
### v0.1.0\n\
- **Рабочая область и проводник**:\n\
  - Инициализация рабочей директории `geko.workspace` со справочным `README.md`.\n\
  - Исправлено отображение файлов в проводнике на Android (устранены ограничения Scoped Storage).\n\
  - Запоминание и автовосстановление последней открытой папки и активных файлов при перезапуске.\n\
- **Терминал и Alpine Linux**:\n\
  - Поддержка Alpine Linux внутри PRoot с автономным менеджером пакетов `apk`.\n\
  - Устранена ошибка прав доступа W^X и EPERM на Android.\n\
  - Исправлено залипание и дублирование символов при вводе с мобильных софт-клавиатур.\n\
  - Предотвращено ложное закрытие терминала при старте сессий.\n\
- **Интерфейс и навигация**:\n\
  - Панель Activity Bar (Explorer, Search, Git, Terminal) и мобильная нижняя панель.\n\
  - Нативные векторные SVG-иконки для папок и типов файлов.\n\
  - Встроенный визуализатор различий (Diff Editor) для Git.\n\
  - Поддержка Samsung DeX и свободной смены размера окна.\n";
    let _ = fs::write(readme_path, readme);
}

#[derive(Serialize)]
pub struct Root {
    pub name: String,
    pub path: String,
}

/// Places worth offering as a starting folder, most specific first.
///
/// On Android, prioritize geko.workspace on shared storage,
/// followed by Shared storage, Documents, and Downloads.
fn root_candidates(app: &AppHandle) -> Vec<Root> {
    let p = app.path();
    #[cfg(target_os = "android")]
    let roots: Vec<(&str, tauri::Result<PathBuf>)> = {
        let mut r = Vec::new();
        // Priority 1: geko.workspace on shared storage (accessible to user and file managers)
        let main_candidates = [
            PathBuf::from("/storage/emulated/0/geko.workspace"),
            PathBuf::from("/sdcard/geko.workspace"),
        ];
        let mut found_workspace = false;
        for ws in &main_candidates {
            if let Some(parent) = ws.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if fs::create_dir_all(ws).is_ok() && fs::read_dir(ws).is_ok() {
                ensure_starter_project(ws);
                r.push(("Workspace", Ok(ws.clone())));
                found_workspace = true;
                break;
            }
        }

        // Fallback workspace if shared root storage is not accessible yet (e.g. before user grants All files access)
        if !found_workspace {
            let app_data = p.app_data_dir().unwrap_or_default();
            let fallback_candidates = [
                PathBuf::from(
                    "/storage/emulated/0/Android/data/dev.codeeditor.ide/files/geko.workspace",
                ),
                app_data.join("files").join("geko.workspace"),
                app_data.join("geko.workspace"),
            ];
            for ws in &fallback_candidates {
                if ws.as_os_str().is_empty() {
                    continue;
                }
                if fs::create_dir_all(ws).is_ok() && fs::read_dir(ws).is_ok() {
                    ensure_starter_project(ws);
                    r.push(("Workspace", Ok(ws.clone())));
                    break;
                }
            }
        }

        if let Ok(rootfs) = linux_env::rootfs_dir(app) {
            let linux_root = rootfs.join("root");
            if linux_root.exists() {
                r.push(("Linux Home (/root)", Ok(linux_root)));
            }
        }

        r.push(("Shared storage", Ok(PathBuf::from("/storage/emulated/0"))));
        r.push((
            "Documents",
            Ok(PathBuf::from("/storage/emulated/0/Documents")),
        ));
        r.push((
            "Downloads",
            Ok(PathBuf::from("/storage/emulated/0/Download")),
        ));
        r
    };
    #[cfg(not(target_os = "android"))]
    let roots: Vec<(&str, tauri::Result<PathBuf>)> = {
        let mut r = Vec::new();
        if let Ok(home_dir) = p.home_dir() {
            let home_workspace = home_dir.join("geko.workspace");
            if fs::create_dir_all(&home_workspace).is_ok() && fs::read_dir(&home_workspace).is_ok()
            {
                ensure_starter_project(&home_workspace);
                r.push(("Workspace", Ok(home_workspace)));
            }
        }
        if let Ok(rootfs) = linux_env::rootfs_dir(app) {
            let linux_root = rootfs.join("root");
            if linux_root.exists() {
                r.push(("Linux Home (/root)", Ok(linux_root)));
            }
        }
        r.push(("Home", p.home_dir()));
        r.push(("Documents", p.document_dir()));
        r.push(("Downloads", p.download_dir()));
        r
    };
    let mut roots = roots;
    if cfg!(unix) {
        roots.push(("Filesystem", Ok(PathBuf::from("/"))));
    }

    let mut seen = Vec::new();
    let mut out = Vec::new();
    for (name, dir) in roots {
        let Ok(dir) = dir else { continue };
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
/// by name. Entries that cannot be stat'ed fall back to file_type/symlink_metadata
/// rather than silently dropping files.
pub fn read_dir_listing(dir: &Path) -> Result<DirListing, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(dir).map_err(err("cannot read directory"))? {
        let Ok(entry) = entry else { continue };
        let (is_dir, size) = match entry.metadata() {
            Ok(meta) => (meta.is_dir(), meta.len()),
            Err(_) => match fs::symlink_metadata(entry.path()) {
                Ok(meta) => (meta.is_dir(), meta.len()),
                Err(_) => {
                    let is_dir = entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
                    (is_dir, 0)
                }
            },
        };
        entries.push(DirEntryInfo {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
            size,
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

#[derive(Serialize)]
pub struct FilePreview {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub is_binary: bool,
    pub is_image: bool,
    pub is_media: bool,
    pub mime: String,
    pub data_url: Option<String>,
    pub text_content: Option<String>,
    pub hex_dump: Option<String>,
}

fn detect_mime(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        "json" => "application/json",
        "xml" => "application/xml",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" | "cjs" => "application/javascript",
        "ts" | "mts" | "cts" => "text/plain",
        "md" | "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn format_hex_dump(bytes: &[u8]) -> String {
    let mut out = String::new();
    for (i, chunk) in bytes.chunks(16).enumerate() {
        let offset = i * 16;
        let mut hex_part = String::new();
        let mut ascii_part = String::new();
        for (j, &b) in chunk.iter().enumerate() {
            if j == 8 {
                hex_part.push(' ');
            }
            hex_part.push_str(&format!("{:02x} ", b));
            if (32..=126).contains(&b) {
                ascii_part.push(b as char);
            } else {
                ascii_part.push('.');
            }
        }
        let padding = if chunk.len() < 16 {
            let missing = 16 - chunk.len();
            let extra_space = if chunk.len() <= 8 { 1 } else { 0 };
            " ".repeat(missing * 3 + extra_space)
        } else {
            String::new()
        };
        out.push_str(&format!(
            "{:08x}  {}{} |{}|\n",
            offset, hex_part, padding, ascii_part
        ));
    }
    out
}

#[tauri::command]
fn read_file_preview(path: String) -> Result<FilePreview, String> {
    let p = resolve(&path);
    let meta = fs::metadata(&p).map_err(err("cannot stat file"))?;
    let size = meta.len();
    let name = p
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mime = detect_mime(&p).to_string();
    let is_image = mime.starts_with("image/");
    let is_media = mime.starts_with("audio/") || mime.starts_with("video/");

    let read_limit = if is_image || is_media {
        30 * 1024 * 1024
    } else {
        MAX_FILE_SIZE
    };

    if size > read_limit {
        return Err(format!(
            "file is too large to load ({:.1} MiB, limit {:.0} MiB)",
            size as f64 / (1024.0 * 1024.0),
            read_limit as f64 / (1024.0 * 1024.0)
        ));
    }

    let bytes = fs::read(&p).map_err(err("cannot read file"))?;
    let is_binary = bytes.contains(&0) || is_image || is_media;

    if is_image || is_media {
        let b64 = BASE64_STANDARD.encode(&bytes);
        let data_url = format!("data:{mime};base64,{b64}");
        let text_content = if mime == "image/svg+xml" {
            String::from_utf8(bytes).ok()
        } else {
            None
        };
        return Ok(FilePreview {
            path,
            name,
            size,
            is_binary: true,
            is_image,
            is_media,
            mime,
            data_url: Some(data_url),
            text_content,
            hex_dump: None,
        });
    }

    if !is_binary {
        let text = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            match String::from_utf8(bytes[3..].to_vec()) {
                Ok(s) => s,
                Err(_) => String::from_utf8_lossy(&bytes[3..]).into_owned(),
            }
        } else if bytes.starts_with(&[0xFF, 0xFE]) {
            let u16_chars: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|c| u16::from_le_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&u16_chars)
        } else if bytes.starts_with(&[0xFE, 0xFF]) {
            let u16_chars: Vec<u16> = bytes[2..]
                .chunks_exact(2)
                .map(|c| u16::from_be_bytes([c[0], c[1]]))
                .collect();
            String::from_utf16_lossy(&u16_chars)
        } else {
            match String::from_utf8(bytes.clone()) {
                Ok(s) => s,
                Err(_) => String::from_utf8_lossy(&bytes).into_owned(),
            }
        };

        return Ok(FilePreview {
            path,
            name,
            size,
            is_binary: false,
            is_image: false,
            is_media: false,
            mime,
            data_url: None,
            text_content: Some(text),
            hex_dump: None,
        });
    }

    let sample = &bytes[..bytes.len().min(4096)];
    let hex_dump = format_hex_dump(sample);

    Ok(FilePreview {
        path,
        name,
        size,
        is_binary: true,
        is_image: false,
        is_media: false,
        mime,
        data_url: None,
        text_content: None,
        hex_dump: Some(hex_dump),
    })
}

#[tauri::command]
fn read_file_force_text(path: String) -> Result<String, String> {
    let p = resolve(&path);
    let bytes = fs::read(&p).map_err(err("cannot read file"))?;
    let take_len = bytes.len().min(MAX_FILE_SIZE as usize);
    let slice = &bytes[..take_len];
    Ok(String::from_utf8_lossy(slice).into_owned())
}

#[tauri::command]
fn get_cli_open_targets(state: State<'_, Arc<CliTargets>>, #[allow(unused_variables)] app: AppHandle) -> Vec<String> {
    let mut lock = state.0.lock().unwrap();
    #[allow(unused_mut)]
    let mut list = std::mem::take(&mut *lock);

    #[cfg(target_os = "android")]
    {
        if let Ok(app_dir) = app.path().app_data_dir() {
            let pending = app_dir.join("pending_open_file.txt");
            if pending.exists() {
                if let Ok(content) = fs::read_to_string(&pending) {
                    for line in content.lines() {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() && Path::new(trimmed).exists() {
                            list.push(trimmed.to_string());
                        }
                    }
                }
                let _ = fs::remove_file(pending);
            }
        }
    }

    list
}

#[tauri::command]
fn read_file_text(path: String) -> Result<String, String> {
    read_text_file(&resolve(&path))
}

/// Read a file for the editor, refusing anything too large or binary,
/// but supporting BOMs and falling back gracefully to lossy UTF-8 for 8-bit encodings.
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

    // Check BOMs
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return match String::from_utf8(bytes[3..].to_vec()) {
            Ok(s) => Ok(s),
            Err(_) => Ok(String::from_utf8_lossy(&bytes[3..]).into_owned()),
        };
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let u16_chars: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return Ok(String::from_utf16_lossy(&u16_chars));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let u16_chars: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        return Ok(String::from_utf16_lossy(&u16_chars));
    }

    if bytes.contains(&0) {
        return Err("file appears to be binary".into());
    }
    match String::from_utf8(bytes.clone()) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
    }
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
pub struct Terminal {
    sessions: Mutex<std::collections::HashMap<u64, PtySession>>,
    session_id: std::sync::atomic::AtomicU64,
}

#[derive(Serialize, Clone)]
struct PtyOutputPayload {
    id: u64,
    bytes: Vec<u8>,
}

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
pub struct ProxyOptions {
    pub proxy_url: Option<String>,
    pub isolate_env: Option<bool>,
    pub isolated_home: Option<bool>,
}

fn apply_proxy_to_cmd(cmd: &mut CommandBuilder, proxy_url: Option<&str>) {
    if let Some(proxy) = proxy_url.filter(|s| !s.trim().is_empty()) {
        let clean = proxy.trim();
        let socks_url = if clean.starts_with("socks5://") {
            clean.replacen("socks5://", "socks5h://", 1)
        } else {
            clean.to_string()
        };
        cmd.env("ALL_PROXY", &socks_url);
        cmd.env("all_proxy", &socks_url);
        cmd.env("HTTP_PROXY", clean);
        cmd.env("http_proxy", clean);
        cmd.env("HTTPS_PROXY", clean);
        cmd.env("https_proxy", clean);
        cmd.env("NO_PROXY", "localhost,127.0.0.1,::1");
        cmd.env("no_proxy", "localhost,127.0.0.1,::1");
    }
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
    proxy_url: Option<&str>,
) -> Result<(PtySession, Box<dyn Read + Send>), String> {
    let mut cmd = CommandBuilder::new(default_shell());
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        cmd.cwd(dir);
        #[cfg(target_os = "android")]
        cmd.env("HOME", dir);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // An Android app process usually starts without PATH, which leaves the
    // shell unable to find even the toybox applets.
    #[cfg(target_os = "android")]
    cmd.env(
        "PATH",
        "/system/bin:/system/xbin:/vendor/bin:/apex/com.android.runtime/bin:/apex/com.android.art/bin",
    );
    apply_proxy_to_cmd(&mut cmd, proxy_url);

    spawn_with_command(cmd, cols, rows)
}

pub fn spawn_app_shell(
    app: &AppHandle,
    shell_mode: Option<&str>,
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
    proxy_url: Option<&str>,
) -> Result<(PtySession, Box<dyn Read + Send>), String> {
    let explicit_alpine = matches!(shell_mode, Some("alpine"));
    let use_alpine = match shell_mode {
        Some("alpine") => true,
        Some("native") => false,
        _ => linux_env::is_installed(app),
    };

    if use_alpine {
        match linux_env::build_proot_command(app, cwd, proxy_url) {
            Some(cmd) => match spawn_with_command(cmd, cols, rows) {
                Ok(res) => {
                    linux_env::emit_log(app, "started the Alpine shell");
                    return Ok(res);
                }
                // Asking for Alpine explicitly and silently landing in the native
                // shell is what makes `apk` look broken, so say what happened.
                Err(e) if explicit_alpine => {
                    linux_env::emit_log(app, format!("Alpine shell could not start: {e}"));
                    return Err(format!("Alpine Linux shell could not start: {e}"));
                }
                Err(e) => report_alpine_fallback(app, &e),
            },
            None if explicit_alpine => {
                return Err("Alpine Linux environment is not installed yet".to_string())
            }
            None => report_alpine_fallback(app, "environment files are missing"),
        }
    }

    spawn_shell(cwd, cols, rows, proxy_url)
}

/// Tell the webview that the Alpine shell was requested but the native shell is
/// what actually started, so the terminal can show it instead of pretending.
fn report_alpine_fallback(app: &AppHandle, reason: &str) {
    linux_env::emit_log(
        app,
        format!("Alpine shell unavailable ({reason}); using the native shell"),
    );
    let _ = app.emit(
        "linux-env://fallback",
        linux_env::SimpleMessagePayload {
            message: format!(
                "Alpine Linux shell unavailable ({reason}); using the native shell instead."
            ),
        },
    );
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
    proxy: Option<ProxyOptions>,
) -> Result<u64, String> {
    let id = terminal
        .session_id
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;

    let proxy_url = proxy.as_ref().and_then(|p| p.proxy_url.as_deref());
    let (session, mut reader) =
        spawn_app_shell(&app, shell_mode.as_deref(), cwd.as_deref(), cols, rows, proxy_url)?;

    let emitter = app.clone();
    let term_state = terminal.inner().clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let payload = PtyOutputPayload {
                        id,
                        bytes: buf[..n].to_vec(),
                    };
                    if emitter.emit("pty://output", &payload).is_err() {
                        break;
                    }
                }
            }
        }
        term_state.sessions.lock().unwrap().remove(&id);
        let _ = emitter.emit("pty://exit", id);
    });

    terminal.sessions.lock().unwrap().insert(id, session);
    Ok(id)
}

#[tauri::command]
fn pty_write(
    terminal: State<'_, Arc<Terminal>>,
    id: Option<u64>,
    data: String,
) -> Result<(), String> {
    let mut guard = terminal.sessions.lock().unwrap();
    let session = if let Some(id) = id {
        guard.get_mut(&id).ok_or("terminal session not found")?
    } else {
        guard.values_mut().next().ok_or("terminal is not running")?
    };
    session.write(&data)
}

#[tauri::command]
fn pty_resize(
    terminal: State<'_, Arc<Terminal>>,
    id: Option<u64>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let guard = terminal.sessions.lock().unwrap();
    if let Some(id) = id {
        if let Some(session) = guard.get(&id) {
            session.resize(cols, rows)?;
        }
    } else if let Some(session) = guard.values().next() {
        session.resize(cols, rows)?;
    }
    Ok(())
}

#[tauri::command]
fn pty_kill(terminal: State<'_, Arc<Terminal>>, id: Option<u64>) -> Result<(), String> {
    let mut guard = terminal.sessions.lock().unwrap();
    if let Some(id) = id {
        if let Some(mut session) = guard.remove(&id) {
            session.kill();
        }
    } else {
        for (_, mut session) in guard.drain() {
            session.kill();
        }
    }
    Ok(())
}

#[tauri::command]
fn test_proxy_connection(proxy_url: String) -> Result<bool, String> {
    let raw = proxy_url.trim();
    if raw.is_empty() {
        return Err("Proxy URL is empty".into());
    }

    let without_proto = if let Some(idx) = raw.find("://") {
        &raw[idx + 3..]
    } else {
        raw
    };
    let without_auth = if let Some(idx) = without_proto.find('@') {
        &without_proto[idx + 1..]
    } else {
        without_proto
    };
    let host_port = without_auth.split('/').next().unwrap_or(without_auth).trim();
    if host_port.is_empty() {
        return Err("Empty host in proxy URL".into());
    }

    let (host, port) = if let Some((h, p_str)) = host_port.rsplit_once(':') {
        let p: u16 = p_str.parse().map_err(|_| format!("Invalid port in proxy URL: {p_str}"))?;
        (h, p)
    } else {
        let default_port = if raw.starts_with("socks") { 1080 } else { 8080 };
        (host_port, default_port)
    };

    use std::net::ToSocketAddrs;
    let addrs = format!("{host}:{port}")
        .to_socket_addrs()
        .map_err(|e| format!("Cannot resolve host {host}:{port}: {e}"))?;

    let timeout = std::time::Duration::from_secs(3);
    for addr in addrs {
        if std::net::TcpStream::connect_timeout(&addr, timeout).is_ok() {
            return Ok(true);
        }
    }

    Err(format!("Could not connect to proxy server at {host}:{port}"))
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
    branch: Option<String>,
) -> Result<(), String> {
    linux_env::start_install(app, state.inner().clone(), branch)
}

#[tauri::command]
fn get_alpine_config(app: AppHandle) -> Result<linux_env::AlpineConfig, String> {
    linux_env::get_alpine_config(&app)
}

#[tauri::command]
fn set_alpine_branch(
    app: AppHandle,
    branch: String,
    enable_edge: bool,
    run_upgrade: bool,
) -> Result<(), String> {
    linux_env::set_alpine_branch(&app, branch, enable_edge, run_upgrade)
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

#[derive(serde::Serialize, Clone, Debug)]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub build_profile: &'static str,
    pub target_os: &'static str,
    pub target_arch: &'static str,
    pub commit_hash: Option<&'static str>,
}

#[tauri::command]
fn get_app_info() -> AppInfo {
    AppInfo {
        name: "Geko",
        version: env!("CARGO_PKG_VERSION"),
        build_profile: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        target_os: std::env::consts::OS,
        target_arch: std::env::consts::ARCH,
        commit_hash: option_env!("GIT_COMMIT_HASH"),
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let res = std::process::Command::new("/system/bin/am")
            .args(["start", "-a", "android.intent.action.VIEW", "-d", &url])
            .status();
        if let Ok(s) = res {
            if s.success() {
                return Ok(());
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let res = std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn();
        if let Ok(mut child) = res {
            let _ = child.wait();
            return Ok(());
        }
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("cmd").args(["/C", "start", &url]).spawn();
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(&url).spawn();
        return Ok(());
    }
    Err("Failed to open URL in external application".to_string())
}

// ── Setup ──

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init());

    #[cfg(not(target_os = "android"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let mut targets = Vec::new();
            let cwd_path = PathBuf::from(&cwd);
            for arg in argv.into_iter().skip(1) {
                if arg.starts_with('-') {
                    continue;
                }
                let p = PathBuf::from(&arg);
                let full = if p.is_absolute() { p } else { cwd_path.join(p) };
                targets.push(full.to_string_lossy().into_owned());
            }
            if !targets.is_empty() {
                let _ = app.emit("open-files", &targets);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }));
    }

    builder
        .manage(Arc::new(Terminal::default()))
        .manage(Arc::new(FsWatcher::default()))
        .manage(Arc::new(linux_env::InstallState::default()))
        .manage(Arc::new(lsp::LspManager::default()))
        .manage(Arc::new(CliTargets::default()))
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            open_external_url,
            default_root,
            quick_roots,
            list_dir,
            find_files,
            read_file_text,
            read_file_preview,
            read_file_force_text,
            get_cli_open_targets,
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
            test_proxy_connection,
            get_linux_env_status,
            install_linux_env,
            get_alpine_config,
            set_alpine_branch,
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
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_supported,
        ])
        .setup(|app| {
            // Collect initial command-line arguments to open files
            let cli_targets = app.state::<Arc<CliTargets>>();
            let args: Vec<String> = std::env::args().skip(1).collect();
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let mut targets = Vec::new();
            for arg in args {
                if arg.starts_with('-') {
                    continue;
                }
                let p = PathBuf::from(&arg);
                let full = if p.is_absolute() { p } else { cwd.join(p) };
                targets.push(full.to_string_lossy().into_owned());
            }
            if !targets.is_empty() {
                if let Ok(mut lock) = cli_targets.0.lock() {
                    *lock = targets;
                }
            }

            // The Alpine environment is what provides apk, git and compilers, so
            // it is installed on first launch instead of on request. Driving it
            // from here keeps it working even if the webview never gets there.
            let handle = app.handle().clone();
            if !linux_env::is_installed(&handle) {
                let state = handle
                    .state::<Arc<linux_env::InstallState>>()
                    .inner()
                    .clone();
                if let Err(e) = linux_env::start_install(handle, state, None) {
                    eprintln!("Linux environment setup did not start: {e}");
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
