/**
 * Backend bridge.
 *
 * Inside Tauri every call goes to a Rust command. In a plain browser
 * (`npm run dev` without Tauri) the same API is served by a small in-memory
 * demo workspace, so the UI can be developed without building the shell.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// ── Demo workspace (browser-only fallback) ──

const DEMO_ROOT = '/demo';
const demoFiles = new Map([
  ['/demo/README.md', '# Demo workspace\n\nYou are running the editor in a browser.\nStart it with `npm run tauri:dev` to get a real file system and terminal.\n'],
  ['/demo/src/main.js', "console.log('hello from the demo workspace');\n"],
  ['/demo/src/style.css', 'body {\n  margin: 0;\n}\n'],
  ['/demo/package.json', '{\n  "name": "demo",\n  "version": "1.0.0"\n}\n'],
]);

function demoList(path) {
  const dir = path && path !== '' ? path.replace(/\/+$/, '') || '/' : DEMO_ROOT;
  const prefix = dir === '/' ? '/' : dir + '/';
  const names = new Map();
  for (const filePath of demoFiles.keys()) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    const slash = rest.indexOf('/');
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (name) names.set(name, slash !== -1);
  }
  const entries = [...names].map(([name, isDir]) => ({
    name,
    path: prefix + name,
    is_dir: isDir,
    size: isDir ? 0 : (demoFiles.get(prefix + name) || '').length,
  }));
  entries.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.localeCompare(b.name));
  const parent = dir === '/' ? null : dir.slice(0, dir.lastIndexOf('/')) || '/';
  return { path: dir, parent, entries };
}

// ── File system ──

export async function defaultRoot() {
  return isTauri ? invoke('default_root') : DEMO_ROOT;
}

/** Named starting folders (Home, Downloads, app storage, …) that are readable. */
export async function quickRoots() {
  return isTauri ? invoke('quick_roots') : [{ name: 'Demo', path: DEMO_ROOT }];
}

/** Quick-open search: files under `root` fuzzy-matching `query`. */
export async function findFiles(root, query) {
  if (isTauri) return invoke('find_files', { root, query });
  return [...demoFiles.keys()].filter((p) => p.startsWith(root) && fuzzyMatch(p, query));
}

function fuzzyMatch(haystack, needle) {
  if (!needle) return true;
  const hay = haystack.toLowerCase();
  let i = 0;
  for (const ch of needle.toLowerCase()) {
    i = hay.indexOf(ch, i) + 1;
    if (i === 0) return false;
  }
  return true;
}

export async function listDir(path) {
  return isTauri ? invoke('list_dir', { path: path ?? null }) : demoList(path);
}

export async function readFile(path) {
  if (isTauri) return invoke('read_file_text', { path });
  if (!demoFiles.has(path)) throw new Error(`no such file: ${path}`);
  return demoFiles.get(path);
}

export async function writeFile(path, content) {
  if (isTauri) return invoke('write_file_text', { path, content });
  demoFiles.set(path, content);
}

export async function createEntry(path, isDir) {
  if (isTauri) return invoke('create_entry', { path, isDir });
  if (!isDir) demoFiles.set(path, '');
}

export async function renameEntry(from, to) {
  if (isTauri) return invoke('rename_entry', { from, to });
  if (demoFiles.has(from)) {
    demoFiles.set(to, demoFiles.get(from));
    demoFiles.delete(from);
  }
}

export async function deleteEntry(path) {
  if (isTauri) return invoke('delete_entry', { path });
  for (const key of [...demoFiles.keys()]) {
    if (key === path || key.startsWith(path + '/')) demoFiles.delete(key);
  }
}

export async function watchDir(path) {
  if (isTauri) return invoke('watch_dir', { path });
}

export async function unwatchDir() {
  if (isTauri) return invoke('unwatch_dir');
}

/** Subscribe to file system changes; callback receives list of changed paths. */
export async function onFsChange(callback) {
  if (!isTauri) return () => {};
  return listen('fs://change', (event) => callback(event.payload));
}

/**
 * True when the system folder picker returns a usable filesystem path.
 * Android's picker hands back `content://` URIs that `std::fs` cannot open,
 * so there the app browses folders in its own explorer instead.
 */
export const hasNativeFolderPicker = isTauri && !/android/i.test(navigator.userAgent);

export async function pickFolder(defaultPath) {
  if (!hasNativeFolderPicker) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: false, defaultPath });
  return typeof selected === 'string' ? selected : null;
}

export async function pickSavePath(defaultPath) {
  if (!isTauri) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  return (await save({ defaultPath })) || null;
}

// ── Terminal ──

export async function ptyStart(cwd, cols, rows, shellMode = null) {
  if (!isTauri) throw new Error('terminal requires the desktop app');
  return invoke('pty_start', { cwd, cols, rows, shellMode });
}

export async function ptyWrite(data) {
  if (!isTauri) return;
  return invoke('pty_write', { data });
}

export async function ptyResize(cols, rows) {
  if (!isTauri) return;
  return invoke('pty_resize', { cols, rows });
}

export async function ptyKill() {
  if (!isTauri) return;
  return invoke('pty_kill');
}

/** Subscribe to PTY output; the callback receives a Uint8Array. */
export async function onPtyOutput(callback) {
  if (!isTauri) return () => {};
  return listen('pty://output', (event) => callback(Uint8Array.from(event.payload)));
}

/** Subscribe to shell exit. */
export async function onPtyExit(callback) {
  if (!isTauri) return () => {};
  return listen('pty://exit', (event) => callback(event.payload));
}

// ── Autonomous Linux Environment (Alpine + PRoot) ──

export async function getLinuxEnvStatus() {
  if (!isTauri) return { is_installed: false, is_installing: false, arch: 'unknown', env_dir: null };
  return invoke('get_linux_env_status');
}

export async function installLinuxEnv() {
  if (!isTauri) throw new Error('Linux environment requires the desktop or mobile app');
  return invoke('install_linux_env');
}

export async function removeLinuxEnv() {
  if (!isTauri) return;
  return invoke('remove_linux_env');
}

export async function onLinuxEnvProgress(callback) {
  if (!isTauri) return () => {};
  return listen('linux-env://progress', (event) => callback(event.payload));
}

export async function onLinuxEnvComplete(callback) {
  if (!isTauri) return () => {};
  return listen('linux-env://complete', (event) => callback(event.payload));
}

export async function onLinuxEnvError(callback) {
  if (!isTauri) return () => {};
  return listen('linux-env://error', (event) => callback(event.payload));
}

// ── Path helpers ──

export const sep = '/';

export function basename(path) {
  const clean = path.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx === -1 ? clean : clean.slice(idx + 1);
}

export function dirname(path) {
  const clean = path.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx <= 0 ? '/' : clean.slice(0, idx);
}

export function join(dir, name) {
  return dir.replace(/[\\/]+$/, '') + '/' + name;
}

// ── Git & GitHub ──

export async function gitStatus(path) {
  if (isTauri) return invoke('git_status', { path });
  return {
    is_repo: true,
    root: DEMO_ROOT,
    branch: 'main',
    remote_url: 'https://github.com/demo/workspace',
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [
      { path: 'src/main.js', full_path: '/demo/src/main.js', status: 'modified', staged: false, unstaged: true },
    ],
    untracked: [],
    total_changes: 1,
  };
}

export async function gitStage(path, files = []) {
  if (isTauri) return invoke('git_stage', { path, files });
}

export async function gitUnstage(path, files = []) {
  if (isTauri) return invoke('git_unstage', { path, files });
}

export async function gitDiscard(path, files = []) {
  if (isTauri) return invoke('git_discard', { path, files });
}

export async function gitCommit(path, message) {
  if (isTauri) return invoke('git_commit', { path, message });
  return `[main demo123] ${message}`;
}

export async function gitPush(path, token = null) {
  if (isTauri) return invoke('git_push', { path, token });
  return 'Everything up-to-date';
}

export async function gitPull(path, token = null) {
  if (isTauri) return invoke('git_pull', { path, token });
  return 'Already up-to-date';
}

export async function gitFetch(path, token = null) {
  if (isTauri) return invoke('git_fetch', { path, token });
  return '';
}

export async function gitDiff(path, file, staged = false) {
  if (isTauri) return invoke('git_diff', { path, file, staged });
  return '';
}

export async function gitShowFile(path, file, revision = null) {
  if (isTauri) return invoke('git_show_file', { path, file, revision });
  return '';
}

export async function gitBranches(path) {
  if (isTauri) return invoke('git_branches', { path });
  return ['main'];
}

export async function gitCheckout(path, branch) {
  if (isTauri) return invoke('git_checkout', { path, branch });
  return '';
}

export async function gitCreateBranch(path, branch) {
  if (isTauri) return invoke('git_create_branch', { path, branch });
  return '';
}

export async function gitClone(url, targetParent, customName = null, token = null) {
  if (isTauri) return invoke('git_clone', { url, targetParent, customName, token });
  throw new Error('git clone requires the desktop/mobile application');
}

export async function githubGetUser(token) {
  if (isTauri) return invoke('github_get_user', { token });
  const res = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.statusText}`);
  return res.json();
}

export async function githubListRepos(token) {
  if (isTauri) return invoke('github_list_repos', { token });
  const res = await fetch(
    'https://api.github.com/user/repos?sort=updated&per_page=100&affiliation=owner,collaborator',
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    },
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.statusText}`);
  return res.json();
}

