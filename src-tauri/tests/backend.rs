//! Backend tests: the file-system helpers and the PTY the terminal panel talks to.

use std::io::Read;
use std::time::{Duration, Instant};
use std::{env, fs};

use tauri_code_editor::{
    normalize_path, read_dir_listing, read_text_file, spawn_shell, write_text_file,
};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = env::temp_dir().join(format!("geko-test-{name}"));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn listing_puts_directories_first_and_sorts_case_insensitively() {
    let dir = temp_dir("listing");
    fs::create_dir(dir.join("zebra")).unwrap();
    fs::write(dir.join("Alpha.txt"), "a").unwrap();
    fs::write(dir.join("beta.txt"), "bb").unwrap();

    let listing = read_dir_listing(&dir).unwrap();
    let names: Vec<_> = listing.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, ["zebra", "Alpha.txt", "beta.txt"]);
    assert!(listing.entries[0].is_dir);
    assert_eq!(listing.entries[2].size, 2);
    assert_eq!(listing.parent.as_deref(), dir.parent().unwrap().to_str());
}

#[test]
fn write_then_read_round_trips_and_creates_parents() {
    let dir = temp_dir("roundtrip");
    let file = dir.join("nested/deeper/notes.md");

    write_text_file(&file, "# hello\nпривет\n").unwrap();
    assert_eq!(read_text_file(&file).unwrap(), "# hello\nпривет\n");
}

#[test]
fn reading_a_binary_file_is_refused() {
    let dir = temp_dir("binary");
    let file = dir.join("blob.bin");
    fs::write(&file, [0x89, 0x50, 0x00, 0x01]).unwrap();

    let err = read_text_file(&file).unwrap_err();
    assert!(err.contains("binary"), "unexpected error: {err}");
}

#[test]
fn reading_a_missing_file_reports_the_path_problem() {
    let err = read_text_file(&temp_dir("missing").join("nope.txt")).unwrap_err();
    assert!(err.contains("cannot stat file"), "unexpected error: {err}");
}

#[test]
fn shell_round_trips_input_and_output_through_the_pty() {
    let dir = temp_dir("pty");
    let (mut session, mut reader) = spawn_shell(dir.to_str(), 80, 24).unwrap();

    // Read on a worker thread: the PTY never reaches EOF while the shell lives.
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                break;
            }
        }
    });

    // The arithmetic keeps the marker out of the echoed command line, so finding
    // it proves the shell actually ran what we wrote rather than just echoing it.
    // Wait for the shell to finish drawing its first prompt. Writing before
    // readline is ready gets the line echoed but never executed.
    let mut output = String::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline && !output.contains("2004h") {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(500)) {
            output.push_str(&String::from_utf8_lossy(&chunk));
        }
    }
    assert!(!output.is_empty(), "shell produced no output at all");

    // The arithmetic keeps the marker out of the echoed command line, so finding
    // it proves the shell actually ran what we wrote rather than just echoing it.
    session.write("echo pty-marker-$((6 * 7))\n").unwrap();

    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline && !output.contains("pty-marker-42") {
        if let Ok(chunk) = rx.recv_timeout(Duration::from_millis(500)) {
            output.push_str(&String::from_utf8_lossy(&chunk));
        }
    }

    session.resize(100, 30).unwrap();
    session.kill();

    assert!(
        output.contains("pty-marker-42"),
        "shell output never showed the marker; got: {output:?}"
    );
}

#[test]
fn quick_open_matches_subsequences_and_skips_heavy_directories() {
    let dir = temp_dir("search");
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::create_dir_all(dir.join("node_modules/left-pad")).unwrap();
    fs::write(dir.join("src/main.js"), "").unwrap();
    fs::write(dir.join("src/helper.rs"), "").unwrap();
    fs::write(dir.join("README.md"), "").unwrap();
    fs::write(dir.join("node_modules/left-pad/index.js"), "").unwrap();

    let all = tauri_code_editor::search_files(&dir, "");
    let names: Vec<_> = all.iter().map(|p| p.rsplit('/').next().unwrap()).collect();
    assert!(names.contains(&"main.js"), "got {names:?}");
    assert!(names.contains(&"README.md"), "got {names:?}");
    assert!(
        !names.contains(&"index.js"),
        "node_modules must be skipped: {names:?}"
    );

    // Subsequence across the relative path, the way quick-open palettes behave.
    let hits = tauri_code_editor::search_files(&dir, "smjs");
    assert_eq!(hits.len(), 1, "got {hits:?}");
    assert!(hits[0].ends_with("src/main.js"));

    // Shallower paths sort first.
    let sorted = tauri_code_editor::search_files(&dir, "e");
    assert!(sorted[0].ends_with("README.md"), "got {sorted:?}");
}

#[test]
fn watching_directory_detects_changes() {
    use notify::Watcher;
    let dir = temp_dir("watcher");
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let _ = tx.send(event);
            }
        })
        .unwrap();

    watcher
        .watch(&dir, notify::RecursiveMode::Recursive)
        .unwrap();

    let file = dir.join("new_file.txt");
    fs::write(&file, "hello").unwrap();

    let event = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("did not receive file event");
    assert!(event.paths.iter().any(|p| p.ends_with("new_file.txt")));
}

#[test]
fn tar_gz_unpack_works() {
    use flate2::read::GzDecoder;
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use tar::{Archive, Builder};

    let dir = temp_dir("tar");
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    {
        let mut builder = Builder::new(&mut enc);
        let mut header = tar::Header::new_gnu();
        header.set_size(11);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, "hello.txt", &b"hello world"[..])
            .unwrap();
    }
    let compressed = enc.finish().unwrap();

    let tar = GzDecoder::new(&compressed[..]);
    let mut archive = Archive::new(tar);
    archive.unpack(&dir).unwrap();

    assert_eq!(
        fs::read_to_string(dir.join("hello.txt")).unwrap(),
        "hello world"
    );
}

#[test]
fn linux_env_target_arch_is_valid() {
    let arch = tauri_code_editor::linux_env::target_arch();
    assert!(!arch.is_empty());
    assert!(["aarch64", "arm", "x86_64"].contains(&arch));
}

#[test]
fn linux_env_counts_as_installed_only_when_the_install_finished() {
    use tauri_code_editor::linux_env::{env_is_complete, INSTALL_VERSION};

    let dir = temp_dir("linux-env-complete");
    fs::create_dir_all(dir.join("bin")).unwrap();
    fs::create_dir_all(dir.join("alpine").join("bin")).unwrap();

    // Files downloaded but the install never reached the end.
    fs::write(dir.join("bin").join("proot"), "binary").unwrap();
    fs::write(dir.join("alpine").join("bin").join("sh"), "shell").unwrap();
    assert!(!env_is_complete(&dir));

    // A marker from an older layout does not count either.
    fs::write(dir.join(".install-complete"), "0").unwrap();
    assert!(!env_is_complete(&dir));

    fs::write(
        dir.join(".install-complete"),
        format!("{INSTALL_VERSION}\n"),
    )
    .unwrap();
    assert!(env_is_complete(&dir));

    // Alpine ships /bin/sh as a symlink to the absolute path /bin/busybox, which
    // only resolves inside PRoot. Following it from the host must not make a
    // perfectly good environment look uninstalled.
    let shell = dir.join("alpine").join("bin").join("sh");
    fs::remove_file(&shell).unwrap();
    std::os::unix::fs::symlink("/no-such-root/bin/busybox", &shell).unwrap();
    assert!(
        !shell.exists(),
        "the symlink target must not resolve on the host"
    );
    assert!(env_is_complete(&dir));

    // Losing the PRoot binary makes the environment unusable again.
    fs::remove_file(dir.join("bin").join("proot")).unwrap();
    assert!(!env_is_complete(&dir));
}

#[test]
fn proot_arguments_root_the_shell_in_the_alpine_filesystem() {
    use tauri_code_editor::linux_env::proot_args;

    let rootfs = temp_dir("linux-env-args");
    let cwd = temp_dir("linux-env-project");
    let args = proot_args(&rootfs, cwd.to_str());

    // Root emulation plus the rootfs are what make apk able to write to /usr.
    assert!(args.contains(&"-0".to_string()));
    let root_at = args.iter().position(|a| a == "-r").expect("rootfs flag");
    assert_eq!(args[root_at + 1], rootfs.to_string_lossy());

    // /dev and /proc must be visible inside, or the shell has no terminal.
    for mount in ["/dev", "/proc"] {
        assert!(
            args.contains(&mount.to_string()),
            "missing bind for {mount}"
        );
    }

    // The project directory is bound under its own path and used as the cwd.
    let work_at = args.iter().position(|a| a == "-w").expect("workdir flag");
    assert_eq!(args[work_at + 1], cwd.to_string_lossy());
    assert!(args.contains(&format!("{0}:{0}", cwd.to_string_lossy())));

    // Without a project directory the shell starts in the rootfs home.
    let home_args = proot_args(&rootfs, None);
    let home_at = home_args.iter().position(|a| a == "-w").unwrap();
    assert_eq!(home_args[home_at + 1], "/root");
}

#[test]
fn proot_always_starts_from_a_directory_that_exists_on_the_host() {
    use std::path::PathBuf;
    use tauri_code_editor::linux_env::host_start_dir;

    let project = temp_dir("linux-env-project-dir");
    let app_data = temp_dir("linux-env-app-data");

    assert_eq!(host_start_dir(None, project.to_str()), project);

    // PRoot itself runs on the host, so a project folder that is gone must never
    // reach the spawn: it fails with "No such file or directory" before PRoot
    // has a chance to enter the rootfs.
    assert_eq!(
        host_start_dir(Some(app_data.clone()), Some("/no/such/project")),
        app_data
    );
    assert_eq!(
        host_start_dir(Some(PathBuf::from("/no/such/dir")), Some("")),
        PathBuf::from("/")
    );
    assert_eq!(host_start_dir(None, None), PathBuf::from("/"));
}

#[test]
fn git_porcelain_parsing_categorizes_correctly() {
    use tauri_code_editor::git::parse_porcelain_status;
    let root = std::path::Path::new("/dummy/repo");
    let output = " M src/main.js\nM  src/file.js\nMM src/both.js\n?? untracked.txt\nA  added.txt\n D deleted.txt\n";

    let (staged, unstaged, untracked) = parse_porcelain_status(root, output);

    assert_eq!(staged.len(), 3); // file.js (M), both.js (M), added.txt (A)
    assert_eq!(unstaged.len(), 3); // main.js (M), both.js (M), deleted.txt (D)
    assert_eq!(untracked.len(), 1); // untracked.txt

    assert_eq!(staged[0].path, "src/file.js");
    assert_eq!(staged[0].status, "modified");
    assert!(staged[0].staged);

    assert_eq!(untracked[0].path, "untracked.txt");
    assert_eq!(untracked[0].status, "untracked");
}

#[test]
fn git_find_root_and_read_head() {
    use tauri_code_editor::git::{find_git_root, read_git_head};
    let dir = temp_dir("git-root-test");
    let git_dir = dir.join(".git");
    fs::create_dir_all(&git_dir).unwrap();
    fs::write(git_dir.join("HEAD"), "ref: refs/heads/feature/branch-x\n").unwrap();

    let sub_dir = dir.join("nested").join("folder");
    fs::create_dir_all(&sub_dir).unwrap();

    let found = find_git_root(&sub_dir).expect("should find root");
    assert_eq!(found, dir);

    let branch = read_git_head(&dir).expect("should read branch");
    assert_eq!(branch, "feature/branch-x");
}

#[test]
fn git_repo_status_on_local_repo() {
    use tauri_code_editor::git::{commit, get_repo_status, stage_files};
    let dir = temp_dir("git-status-test");

    // Initialize repo using git CLI
    let init_res = std::process::Command::new("git")
        .current_dir(&dir)
        .args(["init", "-b", "main"])
        .output();
    if init_res.is_err() || !init_res.as_ref().unwrap().status.success() {
        // Fallback for older git without -b
        let _ = std::process::Command::new("git")
            .current_dir(&dir)
            .args(["init"])
            .output();
    }
    // Set dummy config for commit
    let _ = std::process::Command::new("git")
        .current_dir(&dir)
        .args(["config", "user.name", "Test"])
        .output();
    let _ = std::process::Command::new("git")
        .current_dir(&dir)
        .args(["config", "user.email", "test@example.com"])
        .output();

    fs::write(dir.join("readme.md"), "# Hello").unwrap();

    let status = get_repo_status(None, dir.to_str().unwrap()).unwrap();
    assert!(status.is_repo);
    assert_eq!(status.untracked.len(), 1);
    assert_eq!(status.untracked[0].path, "readme.md");

    // Stage
    stage_files(None, dir.to_str().unwrap(), &["readme.md".to_string()]).unwrap();
    let status_staged = get_repo_status(None, dir.to_str().unwrap()).unwrap();
    assert_eq!(status_staged.staged.len(), 1);

    // Commit
    commit(None, dir.to_str().unwrap(), "Initial commit").unwrap();
    let status_clean = get_repo_status(None, dir.to_str().unwrap()).unwrap();
    assert_eq!(status_clean.total_changes, 0);
}

#[test]
fn normalize_path_resolves_parent_and_current_segments_lexically() {
    use std::path::Path;

    let p = Path::new("/storage/emulated/0/Documents/../Download");
    assert_eq!(normalize_path(p), Path::new("/storage/emulated/0/Download"));

    let p2 = Path::new("/storage/emulated/0/./Documents/Projects");
    assert_eq!(normalize_path(p2), Path::new("/storage/emulated/0/Documents/Projects"));
}
