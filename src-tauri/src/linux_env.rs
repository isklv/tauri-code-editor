//! Autonomous Linux environment (Alpine Linux + PRoot) for Android and desktop.
//!
//! Downloads and sets up an isolated Alpine Linux user-space environment with the
//! `apk` package manager. Allows running `apk add git`, `apk add go`, `apk add rust cargo`,
//! compilers, and runtimes without root privileges or external apps like Termux.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use flate2::read::GzDecoder;
use portable_pty::CommandBuilder;
use serde::Serialize;
use tar::Archive;
use tauri::{AppHandle, Emitter, Manager};

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

fn proot_url(arch: &str) -> &'static str {
    match arch {
        "aarch64" => {
            "https://github.com/proot-me/proot/releases/download/v5.3.0/proot-v5.3.0-aarch64-static"
        }
        "arm" => {
            "https://github.com/proot-me/proot/releases/download/v5.3.0/proot-v5.3.0-arm-static"
        }
        _ => {
            "https://github.com/proot-me/proot/releases/download/v5.3.0/proot-v5.3.0-x86_64-static"
        }
    }
}

fn alpine_url(arch: &str) -> &'static str {
    match arch {
        "aarch64" => {
            "https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/aarch64/alpine-minirootfs-3.20.3-aarch64.tar.gz"
        }
        "arm" => {
            "https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/armv7/alpine-minirootfs-3.20.3-armv7.tar.gz"
        }
        _ => {
            "https://dl-cdn.alpinelinux.org/alpine/v3.20/releases/x86_64/alpine-minirootfs-3.20.3-x86_64.tar.gz"
        }
    }
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

pub fn is_installed(app: &AppHandle) -> bool {
    let (Ok(proot), Ok(rootfs)) = (proot_bin(app), rootfs_dir(app)) else {
        return false;
    };
    proot.exists() && rootfs.join("bin").join("sh").exists()
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
            Ok(()) => {
                let _ = emitter.emit(
                    "linux-env://complete",
                    SimpleMessagePayload {
                        message: "Alpine Linux environment ready! Open terminal to start."
                            .to_string(),
                    },
                );
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

fn run_install(app: &AppHandle) -> Result<(), String> {
    let arch = target_arch();
    let env_path = env_dir(app)?;
    let bin_path = env_path.join("bin");
    let proot_path = bin_path.join("proot");
    let rootfs_path = env_path.join("alpine");

    fs::create_dir_all(&bin_path)
        .map_err(|e| format!("cannot create bin directory {}: {e}", bin_path.display()))?;
    fs::create_dir_all(&rootfs_path).map_err(|e| {
        format!(
            "cannot create rootfs directory {}: {e}",
            rootfs_path.display()
        )
    })?;

    // 1. Download PRoot binary
    emit_progress(app, "proot", "Downloading PRoot binary (~3 MB)...", 15);
    let p_url = proot_url(arch);
    let resp = ureq::get(p_url)
        .call()
        .map_err(|e| format!("failed to download PRoot from {p_url}: {e}"))?;
    let mut reader = resp.into_body().into_reader();
    let mut file = fs::File::create(&proot_path)
        .map_err(|e| format!("cannot create {}: {e}", proot_path.display()))?;
    std::io::copy(&mut reader, &mut file)
        .map_err(|e| format!("failed writing {}: {e}", proot_path.display()))?;
    drop(file);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&proot_path, fs::Permissions::from_mode(0o755));
    }

    // 2. Download Alpine Linux rootfs
    emit_progress(
        app,
        "alpine_download",
        "Downloading Alpine Linux rootfs (~3.5 MB)...",
        45,
    );
    let a_url = alpine_url(arch);
    let a_resp = ureq::get(a_url)
        .call()
        .map_err(|e| format!("failed to download Alpine from {a_url}: {e}"))?;
    let a_reader = a_resp.into_body().into_reader();

    // 3. Extract rootfs
    emit_progress(
        app,
        "alpine_extract",
        "Extracting Alpine Linux filesystem...",
        75,
    );
    let gz = GzDecoder::new(a_reader);
    let mut archive = Archive::new(gz);
    archive.set_preserve_permissions(true);
    archive
        .unpack(&rootfs_path)
        .map_err(|e| format!("failed to extract rootfs to {}: {e}", rootfs_path.display()))?;

    #[cfg(unix)]
    fix_rootfs_permissions(&rootfs_path);

    // 4. Configure DNS (resolv.conf)
    emit_progress(
        app,
        "configure",
        "Configuring network and package mirrors...",
        90,
    );
    let etc_dir = rootfs_path.join("etc");
    let _ = fs::create_dir_all(&etc_dir);
    let resolv_file = etc_dir.join("resolv.conf");
    let _ = fs::write(&resolv_file, "nameserver 1.1.1.1\nnameserver 8.8.8.8\n");

    // 5. Configure APK repositories
    let apk_dir = etc_dir.join("apk");
    let _ = fs::create_dir_all(&apk_dir);
    let repos_file = apk_dir.join("repositories");
    let _ = fs::write(
        &repos_file,
        "https://dl-cdn.alpinelinux.org/alpine/v3.20/main\nhttps://dl-cdn.alpinelinux.org/alpine/v3.20/community\n",
    );

    // 6. Setup welcome banner in /etc/profile.d/welcome.sh
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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&welcome_file, fs::Permissions::from_mode(0o755));
    }

    emit_progress(app, "done", "Alpine Linux environment ready!", 100);
    Ok(())
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

/// Build CommandBuilder for PRoot executing Alpine Linux.
pub fn build_proot_command(app: &AppHandle, cwd: Option<&str>) -> Option<CommandBuilder> {
    let proot = proot_bin(app).ok()?;
    let rootfs = rootfs_dir(app).ok()?;

    if !proot.exists() || !rootfs.join("bin").join("sh").exists() {
        return None;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&proot, fs::Permissions::from_mode(0o755));
        fix_rootfs_permissions(&rootfs);
    }

    let mut cmd = CommandBuilder::new(proot);

    #[cfg(target_os = "android")]
    cmd.arg("--link2symlink");

    cmd.arg("-0");
    cmd.args(["-r", &rootfs.to_string_lossy()]);

    // Virtual kernel filesystems: bind dev and proc (skip /sys on Android due to SELinux)
    cmd.args(["-b", "/dev", "-b", "/proc"]);
    #[cfg(not(target_os = "android"))]
    if Path::new("/sys").exists() {
        cmd.args(["-b", "/sys"]);
    }

    // Mount storage and host directories so files can be accessed
    if Path::new("/storage").exists() {
        cmd.args(["-b", "/storage"]);
    }
    if Path::new("/sdcard").exists() {
        cmd.args(["-b", "/sdcard"]);
    }
    if Path::new("/data").exists() {
        cmd.args(["-b", "/data"]);
    }
    if Path::new("/home").exists() {
        cmd.args(["-b", "/home"]);
    }
    if Path::new("/tmp").exists() {
        cmd.args(["-b", "/tmp"]);
    }

    // Bind working directory specifically if not already within standard mounts
    let mut target_dir = "/root".to_string();
    if let Some(dir) = cwd.filter(|d| !d.is_empty()) {
        let p = Path::new(dir);
        if p.exists() {
            cmd.args(["-b", &format!("{dir}:{dir}")]);
            target_dir = dir.to_string();
        }
    }
    cmd.args(["-w", &target_dir]);

    cmd.env("TERM", "xterm-256color");
    cmd.env("HOME", "/root");
    cmd.env(
        "PATH",
        "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    );

    // Login shell
    cmd.args(["/bin/sh", "-l"]);

    Some(cmd)
}
