//! Backend tests: the file-system helpers and the PTY the terminal panel talks to.

use std::io::Read;
use std::time::{Duration, Instant};
use std::{env, fs};

use tauri_code_editor::{read_dir_listing, read_text_file, spawn_shell, write_text_file};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = env::temp_dir().join(format!("tauri-code-editor-test-{name}"));
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
