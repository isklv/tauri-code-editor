//! Autonomous Linux environment (Alpine Linux + PRoot) for Android and desktop.
//!
//! Downloads and sets up an isolated Alpine Linux user-space environment with the
//! `apk` package manager. Allows running `apk add git`, `apk add go`, `apk add rust cargo`,
//! compilers, and runtimes without root privileges or external apps like Termux.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use flate2::read::GzDecoder;
use portable_pty::CommandBuilder;
use serde::Serialize;
use tar::Archive;
use tauri::{AppHandle, Emitter, Manager};

/// Bumped whenever the layout produced by `run_install` changes; an environment
/// installed by an older version is re-created instead of being trusted.
pub const INSTALL_VERSION: &str = "2";
const MARKER_FILE: &str = ".install-complete";

const ALPINE_BRANCH: &str = "v3.20";
const ALPINE_RELEASE: &str = "3.20.3";

#[derive(Serialize, Clone, Debug)]
pub struct LinuxEnvStatus {
    pub is_installed: bool,
    pub is_installing: bool,
    pub arch: String,
    pub env_dir: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ProgressPayload {
    pub step: String,
    pub message: String,
    pub percent: u32,
}

#[derive(Serialize, Clone, Debug)]
pub struct SimpleMessagePayload {
    pub message: String,
}

#[derive(Default)]
pub struct InstallState {
    pub is_installing: Mutex<bool>,
}

pub fn target_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "arm") {
        "arm"
    } else if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else {
        "aarch64"
    }
}

/// Where to fetch the static PRoot build for this CPU. A download is only
/// accepted once the binary has been executed successfully, since a device can
/// refuse to run it even when the transfer went fine.
fn proot_urls(arch: &str) -> Vec<String> {
    let name = match arch {
        "aarch64" => "proot-v5.3.0-aarch64-static",
        "arm" => "proot-v5.3.0-arm-static",
        _ => "proot-v5.3.0-x86_64-static",
    };
    vec![format!(
        "https://github.com/proot-me/proot/releases/download/v5.3.0/{name}"
    )]
}

fn alpine_arch(arch: &str) -> &'static str {
    match arch {
        "aarch64" => "aarch64",
        "arm" => "armv7",
        _ => "x86_64",
    }
}

fn alpine_urls(arch: &str) -> Vec<String> {
    let a = alpine_arch(arch);
    let file = format!("alpine-minirootfs-{ALPINE_RELEASE}-{a}.tar.gz");
    [
        "https://dl-cdn.alpinelinux.org/alpine",
        "https://mirrors.edge.kernel.org/alpine",
        "https://mirror.yandex.ru/mirrors/alpine",
    ]
    .iter()
    .map(|base| format!("{base}/{ALPINE_BRANCH}/releases/{a}/{file}"))
    .collect()
}

pub fn env_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot get app data directory: {e}"))?;
    Ok(base.join("linux-env"))
}

pub fn proot_bin(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(env_dir(app)?.join("bin").join("proot"))
}

pub fn rootfs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(env_dir(app)?.join("alpine"))
}

/// Scratch directory PRoot uses for its own temporary files. Android has no
/// writable `/tmp`, and without this PRoot dies before it ever starts the shell.
pub fn proot_tmp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(env_dir(app)?.join("tmp"))
}

fn marker_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(env_dir(app)?.join(MARKER_FILE))
}

/// An environment only counts as installed once `run_install` has written its
/// marker, so a half-finished download is never mistaken for a usable rootfs.
pub fn is_installed(app: &AppHandle) -> bool {
    env_dir(app)
        .map(|dir| env_is_complete(&dir))
        .unwrap_or(false)
}

/// True only for an environment that finished installing: a marker of the
/// current layout version, the PRoot binary, and a shell inside the rootfs.
pub fn env_is_complete(env_path: &Path) -> bool {
    let marker = env_path.join(MARKER_FILE);
    match fs::read_to_string(marker) {
        Ok(version) if version.trim() == INSTALL_VERSION => {}
        _ => return false,
    }
    env_path.join("bin").join("proot").exists() && rootfs_has_shell(&env_path.join("alpine"))
}

/// Whether a rootfs carries a usable shell. `/bin/sh` inside Alpine is a symlink
/// to the absolute path `/bin/busybox`, which only resolves *inside* PRoot — so
/// following it from the host (what `Path::exists` does) always says "missing".
fn rootfs_has_shell(rootfs: &Path) -> bool {
    rootfs.join("bin").join("busybox").exists()
        || fs::symlink_metadata(rootfs.join("bin").join("sh")).is_ok()
}

pub fn get_status(app: &AppHandle, state: &InstallState) -> LinuxEnvStatus {
    let installing = *state.is_installing.lock().unwrap();
    let installed = is_installed(app);
    let dir_str = env_dir(app).ok().map(|p| p.to_string_lossy().into_owned());

    LinuxEnvStatus {
        is_installed: installed,
        is_installing: installing,
        arch: target_arch().to_string(),
        env_dir: dir_str,
    }
}

pub fn start_install(app: AppHandle, state: Arc<InstallState>) -> Result<(), String> {
    let mut guard = state.is_installing.lock().unwrap();
    if *guard {
        return Err("installation already in progress".to_string());
    }
    *guard = true;
    drop(guard);

    let emitter = app.clone();
    let thread_state = state.clone();

    std::thread::spawn(move || {
        let result = run_install(&app);
        *thread_state.is_installing.lock().unwrap() = false;

        match result {
            Ok(note) => {
                let message = match note {
                    Some(warning) => format!("Alpine Linux ready, but {warning}"),
                    None => "Alpine Linux environment ready! Open terminal to start.".to_string(),
                };
                let _ = emitter.emit("linux-env://complete", SimpleMessagePayload { message });
            }
            Err(e) => {
                let _ = emitter.emit("linux-env://error", SimpleMessagePayload { message: e });
            }
        }
    });

    Ok(())
}

fn emit_progress(app: &AppHandle, step: &str, message: &str, percent: u32) {
    let _ = app.emit(
        "linux-env://progress",
        ProgressPayload {
            step: step.to_string(),
            message: message.to_string(),
            percent,
        },
    );
}

/// Download `url` into `dest`, writing through a `.part` file so an interrupted
/// transfer can never leave a truncated binary behind.
fn download_to(url: &str, dest: &Path) -> Result<(), String> {
    // A stalled transfer must fail so the caller can retry, rather than leaving
    // the install spinning forever on a dead connection.
    const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

    let part = dest.with_extension("part");
    let agent = ureq::Agent::config_builder()
        .timeout_resolve(Some(std::time::Duration::from_secs(20)))
        .timeout_connect(Some(std::time::Duration::from_secs(30)))
        .timeout_recv_response(Some(std::time::Duration::from_secs(60)))
        .timeout_global(Some(DOWNLOAD_TIMEOUT))
        .build()
        .new_agent();
    let resp = agent
        .get(url)
        .call()
        .map_err(|e| format!("download failed ({url}): {e}"))?;
    let mut reader = resp.into_body().into_reader();
    let mut file =
        fs::File::create(&part).map_err(|e| format!("cannot create {}: {e}", part.display()))?;
    std::io::copy(&mut reader, &mut file)
        .map_err(|e| format!("failed writing {}: {e}", part.display()))?;
    file.flush()
        .map_err(|e| format!("failed flushing {}: {e}", part.display()))?;
    drop(file);

    let size = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        let _ = fs::remove_file(&part);
        return Err(format!("download from {url} produced an empty file"));
    }
    fs::rename(&part, dest).map_err(|e| format!("cannot finish writing {}: {e}", dest.display()))
}

/// Try each URL, a few times each: a phone switching between Wi-Fi and mobile
/// data drops transfers often enough that one failed attempt means little.
fn download_first_working(
    urls: &[String],
    dest: &Path,
    verify: impl Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    const ATTEMPTS_PER_URL: u32 = 3;
    let mut last_error = String::from("no download source available");
    for url in urls {
        for attempt in 0..ATTEMPTS_PER_URL {
            match download_to(url, dest).and_then(|()| verify(dest)) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    eprintln!("linux-env: attempt {} for {url} failed: {e}", attempt + 1);
                    let _ = fs::remove_file(dest);
                    last_error = e;
                    if attempt + 1 < ATTEMPTS_PER_URL {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                    }
                }
            }
        }
    }
    Err(last_error)
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o755));
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) {}

/// A PRoot binary is only usable if this device can actually execute it: the
/// download may be fine while the filesystem is mounted `noexec`, or the build
/// may not run on this kernel at all.
fn verify_proot(path: &Path) -> Result<(), String> {
    make_executable(path);
    let out = Command::new(path)
        .arg("--version")
        .output()
        .map_err(|e| format!("PRoot binary cannot be executed: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "PRoot binary exited with {}: {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

fn verify_gzip(path: &Path) -> Result<(), String> {
    let file = fs::File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let mut decoder = GzDecoder::new(file);
    let mut probe = [0u8; 1024];
    use std::io::Read;
    decoder
        .read(&mut probe)
        .map(|_| ())
        .map_err(|e| format!("downloaded rootfs archive is not readable: {e}"))
}

fn run_install(app: &AppHandle) -> Result<Option<String>, String> {
    let arch = target_arch();
    let env_path = env_dir(app)?;
    let bin_path = env_path.join("bin");
    let proot_path = bin_path.join("proot");
    let rootfs_path = env_path.join("alpine");
    let tmp_path = proot_tmp_dir(app)?;

    // A previous attempt may have left a partial rootfs; start from a clean slate.
    let _ = fs::remove_file(marker_path(app)?);
    if rootfs_path.exists() {
        let _ = fs::remove_dir_all(&rootfs_path);
    }

    fs::create_dir_all(&bin_path)
        .map_err(|e| format!("cannot create bin directory {}: {e}", bin_path.display()))?;
    fs::create_dir_all(&rootfs_path).map_err(|e| {
        format!(
            "cannot create rootfs directory {}: {e}",
            rootfs_path.display()
        )
    })?;
    fs::create_dir_all(&tmp_path)
        .map_err(|e| format!("cannot create temp directory {}: {e}", tmp_path.display()))?;

    // 1. Download PRoot binary
    emit_progress(app, "proot", "Downloading PRoot binary (~3 MB)...", 10);
    download_first_working(&proot_urls(arch), &proot_path, verify_proot)
        .map_err(|e| format!("could not set up PRoot for {arch}: {e}"))?;

    // 2. Download Alpine Linux rootfs
    emit_progress(
        app,
        "alpine_download",
        "Downloading Alpine Linux rootfs (~3.5 MB)...",
        35,
    );
    let archive_path = env_path.join("alpine-rootfs.tar.gz");
    download_first_working(&alpine_urls(arch), &archive_path, verify_gzip)
        .map_err(|e| format!("could not download Alpine rootfs: {e}"))?;

    // 3. Extract rootfs
    emit_progress(
        app,
        "alpine_extract",
        "Extracting Alpine Linux filesystem...",
        55,
    );
    let archive_file = fs::File::open(&archive_path)
        .map_err(|e| format!("cannot open {}: {e}", archive_path.display()))?;
    let gz = GzDecoder::new(archive_file);
    let mut archive = Archive::new(gz);
    archive.set_preserve_permissions(true);
    archive
        .unpack(&rootfs_path)
        .map_err(|e| format!("failed to extract rootfs to {}: {e}", rootfs_path.display()))?;
    let _ = fs::remove_file(&archive_path);

    #[cfg(unix)]
    fix_rootfs_permissions(&rootfs_path);

    // 4. Configure network, package mirrors and the welcome banner
    emit_progress(
        app,
        "configure",
        "Configuring network and package mirrors...",
        70,
    );
    configure_rootfs(&rootfs_path)?;

    // The environment is usable from here on; the package bootstrap below is a
    // convenience, so a slow mirror must not leave the install marked unfinished.
    fs::write(marker_path(app)?, INSTALL_VERSION)
        .map_err(|e| format!("cannot finalize installation: {e}"))?;

    // 5. Seed the package index (and Git) so `apk add` works right away
    emit_progress(
        app,
        "packages",
        "Updating package index and installing git...",
        85,
    );
    let warning = match bootstrap_packages(app) {
        Ok(()) => None,
        Err(e) => {
            eprintln!("Alpine package bootstrap failed: {e}");
            Some(format!(
                "package setup failed: {e}. Run `apk update` in the terminal."
            ))
        }
    };

    emit_progress(app, "done", "Alpine Linux environment ready!", 100);
    Ok(warning)
}

fn configure_rootfs(rootfs_path: &Path) -> Result<(), String> {
    let etc_dir = rootfs_path.join("etc");
    fs::create_dir_all(&etc_dir)
        .map_err(|e| format!("cannot create {}: {e}", etc_dir.display()))?;

    // DNS: PRoot exposes no host resolver, so the rootfs needs its own.
    fs::write(
        etc_dir.join("resolv.conf"),
        "nameserver 1.1.1.1\nnameserver 8.8.8.8\n",
    )
    .map_err(|e| format!("cannot write resolv.conf: {e}"))?;
    let _ = fs::write(
        etc_dir.join("hosts"),
        "127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n",
    );

    // APK repositories
    let apk_dir = etc_dir.join("apk");
    fs::create_dir_all(&apk_dir)
        .map_err(|e| format!("cannot create {}: {e}", apk_dir.display()))?;
    fs::write(
        apk_dir.join("repositories"),
        format!(
            "https://dl-cdn.alpinelinux.org/alpine/{ALPINE_BRANCH}/main\n\
             https://dl-cdn.alpinelinux.org/alpine/{ALPINE_BRANCH}/community\n"
        ),
    )
    .map_err(|e| format!("cannot write apk repositories: {e}"))?;

    // Directories apk and ordinary tools expect to be writable.
    for dir in ["tmp", "var/tmp", "var/cache/apk", "root", "dev/shm", "run"] {
        let _ = fs::create_dir_all(rootfs_path.join(dir));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for dir in ["tmp", "var/tmp", "dev/shm"] {
            let _ = fs::set_permissions(rootfs_path.join(dir), fs::Permissions::from_mode(0o1777));
        }
    }

    // Welcome banner
    let profile_d = etc_dir.join("profile.d");
    let _ = fs::create_dir_all(&profile_d);
    let welcome_file = profile_d.join("welcome.sh");
    let welcome_msg = r#"#!/bin/sh
cat << 'EOF'

   _    _       _             _     _                  
  /_\  | |_ __ (_)_ _  ___   | |   (_)_ _  _  ___ __   
 / _ \ | | '_ \| | ' \/ -_)  | |__ | | ' \| || \ \ /   
/_/ \_\|_| .__/|_|_||_\___|  |____||_|_||_|\_,_/_\_\   
         |_|                                           
Welcome to Alpine Linux (PRoot environment)!
Package manager: apk

Quick start:
  apk update
  apk add git         # install Git
  apk add go          # install Go compiler
  apk add rust cargo  # install Rust & Cargo
  apk add python3     # install Python
  apk add nodejs npm  # install Node.js

EOF
"#;
    let _ = fs::write(&welcome_file, welcome_msg);
    make_executable(&welcome_file);
    Ok(())
}

/// Run `apk update` (plus a couple of staples) inside the fresh rootfs so the
/// first `apk add` in the terminal does not have to bootstrap anything itself.
fn bootstrap_packages(app: &AppHandle) -> Result<(), String> {
    const BOOTSTRAP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

    let log_path = proot_tmp_dir(app)?.join("bootstrap.log");
    let log = fs::File::create(&log_path)
        .map_err(|e| format!("cannot create {}: {e}", log_path.display()))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("cannot open bootstrap log: {e}"))?;

    let mut cmd = proot_command(app, None).ok_or("PRoot environment is not ready")?;
    cmd.args(["/bin/sh", "-lc", "apk update && apk add --no-cache git"]);
    cmd.stdout(log);
    cmd.stderr(log_err);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot run apk inside the Linux environment: {e}"))?;

    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() > BOOTSTRAP_TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("apk took too long and was stopped".to_string());
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            Err(e) => return Err(format!("cannot wait for apk: {e}")),
        }
    };

    if status.success() {
        return Ok(());
    }
    let log_text = fs::read_to_string(&log_path).unwrap_or_default();
    let lines: Vec<&str> = log_text.lines().collect();
    let log_tail = lines[lines.len().saturating_sub(3)..].join(" ");
    Err(if log_tail.trim().is_empty() {
        format!("apk exited with {status}")
    } else {
        log_tail
    })
}

#[cfg(unix)]
fn fix_rootfs_permissions(rootfs: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let subs = [
        "bin",
        "sbin",
        "usr/bin",
        "usr/sbin",
        "lib",
        "usr/lib",
        "etc/profile.d",
    ];
    for sub in subs {
        let dir = rootfs.join(sub);
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    let mut perms = meta.permissions();
                    let mode = perms.mode();
                    perms.set_mode(mode | 0o755);
                    let _ = fs::set_permissions(entry.path(), perms);
                }
            }
        }
    }
}

pub fn remove_env(app: &AppHandle) -> Result<(), String> {
    let env_path = env_dir(app)?;
    if env_path.exists() {
        fs::remove_dir_all(&env_path)
            .map_err(|e| format!("cannot remove {}: {e}", env_path.display()))?;
    }
    Ok(())
}

/// Arguments shared by every PRoot invocation (terminal, git, package bootstrap):
/// root emulation, the rootfs, the kernel filesystems and the working directory.
pub fn proot_args(rootfs: &Path, cwd: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    #[cfg(target_os = "android")]
    args.push("--link2symlink".to_string());

    args.push("--kill-on-exit".to_string());
    args.push("-0".to_string());
    args.push("-r".to_string());
    args.push(rootfs.to_string_lossy().into_owned());

    let mut bind = |host: &str, guest: Option<&str>| {
        if Path::new(host).exists() {
            args.push("-b".to_string());
            match guest {
                Some(g) => args.push(format!("{host}:{g}")),
                None => args.push(host.to_string()),
            }
        }
    };

    // Virtual kernel filesystems (skip /sys on Android, SELinux blocks it).
    bind("/dev", None);
    bind("/proc", None);
    #[cfg(not(target_os = "android"))]
    bind("/sys", None);
    bind("/proc/self/fd", Some("/dev/fd"));

    // Host storage, so project files are reachable from inside the environment.
    for dir in ["/storage", "/sdcard", "/data", "/home", "/tmp"] {
        bind(dir, None);
    }
    let mut target_dir = "/root".to_string();
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        if Path::new(dir).exists() {
            args.push("-b".to_string());
            args.push(format!("{dir}:{dir}"));
            target_dir = dir.to_string();
        }
    }
    args.push("-w".to_string());
    args.push(target_dir);

    args
}

const GUEST_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// Build a `std::process::Command` running PRoot; the caller appends the program
/// to execute inside the rootfs.
pub fn proot_command(app: &AppHandle, cwd: Option<&str>) -> Option<Command> {
    let (proot, rootfs) = ready_paths(app)?;
    let mut cmd = Command::new(&proot);
    cmd.args(proot_args(&rootfs, cwd));
    cmd.env("HOME", "/root");
    cmd.env("TMPDIR", "/tmp");
    cmd.env("PATH", GUEST_PATH);
    if let Ok(tmp) = proot_tmp_dir(app) {
        let _ = fs::create_dir_all(&tmp);
        cmd.env("PROOT_TMP_DIR", &tmp);
    }
    Some(cmd)
}

/// Paths of a PRoot environment that is present on disk, with permissions fixed up.
pub fn ready_paths(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let proot = proot_bin(app).ok()?;
    let rootfs = rootfs_dir(app).ok()?;
    if !proot.exists() || !rootfs_has_shell(&rootfs) {
        return None;
    }
    make_executable(&proot);
    #[cfg(unix)]
    fix_rootfs_permissions(&rootfs);
    Some((proot, rootfs))
}

/// Build CommandBuilder for PRoot executing an Alpine Linux login shell.
pub fn build_proot_command(app: &AppHandle, cwd: Option<&str>) -> Option<CommandBuilder> {
    let (proot, rootfs) = ready_paths(app)?;

    let mut cmd = CommandBuilder::new(proot);
    for arg in proot_args(&rootfs, cwd) {
        cmd.arg(arg);
    }

    cmd.env("TERM", "xterm-256color");
    cmd.env("HOME", "/root");
    cmd.env("TMPDIR", "/tmp");
    cmd.env("PATH", GUEST_PATH);
    if let Ok(tmp) = proot_tmp_dir(app) {
        let _ = fs::create_dir_all(&tmp);
        cmd.env("PROOT_TMP_DIR", tmp.to_string_lossy().into_owned());
    }

    // Login shell
    cmd.args(["/bin/sh", "-l"]);

    Some(cmd)
}
