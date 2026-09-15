import './style.css';

import * as api from './api.js';
import { askConfirm, askFolder, askText } from './dialog.js';
import { showMenu } from './contextmenu.js';
import { openPalette } from './palette.js';
import { createEditor, createModel, monaco, setupCompletions } from './editor.js';
import { FileTree } from './filetree.js';
import { TerminalPanel } from './terminal.js';

// ── Layout ──

document.getElementById('app').innerHTML = `
  <div class="workbench">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <span class="title" id="root-name">Explorer</span>
        <button class="icon-button" id="btn-up" title="Go to parent folder">↑</button>
        <button class="icon-button" id="btn-new-file" title="New file">＋</button>
        <button class="icon-button" id="btn-refresh" title="Refresh">⟳</button>
      </div>
      <div class="sidebar-path" id="root-path"></div>
      <div class="file-tree" id="file-tree"></div>
    </aside>
    <div class="resizer-v" id="resizer-sidebar"></div>
    <div class="scrim" id="scrim"></div>

    <main class="main">
      <div class="toolbar" id="toolbar">
        <button class="tool" id="btn-menu" title="Toggle explorer (Ctrl+B)">☰</button>
        <button class="tool" id="btn-open">Open Folder</button>
        <button class="tool" id="btn-save">Save</button>
        <button class="tool" id="btn-goto">Go to File</button>
        <button class="tool" id="btn-toggle-terminal">Terminal</button>
      </div>
      <div class="tabbar" id="tabbar"></div>
      <div class="editor" id="editor"></div>
      <div class="resizer-h" id="resizer-panel"></div>
      <section class="panel" id="panel">
        <div class="panel-header">
          <span>Terminal</span>
          <button class="panel-pill" id="btn-install-linux" title="Install Alpine Linux + apk package manager">🐧 Install Linux</button>
          <select class="panel-select" id="select-shell" style="display:none" title="Choose shell environment">
            <option value="alpine">🐧 Alpine Linux (apk)</option>
            <option value="native">📱 Native Shell</option>
          </select>
          <span class="spacer"></span>
          <button class="icon-button" id="btn-term-keys" title="Toggle on-screen keys">⌨</button>
          <button class="icon-button" id="btn-restart-terminal" title="Restart shell">⟳</button>
          <button class="icon-button" id="btn-close-terminal" title="Hide terminal">×</button>
        </div>
        <div class="linux-progress" id="linux-progress" style="display:none">
          <span class="linux-progress-text" id="linux-progress-text">Preparing Linux environment...</span>
          <div class="linux-progress-bar-bg">
            <div class="linux-progress-bar" id="linux-progress-bar"></div>
          </div>
        </div>
        <div class="terminal-host" id="terminal"></div>
        <div class="term-keys" id="term-keys"></div>
      </section>
    </main>
  </div>

  <footer class="statusbar">
    <span class="message" id="status-message">Ready</span>
    <span class="spacer"></span>
    <span id="status-position"></span>
    <span id="status-language"></span>
  </footer>
`;

const $ = (id) => document.getElementById(id);

// ── State ──

/** @type {Map<string, {model: any, viewState: any, saved: string}>} */
const openFiles = new Map();
let activePath = null;
let rootPath = null;
let statusTimer = null;

const editor = createEditor($('editor'));
const terminal = new TerminalPanel($('terminal'), $('term-keys'));
const tree = new FileTree($('file-tree'), {
  onOpenFile: async (path) => {
    await openFile(path);
    if (isNarrow()) setSidebar(false);
  },
  onError: (msg) => setStatus(msg, true),
  onContextMenu: (entry, x, y) => showEntryMenu(entry, x, y),
});

setupCompletions(monaco, {
  getActivePath: () => activePath,
  getRootPath: () => rootPath,
});

let refreshDebounceTimer = null;
function scheduleTreeRefresh(delay = 150) {
  clearTimeout(refreshDebounceTimer);
  refreshDebounceTimer = setTimeout(() => {
    tree.refresh();
  }, delay);
}

api.onFsChange(() => {
  scheduleTreeRefresh();
});

window.addEventListener('focus', () => {
  scheduleTreeRefresh(50);
});

setInterval(() => {
  if (document.visibilityState === 'visible' && rootPath) {
    tree.refresh();
  }
}, 4000);

// ── Status bar ──

function setStatus(message, isError = false, resetAfter = isError ? 6000 : 2500) {
  const el = $('status-message');
  el.textContent = message;
  el.classList.toggle('error', isError);
  clearTimeout(statusTimer);
  if (resetAfter) statusTimer = setTimeout(() => updateStatus(), resetAfter);
}

function updateStatus() {
  const el = $('status-message');
  el.classList.remove('error');
  el.textContent = activePath ?? (rootPath ? 'No file open' : 'Open a folder to start');
  const model = activePath ? editor.getModel() : null;
  $('status-language').textContent = model ? model.getLanguageId() : '';
  if (!activePath) $('status-position').textContent = '';
}

editor.onDidChangeCursorPosition((e) => {
  $('status-position').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
});

// ── Files ──

async function openFile(path) {
  try {
    if (!openFiles.has(path)) {
      const content = await api.readFile(path);
      openFiles.set(path, { model: createModel(content, path), viewState: null, saved: content });
      openFiles.get(path).model.onDidChangeContent(() => renderTabs());
    }
    activate(path);
  } catch (e) {
    setStatus(`Cannot open ${api.basename(path)}: ${e}`, true);
  }
}

function activate(path) {
  if (activePath && openFiles.has(activePath)) {
    openFiles.get(activePath).viewState = editor.saveViewState();
  }
  const entry = openFiles.get(path);
  if (!entry) return;
  activePath = path;
  editor.setModel(entry.model);
  if (entry.viewState) editor.restoreViewState(entry.viewState);
  editor.focus();
  tree.setActive(path);
  renderTabs();
  updateStatus();
}

function isDirty(path) {
  const entry = openFiles.get(path);
  return entry ? entry.model.getValue() !== entry.saved : false;
}

async function saveFile(path = activePath) {
  if (!path) return;
  const entry = openFiles.get(path);
  if (!entry) return;
  const content = entry.model.getValue();
  try {
    await api.writeFile(path, content);
    entry.saved = content;
    renderTabs();
    setStatus(`Saved ${api.basename(path)}`);
    scheduleTreeRefresh(50);
  } catch (e) {
    setStatus(`Save failed: ${e}`, true);
  }
}

async function closeFile(path) {
  if (isDirty(path)) {
    const discard = await askConfirm(
      `${api.basename(path)} has unsaved changes. Close without saving?`,
      'Discard',
    );
    if (!discard) return;
  }
  const entry = openFiles.get(path);
  entry?.model.dispose();
  openFiles.delete(path);

  if (activePath === path) {
    activePath = null;
    const next = [...openFiles.keys()].pop();
    if (next) activate(next);
    else {
      editor.setModel(null);
      tree.setActive(null);
      renderTabs();
      updateStatus();
    }
  } else {
    renderTabs();
  }
}

// ── Tabs ──

function renderTabs() {
  const bar = $('tabbar');
  bar.textContent = '';
  for (const path of openFiles.keys()) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    if (path === activePath) tab.classList.add('active');
    if (isDirty(path)) tab.classList.add('dirty');
    tab.title = path;

    const name = document.createElement('span');
    name.textContent = api.basename(path);
    tab.appendChild(name);

    const close = document.createElement('span');
    close.className = 'close';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      closeFile(path);
    });
    tab.appendChild(close);

    tab.addEventListener('click', () => activate(path));
    bar.appendChild(tab);
  }
}

/** Move `step` tabs along the open list, wrapping around. */
function cycleTab(step) {
  const paths = [...openFiles.keys()];
  if (paths.length < 2) return;
  const current = paths.indexOf(activePath);
  activate(paths[(current + step + paths.length) % paths.length]);
}

// ── Folder ──

async function openFolder(path) {
  try {
    await tree.setRoot(path);
  } catch (e) {
    setStatus(`Cannot open ${path}: ${e}`, true);
    return false;
  }
  rootPath = path;
  $('root-name').textContent = api.basename(path) || path;
  $('root-path').textContent = path;
  $('root-path').title = path;
  if (activePath) tree.setActive(activePath);
  updateStatus();
  try {
    await api.watchDir(path);
  } catch (e) {
    console.warn('Cannot watch folder:', e);
  }
  return true;
}

// ── File operations ──

async function createEntryUnder(dir) {
  const name = await askText('New name (end with / to create a folder):');
  if (!name) return;
  const path = api.join(dir, name);
  try {
    await api.createEntry(path, name.endsWith('/'));
    await tree.refresh();
    if (!name.endsWith('/')) await openFile(path);
  } catch (e) {
    setStatus(`Cannot create ${name}: ${e}`, true);
  }
}

async function renameEntry(entry) {
  const name = await askText(`Rename ${api.basename(entry.path)} to:`, api.basename(entry.path));
  if (!name || name === api.basename(entry.path)) return;
  const target = api.join(api.dirname(entry.path), name);
  try {
    await api.renameEntry(entry.path, target);
    // An open tab still points at the old path, so move it across.
    if (openFiles.has(entry.path)) {
      const open = openFiles.get(entry.path);
      openFiles.delete(entry.path);
      openFiles.set(target, open);
      if (activePath === entry.path) activePath = target;
    }
    await tree.refresh();
    renderTabs();
    updateStatus();
  } catch (e) {
    setStatus(`Cannot rename: ${e}`, true);
  }
}

async function deleteEntry(entry) {
  const kind = entry.is_dir ? 'folder and everything in it' : 'file';
  const confirmed = await askConfirm(`Delete ${api.basename(entry.path)}? This ${kind} cannot be recovered.`, 'Delete');
  if (!confirmed) return;
  try {
    await api.deleteEntry(entry.path);
    for (const path of [...openFiles.keys()]) {
      if (path === entry.path || path.startsWith(entry.path + '/')) {
        openFiles.get(path).model.dispose();
        openFiles.delete(path);
        if (activePath === path) activePath = null;
      }
    }
    if (!activePath) {
      const next = [...openFiles.keys()].pop();
      if (next) activate(next);
      else editor.setModel(null);
    }
    await tree.refresh();
    renderTabs();
    updateStatus();
  } catch (e) {
    setStatus(`Cannot delete: ${e}`, true);
  }
}

function showEntryMenu(entry, x, y) {
  const parent = entry.is_dir ? entry.path : api.dirname(entry.path);
  showMenu(x, y, [
    entry.is_dir
      ? { label: 'Open as root', action: () => openFolder(entry.path) }
      : { label: 'Open', action: () => openFile(entry.path) },
    { label: 'New file / folder here…', action: () => createEntryUnder(parent) },
    { separator: true },
    { label: 'Rename…', action: () => renameEntry(entry) },
    { label: 'Copy path', action: () => copyText(entry.path) },
    { separator: true },
    { label: 'Delete…', action: () => deleteEntry(entry), danger: true },
  ]);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Path copied');
  } catch {
    setStatus('Clipboard is not available', true);
  }
}

// ── Toolbar / commands ──

async function chooseFolder() {
  // The native picker only returns real paths on desktop; elsewhere the app
  // offers its own list of roots plus a typed path.
  const picked = api.hasNativeFolderPicker
    ? await api.pickFolder(rootPath ?? undefined)
    : await askFolder(await api.quickRoots(), rootPath ?? '');
  if (!picked) return;
  await openFolder(picked);
  await terminal.restart(picked);
}

$('btn-open').addEventListener('click', chooseFolder);

$('btn-up').addEventListener('click', async () => {
  if (!rootPath) return;
  const parent = api.dirname(rootPath);
  if (parent === rootPath) return;
  await openFolder(parent);
});

$('btn-save').addEventListener('click', () => saveFile());
$('btn-goto').addEventListener('click', () => quickOpen());
$('btn-refresh').addEventListener('click', () => tree.refresh());

$('btn-new-file').addEventListener('click', () => {
  if (!rootPath) return setStatus('Open a folder first', true);
  createEntryUnder(rootPath);
});

/** Phones get the explorer as an overlay drawer, desktops as a fixed column. */
const isNarrow = () => window.matchMedia('(max-width: 700px)').matches;

function setSidebar(open) {
  document.body.classList.toggle('sidebar-open', open);
  if (!open) editor.focus();
}

$('btn-menu').addEventListener('click', () => setSidebar(!document.body.classList.contains('sidebar-open')));
$('scrim').addEventListener('click', () => setSidebar(false));

function toggleTerminal(force) {
  const panel = $('panel');
  const resizer = $('resizer-panel');
  const hide = force ?? !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', hide);
  resizer.classList.toggle('hidden', hide);
  if (!hide) {
    terminal.fit();
    terminal.focus();
  } else {
    editor.focus();
  }
}

$('btn-toggle-terminal').addEventListener('click', () => toggleTerminal());
$('btn-close-terminal').addEventListener('click', () => toggleTerminal(true));
$('btn-restart-terminal').addEventListener('click', () => terminal.restart(rootPath, currentShellMode));

// ── Linux Environment (Alpine + PRoot) ──

let currentShellMode = 'auto';

async function updateLinuxEnvUI() {
  const btnInstall = $('btn-install-linux');
  const selectShell = $('select-shell');
  const progressBox = $('linux-progress');
  if (!btnInstall || !selectShell) return;

  try {
    const status = await api.getLinuxEnvStatus();
    if (status.is_installing) {
      btnInstall.style.display = 'none';
      selectShell.style.display = 'none';
      progressBox.style.display = 'flex';
    } else if (status.is_installed) {
      btnInstall.style.display = 'none';
      selectShell.style.display = 'inline-block';
      selectShell.value = currentShellMode === 'native' ? 'native' : 'alpine';
      progressBox.style.display = 'none';
    } else {
      btnInstall.style.display = 'inline-flex';
      btnInstall.textContent = '🐧 Install Linux';
      selectShell.style.display = 'none';
      progressBox.style.display = 'none';
    }
  } catch {
    btnInstall.style.display = 'none';
    selectShell.style.display = 'none';
  }
}

async function triggerInstallLinux() {
  const progressBox = $('linux-progress');
  const progressText = $('linux-progress-text');
  const progressBar = $('linux-progress-bar');
  const btnInstall = $('btn-install-linux');

  btnInstall.style.display = 'none';
  progressBox.style.display = 'flex';
  progressText.textContent = 'Downloading Alpine Linux & PRoot (~7 MB)...';
  progressBar.style.width = '10%';

  try {
    await api.installLinuxEnv();
  } catch (e) {
    setStatus(`Installation failed: ${e}`, true);
    await updateLinuxEnvUI();
  }
}

$('btn-install-linux')?.addEventListener('click', () => triggerInstallLinux());

$('select-shell')?.addEventListener('change', (e) => {
  currentShellMode = e.target.value;
  terminal.restart(rootPath, currentShellMode);
});

api.onLinuxEnvProgress((payload) => {
  const progressBox = $('linux-progress');
  const progressText = $('linux-progress-text');
  const progressBar = $('linux-progress-bar');
  if (progressBox) progressBox.style.display = 'flex';
  if (progressText) progressText.textContent = `${payload.message} (${payload.percent}%)`;
  if (progressBar) progressBar.style.width = `${payload.percent}%`;
});

api.onLinuxEnvComplete(async (payload) => {
  const progressBox = $('linux-progress');
  if (progressBox) progressBox.style.display = 'none';
  setStatus(payload.message || 'Alpine Linux environment ready!');
  currentShellMode = 'alpine';
  await updateLinuxEnvUI();
  await terminal.restart(rootPath, 'alpine');
});

api.onLinuxEnvError(async (payload) => {
  const progressBox = $('linux-progress');
  if (progressBox) progressBox.style.display = 'none';
  setStatus(`Linux setup error: ${payload.message}`, true);
  await updateLinuxEnvUI();
});

// The helper key row is for soft keyboards; a DeX or desktop keyboard has all
// these keys already, so it starts hidden there.
const isTouchDevice = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
$('term-keys').classList.toggle('visible', isTouchDevice);
$('btn-term-keys').addEventListener('click', () => {
  $('term-keys').classList.toggle('visible');
  terminal.fit();
});

// ── Keyboard ──

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  // Ctrl+S/W/P/N inside the terminal belong to the shell (XOFF, kill-word,
  // previous/next history), so only the app-wide chords are taken there.
  const inTerminal = $('terminal').contains(e.target);

  const handlers = {
    '`': () => toggleTerminal(),
    b: () => setSidebar(!document.body.classList.contains('sidebar-open')),
    Tab: () => cycleTab(e.shiftKey ? -1 : 1),
  };
  const editorHandlers = {
    s: () => saveFile(),
    w: () => activePath && closeFile(activePath),
    p: () => quickOpen(),
    n: () => rootPath && createEntryUnder(rootPath),
  };

  const handler = handlers[e.key] ?? (inTerminal ? undefined : editorHandlers[e.key]);
  if (handler) {
    e.preventDefault();
    handler();
  }
});

async function quickOpen() {
  if (!rootPath) return setStatus('Open a folder first', true);
  const picked = await openPalette(rootPath);
  if (picked) await openFile(picked);
}

// Keep the app-level chords for the app instead of forwarding them to the shell.
terminal.term.attachCustomKeyEventHandler((e) => {
  const mod = e.ctrlKey || e.metaKey;
  return !(mod && (e.key === '`' || e.key === 'b' || e.key === 'Tab'));
});

window.addEventListener('beforeunload', (e) => {
  if ([...openFiles.keys()].some(isDirty)) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── Drag-to-resize ──

function makeResizer(handle, apply) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => apply(ev);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

makeResizer($('resizer-sidebar'), (e) => {
  const width = Math.min(Math.max(e.clientX, 150), window.innerWidth * 0.6);
  $('sidebar').style.width = `${width}px`;
});

makeResizer($('resizer-panel'), (e) => {
  const workbench = document.querySelector('.workbench').getBoundingClientRect();
  const height = Math.min(Math.max(workbench.bottom - e.clientY, 60), maxPanelHeight());
  $('panel').style.height = `${height}px`;
  terminal.fit();
});

// ── Window resizing ──
//
// A Samsung DeX or desktop window can be resized to any size at any moment;
// the panel and sidebar keep pixel sizes from dragging, so clamp them back
// into range whenever the window changes.

/** Tallest the terminal may get while still leaving the editor usable. */
function maxPanelHeight() {
  const main = document.querySelector('.main').getBoundingClientRect().height;
  const chrome = $('toolbar').offsetHeight + $('tabbar').offsetHeight + $('resizer-panel').offsetHeight;
  const MIN_EDITOR = 120;
  return Math.max(60, main - chrome - MIN_EDITOR);
}

function clampLayout() {
  const panel = $('panel');
  const maxPanel = maxPanelHeight();
  if (panel.getBoundingClientRect().height > maxPanel) {
    panel.style.height = `${maxPanel}px`;
  }

  const sidebar = $('sidebar');
  if (isNarrow()) {
    // The drawer sizes itself in CSS; drop any width left over from dragging.
    sidebar.style.width = '';
  } else {
    const maxSidebar = Math.max(150, window.innerWidth * 0.6);
    if (sidebar.getBoundingClientRect().width > maxSidebar) {
      sidebar.style.width = `${maxSidebar}px`;
    }
  }

  // The minimap is only worth its width on a roomy window.
  editor.updateOptions({ minimap: { enabled: window.innerWidth > 900 } });
  terminal.fit();
}

window.addEventListener('resize', clampLayout);

// ── Boot ──

async function init() {
  setSidebar(!isNarrow());
  try {
    await openFolder(await api.defaultRoot());
  } catch (e) {
    setStatus(`Cannot determine a starting folder: ${e}`, true);
  }
  await updateLinuxEnvUI();
  await terminal.start(rootPath, currentShellMode);
  renderTabs();
  updateStatus();
  clampLayout();
}

init();
