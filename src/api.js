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

export async function readFilePreview(path) {
  if (isTauri) return invoke('read_file_preview', { path });
  if (!demoFiles.has(path)) throw new Error(`no such file: ${path}`);
  const text = demoFiles.get(path);
  return {
    path,
    name: basename(path),
    size: text.length,
    is_binary: false,
    is_image: false,
    is_media: false,
    mime: 'text/plain',
    data_url: null,
    text_content: text,
    hex_dump: null,
  };
}

export async function readFileForceText(path) {
  if (isTauri) return invoke('read_file_force_text', { path });
  return demoFiles.get(path) || '';
}

export async function getCliOpenTargets() {
  if (!isTauri) return [];
  return invoke('get_cli_open_targets');
}

export async function onOpenFiles(callback) {
  if (!isTauri) return () => {};
  return listen('open-files', (event) => callback(event.payload));
}

/**
 * True when the system folder picker returns a usable filesystem path.
 * Android's picker hands back `content://` URIs that `std::fs` cannot open,
 * so there the app browses folders in its own explorer instead.
 */
export const hasNativeFolderPicker = isTauri && !/android/i.test(navigator.userAgent);
export const hasNativeFilePicker = isTauri && !/android/i.test(navigator.userAgent);

export async function pickFolder(defaultPath) {
  if (!hasNativeFolderPicker) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({ directory: true, multiple: false, defaultPath });
  return typeof selected === 'string' ? selected : null;
}

export async function pickFiles(defaultPath) {
  if (!hasNativeFilePicker) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const selected = await open({
    directory: false,
    multiple: true,
    defaultPath,
  });
  if (!selected) return null;
  return Array.isArray(selected) ? selected : [selected];
}

export async function onTauriDrop(callback) {
  if (!isTauri) return () => {};
  return listen('tauri://drag-drop', (event) => {
    const paths = event.payload?.paths || [];
    if (paths.length > 0) callback(paths);
  });
}

export async function pickSavePath(defaultPath) {
  if (!isTauri) return null;
  const { save } = await import('@tauri-apps/plugin-dialog');
  return (await save({ defaultPath })) || null;
}

// ── Terminal ──

export async function ptyStart(cwd, cols, rows, shellMode = null, proxy = null) {
  if (!isTauri) throw new Error('terminal requires the desktop app');
  return invoke('pty_start', { cwd, cols, rows, shellMode, proxy });
}

export async function ptyWrite(data, id = null) {
  if (!isTauri) return;
  return invoke('pty_write', { data, id });
}

export async function ptyResize(cols, rows, id = null) {
  if (!isTauri) return;
  return invoke('pty_resize', { cols, rows, id });
}

export async function ptyKill(id = null) {
  if (!isTauri) return;
  return invoke('pty_kill', { id });
}

export async function testProxyConnection(proxyUrl) {
  if (!isTauri) return true;
  return invoke('test_proxy_connection', { proxyUrl });
}

/** Subscribe to PTY output; the callback receives (Uint8Array, sessionId). */
export async function onPtyOutput(callback) {
  if (!isTauri) return () => {};
  return listen('pty://output', (event) => {
    if (event.payload && typeof event.payload === 'object' && 'bytes' in event.payload) {
      callback(Uint8Array.from(event.payload.bytes), event.payload.id);
    } else {
      callback(Uint8Array.from(event.payload), null);
    }
  });
}

/** Subscribe to shell exit; callback receives sessionId. */
export async function onPtyExit(callback) {
  if (!isTauri) return () => {};
  return listen('pty://exit', (event) => callback(event.payload));
}

// ── Autonomous Linux Environment (Alpine + PRoot) ──

export async function getLinuxEnvStatus() {
  if (!isTauri) return { is_installed: false, is_installing: false, arch: 'unknown', env_dir: null };
  return invoke('get_linux_env_status');
}

export async function installLinuxEnv(branch = null) {
  if (!isTauri) throw new Error('Linux environment requires the desktop or mobile app');
  return invoke('install_linux_env', { branch });
}

export async function getAlpineConfig() {
  if (!isTauri) {
    return {
      current_branch: 'v3.22',
      edge_enabled: false,
      available_branches: ['v3.22', 'v3.23', 'edge'],
    };
  }
  return invoke('get_alpine_config');
}

export async function setAlpineBranch({ branch, enableEdge = true, runUpgrade = false }) {
  if (!isTauri) return;
  return invoke('set_alpine_branch', { branch, enableEdge, runUpgrade });
}

export async function removeLinuxEnv() {
  if (!isTauri) return;
  return invoke('remove_linux_env');
}

export async function setAnthropicApiKey(key) {
  if (!isTauri) return;
  return invoke('set_anthropic_api_key', { key });
}

export async function getAnthropicApiKey() {
  if (!isTauri) return '';
  return invoke('get_anthropic_api_key');
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

/** Line-by-line progress of the Linux environment setup. */
export async function onLinuxEnvLog(callback) {
  if (!isTauri) return () => {};
  return listen('linux-env://log', (event) => callback(event.payload));
}

/** Fired when the Alpine shell was wanted but the native shell started instead. */
export async function onLinuxEnvFallback(callback) {
  if (!isTauri) return () => {};
  return listen('linux-env://fallback', (event) => callback(event.payload));
}

// ── Path helpers ──

export const sep = '/';

export function basename(path) {
  const clean = path.replace(/[\\/]+$/, '');
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return idx === -1 ? clean : clean.slice(idx + 1);
}

export function folderDisplayName(path) {
  if (!path) return 'Workspace';
  const clean = path.replace(/[\\/]+$/, '');
  if (clean === '/storage/emulated/0' || clean === '/sdcard') {
    return 'Internal Storage';
  }
  if (clean.endsWith('/geko.workspace') || clean === 'geko.workspace') {
    return 'geko.workspace';
  }
  if (clean.endsWith('/linux-env/alpine/root') || clean.endsWith('/alpine/root')) {
    return 'Linux Home (/root)';
  }
  if (clean.includes('/alpine/root/')) {
    return '~/' + clean.split('/alpine/root/')[1];
  }
  const base = basename(clean);
  if (!base || base === '/' || base === '\\') return 'Root';
  return base;
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

// ── Application Info ──

export async function getAppInfo() {
  if (!isTauri) {
    return {
      name: 'Geko',
      version: '0.1.0',
      build_profile: 'dev',
      target_os: 'browser',
      target_arch: 'unknown',
      commit_hash: null,
    };
  }
  return invoke('get_app_info');
}

// ── Language Server Protocol (LSP) ──

export async function lspStart(lang, cwd) {
  if (!isTauri) return;
  return invoke('lsp_start', { lang, cwd });
}

export async function lspSend(lang, payload) {
  if (!isTauri) return;
  return invoke('lsp_send', { lang, payload });
}

export async function lspStop(lang) {
  if (!isTauri) return;
  return invoke('lsp_stop', { lang });
}

export async function lspSupported(lang) {
  if (!isTauri) return false;
  return invoke('lsp_supported', { lang });
}

export async function onLspMessage(callback) {
  if (!isTauri) return () => {};
  return listen('lsp://message', (event) => callback(event.payload));
}

// ── External URL Opener ──

export async function openExternalUrl(url) {
  if (isTauri) {
    try {
      await invoke('open_external_url', { url });
      return;
    } catch (e) {
      console.warn('Native open_external_url failed:', e);
    }
  }
  window.open(url, '_blank');
}



