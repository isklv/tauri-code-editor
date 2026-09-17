fn main() {
    let commit = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|out| {
            if out.status.success() {
                String::from_utf8(out.stdout)
                    .ok()
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        })
        .or_else(|| {
            std::env::var("GITHUB_SHA")
                .ok()
                .map(|s| s.chars().take(7).collect())
        })
        .or_else(|| std::env::var("GIT_COMMIT_HASH").ok());

    if let Some(c) = commit {
        println!("cargo:rustc-env=GIT_COMMIT_HASH={c}");
    }

    tauri_build::build();
}
