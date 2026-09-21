//! Autonomous Linux environment (Alpine Linux + PRoot) for Android and desktop.
//!
//! Downloads and sets up an isolated Alpine Linux user-space environment with the
//! `apk` package manager. Allows running `apk add git`, `apk add go`, `apk add rust cargo`,
//! compilers, and runtimes without root privileges or external apps like Termux.

use std::fs;
use std::io::{BufRead, Write};
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
pub const INSTALL_VERSION: &str = "4";
const MARKER_FILE: &str = ".install-complete";

const ALPINE_BRANCH: &str = "v3.22";
const ALPINE_RELEASE: &str = "3.22.5";

#[derive(Serialize, Clone, Debug)]
pub struct LinuxEnvStatus {
    pub is_installed: bool,
    pub is_installing: bool,
    pub arch: String,
    pub env_dir: Option<String>,
}

#[derive(Serialize, serde::Deserialize, Clone, Debug)]
pub struct AlpineConfig {
    pub current_branch: String,
    pub edge_enabled: bool,
    pub available_branches: Vec<String>,
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

#[derive(Serialize, Clone, Debug)]
pub struct CompletePayload {
    pub message: String,
    /// The environment works, but something in it needs attention — the setup
    /// log stays on screen so the user can see what.
    pub warning: bool,
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

pub fn start_install(
    app: AppHandle,
    state: Arc<InstallState>,
    branch: Option<String>,
) -> Result<(), String> {
    let mut guard = state.is_installing.lock().unwrap();
    if *guard {
        return Err("installation already in progress".to_string());
    }
    *guard = true;
    drop(guard);

    let emitter = app.clone();
    let thread_state = state.clone();

    std::thread::spawn(move || {
        let result = run_install(&app, branch.as_deref());
        *thread_state.is_installing.lock().unwrap() = false;

        match result {
            Ok(note) => {
                let payload = match note {
                    Some(warning) => CompletePayload {
                        message: format!("Alpine Linux ready, but {warning}"),
                        warning: true,
                    },
                    None => CompletePayload {
                        message: "Alpine Linux environment ready! Open terminal to start."
                            .to_string(),
                        warning: false,
                    },
                };
                let _ = emitter.emit("linux-env://complete", payload);
            }
            Err(e) => {
                let _ = emitter.emit("linux-env://error", SimpleMessagePayload { message: e });
            }
        }
    });

    Ok(())
}

/// Append one line to the setup log the terminal panel shows. Progress percentages
/// say how far along the install is; these lines say what it is actually doing,
/// which is what makes a stuck or failed install diagnosable.
pub fn emit_log(app: &AppHandle, line: impl AsRef<str>) {
    let line = line.as_ref();
    eprintln!("linux-env: {line}");
    let _ = app.emit(
        "linux-env://log",
        SimpleMessagePayload {
            message: line.to_string(),
        },
    );
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
fn download_to(url: &str, dest: &Path) -> Result<u64, String> {
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
    fs::rename(&part, dest)
        .map_err(|e| format!("cannot finish writing {}: {e}", dest.display()))?;
    Ok(size)
}

/// Try each URL, a few times each: a phone switching between Wi-Fi and mobile
/// data drops transfers often enough that one failed attempt means little.
fn download_first_working(
    app: &AppHandle,
    urls: &[String],
    dest: &Path,
    verify: impl Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    const ATTEMPTS_PER_URL: u32 = 3;
    let mut last_error = String::from("no download source available");
    for url in urls {
        for attempt in 1..=ATTEMPTS_PER_URL {
            emit_log(app, format!("GET {url} (attempt {attempt})"));
            match download_to(url, dest).and_then(|size| verify(dest).map(|()| size)) {
                Ok(size) => {
                    emit_log(
                        app,
                        format!("saved {} ({})", dest.display(), human_size(size)),
                    );
                    return Ok(());
                }
                Err(e) => {
                    emit_log(app, format!("failed: {e}"));
                    let _ = fs::remove_file(dest);
                    last_error = e;
                    if attempt < ATTEMPTS_PER_URL {
                        std::thread::sleep(std::time::Duration::from_secs(2));
                    }
                }
            }
        }
    }
    Err(last_error)
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    }
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

fn run_install(app: &AppHandle, branch: Option<&str>) -> Result<Option<String>, String> {
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

    emit_log(
        app,
        format!(
            "installing Alpine {ALPINE_RELEASE} for {arch} into {}",
            env_path.display()
        ),
    );

    // 1. Download PRoot binary
    emit_progress(app, "proot", "Downloading PRoot binary (~3 MB)...", 10);
    download_first_working(app, &proot_urls(arch), &proot_path, verify_proot)
        .map_err(|e| format!("could not set up PRoot for {arch}: {e}"))?;

    // 2. Download Alpine Linux rootfs
    emit_progress(
        app,
        "alpine_download",
        "Downloading Alpine Linux rootfs (~3.5 MB)...",
        35,
    );
    let archive_path = env_path.join("alpine-rootfs.tar.gz");
    download_first_working(app, &alpine_urls(arch), &archive_path, verify_gzip)
        .map_err(|e| format!("could not download Alpine rootfs: {e}"))?;

    // 3. Extract rootfs
    emit_progress(
        app,
        "alpine_extract",
        "Extracting Alpine Linux filesystem...",
        55,
    );
    emit_log(app, "unpacking the root filesystem");
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
    configure_rootfs(&rootfs_path, branch)?;
    emit_log(
        app,
        "wrote resolv.conf, apk repositories and the welcome banner",
    );

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
        Ok(()) => {
            emit_log(app, "package index updated, git installed");
            None
        }
        Err(e) => {
            emit_log(app, format!("package setup failed: {e}"));
            Some(format!(
                "package setup failed: {e}. Run `apk update` in the terminal."
            ))
        }
    };

    emit_log(app, "environment ready");
    emit_progress(app, "done", "Alpine Linux environment ready!", 100);
    Ok(warning)
}

/// Shell snippet sourced by every login shell in the guest.
///
/// `rootfs` is the environment's path *on the host*. It is also reachable under
/// that same path from inside the guest, because `/data` (Android) or `/home`
/// is bound straight through -- which is what makes the `GOROOT` workaround
/// below possible.
fn env_script_contents(rootfs: &Path) -> String {
    // The path lands inside a double-quoted shell string.
    let quoted = rootfs
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('$', "\\$")
        .replace('`', "\\`");

    format!(
        r#"export PATH="/root/.bun/bin:/root/.cargo/bin:/root/go/bin:/root/.local/bin:$PATH"
export BUN_INSTALL="/root/.bun"
export TMPDIR="/tmp"
export GOTMPDIR="/tmp"

# Go looks its own tools up with exec.LookPath, which probes them using
# faccessat2(2) -- a syscall PRoot has no table entry for on arm64, so the guest
# path is handed to the host kernel untranslated and comes back ENOENT. `go
# build` then reports its own compiler as missing while `go tool compile` works,
# because that path execs the tool without the probe. The rootfs is visible from
# the host at the path below too, so pointing GOROOT there makes the
# untranslated probe land on the very file it meant to check.
GEKO_ROOTFS="{quoted}"
if [ -z "$GOROOT" ] && [ -x "$GEKO_ROOTFS/usr/lib/go/bin/go" ]; then
  export GOROOT="$GEKO_ROOTFS/usr/lib/go"
fi
"#
    )
}

fn configure_rootfs(rootfs_path: &Path, branch: Option<&str>) -> Result<(), String> {
    let etc_dir = rootfs_path.join("etc");
    fs::create_dir_all(&etc_dir)
        .map_err(|e| format!("cannot create {}: {e}", etc_dir.display()))?;

    // DNS: PRoot exposes no host resolver, so the rootfs needs its own.
    let mut resolv_conf = String::new();
    #[cfg(target_os = "android")]
    {
        for prop in ["net.dns1", "net.dns2", "net.dns3", "net.dns4"] {
            if let Ok(out) = Command::new("getprop").arg(prop).output() {
                let ip = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !ip.is_empty() && (ip.contains('.') || ip.contains(':')) {
                    resolv_conf.push_str(&format!("nameserver {ip}\n"));
                }
            }
        }
    }
    resolv_conf.push_str(
        "nameserver 1.1.1.1\nnameserver 8.8.8.8\nnameserver 1.0.0.1\nnameserver 8.8.4.4\n",
    );
    fs::write(etc_dir.join("resolv.conf"), resolv_conf)
        .map_err(|e| format!("cannot write resolv.conf: {e}"))?;
    let _ = fs::write(
        etc_dir.join("hosts"),
        "127.0.0.1 localhost\n::1 localhost ip6-localhost ip6-loopback\n",
    );

    // APK repositories
    let apk_dir = etc_dir.join("apk");
    fs::create_dir_all(&apk_dir)
        .map_err(|e| format!("cannot create {}: {e}", apk_dir.display()))?;
    let selected_branch = branch.unwrap_or(ALPINE_BRANCH);
    let mut repo_content = format!(
        "https://dl-cdn.alpinelinux.org/alpine/{selected_branch}/main\n\
         https://dl-cdn.alpinelinux.org/alpine/{selected_branch}/community\n"
    );
    if selected_branch != "edge" {
        repo_content.push_str(
            "@edge https://dl-cdn.alpinelinux.org/alpine/edge/main\n\
             @edge https://dl-cdn.alpinelinux.org/alpine/edge/community\n"
        );
    }
    fs::write(apk_dir.join("repositories"), repo_content)
        .map_err(|e| format!("cannot write apk repositories: {e}"))?;

    // Directories apk and ordinary tools expect to be writable.
    for dir in ["tmp", "var/tmp", "var/cache/apk", "root", "dev/shm", "run"] {
        let _ = fs::create_dir_all(rootfs_path.join(dir));
    }
    // Default bunfig.toml to avoid FUSE hardlink ENOENT on Android external storage
    let bunfig = rootfs_path.join("root").join(".bunfig.toml");
    if !bunfig.exists() {
        let _ = fs::write(bunfig, "[install]\nbackend = \"copyfile\"\n");
    }
    // Ensure PATH preserves user-installed toolchains (bun, cargo, go) across directories
    let profile_d = etc_dir.join("profile.d");
    let _ = fs::create_dir_all(&profile_d);
    let env_script = profile_d.join("00-geko-env.sh");
    let script = env_script_contents(rootfs_path);
    let _ = fs::write(&env_script, &script);
    let root_profile = rootfs_path.join("root").join(".profile");
    if !root_profile.exists() {
        let _ = fs::write(&root_profile, &script);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for dir in ["tmp", "var/tmp", "dev/shm"] {
            let _ = fs::set_permissions(rootfs_path.join(dir), fs::Permissions::from_mode(0o1777));
        }
    }

    // Welcome banner
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
    const COMMAND: &str = "apk update && apk add --no-cache git";

    let mut cmd = proot_command(app, None).ok_or("PRoot environment is not ready")?;
    cmd.args(["/bin/sh", "-lc", COMMAND]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    emit_log(app, format!("$ {COMMAND}"));

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot run apk inside the Linux environment: {e}"))?;

    // apk is the slowest part of the install, so its output is streamed into the
    // log as it arrives instead of appearing all at once when it finishes.
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let readers: Vec<_> = [
        child.stdout.take().map(pipe_to_log(app, &tail)),
        child.stderr.take().map(pipe_to_log(app, &tail)),
    ]
    .into_iter()
    .flatten()
    .collect();

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
    for reader in readers {
        let _ = reader.join();
    }

    if status.success() {
        return Ok(());
    }
    let log_tail = tail.lock().unwrap().join(" ");
    Err(if log_tail.trim().is_empty() {
        format!("apk exited with {status}")
    } else {
        log_tail
    })
}

/// Build a closure that drains one of apk's output streams into the setup log,
/// keeping the last few lines around so a failure can quote them.
fn pipe_to_log<R: std::io::Read + Send + 'static>(
    app: &AppHandle,
    tail: &Arc<Mutex<Vec<String>>>,
) -> impl FnOnce(R) -> std::thread::JoinHandle<()> {
    let app = app.clone();
    let tail = tail.clone();
    move |reader| {
        std::thread::spawn(move || {
            for line in std::io::BufReader::new(reader)
                .lines()
                .map_while(Result::ok)
            {
                emit_log(&app, &line);
                let mut tail = tail.lock().unwrap();
                tail.push(line);
                if tail.len() > 3 {
                    tail.remove(0);
                }
            }
        })
    }
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
    // Ensure rootfs tmp, var/tmp, and dev/shm exist and are world-writable with sticky bit (mode 1777)
    for dir_name in ["tmp", "var/tmp", "dev/shm"] {
        let dir = rootfs.join(dir_name);
        let _ = fs::create_dir_all(&dir);
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o1777));
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
pub fn proot_args(rootfs: &Path, cwd: Option<&str>) -> Vec<String> {
    let mut args = if cfg!(target_os = "android") {
        vec!["--link2symlink".to_string()]
    } else {
        Vec::new()
    };
    args.extend([
        "--kill-on-exit".to_string(),
        "-0".to_string(),
        "-r".to_string(),
        rootfs.to_string_lossy().into_owned(),
    ]);

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
    bind("/dev/urandom", Some("/dev/random"));
    bind("/proc", None);
    #[cfg(not(target_os = "android"))]
    bind("/sys", None);
    bind("/proc/self/fd", Some("/dev/fd"));
    bind("/proc/self/fd/0", Some("/dev/stdin"));
    bind("/proc/self/fd/1", Some("/dev/stdout"));
    bind("/proc/self/fd/2", Some("/dev/stderr"));

    // Host storage, so project files are reachable from inside the environment.
    // Note: Do NOT bind host /tmp here; guest Alpine must use its own rootfs /tmp
    // so that compilers (go, gcc, etc.) have full write permissions without host/SELinux interference.
    for dir in ["/storage", "/sdcard", "/data", "/home"] {
        bind(dir, None);
    }
    let mut target_dir = "/root".to_string();
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        let p = Path::new(dir);
        if let Ok(rel) = p.strip_prefix(rootfs) {
            target_dir = format!("/{}", rel.to_string_lossy());
        } else if p.exists() {
            args.push("-b".to_string());
            args.push(format!("{dir}:{dir}"));
            target_dir = dir.to_string();
        }
    }
    args.push("-w".to_string());
    args.push(target_dir);

    args
}

const GUEST_PATH: &str =
    "/root/.bun/bin:/root/.cargo/bin:/root/go/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// A directory on the host that PRoot can be started from: the project folder
/// when it is usable, otherwise `fallback` (the app's own data directory),
/// otherwise `/`. Whatever comes back must exist, or the spawn fails outright.
pub fn host_start_dir(fallback: Option<PathBuf>, cwd: Option<&str>) -> PathBuf {
    cwd.filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| fallback.filter(|p| p.is_dir()))
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Build a `std::process::Command` running PRoot; the caller appends the program
/// to execute inside the rootfs.
pub fn proot_command(app: &AppHandle, cwd: Option<&str>) -> Option<Command> {
    let (proot, rootfs) = ready_paths(app)?;
    let mut cmd = Command::new(&proot);
    cmd.args(proot_args(&rootfs, cwd));
    cmd.current_dir(host_start_dir(env_dir(app).ok(), cwd));
    cmd.env("HOME", "/root");
    cmd.env("TMPDIR", "/tmp");
    cmd.env("PATH", GUEST_PATH);
    cmd.env("BUN_INSTALL", "/root/.bun");
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
    // Ensure bunfig.toml exists in /root
    let bunfig = rootfs.join("root").join(".bunfig.toml");
    if !bunfig.exists() {
        let _ = fs::write(bunfig, "[install]\nbackend = \"copyfile\"\n");
    }
    // Rewrite the environment script on every launch rather than only when it is
    // missing: environments installed by an older build carry a stale copy, and
    // the GOROOT line in it depends on where the rootfs currently lives.
    let script = env_script_contents(&rootfs);
    let profile_d = rootfs.join("etc").join("profile.d");
    if profile_d.exists() {
        let _ = fs::write(profile_d.join("00-geko-env.sh"), &script);
    }
    let root_profile = rootfs.join("root").join(".profile");
    if !root_profile.exists() {
        let _ = fs::write(&root_profile, &script);
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

    // PRoot itself starts on the host, so it needs a working directory that
    // exists *there*. Without this, portable-pty falls back to $HOME — which we
    // set to the guest's /root, a path Android has no equivalent of, and the
    // spawn fails with "No such file or directory" before PRoot ever runs.
    cmd.cwd(host_start_dir(env_dir(app).ok(), cwd));

    cmd.env("TERM", "xterm-256color");
    cmd.env("HOME", "/root");
    cmd.env("TMPDIR", "/tmp");
    cmd.env("PATH", GUEST_PATH);
    cmd.env("BUN_INSTALL", "/root/.bun");
    if let Ok(tmp) = proot_tmp_dir(app) {
        let _ = fs::create_dir_all(&tmp);
        cmd.env("PROOT_TMP_DIR", tmp.to_string_lossy().into_owned());
    }

    // Login shell
    cmd.args(["/bin/sh", "-l"]);

    Some(cmd)
}

pub fn get_alpine_config(app: &AppHandle) -> Result<AlpineConfig, String> {
    let available = vec!["v3.22".to_string(), "v3.23".to_string(), "edge".to_string()];
    let rootfs = match rootfs_dir(app) {
        Ok(dir) => dir,
        Err(_) => {
            return Ok(AlpineConfig {
                current_branch: ALPINE_BRANCH.to_string(),
                edge_enabled: false,
                available_branches: available,
            });
        }
    };

    let repos_file = rootfs.join("etc").join("apk").join("repositories");
    if !repos_file.exists() {
        return Ok(AlpineConfig {
            current_branch: ALPINE_BRANCH.to_string(),
            edge_enabled: false,
            available_branches: available,
        });
    }

    let content = fs::read_to_string(&repos_file).map_err(|e| format!("cannot read repositories: {e}"))?;
    let mut current_branch = ALPINE_BRANCH.to_string();
    let mut edge_enabled = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("@edge") {
            edge_enabled = true;
            continue;
        }
        if trimmed.contains("/alpine/edge/") {
            current_branch = "edge".to_string();
        } else if let Some(idx) = trimmed.find("/alpine/v") {
            let after = &trimmed[idx + "/alpine/".len()..];
            if let Some(slash_idx) = after.find('/') {
                current_branch = after[..slash_idx].to_string();
            }
        }
    }

    Ok(AlpineConfig {
        current_branch,
        edge_enabled,
        available_branches: available,
    })
}

pub fn set_alpine_branch(
    app: &AppHandle,
    branch: String,
    enable_edge: bool,
    run_upgrade: bool,
) -> Result<(), String> {
    let rootfs = rootfs_dir(app)?;
    if !is_installed(app) {
        return Err("Alpine Linux environment is not installed".to_string());
    }

    let etc_dir = rootfs.join("etc");
    let apk_dir = etc_dir.join("apk");
    fs::create_dir_all(&apk_dir)
        .map_err(|e| format!("cannot create apk directory: {e}"))?;

    let mut repo_content = format!(
        "https://dl-cdn.alpinelinux.org/alpine/{branch}/main\n\
         https://dl-cdn.alpinelinux.org/alpine/{branch}/community\n"
    );
    if enable_edge && branch != "edge" {
        repo_content.push_str(
            "@edge https://dl-cdn.alpinelinux.org/alpine/edge/main\n\
             @edge https://dl-cdn.alpinelinux.org/alpine/edge/community\n"
        );
    }
    fs::write(apk_dir.join("repositories"), repo_content)
        .map_err(|e| format!("cannot write apk repositories: {e}"))?;

    let app_clone = app.clone();
    let branch_clone = branch.clone();
    std::thread::spawn(move || {
        emit_log(&app_clone, format!("Switching Alpine branch to {branch_clone}..."));
        let cmd_str = if run_upgrade {
            "apk update && apk upgrade --no-cache"
        } else {
            "apk update"
        };
        emit_log(&app_clone, format!("$ {cmd_str}"));
        if let Some(mut cmd) = proot_command(&app_clone, None) {
            cmd.args(["/bin/sh", "-lc", cmd_str]);
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            if let Ok(mut child) = cmd.spawn() {
                let tail = Arc::new(Mutex::new(Vec::<String>::new()));
                let r1 = child.stdout.take().map(pipe_to_log(&app_clone, &tail));
                let r2 = child.stderr.take().map(pipe_to_log(&app_clone, &tail));
                if let Some(r) = r1 {
                    let _ = r.join();
                }
                if let Some(r) = r2 {
                    let _ = r.join();
                }
                let _ = child.wait();
            }
        }
        emit_log(&app_clone, format!("Alpine branch switched to {branch_clone} successfully!"));
        let _ = app_clone.emit(
            "linux-env://complete",
            CompletePayload {
                message: format!("Alpine switched to {branch_clone}!"),
                warning: false,
            },
        );
    });

    Ok(())
}
