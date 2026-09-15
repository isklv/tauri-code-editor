//! Git operations and GitHub integration.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitFileChange {
    pub path: String,
    pub full_path: String,
    pub status: String, // "modified" | "added" | "deleted" | "renamed" | "untracked"
    pub staged: bool,
    pub unstaged: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitRepoStatus {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: String,
    pub remote_url: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub staged: Vec<GitFileChange>,
    pub unstaged: Vec<GitFileChange>,
    pub untracked: Vec<GitFileChange>,
    pub total_changes: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitHubUser {
    pub login: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    pub html_url: String,
    #[serde(default)]
    pub public_repos: Option<u32>,
    #[serde(default)]
    pub total_private_repos: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GitHubRepo {
    pub name: String,
    pub full_name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub private: bool,
    pub html_url: String,
    pub clone_url: String,
    #[serde(default = "default_branch_name")]
    pub default_branch: String,
    #[serde(default)]
    pub updated_at: Option<String>,
}

fn default_branch_name() -> String {
    "main".to_string()
}

/// Locate git root directory by walking up from `start`.
pub fn find_git_root(start: &Path) -> Option<PathBuf> {
    let mut current = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };
    loop {
        if current.join(".git").exists() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

/// Execute git command on host or within Alpine PRoot environment.
pub fn run_git(app: Option<&AppHandle>, cwd: &Path, args: &[&str]) -> Result<String, String> {
    let host_result = Command::new("git").current_dir(cwd).args(args).output();

    match host_result {
        Ok(out) => {
            if out.status.success() {
                Ok(String::from_utf8_lossy(&out.stdout).to_string())
            } else {
                let err_msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if err_msg.is_empty() {
                    Err(String::from_utf8_lossy(&out.stdout).trim().to_string())
                } else {
                    Err(err_msg)
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // Check if Alpine PRoot environment has git installed
            if let Some(app) = app {
                if let (Ok(proot), Ok(rootfs)) = (
                    crate::linux_env::proot_bin(app),
                    crate::linux_env::rootfs_dir(app),
                ) {
                    let git_in_rootfs = rootfs.join("usr").join("bin").join("git");
                    if proot.exists() && git_in_rootfs.exists() {
                        let mut cmd = Command::new(proot);
                        cmd.args(["-b", "/dev", "-b", "/proc", "-b", "/sys"]);
                        if Path::new("/storage").exists() {
                            cmd.args(["-b", "/storage"]);
                        }
                        if Path::new("/sdcard").exists() {
                            cmd.args(["-b", "/sdcard"]);
                        }
                        cmd.args(["-r", &rootfs.to_string_lossy(), "-0"]);
                        cmd.args(["-w", &cwd.to_string_lossy()]);
                        cmd.env("HOME", "/root");
                        cmd.env(
                            "PATH",
                            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                        );
                        cmd.arg("/usr/bin/git");
                        cmd.args(args);

                        let proot_out = cmd
                            .output()
                            .map_err(|e| format!("Failed executing git inside Linux env: {e}"))?;
                        if proot_out.status.success() {
                            return Ok(String::from_utf8_lossy(&proot_out.stdout).to_string());
                        } else {
                            let err_msg = String::from_utf8_lossy(&proot_out.stderr)
                                .trim()
                                .to_string();
                            return Err(if err_msg.is_empty() {
                                String::from_utf8_lossy(&proot_out.stdout)
                                    .trim()
                                    .to_string()
                            } else {
                                err_msg
                            });
                        }
                    }
                }
            }
            Err("Git is not installed. You can install git in the terminal (apk add git) or install git on your system.".to_string())
        }
        Err(e) => Err(format!("Failed to execute git: {e}")),
    }
}

/// Read branch name directly from .git/HEAD when available.
pub fn read_git_head(repo_root: &Path) -> Option<String> {
    let head_path = repo_root.join(".git").join("HEAD");
    let content = fs::read_to_string(head_path).ok()?;
    let trimmed = content.trim();
    if let Some(branch) = trimmed.strip_prefix("ref: refs/heads/") {
        Some(branch.to_string())
    } else if trimmed.len() >= 7 {
        Some(trimmed[..7].to_string())
    } else {
        None
    }
}

/// Read remote origin URL directly from .git/config when available.
pub fn read_git_remote_url(repo_root: &Path) -> Option<String> {
    let config_path = repo_root.join(".git").join("config");
    let content = fs::read_to_string(config_path).ok()?;
    let mut in_origin = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == "[remote \"origin\"]" {
            in_origin = true;
            continue;
        }
        if in_origin {
            if trimmed.starts_with('[') {
                break;
            }
            if let Some(val) = trimmed.strip_prefix("url = ") {
                return Some(val.trim().to_string());
            }
            if let Some(val) = trimmed.strip_prefix("url=") {
                return Some(val.trim().to_string());
            }
        }
    }
    None
}

/// Parse `git status --porcelain=v1 -uall` output.
pub fn parse_porcelain_status(
    root: &Path,
    output: &str,
) -> (Vec<GitFileChange>, Vec<GitFileChange>, Vec<GitFileChange>) {
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    for line in output.lines() {
        let line = line.trim_end();
        if line.len() < 3 {
            continue;
        }

        let chars: Vec<char> = line.chars().collect();
        let x = chars[0];
        let y = chars[1];
        let raw_path = line[3..].trim();
        let path = if raw_path.contains(" -> ") {
            raw_path
                .split(" -> ")
                .last()
                .unwrap_or(raw_path)
                .trim_matches('"')
        } else {
            raw_path.trim_matches('"')
        };
        let full_path = root.join(path).to_string_lossy().into_owned();

        if x == '?' && y == '?' {
            untracked.push(GitFileChange {
                path: path.to_string(),
                full_path,
                status: "untracked".to_string(),
                staged: false,
                unstaged: true,
            });
            continue;
        }

        if x != ' ' && x != '?' {
            let status = match x {
                'A' => "added",
                'D' => "deleted",
                'R' => "renamed",
                'C' => "copied",
                _ => "modified",
            };
            staged.push(GitFileChange {
                path: path.to_string(),
                full_path: full_path.clone(),
                status: status.to_string(),
                staged: true,
                unstaged: false,
            });
        }

        if y != ' ' && y != '?' {
            let status = match y {
                'D' => "deleted",
                _ => "modified",
            };
            unstaged.push(GitFileChange {
                path: path.to_string(),
                full_path,
                status: status.to_string(),
                staged: false,
                unstaged: true,
            });
        }
    }

    (staged, unstaged, untracked)
}

/// Get repository status for `path`.
pub fn get_repo_status(app: Option<&AppHandle>, path: &str) -> Result<GitRepoStatus, String> {
    let start_path = PathBuf::from(path);
    let root = match find_git_root(&start_path) {
        Some(r) => r,
        None => {
            return Ok(GitRepoStatus {
                is_repo: false,
                root: None,
                branch: String::new(),
                remote_url: None,
                ahead: 0,
                behind: 0,
                staged: Vec::new(),
                unstaged: Vec::new(),
                untracked: Vec::new(),
                total_changes: 0,
            });
        }
    };

    // 1. Determine branch name
    let branch = run_git(app, &root, &["symbolic-ref", "--short", "HEAD"])
        .map(|b| b.trim().to_string())
        .or_else(|_| {
            run_git(app, &root, &["rev-parse", "--short", "HEAD"]).map(|b| b.trim().to_string())
        })
        .unwrap_or_else(|_| read_git_head(&root).unwrap_or_else(|| "HEAD".to_string()));

    // 2. Determine remote origin URL
    let remote_url = run_git(app, &root, &["config", "--get", "remote.origin.url"])
        .map(|u| u.trim().to_string())
        .ok()
        .filter(|u| !u.is_empty())
        .or_else(|| read_git_remote_url(&root));

    // 3. Ahead / behind counts
    let mut ahead = 0;
    let mut behind = 0;
    if let Ok(counts) = run_git(
        app,
        &root,
        &["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    ) {
        let parts: Vec<&str> = counts.split_whitespace().collect();
        if parts.len() >= 2 {
            ahead = parts[0].parse().unwrap_or(0);
            behind = parts[1].parse().unwrap_or(0);
        }
    }

    // 4. Working tree changes
    let status_out = match run_git(app, &root, &["status", "--porcelain=v1", "-uall"]) {
        Ok(out) => out,
        Err(_e) => {
            // If git command fails (e.g. git binary not found), return minimal status
            return Ok(GitRepoStatus {
                is_repo: true,
                root: Some(root.to_string_lossy().into_owned()),
                branch,
                remote_url,
                ahead: 0,
                behind: 0,
                staged: Vec::new(),
                unstaged: Vec::new(),
                untracked: Vec::new(),
                total_changes: 0,
            });
        }
    };

    let (staged, unstaged, untracked) = parse_porcelain_status(&root, &status_out);
    let total_changes = staged.len() + unstaged.len() + untracked.len();

    Ok(GitRepoStatus {
        is_repo: true,
        root: Some(root.to_string_lossy().into_owned()),
        branch,
        remote_url,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
        total_changes,
    })
}

/// Stage files or all changes.
pub fn stage_files(app: Option<&AppHandle>, path: &str, files: &[String]) -> Result<(), String> {
    let start_path = PathBuf::from(path);
    let root = find_git_root(&start_path).ok_or("Not inside a git repository")?;

    if files.is_empty() || (files.len() == 1 && files[0] == ".") {
        run_git(app, &root, &["add", "-A"])?;
    } else {
        let mut args = vec!["add", "--"];
        let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
        args.extend(file_refs);
        run_git(app, &root, &args)?;
    }
    Ok(())
}

/// Unstage files or all staged changes.
pub fn unstage_files(app: Option<&AppHandle>, path: &str, files: &[String]) -> Result<(), String> {
    let start_path = PathBuf::from(path);
    let root = find_git_root(&start_path).ok_or("Not inside a git repository")?;

    if files.is_empty() || (files.len() == 1 && files[0] == ".") {
        // Unstage all
        if run_git(app, &root, &["restore", "--staged", "."]).is_err() {
            run_git(app, &root, &["reset", "HEAD", "."])?;
        }
    } else {
        let mut args = vec!["restore", "--staged", "--"];
        let file_refs: Vec<&str> = files.iter().map(|s| s.as_str()).collect();
        args.extend(file_refs.clone());
        if run_git(app, &root, &args).is_err() {
            let mut reset_args = vec!["reset", "HEAD", "--"];
            reset_args.extend(file_refs);
            run_git(app, &root, &reset_args)?;
        }
    }
    Ok(())
}

/// Discard changes for files (restores modified/deleted, cleans untracked).
pub fn discard_files(app: Option<&AppHandle>, path: &str, files: &[String]) -> Result<(), String> {
    let start_path = PathBuf::from(path);
    let root = find_git_root(&start_path).ok_or("Not inside a git repository")?;

    for file in files {
        // If file is untracked, clean/delete it
        let _ = run_git(app, &root, &["restore", "--", file]);
        let _ = run_git(app, &root, &["clean", "-fd", "--", file]);
    }
    Ok(())
}

/// Commit staged changes.
pub fn commit(app: Option<&AppHandle>, path: &str, message: &str) -> Result<String, String> {
    let start_path = PathBuf::from(path);
    let root = find_git_root(&start_path).ok_or("Not inside a git repository")?;
    if message.trim().is_empty() {
        return Err("Commit message cannot be empty".to_string());
    }

    run_git(app, &root, &["commit", "-m", message])
}

/// Helper to build authenticated GitHub URL with personal access token.
fn make_authed_url(url: &str, token: &str) -> String {
    let trimmed = url.trim();
    if let Some(rest) = trimmed.strip_prefix("https://github.com/") {
        format!("https://x-access-token:{token}@github.com/{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://github.com/") {
        format!("https://x-access-token:{token}@github.com/{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        format!("https://x-access-token:{token}@github.com/{rest}")
    } else {
        trimmed.to_string()
    }
}

/// Push changes to remote.
pub fn push(app: Option<&AppHandle>, path: &str, token: Option<&str>) -> Result<String, String> {
    let start_path = PathBuf::from(path);
    let root = find_git_root(&start_path).ok_or("Not inside a git repository")?;

    let remote_url = read_git_remote_url(&root);
    let current_branch = run_git(app, &root, &["symbolic-ref", "--short", "HEAD"])
        .map(|b| b.trim().to_string())
        .unwrap_or_else(|_| "main".to_string());

    if let (Some(token), Some(url)) = (token, remote_url) {
        if !token.trim().is_empty() && (url.contains("github.com") || url.starts_with("http")) {
            let authed = make_authed_url(&url, token.trim());
            return run_git(
                app,
                &root,
                &["push", &authed, &format!("HEAD:{current_branch}")],
            );
        }
    }

    run_git(app, &root, &["push"])
}

/// Pull changes from remote.
pub fn pull(app: Option<&AppHandle>, path: &str, token: Option<&str>) -> Result<String, String> {
    let start_path = PathBuf::from(path);
    let root = find_git_root(&start_path).ok_or("Not inside a git repository")?;

    let remote_url = read_git_remote_url(&root);
    let current_branch = run_git(app, &root, &["symbolic-ref", "--short", "HEAD"])
        .map(|b| b.trim().to_string())
        .unwrap_or_else(|_| "main".to_string());

    if let (Some(token), Some(url)) = (token, remote_url) {
        if !token.trim().is_empty() && (url.contains("github.com") || url.starts_with("http")) {
            let authed = make_authed_url(&url, token.trim());
            return run_git(app, &root, &["pull", &authed, &current_branch]);
        }
    }

    run_git(app, &root, &["pull"])
}

/// Fetch from remote.
pub fn fetch(app: Option<&AppHandle>, path: &str, token: Option<&str>) -> Result<String, String> {
    let start_path = PathBuf::from(path);
    let root = find_git_root(&start_path).ok_or("Not inside a git repository")?;

    let remote_url = read_git_remote_url(&root);

    if let (Some(token), Some(url)) = (token, remote_url) {
        if !token.trim().is_empty() && (url.contains("github.com") || url.starts_with("http")) {
            let authed = make_authed_url(&url, token.trim());
            return run_git(app, &root, &["fetch", &authed]);
        }
    }

    run_git(app, &root, &["fetch"])
}

/// Get git diff for a specific file.
pub fn diff_file(
    app: Option<&AppHandle>,
    path: &str,
    file: &str,
    staged: bool,
) -> Result<String, String> {
    let start_path = PathBuf::from(path);
    let root = find_git_root(&start_path).ok_or("Not inside a git repository")?;

    if staged {
        run_git(app, &root, &["diff", "--cached", "--", file])
    } else {
        run_git(app, &root, &["diff", "--", file])
    }
}

/// Show file content from HEAD or index (for Monaco Diff Editor original model).
pub fn show_file(
    app: Option<&AppHandle>,
    path: &str,
    file: &str,
    revision: Option<&str>,
) -> Result<String, String> {
    let start_path = PathBuf::from(path);
    let root = find_git_root(&start_path).ok_or("Not inside a git repository")?;
    let rev = revision.unwrap_or("HEAD");
    let target = format!("{rev}:{file}");

    run_git(app, &root, &["show", &target])
}

/// List local branches.
pub fn list_branches(app: Option<&AppHandle>, path: &str) -> Result<Vec<String>, String> {
    let start_path = PathBuf::from(path);
    let root = find_git_root(&start_path).ok_or("Not inside a git repository")?;

    let out = run_git(
        app,
        &root,
        &["branch", "--list", "--format=%(refname:short)"],
    )?;
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

/// Checkout branch.
pub fn checkout_branch(
    app: Option<&AppHandle>,
    path: &str,
    branch: &str,
) -> Result<String, String> {
    let start_path = PathBuf::from(path);
    let root = find_git_root(&start_path).ok_or("Not inside a git repository")?;

    run_git(app, &root, &["checkout", branch])
}

/// Create and checkout a new branch.
pub fn create_branch(app: Option<&AppHandle>, path: &str, branch: &str) -> Result<String, String> {
    let start_path = PathBuf::from(path);
    let root = find_git_root(&start_path).ok_or("Not inside a git repository")?;

    run_git(app, &root, &["checkout", "-b", branch])
}

/// Normalize GitHub or git URL.
fn normalize_repo_url(url: &str) -> (String, String) {
    let trimmed = url.trim().trim_end_matches('/');
    let clean = if !trimmed.contains("://") && !trimmed.starts_with("git@") {
        if trimmed.starts_with("github.com/") {
            format!("https://{trimmed}")
        } else if trimmed.contains('/') && !trimmed.contains(' ') {
            format!("https://github.com/{trimmed}")
        } else {
            trimmed.to_string()
        }
    } else {
        trimmed.to_string()
    };

    let name = clean
        .split('/')
        .next_back()
        .unwrap_or("repo")
        .trim_end_matches(".git")
        .to_string();

    (clean, name)
}

/// Clone repository to target parent directory.
pub fn clone_repo(
    app: Option<&AppHandle>,
    url: &str,
    target_parent: &str,
    custom_name: Option<&str>,
    token: Option<&str>,
) -> Result<String, String> {
    let (clean_url, repo_name) = normalize_repo_url(url);
    let folder_name = custom_name
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&repo_name);
    let target_dir = PathBuf::from(target_parent).join(folder_name);

    if target_dir.exists() {
        if let Ok(mut read) = fs::read_dir(&target_dir) {
            if read.next().is_some() {
                return Err(format!(
                    "Destination folder '{}' already exists and is not empty",
                    target_dir.display()
                ));
            }
        }
    }

    let clone_url = match token {
        Some(t) if !t.trim().is_empty() && clean_url.contains("github.com") => {
            make_authed_url(&clean_url, t.trim())
        }
        _ => clean_url.clone(),
    };

    let parent_path = Path::new(target_parent);
    if !parent_path.exists() {
        let _ = fs::create_dir_all(parent_path);
    }

    run_git(
        app,
        parent_path,
        &["clone", &clone_url, &target_dir.to_string_lossy()],
    )?;

    // If a token was injected in clone URL, sanitize the stored origin URL so the token is not kept in .git/config
    if token.is_some() {
        let _ = run_git(
            app,
            &target_dir,
            &["remote", "set-url", "origin", &clean_url],
        );
    }

    Ok(target_dir.to_string_lossy().into_owned())
}

/// Fetch user profile from GitHub API.
pub fn github_get_user(token: &str) -> Result<GitHubUser, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("GitHub token cannot be empty".to_string());
    }

    let resp = ureq::get("https://api.github.com/user")
        .header("Authorization", &format!("Bearer {token}"))
        .header("User-Agent", "Tauri-Code-Editor")
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("GitHub API request failed: {e}"))?;

    let mut reader = resp.into_body().into_reader();
    let mut body = String::new();
    reader
        .read_to_string(&mut body)
        .map_err(|e| format!("Failed reading GitHub response: {e}"))?;

    serde_json::from_str::<GitHubUser>(&body)
        .map_err(|e| format!("Failed parsing GitHub user profile: {e}"))
}

/// List repositories of the authenticated GitHub user.
pub fn github_list_repos(token: &str) -> Result<Vec<GitHubRepo>, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("GitHub token cannot be empty".to_string());
    }

    let url = "https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator";
    let resp = ureq::get(url)
        .header("Authorization", &format!("Bearer {token}"))
        .header("User-Agent", "Tauri-Code-Editor")
        .header("Accept", "application/vnd.github+json")
        .call()
        .map_err(|e| format!("GitHub API request failed: {e}"))?;

    let mut reader = resp.into_body().into_reader();
    let mut body = String::new();
    reader
        .read_to_string(&mut body)
        .map_err(|e| format!("Failed reading GitHub response: {e}"))?;

    serde_json::from_str::<Vec<GitHubRepo>>(&body)
        .map_err(|e| format!("Failed parsing GitHub repositories: {e}"))
}
